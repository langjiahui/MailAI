"""Exact identities, mixed-version history and recipient-name round trips."""
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from email.utils import getaddresses
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, parser, smtp_client


def main():
    with tempfile.TemporaryDirectory() as root, patch.object(config, 'DB_PATH', str(Path(root)/'mail.db')):
        db.init_db()
        for uid, date, names, raw in [
            (1,'2026-01-01',{'person@example.test':'旧名字'},''),
            (2,'2026-09-10',{},'new.eml'),
            (3,'2026-09-11',{'person@example.test':'最新名字'},''),
            (4,'2025-01-01',{},'old.eml'),
        ]:
            db.upsert_email(dict(uid=uid, date=date, recipient_names=names, raw_path=raw, status='inbox'))
        with db.conn() as c:
            c.executemany("INSERT INTO emails(uid,folder,date,raw_path,recipient_names,status) VALUES(?,'INBOX','2026-09-01',?,'{}','inbox')",
                          [(n,f'empty-{n}.eml') for n in range(10,3015)])
        def names(path):
            return {'new.eml':{'person@example.test':'新名字'},'old.eml':{'old@example.test':'历史姓名'}}.get(path,{})
        with patch.object(parser,'recipient_names_from_raw_path',side_effect=names):
            assert db.contact_display_names(['person@example.test'])['person@example.test']['name']=='最新名字'
            assert db.contact_display_names(['old@example.test'])['old@example.test']['name']=='历史姓名', 'Old raw headers beyond 3000 rows must be considered'
            with db.conn() as c:
                c.execute('DELETE FROM emails WHERE uid=3')
            assert db.contact_display_names(['person@example.test'])['person@example.test']['name']=='新名字', 'New raw header must beat old structured header'
            db.save_contact('person@example.test','人工维护')
            assert db.contact_display_names(['person@example.test'])['person@example.test']['name']=='人工维护'
        raw = Path(root)/'cache.eml'
        raw.write_bytes('To: 陈甲 <cache@example.test>\r\n\r\nbody'.encode())
        assert parser.recipient_names_from_raw_path(str(raw))['cache@example.test']=='陈甲'
        with patch('builtins.open',side_effect=AssertionError('cached header re-read')):
            assert parser.recipient_names_from_raw_path(str(raw))['cache@example.test']=='陈甲'
        raw.write_bytes('To: 陈乙乙 <cache@example.test>\r\n\r\nbody'.encode())
        assert parser.recipient_names_from_raw_path(str(raw))['cache@example.test']=='陈乙乙'

    for name in ['张三;项目组', '张三，采购；项目', '张三,,采购', '张三(采购)', '张三:项目', '张三"采购"', '张三\\采购']:
        quoted='"'+name.replace('\\','\\\\').replace('"','\\"')+'"'
        fields={'to_addr':f'{quoted} <person@example.test>； other@example.test'}
        normalized=smtp_client.normalize_recipient_fields(fields)
        for _ in range(3):
            display=smtp_client.recipient_fields_for_display(normalized)
            assert getaddresses([display['to_addr']])[0] == (name,'person@example.test')
            normalized=smtp_client.normalize_recipient_fields(display)
            assert normalized['recipients']==['person@example.test','other@example.test']
    for broken in ['"姓名 <a@example.test>', '姓名 <a@example.test', '"姓名\r\nBcc: x@example.test" <a@example.test>']:
        try: smtp_client.normalize_recipient_fields({'to_addr':broken})
        except ValueError: pass
        else: raise AssertionError('Malformed input was silently accepted')
    print('PASS chronological name sources, >3000 legacy headers, manual names, header cache and punctuation round trips')


if __name__ == '__main__': main()
