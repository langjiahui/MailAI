"""Signed gifts: issuer authority, recipient binding, atomic retry, expiry and backups."""
import hashlib
import json
import sqlite3
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from app import config, db, companion_growth as growth, companion_gifts as gifts
from app.account_context import use
from app.web.routes.companion_growth import Gift, preview_gift
from fastapi import HTTPException
from pydantic import ValidationError
from scripts.companion_gift_issuer import issue, public, initialize, load_key, issue_saved, history, LABELS, LABELS_EN


def fails(action, name):
    try:
        action()
    except gifts.GiftError as exc:
        assert exc.code == name, (exc.code, name)
    else:
        raise AssertionError('Invalid gift accepted: '+name)


def raw_sign(key, payload):
    raw = gifts.canonical(payload)
    return 'XYG1.'+gifts.encode(raw)+'.'+gifts.encode(key.sign(gifts.DOMAIN+raw))


def main():
    catalog=Path('app/web/static/i18n-catalog.js').read_text(encoding='utf-8')
    copy=json.loads(catalog.split('const MAILAI_UI_COPY = ',1)[1].split('\n};',1)[0]+'\n}')
    for item in LABELS:
        assert [LABELS[item],LABELS_EN[item]] == copy['pet.item.'+item], 'Issuing and receiving must use the same item names'
    key = Ed25519PrivateKey.generate()
    kid, raw = public(key)
    now = datetime(2026, 10, 12, 14, tzinfo=timezone.utc)
    timestamp = int(now.timestamp())
    with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2]) as temp, patch.object(config, 'DATA_DIR', temp), patch.object(gifts, 'TRUSTED_KEYS', {kid:raw}), patch.object(growth, '_now', return_value=now):
        root = Path(temp)
        profile = dict(ACCOUNT_ID='gift-a', DB_PATH=str(root/'a'/'mailai.db'), IMAP_USER='a@example.test')
        Path(profile['DB_PATH']).parent.mkdir()
        with use(profile):
            db.init_db();growth.set_enabled(False)
            before = growth.snapshot(); recipient = before['claim_code']
            assert recipient.startswith('XY-') and gifts.normalize_recipient(recipient.lower()) == recipient
            with growth.connection() as c:
                identity = c.execute('SELECT id FROM companion_client').fetchone()['id']
            assert gifts.recipient_code(identity) == recipient
            payload, code = issue(key,['wings','aurora','theme_baowu'],title='<小邮见面礼>',recipient=recipient,days=7,now=timestamp)
            info = gifts.preview(code)
            assert gifts.preview('\ufeff'+code+'\n') == info
            assert info['exclusive'] and not info['claimed'] and len(info['items']) == 3
            assert growth.snapshot() == before, 'Preview must not grant or change any saved state'
            fails(lambda:gifts.preview(code[:-1]+('A' if code[-1] != 'A' else 'B')), 'invalid')
            altered = dict(payload, items=['scarf']); fails(lambda:gifts.preview('XYG1.'+gifts.encode(gifts.canonical(altered))+'.'+code.split('.')[2]),'invalid')
            wrong = Ed25519PrivateKey.generate();fails(lambda:gifts.preview(raw_sign(wrong,payload)),'invalid')
            unknown,_ = issue(wrong,['scarf'],title='unknown',now=timestamp);fails(lambda:gifts.preview(raw_sign(wrong,unknown)),'issuer')
            for malformed in ['', '[]', 'XYG1.x.y', 'XYG1.'+gifts.encode(b'{')+'.'+gifts.encode(b'x'*64), code+'=', 'x'*8193]:
                fails(lambda:gifts.preview(malformed),'invalid')
            for change in [dict(v=True), dict(items=['wings','wings']), dict(expires=True), dict(issued=-1), dict(extra='x')]:
                fails(lambda:gifts.preview(raw_sign(key,dict(payload,**change))),'invalid')
            fails(lambda:gifts.preview(raw_sign(key,dict(payload,items=['berry']))),'unsupported')
            fails(lambda:gifts.preview(raw_sign(key,dict(payload,items=['future_skin']))),'unsupported')
            fails(lambda:gifts.preview(raw_sign(key,dict(payload,issued=timestamp+3600,expires=0))),'future')
            fails(lambda:gifts.preview(raw_sign(key,dict(payload,issued=timestamp-90000,expires=timestamp))),'expired')
            foreign = gifts.recipient_code('0'*32)
            fails(lambda:gifts.preview(raw_sign(key,dict(payload,recipient=foreign))),'recipient')
            try:
                preview_gift(Gift(code=raw_sign(key,dict(payload,recipient=foreign))))
            except HTTPException as exc:
                assert exc.status_code == 400
            else:
                raise AssertionError('API accepted wrong recipient')
            try:
                Gift(code='x'*8193)
            except ValidationError:
                pass
            else:
                raise AssertionError('API body limit missing')
            # All concurrent claims share one receipt; growth, balance, pause and outfit are untouched.
            def claim():
                with use(profile):
                    return gifts.claim(code)
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _:claim(),range(16)))
            after = growth.snapshot()
            assert all(result == after for result in results)
            assert (after['xp'],after['stamps'],after['earned'],after['equipped'],after['enabled']) == (before['xp'],before['stamps'],before['earned'],before['equipped'],False)
            assert len(after['gifts']) == 1 and gifts.preview(code)['claimed']
            assert all(item['owned'] for item in after['items'] if item['id'] in payload['items'])
            assert after['stage'] == 1 and growth.equip('accessory','wings')['equipped']['accessory'] == 'wings'
            assert gifts.claim(code)['gifts'] == after['gifts']
            with patch.object(growth, '_now', return_value=datetime(2028,1,1,tzinfo=timezone.utc)):
                assert gifts.preview(code)['claimed'];gifts.claim(code)
            fails(lambda:gifts.claim(raw_sign(key,dict(payload,title='changed same ID'))),'conflict')
            # Claiming different vouchers for owned items is harmless and records the new gift.
            _, again = issue(key,['wings'],title='another gift',recipient=recipient,now=timestamp)
            gifts.claim(again);assert len(growth.snapshot()['gifts']) == 2
            backup_state = growth.snapshot()
            backup = root/'pet-backup.db';growth.export_store(backup)
            # Any mailbox sharing this client sees the same recipient and inventory.
            with use(dict(ACCOUNT_ID='gift-b', DB_PATH=str(root/'a'/'other.db'), IMAP_USER='b@example.test')):
                db.init_db(); assert growth.snapshot()['claim_code'] == recipient
            restored_account = dict(ACCOUNT_ID='restored', DB_PATH=str(root/'restored'/'mailai.db'), IMAP_USER='restored@example.test')
            Path(restored_account['DB_PATH']).parent.mkdir()
            with use(restored_account), patch.object(config, 'DATA_DIR',str(root/'restored')):
                db.init_db();growth.import_store(backup)
                restored = growth.snapshot()
                assert restored['claim_code'] == recipient
                assert restored['gifts'] == backup_state['gifts'] and restored['equipped'] == backup_state['equipped']
                assert len(restored['gifts']) == 2 and gifts.preview(code)['claimed']
                assert all(item['owned'] for item in restored['items'] if item['id'] in payload['items'])
                growth.import_store(backup);assert growth.snapshot() == restored
            # Merge onto existing progress, export again, then restore: foreign receipts remain valid.
            merged_account=dict(ACCOUNT_ID='merged',DB_PATH=str(root/'merged'/'mailai.db'),IMAP_USER='merged@example.test')
            Path(merged_account['DB_PATH']).parent.mkdir()
            merged_backup=root/'merged-backup.db'
            with use(merged_account),patch.object(config,'DATA_DIR',str(root/'merged')):
                db.init_db()
                with growth.connection() as c:
                    c.execute('UPDATE companion_profile SET xp=1,earned=1,stamps=1 WHERE id=1')
                merged_identity=growth.snapshot()['claim_code']
                assert merged_identity != recipient
                growth.import_store(backup)
                assert growth.snapshot()['claim_code'] == merged_identity
                assert gifts.preview(code)['claimed']
                growth.export_store(merged_backup)
            roundtrip_account=dict(ACCOUNT_ID='roundtrip',DB_PATH=str(root/'roundtrip'/'mailai.db'),IMAP_USER='roundtrip@example.test')
            Path(roundtrip_account['DB_PATH']).parent.mkdir()
            with use(roundtrip_account),patch.object(config,'DATA_DIR',str(root/'roundtrip')):
                db.init_db();growth.import_store(merged_backup)
                assert growth.snapshot()['claim_code'] == merged_identity
                assert growth.snapshot()['gifts'] == backup_state['gifts']
                assert gifts.preview(code)['claimed']
            # A campaign can be claimed once per independent client, never once per mailbox.
            _, campaign = issue(key,['scarf'],title='campaign',now=timestamp)
            assert not gifts.preview(campaign)['exclusive'];gifts.claim(campaign)
            other_account = dict(ACCOUNT_ID='independent',DB_PATH=str(root/'other'/'mailai.db'),IMAP_USER='other@example.test')
            Path(other_account['DB_PATH']).parent.mkdir()
            with use(other_account), patch.object(config, 'DATA_DIR',str(root/'other')):
                db.init_db();assert growth.snapshot()['claim_code'] != recipient
                fails(lambda:gifts.claim(code),'recipient');gifts.claim(campaign)
                assert len(growth.snapshot()['gifts']) == 1
            # Simulate a database failure after unlocking: the whole claim rolls back.
            _, rollback = issue(key,['mech_wings'],title='rollback',now=timestamp)
            with growth.connection() as c:
                c.execute("CREATE TRIGGER reject_gift BEFORE INSERT ON companion_gifts BEGIN SELECT RAISE(ABORT,'fixture'); END")
            try:
                gifts.claim(rollback)
            except sqlite3.DatabaseError:
                pass
            else:
                raise AssertionError('Injected DB failure was not exercised')
            assert not next(item for item in growth.snapshot()['items'] if item['id']=='mech_wings')['owned']
            assert not gifts.preview(rollback)['claimed']
            with growth.connection() as c:
                c.execute('DROP TRIGGER reject_gift')
            gifts.claim(rollback);assert gifts.preview(rollback)['claimed']
        # Private key output is encrypted, exclusive-created, outside the application and requires unlocking.
        issuer_home=root/'issuer'
        issuer_home.mkdir()
        data=dict(request_id='fixture-request-123',items=['wings'],title='retry-safe',recipient=recipient,days=7)
        with ThreadPoolExecutor(max_workers=8) as workers:
            issued=list(workers.map(lambda _:issue_saved(issuer_home,key,data),range(16)))
        assert all(entry == issued[0] for entry in issued), 'Concurrent signing retries must return the exact same voucher'
        assert history(issuer_home,key)[0]['code'] == issued[0][1]
        assert len(history(issuer_home,key)) == 1
        try:
            issue_saved(issuer_home,key,{**data,'items':['scarf']})
        except ValueError:
            pass
        else:
            raise AssertionError('Same request ID accepted different gifts')
        # Existing issuer metadata remains recoverable after the storage upgrade.
        old_payload,old_code=issue(key,['scarf'],title='legacy history')
        (issuer_home/'issued.jsonl').write_text(json.dumps(old_payload)+'\n',encoding='utf-8')
        assert history(issuer_home,key)[0]['code'] == old_code
        assert len(history(issuer_home,key)) == 2
        with patch('getpass.getpass', return_value='fixture-password-very-long'):
            created=initialize(issuer_home)
            assert 'ENCRYPTED PRIVATE KEY' in (issuer_home/'issuer.pem').read_text()
            assert public(load_key(issuer_home))[0] == created
            try:
                initialize(issuer_home)
            except ValueError:
                pass
            else:
                raise AssertionError('Issuer initialization overwrote a private key')
    assert gifts.TRUSTED_KEYS and all(len(value)==64 for value in gifts.TRUSTED_KEYS.values()), 'Production public key is required'
    for spec in ('MailAI.spec','MailAI.linux.spec'):
        assert 'companion_gift_issuer' not in Path(spec).read_text()
    print('Gifts: pinned signatures, malformed/forged codes, recipient, expiry, 16 concurrent retries, zero cost, stage-free outfits, mailbox sharing, backup identity/receipts, campaigns and transaction rollback passed')


if __name__ == '__main__':
    main()
