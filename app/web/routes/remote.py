"""Local configuration only: incoming commands travel through the authenticated stream."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ... import remote_control, dingtalk_remote, weixin_remote

router = APIRouter()


class RemoteConfigRequest(BaseModel):
    ai_enabled: bool = False
    enabled: bool = False
    client_id: str = Field(default='', max_length=160)
    client_secret: str = Field(default='', max_length=512)
    corp_id: str = Field(default='', max_length=160)
    staff_id: str = Field(default='', max_length=160)
    account_ids: list[str] = Field(default_factory=list, max_length=20)


@router.get('/api/system/remote-control')
def api_remote_config():
    return {**remote_control.public_config(), 'connection': dingtalk_remote.status()}


@router.post('/api/system/remote-control')
def api_remote_save(payload: RemoteConfigRequest):
    try:
        saved = remote_control.save_config(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**saved, 'connection': dingtalk_remote.restart()}


@router.post('/api/system/remote-control/reconnect')
def api_remote_reconnect():
    return {'connection': dingtalk_remote.restart()}


class WeixinConfigRequest(BaseModel):
    ai_enabled: bool = False
    enabled: bool = False
    account_ids: list[str] = Field(default_factory=list, max_length=20)


class WeixinPollRequest(BaseModel):
    verify_code: str = Field(default='', max_length=12)


@router.get('/api/system/remote-control/weixin')
def api_weixin_config():
    return {**remote_control.public_config('weixin'), 'connection': weixin_remote.status()}


@router.post('/api/system/remote-control/weixin')
def api_weixin_save(payload: WeixinConfigRequest):
    try:
        saved = weixin_remote.save_config(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**saved, 'connection': weixin_remote.restart()}


@router.post('/api/system/remote-control/weixin/login')
def api_weixin_login():
    try:
        return weixin_remote.begin_login()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, '无法获取微信二维码，请检查网络后重试') from exc


@router.post('/api/system/remote-control/weixin/login/{login_id}/poll')
def api_weixin_poll(login_id: str, payload: WeixinPollRequest):
    if len(login_id) > 64:
        raise HTTPException(400, '二维码编号无效')
    try:
        return weixin_remote.poll_login(login_id, payload.verify_code)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, '扫码状态暂不可用，正在等待重试') from exc


@router.post('/api/system/remote-control/weixin/login/{login_id}/cancel')
def api_weixin_cancel(login_id: str):
    weixin_remote.cancel_login(login_id)
    return {'ok': True}


@router.post('/api/system/remote-control/weixin/reconnect')
def api_weixin_reconnect():
    return {'connection': weixin_remote.restart()}
