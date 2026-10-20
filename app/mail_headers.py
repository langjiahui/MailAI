"""Lossless-first decoding for legacy MIME headers and display names."""
import codecs
import re
from email.errors import HeaderParseError
from email.header import decode_header
from email.utils import getaddresses


_ENCODED_WORD = re.compile(r"=\?[^? \t\r\n]+\?[bBqQ]\?[^?\r\n]*\?=")


def _decode_bytes(value: bytes, charset: str | None) -> str:
    declared = (charset or "").strip()
    try:
        canonical = codecs.lookup(declared).name
    except (LookupError, ValueError):
        canonical = ""
    # Some older clients label GBK/GB18030 bytes as GB2312. Try the full
    # Chinese encoding before a permissive single-byte fallback loses data.
    candidates = [declared]
    if canonical in {"gb2312", "gbk", "gb18030"}:
        candidates.append("gb18030")
    candidates.extend(("utf-8", "gb18030", "big5", "windows-1252"))
    for encoding in dict.fromkeys(candidates):
        if not encoding:
            continue
        try:
            return value.decode(encoding, "strict")
        except (LookupError, ValueError):
            continue
    return value.decode("utf-8", "replace")


def decode_header_text(value) -> str:
    """Decode original header bytes before policy.default inserts replacement chars."""
    if not value:
        return ""
    raw = re.sub(r"\r?\n[ \t]+", " ", str(value))

    def plain(text):
        # BytesParser.raw_items() preserves unencoded 8-bit headers with
        # surrogateescape; recover those bytes instead of serializing them.
        if any("\udc80" <= char <= "\udcff" for char in text):
            return _decode_bytes(text.encode("utf-8", "surrogateescape"), None)
        return text

    # Decode only encoded words. Passing mixed Unicode/plain text through
    # decode_header turns its Unicode characters into literal \\uXXXX escapes.
    parts, end = [], 0
    for match in _ENCODED_WORD.finditer(raw):
        gap = raw[end:match.start()]
        if not (end and gap.isspace()):  # RFC 2047 ignores LWS between encoded words.
            parts.append(plain(gap))
        encoded = match.group()
        try:
            fragments = decode_header(encoded)
            decoded = ''.join(_decode_bytes(text, charset) if isinstance(text, bytes) else text
                              for text, charset in fragments)
            parts.append(decoded or encoded)
        except HeaderParseError:
            parts.append(encoded)
        end = match.end()
    parts.append(plain(raw[end:]))
    return "".join(parts)


def damaged_display_name(value: str) -> bool:
    """Only flag definite data loss; unfamiliar scripts are valid names."""
    return any(char == "\ufffd" or "\ud800" <= char <= "\udfff" for char in str(value or ""))


def address_header_pairs(message, field: str) -> list[tuple[str, str]]:
    """Split transport syntax before decoding punctuation inside encoded names."""
    values = [value for key, value in message.raw_items() if key.casefold() == field.casefold()]
    pairs = getaddresses(values)
    return [(re.sub(r"[\r\n]+[ \t]*", " ", decode_header_text(name)).strip(), address)
            for name, address in pairs]
