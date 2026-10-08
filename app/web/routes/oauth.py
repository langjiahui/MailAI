"""Configuration and native OAuth session control. Tokens never leave the server."""

from fastapi import APIRouter, HTTPException
from ... import oauth_mail

router = APIRouter()


def checked(fn, *args):
    try:
        return fn(*args)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/api/oauth/clients")
def clients():
    return oauth_mail.clients()


@router.post("/api/oauth/clients")
def save_client(payload: dict):
    return checked(
        oauth_mail.save_client,
        payload.get("provider"),
        payload.get("client_id"),
        payload.get("client_secret") or "",
    )


@router.post("/api/oauth/start")
def begin(payload: dict):
    return checked(oauth_mail.begin, payload.get("provider"), payload.get("user") or "")


@router.get("/api/oauth/status")
def status(state: str):
    return oauth_mail.status(state)


@router.post("/api/oauth/cancel")
def cancel(payload: dict):
    return oauth_mail.cancel(payload.get("state") or "")


@router.post("/api/oauth/complete")
def complete(payload: dict):
    result = checked(oauth_mail.complete, payload.get("state") or "")
    from ...account_guard import start_account_thread
    from ... import pipeline
    from ..helpers import complete_mailbox_initialization

    def initialize():
        if result.get("initialization_needed"):
            complete_mailbox_initialization()
        else:
            pipeline.poll_once()

    start_account_thread(initialize, name="mailai-oauth-initialize")
    return result
