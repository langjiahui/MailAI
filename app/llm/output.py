"""Separate gateway reasoning markup from user-visible model output."""
import re

_TAG = re.compile(r'<\s*(/?)\s*(think|analysis|reasoning)\s*>', re.I)
_PREFACES = ("here's a thinking process:", 'here is a thinking process:',
             'thinking process:', '思考过程：', '思考过程:')


def content_text(content) -> str:
    """Typed reasoning blocks are metadata, including in multipart gateways."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ''.join(str(part.get('text') or part.get('content') or '')
                       for part in content if isinstance(part, dict)
                       and part.get('type', 'text') in ('text', 'output_text'))
    return ''


class VisibleTextStream:
    """Hold partial tags and discard reasoning across arbitrary SSE boundaries."""
    def __init__(self):
        self.pending = ''
        self.hidden = []
        self.initial = True

    def feed(self, text: str) -> str:
        self.pending += text
        if self.initial:
            start = self.pending.lstrip().casefold()
            if not start or any(prefix.startswith(start) for prefix in _PREFACES):
                return ''
            self.initial = False
            if any(start.startswith(prefix) for prefix in _PREFACES):
                self.hidden.append('think')
        output = []
        cursor = 0
        for match in _TAG.finditer(self.pending):
            if not self.hidden:
                output.append(self.pending[cursor:match.start()])
            closing, name = match.group(1), match.group(2).lower()
            if closing:
                if name in self.hidden:
                    index = len(self.hidden) - 1 - self.hidden[::-1].index(name)
                    self.hidden = self.hidden[:index]
            else:
                self.hidden.append(name)
            cursor = match.end()
        tail = self.pending[cursor:]
        # A tag may span tokens or UTF-8/network chunks. Bound held text even
        # for malformed markup, without ever releasing a hidden reasoning block.
        partial = tail.rfind('<')
        if partial >= 0 and '>' not in tail[partial:] and len(tail) - partial < 64:
            self.pending = tail[partial:]
            tail = tail[:partial]
        else:
            self.pending = ''
        if not self.hidden:
            output.append(tail)
        return ''.join(output)

    def finish(self) -> str:
        tail, self.pending = self.pending, ''
        if self.hidden or any(tail.lstrip().casefold().startswith(p) for p in _PREFACES):
            return ''
        # Never show an unfinished reserved reasoning tag.
        if re.match(r'^<\s*/?\s*(?:thi|analys|reason)', tail, re.I):
            return ''
        return tail


def visible_text(content) -> str:
    text = content_text(content)
    # Some Qwen templates omit the opening <think> tag. A complete response
    # lets us safely discard the prefix before its closing delimiter as well.
    matches = list(_TAG.finditer(text))
    if matches and matches[0].group(1):
        text = text[matches[0].end():]
    stream = VisibleTextStream()
    return stream.feed(text) + stream.finish()
