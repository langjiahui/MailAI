"""Work assistance uses the same account middleware as mail and compose."""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from ... import work_assistant, work_memory

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


class MemoryActionRequest(BaseModel):
    revision: int = Field(ge=0)


class MemorySettingsRequest(MemoryActionRequest):
    enabled: bool
    auto_analyze: bool


class MemoryCandidateActionRequest(MemoryActionRequest):
    candidate_revision: int = Field(ge=1)


class MemoryEditRequest(BaseModel):
    preference: str = Field(min_length=1,max_length=300)
    revision: int = Field(ge=1)
    pref_revision: int = Field(ge=0)


class MemoryDeleteRequest(BaseModel):
    revision: int = Field(ge=1)
    pref_revision: int = Field(ge=0)


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


class FollowupDraftRequest(BaseModel):
    tone: str = Field('polite', max_length=30)
    instruction: str = Field('', max_length=600)
    use_work_preferences: bool = True
    language: str = Field('zh-CN', max_length=20)


@router.get('/api/work/followups/{sent_id}/prepare')
def prepare_followup(sent_id: int):
    return checked(work_assistant.followup_seed, sent_id)


@router.post('/api/work/followups/{sent_id}/draft')
def draft_followup(sent_id: int, payload: FollowupDraftRequest | None = None):
    req = payload or FollowupDraftRequest()
    return checked(
        work_assistant.followup_draft,
        sent_id,
        tone=req.tone,
        instruction=req.instruction,
        use_work_preferences=req.use_work_preferences,
        language=req.language,
    )


@router.get('/api/work/memory')
def memory_listing(status: str='adopted', offset: int=Query(0,ge=0), limit: int=Query(20,ge=1,le=50)):
    return checked(work_memory.listing,status,offset,limit)


@router.post('/api/work/memory/analyze')
def memory_analyze(idle: bool=False):
    return checked(work_memory.analyze,idle_only=idle)


@router.get('/api/work/memory/settings')
def memory_settings():
    return work_memory.settings()


@router.put('/api/work/memory/settings')
def save_memory_settings(payload: MemorySettingsRequest):
    return checked(work_memory.save_settings,payload.enabled,payload.auto_analyze,payload.revision)


@router.post('/api/work/memory/clear')
def clear_memory(payload: MemoryActionRequest):
    return checked(work_memory.clear,payload.revision)


@router.post('/api/work/memory/{candidate_id}/adopt')
def memory_adopt(candidate_id: int,payload: MemoryCandidateActionRequest):
    return checked(work_memory.adopt,candidate_id,payload.revision,payload.candidate_revision)


@router.post('/api/work/memory/{candidate_id}/dismiss')
def memory_dismiss(candidate_id: int,payload: MemoryCandidateActionRequest):
    return checked(work_memory.dismiss,candidate_id,payload.revision,payload.candidate_revision)


@router.put('/api/work/memory/{candidate_id}')
def memory_edit(candidate_id: int,payload: MemoryEditRequest):
    return checked(work_memory.edit,candidate_id,payload.preference,payload.revision,payload.pref_revision)


@router.delete('/api/work/memory/{candidate_id}')
def memory_delete(candidate_id: int,payload: MemoryDeleteRequest):
    return checked(work_memory.remove,candidate_id,payload.revision,payload.pref_revision)
