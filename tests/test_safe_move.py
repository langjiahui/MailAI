"""Offline regression: UID mapping and non-destructive IMAP fallback."""
import sys
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.imap_client import MailClient


def client(response=b'[COPYUID 42 7 91] Copied', supported=True, fallback=False,
           preexisting=None, message_id=True, uidnext=0):
    mail = MailClient()
    mail.client = Mock()
    mail.client.has_capability.return_value = supported
    mail.client.list_folders.return_value = [((), '/', 'Archive')]
    state = {'folder': '', 'copied': False}
    preexisting = list(preexisting or [])
    def select(folder, readonly=False):
        state['folder'] = folder
        return {b'UIDNEXT': uidnext} if folder == 'Archive' and uidnext else {}
    def search(criteria):
        if state['folder'] == 'Archive':
            if criteria[0] == 'HEADER':
                return preexisting + ([91] if fallback and state['copied'] else [])
            return [91] if fallback and state['copied'] else []
        return [7]
    def copy(*_args):
        state['copied'] = True
        return response
    def fetch(uids, fields):
        if list(uids) == [7]:
            header = b'Message-ID: <m1@example.com>\r\n' if message_id else b''
            return {7: {b'BODY[HEADER.FIELDS (MESSAGE-ID)]': header,
                        b'RFC822.SIZE': 100}}
        return {value: {b'RFC822.SIZE': 100} for value in uids}
    mail.client.select_folder.side_effect = select
    mail.client.search.side_effect = search
    mail.client.fetch.side_effect = fetch
    mail.client.copy.side_effect = copy
    return mail


def main():
    mail = client()
    assert mail.move(7, 'INBOX', 'Archive') == 91
    mail.client.expunge.assert_called_once_with([7])
    mail.client.add_flags.assert_called_once_with([7], ['\\Deleted'], silent=True)
    fallback = client(b'Copied', fallback=True)
    assert fallback.move(7, 'INBOX', 'Archive') == 91
    fallback.client.copy.assert_called_once_with([7], 'Archive')
    fallback.client.expunge.assert_called_once_with([7])
    recovered = client(b'Copied', preexisting=[91, 92, 93])
    assert recovered.move(7, 'INBOX', 'Archive') == 93
    recovered.client.copy.assert_not_called()
    assert recovered.client.add_flags.call_args_list[0].args == ([91, 92], ['\\Deleted'])
    assert recovered.client.expunge.call_args_list[0].args == ([91, 92],)
    assert recovered.client.expunge.call_args_list[1].args == ([7],)
    unidentified = client(b'Copied', fallback=True, message_id=False)
    assert unidentified.move(7, 'INBOX', 'Archive') == 91
    unidentified.client.copy.assert_called_once_with([7], 'Archive')
    for mail in (client(supported=False), client(b'Copied'), client(b'[COPYUID 42 8 91]')):
        try:
            mail.move(7, 'INBOX', 'Archive')
        except RuntimeError:
            pass
        else:
            raise AssertionError('Unsafe move must stop')
        mail.client.add_flags.assert_not_called()
        mail.client.expunge.assert_not_called()
    mail = client()
    mail.client.search.side_effect = None
    mail.client.search.return_value = []
    try:
        mail.move(7, 'INBOX', 'Archive')
    except RuntimeError:
        pass
    else:
        raise AssertionError('Missing source must fail')
    mail.client.copy.assert_not_called()
    print('Safe move UID mapping and deletion guards passed')


if __name__ == '__main__':
    main()
