"""Validated endpoints for the account-local companion journal."""
from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ... import companion_growth as growth

router = APIRouter()


class Heartbeat(BaseModel):
    token: str = Field(min_length=8, max_length=80, pattern=r'^[a-zA-Z0-9-]+$')
    active: int = Field(default=0, ge=0, le=30)
    reading: int = Field(default=0, ge=0, le=30)
    clicks: int = Field(default=0, ge=0, le=10)
    email_id: int | None = Field(default=None, gt=0)
    learn: str = Field(default='', max_length=80, pattern=r'^[a-zA-Z0-9._-]*$')


class Purchase(BaseModel):
    item: str = Field(max_length=32)
    token: str = Field(default='', max_length=80, pattern=r'^[a-zA-Z0-9-]*$')


class Outfit(BaseModel):
    slot: Literal['palette', 'accessory', 'effect', 'theme']
    item: str = Field(default='', max_length=32)


class Style(BaseModel):
    style: Literal['nature', 'ranger']


class Preference(BaseModel):
    enabled: bool


def checked(action, *args):
    try:
        return action(*args)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/api/companion/growth')
def status():
    return growth.snapshot()


@router.post('/api/companion/heartbeat')
def heartbeat(payload: Heartbeat):
    return growth.heartbeat(**payload.model_dump())


@router.post('/api/companion/purchase')
def purchase(payload: Purchase):
    return checked(growth.purchase, payload.item, payload.token)


@router.post('/api/companion/equip')
def equip(payload: Outfit):
    return checked(growth.equip, payload.slot, payload.item)


@router.post('/api/companion/preferences')
def preferences(payload: Preference):
    return growth.set_enabled(payload.enabled)


@router.post('/api/companion/style')
def style(payload: Style):
    return checked(growth.set_style, payload.style)
