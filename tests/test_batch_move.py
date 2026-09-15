"""Offline regression: grouped trash moves use bounded IMAP round trips."""
import sys
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.imap_client import MailClient


def make_mail(response=b"[COPYUID 77 41:66 91:116] copied"):
    mail = MailClient()
    mail.client = Mock()
    mail.client.has_capability.return_value = True
    mail.client.list_folders.return_value = [((), "/", "Trash")]
    state = {"folder": ""}

    def select(folder, readonly=False):
        state["folder"] = folder
        return {b"UIDNEXT": 91} if folder == "Trash" else {}

    def search(criteria):
        if state["folder"] != "INBOX":
            return []
        if criteria[:1] == ["UID"]:
            values = []
            for value in criteria[1].split(","):
                values.append(int(value))
            return values
        return []

    mail.client.select_folder.side_effect = select
    mail.client.search.side_effect = search
    mail.client.copy.return_value = response
    return mail


def main():
    assert MailClient._uid_sequence("41:43,50,55:54") == [41, 42, 43, 50, 55, 54]
    assert MailClient._copyuid_mapping("[COPYUID 7 41:43 91:93]", [41, 42, 43]) == {
        41: 91, 42: 92, 43: 93,
    }
    assert not MailClient._copyuid_mapping("[COPYUID 7 41:43 91:92]", [41, 42, 43])

    planned = list(range(41, 67))
    mail = make_mail()
    mapping = mail.move_many(planned, "INBOX", "Trash")
    assert mapping == dict(zip(planned, range(91, 117)))
    mail.client.copy.assert_called_once_with(planned, "Trash")
    mail.client.add_flags.assert_called_once_with(planned, ["\\Deleted"], silent=True)
    mail.client.expunge.assert_called_once_with(planned)
    # Presence is checked before and after copying, regardless of batch size.
    assert mail.client.search.call_count == 2

    fallback = make_mail(b"copied without mapping")
    fallback.move = Mock(side_effect=[191, RuntimeError("cannot prove target"), 193])
    result = fallback.move_many([41, 42, 43], "INBOX", "Trash")
    assert result == {41: 191, 43: 193}
    assert fallback.move.call_count == 3
    # The batch path must never guess/delete a target UIDNEXT range.
    fallback.client.add_flags.assert_not_called()
    fallback.client.expunge.assert_not_called()
    print("Batch move uses one copy/delete sequence and preserves safe partial fallback")


if __name__ == "__main__":
    main()
