"""Mailbox-local personal tags; legacy groups remain readable without a migration."""
import re
from collections import Counter
from .core import conn


def split_tags(value):
    return list(dict.fromkeys(t.strip() for t in re.split(r'[、,，;；\n]', str(value or '')) if t.strip()))


def members(c):
    result = {}
    for row in c.execute('SELECT email,tag FROM contact_tag_members ORDER BY tag'):
        result.setdefault(row['email'].casefold(), []).append(row['tag'])
    return result


def annotate(item, personal):
    names = list(dict.fromkeys([*personal, *([item['group_name']] if item.get('group_name') else [])]))
    item['tags'] = [{'id':'personal:'+name, 'name':name, 'source':'personal'} for name in names]
    item['tags'] += [{'id':'directory:'+name, 'name':name, 'source':'directory'} for name in split_tags(item.get('profile', {}).get('directory_tags'))]


def matches(item, selected, mode='any'):
    ids = {tag['id'] for tag in item.get('tags', [])}
    return not selected or (set(selected) <= ids if mode == 'all' else bool(set(selected) & ids))


def facets(query='', favorites_only=False, department='', company='', tags=(), mode='any'):
    from .contacts import search_contacts, filter_contact_values
    all_items = search_contacts(_all=True)
    base = filter_contact_values(all_items,query,favorites_only,department=department,company=company)
    counts = Counter(tag['id'] for item in base for tag in item['tags'])
    available = {tag['id']:tag for item in all_items for tag in item['tags']}
    with conn() as c:
        names = [r['name'] for r in c.execute('SELECT name FROM contact_tags UNION SELECT name FROM contact_groups')]
    for name in names:
        available.setdefault('personal:'+name, {'id':'personal:'+name,'name':name,'source':'personal'})
    companies = Counter(item['company'] for item in all_items if item['company'])
    return {'tags':[dict(tag, count=counts[tag['id']]) for tag in sorted(available.values(), key=lambda t:(t['source'] != 'personal', t['name']))],
            'companies':[{'name':name,'count':count} for name,count in sorted(companies.items())],
            'total':sum(matches(item,tags,mode) for item in base)}


def valid_name(value):
    name = str(value or '').strip()
    if not name or len(name) > 80 or re.search(r'[\x00-\x1f]', name):
        raise ValueError('标签名称不能为空，且不能超过 80 字')
    return name


def exists(c, name):
    return c.execute('SELECT name FROM contact_tags WHERE name=? UNION SELECT name FROM contact_groups WHERE name=?', (name,name)).fetchone()


def save(name, previous=None):
    name = valid_name(name)
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        if previous is not None and not exists(c,previous):
            raise ValueError('标签已不存在，请刷新后重试')
        if exists(c,name) and (previous is None or name.casefold() != previous.casefold()):
            raise ValueError('标签名称已存在')
        if previous is None:
            c.execute('INSERT INTO contact_tags(name) VALUES(?)', (name,))
        elif name != previous:
            c.execute('DELETE FROM contact_tags WHERE name=?', (previous,))
            c.execute('INSERT INTO contact_tags(name) VALUES(?)', (name,))
            c.execute('UPDATE contact_tag_members SET tag=? WHERE tag=?', (name,previous))
            c.execute('UPDATE contact_groups SET name=? WHERE name=?', (name,previous))
            c.execute('UPDATE contacts SET group_name=? WHERE group_name=?', (name,previous))
    return {'ok':True,'name':name}


def delete(name):
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        c.execute('DELETE FROM contact_tag_members WHERE tag=?', (name,))
        c.execute('DELETE FROM contact_tags WHERE name=?', (name,))
        c.execute('DELETE FROM contact_groups WHERE name=?', (name,))
        c.execute("UPDATE contacts SET group_name='' WHERE group_name=?", (name,))
    return {'ok':True}


def update_members(name, emails, remove=False):
    from .contacts import search_contacts
    addresses = list(dict.fromkeys(str(email).strip().casefold() for email in emails))
    if not addresses or len(addresses) > 300:
        raise ValueError('每次请选择 1 至 300 位联系人')
    visible = {item['email'] for item in search_contacts(_all=True)}
    if any(email not in visible for email in addresses):
        raise ValueError('所选联系人已不存在，请刷新后重新选择')
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        existing = exists(c,name)
        if not existing:
            raise ValueError('标签已不存在，请刷新后重试')
        name = existing['name']
        for email in addresses:
            if remove:
                c.execute('DELETE FROM contact_tag_members WHERE email=? AND tag=?', (email,name))
                c.execute("UPDATE contacts SET group_name='' WHERE email=? AND group_name=?", (email,name))
            else:
                c.execute('INSERT OR IGNORE INTO contact_tag_members(email,tag) VALUES(?,?)', (email,name))
    return {'ok':True,'count':len(addresses)}
