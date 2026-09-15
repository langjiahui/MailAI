"""Confirming a risk result recovers safely from a stale server UID."""
import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.imap_client import MailClient


def main():
    mail = MailClient()
    mail.client = MagicMock()
    mail.client.search.return_value = [41, 43]
    assert mail.find_message_uid("INBOX", "<stable@example.test>") == 43
    mail.client.select_folder.assert_called_once_with("INBOX", readonly=True)
    mail.client.search.assert_called_once_with(["HEADER", "Message-ID", "<stable@example.test>"])
    mail.client.reset_mock()
    assert mail.find_message_uid("INBOX", "") is None
    mail.client.select_folder.assert_not_called()
    print("Stale UID lookup uses an exact-folder stable Message-ID search")


if __name__ == "__main__":
    main()
