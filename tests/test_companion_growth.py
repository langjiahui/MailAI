"""Growth caps, deduplication, lifecycle hooks and atomic client-wide purchases."""
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, companion_growth as growth
from app.account_context import use
from app.web.routes.companion_growth import Heartbeat
from pydantic import ValidationError


def main():
    with tempfile.TemporaryDirectory() as root:
        context = {'ACCOUNT_ID':'growth-a','DB_PATH':str(Path(root)/'a.db'),'IMAP_USER':'a@example.test'}
        now = datetime(2026, 10, 10, 10, tzinfo=timezone(timedelta(hours=8)))
        with use(context), patch.object(growth, '_now', return_value=now):
            db.init_db(); db.init_db()
            assert growth.snapshot()['xp'] == 0
            # Historical imports and repeated processing never reward new mail.
            old = db.upsert_email({'uid':1,'arrival_kind':'history','status':'inbox'})
            db.finish_email_processing(old)
            assert growth.snapshot()['xp'] == 0
            received = db.upsert_email({'uid':2,'message_id':'<new@example.test>','arrival_kind':'new','status':'inbox'})
            db.finish_email_processing(received); db.finish_email_processing(received)
            assert growth.snapshot()['xp'] == 2
            assert growth.snapshot()['streak'] == 0
            # Same message imported into another folder earns once.
            clone = db.upsert_email({'uid':3,'folder':'Other','message_id':'<new@example.test>','arrival_kind':'new','status':'inbox'})
            db.finish_email_processing(clone)
            assert growth.snapshot()['xp'] == 2
            sent = db.create_sent_message({'to_addr':'b@example.test','body_html':'hello','subject':'fixture'})
            db.finish_sent_message(sent, ok=False)
            assert growth.snapshot()['today']['counts'].get('sent',0) == 0
            db.finish_sent_message(sent,ok=True); db.finish_sent_message(sent,ok=True)
            assert growth.snapshot()['today']['counts']['sent'] == 1
            assert growth.snapshot()['xp'] == 22  # 2 received +10 send +10 active-day bonus
            # Retrying a client batch or opening a mail again cannot double-credit.
            with patch.object(growth.time,'time',return_value=1000):
                first = growth.heartbeat('heartbeat-0001',active=10,reading=10,email_id=old,clicks=10,learn='guide.topic.mail')
                retry = growth.heartbeat('heartbeat-0001',active=10,reading=10,email_id=old,clicks=10,learn='guide.topic.mail')
                assert first == retry
                # Concurrent tabs cannot both claim the same elapsed wall time.
                other = growth.heartbeat('heartbeat-0002',active=10,reading=10,email_id=received)
                assert other['today']['counts']['active'] == 10
                assert other['today']['counts']['reading'] == 10
            with patch.object(growth.time,'time',return_value=1010):
                next_tick = growth.heartbeat('heartbeat-0003',active=10,reading=10,email_id=old)
                assert next_tick['today']['counts']['read'] == 1
            # Short foreground segments accumulate instead of losing the 8s reward.
            with patch.object(growth.time,'time',return_value=1014):
                fragment = growth.heartbeat('fragment-0001',active=4,reading=4,email_id=received)
                assert fragment['today']['counts']['read'] == 1
            with patch.object(growth.time,'time',return_value=1018):
                completed = growth.heartbeat('fragment-0002',active=4,reading=4,email_id=received)
                assert completed['today']['counts']['read'] == 2
            # Caps stop rewards but retain honest activity totals.
            with growth.connection() as c:
                c.execute('BEGIN IMMEDIATE')
                growth._award(c,'click',100)
                before = growth._snapshot(c)
                growth._award(c,'click',100)
                after = growth._snapshot(c)
                assert before['xp'] == after['xp']
                assert after['today']['counts']['click'] == 210
                growth._award(c,'read',3,key='quest-reader')
                assert growth._snapshot(c)['quests'][0]['complete']
            # Pause stops every source, including successful backend sends.
            growth.set_enabled(False)
            paused = growth.snapshot()
            growth.record('tool',key='pause-tool')
            growth.heartbeat('paused-tick-1',active=10,clicks=10)
            assert growth.snapshot() == paused
            growth.set_enabled(True)
            # Streak reset and seven-day bonus are independent of spending.
            for index in range(1,7):
                growth.record('learn',key=f'streak-{index}',now=now+timedelta(days=index))
            final = now + timedelta(days=6)
            assert growth._now() == now
            with patch.object(growth,'_now',return_value=final):
                assert growth.snapshot()['streak'] == 7
                assert growth.snapshot()['today']['xp'] == 10+30+5+10  # check-in, weekly, learn, quest
            growth.record('tool',key='after-gap',now=now+timedelta(days=9))
            with patch.object(growth,'_now',return_value=now+timedelta(days=9)):
                assert growth.snapshot()['streak'] == 1
            # Purchases validate stage, ownership, balance and slot server-side.
            try: growth.purchase('wings'); raise AssertionError('locked item bought')
            except ValueError: pass
            try: growth.equip('accessory','cap'); raise AssertionError('unowned item equipped')
            except ValueError: pass
            with growth.connection() as c:
                c.execute('UPDATE companion_profile SET xp=1200,stamps=1000 WHERE id=1')
            before = growth.snapshot()
            ranger = growth.set_style('ranger')
            assert ranger['style'] == 'ranger' and ranger['xp'] == before['xp'] and ranger['stamps'] == before['stamps']
            try: growth.set_style('unknown'); raise AssertionError('invalid style accepted')
            except ValueError: pass
            bought = growth.purchase('scarf')
            assert bought['xp'] == before['xp'] and bought['stamps'] == 920
            assert bought['equipped']['accessory'] == 'scarf'
            assert growth.purchase('scarf')['stamps'] == 920
            growth.equip('accessory','')
            assert 'accessory' not in growth.snapshot()['equipped']
            first_berry = growth.purchase('berry',token='berry-once-0001')
            replay = growth.purchase('berry',token='berry-once-0001')
            assert replay == first_berry
            assert replay['berry_today'] == 1
            try: growth.purchase('sky',token='berry-once-0001'); raise AssertionError('purchase token reused for different item')
            except ValueError: pass
            for index in range(2): growth.purchase('berry',token=f'berry-next-{index}')
            assert growth.snapshot()['xp'] == 1440
            assert len([r for r in growth.snapshot()['purchases'] if r['item'] == 'berry']) == 3
            try: growth.purchase('berry'); raise AssertionError('berry daily limit bypassed')
            except ValueError: pass
            with growth.connection() as c: c.execute('UPDATE companion_profile SET stamps=0 WHERE id=1')
            try: growth.purchase('sky'); raise AssertionError('overspent')
            except ValueError: pass
            assert growth.snapshot()['stamps'] == 0
            # Faults inside optional hooks cannot roll back or partially award mail.
            def partial_failure(c,*args,**kwargs):
                c.execute('UPDATE companion_profile SET xp=xp+999 WHERE id=1')
                raise RuntimeError('simulated optional growth fault')
            original = growth.snapshot()['xp']
            with patch.object(growth,'_award',side_effect=partial_failure), patch.object(growth.log,'exception'):
                db.finish_sent_message(sent,ok=True)
            assert db.get_sent_message(sent)['status'] == 'sent'
            assert growth.snapshot()['xp'] == original
        # Two concurrent first-time purchases spend once.
        with use(context), growth.connection() as c:
            c.execute('UPDATE companion_profile SET stamps=120,xp=240 WHERE id=1')
        def purchase_sky(_):
            with use(context): return growth.purchase('sky')
        with ThreadPoolExecutor(max_workers=2) as pool: list(pool.map(purchase_sky,range(2)))
        with use(context):
            saved = growth.snapshot()
            assert saved['stamps'] == 0
            assert saved['equipped']['palette'] == 'sky'
            assert saved['style'] == 'ranger'
            db.init_db()
            assert growth.snapshot() == saved
            assert growth.purchase('berry',token='berry-once-0001') == saved
            with patch.object(growth,'_now',return_value=now+timedelta(days=1)):
                next_day = growth.snapshot()
                assert next_day['berry_today'] == 0
                assert growth.purchase('berry',token='berry-once-0001')['stamps'] == next_day['stamps']
                assert growth.snapshot()['berry_today'] == 0
        # Concurrent consumable retries also charge once, not once per worker.
        with use(context), growth.connection() as c:
            c.execute('UPDATE companion_profile SET stamps=600 WHERE id=1')
        def purchase_berry(_):
            with use(context): return growth.purchase('berry',token='concurrent-berry')
        with patch.object(growth,'_now',return_value=now+timedelta(days=1)), ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(purchase_berry,range(2)))
        with use(context):
            assert growth.snapshot()['stamps'] == 480
            assert len([r for r in growth.snapshot()['purchases'] if r['item'] == 'berry']) == 4
            # Workspace themes have an independent slot and permanent ownership.
            try: growth.equip('theme','theme_baowu'); raise AssertionError('unowned theme applied')
            except ValueError: pass
            try: growth.equip('theme','sky'); raise AssertionError('pet palette applied as workspace theme')
            except ValueError: pass
            with growth.connection() as c: c.execute('UPDATE companion_profile SET stamps=1000 WHERE id=1')
            baseline = growth.snapshot()
            mono = growth.purchase('theme_monochrome',token='theme-mono-once')
            assert mono['stamps'] == 700 and mono['xp'] == baseline['xp']
            assert mono['equipped']['theme'] == 'theme_monochrome'
            assert mono['equipped']['palette'] == baseline['equipped']['palette']
            assert growth.purchase('theme_monochrome',token='theme-mono-once') == mono
            blue = growth.purchase('theme_baowu',token='theme-blue-once')
            assert blue['stamps'] == 220 and blue['equipped']['theme'] == 'theme_baowu'
            assert growth.purchase('theme_baowu')['stamps'] == 220
            growth.set_style('nature')
            assert growth.snapshot()['equipped'] == blue['equipped']
            growth.set_style('ranger')
            growth.equip('theme','theme_monochrome')
            assert growth.snapshot()['stamps'] == 220
            reset = growth.equip('theme','')
            assert 'theme' not in reset['equipped']
            assert all(item['owned'] for item in reset['items'] if item['slot'] == 'theme')
            themed = growth.equip('theme','theme_baowu')
            db.init_db()
            assert growth.snapshot() == themed
        with use({'ACCOUNT_ID':'growth-b','DB_PATH':str(Path(root)/'b.db'),'IMAP_USER':'b@example.test'}):
            db.init_db()
            assert growth.snapshot() == themed
            assert growth.snapshot()['scope'] == 'client'
            with growth.connection() as c: c.execute('ALTER TABLE companion_profile DROP COLUMN style')
            db.init_db()
            assert growth.snapshot()['style'] == 'nature'
        for invalid in ({'token':'bad'}, {'token':'valid-token','active':-1}, {'token':'valid-token','clicks':11}, {'token':'valid-token','reading':31}):
            try: Heartbeat(**invalid); raise AssertionError(invalid)
            except ValidationError: pass
    print('Companion growth caps, streaks, hooks, purchases, persistence and client-wide sharing passed')


if __name__ == '__main__': main()
