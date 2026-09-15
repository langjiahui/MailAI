"""Representative mailbox profiling, entirely local and disposable."""
import gc
import json
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path
from datetime import datetime
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from app import db, mail_assistant
from app.account_context import use


def main():
    with tempfile.TemporaryDirectory(prefix='mailai-memory-') as root, use(dict(DB_PATH=str(Path(root)/'mail.db'),ACCOUNT_ID='fixture')):
        db.init_db()
        now=datetime.now().isoformat()
        body='x'*32768
        with db.conn() as connection:
            connection.executemany('INSERT INTO emails(uid,date,subject,body_text,body_html) VALUES(?,?,?,?,?)',
                ((n,now,'fixture',body,body) for n in range(2000)))
        tracemalloc.start()
        old=db.list_emails(days=9999,limit=100000)
        full_peak=tracemalloc.get_traced_memory()[1]
        del old
        gc.collect();tracemalloc.reset_peak()
        started=time.monotonic()
        for _ in range(30):
            assert mail_assistant.alerts()['risk_count']==0
        metadata_peak=tracemalloc.get_traced_memory()[1]
        elapsed=time.monotonic()-started
        tracemalloc.stop()
        assert metadata_peak < 16*1024*1024
        assert metadata_peak < full_peak/5
        print(json.dumps(dict(emails=2000,bodyBytesPerEmail=65536,fullReadPeakBytes=full_peak,
            alertPasses=30,alertsPeakBytes=metadata_peak,elapsedSeconds=round(elapsed,3))))


if __name__=='__main__':main()
