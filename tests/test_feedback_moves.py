"""Feedback must agree with server moves; never use a real mailbox."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db, pipeline


def main():
    with tempfile.TemporaryDirectory() as root, patch.object(config, 'DB_PATH', os.path.join(root, 'mail.db')):
        db.init_db()
        email_id = db.upsert_email({'uid': 7, 'folder': config.INBOX_FOLDER,
                                   'status': 'inbox', 'verdict': 'clean', 'score': 40,
                                   'subject': 'Re: Project status', 'from_addr': 'sender@example.com'})
        similar_id = db.upsert_email({'uid': 8, 'folder': config.INBOX_FOLDER,
                                     'status': 'inbox', 'verdict': 'phishing', 'score': 50,
                                     'recommended_status': 'spam',
                                     'subject': 'Project status', 'from_addr': 'sender@example.com'})
        high_risk_id = db.upsert_email({'uid': 9, 'folder': config.INBOX_FOLDER,
                                       'status': 'inbox', 'verdict': 'phishing', 'score': 90,
                                       'recommended_status': 'quarantine',
                                       'subject': 'Fwd: Project status', 'from_addr': 'sender@example.com'})
        db.add_todos(email_id, [{'title': 'Source remains linked'}])
        mail = MagicMock()
        mail.__enter__.return_value = mail
        mail.move.return_value = 91
        with patch('app.pipeline.MailClient', return_value=mail):
            assert pipeline.record_feedback(email_id, 'fn')
            mail.move.assert_called_once_with(7, config.INBOX_FOLDER, config.QUARANTINE_FOLDER)
            row = db.get_email(email_id)
            assert (row['uid'], row['folder'], row['verdict']) == (91, config.QUARANTINE_FOLDER, 'phishing')
            mail.move.side_effect = RuntimeError('Disconnected')
            try:
                pipeline.record_feedback(email_id, 'fp')
            except RuntimeError:
                pass
            else:
                raise AssertionError('Failed move must not report success')
            assert db.get_email(email_id)['feedback'] == 'fn'
            assert db.get_email(email_id)['folder'] == config.QUARANTINE_FOLDER
            mail.move.side_effect = None
            mail.move.return_value = 105
            result = pipeline.record_feedback(email_id, 'fp')
            assert result and result['calibrated'] == 0
            row = db.get_email(email_id)
            assert (row['uid'], row['folder'], row['verdict'], row['status'], row['score']) == (105, config.INBOX_FOLDER, 'clean', 'inbox', 50)
            assert row['feedback'] == 'fp' and row['reviewed'] == 1
            similar = db.get_email(similar_id)
            assert (similar['score'], similar['verdict'], similar['recommended_status']) == (50, 'phishing', 'spam')
            assert similar['feedback'] is None and similar['reviewed'] == 0
            high_risk = db.get_email(high_risk_id)
            assert (high_risk['score'], high_risk['verdict'], high_risk['recommended_status']) == (90, 'phishing', 'quarantine')
            assert db.list_todos()[0]['email_id'] == email_id
            db.set_mail_state(email_id, folder='Archive')
            mail.reset_mock()
            assert pipeline.record_feedback(email_id, 'fp')
            mail.move.assert_not_called()
            assert db.get_email(email_id)['folder'] == 'Archive'
    print('Single-email feedback, move safety, source linkage and archive tests passed')


if __name__ == '__main__':
    main()
