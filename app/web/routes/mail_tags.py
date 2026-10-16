"""Personal mail labels and automatic labeling rules (account-scoped middleware)."""
from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ...db import mail_tags

router = APIRouter()

class TagRequest(BaseModel):
    name: str = Field(max_length=80)
    color: str = '#548879'
    id: int | None = Field(default=None, gt=0)

class MembersRequest(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=300)
    tag_ids: list[int] = Field(max_length=1000)
    mode: Literal['add', 'remove', 'replace'] = 'add'
    original_tag_ids: list[int] | None = Field(default=None, max_length=1000)

class Condition(BaseModel):
    field: Literal['sender', 'subject', 'body']
    operator: Literal['contains', 'equals', 'not_contains'] = 'contains'
    value: str = Field(min_length=1, max_length=500)

class RuleRequest(BaseModel):
    id: int | None = Field(default=None, gt=0)
    name: str = Field(max_length=80)
    enabled: bool = True
    match_mode: Literal['all', 'any'] = 'all'
    conditions: list[Condition] = Field(min_length=1, max_length=20)
    tag_ids: list[int] = Field(min_length=1, max_length=50)


def checked(action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error

@router.get('/api/mail/tags')
def api_mail_tags():
    return {'tags': mail_tags.catalog(), 'rules': mail_tags.rules()}

@router.post('/api/mail/tags')
def api_save_mail_tag(payload: TagRequest):
    return checked(mail_tags.save_tag, payload.name, payload.color, payload.id)

@router.delete('/api/mail/tags/{tag_id}')
def api_delete_mail_tag(tag_id: int):
    return mail_tags.delete_tag(tag_id)

@router.post('/api/mail/tags/members')
def api_mail_tag_members(payload: MembersRequest):
    return checked(mail_tags.update_members, payload.ids, payload.tag_ids, payload.mode, payload.original_tag_ids)

@router.post('/api/mail/tag-rules')
def api_save_mail_tag_rule(payload: RuleRequest):
    return checked(mail_tags.save_rule, payload.name, [item.model_dump() for item in payload.conditions],
                   payload.tag_ids, payload.match_mode, payload.enabled, payload.id)

@router.delete('/api/mail/tag-rules/{rule_id}')
def api_delete_mail_tag_rule(rule_id: int):
    return mail_tags.delete_rule(rule_id)

@router.post('/api/mail/tag-rules/apply')
def api_apply_mail_tag_rules():
    return mail_tags.apply_existing()


class SnapshotRequest(BaseModel):
    ids: list[int] = Field(max_length=1000)

@router.post('/api/mail/tags/snapshot')
def api_mail_tag_snapshot(payload: SnapshotRequest):
    return {'items': checked(mail_tags.snapshot, payload.ids)}


class PreviewRequest(BaseModel):
    conditions: list[Condition] = Field(min_length=1, max_length=20)
    match_mode: Literal['all', 'any'] = 'all'

@router.post('/api/mail/tag-rules/preview')
def api_preview_mail_tag_rule(payload: PreviewRequest):
    return checked(mail_tags.preview, [item.model_dump() for item in payload.conditions], payload.match_mode)
