"""Isolated mail fixtures and mocked CDN/WeChat; no live attachment transmission."""
import base64
import hashlib
import io
import json
import os
import sys
import tempfile
from contextlib import closing
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main():
    with tempfile.TemporaryDirectory(prefix='mailai-weixin-media-') as tmp:
        os.environ.update(MAILAI_HOME=tmp, IMAP_USER='desktop@example.test', IMAP_PASSWORD='fixture')
        from app import db, system_settings, credential_store, remote_control as remote, remote_media as media
        from app import weixin_remote as wx, weixin_media as upload, parser
        from app.account_context import use
        from app.remote_commands import canonicalize
        from PIL import Image
        image = io.BytesIO(); Image.new('RGB', (8, 8), 'red').save(image, format='PNG')
        raw = EmailMessage()
        raw['From'] = 'sender@example.test'; raw['To'] = 'a@example.test'; raw['Subject'] = '附件测试'
        raw.set_content('请查看附件')
        raw.add_attachment(b'fixture file', maintype='application', subtype='pdf', filename='报告.pdf')
        raw.add_attachment(image.getvalue(), maintype='image', subtype='png', filename='图片.png')
        registry = {'accounts': {}}
        scopes = {}
        for account_id in ('a', 'b'):
            raw_dir = Path(tmp) / account_id / 'raw'; raw_dir.mkdir(parents=True)
            account = dict(user=account_id+'@example.test', host='imap.example.test', db_path=tmp+'/'+account_id+'.db', raw_dir=str(raw_dir))
            registry['accounts'][account_id] = account
            scope = dict(ACCOUNT_ID=account_id, DB_PATH=account['db_path'], RAW_DIR=str(raw_dir), IMAP_USER=account['user'])
            scopes[account_id] = scope
            path = raw_dir/'fixture.eml'; path.write_bytes(raw.as_bytes())
            with use(scope):
                db.init_db()
                db.upsert_email(dict(uid=1, subject=account_id+' 附件测试', body_text='正文', status='inbox',
                                     raw_path=str(path), attachments=parser.attachment_metadata(raw.as_bytes()), date='2026-09-28T12:00:00'))
        system_settings._save_registry(registry)
        saved = dict(enabled=True, ai_enabled=False, bot_id='bot', user_id='owner', base_url=wx.BASE_URL, account_ids=['a', 'b'])
        with closing(remote.connection()) as c, c:
            c.execute('INSERT INTO settings VALUES(2,?)', (json.dumps(saved),))
        count = 0
        def say(text):
            nonlocal count
            count += 1
            return remote.handle_message(channel='weixin', staff_id='owner', conversation_id='owner', message_id=str(count), text=text)
        class Immediate:
            def __init__(self, target, **kwargs): self.target = target
            def start(self): self.target()
        sent, feedback = [], []
        with patch.object(credential_store, 'load', return_value='fixture'), patch.object(system_settings, 'account_password', return_value='fixture'), \
                patch.object(media.threading, 'Thread', Immediate):
            assert 'a 附件测试' in say('最新邮件')
            assert '报告.pdf' in say('查看第一封的附件')
            for phrase in ('把第二个附件发给我', '发送第２个附件', '下载第二个附件'):
                assert canonicalize(phrase) == '发送附件第 2 个'
            for phrase in ('预览第一个附件', '发送附件第 1 个', '附件列表第 1 封'):
                assert canonicalize(canonicalize(phrase)) == canonicalize(phrase)
            assert '图片预览支持' in say('预览第一个附件')
            assert '准备附件' in say('把第一个附件发给我')
            job_id = str(count)
            media.deliver(saved, 'owner', job_id, lambda att, mode, allowed: sent.append((att, mode, allowed())), feedback.append)
            assert sent[0][0]['payload'] == b'fixture file' and sent[0][1] == 'file' and sent[0][2]
            media.deliver(saved, 'owner', job_id, lambda *args: sent.append(args), feedback.append)
            assert len(sent) == 1  # Receipt replay never reuploads.
            assert '微信已接受附件' in feedback[-1]
            assert '准备图片预览' in say('预览第二个附件')
            media.deliver(saved, 'owner', str(count), lambda att, mode, allowed: sent.append((att, mode, allowed())), feedback.append)
            assert sent[-1][1] == 'image' and sent[-1][0]['payload'].startswith(b'\x89PNG')
            say('切换邮箱 b@example.test')
            assert '获取当前邮件' in say('发送第一个附件')
            say('最新邮件'); say('查看第一封的附件')
            with use(scopes['b']):
                db.update_attachment_metadata(1, [dict(name='变化.pdf', content_type='application/pdf', size=12)])
            assert '记录已变化' in say('发送第一个附件')
            say('切换邮箱 a@example.test'); say('最新邮件'); say('查看第一封的附件')
            say('发送第一个附件'); job_id = str(count)
            with closing(remote.connection()) as c, c:
                c.execute('UPDATE settings SET value=? WHERE id=2', (json.dumps({**saved, 'account_ids': ['b']}),))
            media.deliver(saved, 'owner', job_id, lambda *args: sent.append(args), feedback.append)
            assert len(sent) == 2  # Revoked permission cancels before extracting/uploading.
            with use(scopes['a']):
                row = db.get_email(1); descriptor = dict(email_id=1, index=0, fingerprint=media._fingerprint(media._attachments(row)[0]), mode='file')
                with patch.object(media.Path, 'is_relative_to', return_value=False):
                    try: media.load_attachment(descriptor)
                    except media.MediaValidationError: pass
                    else: raise AssertionError('outside mailbox accepted')
                with patch.object(media, 'MAX_BYTES', 3):
                    try: media.load_attachment(descriptor)
                    except media.MediaValidationError: pass
                    else: raise AssertionError('oversize accepted')
        # Exercise the actual encrypt/upload/message builders with an in-memory CDN response.
        response = Mock(status_code=200, headers={'x-encrypted-param': 'download-param'})
        response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        for mode in ('file', 'image'):
            requests_seen = []
            def api(base, path, **kwargs):
                requests_seen.append((path, kwargs))
                return {'upload_param': 'encrypted+param'} if path.endswith('getuploadurl') else {}
            with patch.object(wx, '_request', side_effect=api), patch('requests.post', return_value=response) as post:
                upload.send(saved, 'secret', 'owner', 'context', 'stable-id', dict(payload=b'fixture file', name='报告.pdf'), mode, lambda: True)
                metadata = requests_seen[0][1]['body']
                assert metadata['media_type'] == (1 if mode == 'image' else 3)
                assert 'Authorization' not in post.call_args.kwargs['headers']
                assert not post.call_args.kwargs['allow_redirects']
                from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
                from cryptography.hazmat.primitives.padding import PKCS7
                decryptor = Cipher(algorithms.AES(bytes.fromhex(metadata['aeskey'])), modes.ECB()).decryptor()
                plaintext = decryptor.update(post.call_args.kwargs['data']) + decryptor.finalize()
                unpad = PKCS7(128).unpadder()
                assert unpad.update(plaintext) + unpad.finalize() == b'fixture file'
                item = requests_seen[1][1]['body']['msg']['item_list'][0]
                assert item['type'] == (2 if mode == 'image' else 4)
                assert requests_seen[1][1]['body']['msg']['client_id'] == 'stable-id-media'
        for url in ('http://novac2c.cdn.weixin.qq.com/c2c/upload', 'https://evil.test/c2c/upload', 'https://novac2c.cdn.weixin.qq.com:8443/c2c/upload'):
            try: upload.upload_url({'upload_full_url': url}, 'key')
            except RuntimeError: pass
            else: raise AssertionError('untrusted CDN accepted')
        with patch.object(wx, '_request', return_value={'upload_param': 'param'}) as api, patch('requests.post', return_value=response):
            allowed = iter([True, True, False])
            try: upload.send(saved, 'secret', 'owner', 'context', 'id', dict(payload=b'data', name='file'), 'file', lambda: next(allowed))
            except RuntimeError: pass
            else: raise AssertionError('revoked send accepted')
            assert api.call_count == 1
        # Speech recognition never becomes a reply, confirmation or file upload command.
        message = dict(message_type=1, from_user_id='owner', context_token='ctx', message_id='voice')
        with patch.object(remote, 'handle_message', return_value='结果') as engine, patch.object(remote, 'delivered'), \
                patch.object(remote, 'deliver_sync_feedback'), patch.object(media, 'deliver'), patch.object(wx, '_request', return_value={}):
            for transcript, command in (('查看第一封', '查看第 1 封'), ('看看今天待办', '今天待办'), ('确认发送 ABCD1234', '帮助'), ('回复这封', '帮助'), ('发送第一个附件', '帮助')):
                wx.process_message(saved, 'secret', {**message, 'item_list': [dict(type=3, voice_item=dict(text=transcript))]})
                assert engine.call_args.kwargs['text'] == command
    print('PASS isolated attachment flow, image decoding, ordinals, permissions, replay, size/path limits, real AES/CDN construction and voice query boundaries')


if __name__ == '__main__':
    main()
