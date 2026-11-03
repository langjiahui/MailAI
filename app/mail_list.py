"""Bounded local mailbox queries; no original files, IMAP or model calls."""
import base64
from contextlib import ExitStack
import hashlib
import json
import logging
import os
import re
import sqlite3
import time

from . import config, db

log = logging.getLogger(__name__)
DATE = 'list_date'
RISK = """CASE WHEN feedback='fp' AND reviewed<>0 THEN 'clean'
    WHEN feedback='fn' THEN 'phishing' WHEN verdict='unreviewed' THEN 'unreviewed'
    WHEN verdict='phishing' OR score>=70 THEN 'phishing'
    WHEN verdict='suspicious' OR score>=35 THEN 'suspicious' ELSE 'clean' END"""


def initialize(c):
    from .mail_identities import initialize as identities
    identities(c)
    if 'list_date' not in {row[1] for row in c.execute('PRAGMA table_info(emails)')}:
        c.execute('ALTER TABLE emails ADD COLUMN list_date REAL')
    c.execute("UPDATE emails SET list_date=COALESCE(julianday(NULLIF(date,''),'utc'),julianday(created_at,'utc'),0) WHERE list_date IS NULL")
    for event,suffix in [('INSERT','insert'),('UPDATE OF date,created_at','update')]:
        c.execute(f'''CREATE TRIGGER IF NOT EXISTS mail_list_date_{suffix} AFTER {event} ON emails BEGIN
            UPDATE emails SET list_date=COALESCE(julianday(NULLIF(NEW.date,''),'utc'),julianday(NEW.created_at,'utc'),0) WHERE id=NEW.id; END''')
    c.execute(f'CREATE INDEX IF NOT EXISTS idx_mail_list_date ON emails(remote_missing,{DATE},id)')
    c.execute(f'CREATE INDEX IF NOT EXISTS idx_mail_list_status_date ON emails(status,remote_missing,{DATE},id)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_mail_list_sender ON emails(lower(from_addr))')
    c.execute('CREATE INDEX IF NOT EXISTS idx_mail_list_folder_date ON emails(folder,remote_missing,list_date,id)')
    c.execute('CREATE TABLE IF NOT EXISTS mail_list_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,email_id INTEGER NOT NULL)')
    for action in ('INSERT', 'UPDATE', 'DELETE'):
        prefix = 'OLD' if action == 'DELETE' else 'NEW'
        c.execute(f'''CREATE TRIGGER IF NOT EXISTS mail_list_{action.lower()} AFTER {action} ON emails BEGIN
            INSERT INTO mail_list_changes(email_id) VALUES({prefix}.id);
            DELETE FROM mail_list_changes WHERE seq <= last_insert_rowid()-10000; END''')
    for table in ('contacts', 'focus_senders', 'drafts', 'sent_messages'):
        for action in ('INSERT', 'UPDATE', 'DELETE'):
            c.execute(f'''CREATE TRIGGER IF NOT EXISTS mail_list_{table}_{action.lower()} AFTER {action} ON {table} BEGIN
                UPDATE mailbox_sequence SET value=value+1 WHERE id=1; END''')


def validate(value):
    if not isinstance(value, dict):
        raise ValueError('无效的列表筛选条件')
    allowed = {'status','folder','days','verdict','category','priority','domain','unread','attachments','tags','tag_mode','sort','workflow','unified','special','conversations'}
    if set(value) - allowed:
        raise ValueError('无效的列表筛选条件')
    result = {key: value.get(key, '') for key in ('status','folder','verdict','category','priority','domain','workflow')}
    if any(not isinstance(v, str) or len(v)>300 for v in result.values()):
        raise ValueError('列表筛选条件过长')
    result['days'] = int(value.get('days',9999))
    if result['days'] < 1 or result['days'] > 365000:
        raise ValueError('无效的日期范围')
    result.update({key: bool(value.get(key,False)) for key in ('unread','attachments','unified','conversations')})
    tags = value.get('tags',[])
    if not isinstance(tags,list) or len(tags)>50 or any(not isinstance(t,str) or len(t)>80 for t in tags):
        raise ValueError('无效的标签筛选条件')
    result['tags'] = sorted(set(tags))
    result['tag_mode'] = value.get('tag_mode','any')
    result['sort'] = value.get('sort','date-desc')
    result['special'] = value.get('special','')
    if result['special'] not in ('','sent','drafts') or result['special'] and result['unified']:
        raise ValueError('无效的列表筛选条件')
    if result['tag_mode'] not in ('any','all') or result['sort'] not in ('date-desc','date-asc','score-desc'):
        raise ValueError('无效的排序或标签筛选')
    if result['workflow'] not in ('','all','focus','unhandled','reply','waiting','later','done'):
        raise ValueError('无效的处理状态')
    return result


def condition(q, *, omit=(), user=None):
    status = 'inbox' if q['unified'] else q['status']
    clauses = ["(pending_action IN ('trash','trash_copying','trash_copied','trash_locating','trash_local') OR (remote_missing=0 AND status='trash'))" if status=='trash' else 'remote_missing=0']
    args=[]
    if status=='favorites':clauses.append('is_favorite=1')
    elif status and status!='trash':clauses.append('status=?');args.append(status)
    if q['folder']:clauses.append('folder=?');args.append(q['folder'])
    if q['days'] not in (9999,365000):
        clauses.append(f"{DATE}>=julianday('now',?)");args.append(f"-{q['days']} days")
    if q['priority']:clauses.append('priority=?');args.append(q['priority'])
    if q['domain']:
        clauses.append("lower(substr(from_addr,instr(from_addr,'@')+1))=?");args.append(q['domain'].lower())
    if q['unread']:clauses.append("is_read=0 AND status NOT IN ('sent','draft') AND lower(coalesce(from_addr,''))<>?");args.append(str(config.IMAP_USER if user is None else user or '').lower())
    if q['attachments']:clauses.append("json_array_length(CASE WHEN json_valid(attachments) THEN attachments ELSE '[]' END)>0")
    if q['workflow']=='focus':
        clauses.append("focus_override='focus' OR (focus_override='' AND NOT EXISTS(SELECT 1 FROM focus_senders f WHERE f.address=lower(from_addr) AND f.choice='other') AND (priority='高' OR EXISTS(SELECT 1 FROM focus_senders f WHERE f.address=lower(from_addr) AND f.choice='focus') OR EXISTS(SELECT 1 FROM contacts c WHERE lower(c.email)=lower(from_addr) AND c.favorite=1 AND c.hidden=0)))")
    elif q['workflow'] not in ('','all'):
        clauses.append("coalesce(nullif(handle_state,''),'unhandled')=?");args.append(q['workflow'])
    if 'verdict' not in omit and q['verdict']:clauses.append(f'{RISK}=?');args.append(q['verdict'])
    if 'category' not in omit and q['category']:clauses.append("coalesce(nullif(category,''),'未分类')=?");args.append(q['category'])
    where=' AND '.join('('+part+')' for part in clauses)
    if 'tags' not in omit:
        from .db.mail_tags import filter_sql
        sql, values=filter_sql(q['tags'],q['tag_mode']);where+=sql;args.extend(values)
    return where,args


def _special_source(kind):
    """One metadata union preserves SMTP receipt identity and server-copy dedup."""
    table='drafts' if kind=='drafts' else 'sent_messages'
    status='draft' if kind=='drafts' else 'sent'
    fields=db.EMAIL_LIST_COLUMNS.split(',')+['cc_addr','bcc_addr','body_html','remote_email_id','_remote','_kind','_search_summary','remote_missing','list_date']
    metadata="""(SELECT coalesce(json_group_array(json_object('filename',coalesce(json_extract(value,'$.filename'),json_extract(value,'$.name'),'附件'),
        'size',coalesce(json_extract(value,'$.size'),0),'content_type',coalesce(json_extract(value,'$.content_type'),''))),'[]')
        FROM json_each(CASE WHEN json_valid(attachments_json) THEN attachments_json ELSE '[]' END))"""
    local={'id':'id','message_id':"''" if kind=='drafts' else 'message_id','subject':'subject','from_addr':"''" if kind=='drafts' else 'from_addr',
        'to_addr':'to_addr','cc_addr':'cc_addr','bcc_addr':'bcc_addr','date':'updated_at' if kind=='drafts' else 'coalesce(sent_at,created_at)',
        'created_at':'created_at','snippet':'substr(body_html,1,1000)','summary':'substr(body_html,1,1000)',
        'attachments':metadata,'body_html':"''",'status':"'draft'" if kind=='drafts' else 'status',
        'is_read':'1','_remote':'0','_kind':"'draft'" if kind=='drafts' else "'sent'",'_search_summary':'1','remote_missing':'0'}
    local['list_date']="coalesce(julianday("+local['date']+",'utc'),0)"
    remote={field:field for field in db.EMAIL_LIST_COLUMNS.split(',')}
    remote.update(id='-id',cc_addr='cc_addr',bcc_addr="''",body_html="''",remote_email_id='id',_remote='1',_kind=local['_kind'],_search_summary='1',remote_missing='0',list_date='list_date')
    def projection(values):return ','.join(values.get(field,'NULL')+' AS '+field for field in fields)
    exclude=''
    if kind=='sent':
        exclude=""" AND (coalesce(message_id,'')='' OR NOT EXISTS(SELECT 1 FROM sent_messages s WHERE lower(trim(s.message_id))=lower(trim(main.emails.message_id))))"""
        local_where=""" WHERE coalesce(trim(message_id),'')='' OR NOT EXISTS(SELECT 1 FROM main.emails e
            WHERE lower(trim(e.message_id))=lower(trim(sent_messages.message_id)) AND (e.status='trash' OR e.pending_action='trash'))"""
    else:local_where=''
    return f"WITH emails AS (SELECT {projection(local)} FROM {table}{local_where} UNION ALL SELECT {projection(remote)} FROM main.emails WHERE remote_missing=0 AND status='{status}'{exclude}) "


def _stamp(c):
    return ':'.join(str(v) for v in c.execute('SELECT (SELECT coalesce(max(seq),0) FROM mail_list_changes),(SELECT value FROM mailbox_sequence WHERE id=1),(SELECT value FROM mail_identity_revision WHERE id=1)').fetchone())


def _connections(stack,q):
    if not q['unified']:
        owner = hashlib.sha256(str(config.DB_PATH).encode()).hexdigest()[:24]
        return [(owner,str(config.IMAP_USER or ''),stack.enter_context(db.conn()))]
    from . import system_settings
    result=[]
    for account_id,item in sorted(system_settings._load_registry().get('accounts',{}).items()):
        path=item.get('db_path','')
        if not item.get('visible',True) or not os.path.isfile(path):continue
        c=stack.enter_context(system_settings._sqlite_connection(path));c.row_factory=sqlite3.Row
        # Legacy accounts are upgraded by their normal activation, never silently
        # omitted from a unified mailbox when new list metadata is unavailable.
        if not c.execute("SELECT 1 FROM sqlite_master WHERE name='mail_list_changes'").fetchone():
            from .account_context import use
            with use(dict(ACCOUNT_ID=account_id,DB_PATH=path,IMAP_USER=item.get('user',''),RAW_DIR=item.get('raw_dir',''))):
                db.init_db()
        result.append((account_id,item.get('user',''),c))
    return result


def page(filters, *, cursor='', limit=200, refresh=False, around_id=0):
    q=validate(filters);limit=max(1,min(int(limit),200));started=time.monotonic()
    fingerprint=hashlib.sha256(json.dumps(q,sort_keys=True,ensure_ascii=True).encode()).hexdigest()
    position=None
    if cursor:
        try:
            if len(cursor)>16000:raise ValueError()
            position=json.loads(base64.urlsafe_b64decode(cursor.encode()))
            if position['query']!=fingerprint or not isinstance(position['stamps'],dict):raise ValueError()
            if not isinstance(position['key'],list) or len(position['key'])!=3:raise ValueError()
            float(position['key'][0]);int(position['key'][1]);str(position['key'][2])
        except (ValueError,TypeError,KeyError,UnicodeError) as exc:raise ValueError('无效的列表分页位置') from exc
    items=[];stamps={};facets={'risk':{},'categories':{},'tags':{}};total=0;domains=set()
    counts={'totals':{},'local':{},'all':0}
    sort_expr='COALESCE(score,0)' if q['sort']=='score-desc' else DATE
    ascending=q['sort']=='date-asc';direction='ASC' if ascending else 'DESC'
    with ExitStack() as stack:
        connections=_connections(stack,q)
        for account,user,c in connections:
            c.execute('BEGIN')
            stamps[account]=_stamp(c)
            if position and not refresh and position['stamps'].get(account)!=stamps[account]:raise StalePage()
            prefix=_special_source(q['special']) if q['special'] else ''
            where,args=condition(q,user=user)
            total+=c.execute(prefix+f'SELECT count(*) FROM emails WHERE {where}',args).fetchone()[0]
            for kind,omit,expr in [('risk',('verdict',),RISK),('categories',('category',),'coalesce(nullif(category,\'\'),\'未分类\')')]:
                clause,values=condition(q,omit=omit,user=user)
                for row in c.execute(prefix+f'SELECT {expr},count(*) FROM emails WHERE {clause} GROUP BY {expr}',values):
                    facets[kind][row[0]]=facets[kind].get(row[0],0)+row[1]
            clause,values=condition(q,omit=('tags',),user=user)
            for row in c.execute(prefix+f'''SELECT t.name,count(*) FROM emails JOIN email_tags et ON et.email_id=emails.id
                    JOIN mail_tags t ON t.id=et.tag_id WHERE {clause} GROUP BY t.name''',values):
                facets['tags'][row[0]]=facets['tags'].get(row[0],0)+row[1]
            for row in c.execute("SELECT lower(substr(from_addr,instr(from_addr,'@')+1)) FROM main.emails WHERE remote_missing=0 AND instr(from_addr,'@')>0 GROUP BY 1"):
                domains.add(row[0])
            for row in c.execute('SELECT status,is_local_archive,count(*) FROM main.emails WHERE remote_missing=0 GROUP BY status,is_local_archive'):
                counts['totals'][row[0]]=counts['totals'].get(row[0],0)+row[2];counts['all']+=row[2]
                if row[1]:counts['local'][row[0]]=counts['local'].get(row[0],0)+row[2]
            receipts=c.execute("""SELECT COUNT(*) FROM sent_messages s
                WHERE trim(COALESCE(s.message_id,''))='' OR lower(trim(s.message_id)) NOT IN (
                    SELECT lower(trim(message_id)) FROM main.emails WHERE trim(COALESCE(message_id,''))<>''
                    AND (status='trash' OR pending_action='trash' OR (remote_missing=0 AND status='sent')))
                """).fetchone()[0]
            counts['totals']['sent']=counts['totals'].get('sent',0)+receipts
            page_where=''
            page_args=[]
            if position:
                key,email_id,owner=position['key'];op='>' if ascending else '<'
                # Account is the final deterministic tie breaker in unified mode.
                include_equal=account>owner if ascending else account<owner
                page_where=f'({sort_expr}{op}? OR ({sort_expr}=? AND (id{op}?'+(' OR id=?' if include_equal else '')+')))'
                page_args=[key,key,email_id];page_args.extend([email_id] if include_equal else [])
            elif around_id and not q['unified'] and not q['special']:
                target=c.execute(f'SELECT {sort_expr},id FROM emails WHERE id=? AND {where}',[around_id,*args]).fetchone()
                if target:
                    op='>' if ascending else '<'
                    page_where=f'({sort_expr}{op}? OR ({sort_expr}=? AND id{op}=?))'
                    page_args=[target[0],target[0],target[1]]
            columns=db.EMAIL_LIST_COLUMNS+(',cc_addr,bcc_addr,body_html,remote_email_id,_remote,_kind,_search_summary' if q['special'] else '')
            if q['conversations'] and not q['special']:
                group="coalesce(nullif(thread_id,''),nullif(message_id,''),'single-'||id)"
                sql=f'''WITH grouped AS (SELECT {columns},list_date,coalesce(score,0) AS _score,
                    count(*) OVER(PARTITION BY {group}) AS _conversationCount,
                    row_number() OVER(PARTITION BY {group} ORDER BY {sort_expr} {direction},id {direction}) AS _rank
                    FROM emails WHERE {where})
                    SELECT *,{'_score' if q['sort']=='score-desc' else DATE} AS _sort_key FROM grouped WHERE _rank=1'''
                if page_where:sql+=' AND '+page_where.replace('COALESCE(score,0)','_score')
                sql+=f' ORDER BY _sort_key {direction},id {direction} LIMIT ?'
            else:
                sql=prefix+f'SELECT {columns},{sort_expr} AS _sort_key FROM emails WHERE {where}'+(' AND '+page_where if page_where else '')+f' ORDER BY {sort_expr} {direction},id {direction} LIMIT ?'
            rows=db._decode_rows(c.execute(sql,[*args,*page_args,limit+1]).fetchall(),connection=c)
            names=db.contact_display_names([v for r in rows for v in (r.get('from_addr'),r.get('to_addr')) if v],connection=c,allow_raw=False)
            from .web.helpers import annotate_list_identity
            for row in rows:
                annotate_list_identity(row,names,current_user=user)
                if q['special']:
                    row['updated_at' if q['special']=='drafts' else 'sent_at']=row['date']
                if q['status']=='trash' and row.get('pending_action'):row['status']='trash'
                if q['unified']:row.update(_account_id=account,_account_user=user)
                row['_owner']=account;items.append(row)
        if position and not refresh and set(position['stamps'])!=set(stamps):raise StalePage()
    items.sort(key=lambda row:(row['_sort_key'],row['id'],row['_owner']),reverse=not ascending)
    more=len(items)>limit;items=items[:limit];next_cursor=''
    if more:
        row=items[-1]
        next_cursor=base64.urlsafe_b64encode(json.dumps({'query':fingerprint,'stamps':stamps,'key':[row['_sort_key'],row['id'],row['_owner']]},separators=(',',':')).encode()).decode()
    for row in items:
        for field in ('_sort_key','_owner','_rank','_score','list_date'):
            row.pop(field,None)
        if q['special']:
            row['summary']=re.sub(r'<[^>]+>',' ',row.get('summary') or '')
        if isinstance(row.get('attachments'),list):
            row['attachments']=[{key:value for key,value in attachment.items() if key in {'name','filename','size','content_type','content_id','disposition'}}
                                for attachment in row['attachments'] if isinstance(attachment,dict)]
    elapsed=time.monotonic()-started
    if elapsed>=1:log.warning('Slow mailbox metadata query: rows=%d total=%d seconds=%.2f',len(items),total,elapsed)
    # Background repair is independent of the current response and account data.
    if not q['unified']:
        from .mail_identities import schedule
        schedule()
    return {'items':items,'total':total,'facets':facets,'counts':counts,'domains':sorted(domains),'next':next_cursor,'revision':stamps}


class StalePage(ValueError):
    def __init__(self):super().__init__('邮件列表已更新，请重新载入当前列表')
