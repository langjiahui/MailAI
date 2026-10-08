"""通讯录与联系人分组。"""
import logging

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from fastapi.responses import Response

from ... import db, contact_directory
from ..helpers import correspondence_payload, valid_contact_email
from ..schemas import (ContactFavoriteRequest, ContactGroupMembersRequest,
                       ContactGroupRequest, ContactRequest)

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/mail/contacts")
def api_mail_contacts(q: str = "", limit: int = 20, favorites_only: bool = False, group_name: str = "", offset: int = 0, department: str = ""):
    return db.search_contacts(q, limit, favorites_only, group_name, max(0,min(offset,10000)), department)


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
    try:
        profile = contact_directory.normalize_profile(payload.profile) if payload.profile is not None else None
    except ValueError as exc:
        raise HTTPException(400,str(exc))
    try:
        return db.save_contact(email,payload.name,payload.company,payload.note,payload.favorite,
                               profile=profile,group_name=payload.group_name,
                               expected_directory_revision=payload.directory_revision)
    except ValueError as exc:
        raise HTTPException(409,str(exc))



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


@router.post('/api/mail/contacts/directory/file')
async def api_directory_file(request: Request, filename: str = '通讯录.xlsx'):
    content=bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content)>contact_directory.MAX_FILE:
            raise HTTPException(413,'文件超过 5 MB，请拆分后导入')
    try:
        return await run_in_threadpool(contact_directory.inspect_file, bytes(content),filename)
    except ValueError as exc:
        raise HTTPException(400,str(exc))


@router.post('/api/mail/contacts/directory/preview')
def api_directory_preview(payload: dict):
    try:
        return contact_directory.preview(payload.get('token',''),payload.get('sheets'),payload.get('policy','sync'),payload.get('mapping'))
    except ValueError as exc:
        raise HTTPException(409,str(exc))


@router.post('/api/mail/contacts/directory/apply')
def api_directory_apply(payload: dict):
    try:
        return contact_directory.apply(payload.get('token',''),payload.get('emails'))
    except ValueError as exc:
        raise HTTPException(409,str(exc))


@router.get('/api/mail/contacts/directory/summary')
def api_directory_summary():
    return contact_directory.summary()


@router.get('/api/mail/contacts/directory/pending')
def api_directory_pending():
    return contact_directory.pending_records()


@router.post('/api/mail/contacts/directory/pending/{record_key}')
def api_directory_resolve(record_key: str, payload: ContactRequest):
    try:
        return contact_directory.resolve_pending(record_key,payload.model_dump())
    except ValueError as exc:
        raise HTTPException(409,str(exc))


@router.get('/api/mail/contacts/directory/export')
def api_directory_export():
    import csv,io,json
    out=io.StringIO();headers={**contact_directory.CORE,**contact_directory.FIELDS,'note':'个人备注','group_name':'个人分组'}
    writer=csv.writer(out);writer.writerow([*headers.values(),'其他资料（JSON）'])
    with db.conn() as c:
        extra=contact_directory.profiles(c)
        for row in c.execute('SELECT * FROM contacts WHERE hidden=0 ORDER BY email'):
            profile=extra.get(row['email'].casefold(),{})
            values=[str(row[key] or '') if key in row.keys() else str(profile.get(key,'') or '') for key in headers]
            writer.writerow([*("'"+v if v.lstrip().startswith(('=','+','-','@')) else v for v in values),json.dumps(profile.get('custom_fields',{}),ensure_ascii=False)])
    return Response('\ufeff'+out.getvalue(),media_type='text/csv; charset=utf-8',headers={'Content-Disposition':'attachment; filename="contacts-full.csv"','Cache-Control':'no-store'})
