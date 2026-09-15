"""A failed message must not be skipped by advancing sync cursors."""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import pipeline, config


def main():
    mail = MagicMock()
    mail.__enter__.return_value = mail
    mail.fetch_new.return_value = [(10, b'a'), (11, b'b'), (12, b'c')]
    with patch('app.pipeline.MailClient', return_value=mail), \
         patch('app.pipeline._set_fetch_state'), patch('app.pipeline._reset_action_guard'), \
         patch('app.pipeline.db.already_processed', return_value=False), \
         patch('app.pipeline.db.set_last_uid') as cursor, \
         patch('app.pipeline.process_message', side_effect=[{'status': 'inbox'}, RuntimeError('decode'), {'status': 'inbox'}]):
        result = pipeline.poll_once()
        assert result['errors'] == 1
        cursor.assert_called_once_with(config.INBOX_FOLDER, 10)
    mail.fetch_older.return_value = [(7, b'a'), (8, b'b'), (9, b'c')]
    with patch('app.pipeline.MailClient', return_value=mail), \
         patch('app.pipeline._set_fetch_state'), patch('app.pipeline._reset_action_guard'), \
         patch('app.pipeline.db.already_processed', return_value=False), \
         patch('app.pipeline.db.get_first_uid', return_value=10), \
         patch('app.pipeline.db.count_history_imported', return_value=0), \
         patch('app.pipeline.process_message', side_effect=[{'status': 'inbox'}, RuntimeError('decode')]) as process:
        result = pipeline.fetch_more()
        assert result['errors'] == 1
        assert [call.args[1] for call in process.call_args_list] == [9, 8]
    mail.client.search.return_value = [1, 2]
    selected = []
    mail.select_folder.side_effect = lambda folder, **kw: selected.append(folder) or {}
    def fetch(uids, fields):
        assert selected[-1] == config.INBOX_FOLDER
        return {uid: {b'BODY[]': b'mail'} for uid in uids}
    mail.client.fetch.side_effect = fetch
    def moved(*args):
        selected.append('Quarantine')
        return {'status': 'quarantine'}
    with patch('app.pipeline.MailClient', return_value=mail), \
         patch('app.pipeline._set_fetch_state'), patch('app.pipeline._reset_action_guard'), \
         patch('app.pipeline.db.already_processed', return_value=False), \
         patch('app.pipeline.db.count_history_imported', return_value=0), \
         patch('app.pipeline.db.reconcile_folder') as reconcile, \
         patch('app.pipeline.process_message', side_effect=moved):
        assert pipeline.fetch_all(batch=1)['fetched'] == 2
        reconcile.assert_called_once_with(config.INBOX_FOLDER, [1, 2])
    print('Incremental retry, descending history retry and batch folder reselection passed')


if __name__ == '__main__':
    main()
