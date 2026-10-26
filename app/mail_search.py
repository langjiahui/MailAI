"""SQLite substring index with local full-pinyin and initials aliases."""
FIELDS = ('subject', 'from_addr', 'from_name', 'summary', 'snippet', 'body_text', 'category', 'attachments')
PINYIN_FIELDS = ('subject', 'from_name')


def sender_alias_addresses(connection, terms):
    """Match the names users see, including names learned from other headers.

    Resolve once per query using this account's connection. Do not rewrite mail
    headers or recompute body pinyin while looking up a sender's local aliases.
    """
    import re
    import unicodedata
    from .db.contacts import _recipient_header_display_names, contact_display_names
    from .mail_headers import damaged_display_name, decode_header_text
    from .pinyin_search import aliases

    def clean(value):
        value = unicodedata.normalize('NFKC', decode_header_text(value or '')).casefold()
        value = re.sub(r'[\u200b-\u200d\ufeff]', '', value)
        value = re.sub(r'\s+', ' ', value).strip()
        return re.sub(r'(?<=[\u3400-\u9fff]) (?=[\u3400-\u9fff])', '', value)

    needles = [clean(term) for term in terms]
    for index, needle in enumerate(needles):
        # Pasting a displayed "Name <address>" identifies the exact address;
        # that string is not stored as one field in the email table.
        address = re.fullmatch(r'.*?[<(]([^\s<>(),;]+@[^\s<>(),;]+)[>)]', needle)
        if address:
            needles[index] = address[1]
    matches = [set() for _ in needles]
    if not any(needles):
        return matches
    saved = list(connection.execute('SELECT email,name,hidden FROM contacts'))
    hidden = {str(row['email'] or '').strip().casefold() for row in saved if row['hidden']}
    pairs = [(address, name) for address, name in _recipient_header_display_names(connection).items()
             if address not in hidden]
    pairs.extend((row['email'], row['name']) for row in saved if not row['hidden'])
    senders = list(connection.execute(
        "SELECT DISTINCT from_addr,from_name FROM emails WHERE trim(coalesce(from_addr,''))<>''"))
    pairs.extend((row['from_addr'], row['from_name']) for row in senders)
    damaged = {row['from_addr'] for row in senders if damaged_display_name(row['from_name'])}
    if damaged:
        # Reuse the same bounded header recovery used by mailbox display.
        recovered = contact_display_names(damaged, connection=connection)
        pairs.extend((address, value['name']) for address, value in recovered.items())
    latin = any(needle and needle.isascii() for needle in needles)
    for address, name in pairs:
        address = str(address or '').strip().casefold()
        if not address:
            continue
        name = clean(name)
        phonetic = aliases(name) if latin else ''
        for index, needle in enumerate(needles):
            if needle and (needle in address or needle in name or
                           needle in phonetic or needle.replace(' ', '') in phonetic.replace(' ', '')):
                matches[index].add(address)
    return matches


def register(connection):
    from .pinyin_search import aliases, body_aliases
    try:
        connection.create_function('mailai_pinyin', 1, aliases, deterministic=True)
        connection.create_function('mailai_body_pinyin', 1, body_aliases, deterministic=True)
    except TypeError:  # Python/SQLite builds without the deterministic flag.
        connection.create_function('mailai_pinyin', 1, aliases)
        connection.create_function('mailai_body_pinyin', 1, body_aliases)


def expression(prefix='', *, include_pinyin=True):
    original = "||' '||".join(f"coalesce({prefix}{field},'')" for field in FIELDS)
    if not include_pinyin:
        return f"lower({original})"
    names = "||' '||".join(f"coalesce({prefix}{field},'')" for field in PINYIN_FIELDS)
    return f"lower({original}||' '||mailai_pinyin({names})||' '||mailai_body_pinyin({prefix}body_text))"


def initialize(connection):
    register(connection)
    search = connection.execute("SELECT sql FROM sqlite_master WHERE name='email_search'").fetchone()
    view = connection.execute("SELECT sql FROM sqlite_master WHERE type='view' AND name='email_search_source'").fetchone()
    if (search and "content=" not in (search[0] or '').replace(' ', '').lower()
            and view and 'mailai_body_pinyin' in (view[0] or '') and 'attachments' in (view[0] or '')):
        return
    # Store searchable text, including pinyin, in FTS itself. An external-content
    # view recomputed all body aliases whenever LIKE verified an index hit (and
    # for every row for two-character Chinese terms).
    # Keep the view only as the source of the one-time rebuild.
    connection.execute('DROP TRIGGER IF EXISTS email_search_insert')
    connection.execute('DROP TRIGGER IF EXISTS email_search_delete')
    connection.execute('DROP TRIGGER IF EXISTS email_search_update')
    connection.execute('DROP TABLE IF EXISTS email_search')
    connection.execute('DROP VIEW IF EXISTS email_search_content')
    connection.execute('DROP VIEW IF EXISTS email_search_source')
    # Older system SQLite builds may lack FTS5 or the trigram tokenizer.
    connection.execute('SAVEPOINT search_setup')
    try:
        connection.execute(f'CREATE VIEW email_search_source AS SELECT id,{expression()} AS text FROM emails')
        connection.execute("CREATE VIRTUAL TABLE email_search USING fts5(text, tokenize='trigram')")
        connection.execute(f"CREATE TRIGGER email_search_insert AFTER INSERT ON emails BEGIN INSERT INTO email_search(rowid,text) VALUES(new.id,{expression('new.')}); END")
        connection.execute("CREATE TRIGGER email_search_delete AFTER DELETE ON emails BEGIN DELETE FROM email_search WHERE rowid=old.id; END")
        connection.execute(f"CREATE TRIGGER email_search_update AFTER UPDATE OF {','.join(FIELDS)} ON emails BEGIN UPDATE email_search SET text={expression('new.')} WHERE rowid=new.id; END")
        connection.execute("INSERT INTO email_search(rowid,text) SELECT id,text FROM email_search_source")
    except Exception as exc:
        connection.execute('ROLLBACK TO search_setup')
        if 'no such module' not in str(exc) and 'no such tokenizer' not in str(exc):
            raise
    finally:
        connection.execute('RELEASE search_setup')


def indexed(connection, terms):
    search = connection.execute("SELECT sql FROM sqlite_master WHERE name='email_search'").fetchone()
    if not search:
        return False
    # Stored content also makes a scan for short terms and LIKE wildcards cheap.
    # Unmigrated external indexes still require three literal characters.
    return "content=" not in (search[0] or '').replace(' ', '').lower() or all(
        len(term) >= 3 and '%' not in term and '_' not in term for term in terms)


def predicate(connection, terms):
    register(connection)
    cleaned = [str(term).strip().lower()[:80] for term in terms if str(term).strip()][:12]
    if not cleaned:
        return '1=1', []
    args = [f'%{term}%' for term in cleaned]
    import json
    # Keep FTS candidates indexed; alias hits add email IDs through a separate
    # subquery instead of turning every full-text search into a row callback.
    alias_addresses = set().union(*sender_alias_addresses(connection, cleaned))
    extra = ''
    if alias_addresses:
        extra = " OR id IN (SELECT id FROM emails WHERE lower(trim(from_addr)) IN (SELECT value FROM json_each(?)))"
    if indexed(connection, cleaned):
        candidates = ' UNION '.join('SELECT rowid FROM email_search WHERE text LIKE ?' for _ in cleaned)
        return f'(id IN ({candidates}){extra})', args + ([json.dumps(sorted(alias_addresses))] if extra else [])
    # Unmigrated accounts and SQLite without trigram support retain a literal
    # scan. A term containing Chinese cannot match ASCII-only pinyin aliases,
    # so do not transliterate every body on this fallback path either.
    import re
    return '((' + ' OR '.join(
        expression(include_pinyin=not re.search(r'[\u3400-\u9fff]', term)) + ' LIKE ?'
        for term in cleaned
    ) + ')' + extra + ')', args + ([json.dumps(sorted(alias_addresses))] if extra else [])


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
