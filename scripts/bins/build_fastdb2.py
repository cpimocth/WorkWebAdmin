#!/usr/bin/env python3
"""Build a read-only, sharded CPI fast data store from existing XLSX files.

The dashboard reads these compressed JSON snapshots directly from GitHub Pages.
Data are not modified: raw product codes/specs/source prices are preserved.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import hashlib
import json
import posixpath
import re
import sys
import unicodedata
import warnings
from pathlib import Path
from zipfile import ZipFile

from lxml import etree

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
TAG = lambda x: '{' + NS + '}' + x
MON = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม']
SHORT = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']
SKIP_DIRS = {'.git', '.github', '.venv', 'node_modules', '__pycache__', '_site', 'fastdb'}
FASTDB_BUILD_REV = 'central-details-v2'  # price rows format unchanged
MASTER_BUILD_REV = 'master-guides-v1'  # Master classification changed; bust master cache


def s(v):
    if v is None:return ''
    if v is True:return 'true'
    if v is False:return 'false'
    if isinstance(v, float) and v.is_integer():return str(int(v))
    return str(v)


def clean(x):
    return ' '.join(s(x).split())


def norm(x):
    return re.sub(r'[\s\u200b-\u200d\ufeff\-_.()（）\[\]{}\\/,:;ฯ๏]','',unicodedata.normalize('NFKC',s(x))).lower()


def num(x):
    if isinstance(x, bool) or x is None or s(x).strip()=='':return None
    value=s(x).strip().replace(',','')
    if not re.fullmatch(r'[-+]?\d+(?:\.\d+)?',value):return None
    try:
        n=float(value)
        return n if n!=float('inf') and n!=float('-inf') else None
    except (ValueError,OverflowError):return None


def flag(v):
    return v is True or v == 1 or s(v)=='1' or clean(v).lower() in {'checked','yes','true','ใช่','✓'}


def code7(v):
    x=s(v).strip()
    return x if re.fullmatch(r'\d{7}',x) else ''


def code(v):
    return s(v).strip()


def col(header,names):
    return next((i for i,x in enumerate(header) if clean(x) in names),-1)


def get(row,i):
    return row[i] if 0<=i<len(row) else ''


def guess_header(rows,kind):
    best=(-1,-1)
    for ix,(_,row) in enumerate(rows[:16]):
        h=list(map(clean,row))
        score=0
        if kind=='master':
            if 'กำหนดให้เก็บ' in h:score+=8
            if 'ผู้ดูแล' in h:score+=5
            if 'รายการ' in h:score+=3
            if 'รหัส' in h:score+=3
        else:
            if 'จังหวัด' in h:score+=5
            if 'รหัส' in h:score+=3
            if 'ราคาปัจจุบัน' in h or 'ราคาเฉลี่ย' in h:score+=5
            if 'ลักษณะจำเพาะ' in h or 'รายการบ้านเช่า' in h:score+=4
            if 'G' in h:score+=2
        if score>best[1]:best=(ix,score)
    return best[0] if best[1]>=(13 if kind=='master' else 11) else -1


def period_label(metadata,filename):
    text=s(metadata);fallback=s(filename)
    ym=re.search(r'ปี\s*(25\d{2}|20\d{2})',text)
    year=int(ym.group(1)) if ym else 0
    match=re.search(r'เดือน\s*(.*?)(?:ประเทศไทย|ชุดทั่วไป|ชุดรายได้น้อย|\s*$)',text)
    sub=match.group(1) if match else text
    def find_month(t):
        for i in range(12):
            if MON[i] in t or SHORT[i] in t:return i+1
        return 0
    month=find_month(sub) or find_month(fallback)
    if not year:
        y2=re.search(r'(?<!\d)(25\d{2}|20\d{2})[-_ .]*(0?[1-9]|1[0-2])(?!\d)',fallback)
        if y2:year=int(y2.group(1));month=month or int(y2.group(2))
    if not year or not month:return ''
    if year>=2400:year-=543
    return f'{year}-{month:02d}'


def git_period(name):
    m=re.search(r'(?:ปี\s*|^|[\s_-])(25\d{2}|20\d{2})(?!\d)',name)
    year=int(m.group(1)) if m else 0
    month=next((i+1 for i in range(12) if MON[i] in name or SHORT[i] in name),0)
    if not month:
        mm=re.search(r'(?:เดือน\s*|[\s_-])(0?[1-9]|1[0-2])(?=[\s_.-]|$)',name)
        if mm:month=int(mm.group(1))
    if not year or not month:
        comb=re.search(r'(25\d{2}|20\d{2})[-_.]?(0[1-9]|1[0-2])(?!\d)',name)
        if comb:return f'{int(comb.group(1))-(543 if int(comb.group(1))>2400 else 0)}-{comb.group(2)}'
    return f'{year-(543 if year>=2400 else 0)}-{month:02d}' if year and month else ''


def source_kind(rel):
    name=Path(rel).name
    if not name.lower().endswith('.xlsx') or name.startswith('~$'):return ''
    if re.search(r'Real[_\s-]*Master[_\s-]*CPI',name,re.I):return 'master'
    if re.match(r'^4\.1\.\d+\.\d+',name):return 'price'
    if re.search(r'(^|/)(data|excel|inputs|price-data|survey-data)/',rel,re.I) and re.search(r'ชุด\s*[GLU]|รายเดือน|รายสัปดาห์|ราคา|rent|rental',name,re.I):return 'price'
    return ''


def survey_topic(rel):
    """The 4.1.x.x code identifies an independent report topic (weekly, monthly, rent, U)."""
    name=Path(rel).name
    match=re.search(r'(?<![0-9])(4\.1\.\d+\.\d+)(?![0-9])',name)
    if match:return match.group(1)
    return 'name:'+norm(re.sub(r'\s*\(\d+\)(?=\.xlsx$)','',name,flags=re.I).removesuffix('.xlsx'))


def survey_dup_key(entry):
    if entry['kind']!='price':return ''
    period=entry.get('period') or ''
    if not re.fullmatch(r'20\d{2}-(0[1-9]|1[0-2])',period):return ''
    return period+'|'+survey_topic(entry['rel'])


def file_version(entry):
    found=re.search(r'\((\d+)\)(?=\.xlsx$)',entry['path'].name,re.I)
    return int(found.group(1)) if found else 0


def prefer_price(a,b):
    """One representative file: higher filename revision, then more complete file size."""
    def score(v):return (file_version(v),v['path'].stat().st_size,-len(v['rel']))
    return a if score(a)>=score(b) else b


def discover(root):
    originals=[]
    for p in (root / 'Count_CPI_fast').glob('*.xlsx'):
    # for p in root.rglob('*.xlsx'):
        if any(x in SKIP_DIRS or x.startswith('.') for x in p.relative_to(root).parts[:-1]):continue
        kind=source_kind(p.relative_to(root).as_posix())
        if kind:originals.append({'path':p,'rel':p.relative_to(root).as_posix(),'kind':kind,'period':git_period(p.name)})
    masters=[x for x in originals if x['kind']=='master']
    def master_pri(x):
        n=x['path'].name
        return (1000 if n.lower()=='real_master_cpi.xlsx' else int(re.search(r'\((\d+)\)\.xlsx$',n,re.I).group(1)) if re.search(r'\((\d+)\)\.xlsx$',n,re.I) else 0,-len(x['rel']))
    masters.sort(key=master_pri,reverse=True)
    kept={};ignored=[]
    for item in sorted((y for y in originals if y['kind']=='price'),key=lambda a:a['rel']):
        # No year/month: retain the old conservative exact-filename deduplication.
        key=survey_dup_key(item) or 'file:'+re.sub(r'\s*\(\d+\)(?=\.xlsx$)','',item['rel'],flags=re.I)
        previous=kept.get(key)
        if previous is None:
            kept[key]=item
            continue
        selected=prefer_price(previous,item)
        skipped=item if selected is previous else previous
        kept[key]=selected
        ignored.append({'period':item['period'],'topic':survey_topic(item['rel']),'skipped':skipped['rel'],'used':selected['rel']})
    return masters[:1]+sorted(kept.values(),key=lambda x:x['rel']),ignored


class Book:
    def __init__(self,path):
        self.path=path
        self.zip=ZipFile(path)
        self.shared=self._shared()
        wb=etree.fromstring(self.zip.read('xl/workbook.xml'))
        rels=etree.fromstring(self.zip.read('xl/_rels/workbook.xml.rels'))
        ref={r.get('Id'):r.get('Target') for r in rels if r.tag.endswith('}Relationship')}
        self.sheets=[]
        for sh in wb.findall('.//'+TAG('sheet')):
            target=ref.get(sh.get('{'+DOC+'}id'))
            if not target:continue
            if target.startswith('/'):
                p=target.lstrip('/')
            else:p=posixpath.normpath(posixpath.join('xl',target))
            if p not in self.zip.namelist():continue
            self.sheets.append((sh.get('name','Sheet'),p))

    def _shared(self):
        if 'xl/sharedStrings.xml' not in self.zip.namelist():return []
        out=[]
        with self.zip.open('xl/sharedStrings.xml') as reader:
            for _,si in etree.iterparse(reader,events=('end',),tag=TAG('si'),huge_tree=True):
                out.append(''.join(n.text or '' for n in si.iter(TAG('t'))))
                si.clear()
                while si.getprevious() is not None:del si.getparent()[0]
        return out

    def iterrows(self,path):
        with self.zip.open(path) as reader:
            for _,row in etree.iterparse(reader,events=('end',),tag=TAG('row'),huge_tree=True):
                rownum=int(row.get('r') or 0)
                cells=[]
                offset=0
                for c in row.iterchildren(TAG('c')):
                    ref=c.get('r') or ''
                    cm=re.match(r'([A-Z]+)',ref)
                    if cm:
                        idx=0
                        for ch in cm.group(1):idx=idx*26+ord(ch)-64
                        idx-=1
                    else:idx=offset
                    offset=idx+1
                    typ=c.get('t') or ''
                    if typ=='inlineStr':v=''.join(n.text or '' for n in c.iter(TAG('t')))
                    else:
                        node=c.find(TAG('v'))
                        v=node.text if node is not None and node.text is not None else ''
                        if typ=='s':
                            try:v=self.shared[int(v)]
                            except (ValueError,IndexError):v=''
                        elif typ=='b':v=v=='1'
                        elif typ not in ('str','e') and v!='':
                            try:
                                f=float(v)
                                v=int(f) if f.is_integer() and abs(f)<1e16 else f
                            except ValueError:pass
                    if idx>=len(cells):cells.extend(['']*(idx-len(cells)+1))
                    cells[idx]=v
                yield rownum,cells
                row.clear()
                while row.getprevious() is not None:del row.getparent()[0]

    def named(self,phrase):
        return next(((n,p) for n,p in self.sheets if phrase in n),None)

    def close(self):self.zip.close()


def build_master(path):
    wb=Book(path)
    try:
        target=wb.named('ข้อมูล_รายการ_ผู้ดูแล')
        if not target:raise ValueError('Master lacks ข้อมูล_รายการ_ผู้ดูแล sheet')
        rr=list(wb.iterrows(target[1])); hix=guess_header(rr,'master')
        if hix<0:raise ValueError('Cannot detect master headers')
        h=list(map(clean,rr[hix][1]))
        ii={k:col(h,v) for k,v in dict(code=['รหัส'],name=['รายการ'],admin=['ผู้ดูแล'],target=['กำหนดให้เก็บ'],detail=['รายละเอียด'],mode=['เวลาเก็บ'],gl=['G/L'],u=['U']).items()}
        items={};review=[]
        for rn,r in rr[hix+1:]:
            cd=code7(get(r,ii['code']))
            if not cd:continue
            if cd in items:review.append('Master พบ CODE7 ซ้ำ: '+cd);continue
            raw_target=clean(get(r,ii['target']));detail=clean(get(r,ii['detail']))
            tar=num(get(r,ii['target']))
            central_master='ส่วนกลางจัดเก็บ' in norm(detail) or 'ส่วนกลางจัดเก็บ' in norm(raw_target)
            items[cd]={'code':cd,'name':clean(get(r,ii['name'])),'admin':clean(get(r,ii['admin'])),'target':tar if tar and tar>0 else 0,'targetNote':raw_target,'detail':detail,'centralMaster':central_master,'mode':clean(get(r,ii['mode'])),'gl':flag(get(r,ii['gl'])),'u':flag(get(r,ii['u'])),'available':None,'uAvailable':None}
        provinces=[];province_map={}; regions=[]
        ps=wb.named('รหัสจังหวัด')
        if ps:
            it=iter(wb.iterrows(ps[1]));_,head=next(it,(1,[]));hn=list(map(clean,head));pcol=col(hn,['จังหวัด','ชื่อจังหวัด']);rcol=col(hn,['ภาค','ชื่อภาค'])
            for rn,row in it:
                if pcol<0 or rcol<0:continue
                pn,reg=clean(get(row,pcol)),clean(get(row,rcol))
                if pn and reg:
                    p={'province':pn,'region':reg};province_map[norm(pn)]=p;provinces.append(p)
                    if reg not in regions:regions.append(reg)
        areas=[];seenareas=set()
        us=wb.named('จังหวัดใช้งาน')
        if us:
            it=iter(wb.iterrows(us[1]));_,head=next(it,(1,[]));hh=list(map(clean,head));typecol=col(hh,['ชุดCPI']);areacol=col(hh,['จังหวัด/กลุ่ม']);districtcol=col(hh,['อำเภอ'])
            for rn,row in it:
                if typecol<0 or areacol<0:continue
                typ=clean(get(row,typecol))
                survey='U' if 'ชุดนอกเขตเมือง' in typ else 'GL' if 'ชุดอำเภอเมือง' in typ else ''
                if not survey:continue
                raw=clean(get(row,areacol))
                if not raw:continue
                group=raw if survey=='GL' and raw.startswith('กลุ่ม') else ''
                province='กรุงเทพมหานคร' if group else raw
                p=province_map.get(norm(province),{})
                district=clean(get(row,districtcol)) if districtcol>=0 else ''
                id=('U|'+province) if survey=='U' else province+'|'+group
                if id in seenareas:continue
                seenareas.add(id)
                label=(province+' · นอกเขตเมือง'+(' ('+district+')' if district else '')) if survey=='U' else ('กทม. · '+re.sub(r'^กลุ่ม\s*','',group)) if group else province
                areas.append({'id':id,'province':province,'region':p.get('region','ไม่พบภาค'),'group':group,'groupName':re.sub(r'^กลุ่ม\s*','',group) if group else '', 'district':district,'label':label,'planned':True,'survey':survey})
        major={};covered=0;calc=wb.named('คำนวณ')
        if calc:
            rr=list(wb.iterrows(calc[1]))
            columns=[]
            for rn,row in rr:
                cd=code7(get(row,0))
                if cd and re.fullmatch(r'\d0{6}',cd) and clean(get(row,1)):major[cd[0]]=clean(get(row,1))
                if 'BKK' in row and 'CEN' in row:columns=list(row)
            glkeys=['BKK','CEN','NOR','NET','SOU'];ukeys=['CU','EU','NU','SU']
            glidx=[next((i for i,x in enumerate(columns) if clean(x)==k),-1) for k in glkeys]
            uidx=[next((i for i,x in enumerate(columns) if clean(x)==k),-1) for k in ukeys]
            if all(i>=0 for i in glidx):
                for rn,row in rr:
                    cd=code7(get(row,0));it=items.get(cd)
                    if not it:continue
                    it['available']={k:flag(get(row,idx)) for k,idx in zip(glkeys,glidx)}
                    if all(i>=0 for i in uidx):it['uAvailable']={k:flag(get(row,idx)) for k,idx in zip(ukeys,uidx)}
                    covered+=1
        if not any(a['survey']=='GL' for a in areas):review.append('Master ไม่มีรายการพื้นที่ชุดอำเภอเมืองในชีตจังหวัดใช้งาน')
        if not any(a['survey']=='U' for a in areas):review.append('Master ไม่มีรายการพื้นที่ชุดนอกเขตเมืองในชีตจังหวัดใช้งาน')
        if calc and not any(it.get('uAvailable') for it in items.values()):review.append('ไม่พบธง CU/EU/NU/SU ของชุด U ในชีตคำนวณ')
        if not province_map:review.append('ไม่พบผังจังหวัด–ภาคใน Master')
        if not covered:review.append('ไม่พบธงพื้นที่ BKK/CEN/NOR/NET/SOU ในชีตคำนวณ')
        # Province aliases are added at browser runtime; no static region guesses are used.
        return {'schema':1,'kind':'master','items':list(items.values()),'areas':areas,'provinces':provinces,'regions':regions,'review':review,'covered':covered,'src':target[0],'groupRows':[],'majorNames':major}
    finally:wb.close()


def price_rows(path):
    book=Book(path)
    try:
        records=[];skipped=[];types=set();periods=set()
        for sheet,pathxml in book.sheets:
            rows=book.iterrows(pathxml)
            head=[]
            for _ in range(16):
                try:head.append(next(rows))
                except StopIteration:break
            hi=guess_header(head,'main')
            if hi<0:continue
            headers=list(map(clean,head[hi][1]))
            rental='รายการบ้านเช่า' in headers or 'ค่าเช่าบ้าน' in sheet
            weekly=not rental and 'ราคาเฉลี่ย' in headers and 'ราคาปัจจุบัน' not in headers
            typ='rental' if rental else 'weekly' if weekly else 'monthly'
            types.add(typ)
            top=' '.join(str(x) for x in head[0][1] if isinstance(x,str)) if head else ''
            period=period_label(top,Path(path).name)
            columns={
                'id':col(headers,['รหัส']),'spec':col(headers,['ลักษณะจำเพาะ','รายการบ้านเช่า']),
                'shop':col(headers,['แหล่งจัดเก็บ']),'province':col(headers,['จังหวัด']),
                'g':col(headers,['G']),'l':col(headers,['L']),'u':col(headers,['U']),
                'market':col(headers,['กลุ่มตลาด']),'detail':col(headers,['รายละเอียด']),'source':-1,
            }
            if columns['spec']>=0:columns['source']=next((i for i,x in enumerate(headers) if i>columns['spec'] and x=='รหัส'),-1)
            columns['price']=(len(headers)-1-headers[::-1].index('ราคาเฉลี่ย')) if weekly and 'ราคาเฉลี่ย' in headers else col(headers,['ราคาปัจจุบัน'])
            if columns['id']<0 or columns['province']<0 or columns['price']<0:
                skipped.append(sheet+': ไม่พบรหัส/จังหวัด/คอลัมน์ราคา');continue
            def source_rows():
                yield from head[hi+1:]
                yield from rows
            for rn,r in source_rows():
                raw=code(get(r,columns['id']))
                if not raw:continue
                c='3110001' if rental else raw[:7]
                if not re.fullmatch(r'\d{7}',c):continue
                if not rental and len(raw)!=16:
                    if len(skipped)<30:skipped.append(f'{sheet} แถว {rn}: รหัสรายการไม่ได้ยาว 16 หลัก')
                    continue
                province=clean(get(r,columns['province']))
                spec=clean(get(r,columns['spec']))
                shop=clean(get(r,columns['shop'])) if columns['shop']>=0 else ''
                market=clean(get(r,columns['market'])) if columns['market']>=0 else ''
                source=code(get(r,columns['source'])) if columns['source']>=0 else ''
                price=num(get(r,columns['price']))
                price_detail=clean(get(r,columns['detail'])) if columns['detail']>=0 else ''
                g=columns['g']>=0 and flag(get(r,columns['g']))
                l=columns['l']>=0 and flag(get(r,columns['l']))
                u=columns['u']>=0 and flag(get(r,columns['u']))
                survey='U' if columns['u']>=0 and ((columns['g']<0 and columns['l']<0) or (u and not g and not l)) else 'GL'
                records.append([raw,spec,source,shop or (market if rental and market else 'ไม่ระบุแหล่ง'),province,market,typ,price,(1 if g else 0)|(2 if l else 0)|(4 if u else 0),1 if survey=='U' else 0,sheet,rn,period,price_detail])
                if period:periods.add(period)
        if not types:raise ValueError('ไม่พบชีตที่มีคอลัมน์รหัส จังหวัด และราคาปัจจุบัน/ราคาเฉลี่ย')
        positive=sum(1 for r in records if r[7] is not None and r[7]>0)
        central_positive=sum(1 for r in records if r[7] is not None and r[7]>0 and 'ส่วนกลางจัดเก็บ' in norm(r[13]))
        survey=['U' if x else 'GL' for x in sorted(set(row[9] for row in records))]
        common=next(iter(periods)) if len(periods)==1 else ''
        return {'schema':1,'kind':'price','name':path.name,'period':common,'types':sorted(types),'sets':survey,'count':len(records),'positive':positive,'centralPositive':central_positive,'skipped':skipped,'rows':records}
    finally:book.close()


def dump_gzip(obj,dest):
    data=json.dumps(obj,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf-8')
    dest.parent.mkdir(parents=True,exist_ok=True)
    with dest.open('wb') as target:
        with gzip.GzipFile(fileobj=target,mode='wb',compresslevel=7,mtime=0) as writer:writer.write(data)
    return len(data),dest.stat().st_size


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--root',type=Path,default=Path('.'))
    ap.add_argument('--out',type=Path,default=Path('fastdb'))
    args=ap.parse_args();root=args.root.resolve();out=args.out.resolve()
    if not out.is_relative_to(root):raise SystemExit('output must be within repository root')
    out.mkdir(parents=True,exist_ok=True)
    files=[];master=None;total=0
    sources,ignored=discover(root)
    for item in ignored:
        print('SKIP duplicate survey '+item['period']+' / '+item['topic']+': '+item['skipped']+' -> '+item['used'],flush=True)
    for src in sources:
        p=src['path'];raw=p.read_bytes();sha=hashlib.sha256(raw).hexdigest()
        try:
            if src['kind']=='master':
                data=build_master(p)
                rel=f'master-{sha[:16]}-{MASTER_BUILD_REV}.json.gz'
                meta={'path':src['rel'],'name':p.name,'kind':'master','sha':sha,'file':rel}
            else:
                data=price_rows(p)
                rel=f'files/{sha[:16]}-{FASTDB_BUILD_REV}.json.gz'
                meta={'path':src['rel'],'name':p.name,'kind':'price','sha':sha,'file':rel,
                      'period':data['period'] or src['period'],'types':data['types'],'sets':data['sets'],
                      'count':data['count'],'positive':data['positive'],'centralPositive':data['centralPositive']}
                total+=data['count']
            uncompressed,compressed=dump_gzip(data,out/rel)
            files.append(meta)
            print(f"{src['kind']:<6} {p.name[:53]:53}  rows={data.get('count',len(data.get('items',[]))):>6}  {uncompressed/1024/1024:6.2f}MB => {compressed/1024/1024:5.2f}MB",flush=True)
            if src['kind']=='master':master=meta
        except Exception as exc:
            print('ERROR: Cannot convert '+str(p)+': '+str(exc),file=sys.stderr,flush=True)
            return 1
    if not master:
        print('ERROR: No Real_Master_CPI.xlsx found',file=sys.stderr)
        return 1
    if not any(x['kind']=='price' for x in files):
        print('ERROR: No usable 4.1.*.xlsx price files found',file=sys.stderr)
        return 1
    periods=sorted(set(x['period'] for x in files if x['kind']=='price' and x['period']))
    man={'schema':1,'builtAt':datetime.now(timezone.utc).isoformat(timespec='seconds'),'master':master,
         'files':files,'periods':periods,'latest':periods[-1] if periods else '',
         'sourceRows':total,'skippedDuplicates':ignored}
    (out/'manifest.json').write_text(json.dumps(man,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    expected={x['file'] for x in files}
    for old in out.rglob('*.json.gz'):
        if old.relative_to(out).as_posix() not in expected:old.unlink()
    print(f"MANIFEST: {len(files)} files; {len(periods)} months; {total:,} records; saved {out/'manifest.json'}",flush=True)
    return 0

if __name__=='__main__':raise SystemExit(main())
