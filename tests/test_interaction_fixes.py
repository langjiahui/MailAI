"""Search parity and old unresolved outbox items, in isolated storage."""
import tempfile
from pathlib import Path
import sys
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from app import db,outbox,system_settings
from app.account_context import use

def main():
    with tempfile.TemporaryDirectory() as directory,use({'ACCOUNT_ID':'test','DB_PATH':str(Path(directory)/'test.db')}):
        db.init_db()
        db.upsert_email({'uid':1,'date':'2026-09-08','status':'inbox','summary':'稀有关键词','subject':'普通主题'})
        registry={'accounts':{'test':{'db_path':str(Path(directory)/'test.db'),'user':'test@example.test'}}}
        with patch.object(system_settings,'_load_registry',return_value=registry):
            assert len(system_settings.list_unified_inbox(q='稀有关键词'))==len(db.search_emails(['稀有关键词']))==1
            assert len(system_settings.list_unified_inbox(q='未命中 稀有关键词'))==1
        assert db.search_emails(['稀有关键词'],folder='Other')==[]
        with db.conn() as c:
            c.execute("INSERT INTO outbox(token,payload,status,created_at,due_at,updated_at) VALUES('pending','{}','unknown','2026-09-01','2026-09-01','2026-09-01')")
            c.executemany("INSERT INTO outbox(token,payload,status,created_at,due_at,updated_at) VALUES(?,'{}','sent','2026-09-08','2026-09-08','2026-09-08')",[(str(i),) for i in range(201)])
        assert any(row['token']=='pending' for row in outbox.items())
    print('PASS unified indexed search parity, folder scoping, old unresolved outbox visibility')

if __name__=='__main__':main()
