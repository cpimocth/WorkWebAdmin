from __future__ import annotations

import argparse
import json
import os
import posixpath
import re
import threading
import webbrowser
import zipfile
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from xml.etree import ElementTree as ET

BASE_DIR = Path(__file__).resolve().parent
DB_FILE = BASE_DIR / "Database_CPI.xlsx"

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_REL_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

DATE_BUILTIN_IDS = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))


def _excel_col_index(cell_ref: str) -> int:
    m = re.match(r"([A-Z]+)", cell_ref or "")
    if not m:
        return 0
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _read_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    name = "xl/sharedStrings.xml"
    if name not in zf.namelist():
        return []
    root = ET.fromstring(zf.read(name))
    out = []
    for si in root.findall(f"{{{NS_MAIN}}}si"):
        parts = []
        for t in si.iter(f"{{{NS_MAIN}}}t"):
            parts.append(t.text or "")
        out.append("".join(parts))
    return out


def _read_styles(zf: zipfile.ZipFile):
    name = "xl/styles.xml"
    if name not in zf.namelist():
        return [], {}
    root = ET.fromstring(zf.read(name))
    custom = {}
    numfmts = root.find(f"{{{NS_MAIN}}}numFmts")
    if numfmts is not None:
        for n in numfmts.findall(f"{{{NS_MAIN}}}numFmt"):
            try:
                custom[int(n.attrib.get("numFmtId", "0"))] = n.attrib.get("formatCode", "")
            except ValueError:
                pass
    xfs = []
    cellxfs = root.find(f"{{{NS_MAIN}}}cellXfs")
    if cellxfs is not None:
        for xf in cellxfs.findall(f"{{{NS_MAIN}}}xf"):
            try:
                xfs.append(int(xf.attrib.get("numFmtId", "0")))
            except ValueError:
                xfs.append(0)
    return xfs, custom


def _looks_like_date_format(num_fmt_id: int, custom: dict[int, str]) -> bool:
    if num_fmt_id in DATE_BUILTIN_IDS:
        return True
    code = custom.get(num_fmt_id, "")
    if not code:
        return False
    code = re.sub(r'"[^"]*"', "", code)
    code = re.sub(r"\[[^\]]*\]", "", code)
    code = code.lower()
    return bool(re.search(r"(^|[^a-z])[dmy]+([^a-z]|$)", code))


def _excel_date(serial: float) -> str:
    # Excel 1900 date system (with the standard 1899-12-30 compatibility epoch)
    dt = datetime(1899, 12, 30) + timedelta(days=serial)
    if abs(serial - int(serial)) < 1e-10:
        return dt.strftime("%d/%m/%Y")
    if dt.second:
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    return dt.strftime("%d/%m/%Y %H:%M")


def _sheet_paths(zf: zipfile.ZipFile) -> dict[str, str]:
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rel_map = {}
    for rel in rels.findall(f"{{{NS_REL_PKG}}}Relationship"):
        rel_map[rel.attrib.get("Id", "")] = rel.attrib.get("Target", "")
    result = {}
    sheets = workbook.find(f"{{{NS_MAIN}}}sheets")
    if sheets is None:
        return result
    for sh in sheets.findall(f"{{{NS_MAIN}}}sheet"):
        name = sh.attrib.get("name", "")
        rid = sh.attrib.get(f"{{{NS_REL_DOC}}}id", "")
        target = rel_map.get(rid, "")
        if target:
            if target.startswith("/"):
                path = target.lstrip("/")
            else:
                path = posixpath.normpath(posixpath.join("xl", target))
            result[name] = path
    return result


def _sheet_hyperlinks(zf: zipfile.ZipFile, sheet_path: str) -> dict[str, str]:
    rel_path = posixpath.join(posixpath.dirname(sheet_path), "_rels", posixpath.basename(sheet_path) + ".rels")
    if rel_path not in zf.namelist():
        return {}
    rel_root = ET.fromstring(zf.read(rel_path))
    rel_map = {
        r.attrib.get("Id", ""): r.attrib.get("Target", "")
        for r in rel_root.findall(f"{{{NS_REL_PKG}}}Relationship")
        if r.attrib.get("TargetMode") == "External"
    }
    root = ET.fromstring(zf.read(sheet_path))
    h = root.find(f"{{{NS_MAIN}}}hyperlinks")
    if h is None:
        return {}
    out = {}
    for node in h.findall(f"{{{NS_MAIN}}}hyperlink"):
        ref = node.attrib.get("ref", "")
        rid = node.attrib.get(f"{{{NS_REL_DOC}}}id", "")
        if ref and rid in rel_map:
            out[ref] = rel_map[rid]
    return out


def _cell_value(cell, shared_strings, style_numfmts, custom_formats):
    t = cell.attrib.get("t", "")
    style_idx = int(cell.attrib.get("s", "0") or 0)
    v = cell.find(f"{{{NS_MAIN}}}v")
    if t == "inlineStr":
        is_node = cell.find(f"{{{NS_MAIN}}}is")
        if is_node is None:
            return ""
        return "".join((n.text or "") for n in is_node.iter(f"{{{NS_MAIN}}}t"))
    if v is None or v.text is None:
        return ""
    raw = v.text
    if t == "s":
        try:
            return shared_strings[int(raw)]
        except Exception:
            return raw
    if t == "b":
        return "TRUE" if raw == "1" else "FALSE"
    if t in {"str", "e"}:
        return raw
    try:
        num = float(raw)
        num_fmt_id = style_numfmts[style_idx] if 0 <= style_idx < len(style_numfmts) else 0
        if _looks_like_date_format(num_fmt_id, custom_formats):
            return _excel_date(num)
        if num.is_integer():
            return str(int(num))
        return format(num, ".15g")
    except Exception:
        return raw


def _read_sheet_as_dicts(zf, sheet_path, shared_strings, style_numfmts, custom_formats):
    root = ET.fromstring(zf.read(sheet_path))
    sheet_data = root.find(f"{{{NS_MAIN}}}sheetData")
    if sheet_data is None:
        return []
    hyperlinks = _sheet_hyperlinks(zf, sheet_path)
    rows = []
    for row in sheet_data.findall(f"{{{NS_MAIN}}}row"):
        values = {}
        for cell in row.findall(f"{{{NS_MAIN}}}c"):
            ref = cell.attrib.get("r", "")
            idx = _excel_col_index(ref)
            value = _cell_value(cell, shared_strings, style_numfmts, custom_formats)
            values[idx] = (value, ref)
        if values:
            max_idx = max(values)
            arr = [""] * (max_idx + 1)
            refs = [""] * (max_idx + 1)
            for idx, (val, ref) in values.items():
                arr[idx] = val
                refs[idx] = ref
            rows.append((arr, refs, hyperlinks))
    if not rows:
        return []
    headers = [str(x).strip() for x in rows[0][0]]
    result = []
    for arr, refs, hyperlink_map in rows[1:]:
        item = {}
        nonempty = False
        for i, header in enumerate(headers):
            if not header:
                continue
            val = arr[i] if i < len(arr) else ""
            ref = refs[i] if i < len(refs) else ""
            if header.lower().endswith("_link") and ref in hyperlink_map:
                val = hyperlink_map[ref]
            if val != "":
                nonempty = True
            item[header] = val
        if nonempty:
            result.append(item)
    return result


def load_database(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"ไม่พบไฟล์ {path.name}")
    with zipfile.ZipFile(path) as zf:
        shared = _read_shared_strings(zf)
        style_numfmts, custom_formats = _read_styles(zf)
        sheets = _sheet_paths(zf)
        users_path = sheets.get("Users")
        tasks_path = sheets.get("Tasks")
        if not users_path:
            raise ValueError("ไม่พบชีท Users")
        if not tasks_path:
            raise ValueError("ไม่พบชีท Tasks")
        users = _read_sheet_as_dicts(zf, users_path, shared, style_numfmts, custom_formats)
        tasks = _read_sheet_as_dicts(zf, tasks_path, shared, style_numfmts, custom_formats)

    if not users or "Username" not in users[0] or "Password" not in users[0]:
        raise ValueError("ชีท Users ต้องมีคอลัมน์ Username และ Password")

    task_count = 0
    for row in tasks:
        for key, value in row.items():
            if re.fullmatch(r"Task\d+_Name", key, flags=re.I) and str(value).strip() not in {"", "-"}:
                task_count += 1

    return {
        "users": users,
        "tasks": tasks,
        "meta": {
            "file": path.name,
            "modified": datetime.fromtimestamp(path.stat().st_mtime).strftime("%d/%m/%Y %H:%M:%S"),
            "users": len(users),
            "task_items": task_count,
        },
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/db":
            try:
                data = load_database(DB_FILE)
                payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except Exception as exc:
                payload = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            return
        if path == "/api/health":
            payload = json.dumps({"ok": True, "database_exists": DB_FILE.exists()}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(description="TPSO CPI local task server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    os.chdir(BASE_DIR)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/index.html"
    print("=" * 68)
    print(" TPSO CPI Task System")
    print(f" Database : {DB_FILE}")
    print(f" URL      : {url}")
    print(" Press Ctrl+C to stop")
    print("=" * 68)

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
