"""Account-local department directories: bounded XLSX reading and reviewable updates."""
from __future__ import annotations
import csv
import hashlib
import io
import json
import os
import re
import secrets
import threading
import time
import unicodedata
import zipfile
from collections import OrderedDict
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET
from . import config
from .db.core import conn

FIELDS = {
    'employee_id':'工号', 'department':'部门', 'admin_group':'行政组',
    'gender':'性别', 'mobile':'手机号', 'work_phone':'工作电话',
    'title':'职务', 'address':'办公地点', 'directory_note1':'部门备注1',
    'directory_note2':'部门备注2', 'directory_tags':'名单标签',
}
CORE = {'email':'邮箱','name':'姓名','company':'公司','note':'个人备注','group_name':'个人分组'}
ALL_FIELDS = {**CORE, **FIELDS}
ALIASES = {
    'email':('邮箱','电子邮箱','电子邮件','邮件地址','电子邮件地址','email','e-mail'),
    'name':('姓名','名字','员工姓名','联系人姓名','name'),
    'note':('个人备注','note'), 'group_name':('个人分组','group_name'),
    'company':('公司','所属公司','公司名称','company'),
    'employee_id':('工号','员工号','员工编号','职工号','员工编码'),
    'department':('部门','员工部门','所属部门','部门名称','事业部'),
    'admin_group':('行政组','科室','班组'),
    'gender':('性别',), 'mobile':('手机号','手机','手机号码','移动电话'),
    'work_phone':('工作电话','办公电话','座机','固定电话','分机'),
    'title':('职务','职位','岗位'), 'address':('办公地点','办公地址','地址'),
    'directory_note1':('备注','备注1','部门备注','部门备注1'),
    'directory_note2':('备注2','部门备注2'), 'directory_tags':('标签','名单标签'),
}
NS = {'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
MAX_FILE = 5 * 1024 * 1024
MAX_ROWS = 5000
_PLANS = OrderedDict()
_LOCK = threading.RLock()


def init_schema(c):
    c.execute("CREATE TABLE IF NOT EXISTS contact_directory_profiles(email TEXT PRIMARY KEY COLLATE NOCASE,data_json TEXT NOT NULL DEFAULT '{}',imported_json TEXT NOT NULL DEFAULT '{}',source_file TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '')")
    c.execute("CREATE TABLE IF NOT EXISTS contact_directory_pending(record_key TEXT PRIMARY KEY,data_json TEXT NOT NULL,reason TEXT NOT NULL,source_file TEXT NOT NULL,source_sheet TEXT NOT NULL,row_number INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',updated_at TEXT NOT NULL)")
    c.execute("CREATE TABLE IF NOT EXISTS contact_directory_imports(id INTEGER PRIMARY KEY AUTOINCREMENT,filename TEXT NOT NULL,digest TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL)")


def clean(value, maximum=300):
    text = str('' if value is None else value).strip()
    return ''.join(c for c in text if c >= ' ' or c in '\n\t')[:maximum]


def normalize_profile(data):
    if not isinstance(data, dict):
        raise ValueError('联系人资料格式无效')
    result = {k:clean(data.get(k), 120 if k not in ('directory_note1','directory_note2','address') else 1000) for k in FIELDS}
    custom = data.get('custom_fields') or {}
    if not isinstance(custom,dict) or len(custom)>30:
        raise ValueError('其他资料最多 30 个字段')
    result['custom_fields'] = {clean(k,60):clean(v,1000) for k,v in custom.items() if clean(k,60)}
    return result


def profiles(c):
    return {r['email'].casefold():{**json.loads(r['data_json']), '_imported':json.loads(r['imported_json']), '_source':r['source_file']} for r in c.execute('SELECT * FROM contact_directory_profiles')}


def save_profile(c, email, data):
    normalized = normalize_profile(data)
    c.execute("INSERT INTO contact_directory_profiles(email,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at", (email,json.dumps(normalized,ensure_ascii=False),datetime.now().isoformat(timespec='seconds')))
    return normalized


def _header(value):
    return re.sub(r'[\s※＊*：:（）()_-]+','',unicodedata.normalize('NFKC',str(value))).casefold()


_HEADER_KEYS = {_header(alias):key for key, values in ALIASES.items() for alias in values}


def _xml(z, filename):
    raw = z.read(filename)
    if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:
        raise ValueError('不支持含外部实体定义的表格')
    return ET.fromstring(raw)


def _column(address):
    value=0
    match=re.fullmatch(r'([A-Z]{1,3})[1-9][0-9]{0,6}',str(address))
    if not match: raise ValueError('工作表中的单元格坐标无效')
    for letter in match.group(1): value=value*26+ord(letter)-64
    return value


def column_name(number):
    value=''
    while number: number,rem=divmod(number-1,26);value=chr(65+rem)+value
    return value


def read_workbook(raw):
    """Read cell values only; no formulas, external links, macros, or Excel execution."""
    if not raw or len(raw)>MAX_FILE: raise ValueError('请选择不超过 5 MB 的 .xlsx 文件')
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            info=z.infolist()
            if len(info)>1500 or sum(i.file_size for i in info)>32*1024*1024 or any(i.flag_bits&1 for i in info):
                raise ValueError('文件过大或已加密，请拆分并另存为普通 .xlsx')
            if any('vbaproject' in i.filename.lower() for i in info): raise ValueError('请选择不含宏的 .xlsx 文件')
            shared=[]
            if 'xl/sharedStrings.xml' in z.namelist():
                shared=[''.join(t.text or '' for t in si.iter('{'+NS['m']+'}t')) for si in _xml(z,'xl/sharedStrings.xml')]
            formats={}
            style_ids=[]
            if 'xl/styles.xml' in z.namelist():
                styles=_xml(z,'xl/styles.xml')
                formats={int(e.attrib['numFmtId']):e.attrib['formatCode'] for e in styles.findall('m:numFmts/m:numFmt',NS)}
                style_ids=[int(e.attrib.get('numFmtId','0')) for e in styles.findall('m:cellXfs/m:xf',NS)]
            rels={e.attrib['Id']:e.attrib['Target'] for e in _xml(z,'xl/_rels/workbook.xml.rels') if e.attrib.get('TargetMode')!='External'}
            sheets=[];cell_count=0
            entries=_xml(z,'xl/workbook.xml').find('m:sheets',NS)
            if entries is None or len(entries)>50: raise ValueError('工作表数量异常，最多支持 50 张表')
            for item in entries:
                rid=item.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
                target=rels.get(rid,'');path=target.lstrip('/') if target.startswith('/') else 'xl/'+target
                path=str(PurePosixPath(path))
                if not path.startswith('xl/worksheets/') or '..' in PurePosixPath(path).parts: raise ValueError('工作表引用无效')
                sheet=_xml(z,path);rows=[];formula_count=0
                for row in sheet.findall('m:sheetData/m:row',NS):
                    number=int(row.attrib['r']);values={}
                    if number>MAX_ROWS+200: raise ValueError('每张工作表最多支持 5000 行人员资料')
                    for cell in row:
                        cell_count+=1
                        if cell_count>150000: raise ValueError('表格单元格过多，请拆分后导入')
                        col=_column(cell.attrib['r'])
                        if col>100: continue
                        if cell.find('m:f',NS) is not None:
                            formula_count+=1
                            continue # Formula results must not become identities or contact details.
                        value=cell.find('m:v',NS);value=value.text if value is not None else ''
                        kind=cell.attrib.get('t','')
                        if kind=='s': value=shared[int(value)] if value else ''
                        elif kind=='inlineStr': value=''.join(t.text or '' for t in cell.findall('.//m:t',NS))
                        elif kind=='e': value=''
                        elif value and kind not in ('str','b'):
                            try:
                                numeric=Decimal(value)
                                if numeric==numeric.to_integral():
                                    value=str(numeric.to_integral())
                                    idx=int(cell.attrib.get('s','0'))
                                    fmt=formats.get(style_ids[idx] if idx<len(style_ids) else 0,'')
                                    if re.fullmatch(r'0{2,20}',fmt): value=value.zfill(len(fmt))
                            except InvalidOperation: pass
                        if value: values[col]=clean(value,2000)
                    if values: rows.append((number,values))
                headers=[]
                for number,values in rows[:200]:
                    columns={col:_HEADER_KEYS[_header(v)] for col,v in values.items() if _header(v) in _HEADER_KEYS}
                    if 'name' in columns.values() and any(k in columns.values() for k in ('email','employee_id','mobile')):
                        headers.append((number,values,columns))
                sheets.append({'name':item.attrib['name'],'rows':rows,'headers':headers,'hidden':item.attrib.get('state','visible')!='visible','formulas':formula_count})
            return sheets
    except (zipfile.BadZipFile,KeyError,ValueError,ET.ParseError,IndexError) as exc:
        if isinstance(exc,ValueError): raise
        raise ValueError('无法读取表格，请另存为 .xlsx 后重试') from None


def _extract(sheet, override=None):
    maps={};records=[]
    for number,values in sheet['rows']:
        columns={col:_HEADER_KEYS[_header(v)] for col,v in values.items() if _header(v) in _HEADER_KEYS}
        if override and number==override['header_row']:
            columns={int(col):key for key,col in override['fields'].items() if col}
        is_header='name' in columns.values() and any(k in columns.values() for k in ('email','employee_id','mobile'))
        if is_header and (not override or number==override['header_row']):
            names=sorted(col for col,key in columns.items() if key=='name')
            for index,namecol in enumerate(names):
                left=(names[index-1]+namecol)//2+1 if index else min(columns)
                right=(namecol+names[index+1])//2 if index+1<len(names) else max(values)
                maps[namecol]={'fields':{key:col for col,key in columns.items() if left<=col<=right}, 'custom':{clean(v,60):col for col,v in values.items() if left<=col<=right and col not in columns and _header(v) not in ('序号','编号','序','序数')},'start':number}
        for namecol,mapping in maps.items():
            if number<=mapping['start'] or _header(values.get(namecol,'')) in ('姓名','员工姓名'):
                continue
            name=values.get(namecol,'')
            if not name or len(name)>80 or name.isdecimal(): continue
            record={key:clean(values.get(col,''),1000 if 'note' in key else 300) for key,col in mapping['fields'].items()}
            # Blank cells are blank: never forward-fill gender, numbers, or identities.
            if not record.get('email') and not (record.get('employee_id') or record.get('mobile')): continue
            record.update(custom_fields={label:clean(values.get(col,''),1000) for label,col in mapping['custom'].items() if values.get(col)}, source_sheet=sheet['name'], source_row=number)
            encoded_custom=record['custom_fields'].pop('其他资料（JSON）','')
            if encoded_custom:
                try:
                    decoded=json.loads(encoded_custom)
                    if not isinstance(decoded,dict): raise ValueError()
                    record['custom_fields'].update(decoded)
                except (ValueError,TypeError): raise ValueError('导出资料列无法读取，请检查 CSV 文件')
            record.update(normalize_profile(record))
            if not record.get('department') and not record.get('email'):
                record['department']=sheet['name'];record['_derived_department']=True
            if '干部' in sheet['name']: record['directory_tags']='干部'
            records.append(record)
            if len(records)>MAX_ROWS: raise ValueError('每次最多导入 5000 位联系人')
    return records


def _valid_email(value):
    from .web.helpers import valid_contact_email
    try: return valid_contact_email(str(value).strip()).casefold()
    except Exception: return ''


def _merge(sheets, selected, overrides):
    chosen=[s for s in sheets if s['name'] in selected]
    if not chosen: raise ValueError('请至少选择一张工作表')
    # Email-rich summary sheets take precedence over phone-only layouts.
    chosen.sort(key=lambda s:(-sum('email' in h[2].values() for h in s['headers']), '干部' in s['name'], '人员' not in s['name']))
    raw=[r for sheet in chosen for r in _extract(sheet,overrides.get(sheet['name']))]
    valid={};pending=[];by_id={}
    for row in raw:
        email=_valid_email(row.get('email'))
        if not email: pending.append(row);continue
        row=dict(row,email=email,conflicts=[])
        if email not in valid: valid[email]=row
        else: _combine(valid[email],row)
    for row in valid.values():
        uid=row.get('employee_id')
        if uid: by_id.setdefault(uid,[]).append(row)
    unresolved={}
    for row in pending:
        uid=row.get('employee_id');matches=by_id.get(uid,[]) if uid else []
        if len(matches)==1 and clean(matches[0]['name']).replace(' ','')==clean(row['name']).replace(' ',''):
            _combine(matches[0],row)
        else:
            key=(uid+':'+row['name']) if uid else row['source_sheet']+':'+str(row['source_row'])
            if key in unresolved and unresolved[key]['name']==row['name']: _combine(unresolved[key],row)
            else: unresolved[key]=dict(row,conflicts=[], reason='邮箱格式异常' if row.get('email') else '缺少邮箱')
    if len(valid)+len(unresolved)>MAX_ROWS: raise ValueError('每次最多导入 5000 位联系人')
    return list(valid.values()),list(unresolved.values())


def _combine(target, other):
    for key in ALL_FIELDS:
        if key in ('email',): continue
        incoming=other.get(key,'')
        if not incoming: continue
        if key=='department' and other.get('_derived_department') and target.get(key): continue
        if '干部' in other['source_sheet'] and key in ('directory_note1','directory_note2','department'):
            target.setdefault('custom_fields',{})[other['source_sheet']+' · '+ALL_FIELDS[key]]=incoming
            continue
        if not target.get(key): target[key]=incoming
        elif incoming!=target[key]:
            if key=='directory_tags': target[key]='、'.join(dict.fromkeys((target[key]+'、'+incoming).split('、')))
            else: target.setdefault('conflicts',[]).append({'field':key,'label':ALL_FIELDS[key],'primary':target[key],'other':incoming,'source_sheet':other['source_sheet'],'source_row':other['source_row']})
    target.setdefault('custom_fields',{}).update({k:v for k,v in other.get('custom_fields',{}).items() if k not in target.get('custom_fields',{})})


def _scope(): return os.path.realpath(config.DB_PATH)


def _cache(payload):
    now=time.monotonic()
    with _LOCK:
        for key in list(_PLANS):
            if _PLANS[key]['expires']<now: del _PLANS[key]
        while len(_PLANS)>=16: _PLANS.popitem(last=False)
        token=secrets.token_urlsafe(24)
        _PLANS[token]={'scope':_scope(),'expires':now+900,**payload}
        return token


def _get(token):
    if not isinstance(token,str) or len(token)>128:raise ValueError('预览标识无效，请重新选择文件')
    value=_PLANS.get(token)
    if not value or value['scope']!=_scope() or value['expires']<time.monotonic():
        raise ValueError('预览已过期或不属于当前邮箱，请重新选择文件')
    return value


def inspect_file(raw,filename):
    if str(filename).lower().endswith('.csv'):
        if not raw or len(raw)>MAX_FILE: raise ValueError('请选择不超过 5 MB 的文件')
        try: text=raw.decode('utf-8-sig')
        except UnicodeError:
            try: text=raw.decode('gb18030')
            except UnicodeError: raise ValueError('CSV 编码无法读取，请保存为 UTF-8 CSV')
        values=list(csv.reader(io.StringIO(text)))
        if len(values)>MAX_ROWS+200 or any(len(row)>100 for row in values):raise ValueError('CSV 过大，请拆分后导入')
        grid=[(index+1,{col+1:clean(value,65536) for col,value in enumerate(row) if value}) for index,row in enumerate(values)]
        headers=[]
        for number,row in grid[:200]:
            cols={col:_HEADER_KEYS[_header(v)] for col,v in row.items() if _header(v) in _HEADER_KEYS}
            if 'name' in cols.values() and any(k in cols.values() for k in ('email','employee_id','mobile')):headers.append((number,row,cols))
        sheets=[{'name':'CSV 通讯录','rows':grid,'headers':headers,'hidden':False,'formulas':0}]
    elif str(filename).lower().endswith('.xlsx'): sheets=read_workbook(raw)
    else: raise ValueError('请选择 .xlsx 或 CSV；旧版 .xls 请先另存为 .xlsx')
    info=[]
    for sheet in sheets:
        rows=_extract(sheet);with_email=sum(bool(_valid_email(r.get('email'))) for r in rows)
        first=sheet['headers'][0] if sheet['headers'] else None
        info.append({'name':sheet['name'],'count':len(rows),'email_count':with_email,'hidden':sheet['hidden'],'formula_count':sheet['formulas'],'header_row':first[0] if first else 1,'columns':[{'column':col,'letter':column_name(col),'label':value} for col,value in first[1].items()] if first else [],'mapping':{key:col for col,key in first[2].items()} if first else {},'selected':bool(with_email) and not sheet['hidden'],'column_count':max((max(v) for _,v in sheet['rows']),default=1),'sample_rows':{str(number):{str(k):v for k,v in row.items()} for number,row in sheet['rows'][:20]}})
    safe_filename=clean(PurePosixPath(str(filename).replace('\\','/')).name,180)
    token=_cache({'sheets':sheets,'filename':safe_filename,'digest':hashlib.sha256(raw).hexdigest()})
    return {'token':token,'filename':safe_filename,'sheets':info,'fields':ALL_FIELDS,'max_contacts':MAX_ROWS}


def _flatten(profile):
    return {**{k:profile.get(k,'') for k in FIELDS},**{'custom:'+k:v for k,v in profile.get('custom_fields',{}).items()}}


def _unflatten(flat):
    return {**{k:flat.get(k,'') for k in FIELDS},'custom_fields':{k[7:]:v for k,v in flat.items() if k.startswith('custom:')}}


def _signature(contact, profile):
    return hashlib.sha256(json.dumps({'contact':contact,'profile':profile},sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def preview(token, selected, policy='sync', overrides=None):
    if policy not in ('sync','fill','replace'): raise ValueError('更新方式无效')
    if not isinstance(selected,list) or not all(isinstance(v,str) for v in selected): raise ValueError('请选择工作表')
    overrides=overrides or {}
    if not isinstance(overrides,dict):raise ValueError('字段映射无效')
    for sheet,override in overrides.items():
        if not isinstance(override,dict) or not isinstance(override.get('header_row'),int) or not 1<=override['header_row']<=200 or not isinstance(override.get('fields'),dict): raise ValueError('表头映射无效')
        if any(k not in ALL_FIELDS or not str(v).isdigit() or not 1<=int(v)<=100 for k,v in override['fields'].items() if v): raise ValueError('字段映射无效')
        if not override['fields'].get('name'): raise ValueError('请映射姓名列')
        if len([v for v in override['fields'].values() if v])!=len(set(str(v) for v in override['fields'].values() if v)): raise ValueError('一列不能同时映射多个字段')
    with _LOCK:
        source=_get(token)
        rows,pending=_merge(source['sheets'],selected,overrides)
        if not rows and not pending: raise ValueError('没有识别到人员记录，请检查工作表和字段映射')
        with conn() as c:
            saved={r['email'].casefold():dict(r) for r in c.execute('SELECT * FROM contacts')};extra=profiles(c)
            resolved={r['record_key']:json.loads(r['data_json']).get('resolved_email') for r in c.execute("SELECT record_key,data_json FROM contact_directory_pending WHERE status='resolved'")}
        outstanding=[]
        for row in pending:
            verified=resolved.get(_record_key(row))
            if verified and verified in saved:
                rows.append(dict(row,email=verified))
            else: outstanding.append(row)
        pending=outstanding
        items=[]
        for incoming in rows:
            email=incoming['email'];old=saved.get(email);profile=extra.get(email,{})
            current={**{k:(old or {}).get(k,'') for k in ('name','company','note','group_name')},**_flatten(profile)}
            proposed={**{k:incoming.get(k,'') for k in ('name','company','note','group_name')},**_flatten(incoming)}
            baseline=profile.get('_imported',{});changes=[];protected=[];next_values=dict(current);next_baseline=dict(baseline)
            for key,value in proposed.items():
                if not value: continue # A department file's empty cell never erases user data.
                previous=current.get(key,'')
                if key in ('note','group_name'):
                    update=not previous and (key not in baseline or previous==baseline[key])
                elif policy=='replace': update=True
                elif policy=='fill': update=not previous
                else: update=previous==baseline[key] if key in baseline else not previous
                if previous==value: next_baseline[key]=value;continue
                if update:
                    next_values[key]=value;next_baseline[key]=value
                    changes.append({'field':key,'label':ALL_FIELDS.get(key,key.removeprefix('custom:')),'before':previous,'after':value})
                else: protected.append({'field':key,'label':ALL_FIELDS.get(key,key.removeprefix('custom:')),'current':previous,'incoming':value})
            if old is None and incoming.get('employee_id'):
                previous_addresses=[address for address,p in extra.items() if p.get('employee_id')==incoming['employee_id'] and address!=email]
                for address in previous_addresses:
                    incoming.setdefault('conflicts',[]).append({'field':'email','label':'同工号的邮箱','primary':email,'other':address,'source_sheet':'现有通讯录','source_row':0})
            items.append({'email':email,'name':incoming.get('name',''),'department':incoming.get('department',''),'employee_id':incoming.get('employee_id',''),'status':'new' if old is None else 'update' if changes else 'unchanged','changes':changes,'protected':protected,'conflicts':incoming.get('conflicts',[]),'source_sheet':incoming['source_sheet'],'source_row':incoming['source_row'],'hidden':bool(old and old.get('hidden')),'_next':next_values,'_baseline':next_baseline,'_incoming':incoming,'_signature':_signature(old,profile)})
        plan=_cache({'filename':source['filename'],'digest':source['digest'],'items':items,'pending':pending,'policy':policy})
        return {'token':plan,'items':[{k:v for k,v in row.items() if not k.startswith('_')} for row in items],'pending':[{'name':r.get('name',''),'employee_id':r.get('employee_id',''),'source_sheet':r['source_sheet'],'source_row':r['source_row'],'reason':r['reason']} for r in pending],'counts':{status:sum(r['status']==status for r in items) for status in ('new','update','unchanged')}|{'conflict':sum(bool(r['conflicts']) for r in items),'protected':sum(bool(r['protected']) for r in items),'pending':len(pending)}}


def _record_key(row):
    uid=row.get('employee_id')
    identity=('id:'+uid+':'+row.get('name','')) if uid else row['source_sheet']+':'+str(row['source_row'])+':'+row.get('name','')
    return hashlib.sha256(identity.encode()).hexdigest()


def _pending(c,row,source,reason):
    key=_record_key(row)
    c.execute("INSERT INTO contact_directory_pending(record_key,data_json,reason,source_file,source_sheet,row_number,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(record_key) DO UPDATE SET data_json=excluded.data_json,reason=excluded.reason,source_file=excluded.source_file,status='pending',updated_at=excluded.updated_at",(key,json.dumps(row,ensure_ascii=False),reason,source,row['source_sheet'],row['source_row'],datetime.now().isoformat(timespec='seconds')))


def apply(token, selected_emails):
    if not isinstance(selected_emails,list) or not all(isinstance(v,str) for v in selected_emails): raise ValueError('请选择需要导入的联系人')
    with _LOCK:
        plan=_get(token)
        if plan.get('result'): return plan['result']
        if 'items' not in plan: raise ValueError('请先预览导入结果')
        selected=set(selected_emails);allowed={r['email'] for r in plan['items']}
        if not selected<=allowed: raise ValueError('选择中包含预览外的联系人')
        counts={'new':0,'update':0,'unchanged':0,'skipped':0,'pending':len(plan['pending'])}
        now=datetime.now().isoformat(timespec='seconds')
        with conn() as c:
            c.execute('BEGIN IMMEDIATE');existing={r['email'].casefold():dict(r) for r in c.execute('SELECT * FROM contacts')};extra=profiles(c)
            for row in plan['items']:
                if row['email'] in selected and _signature(existing.get(row['email']),extra.get(row['email'],{}))!=row['_signature']:
                    raise ValueError('联系人资料已被修改，请重新预览后导入')
            for row in plan['items']:
                if row['email'] not in selected:
                    counts['skipped']+=1
                    if row['conflicts']: _pending(c,row['_incoming'],plan['filename'],'文件内资料冲突，待核对');counts['pending']+=1
                    continue
                values=row['_next'];email=row['email']
                c.execute("INSERT INTO contacts(email,name,company,note,group_name,source,created_at,updated_at) VALUES(?,?,?,?,?,'manual',?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,company=excluded.company,note=CASE WHEN coalesce(contacts.note,'')='' THEN excluded.note ELSE contacts.note END,group_name=CASE WHEN coalesce(contacts.group_name,'')='' THEN excluded.group_name ELSE contacts.group_name END,source='manual',updated_at=excluded.updated_at",(email,values.get('name',''),values.get('company',''),values.get('note',''),values.get('group_name',''),now,now))
                if values.get('group_name'): c.execute('INSERT OR IGNORE INTO contact_groups(name) VALUES(?)',(values['group_name'],))
                c.execute("INSERT INTO contact_directory_profiles(email,data_json,imported_json,source_file,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET data_json=excluded.data_json,imported_json=excluded.imported_json,source_file=excluded.source_file,updated_at=excluded.updated_at",(email,json.dumps(_unflatten(values),ensure_ascii=False),json.dumps(row['_baseline'],ensure_ascii=False),plan['filename'],now))
                # A removed contact stays removed; imports never reset favorite, group, or personal note.
                if row['_incoming'].get('employee_id'):
                    key=_record_key(row['_incoming'])
                    c.execute("UPDATE contact_directory_pending SET status='resolved' WHERE record_key=?",(key,))
                counts[row['status']]+=1
            for row in plan['pending']: _pending(c,row,plan['filename'],row['reason'])
            c.execute('INSERT INTO contact_directory_imports(filename,digest,result_json,created_at) VALUES(?,?,?,?)',(plan['filename'],plan['digest'],json.dumps(counts),now))
        plan['result']={'ok':True,**counts}
        return plan['result']


def summary():
    with conn() as c:
        extra=profiles(c);visible={r['email'].casefold() for r in c.execute('SELECT email FROM contacts WHERE hidden=0')}
        depts={}
        for email,p in extra.items():
            if email in visible and p.get('department'):depts[p['department']]=depts.get(p['department'],0)+1
        pending=c.execute("SELECT COUNT(*) FROM contact_directory_pending WHERE status='pending'").fetchone()[0]
        recent=[dict(r)|{'result':json.loads(r['result_json'])} for r in c.execute('SELECT * FROM contact_directory_imports ORDER BY id DESC LIMIT 5')]
    return {'departments':[{'name':k,'count':v} for k,v in sorted(depts.items())],'pending':pending,'recent':recent}


def pending_records():
    with conn() as c:
        return [dict(r)|{'data':json.loads(r['data_json'])} for r in c.execute("SELECT * FROM contact_directory_pending WHERE status='pending' ORDER BY updated_at DESC LIMIT 5000")]


def resolve_pending(key,data):
    email=_valid_email(data.get('email'))
    if not email:raise ValueError('请填写有效邮箱')
    now=datetime.now().isoformat(timespec='seconds')
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        row=c.execute("SELECT * FROM contact_directory_pending WHERE record_key=? AND status='pending'",(key,)).fetchone()
        if not row:raise ValueError('该记录已处理，请刷新列表')
        if c.execute('SELECT 1 FROM contacts WHERE email=?',(email,)).fetchone():raise ValueError('已有同邮箱联系人，请先核对或在通讯录编辑现有资料，避免覆盖')
        profile=normalize_profile(data.get('profile') or {})
        c.execute("INSERT INTO contacts(email,name,company,source,created_at,updated_at) VALUES(?,?,?,'manual',?,?)",(email,clean(data.get('name'),80),clean(data.get('company'),120),now,now))
        save_profile(c,email,profile)
        original=json.loads(row['data_json'])
        baseline={**{k:original.get(k,'') for k in ('name','company')},**_flatten(original)}
        baseline={k:v for k,v in baseline.items() if v}
        c.execute('UPDATE contact_directory_profiles SET imported_json=?,source_file=? WHERE email=?',(json.dumps(baseline,ensure_ascii=False),row['source_file'],email))
        original['resolved_email']=email
        c.execute("UPDATE contact_directory_pending SET status='resolved',data_json=? WHERE record_key=?",(json.dumps(original,ensure_ascii=False),key))
    return {'ok':True,'email':email}
