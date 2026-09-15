"""RFC address parsing for reply and reply-all; Bcc is never copied."""
from email.parser import BytesHeaderParser
from email.utils import getaddresses


def recipients(email, current_user, reply_all=False):
    headers = {}
    if email.get("raw_path"):
        try:
            with open(email["raw_path"], "rb") as source:
                headers = BytesHeaderParser().parse(source)
        except OSError as exc:
            if reply_all:
                raise ValueError("原始邮件暂不可用，无法确认完整抄送列表，请同步后重试") from exc
    seen = {current_user.strip().casefold()}

    def unique(values):
        result = []
        for _, address in getaddresses(values):
            key = address.strip().casefold()
            if "@" in key and key not in seen:
                seen.add(key)
                result.append(address.strip())
        return result

    reply = headers.get("Reply-To") or email.get("reply_to") or headers.get("From") or email.get("from_addr", "")
    to = unique([reply])
    original_to = headers.get("To") or email.get("to_addr", "")
    if reply_all or not to:  # Replying to one's own sent message targets original recipients.
        to += unique([original_to])
    cc = unique([headers.get("Cc") or email.get("cc_addr", "")]) if reply_all else []
    return {"to_addr": ", ".join(to), "cc_addr": ", ".join(cc)}
