(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MiniXLSX = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const UTF8_DECODER = new TextDecoder("utf-8");
  const UTF8_ENCODER = new TextEncoder();

  function decodeXml(value) {
    return String(value || "").replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower === "amp") return "&";
      if (lower === "lt") return "<";
      if (lower === "gt") return ">";
      if (lower === "quot") return '"';
      if (lower === "apos") return "'";
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
      return match;
    });
  }

  function escapeXml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function parseAttributes(fragment) {
    const attrs = {};
    const re = /([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = re.exec(fragment || ""))) {
      attrs[match[1]] = decodeXml(match[2] != null ? match[2] : match[3]);
    }
    return attrs;
  }

  function normalizePath(path) {
    const parts = [];
    String(path || "")
      .replace(/\\/g, "/")
      .split("/")
      .forEach((part) => {
        if (!part || part === ".") return;
        if (part === "..") parts.pop();
        else parts.push(part);
      });
    return parts.join("/");
  }

  function dirname(path) {
    const normalized = normalizePath(path);
    const index = normalized.lastIndexOf("/");
    return index < 0 ? "" : normalized.slice(0, index);
  }

  function basename(path) {
    const normalized = normalizePath(path);
    const index = normalized.lastIndexOf("/");
    return index < 0 ? normalized : normalized.slice(index + 1);
  }

  function resolvePath(baseFile, target) {
    if (!target) return "";
    if (target.startsWith("/")) return normalizePath(target.slice(1));
    const baseDir = dirname(baseFile);
    return normalizePath(baseDir ? `${baseDir}/${target}` : target);
  }

  function readU16(view, offset) {
    return view.getUint16(offset, true);
  }

  function readU32(view, offset) {
    return view.getUint32(offset, true);
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("เบราว์เซอร์นี้ไม่รองรับการคลายไฟล์ ZIP กรุณาใช้ Chrome, Edge, Firefox หรือ Safari รุ่นใหม่");
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(arrayBuffer) {
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const minOffset = Math.max(0, bytes.length - 65557);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= minOffset; i -= 1) {
      if (readU32(view, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("ไม่พบโครงสร้าง ZIP ในไฟล์ .xlsx");

    const totalEntries = readU16(view, eocd + 10);
    const centralOffset = readU32(view, eocd + 16);
    let cursor = centralOffset;
    const entries = new Map();

    for (let n = 0; n < totalEntries; n += 1) {
      if (readU32(view, cursor) !== 0x02014b50) throw new Error("โครงสร้าง ZIP central directory ไม่ถูกต้อง");
      const flags = readU16(view, cursor + 8);
      const compression = readU16(view, cursor + 10);
      const compressedSize = readU32(view, cursor + 20);
      const filenameLength = readU16(view, cursor + 28);
      const extraLength = readU16(view, cursor + 30);
      const commentLength = readU16(view, cursor + 32);
      const localOffset = readU32(view, cursor + 42);
      const filenameBytes = bytes.subarray(cursor + 46, cursor + 46 + filenameLength);
      const filename = UTF8_DECODER.decode(filenameBytes);

      if ((flags & 0x0001) !== 0) throw new Error(`ไม่รองรับไฟล์ Excel ที่เข้ารหัส: ${filename}`);
      if (readU32(view, localOffset) !== 0x04034b50) throw new Error("โครงสร้าง ZIP local header ไม่ถูกต้อง");
      const localNameLength = readU16(view, localOffset + 26);
      const localExtraLength = readU16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      let data;
      if (compression === 0) data = new Uint8Array(compressed);
      else if (compression === 8) data = await inflateRaw(compressed);
      else throw new Error(`ไม่รองรับวิธีบีบอัด ZIP หมายเลข ${compression}`);
      entries.set(normalizePath(filename), data);
      cursor += 46 + filenameLength + extraLength + commentLength;
    }
    return entries;
  }

  function textEntry(entries, path, required) {
    const bytes = entries.get(normalizePath(path));
    if (!bytes) {
      if (required) throw new Error(`ไม่พบไฟล์ภายใน Excel: ${path}`);
      return "";
    }
    return UTF8_DECODER.decode(bytes);
  }

  function parseRelationships(xml, baseFile) {
    const map = new Map();
    const re = /<(?:\w+:)?Relationship\b([^>]*?)(?:\/?>)/gi;
    let match;
    while ((match = re.exec(xml || ""))) {
      const attrs = parseAttributes(match[1]);
      if (!attrs.Id || !attrs.Target) continue;
      map.set(attrs.Id, {
        id: attrs.Id,
        type: attrs.Type || "",
        target: resolvePath(baseFile, attrs.Target),
        targetMode: attrs.TargetMode || ""
      });
    }
    return map;
  }

  function findOfficeDocumentPath(entries) {
    const rootRels = textEntry(entries, "_rels/.rels", false);
    if (rootRels) {
      const rels = parseRelationships(rootRels, "");
      for (const rel of rels.values()) {
        if (/\/officeDocument$/i.test(rel.type)) return rel.target;
      }
    }
    return "xl/workbook.xml";
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    const output = [];
    const itemRe = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/gi;
    let item;
    while ((item = itemRe.exec(xml))) {
      let text = "";
      const textRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi;
      let segment;
      while ((segment = textRe.exec(item[1]))) text += decodeXml(segment[1]);
      output.push(text);
    }
    return output;
  }

  function parseStyles(xml) {
    const customFormats = new Map();
    if (xml) {
      const numFmtRe = /<(?:\w+:)?numFmt\b([^>]*?)(?:\/?>)/gi;
      let match;
      while ((match = numFmtRe.exec(xml))) {
        const attrs = parseAttributes(match[1]);
        if (attrs.numFmtId && attrs.formatCode) customFormats.set(Number(attrs.numFmtId), attrs.formatCode);
      }
    }

    const dateBuiltins = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
    function isDateFormat(numFmtId) {
      if (dateBuiltins.has(numFmtId)) return true;
      const code = customFormats.get(numFmtId);
      if (!code) return false;
      const cleaned = code
        .replace(/"[^"]*"/g, "")
        .replace(/\\./g, "")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/_.|\*./g, "");
      return /[ymdhs]/i.test(cleaned);
    }

    const styleIsDate = [];
    const cellXfsMatch = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/i.exec(xml || "");
    if (cellXfsMatch) {
      const xfRe = /<(?:\w+:)?xf\b([^>]*?)(?:\/?>)/gi;
      let xf;
      while ((xf = xfRe.exec(cellXfsMatch[1]))) {
        const attrs = parseAttributes(xf[1]);
        styleIsDate.push(isDateFormat(Number(attrs.numFmtId || 0)));
      }
    }
    return { styleIsDate };
  }

  function columnIndexFromRef(ref) {
    const match = /^([A-Z]+)\d+$/i.exec(ref || "");
    if (!match) return null;
    let value = 0;
    for (const char of match[1].toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
    return value - 1;
  }

  function excelSerialToDate(serial) {
    const milliseconds = Math.round((Number(serial) - 25569) * 86400000);
    return new Date(milliseconds);
  }

  function readTextTags(xml) {
    let output = "";
    const re = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi;
    let match;
    while ((match = re.exec(xml || ""))) output += decodeXml(match[1]);
    return output;
  }

  function parseCellValue(cellXml, attrs, sharedStrings, styles) {
    const type = attrs.t || "";
    if (type === "inlineStr") return readTextTags(cellXml);
    const valueMatch = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i.exec(cellXml || "");
    const raw = valueMatch ? decodeXml(valueMatch[1]) : "";
    if (type === "s") return sharedStrings[Number(raw)] ?? "";
    if (type === "b") return raw === "1" || /^true$/i.test(raw);
    if (type === "str" || type === "e") return raw;
    if (type === "d") return new Date(raw);
    if (raw === "") return "";
    const number = Number(raw);
    if (!Number.isFinite(number)) return raw;
    const styleIndex = Number(attrs.s || 0);
    if (styles.styleIsDate[styleIndex]) return excelSerialToDate(number);
    return number;
  }

  function parseWorksheet(xml, sharedStrings, styles) {
    const rows = [];
    let fallbackRowIndex = 0;
    const rowRe = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(xml || ""))) {
      const rowAttrs = parseAttributes(rowMatch[1]);
      const rowIndex = rowAttrs.r ? Math.max(0, Number(rowAttrs.r) - 1) : fallbackRowIndex;
      fallbackRowIndex = rowIndex + 1;
      const row = rows[rowIndex] || [];
      let fallbackColIndex = 0;
      const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/gi;
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowMatch[2]))) {
        const attrs = parseAttributes(cellMatch[1]);
        const colIndex = columnIndexFromRef(attrs.r) ?? fallbackColIndex;
        fallbackColIndex = colIndex + 1;
        row[colIndex] = parseCellValue(cellMatch[2] || "", attrs, sharedStrings, styles);
      }
      rows[rowIndex] = row;
    }
    return rows;
  }

  async function readWorkbook(arrayBuffer) {
    const entries = await unzip(arrayBuffer);
    const workbookPath = findOfficeDocumentPath(entries);
    const workbookXml = textEntry(entries, workbookPath, true);
    const workbookRelsPath = normalizePath(`${dirname(workbookPath)}/_rels/${basename(workbookPath)}.rels`);
    const workbookRelsXml = textEntry(entries, workbookRelsPath, true);
    const relationships = parseRelationships(workbookRelsXml, workbookPath);

    let sharedStrings = [];
    let styles = { styleIsDate: [] };
    for (const rel of relationships.values()) {
      if (/\/sharedStrings$/i.test(rel.type)) sharedStrings = parseSharedStrings(textEntry(entries, rel.target, false));
      if (/\/styles$/i.test(rel.type)) styles = parseStyles(textEntry(entries, rel.target, false));
    }

    const sheets = [];
    const sheetRe = /<(?:\w+:)?sheet\b([^>]*?)(?:\/?>)/gi;
    let sheetMatch;
    while ((sheetMatch = sheetRe.exec(workbookXml))) {
      const attrs = parseAttributes(sheetMatch[1]);
      const relationshipId = attrs["r:id"] || attrs.id;
      const rel = relationships.get(relationshipId);
      if (!rel || !/\/worksheet$/i.test(rel.type)) continue;
      const worksheetXml = textEntry(entries, rel.target, true);
      sheets.push({
        name: attrs.name || `Sheet${sheets.length + 1}`,
        rows: parseWorksheet(worksheetXml, sharedStrings, styles)
      });
    }
    if (sheets.length === 0) throw new Error("ไม่พบ worksheet ในไฟล์ Excel");
    return { sheets, sheetNames: sheets.map((sheet) => sheet.name) };
  }

  function detectDelimiter(text) {
    const firstLines = String(text || "").split(/\r?\n/).slice(0, 8).join("\n");
    const candidates = ["\t", ",", ";", "|"];
    let best = "\t";
    let bestCount = -1;
    for (const delimiter of candidates) {
      let count = 0;
      let inQuotes = false;
      for (let i = 0; i < firstLines.length; i += 1) {
        const char = firstLines[i];
        if (char === '"') {
          if (inQuotes && firstLines[i + 1] === '"') i += 1;
          else inQuotes = !inQuotes;
        } else if (!inQuotes && char === delimiter) count += 1;
      }
      if (count > bestCount) {
        best = delimiter;
        bestCount = count;
      }
    }
    return bestCount > 0 ? best : "\n";
  }

  function parseDelimited(text, delimiter) {
    const source = String(text == null ? "" : text).replace(/^\uFEFF/, "");
    const actualDelimiter = delimiter || detectDelimiter(source);
    if (actualDelimiter === "\n") return source.split(/\r?\n/).map((line) => [line]);
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (inQuotes) {
        if (char === '"' && source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else if (char === '"') inQuotes = false;
        else field += char;
      } else if (char === '"') inQuotes = true;
      else if (char === actualDelimiter) {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        field = "";
      } else field += char;
    }
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
    return rows;
  }

  function columnName(index) {
    let value = index + 1;
    let output = "";
    while (value > 0) {
      const remainder = (value - 1) % 26;
      output = String.fromCharCode(65 + remainder) + output;
      value = Math.floor((value - 1) / 26);
    }
    return output;
  }

  function safeSheetName(name, usedNames) {
    const base = String(name || "Sheet")
      .replace(/[\\/?*\[\]:]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 31) || "Sheet";
    let candidate = base;
    let counter = 2;
    while (usedNames.has(candidate.toLocaleLowerCase("en"))) {
      const suffix = ` ${counter}`;
      candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
      counter += 1;
    }
    usedNames.add(candidate.toLocaleLowerCase("en"));
    return candidate;
  }

  function valueToCellXml(value, ref, styleIndex) {
    const style = styleIndex ? ` s="${styleIndex}"` : "";
    if (value == null || value === "") return "";
    if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
    if (typeof value === "boolean") return `<c r="${ref}" t="b"${style}><v>${value ? 1 : 0}</v></c>`;
    let text;
    if (value instanceof Date) text = Number.isNaN(value.getTime()) ? "" : value.toISOString();
    else if (typeof value === "object") {
      try { text = JSON.stringify(value); } catch (_error) { text = String(value); }
    } else text = String(value);
    if (!text) return "";
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
  }

  function estimateColumnWidths(rows, maxSampleRows) {
    const widths = [];
    const limit = Math.min(rows.length, maxSampleRows || 1000);
    for (let r = 0; r < limit; r += 1) {
      const row = rows[r] || [];
      for (let c = 0; c < row.length; c += 1) {
        const value = row[c] == null ? "" : row[c] instanceof Date ? row[c].toISOString() : String(row[c]);
        const visualLength = Array.from(value).reduce((sum, char) => sum + (/[\u0E00-\u0E7F]/u.test(char) ? 1.25 : 1), 0);
        widths[c] = Math.max(widths[c] || 0, Math.min(60, Math.ceil(visualLength + 2)));
      }
    }
    return widths.map((width) => Math.max(10, Math.min(50, width || 10)));
  }

  function makeWorksheetXml(rows, options) {
    const opts = Object.assign({ freezeHeader: true, autoFilter: true }, options || {});
    const maxColumns = rows.reduce((max, row) => Math.max(max, (row || []).length), 0);
    const maxRows = Math.max(rows.length, 1);
    const endRef = `${columnName(Math.max(0, maxColumns - 1))}${maxRows}`;
    const widths = estimateColumnWidths(rows);
    const colsXml = widths.length
      ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`
      : "";
    const paneXml = opts.freezeHeader
      ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
      : '<selection activeCell="A1" sqref="A1"/>';

    const rowXml = rows.map((row, rowIndex) => {
      const cells = (row || [])
        .map((value, colIndex) => valueToCellXml(value, `${columnName(colIndex)}${rowIndex + 1}`, rowIndex === 0 ? 1 : 0))
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join("");

    const filterXml = opts.autoFilter && maxColumns > 0 && rows.length > 1 ? `<autoFilter ref="A1:${endRef}"/>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<dimension ref="A1:${endRef}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0">${paneXml}</sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>${colsXml}<sheetData>${rowXml}</sheetData>${filterXml}` +
      `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
      `</worksheet>`;
  }

  function makeStylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Aptos"/><family val="2"/><scheme val="minor"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/><family val="2"/><scheme val="minor"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
  }

  function makeContentTypesXml(sheetCount) {
    const sheetOverrides = Array.from({ length: sheetCount }, (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${sheetOverrides}
</Types>`;
  }

  function makeRootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  }

  function makeWorkbookXml(sheetNames) {
    const sheetsXml = sheetNames.map((name, index) =>
      `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
    ).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="9303"/>
  <workbookPr defaultThemeVersion="164011"/>
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>
  <sheets>${sheetsXml}</sheets>
  <calcPr calcId="191029"/>
</workbook>`;
  }

  function makeWorkbookRelsXml(sheetCount) {
    const sheetRels = Array.from({ length: sheetCount }, (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    ).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRels}
  <Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  }

  function makeAppXml(sheetNames) {
    const titles = sheetNames.map((name) => `<vt:lpstr>${escapeXml(name)}</vt:lpstr>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Shop Name Classifier</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>
  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheetNames.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>
  <TitlesOfParts><vt:vector size="${sheetNames.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>
  <Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion>
</Properties>`;
  }

  function makeCoreXml() {
    const now = new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Shop Name Classifier</dc:creator><cp:lastModifiedBy>Shop Name Classifier</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
  }

  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
  }

  function crc32(bytes) {
    const table = crcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const d = date || new Date();
    const year = Math.max(1980, d.getFullYear());
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
    const day = ((year - 1980) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time, day };
  }

  function putU16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  function putU32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function createZip(files) {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const dateTime = dosDateTime(new Date());

    for (const file of files) {
      const nameBytes = UTF8_ENCODER.encode(file.name);
      const dataBytes = file.data instanceof Uint8Array ? file.data : UTF8_ENCODER.encode(String(file.data));
      const crc = crc32(dataBytes);

      const localHeader = new Uint8Array(30);
      const localView = new DataView(localHeader.buffer);
      putU32(localView, 0, 0x04034b50);
      putU16(localView, 4, 20);
      putU16(localView, 6, 0x0800);
      putU16(localView, 8, 0);
      putU16(localView, 10, dateTime.time);
      putU16(localView, 12, dateTime.day);
      putU32(localView, 14, crc);
      putU32(localView, 18, dataBytes.length);
      putU32(localView, 22, dataBytes.length);
      putU16(localView, 26, nameBytes.length);
      putU16(localView, 28, 0);
      localParts.push(localHeader, nameBytes, dataBytes);

      const centralHeader = new Uint8Array(46);
      const centralView = new DataView(centralHeader.buffer);
      putU32(centralView, 0, 0x02014b50);
      putU16(centralView, 4, 20);
      putU16(centralView, 6, 20);
      putU16(centralView, 8, 0x0800);
      putU16(centralView, 10, 0);
      putU16(centralView, 12, dateTime.time);
      putU16(centralView, 14, dateTime.day);
      putU32(centralView, 16, crc);
      putU32(centralView, 20, dataBytes.length);
      putU32(centralView, 24, dataBytes.length);
      putU16(centralView, 28, nameBytes.length);
      putU16(centralView, 30, 0);
      putU16(centralView, 32, 0);
      putU16(centralView, 34, 0);
      putU16(centralView, 36, 0);
      putU32(centralView, 38, 0);
      putU32(centralView, 42, localOffset);
      centralParts.push(centralHeader, nameBytes);
      localOffset += localHeader.length + nameBytes.length + dataBytes.length;
    }

    const localBytes = concatBytes(localParts);
    const centralBytes = concatBytes(centralParts);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    putU32(eocdView, 0, 0x06054b50);
    putU16(eocdView, 4, 0);
    putU16(eocdView, 6, 0);
    putU16(eocdView, 8, files.length);
    putU16(eocdView, 10, files.length);
    putU32(eocdView, 12, centralBytes.length);
    putU32(eocdView, 16, localBytes.length);
    putU16(eocdView, 20, 0);
    return concatBytes([localBytes, centralBytes, eocd]);
  }

  function writeWorkbook(inputSheets) {
    const usedNames = new Set();
    const sheets = (inputSheets || []).map((sheet, index) => ({
      name: safeSheetName(sheet.name || `Sheet${index + 1}`, usedNames),
      rows: Array.isArray(sheet.rows) ? sheet.rows : [],
      freezeHeader: sheet.freezeHeader !== false,
      autoFilter: sheet.autoFilter !== false
    }));
    if (sheets.length === 0) sheets.push({ name: safeSheetName("Sheet1", usedNames), rows: [[]], freezeHeader: true, autoFilter: false });
    const names = sheets.map((sheet) => sheet.name);
    const files = [
      { name: "[Content_Types].xml", data: makeContentTypesXml(sheets.length) },
      { name: "_rels/.rels", data: makeRootRelsXml() },
      { name: "docProps/app.xml", data: makeAppXml(names) },
      { name: "docProps/core.xml", data: makeCoreXml() },
      { name: "xl/workbook.xml", data: makeWorkbookXml(names) },
      { name: "xl/_rels/workbook.xml.rels", data: makeWorkbookRelsXml(sheets.length) },
      { name: "xl/styles.xml", data: makeStylesXml() }
    ];
    sheets.forEach((sheet, index) => {
      files.push({
        name: `xl/worksheets/sheet${index + 1}.xml`,
        data: makeWorksheetXml(sheet.rows, { freezeHeader: sheet.freezeHeader, autoFilter: sheet.autoFilter })
      });
    });
    return createZip(files);
  }

  function downloadWorkbook(sheets, filename) {
    const bytes = writeWorkbook(sheets);
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename || "output.xlsx";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    readWorkbook,
    parseDelimited,
    detectDelimiter,
    writeWorkbook,
    downloadWorkbook,
    unzip,
    createZip,
    escapeXml,
    decodeXml,
    columnName
  };
});
