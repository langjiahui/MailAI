"""通讯录与联系人分组。"""
import logging

from fastapi import APIRouter, HTTPException

from ... import db
from ..helpers import correspondence_payload, valid_contact_email
from ..schemas import (ContactFavoriteRequest, ContactGroupMembersRequest,
                       ContactGroupRequest, ContactRequest)

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/mail/contacts")
def api_mail_contacts(q: str = "", limit: int = 20, favorites_only: bool = False, group_name: str = ""):
    return db.search_contacts(q, limit, favorites_only, group_name)


@router.get('/api/mail/contact-groups')
def api_contact_groups():
    return db.list_contact_groups()


@router.post('/api/mail/contact-groups')
def api_save_contact_group(payload: ContactGroupRequest):
    try:
        return db.save_contact_group(payload.name, payload.previous)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.delete('/api/mail/contact-groups')
def api_delete_contact_group(name: str):
    return db.delete_contact_group(name)


@router.post('/api/mail/contact-groups/members')
def api_contact_group_members(payload: ContactGroupMembersRequest):
    try:
        return db.update_contact_group_members(payload.name, [valid_contact_email(email) for email in payload.emails], remove=payload.remove)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/api/mail/contacts")
def api_save_contact(payload: ContactRequest):
    email = valid_contact_email(payload.email)
    result = db.save_contact(email, payload.name, payload.company, payload.note, payload.favorite)
    with db.conn() as c:
        if payload.group_name.strip():
            c.execute('INSERT OR IGNORE INTO contact_groups(name) VALUES(?)', (payload.group_name.strip()[:80],))
        c.execute('UPDATE contacts SET group_name=? WHERE email=?', (payload.group_name.strip()[:80], email))
    return {**result, 'group_name': payload.group_name.strip()[:80]}


@router.get("/api/mail/contacts/correspondence")
def api_contact_correspondence(email: str, limit: int = 50):
    """List locally stored mail exchanged with a contact in the current account."""
    return correspondence_payload(valid_contact_email(email), limit)


@router.patch("/api/mail/contacts/favorite")
def api_favorite_contact(payload: ContactFavoriteRequest):
    return db.set_contact_favorite(valid_contact_email(payload.email), payload.favorite)


@router.delete("/api/mail/contacts")
def api_delete_contact(email: str):
    db.hide_contact(valid_contact_email(email))
    return {"ok": True}
