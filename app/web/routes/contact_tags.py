"""General address-book filtering and personal tag management."""
from typing import Literal
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from ...db import contact_tags
from ..helpers import valid_contact_email

router = APIRouter()

class TagRequest(BaseModel):
    name: str = Field(max_length=80)
    previous: str | None = None

class TagMembersRequest(BaseModel):
    name: str = Field(max_length=80)
    emails: list[str] = Field(min_length=1, max_length=300)
    remove: bool = False

@router.get('/api/mail/contact-tags')
def api_contact_tags(q: str='', favorites_only: bool=False, department: str='', company: str='', tag: list[str]=Query(default=[]), tag_mode: Literal['any','all']='any'):
    return contact_tags.facets(q, favorites_only, department, company, tag, tag_mode)

@router.post('/api/mail/contact-tags')
def api_save_tag(payload: TagRequest):
    try:
        return contact_tags.save(payload.name,payload.previous)
    except ValueError as error:
        raise HTTPException(400,str(error))

@router.delete('/api/mail/contact-tags')
def api_delete_tag(name: str):
    return contact_tags.delete(name)

@router.post('/api/mail/contact-tags/members')
def api_tag_members(payload: TagMembersRequest):
    try:
        return contact_tags.update_members(payload.name,[valid_contact_email(email) for email in payload.emails],payload.remove)
    except ValueError as error:
        raise HTTPException(409,str(error))
