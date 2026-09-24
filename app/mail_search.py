"""SQLite substring index with local full-pinyin and initials aliases."""
FIELDS = ('subject', 'from_addr', 'from_name', 'summary', 'snippet', 'body_text', 'category')
PINYIN_FIELDS = ('subject', 'from_name')


def register(connection):
    from .pinyin_search import aliases, body_aliases
    try:
        connection.create_function('mailai_pinyin', 1, aliases, deterministic=True)
        connection.create_function('mailai_body_pinyin', 1, body_aliases, deterministic=True)
    except TypeError:  # Python/SQLite builds without the deterministic flag.
        connection.create_function('mailai_pinyin', 1, aliases)
        connection.create_function('mailai_body_pinyin', 1, body_aliases)


def expression(prefix=''):
    original = "||' '||".join(f"coalesce({prefix}{field},'')" for field in FIELDS)
    names = "||' '||".join(f"coalesce({prefix}{field},'')" for field in PINYIN_FIELDS)
    return f"lower({original}||' '||mailai_pinyin({names})||' '||mailai_body_pinyin({prefix}body_text))"


def initialize(connection):
    register(connection)
    search = connection.execute("SELECT 1 FROM sqlite_master WHERE name='email_search'").fetchone()
    view = connection.execute("SELECT sql FROM sqlite_master WHERE type='view' AND name='email_search_content'").fetchone()
    if search and view and 'mailai_body_pinyin' in (view[0] or ''):
        return
    # Rebuild the derived index once when upgrading from the literal-only schema.
    connection.execute('DROP TRIGGER IF EXISTS email_search_insert')
    connection.execute('DROP TRIGGER IF EXISTS email_search_delete')
    connection.execute('DROP TRIGGER IF EXISTS email_search_update')
    connection.execute('DROP TABLE IF EXISTS email_search')
    connection.execute('DROP VIEW IF EXISTS email_search_content')
    # Older system SQLite builds may lack FTS5 or the trigram tokenizer.
    connection.execute('SAVEPOINT search_setup')
    try:
        connection.execute(f'CREATE VIEW email_search_content AS SELECT id,{expression()} AS text FROM emails')
        connection.execute("CREATE VIRTUAL TABLE email_search USING fts5(text, content='email_search_content', content_rowid='id', tokenize='trigram')")
        connection.execute(f"CREATE TRIGGER email_search_insert AFTER INSERT ON emails BEGIN INSERT INTO email_search(rowid,text) VALUES(new.id,{expression('new.')}); END")
        connection.execute(f"CREATE TRIGGER email_search_delete AFTER DELETE ON emails BEGIN INSERT INTO email_search(email_search,rowid,text) VALUES('delete',old.id,{expression('old.')}); END")
        connection.execute(f"CREATE TRIGGER email_search_update AFTER UPDATE OF {','.join(FIELDS)} ON emails BEGIN INSERT INTO email_search(email_search,rowid,text) VALUES('delete',old.id,{expression('old.')}); INSERT INTO email_search(rowid,text) VALUES(new.id,{expression('new.')}); END")
        connection.execute("INSERT INTO email_search(email_search) VALUES('rebuild')")
    except Exception as exc:
        connection.execute('ROLLBACK TO search_setup')
        if 'no such module' not in str(exc) and 'no such tokenizer' not in str(exc):
            raise
    finally:
        connection.execute('RELEASE search_setup')


def indexed(connection, terms):
    # A trigram requires three consecutive literal characters. For shorter
    # Chinese words, wildcard patterns and mixed OR queries use the old path.
    return all(len(term) >= 3 and '%' not in term and '_' not in term for term in terms) and bool(
        connection.execute("SELECT 1 FROM sqlite_master WHERE name='email_search'").fetchone())


def predicate(connection, terms):
    register(connection)
    cleaned = [str(term).strip().lower()[:80] for term in terms if str(term).strip()][:12]
    if not cleaned:
        return '1=1', []
    args = [f'%{term}%' for term in cleaned]
    if indexed(connection, cleaned):
        candidates = ' UNION '.join('SELECT rowid FROM email_search WHERE text LIKE ?' for _ in cleaned)
        return f'id IN ({candidates})', args
    return '(' + ' OR '.join(expression() + ' LIKE ?' for _ in cleaned) + ')', args


def match_preview(message, terms):
    """Return a bounded plain-text excerpt; never return the full body to lists."""
    import re
    from .pinyin_search import aliases, body_match_span
    needles = [str(term).strip().lower()[:80] for term in terms if str(term).strip()][:12]
    for field in FIELDS:
        text = re.sub(r"\s+", " ", str(message.get(field) or "")).strip()
        positions = [text.lower().find(term) for term in needles if term in text.lower()]
        if positions:
            start = max(0, min(positions) - 28)
            end = min(len(text), start + 150)
            return {"field": field, "text": ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")}
    for field in PINYIN_FIELDS:
        text = str(message.get(field) or "")
        if any(term in aliases(text).lower() for term in needles):
            return {"field": field, "text": text[:150], "pinyin": True}
    body = str(message.get('body_text') or '')
    span = body_match_span(body, needles)
    if span:
        position = span[0]
        start = max(0, position - 28)
        end = min(len(body), position + 120)
        return {"field": "body_text", "text": ("…" if start else "") + re.sub(r"\s+", " ", body[start:end]) + ("…" if end < len(body) else ""), "pinyin": True, "highlight": body[span[0]:span[1]]}
    return None
