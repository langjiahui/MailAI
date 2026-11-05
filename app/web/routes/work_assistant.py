"""Work assistance uses the same account middleware as mail and compose."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ... import work_assistant

router = APIRouter()


class ContextRequest(BaseModel):
    project: str = Field('', max_length=200)
    role: str = Field('', max_length=200)
    note: str = Field('', max_length=2000)
    revision: int = Field(0, ge=0)
    style: str | None = Field(None, max_length=1000)
    style_revision: int = Field(0, ge=0)


class PreferencesRequest(BaseModel):
    style: str = Field('', max_length=1000)
    revision: int = Field(0, ge=0)


class ReviewRequest(BaseModel):
    email_id: int = Field(gt=0)
    body: str = Field(min_length=1, max_length=30000)
    attachment_names: list[str] = Field(default_factory=list, max_length=100)
    semantic: bool = False


def checked(action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/api/work/preferences')
def preferences():
    return work_assistant.preferences()


@router.put('/api/work/preferences')
def save_preferences(payload: PreferencesRequest):
    return checked(work_assistant.save_preferences, payload.style, payload.revision)


@router.get('/api/work/emails/{email_id}')
def overview(email_id: int):
    return checked(work_assistant.overview, email_id)


@router.put('/api/work/emails/{email_id}/context')
def save_context(email_id: int, payload: ContextRequest):
    return checked(work_assistant.save_context, email_id, **payload.model_dump())


@router.post('/api/work/review')
def review(payload: ReviewRequest):
    return checked(work_assistant.review, payload.email_id, payload.body, payload.attachment_names, semantic=payload.semantic)


@router.get('/api/work/followups/{sent_id}/prepare')
def prepare_followup(sent_id: int):
    return checked(work_assistant.followup_seed, sent_id)
