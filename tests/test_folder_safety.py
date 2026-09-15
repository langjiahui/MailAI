"""Folder navigation and deletion guards without live IMAP writes."""
import sys
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.imap_client import MailClient


def main():
    mail = MailClient()
    mail.client = Mock()
    mail.client.list_folders.return_value = [
        ((b'\\Noselect',), '/', 'Projects'), ((), '/', 'Projects/2026')]
    mail.client.select_folder.return_value = {b'EXISTS': 2}
    mail.client.search.return_value = [1]
    rows = mail.list_mailboxes()
    assert rows[0]['selectable'] is False and rows[1]['messages'] == 2
    mail.client.select_folder.assert_called_once_with('Projects/2026', readonly=True)
    for flags, name, count in [((b'\\Sent',), 'CustomSent', 0), ((), 'Work', 1), ((), 'Sent', 0)]:
        mail.client.list_folders.return_value = [(flags, '/', name)]
        mail.client.select_folder.return_value = {b'EXISTS': count}
        try:
            mail.delete_mailbox(name)
        except ValueError:
            pass
        else:
            raise AssertionError('Unsafe folder deletion allowed')
        mail.client.delete_folder.assert_not_called()
    mail.client.list_folders.return_value = [((), '/', 'Work'), ((), '/', 'Work/Child')]
    try:
        mail.delete_mailbox('Work')
    except ValueError:
        pass
    else:
        raise AssertionError('Parent deletion allowed')
    mail.client.list_folders.return_value = [((), '/', 'Empty')]
    mail.client.search.return_value = []
    mail.client.select_folder.return_value = {b'EXISTS': 0}
    mail.delete_mailbox('Empty')
    mail.client.delete_folder.assert_called_once_with('Empty')
    mail.client.search.return_value = list(range(1, 1206))
    mail.client.fetch.side_effect = lambda uids, fields: {
        uid: {b'BODY[]': b'Subject: test\r\n\r\nbody', b'FLAGS': [b'\\Seen']}
        for uid in uids}
    rows = list(mail.fetch_folder('Work'))
    assert len(rows) == 1205 and len({row[0] for row in rows}) == 1205
    assert rows[0][0] == 1205 and rows[-1][0] == 1
    assert all(len(call.args[0]) <= 50 for call in mail.client.fetch.call_args_list)
    assert all(call.args[1] == ['BODY.PEEK[]', 'FLAGS'] for call in mail.client.fetch.call_args_list)
    assert len(list(mail.fetch_folder('Work', 12))) == 12
    mail.client.fetch.reset_mock()
    rows = list(mail.fetch_folder('Work', 0, {1205, 1204}))
    assert rows[0] == (1205, None, ['\\Seen'])
    assert rows[1] == (1204, None, ['\\Seen'])
    assert any(call.args[1] == ['FLAGS'] for call in mail.client.fetch.call_args_list)
    assert sum(len(call.args[0]) for call in mail.client.fetch.call_args_list
               if call.args[1] == ['BODY.PEEK[]', 'FLAGS']) == 1203
    print('Noselect listing, special-use/nonempty/parent protections and empty deletion passed')


if __name__ == '__main__':
    main()
