"""接口请求模型（Pydantic）。从 server.py 集中拆分，供各路由模块复用。"""
from pydantic import BaseModel, Field


class MailLoginRequest(BaseModel):
    host: str
    port: int = 993
    user: str
    password: str
    ssl: bool = True
    verify_ssl: bool = True
    smtp_host: str
    smtp_port: int = 465
    smtp_ssl: bool = True
    smtp_starttls: bool = False
    smtp_verify_ssl: bool = True


class AccountSwitchRequest(BaseModel):
    account_id: str


class MailAccountUpdateRequest(MailLoginRequest):
    account_id: str


class MailLogoutRequest(BaseModel):
    clear_history: bool = False
    account_id: str = ""


class FolderRequest(BaseModel):
    name: str


class BulkMailRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    action: str
    value: bool | None = None
    target: str = ""


class TrashPurgeRequest(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=10000)
    empty: bool = False
    token: str = ""
    confirmed: bool = False


class AllowlistRequest(BaseModel):
    domain: str
    kind: str = "domain"
    enabled: bool = True
    note: str = ""


class RuleCategoryRequest(BaseModel):
    enabled: bool = True
    sensitivity: str = "balanced"


class ComposeAssistRequest(BaseModel):
    operation: str
    subject: str = ""
    body_text: str = ""
    original_text: str = ""
    user_instruction: str = ""
    recipients: str = ""
    attachment_names: list[str] = Field(default_factory=list)
    tone: str = "正式"
    length: str = "适中"


class ContactRequest(BaseModel):
    email: str
    name: str = ""
    company: str = ""
    note: str = ""
    favorite: bool = False
    group_name: str = ''


class ContactFavoriteRequest(BaseModel):
    email: str
    favorite: bool = True


class SignatureRequest(BaseModel):
    id: str = ""
    name: str = "我的签名"
    html: str = ""
    profile: dict = Field(default_factory=dict)
    make_default: bool = False


class SignatureGenerateRequest(BaseModel):
    profile: dict = Field(default_factory=dict)
    style: str = "专业简洁"


class MailPreflightRequest(BaseModel):
    to_addr: str = ""
    cc_addr: str = ""
    bcc_addr: str = ""
    subject: str = ""
    body_text: str = ""
    attachment_count: int = 0
    attachment_names: list[str] = Field(default_factory=list)
    mode: str = "compose"
    reply_to_email_id: int | None = None
    original_text: str = ""


class TodoUpdateRequest(BaseModel):
    title: str | None = None
    deadline: str | None = None
    stage: str | None = None
    kind: str | None = None
    remind_at: str | None = None


class TodoBulkStatusRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    status: str = "done"


class ModelConfigRequest(BaseModel):
    provider: str = "custom"
    extra_params: dict | None = None
    multimodal_enabled: bool = True
    base_url: str = ""
    model: str = ""
    multimodal_model: str = ""
    api_key: str = ""
    verify_ssl: bool = True


class DraftRequest(BaseModel):
    source_draft_email_id: int | None = None
    id: int | None = None
    to_addr: str = ""
    cc_addr: str = ""
    bcc_addr: str = ""
    subject: str = ""
    body_html: str = ""
    attachments: list[dict] = Field(default_factory=list)
    reply_to_email_id: int | None = None
    mode: str = "compose"
    in_reply_to: str = ""
    references: str = ""


class SendMailRequest(DraftRequest):
    in_reply_to: str = ""
    references: str = ""
    preflight_confirmed: bool = False


class QueuedMailRequest(SendMailRequest):
    request_token: str


class AssistantImage(BaseModel):
    data_url: str = Field(max_length=7 * 1024 * 1024)


class AssistantAttachmentRef(BaseModel):
    email_id: int = Field(ge=1)
    index: int = Field(ge=0)
    digest: str = Field(pattern=r'^[a-f0-9]{64}$')


class AssistantRequest(BaseModel):
    question: str = Field(max_length=12000)
    history: list[dict] = Field(default_factory=list)
    conversation_id: int | None = None
    email_ids: list[int] | None = None
    scope_label: str = ''
    alert_context: bool = False
    images: list[AssistantImage] = Field(default_factory=list, max_length=3)
    attachments: list[AssistantAttachmentRef] = Field(default_factory=list, max_length=3)


class PreferencesRequest(BaseModel):
    notifications: str = 'all'
    muted_threads: list[str] = Field(default_factory=list)
    semantic_enabled: bool = False


class CleanupPreviewRequest(BaseModel):
    offset: int = Field(default=0, ge=0, le=10000000)
    folder: str
    before_date: str
    include_favorites: bool = False


class CleanupExecuteRequest(BaseModel):
    token: str
    confirmation: str
    acknowledge: bool = False


class PortableExportRequest(BaseModel):
    include_raw: bool = True
    password: str = Field(default="", max_length=1024)
    since: str = Field(default="", max_length=40)
    until: str = Field(default="", max_length=40)


class PortableImportRequest(BaseModel):
    import_token: str = Field(min_length=32, max_length=32)
    password: str = Field(default="", max_length=1024)


class ContactGroupRequest(BaseModel):
    name: str
    previous: str | None = None


class ContactGroupMembersRequest(BaseModel):
    name: str
    emails: list[str] = Field(min_length=1, max_length=300)
    remove: bool = False
