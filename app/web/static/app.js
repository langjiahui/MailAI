const API = '';

// Windows 桌面端由 WebView2 承载。多层毛玻璃、阴影和持续动画会让集成显卡
// 在长列表重绘时产生明显卡顿；桌面端默认采用等价但更轻的视觉效果。
const isWindowsDesktop = /Windows/i.test(navigator.userAgent || '');
if (isWindowsDesktop) document.documentElement.classList.add('windows-performance');

// ===== 全局状态 =====
let allEmails = [];
let allTodos = [];
let currentFilter = {
  status: '',
  verdict: '',
  category: '',
  days: 9999,
  priority: '',
  domain: '',
  search: '',
  attachments: false,
  unread: false,
  sort: 'date-desc',
};
let selectedEmailId = null;
let selectedEmailDetail = null;
let _fetchPollTimer = null;
let _fetchPollController = null;
let currentDraftId = null;
let draftSaveTimer = null;
let draftMaxSaveTimer = null;
let draftListRevision = 0;
let composeAiRevision = 0;
let draftSession = {id: null, pending: Promise.resolve(), canceled: false, busy: false};
let sendCapability = {configured: false, from_addr: ''};
let signatureState = {items: [], default_id: '', profile: {}, ai_available: false};
let currentSignatureId = '';
let editingSignatureId = '';
let savedComposeRange = null;
let specialMailbox = '';
let currentServerFolder = '';
let sentMessages = [];
let savedDrafts = [];
let composeContext = {mode: 'compose', reply_to_email_id: null, in_reply_to: '', references: '', original_text: ''};
let composeAttachments = [];
let composeAiSuggestion = '';
let composePreflightPending = null;
let assistantHistory = [];
let assistantAlertContextIds = [];
let assistantAlerts = null;
let assistantConversationId = null;
let assistantHistoryLoaded = false;
let assistantController = null;
let assistantRevision = 0;
let assistantLastQuestion = '';
let assistantLastScope = null;
let assistantLastImages = [];
let assistantLastAttachments = [];
let assistantLastAlertContext = false;
let assistantPinnedScope = null;
let assistantNoticeKey = '';
let assistantScopeKey = '';
let browsingAccountId = localStorage.getItem('mailai-browsing-account') || '';
let composeAccountId = '';
let contactInput = null;
let contactTimer = null;
let contactItems = [];
let contactIndex = -1;
let contactSuggestionRevision = 0;
let contactCenterItems = [];
let contactCenterFilter = 'all';
let contactPickerTarget = '';
let contactCenterAccountId = '';
let contactCenterSession = null;
let contactPickerContacts = new Map();
let contactEditorSession = null;
let selectedContactEmails = new Set();
let selectedMailIds = new Set();
let renderedEmailIds = [];
let mailRenderLimit = 240;
let bulkVisualRevision = 0;
let selectionAnchorId = null;
let bulkStackFocusId = null;
let bulkStackPreviewController = null;
const bulkStackPreviewCache = new Map();
let bulkOperationActive = false;
let mailboxFolders = [];
let mailboxFoldersAccountId = '';
let attachmentItems = [];
let attachmentTypeFilter = 'all';
let selectedManagedAccountId = '';
let globalSearchTimer = null;
let searchResults = null;
let searchRevision = 0;
let sourceFocusTimer = null;
let mailboxRevisionToken = null;
let mailboxRefreshTimer = null;
let mailboxRefreshInFlight = false;
let mailboxConfigCheckedAt = 0;
let emailListRenderSignature = '';
let readingLoadRevision = 0;
let readingLoadController = null;
let readSyncQueue = [];
let readSyncRunning = false;
let readSyncSequence = 0;
const readSyncJobs = new Map();
let unifiedMailbox = false;
let selectedMailboxAccountId = '';
let selectedEmailAccountId = '';
let mailboxNavigationRevision = 0;
let mailboxActivationQueue = Promise.resolve();
const SERVER_FOLDER_VISIBILITY_KEY = 'mailai.preferences.showServerFolders.v1';

function serverFoldersVisible() {
  try { return localStorage.getItem(SERVER_FOLDER_VISIBILITY_KEY) === 'true'; }
  catch (_) { return false; }
}

function applyServerFolderVisibility() {
  const visible = serverFoldersVisible();
  document.getElementById('server-folder-group')?.classList.toggle('hidden', !visible);
  const control = document.getElementById('show-server-folders');
  if (control) control.checked = visible;
  return visible;
}

applyServerFolderVisibility();

function setSegmentedFilter(id, value) {
  const group = document.getElementById(id);
  if (!group) return;
  group.dataset.value = String(value);
  group.querySelectorAll('[data-value]').forEach(button => {
    const active = button.dataset.value === String(value);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function updateFilterSummary() {
  const active = [
    currentFilter.days !== 9999, Boolean(currentFilter.priority), Boolean(currentFilter.domain),
    currentFilter.attachments, currentFilter.unread, Boolean(currentFilter.search), Boolean(currentFilter.status),
    Boolean(currentFilter.verdict), Boolean(currentFilter.category), Boolean(specialMailbox), Boolean(currentServerFolder),
  ].filter(Boolean).length;
  const badge = document.getElementById('filter-active-count');
  if (badge) { badge.textContent = active; badge.classList.toggle('hidden', !active); }
  const clear = document.getElementById('btn-reset-filter');
  if (clear) clear.disabled = active === 0;
}

function lastRecipientSeparatorIndex(value) {
  let index = -1;
  let quoted = false, escaped = false, angleDepth = 0;
  const text = String(value || '');
  for (let position = 0; position < text.length; position += 1) {
    const char = text[position];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quoted) { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === '<') { angleDepth += 1; continue; }
    if (!quoted && char === '>') { angleDepth = Math.max(0, angleDepth - 1); continue; }
    if (!quoted && !angleDepth && /[,;，；\n\r]/.test(char)) index = position;
  }
  return index;
}

function splitRecipientTokens(value) {
  const text = String(value || '');
  const tokens = [];
  let current = '', quoted = false, escaped = false, angleDepth = 0;
  for (const char of text) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quoted) { current += char; escaped = true; continue; }
    if (char === '"') { current += char; quoted = !quoted; continue; }
    if (!quoted && char === '<') angleDepth += 1;
    else if (!quoted && char === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (!quoted && !angleDepth && /[,;，；\n\r]/.test(char)) {
      if (current.trim()) tokens.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

function normalizeRecipientText(value) {
  return splitRecipientTokens(value).join(', ');
}

function contactRecipientValue(item) {
  const email = String(item?.email || item || '').trim();
  const name = String(item?.name || '').trim().replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ');
  const localPart = email.split('@', 1)[0].toLowerCase();
  const usefulName = name && !name.includes('@') && name.toLowerCase() !== localPart && name.toLowerCase() !== email.toLowerCase();
  if (!usefulName) return email;
  const safeName = /[,;"，；():@\[\]\\]/.test(name) ? `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : name;
  return `${safeName} <${email}>`;
}

function currentContactToken(input) {
  return input.value.slice(lastRecipientSeparatorIndex(input.value) + 1).trim();
}

function hideContactSuggestions() {
  clearTimeout(contactTimer); contactTimer = null;
  contactSuggestionRevision += 1;
  document.getElementById('contact-suggestions').classList.add('hidden');
  contactItems = []; contactIndex = -1;
}

function positionContactSuggestions(input) {
  const popup = document.getElementById('contact-suggestions');
  const card = document.querySelector('.compose-card').getBoundingClientRect();
  const rect = input.getBoundingClientRect();
  popup.style.left = `${rect.left - card.left}px`;
  popup.style.top = `${rect.bottom - card.top + 5}px`;
  popup.style.width = `${rect.width}px`;
}

function renderContactSuggestions(items) {
  const popup = document.getElementById('contact-suggestions');
  contactItems = items; contactIndex = items.length ? 0 : -1;
  if (!items.length || !contactInput) return hideContactSuggestions();
  popup.innerHTML = items.map((item, index) => `<button type="button" role="option" class="contact-option ${index === 0 ? 'active' : ''}" data-index="${index}">
    <span class="contact-avatar">${esc((item.name || item.email).charAt(0).toUpperCase())}</span>
    <span><b>${item.favorite ? '<i class="contact-favorite-mark">★</i>' : ''}${esc(item.name || item.email)}</b>${item.name ? `<small>${esc(item.email)}</small>` : ''}</span>
    <em>${item.count ? `往来 ${item.count} 次` : '个人联系人'}</em></button>`).join('');
  positionContactSuggestions(contactInput);
  popup.classList.remove('hidden');
}

async function loadContactSuggestions(input) {
  const revision = ++contactSuggestionRevision;
  contactInput = input;
  const token = currentContactToken(input);
  const accountId = composeAccountId || activeMailAccount()?.id || '';
  try {
    const items = await api(`/api/mail/contacts?q=${encodeURIComponent(token)}&limit=${token ? 12 : 8}`, {accountId});
    if (revision !== contactSuggestionRevision || contactInput !== input ||
        currentContactToken(input) !== token || (composeAccountId || activeMailAccount()?.id || '') !== accountId) return;
    renderContactSuggestions(items);
  } catch (_) {
    if (revision === contactSuggestionRevision) hideContactSuggestions();
  }
}

function chooseContact(index) {
  const item = contactItems[index];
  if (!item || !contactInput) return;
  const value = contactInput.value;
  const split = lastRecipientSeparatorIndex(value);
  const prefix = split >= 0 ? normalizeRecipientText(value.slice(0, split)) : '';
  contactInput.value = [prefix, contactRecipientValue(item)].filter(Boolean).join(', ');
  contactInput.focus();
  hideContactSuggestions(); queueDraftSave(); refreshComposeAiContext();
}

function highlightContact(index) {
  if (!contactItems.length) return;
  contactIndex = (index + contactItems.length) % contactItems.length;
  document.querySelectorAll('.contact-option').forEach((el, i) => el.classList.toggle('active', i === contactIndex));
  document.querySelector(`.contact-option[data-index="${contactIndex}"]`)?.scrollIntoView({block:'nearest'});
}

function recipientEmails(value) {
  return splitRecipientTokens(value).map(part => {
    const match = part.match(/<([^<>\s]+@[^<>\s]+)>/) || part.match(/([^\s<>]+@[^\s<>]+)/);
    return (match?.[1] || '').replace(/[)>]+$/, '').toLowerCase();
  }).filter(Boolean);
}

function appendRecipients(input, contacts) {
  const existingText = normalizeRecipientText(input.value);
  const seen = new Set(recipientEmails(existingText));
  const additions = [];
  for (const contact of contacts) {
    const email = String(contact?.email || contact || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    additions.push(contactRecipientValue(contact));
    seen.add(email);
  }
  input.value = [existingText, ...additions].filter(Boolean).join(', ');
  input.dispatchEvent(new Event('input', {bubbles:true}));
}

function contactInitial(item) {
  return (item.name || item.email || '?').trim().charAt(0).toUpperCase();
}

function renderContactCenter() {
  const list = document.getElementById('contact-center-list');
  const picker = Boolean(contactPickerTarget);
  const selectedGroup = document.getElementById('contact-group-filter')?.value || '';
  const visibleContacts = selectedGroup ? contactCenterItems.filter(item => selectedGroup === '__ungrouped__' ? !item.group_name : item.group_name === selectedGroup) : contactCenterItems;
  if (!visibleContacts.length && selectedGroup && selectedGroup !== '__ungrouped__') {
    list.innerHTML = `<div class="contact-empty"><span>◎</span><b>${mailaiT('contact.groupEmpty') || '当前分组暂无匹配人员'}</b><small>${mailaiT('contact.groupEmptyHint') || '点击“添加人员”，从已有联系人中选择加入'}</small><button type="button" data-open-group-members>＋ ${mailaiT('contact.addMembers') || '添加人员'}</button></div>`;
  } else if (!visibleContacts.length) {
    list.innerHTML = `<div class="contact-empty"><span>◎</span><b>${contactCenterFilter === 'favorite' ? (mailaiT('contact.noFavorites') || '还没有常用联系人') : (mailaiT('contact.notFound') || '没有找到联系人')}</b><small>${contactCenterFilter === 'favorite' ? (mailaiT('contact.noFavoritesHint') || '点击联系人右侧的星标，即可固定到常用') : (mailaiT('contact.notFoundHint') || '可以新建联系人，邮件往来后也会自动出现在这里')}</small></div>`;
  } else {
    list.innerHTML = visibleContacts.map(item => {
      const checked = selectedContactEmails.has(item.email);
      return `<article class="contact-center-item ${checked ? 'selected' : ''}" data-contact-email="${esc(item.email)}">
        ${picker ? `<button type="button" class="contact-pick-check" data-contact-pick="${esc(item.email)}" aria-label="${checked ? '取消选择' : '选择'} ${esc(item.email)}"><span>${checked ? '✓' : ''}</span></button>` : ''}
        <span class="contact-center-avatar">${esc(contactInitial(item))}</span>
        <div class="contact-center-main"><b>${esc(item.name || item.email)}</b><small>${item.name ? `${esc(item.email)}${item.company ? ` · ${esc(item.company)}` : ''}` : (item.company ? esc(item.company) : '从邮件往来自动识别')}</small>${item.note ? `<p>${esc(item.note)}</p>` : ''}</div>
        ${picker ? `<div class="contact-frequency"><b>${item.count || 0}</b><small>${mailaiT('contact.exchanges') || '往来次数'}</small></div>` : `<button type="button" class="contact-frequency contact-correspondence-trigger" data-contact-correspondence="${esc(item.email)}" aria-label="查看与${esc(item.name || item.email)}的往来邮件"><b>${item.count || 0}</b><small>${mailaiT('contact.exchanges') || '往来次数'}</small></button>`}
        <button type="button" class="contact-star ${item.favorite ? 'active' : ''}" data-contact-favorite="${esc(item.email)}" data-favorite="${item.favorite ? '1' : '0'}" aria-label="${item.favorite ? '取消常用' : '设为常用'}">★</button>
        <div class="contact-row-actions">${picker ? '' : `<button type="button" data-contact-compose="${esc(item.email)}">${mailaiT('contact.compose') || '写邮件'}</button><button type="button" data-contact-edit="${esc(item.email)}">${mailaiT('contact.edit') || '编辑'}</button>${selectedGroup && selectedGroup !== '__ungrouped__' ? `<button type="button" data-group-remove-member="${esc(item.email)}">${mailaiT('contact.removeFromGroup') || '移出分组'}</button>` : ''}<button type="button" class="danger" data-contact-delete="${esc(item.email)}">${mailaiT('contact.remove') || '移除'}</button>`}</div>
      </article>`;
    }).join('');
  }
  const footer = document.getElementById('contact-picker-footer');
  footer.classList.toggle('hidden', !picker);
  document.getElementById('contact-picker-count').textContent = selectedContactEmails.size ? `已选择 ${selectedContactEmails.size} 位联系人` : '尚未选择';
  document.getElementById('btn-apply-contacts').disabled = false;
}

function contactAccountId() { return contactCenterAccountId || activeMailAccount()?.id || ''; }

function applyContactSelection(input, selected, contacts) {
  // Preserve typed display names and incomplete input; remove only explicitly
  // deselected addresses, even when their row is hidden by a search/filter.
  const kept = splitRecipientTokens(input.value).filter(token => {
    const email = recipientEmails(token)[0];
    return !email || selected.has(email);
  });
  input.value = kept.join(', ');
  appendRecipients(input, [...selected].map(email => contacts.get(email) || email));
}

let contactLoadRevision = 0;
async function loadContactCenter() {
  if (!contactCenterSession) return;
  const revision = ++contactLoadRevision;
  const accountId = contactAccountId();
  const query = document.getElementById('contact-center-search').value.trim();
  const favorite = contactCenterFilter === 'favorite';
  const group = document.getElementById('contact-group-filter')?.value || '';
  const selectAll = document.getElementById('group-select-all');
  if (selectAll) selectAll.disabled = true;
  try {
    const items = await api(`/api/mail/contacts?q=${encodeURIComponent(query)}&limit=300&favorites_only=${favorite}&group_name=${encodeURIComponent(group)}`, {accountId});
    if (revision !== contactLoadRevision || accountId !== contactAccountId()) return;
    contactCenterItems = items;
    items.forEach(item => contactPickerContacts.set(item.email.toLowerCase(), item));
    await window.refreshContactGroups?.();
    if (revision !== contactLoadRevision) return;
    renderContactCenter();
  } catch (error) {
    if (revision === contactLoadRevision) document.getElementById('contact-center-list').innerHTML = `<div class="contact-empty"><b>通讯录加载失败</b><small>${esc(error.message)}</small></div>`;
  } finally {
    if (selectAll && revision === contactLoadRevision) selectAll.disabled = false;
  }
}

async function openContactCenter(target = '') {
  closeAssistant();
  hideContactSuggestions();
  contactPickerTarget = target;
  contactCenterAccountId = (target ? composeAccountId : activeMailAccount()?.id) || '';
  contactCenterSession = {accountId:contactCenterAccountId, draft:target ? draftSession : null};
  contactEditorSession = null;
  document.getElementById('contact-editor').classList.add('hidden');
  if (document.getElementById('contact-group-filter')) document.getElementById('contact-group-filter').innerHTML = `<option value="">${mailaiT('contact.allGroups') || '全部分组'}</option>`;
  if (document.getElementById('contact-group-options')) document.getElementById('contact-group-options').innerHTML = '';
  window.updateContactGroupControls?.();
  contactPickerContacts = new Map();
  contactCenterItems = [];
  document.getElementById('contact-center-list').textContent = '正在加载联系人…';
  selectedContactEmails = new Set(target ? recipientEmails(document.getElementById(target).value) : []);
  contactCenterFilter = 'all';
  if (document.getElementById('contact-group-filter')) document.getElementById('contact-group-filter').value = '';
  document.getElementById('contact-center-title').textContent = target ? (mailaiT('contact.pickPrefix') || '选择') + (target === 'compose-to' ? (mailaiT('contact.pickTo') || '收件人') : target === 'compose-cc' ? (mailaiT('contact.pickCc') || '抄送人') : (mailaiT('contact.pickBcc') || '密送人')) : (mailaiT('contact.title') || '通讯录');
  document.getElementById('contact-center-eyebrow').textContent = target ? (mailaiT('contact.pickHint') || '从常用和历史往来中选择') : (mailaiT('contact.eyebrow') || '自动学习邮件往来');
  const owner = (_systemConfig?.accounts || []).find(account => account.id === contactCenterAccountId);
  document.getElementById('contact-center-description').textContent = `${owner?.user || (mailaiT('contact.currentAccount') || '当前邮箱')} · ` + (target ? (mailaiT('contact.descPick') || '勾选或取消勾选后点击应用；未完成的手输内容会保留') : (mailaiT('contact.desc') || '常用联系人优先显示，可补充姓名和公司'));
  document.getElementById('contact-center-search').value = '';
  document.querySelectorAll('[data-contact-filter]').forEach(button => button.classList.toggle('active', button.dataset.contactFilter === contactCenterFilter));
  document.getElementById('contact-center').classList.remove('hidden');
  document.body.classList.add('modal-open');
  await loadContactCenter();
}

function closeContactCenter() {
  ++contactLoadRevision;
  clearTimeout(contactSearchTimer);
  contactCenterSession = null; contactEditorSession = null;
  contactCenterAccountId = '';
  ['group-dialog','group-members-dialog'].forEach(id => { const dialog = document.getElementById(id); if (dialog?.open) dialog.close(); });
  document.getElementById('contact-center').classList.add('hidden');
  document.getElementById('contact-editor').classList.add('hidden');
  if (!document.querySelector('.modal:not(.hidden), .attachment-center:not(.hidden)')) document.body.classList.remove('modal-open');
  contactPickerTarget = '';
  selectedContactEmails.clear();
}

function openContactEditor(item = null) {
  contactEditorSession = contactCenterSession;
  if (document.getElementById('contact-group-name')) document.getElementById('contact-group-name').value = item?.group_name || (document.getElementById('contact-group-filter')?.value === '__ungrouped__' ? '' : document.getElementById('contact-group-filter')?.value) || '';
  document.getElementById('contact-editor-title').textContent = item ? '编辑联系人' : '新建联系人';
  document.getElementById('contact-name').value = item?.name || '';
  document.getElementById('contact-email').value = item?.email || '';
  document.getElementById('contact-email').readOnly = Boolean(item);
  document.getElementById('contact-company').value = item?.company || '';
  document.getElementById('contact-note').value = item?.note || '';
  document.getElementById('contact-favorite').checked = Boolean(item?.favorite);
  document.getElementById('contact-editor').classList.remove('hidden');
  (item ? document.getElementById('contact-name') : document.getElementById('contact-email')).focus();
}

function closeContactEditor() { document.getElementById('contact-editor').classList.add('hidden'); }

// ===== MailAI 智能助手 =====
function assistantSourceItems(sources = []) {
  const seen = new Set();
  return sources.filter(source => {
    const id = Number(source?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) return false;
    seen.add(id); return true;
  });
}
function assistantSourcesHtml(sources = [], accountId = '') {
  const items = assistantSourceItems(sources);
  if (!items.length) return '';
  return `<details class="assistant-sources" ${items.length <= 3 ? 'open' : ''}>
    <summary><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14v11H3zM3 5l7 6 7-6"/></svg><span>参考邮件</span><em>${items.length} 封</em><span class="source-disclosure"><span class="source-expand">展开</span><span class="source-collapse">收起</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3 3 3-3"/></svg></span></summary>
    <div class="assistant-source-list" role="list" aria-label="本次回答的参考邮件">${items.map((source, index) => {
      const title = source.subject || '（无主题）';
      const meta = [source.from_addr, source.date ? String(source.date).slice(0, 10) : ''].filter(Boolean).join(' · ');
      return `<div role="listitem"><button type="button" data-email-id="${Number(source.id)}" data-source-account="${esc(accountId)}" aria-label="查看参考邮件 ${index + 1}：${esc(title)}"><span class="source-index">${index + 1}</span><span class="source-copy"><span class="source-subject">${esc(title)}</span>${meta ? `<small>${esc(meta)}</small>` : ''}</span><span class="source-open" aria-hidden="true">↗</span></button></div>`;
    }).join('')}</div></details>`;
}

/* 助手受控操作确认卡片：助手只提议，用户确认后才提交执行。
   执行结果走 /api/assistant/actions/execute（白名单 + 服务端校验 + 审计）。 */
function renderAssistantActionCard(bubble, action, account) {
  if (!bubble || !action || !action.type) return;
  const card = document.createElement('div');
  card.className = 'assistant-action-card';
  card.innerHTML = `<div class="assistant-action-copy"><b>建议操作</b><span>${esc(action.summary || '')}</span></div>
    <div class="assistant-action-buttons"><button type="button" data-action-confirm>确认执行</button><button type="button" data-action-dismiss>取消</button></div>`;
  const finish = html => { card.innerHTML = `<p class="assistant-action-result">${html}</p>`; };
  card.querySelector('[data-action-dismiss]').addEventListener('click', () => {
    finish('已取消，未执行任何操作。');
  });
  card.querySelector('[data-action-confirm]').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const response = await fetch('/api/assistant/actions/execute', {method:'POST',
        headers:{'Content-Type':'application/json', 'X-MailAI-Account':account?.id || ''},
        body:JSON.stringify({type:action.type, params:action.params || {}})});
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `执行失败（${response.status}）`);
      if (action.type === 'create_todo') finish(`已创建待办：${esc(result.title || '')}${result.deadline ? `（截止 ${esc(result.deadline)}）` : ''}`);
      else if (action.type === 'mark_read') finish(`已将 ${Number(result.marked) || 0} 封邮件标记为已读。`);
      else if (action.type === 'draft_reply') finish(`回复草稿已创建（收件人 ${esc(result.to_addr || '')}），可在草稿箱中继续编辑。`);
      else finish('操作已完成。');
    } catch (error) {
      finish(esc(error.message || '操作执行失败，请稍后重试。'));
    }
  });
  bubble.appendChild(card);
}
function assistantTableCells(value) {
  const source = String(value || '').trim();
  if (!source.includes('|')) return null;
  const cells = [''];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\' && source[index + 1] === '|') {
      cells[cells.length - 1] += '|'; index += 1;
    } else if (character === '|') cells.push('');
    else cells[cells.length - 1] += character;
  }
  if (source.startsWith('|')) cells.shift();
  let slashCount = 0;
  for (let index = source.length - 2; index >= 0 && source[index] === '\\'; index -= 1) slashCount += 1;
  if (source.endsWith('|') && slashCount % 2 === 0) cells.pop();
  const normalized = cells.map(cell => cell.trim());
  return normalized.length >= 2 ? normalized : null;
}
function assistantTableBlock(lines, start, inline) {
  const headers = assistantTableCells(lines[start]);
  const separators = assistantTableCells(lines[start + 1]);
  if (!headers || !separators || headers.length !== separators.length || headers.length > 12) return null;
  if (!separators.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))) return null;
  const alignments = separators.map(cell => {
    const compact = cell.replace(/\s/g, '');
    return compact.startsWith(':') && compact.endsWith(':') ? 'center' : compact.endsWith(':') ? 'right' : 'left';
  });
  const rows = [];
  let cursor = start + 2;
  while (cursor < lines.length && rows.length < 80) {
    if (!String(lines[cursor] || '').trim()) break;
    const cells = assistantTableCells(lines[cursor]);
    if (!cells) break;
    // Model-generated tables can contain an unescaped extra pipe. Preserve the
    // excess text in the last cell instead of silently dropping information.
    rows.push(headers.map((_, index) => index === headers.length - 1 ? cells.slice(index).join(' | ') : cells[index] || ''));
    cursor += 1;
  }
  const cell = (tag, value, index) => `<${tag} class="align-${alignments[index]}"${tag === 'th' ? ' scope="col"' : ''}>${inline(value)}</${tag}>`;
  const head = `<thead><tr>${headers.map((value, index) => cell('th', value, index)).join('')}</tr></thead>`;
  const body = rows.length ? `<tbody>${rows.map(row => `<tr>${row.map((value, index) => cell('td', value, index)).join('')}</tr>`).join('')}</tbody>` : '';
  return {html:`<div class="assistant-table-wrap" role="region" tabindex="0" aria-label="表格，可横向滚动"><table>${head}${body}</table></div>`, next:cursor};
}
function assistantAnswerHtml(text, sources = [], accountId = '') {
  const references = assistantSourceItems(sources);
  const inline = value => mdToHtml(String(value || '').trim())
    .replace(/^<p>|<\/p>$/g, '')
    .replace(/\[email_id:(\d+)\]/g, (match, id) => {
      const index = references.findIndex(source => Number(source.id) === Number(id));
      if (index < 0) return '（来源未核实）';
      const title = references[index].subject || '（无主题）';
      return `<button type="button" class="assistant-source-link" data-email-id="${Number(id)}" data-source-account="${esc(accountId)}" title="${esc(title)}" aria-label="查看参考邮件 ${index + 1}：${esc(title)}">${index + 1}</button>`;
    });
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let html = '', paragraph = [], listType = '', items = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html += `<p>${inline(paragraph.join(' '))}</p>`;
    paragraph = [];
  };
  const flushList = () => {
    if (!listType || !items.length) return;
    html += `<${listType}>${items.map(item => `<li>${inline(item.join(' '))}</li>`).join('')}</${listType}>`;
    listType = ''; items = [];
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex];
    const line = raw.trim();
    if (!line) { flushParagraph(); flushList(); continue; }
    const table = assistantTableBlock(lines, lineIndex, inline);
    if (table) {
      flushParagraph(); flushList(); html += table.html; lineIndex = table.next - 1; continue;
    }
    const heading = line.match(/^(?:#{1,4}\s*)?(?:\*\*)?(结论|建议动作|行动建议|分析理由|关键依据|需要确认|下一步|风险提示|处理顺序|优先级)[：:]?(?:\*\*)?\s*(.*)$/);
    if (heading) {
      flushParagraph(); flushList();
      html += `<h3>${inline(heading[1])}</h3>`;
      if (heading[2]) html += `<p>${inline(heading[2])}</p>`;
      continue;
    }
    const numbered = line.match(/^\d+[.、]\s*(.+)$/);
    const bullet = line.match(/^[-•]\s+(.+)$/);
    if (numbered || bullet) {
      flushParagraph();
      const nextType = numbered ? 'ol' : 'ul';
      if (listType && listType !== nextType) flushList();
      listType = nextType; items.push([numbered ? numbered[1] : bullet[1]]);
      continue;
    }
    if (listType && items.length) items[items.length - 1].push(line);
    else paragraph.push(line);
  }
  flushParagraph(); flushList();
  return `<div class="assistant-answer">${html}</div>`;
}
function setAssistantState(state) {
  const root = document.getElementById('mail-assistant');
  root.classList.remove('state-calm', 'state-thinking', 'state-warn', 'state-danger');
  root.classList.add(`state-${state}`);
}
function renderAssistantWelcome() {
  const wrap = document.getElementById('assistant-messages');
  wrap.replaceChildren(document.getElementById('assistant-welcome-template').content.cloneNode(true));
  wrap.classList.add('is-welcome');
}
function appendAssistantMessage(role, content, sources = []) {
  if (role === 'user') content = String(content || '').replace(/\n?（本次附图 \d+ 张；原图不存入历史，后续核对图片细节请重新上传。）/g, '');
  if (role !== 'user') content = String(content || '').replace(/\[email_id:(\d+)\]/g, (match, id) => sources.some(source => String(source.id) === id) ? match : '（来源未核实）');
  const wrap = document.getElementById('assistant-messages');
  wrap.querySelector('.assistant-welcome')?.remove();
  wrap.classList.remove('is-welcome');
  if (role !== 'user' && !String(content || '').trim()) content = '这次分析没有完整返回。你可以把刚才的问题再发一次，我会重新帮你查。';
  const el = document.createElement('div'); el.className = `assistant-message ${role === 'user' ? 'user' : 'bot'}`;
  const accountId = activeMailAccount()?.id || '';
  const sourceHtml = role !== 'user' ? assistantSourcesHtml(sources, accountId) : '';
  el.innerHTML = `<div class="assistant-bubble">${role === 'user' ? esc(content) : assistantAnswerHtml(content, sources, accountId)}${sourceHtml}</div>`;
  wrap.appendChild(el); wrap.scrollTop = wrap.scrollHeight; return el;
}
function assistantProgressHtml(title, detail = '') {
  return `<div class="assistant-progress" role="status" aria-live="polite"><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="assistant-progress-copy"><b>${esc(title)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</span></div>`;
}
function assistantStreamStatusCopy(event, emailIds) {
  const english = typeof currentI18nLanguage === 'function' && currentI18nLanguage() === 'en';
  if (event.state === 'searching' && emailIds?.length) {
    return [mailaiT('asst.readingMail') || '正在读取所选邮件…',
      (mailaiT('asst.readingMailDetail') || '共 {count} 封，正在准备上下文').replace('{count}', emailIds.length)];
  }
  return [english ? (event.message_en || event.message) : event.message,
    english ? (event.detail_en || event.detail) : event.detail];
}
let assistantCloseTimer = null;
let assistantOpenTimer = null;
let assistantPollTimer = null;
const ASSISTANT_LAYOUT_KEY = 'mailai-assistant-layout-v1';
const ASSISTANT_BREAKPOINT = 760;

function assistantDesktopLayout() {
  return window.innerWidth > ASSISTANT_BREAKPOINT;
}

function defaultAssistantLayout() {
  const margin = 16;
  const width = Math.min(420, window.innerWidth - margin * 2);
  const height = Math.min(690, window.innerHeight - margin * 2);
  return {x: window.innerWidth - width - 26, y: window.innerHeight - height - 24, width, height};
}

function clampAssistantLayout(layout) {
  const margin = 8;
  const minWidth = Math.min(340, window.innerWidth - margin * 2);
  const minHeight = Math.min(430, window.innerHeight - margin * 2);
  const width = Math.min(Math.max(Number(layout.width) || 420, minWidth), window.innerWidth - margin * 2);
  const height = Math.min(Math.max(Number(layout.height) || 690, minHeight), window.innerHeight - margin * 2);
  const x = Math.min(Math.max(Number(layout.x) || margin, margin), window.innerWidth - width - margin);
  const y = Math.min(Math.max(Number(layout.y) || margin, margin), window.innerHeight - height - margin);
  return {x, y, width, height};
}

function readAssistantLayout() {
  try { return clampAssistantLayout({...defaultAssistantLayout(), ...JSON.parse(localStorage.getItem(ASSISTANT_LAYOUT_KEY) || '{}')}); }
  catch (_) { return clampAssistantLayout(defaultAssistantLayout()); }
}

function applyAssistantLayout(layout, persist = false) {
  const panel = document.getElementById('assistant-panel');
  if (!assistantDesktopLayout()) {
    panel.style.removeProperty('left'); panel.style.removeProperty('top');
    panel.style.removeProperty('right'); panel.style.removeProperty('bottom');
    panel.style.removeProperty('width'); panel.style.removeProperty('height');
    return layout;
  }
  const value = clampAssistantLayout(layout);
  panel.style.left = `${value.x}px`; panel.style.top = `${value.y}px`;
  panel.style.right = 'auto'; panel.style.bottom = 'auto';
  panel.style.width = `${value.width}px`; panel.style.height = `${value.height}px`;
  if (persist) localStorage.setItem(ASSISTANT_LAYOUT_KEY, JSON.stringify(value));
  return value;
}

function initAssistantLayout() {
  const panel = document.getElementById('assistant-panel');
  const header = panel.querySelector('.assistant-head');
  const resizeHandle = document.getElementById('assistant-resize-handle');
  let layout = readAssistantLayout();
  applyAssistantLayout(layout);

  const startInteraction = (event, mode) => {
    if (!assistantDesktopLayout() || !document.body.classList.contains('assistant-floating') || event.button !== 0) return;
    if (mode === 'move' && event.target.closest('button, details')) return;
    event.preventDefault();
    const start = {...readAssistantLayout(), pointerX: event.clientX, pointerY: event.clientY};
    const target = mode === 'move' ? header : resizeHandle;
    target.setPointerCapture(event.pointerId);
    panel.classList.add('layout-stable', mode === 'move' ? 'is-moving' : 'is-resizing');
    document.body.classList.add('assistant-adjusting');
    const move = moveEvent => {
      const dx = moveEvent.clientX - start.pointerX, dy = moveEvent.clientY - start.pointerY;
      layout = mode === 'move'
        ? applyAssistantLayout({...start, x: start.x + dx, y: start.y + dy})
        : applyAssistantLayout({...start, width: start.width + dx, height: start.height + dy});
    };
    const finish = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', finish); target.removeEventListener('pointercancel', finish);
      panel.classList.remove('is-moving', 'is-resizing'); document.body.classList.remove('assistant-adjusting');
      layout = applyAssistantLayout(layout, true);
    };
    const finishOnce = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', finishOnce); document.removeEventListener('pointercancel', finishOnce);
      finish();
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', finishOnce); document.addEventListener('pointercancel', finishOnce);
  };
  header.addEventListener('pointerdown', event => startInteraction(event, 'move'));
  resizeHandle.addEventListener('pointerdown', event => startInteraction(event, 'resize'));
  header.addEventListener('dblclick', event => {
    if (event.target.closest('button') || !assistantDesktopLayout()) return;
    localStorage.removeItem(ASSISTANT_LAYOUT_KEY); layout = applyAssistantLayout(defaultAssistantLayout());
  });
  window.addEventListener('resize', () => { layout = applyAssistantLayout(readAssistantLayout()); });
}

function openAssistant() {
  const panel = document.getElementById('assistant-panel');
  clearTimeout(assistantCloseTimer);
  clearTimeout(assistantOpenTimer);
  applyAssistantLayout(readAssistantLayout());
  panel.classList.remove('hidden', 'closing', 'layout-stable'); document.getElementById('assistant-nudge').classList.add('hidden');
  assistantOpenTimer = setTimeout(() => panel.classList.add('layout-stable'), 320);
  document.body.classList.add('assistant-visible');
  window.mailOnboarding?.refreshAssistant();
  if (!assistantHistoryLoaded) restoreLatestAssistantConversation();
  document.getElementById('assistant-input').focus();
}
async function markAssistantAlertsSeen() {
  const accountId = activeMailAccount()?.id;
  const ids = (assistantAlerts?.new_items || []).map(item => item.id);
  if (!ids.length) return;
  ++assistantAlertRevision;
  try {
    await api('/api/assistant/alerts/seen', {accountId, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ids})});
    if (accountId === activeMailAccount()?.id) await loadAssistantAlerts();
  } catch (_) {
    if (accountId === activeMailAccount()?.id) toast('提醒未能标记为已查看，请重试', 'warn');
  }
}
function closeAssistant() {
  document.body.classList.remove('assistant-visible');
  document.getElementById('assistant-orb')?.setAttribute('aria-expanded', 'false');
  const panel = document.getElementById('assistant-panel');
  if (panel.classList.contains('hidden') || panel.classList.contains('closing')) return;
  clearTimeout(assistantOpenTimer);
  panel.classList.remove('layout-stable');
  panel.classList.add('closing');
  clearTimeout(assistantCloseTimer);
  assistantCloseTimer = setTimeout(() => {
    if (!panel.classList.contains('closing')) return;
    panel.classList.add('hidden');
    panel.classList.remove('closing');
  }, 280);
}
function resetAssistantConversation({focus = true} = {}) {
  window.assistantAttachments?.clear(); assistantLastAttachments=[];
  window.assistantImages?.clear(); assistantLastImages = [];
  if (focus) window.showSecretaryChat?.();
  assistantController?.abort(); assistantController = null; ++assistantRevision;
  assistantLastQuestion = ''; assistantLastScope = null; assistantLastAlertContext = false;
  setAssistantState(assistantNotificationState(assistantAlerts));
  document.getElementById('assistant-stop').classList.add('hidden');
  document.getElementById('assistant-retry').classList.add('hidden');
  document.getElementById('assistant-send').disabled = false;
  assistantConversationId = null; assistantHistory = []; assistantHistoryLoaded = true;
  assistantAlertContextIds = [];
  renderAssistantWelcome();
  document.getElementById('assistant-history-panel').classList.add('hidden');
  if (focus) document.getElementById('assistant-input').focus();
}
async function loadAssistantConversation(id) {
  assistantController?.abort(); assistantController = null;
  assistantLastQuestion = ''; assistantLastScope = null; assistantLastAlertContext = false;
  setAssistantState(assistantNotificationState(assistantAlerts));
  document.getElementById('assistant-send').disabled = false;
  document.getElementById('assistant-stop').classList.add('hidden');
  document.getElementById('assistant-retry').classList.add('hidden');
  window.assistantAttachments?.clear(); assistantLastAttachments=[];
  window.assistantImages?.clear(); assistantLastImages = [];
  const revision = ++assistantRevision;
  const data = await api(`/api/assistant/conversations/${id}`);
  if (revision !== assistantRevision) return;
  assistantConversationId = Number(id); assistantHistory = [];
  const wrap = document.getElementById('assistant-messages'); wrap.innerHTML = '';
  (data.messages || []).forEach(message => {
    const element = appendAssistantMessage(message.role, message.content, message.sources || []);
    if (message.images?.length) window.assistantImages?.showSent(element, message.images);
    assistantHistory.push({role:message.role, content:message.content});
  });
  if (!data.messages?.length) resetAssistantConversation();
  assistantAlertContextIds = data.alert_email_ids || [];
  reconcileAssistantRiskAnalysis(data.pending_alert_ids);
  document.getElementById('assistant-history-panel').classList.add('hidden'); assistantHistoryLoaded = true;
}
async function restoreLatestAssistantConversation() {
  const revision = assistantRevision;
  assistantHistoryLoaded = true;
  try { const list = await api('/api/assistant/conversations?limit=1'); if (list.length && revision === assistantRevision) await loadAssistantConversation(list[0].id); }
  catch (_) {}
}
async function showAssistantHistory() {
  window.showSecretaryChat?.();
  const panel = document.getElementById('assistant-history-panel'); panel.classList.remove('hidden');
  const listEl = document.getElementById('assistant-history-list'); listEl.innerHTML = '<div class="assistant-history-empty">正在加载…</div>';
  try {
    const items = await api('/api/assistant/conversations?limit=50');
    listEl.innerHTML = items.length ? items.map(item => `<button type="button" class="assistant-history-item ${item.id === assistantConversationId ? 'active' : ''}" data-conversation-id="${item.id}"><span>${esc(item.title)}</span><small>${fmtDate(item.updated_at)} · ${item.message_count} 条消息</small></button>`).join('') : '<div class="assistant-history-empty">还没有历史对话</div>';
  } catch (e) { listEl.innerHTML = `<div class="assistant-history-empty">加载失败：${esc(e.message)}</div>`; }
}

function assistantQuestionReferencesOpenEmail(value) {
  const question = String(value || '').toLowerCase().replace(/[\s，。！？?!、；;：:]/g, '');
  if (!question) return false;
  return /(?:这|此|本|当前|正在(?:阅读|查看|看|打开)|刚刚?(?:阅读|查看|看|打开))(?:的)?(?:一封|封|个)?(?:电子)?邮件/.test(question)
    || /(?:这|此|本)(?:一)?封信/.test(question)
    || /^(?:它|这封|本封)(?:说|讲|写|提到|要求|主要|内容|重点|风险)/.test(question)
    || /(?:this|current|open)email/.test(question);
}

function assistantQuestionReferencesEmailImage(value) {
  const question = String(value || '').toLowerCase();
  return /截图|截屏|图片|图中|图里|看图|读图|识图|图像|图表|表格|image|screenshot|table/.test(question);
}

function assistantImageDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('邮件内嵌图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

function assistantImageMetrics(dataUrl) {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve({data_url:dataUrl, area:image.naturalWidth * image.naturalHeight});
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

async function currentEmailInlineImages(emailId, accountId) {
  const email = selectedEmailDetail?.id === emailId ? selectedEmailDetail : null;
  if (!email?.body_html) return [];
  const documentBody = new DOMParser().parseFromString(email.body_html, 'text/html');
  const localPrefix = `/api/emails/${encodeURIComponent(emailId)}/inline/`;
  const sources = [...new Set([...documentBody.querySelectorAll('img[src]')].map(node => node.getAttribute('src') || '').filter(Boolean))];
  const candidates = [];
  for (const source of sources) {
    if (/^data:image\/(png|jpeg|webp);base64,/i.test(source)) {
      candidates.push(source);
      continue;
    }
    let url;
    try { url = new URL(source, location.origin); } catch (_) { continue; }
    // Never retrieve remote image URLs from a mail body. Only MIME resources
    // already stored with this exact email may be handed to the configured model.
    if (url.origin !== location.origin || !url.pathname.startsWith(localPrefix)) continue;
    try {
      const response = await fetch(mailboxResourceUrl(url.pathname, accountId), {headers:accountId ? {'X-MailAI-Account':accountId} : {}});
      const blob = await response.blob();
      if (!response.ok || blob.size > 5 * 1024 * 1024 || !/^image\/(png|jpeg|webp)$/i.test(blob.type)) continue;
      candidates.push(await assistantImageDataUrl(blob));
    } catch (_) { /* A broken inline image should not block the email conversation. */ }
  }
  const measured = (await Promise.all(candidates.slice(0, 8).map(assistantImageMetrics))).filter(Boolean);
  // Ignore tracking pixels and signature dots; retain the largest useful images.
  return measured.filter(item => item.area >= 12_000).sort((left, right) => right.area - left.area).slice(0, 3).map(item => ({data_url:item.data_url}));
}

async function askAssistant(question, explicitIds = null, images = [], attachments = [], alertContext = false, options = {}) {
  if (!(_systemConfig?.model?.available && _systemConfig?.model?.verified)) { window.mailOnboarding?.openModel(); return; }
  if(attachments.length && !String(question || '').trim())question='请结合所选附件与邮件正文，总结重点和待确认事项。';
  if(images.length && !String(question || '').trim())question='请提炼这些图片的重点，区分明确事实、待确认信息和建议下一步。';
  question = String(question || '').trim(); if (!question || assistantController) return;
  window.showSecretaryChat?.();
  const account = activeMailAccount();
  if(attachments.length)explicitIds=[...new Set(attachments.map(r=>r.email_id))];
  let mode = document.getElementById('assistant-scope').value;
  if (explicitIds?.length) {
    assistantPinnedScope = [...explicitIds];
    mode = document.getElementById('assistant-scope').value = 'selected';
  }
  let emailIds = explicitIds || assistantPinnedScope;
  // Natural references such as “这封邮件” mean the message in the reading pane,
  // even when the scope picker was left at its default “当前邮箱”.  Pin the id so
  // follow-up questions stay on the same message and cannot fall back to a noisy
  // whole-mailbox keyword search.
  if (!emailIds && selectedEmailId && assistantQuestionReferencesOpenEmail(question)) {
    assistantPinnedScope = [selectedEmailId];
    emailIds = [...assistantPinnedScope];
    mode = document.getElementById('assistant-scope').value = 'selected';
  }
  if (!emailIds && mode === 'selected') {
    if (!selectedEmailId) return toast('请先选择一封邮件', 'warn');
    emailIds = [selectedEmailId];
  } else if (!emailIds && mode === 'filtered') {
    emailIds = [...document.querySelectorAll('#email-list .email-item')].filter(node => !node.dataset.accountId || node.dataset.accountId === account?.id).map(node => Number(node.dataset.id));
  }
  if(images.length && !emailIds) emailIds=[];
  let inlineImageCount = 0;
  if (!images.length && emailIds?.length === 1 && assistantQuestionReferencesEmailImage(question)) {
    const emailImages = await currentEmailInlineImages(emailIds[0], account?.id || '');
    if (emailImages.length) { images = emailImages; inlineImageCount = images.length; }
  }
  const imageScope = inlineImageCount ? `邮件内嵌图片 ${inlineImageCount} 张 · ` : images.length ? `${images.length} 张图片 · ` : '';
  const scope = `${account?.user || '当前邮箱'} · ${attachments.length ? attachments.length+' 个附件 · ' : ''}${imageScope}${emailIds ? (emailIds.length ? '所选范围 ' + emailIds.length + ' 封' : '未附邮件') : '全部已同步邮件'}`;
  const scopeKey = JSON.stringify([account?.id, mode, emailIds]);
  if (assistantScopeKey && assistantScopeKey !== scopeKey) resetAssistantConversation();
  assistantScopeKey = scopeKey; assistantLastQuestion = question;
  assistantAlertContextIds = alertContext ? [...(emailIds || [])] : [];
  assistantLastAlertContext = alertContext;
  assistantLastScope = emailIds;
  assistantLastImages = images;
  assistantLastAttachments=attachments;
  if(attachments.length)window.assistantAttachments?.clear();
  if(images.length)window.assistantImages?.clear();
  if (typeof updateAssistantScopeControl === 'function') updateAssistantScopeControl();
  const revision = ++assistantRevision;
  const controller = new AbortController(); assistantController = controller;
  const historyQuestion=question+(inlineImageCount?'\n（本次已传入当前邮件的内嵌图片 '+inlineImageCount+' 张，仅用于本次识图，后续核对请重新选择邮件图片。）':'')+(attachments.length?'\n（本次参考附件：'+attachments.map((r,i)=>`${i+1}. ${r.name}`).join('；')+'。历史不存附件正文，后续核对请重新选择。）':'');
  const retrying = Boolean(options.retry);
  const userMessage = retrying ? null : appendAssistantMessage('user', historyQuestion);
  if(images.length && userMessage)window.assistantImages?.showSent(userMessage,images);
  if (!retrying) assistantHistory.push({role:'user', content:historyQuestion});
  const thinking = appendAssistantMessage('assistant', '');
  const bubble = thinking.querySelector('.assistant-bubble');
  bubble.classList.add('assistant-progress-bubble');
  const initialProgress = attachments.length
    ? [mailaiT('asst.readingAttachments') || '正在读取所选附件…', (mailaiT('asst.readingAttachmentsDetail') || '{count} 个附件，完成后将结合邮件分析').replace('{count}', attachments.length)]
    : inlineImageCount
      ? [mailaiT('asst.readingInlineImages') || '正在读取邮件内嵌图片…', (mailaiT('asst.readingImagesDetail') || '{count} 张图片，正在准备分析内容').replace('{count}', inlineImageCount)]
      : images.length
        ? [mailaiT('asst.readingImages') || '正在读取图片…', (mailaiT('asst.readingImagesDetail') || '{count} 张图片，正在准备分析内容').replace('{count}', images.length)]
        : emailIds?.length
          ? [mailaiT('asst.readingMail') || '正在读取所选邮件…', (mailaiT('asst.readingMailDetail') || '共 {count} 封，正在准备上下文').replace('{count}', emailIds.length)]
          : [mailaiT('asst.understanding') || '正在理解你的问题…', mailaiT('asst.understandingDetail') || '将在当前邮箱范围内查找所需信息'];
  bubble.innerHTML = assistantProgressHtml(...initialProgress);
  document.getElementById('assistant-scope-note').textContent = scope;
  document.getElementById('assistant-stop').classList.remove('hidden');
  document.getElementById('assistant-retry').classList.add('hidden');
  setAssistantState('thinking'); document.getElementById('assistant-send').disabled = true;
  document.getElementById('mail-assistant').dataset.answerComplete = 'false';
  let answer = '', sources = [], completed = false, pendingAction = null;
  let paintTimer = null;
  const streamDeadline = setTimeout(() => controller.abort(), 360000);
  const validAnswer = () => answer.replace(/\[email_id:(\d+)\]/g, (match, id) => sources.some(s => String(s.id) === id) ? match : '（来源未核实）');
  const paint = () => {
    bubble.classList.remove('assistant-progress-bubble');
    bubble.innerHTML = assistantAnswerHtml(validAnswer(), sources, account?.id || '');
    const wrap = document.getElementById('assistant-messages');
    if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 160) wrap.scrollTop = wrap.scrollHeight;
  };
  try {
    const response = await fetch('/api/assistant/ask-stream', {method:'POST', signal:controller.signal,
      headers:{'Content-Type':'application/json', 'X-MailAI-Account':account?.id || ''},
      body:JSON.stringify({question, history:assistantHistory.slice(0, -1).slice(-6), conversation_id:assistantConversationId, email_ids:emailIds, scope_label:scope, images, attachments, alert_context:alertContext})});
    if (!response.ok || !response.body) {const detail=await response.json().catch(()=>({}));throw new Error(typeof detail.detail==='string'?detail.detail:`请求未完成（${response.status}），请检查图片格式、大小和模型连接`);}
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let pending = '';
    const consumeLine = line => {
      if (!line.trim() || revision !== assistantRevision) return;
      const event = JSON.parse(line);
      if (event.type === 'meta') assistantConversationId = event.conversation_id;
      else if (event.type === 'sources') {
        sources = event.sources || [];
        if (sources.length) document.getElementById('assistant-scope-note').textContent = (mailaiT('asst.runScope') || '{scope} · 本次分析 {count} 封（每次最多 20 封）').replace('{scope}', scope).replace('{count}', sources.length);
      } else if (event.type === 'delta') {
        const firstDelta = !answer.trim();
        answer += event.content || '';
        if (answer.length > 100000) throw new Error('回复过长，请缩小范围后分批分析');
        // Rebuilding the entire Markdown/table DOM for every token can monopolize
        // the UI thread. Batch tokens, but always paint the final answer below.
        if (firstDelta) paint();
        else if (!paintTimer) paintTimer = setTimeout(() => {
          paintTimer = null;
          if (revision === assistantRevision) paint();
        }, 120);
      }
      else if (event.type === 'status') {
        if (!answer.trim()) {
          const [statusTitle, statusDetail] = assistantStreamStatusCopy(event, emailIds);
          bubble.classList.add('assistant-progress-bubble');
          bubble.innerHTML = assistantProgressHtml(statusTitle || '正在分析…', statusDetail || '');
        }
      }
      else if (event.type === 'done') completed = true;
      else if (event.type === 'action') pendingAction = event.action || null;
      else if (event.type === 'error') throw new Error(event.message || '分析中断');
    };
    while (true) {
      const {value, done} = await reader.read();
      if (revision !== assistantRevision) { await reader.cancel(); return; }
      pending += decoder.decode(value || new Uint8Array(), {stream:!done});
      if (pending.length > 2 * 1024 * 1024) throw new Error('响应数据异常，请重试');
      const lines = pending.split('\n'); pending = lines.pop() || '';
      lines.forEach(consumeLine);
      if (done) break;
    }
    if (pending.trim()) consumeLine(pending);
    if (!answer.trim() || !completed) throw new Error('分析未完成');
    window.mailOnboarding?.answered();
    document.getElementById('mail-assistant').dataset.answerComplete = 'true';
    paint();
    bubble.insertAdjacentHTML('beforeend', assistantSourcesHtml(sources, account?.id || ''));
    if (pendingAction) renderAssistantActionCard(bubble, pendingAction, account);
    assistantHistory.push({role:'assistant', content:validAnswer()});
  } catch (error) {
    if (revision !== assistantRevision) return;
    paint();
    bubble.insertAdjacentHTML('beforeend', assistantSourcesHtml(sources, account?.id || ''));
    bubble.insertAdjacentHTML('beforeend', `<p class="operation-note">${controller.signal.aborted ? '已停止，已生成内容保留。' : esc(error.message || '分析中断，已生成内容保留。可以重试。')}</p>`);
    document.getElementById('assistant-retry').classList.remove('hidden');
  } finally {
    clearTimeout(paintTimer);
    clearTimeout(streamDeadline);
    controller.abort();
    if (assistantController === controller) assistantController = null;
    if (revision === assistantRevision) {
      document.getElementById('assistant-send').disabled = false;
      document.getElementById('assistant-stop').classList.add('hidden');
      setAssistantState(assistantNotificationState(assistantAlerts));
    }
  }
}
let assistantAlertRevision = 0;
const assistantMailNoticeCursor = new Map();
let assistantNudgeTimer = null;
function reconcileAssistantRiskAnalysis(pendingIds) {
  if (!Array.isArray(pendingIds) || !assistantAlertContextIds.length) return;
  const pending = new Set(pendingIds.map(Number));
  if (assistantAlertContextIds.some(id => pending.has(Number(id)))) return;
  const wrap = document.getElementById('assistant-messages');
  const history = document.createElement('details');
  history.className = 'assistant-resolved-analysis';
  const title = document.createElement('summary');
  title.textContent = '相关邮件已处理 · 查看历史分析';
  history.appendChild(title);
  while (wrap.firstChild) history.appendChild(wrap.firstChild);
  resetAssistantConversation({focus:false});
  assistantPinnedScope = null; assistantScopeKey = '';
  document.getElementById('assistant-scope').value = 'account';
  if (typeof updateAssistantScopeControl === 'function') updateAssistantScopeControl();
  wrap.querySelector('.assistant-welcome')?.remove();
  wrap.classList.remove('is-welcome');
  wrap.appendChild(history);
}

function showAssistantNudge(text) {
  clearTimeout(assistantNudgeTimer);
  const nudge = document.getElementById('assistant-nudge');
  nudge.textContent = text; nudge.classList.remove('hidden');
  assistantNudgeTimer = setTimeout(() => nudge.classList.add('hidden'), 7000);
}
function assistantNotificationState(data) {
  return Number(data?.new_risk_count) > 0 && ['warn', 'danger'].includes(data?.alert_level) ? data.alert_level : 'calm';
}
async function loadAssistantAlerts() {
  const revision = ++assistantAlertRevision;
  try {
    const accountId = activeMailAccount()?.id;
    const data = await api('/api/assistant/alerts', {accountId});
    if (revision !== assistantAlertRevision || accountId !== activeMailAccount()?.id) return;
    assistantAlerts = data; if (!assistantController) setAssistantState(assistantNotificationState(data));
    reconcileAssistantRiskAnalysis(data.pending_risk_ids);
    const previousMail = assistantMailNoticeCursor.get(accountId);
    const incoming = previousMail === undefined ? [] : (data.recent_mail_items || []).filter(item => Number(item.id) > previousMail);
    assistantMailNoticeCursor.set(accountId, Math.max(previousMail || 0, Number(data.latest_mail_id || 0)));
    const count = data.new_risk_count || 0;
    const highCount = data.new_high_risk_count || 0;
    const suspiciousCount = data.new_suspicious_count || 0;
    const alertText = highCount && suspiciousCount
      ? `${count} 封新增需关注邮件（${highCount} 封高风险）`
      : highCount ? `${highCount} 封新增高风险邮件` : `${suspiciousCount} 封新增可疑邮件`;
    const badge = document.getElementById('assistant-badge'); badge.textContent = count > 99 ? '99+' : count; badge.title = count ? alertText : ''; badge.classList.toggle('hidden', !count);
    const strip = document.getElementById('assistant-alert-strip');
    clearTimeout(assistantAlertTimer);
    if (count) {
      strip.className = `assistant-alert-strip ${data.alert_level || 'warn'}`;
      strip.innerHTML = `<b>${alertText}</b><button type="button" data-analyze-alert>查看原因</button><button type="button" data-dismiss-alert aria-label="标记这些提醒为已查看">已查看</button>`;
      strip.classList.remove('hidden');
      const key = JSON.stringify([accountId, data.new_items]);
      if (assistantNoticeKey !== key) {
        assistantNoticeKey = key;
        showAssistantNudge(alertText);
      }
    } else {
      strip.classList.add('hidden');
      if (assistantNoticeKey) {
        clearTimeout(assistantNudgeTimer);
        document.getElementById('assistant-nudge').classList.add('hidden');
      }
      assistantNoticeKey = '';
      if (incoming.length) showAssistantNudge(`收到 ${incoming.length} 封新邮件`);
    }
  } catch (_) {}
}

function analyzeNewAssistantAlerts() {
  if (assistantController) return;
  const items = assistantAlerts?.new_items || [];
  if (!items.length) {
    loadAssistantAlerts();
    return;
  }
  const refs = items.map((item, index) => {
    const subject = item.subject || '（无主题）';
    const sender = item.from_name || item.from_addr || '未知发件人';
    const received = item.date ? fmtDate(item.date) : '时间未知';
    const risk = getRiskLabel(Number(item.score || 0), item.verdict, item).text;
    const rawSummary = String(item.summary || '').replace(/\s+/g, ' ').trim();
    const summary = rawSummary.length > 60 ? rawSummary.slice(0, 60) + '…' : rawSummary;
    return `${index + 1}. 《${subject}》｜${sender}｜${received}｜${risk}${summary ? `｜${summary}` : ''}`;
  }).join('\n');
  resetAssistantConversation();
  askAssistant(`请只分析这次提醒的新增邮件（共 ${items.length} 封）：\n${refs}\n请按上面的 1、2、3 等当次编号分别说明风险等级、触发原因和建议动作，不要带入其他历史邮件或待办。`, items.map(item => item.id), [], [], true);
  markAssistantAlertsSeen();
}
async function goToAssistantEmail(emailId) {
  closeAssistant();
  await revealEmailFromSource(emailId);
}

function syncSelectedEmailVisual(id, {emphasize = false, scroll = false, accountId = ''} = {}) {
  const items = document.querySelectorAll('.email-item');
  items.forEach(item => {
    const current = Number(item.dataset.id) === Number(id) && (!accountId || item.dataset.accountId === accountId);
    item.classList.toggle('selected', current);
    if (current) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  });
  const target = accountId
    ? document.querySelector(`.email-item[data-id="${id}"][data-account-id="${CSS.escape(accountId)}"]`)
    : document.querySelector(`.email-item[data-id="${id}"]`);
  if (!target) return null;
  if (scroll) target.scrollIntoView({behavior:'smooth', block:'center'});
  if (emphasize) {
    clearTimeout(sourceFocusTimer);
    target.classList.remove('source-focus');
    void target.offsetWidth;
    target.classList.add('source-focus');
    sourceFocusTimer = setTimeout(() => target.classList.remove('source-focus'), 1800);
  }
  return target;
}

function resetReadingPane() {
  readingLoadRevision += 1;
  readingLoadController?.abort();
  readingLoadController = null;
  selectedEmailId = null;
  selectedEmailAccountId = '';
  selectedEmailDetail = null;
  removeSecurityFlyout();
  syncSelectedEmailVisual(null);
  const pane = document.querySelector('.reading-pane');
  const empty = document.getElementById('reading-empty');
  const content = document.getElementById('reading-content');
  pane?.classList.remove('show');
  empty?.classList.remove('hidden');
  if (content) {
    content.classList.add('hidden');
    content.replaceChildren();
  }
}

function reconcileReadingPane(emails) {
  if (selectedEmailId === null) return;
  const stillVisible = emails.some(item => Number(item.id) === Number(selectedEmailId) && (!selectedEmailAccountId || item._account_id === selectedEmailAccountId));
  if (stillVisible) syncSelectedEmailVisual(selectedEmailId, {accountId:selectedEmailAccountId});
  else resetReadingPane();
}

async function revealEmailFromSource(emailId) {
  if (!Number.isFinite(Number(emailId))) return;
  let target = document.querySelector(`.email-item[data-id="${emailId}"]`);
  if (!target) {
    const requiresReload = Boolean(currentServerFolder) || currentFilter.days !== 9999 || !allEmails.some(item => item.id === Number(emailId));
    specialMailbox = '';
    currentServerFolder = '';
    currentFilter.status = '';
    currentFilter.verdict = '';
    currentFilter.category = '';
    currentFilter.priority = '';
    currentFilter.domain = '';
    currentFilter.search = '';
    currentFilter.attachments = false;
    currentFilter.days = 9999;
    searchResults = null;
    document.getElementById('global-search').value = '';
    setSegmentedFilter('filter-days', '9999');
    setSegmentedFilter('filter-priority', '');
    document.getElementById('filter-domain').value = '';
    document.getElementById('filter-attachments').checked = false;
  currentFilter.unread = false; document.getElementById('filter-unread').checked = false;
    updateActiveNav();
    if (requiresReload) await loadData();
    else applyFilters();
  }
  await selectEmail(Number(emailId), {emphasize:true, scroll:true});
  target = document.querySelector(`.email-item[data-id="${emailId}"]`);
  toast(target ? '已定位到来源邮件' : '来源邮件已打开', 'success');
}

function draftPayload() {
  return {
    id: currentDraftId,
    source_draft_email_id: composeContext.source_draft_email_id || null,
    to_addr: normalizeRecipientText(document.getElementById('compose-to').value),
    cc_addr: normalizeRecipientText(document.getElementById('compose-cc').value),
    bcc_addr: normalizeRecipientText(document.getElementById('compose-bcc').value),
    subject: document.getElementById('compose-subject').value.trim(),
    body_html: composeBodyHtml(),
    attachments: composeAttachments,
    mode: composeContext.mode,
    reply_to_email_id: composeContext.reply_to_email_id,
    in_reply_to: composeContext.in_reply_to,
    references: composeContext.references,
  };
}

function composeMessageElement() {
  return document.getElementById('compose-message');
}

function composeMessageText() {
  return composeMessageElement().innerText.trim();
}

function composeBodyHtml() {
  const message = composeMessageElement().innerHTML.trim();
  const signature = document.getElementById('compose-signature-content').innerHTML.trim();
  const quote = document.getElementById('compose-quote-content').innerHTML.trim();
  const sections = [message];
  if (signature) sections.push(`<div data-mailai-signature="${esc(currentSignatureId)}" style="margin-top:22px">${signature}</div>`);
  if (quote) sections.push(`<div data-mailai-quote="true" style="margin-top:18px;border-left:2px solid #cfd9d4;padding:4px 0 4px 16px;color:#6f7f78">${quote}</div>`);
  return sections.filter(Boolean).join('<br><br>');
}

function renderSignatureSelect() {
  const select = document.getElementById('compose-signature-select');
  if (!select) return;
  select.innerHTML = '<option value="">不使用签名</option>' + signatureState.items.map(item => `<option value="${esc(item.id)}">${esc(item.name)}${item.id === signatureState.default_id ? '（默认）' : ''}</option>`).join('');
  select.value = currentSignatureId && signatureState.items.some(item => item.id === currentSignatureId) ? currentSignatureId : '';
}

function renderComposeSignature(signatureId, fallbackHtml = '') {
  currentSignatureId = signatureId || '';
  const item = signatureState.items.find(row => row.id === currentSignatureId);
  const html = item?.html || fallbackHtml || '';
  const host = document.getElementById('compose-signature');
  document.getElementById('compose-signature-content').innerHTML = html;
  host.classList.toggle('hidden', !html);
  renderSignatureSelect();
}

async function loadSignatures() {
  const accountId = document.body.classList.contains('compose-open') ? composeAccountId : activeMailAccount()?.id;
  const state = await api('/api/mail/signatures', {accountId});
  if (accountId !== (document.body.classList.contains('compose-open') ? composeAccountId : activeMailAccount()?.id)) return state;
  signatureState = state;
  renderSignatureSelect();
  return signatureState;
}

function stripTrailingBreaks(host) {
  while (host.lastChild && (host.lastChild.nodeName === 'BR' || (!host.lastChild.textContent.trim() && host.lastChild.nodeType === Node.TEXT_NODE))) host.lastChild.remove();
}

function hydrateComposeBody(seed) {
  const message = composeMessageElement();
  const quoteHost = document.getElementById('compose-quote');
  const quoteContent = document.getElementById('compose-quote-content');
  let messageHtml = seed.message_html;
  let quoteHtml = seed.quote_html || '';
  let signatureHtml = '';
  let signatureId = seed.signature_id || '';
  if (messageHtml === undefined) {
    const parsed = document.createElement('div');
    parsed.innerHTML = seed.body_html || '';
    const storedSignature = parsed.querySelector('[data-mailai-signature=""], [data-mailai-signature]');
    if (storedSignature) {
      signatureHtml = storedSignature.innerHTML;
      signatureId = storedSignature.getAttribute('data-mailai-signature') || '';
      storedSignature.remove();
    }
    let storedQuote = parsed.querySelector('[data-mailai-quote="true"], [data-compose-section="quote"]');
    if (!storedQuote && composeContext.mode !== 'compose') {
      storedQuote = [...parsed.querySelectorAll('div')].find(node => (node.getAttribute('style') || '').includes('border-left')) || null;
    }
    if (storedQuote) {
      quoteHtml = storedQuote.innerHTML;
      storedQuote.remove();
      stripTrailingBreaks(parsed);
    }
    messageHtml = parsed.innerHTML;
  }
  message.innerHTML = messageHtml || '';
  if (!signatureId && !signatureHtml && !seed.id) signatureId = signatureState.default_id || '';
  renderComposeSignature(signatureId, signatureHtml);
  quoteContent.innerHTML = quoteHtml;
  if (!composeContext.original_text && quoteHtml) composeContext.original_text = quoteContent.innerText.trim();
  quoteHost.classList.toggle('hidden', !quoteHtml);
  quoteHost.classList.remove('collapsed');
  document.getElementById('compose-quote-toggle').setAttribute('aria-expanded', 'true');
  const labels = {reply:'引用的原邮件', reply_all:'引用的原邮件', forward:'转发的原邮件'};
  document.getElementById('compose-quote-label').textContent = labels[composeContext.mode] || '引用的原邮件';
}

async function openCompose(seed = {}) {
  if (document.body.classList.contains('compose-open')) {
    if (!await closeCompose()) return;
  }
  closeAssistant();
  hideContactSuggestions();
  composeAccountId = seed.account_id || activeMailAccount()?.id || '';
  draftSession = {id: seed.id || null, accountId:composeAccountId, pending: Promise.resolve(), canceled: false, busy: false};
  currentDraftId = seed.id || null;
  signatureState = {items:[], default_id:''};
  composeContext = {source_draft_email_id:seed.source_draft_email_id || null, mode: seed.mode || 'compose', reply_to_email_id: seed.reply_to_email_id || null, in_reply_to: seed.in_reply_to || '', references: seed.references || '', original_text: seed.original_text || ''};
  const titles = {reply: '回复邮件', reply_all: '回复全部', forward: '转发邮件', compose: '写邮件'};
  document.getElementById('compose-title').textContent = titles[composeContext.mode] || '写邮件';
  document.getElementById('compose-to').value = seed.to_addr || '';
  document.getElementById('compose-cc').value = seed.cc_addr || '';
  document.getElementById('compose-bcc').value = seed.bcc_addr || '';
  document.querySelector('.compose-extra-recipients').open = Boolean(seed.cc_addr || seed.bcc_addr);
  document.getElementById('compose-subject').value = seed.subject || '';
  hydrateComposeBody(seed);
  composeAttachments = Array.isArray(seed.attachments) ? seed.attachments : [];
  clearComposePreflight();
  renderComposeAttachments();
  draftSession.initialEdit = draftEditingFingerprint();
  draftSession.savedFingerprint = seed.id ? draftFingerprint(draftPayload()) : null;
  setDraftStatus(draftSession, seed.id ? 'saved' : 'idle');
  renderComposeAccountPicker(seed.account_id || activeMailAccount()?.id || '');
  const send = document.getElementById('btn-send-mail');
  send.disabled = !sendCapability.configured;
  send.textContent = sendCapability.configured ? '发送' : (sendCapability.identity_matched === false && sendCapability.smtp_configured ? '发送（发件账号不匹配）' : '发送（当前邮箱未配置）');
  send.title = sendCapability.reason || '发送邮件';
  document.getElementById('compose-modal').classList.remove('hidden');
  document.body.classList.add('compose-open');
  const session = draftSession;
  send.disabled = true;
  api('/api/mail/send-capability', {accountId:composeAccountId}).then(capability => {
    if (session !== draftSession) return;
    sendCapability = capability; send.disabled = !capability.configured;
    send.textContent = capability.configured ? '发送' : '发送（当前邮箱未配置）'; send.title = capability.reason || '发送邮件';
  }).catch(error => { if (session === draftSession) { send.disabled = true; send.title = error.message; } });
  loadSignatures().then(state => {
    if (session === draftSession && !seed.id && !currentSignatureId) renderComposeSignature(state.default_id || '');
  }).catch(() => {});
  try { document.execCommand('styleWithCSS', false, true); } catch (_) {}
  resetComposeAiPanel();
  (composeContext.mode === 'forward' ? document.getElementById('compose-to') : composeMessageElement()).focus();
}

function rememberComposeSelection() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (composeMessageElement().contains(range.commonAncestorContainer)) savedComposeRange = range.cloneRange();
}

function restoreComposeSelection() {
  const body = composeMessageElement();
  body.focus();
  if (!savedComposeRange || !body.contains(savedComposeRange.commonAncestorContainer)) return;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(savedComposeRange);
}

function normalizeComposeLink(value) {
  const link = String(value || '').trim();
  if (!link) return '';
  if (/^(https?:|mailto:)/i.test(link)) return link;
  return `https://${link}`;
}

function runComposeCommand(command, value = null) {
  restoreComposeSelection();
  if (command === 'createLink') {
    value = normalizeComposeLink(window.prompt('请输入网页或邮箱地址', 'https://'));
    if (!value) return;
    restoreComposeSelection();
  }
  document.execCommand(command, false, value);
  rememberComposeSelection();
  queueDraftSave();
  refreshComposeAiContext();
}

async function insertComposeImage(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/i.test(file.type)) return toast('支持 PNG、JPEG、GIF 或 WebP 图片', 'warn');
  if (file.size > 5 * 1024 * 1024) return toast('单张正文图片不能超过 5MB', 'warn');
  const session = draftSession;
  const accountId = composeAccountId;
  if (session.busy || session.canceled) return;
  session.attachmentReads = (session.attachmentReads || 0) + 1;
  try {
    const src = `data:${file.type};base64,${await readFileAsBase64(file)}`;
    if (session !== draftSession || accountId !== composeAccountId || session.canceled || session.attachmentsClosed) return;
    restoreComposeSelection();
    document.execCommand('insertHTML', false, `<img src="${src}" alt="${esc(file.name)}" style="display:block;max-width:100%;height:auto;margin:12px 0;border-radius:8px">`);
    rememberComposeSelection(); clearComposePreflight(); queueDraftSave();
  } catch (error) {
    if (session === draftSession) toast('正文图片读取失败，请重试', 'error');
  } finally { session.attachmentReads -= 1; }

}

function openComposePreview() {
  document.getElementById('compose-preview-to').textContent = document.getElementById('compose-to').value.trim() || '（尚未填写）';
  document.getElementById('compose-preview-subject').textContent = document.getElementById('compose-subject').value.trim() || '（无主题）';
  document.getElementById('compose-preview-frame').srcdoc = richEmailDocument(composeBodyHtml() || '<p style="color:#8b9892">正文为空</p>', true);
  document.getElementById('compose-preview-modal').classList.remove('hidden');
}

function closeComposePreview() {
  document.getElementById('compose-preview-modal').classList.add('hidden');
  document.getElementById('compose-preview-frame').srcdoc = '';
}

function signatureProfileFromForm() {
  const fields = ['name','title','department','company','phone','email','website'];
  return Object.fromEntries(fields.map(key => [key, document.getElementById(`signature-profile-${key}`).value.trim()]));
}

function fillSignatureProfile(profile = {}) {
  for (const key of ['name','title','department','company','phone','email','website']) document.getElementById(`signature-profile-${key}`).value = profile[key] || '';
}

function editSignature(signatureId = '') {
  editingSignatureId = signatureId;
  const item = signatureState.items.find(row => row.id === signatureId);
  document.getElementById('signature-name').value = item?.name || '';
  document.getElementById('signature-editor').innerHTML = item?.html || '';
  document.getElementById('signature-make-default').checked = Boolean(signatureId && signatureId === signatureState.default_id);
  document.getElementById('btn-delete-signature').disabled = !item;
  document.querySelectorAll('[data-signature-id]').forEach(button => button.classList.toggle('active', button.dataset.signatureId === signatureId));
}

function renderSignatureManager() {
  fillSignatureProfile(signatureState.profile || {});
  document.getElementById('signature-list').innerHTML = signatureState.items.length ? signatureState.items.map(item => `<button type="button" data-signature-id="${esc(item.id)}"><span>${esc(item.name)}</span>${item.id === signatureState.default_id ? '<small>默认</small>' : ''}</button>`).join('') : '<p>还没有签名<br><small>新建一套或让 AI 帮你生成</small></p>';
  document.getElementById('btn-ai-generate-signature').disabled = !signatureState.ai_available;
  document.getElementById('btn-ai-generate-signature').title = signatureState.ai_available ? '根据发件人资料生成签名' : '请先在系统中心配置 AI 模型';
  editSignature(editingSignatureId && signatureState.items.some(item => item.id === editingSignatureId) ? editingSignatureId : (signatureState.items[0]?.id || ''));
}

async function openSignatureManager() {
  try { await loadSignatures(); } catch (err) { return toast('加载签名失败：' + err.message, 'error'); }
  renderSignatureManager();
  document.getElementById('signature-ai-options').classList.add('hidden');
  document.getElementById('signature-manager').classList.remove('hidden');
}

function closeSignatureManager() { document.getElementById('signature-manager').classList.add('hidden'); }

async function saveSignature() {
  const name = document.getElementById('signature-name').value.trim();
  const html = document.getElementById('signature-editor').innerHTML.trim();
  if (!name || !document.getElementById('signature-editor').innerText.trim()) return toast('请填写签名名称和内容', 'warn');
  signatureState = await api('/api/mail/signatures', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:editingSignatureId,name,html,profile:signatureProfileFromForm(),make_default:document.getElementById('signature-make-default').checked})});
  const saved = signatureState.items.find(item => item.name === name && item.html === html) || signatureState.items.at(-1);
  editingSignatureId = saved?.id || editingSignatureId;
  renderSignatureManager(); renderSignatureSelect();
  if (currentSignatureId === editingSignatureId || (!currentSignatureId && document.getElementById('signature-make-default').checked)) renderComposeSignature(editingSignatureId);
  queueDraftSave(); toast('签名已保存', 'success');
}

async function generateSignatures(button) {
  const profile = signatureProfileFromForm();
  if (!profile.name && !profile.email) return toast('请至少填写姓名或邮箱', 'warn');
  setLoading(button, true, 'AI 生成中…');
  try {
    const result = await api('/api/mail/signatures/generate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile,style:document.getElementById('signature-ai-style').value})});
    const host = document.getElementById('signature-ai-options');
    host.innerHTML = result.options.map((item, index) => `<button type="button" data-ai-signature="${index}"><b>${esc(item.name)}</b><span>${item.html}</span><small>使用这套</small></button>`).join('');
    host._options = result.options;
    host.classList.remove('hidden');
  } catch (err) { toast('AI 签名生成失败：' + err.message, 'error'); }
  finally { setLoading(button, false); }
}

function quoteOriginal(e, mode) {
  if (mode === 'forward') {
    return `<div style="font-size:13px;line-height:1.65"><b>---------- 转发邮件 ----------</b><br>发件人：${esc(e.from_addr || '')}<br>发送时间：${esc(fmtDate(e.date))}<br>收件人：${esc(e.to_addr || '')}<br>主题：${esc(e.subject || '')}</div><div style="margin-top:14px">${mdToHtml(e.body_text || '')}</div>`;
  }
  return `<div style="font-size:13px;line-height:1.65">在 ${esc(fmtDate(e.date))}，${esc(e.from_addr || '')} 写道：</div><div style="margin-top:12px">${mdToHtml(e.body_text || '')}</div>`;
}

async function composeFromEmail(mode) {
  const e = selectedEmailDetail;
  if (!e) return;
  if (e._account_id && e._account_id !== activeMailAccount()?.id) {
    try { await activateMailAccount(e._account_id, {keepMailbox:true, quiet:true}); }
    catch (err) { toast('无法使用该邮件所属账号回复：' + err.message, 'error'); return; }
  }
  const replySubject = /^(re|回复)\s*:/i.test(e.subject || '') ? e.subject : `Re: ${e.subject || ''}`;
  const forwardSubject = /^(fw|fwd|转发)\s*:/i.test(e.subject || '') ? e.subject : `Fwd: ${e.subject || ''}`;
  let recipients = {to_addr: '', cc_addr: ''};
  if (mode !== 'forward') {
    try { recipients = await api(`/api/emails/${e.id}/reply-recipients?reply_all=${mode === 'reply_all'}`); }
    catch (err) { toast('无法准备回复：' + err.message, 'error'); return; }
  }
  openCompose({mode, ...recipients, subject: mode === 'forward' ? forwardSubject : replySubject,
    message_html: '', quote_html: quoteOriginal(e, mode), reply_to_email_id: e.id, in_reply_to: e.message_id || '',
    references: [e.references_header, e.message_id].filter(Boolean).join(' '), original_text: e.body_text || '', account_id:e._account_id || activeMailAccount()?.id});
}

function hideCompose() {
  draftSession.attachmentsClosed = true;
  ++composeAiRevision;
  hideContactSuggestions();
  closeComposePreview();
  closeSignatureManager();
  document.getElementById('compose-modal').classList.add('hidden');
  document.body.classList.remove('compose-open', 'compose-ai-active');
  toggleComposeAiPanel(false);
  clearComposePreflight();
}

async function closeCompose() {
  const session = draftSession;
  if (session.busy || session.closing || session.switching) return false;
  if (session.attachmentReads) { toast('附件正在读取，请稍候再关闭', 'warn'); return false; }
  session.closing = true;
  try {
    await saveCurrentDraft();
    if (session !== draftSession) return false;
    // Typing can continue while disk I/O is pending. Never close over a newer edit.
    if (draftNeedsSave(session)) { toast('还有新修改，请稍后再关闭', 'warn'); return false; }
    hideCompose();
    refreshDraftList(session.accountId || composeAccountId).catch(() => {});
    return true;
  } catch (error) {
    toast('草稿未保存，写信窗口已保留。请重试：' + error.message, 'error');
    return false;
  } finally { session.closing = false; }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function localDateKey(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function renderComposeAttachments() {
  const host = document.getElementById('compose-attachments');
  host.classList.toggle('hidden', !composeAttachments.length);
  host.innerHTML = composeAttachments.map((item, index) => `<span class="compose-attachment-chip"><svg viewBox="0 0 20 20"><path d="M7.2 10.7 12 5.9a2.5 2.5 0 0 1 3.5 3.5l-6.3 6.3a4 4 0 0 1-5.7-5.7l6-6"/></svg><button type="button" class="compose-attachment-open" data-preview-compose-attachment="${index}" title="预览附件"><b>${esc(item.filename)}</b><small>${formatFileSize(item.size || 0)} · 预览</small></button><button type="button" data-remove-attachment="${index}" aria-label="移除 ${esc(item.filename)}">×</button></span>`).join('');
  refreshComposeAiContext();
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addComposeAttachments(files) {
  const session = draftSession;
  const accountId = composeAccountId;
  const selected = [...files];
  const reserved = selected.reduce((sum, file) => sum + file.size, 0);
  const total = composeAttachments.reduce((sum, item) => sum + (item.size || 0), 0) + (session.attachmentBytes || 0) + reserved;
  if (session.busy || session.canceled) return;
  if (selected.some(file => file.size > 20 * 1024 * 1024) || total > 25 * 1024 * 1024) {
    return toast('单个附件不能超过 20MB，总大小不能超过 25MB', 'warn');
  }
  session.attachmentBytes = (session.attachmentBytes || 0) + reserved;
  session.attachmentReads = (session.attachmentReads || 0) + 1;
  const current = () => session === draftSession && accountId === composeAccountId && !session.canceled && !session.attachmentsClosed;
  try {
    const batch = [];
    for (const file of selected) {
      const data = await readFileAsBase64(file);
      if (!current()) return;
      const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
      if (bytes.length !== file.size) throw new Error('附件读取不完整');
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if (!current()) return;
      batch.push({sha256, filename:file.name, content_type:file.type || 'application/octet-stream', size:file.size, data_base64:data});
    }
    if (!current()) return;
    composeAttachments.push(...batch);
    clearComposePreflight(); renderComposeAttachments(); queueDraftSave();
  } catch (error) {
    if (current()) toast('附件读取失败，请重新选择文件', 'error');
  } finally {
    session.attachmentBytes -= reserved;
    session.attachmentReads -= 1;
  }
}

function draftFingerprint(payload) {
  const {id, ...content} = payload;
  // Attachment data is immutable after insertion; don't serialize up to 25 MB
  // of base64 on every keystroke just to detect an editor change.
  content.attachments = (payload.attachments || []).map(item => [item.sha256 || '', item.filename, item.size, item.content_type, item.data_base64?.length]);
  return JSON.stringify(content);
}

function draftEditingFingerprint() {
  return JSON.stringify(['compose-to','compose-cc','compose-bcc','compose-subject'].map(id => document.getElementById(id).value.trim())
    .concat([composeMessageElement().innerHTML, draftFingerprint({attachments:composeAttachments})]));
}

function draftHasContent(payload) {
  const content = document.createElement('div');
  content.innerHTML = payload.body_html || '';
  content.querySelectorAll('[data-mailai-signature], [data-mailai-quote], [data-compose-section="quote"]').forEach(node => node.remove());
  return Boolean(payload.to_addr || payload.cc_addr || payload.bcc_addr || payload.subject || payload.attachments?.length ||
    content.textContent.replace(/[\s\u200b]/g, '') || content.querySelector('img,table,hr'));
}

function draftNeedsSave(session = draftSession, payload = draftPayload(), force = false) {
  if (session.canceled) return false;
  if (!session.id && !session.queued && (!draftHasContent(payload) || (!force && draftEditingFingerprint() === session.initialEdit))) return false;
  const fingerprint = draftFingerprint(payload);
  return fingerprint !== session.savedFingerprint || Boolean(session.queued && fingerprint !== session.latestQueuedFingerprint);
}

function setDraftStatus(session, state) {
  if (session !== draftSession) return;
  const status = document.getElementById('draft-state');
  const labels = {idle:'草稿自动保存', pending:'草稿自动保存', saving:'正在保存…', saved:'已存至本地草稿', error:'保存失败 · 点击重试'};
  status.textContent = labels[state];
  status.dataset.state = state;
  status.disabled = state !== 'error';
  status.title = state === 'error' ? '内容仍在当前窗口，请重试保存' : '草稿仅保存在本机，不会同步到邮箱服务器';
}

function clearDraftSaveTimers() {
  clearTimeout(draftSaveTimer); draftSaveTimer = null;
  clearTimeout(draftMaxSaveTimer); draftMaxSaveTimer = null;
}

async function refreshDraftList(accountId) {
  if (activeMailAccount()?.id !== accountId) return;
  const revision = ++draftListRevision;
  const rows = await api('/api/drafts', {accountId});
  if (activeMailAccount()?.id !== accountId || revision !== draftListRevision) return;
  savedDrafts = rows; updateSidebar();
  if (specialMailbox === 'drafts') applyFilters();
}

async function saveCurrentDraft({force = false} = {}) {
  clearDraftSaveTimers();
  const session = draftSession;
  const accountId = session.accountId || composeAccountId;
  if (session.canceled || session.busy) return;
  const currentPayload = draftPayload();
  const fingerprint = draftFingerprint(currentPayload);
  if (!draftNeedsSave(session, currentPayload, force) && !session.queued) {
    await session.pending.catch(() => {});
    setDraftStatus(session, session.id ? 'saved' : 'idle');
    return;
  }
  const payload = JSON.parse(JSON.stringify(currentPayload));
  session.queued = (session.queued || 0) + 1;
  session.latestQueuedFingerprint = fingerprint;
  session.pending = session.pending.catch(() => {}).then(async () => {
    if (session.canceled) return;
    if (fingerprint === session.savedFingerprint) return;
    const indicator = setTimeout(() => setDraftStatus(session, 'saving'), 800);
    payload.id = session.id;
    session.saving = true;
    try {
      const isNew = !session.id;
      const result = await api('/api/drafts', {accountId, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
      session.id = result.id;
      session.savedFingerprint = fingerprint;
      if (session !== draftSession) return;
      currentDraftId = result.id;
      ++draftListRevision;
      if (activeMailAccount()?.id === accountId) {
        const row = {...payload, id:result.id, updated_at:new Date().toISOString()};
        const index = savedDrafts.findIndex(item => item.id === result.id);
        if (index === -1) savedDrafts = [row, ...savedDrafts];
        else savedDrafts = savedDrafts.map(item => item.id === result.id ? {...item, ...row} : item);
        if (isNew) updateSidebar();
      }
      setDraftStatus(session, draftNeedsSave(session) ? 'pending' : 'saved');
      // Keep the cached draft current without rebuilding the mailbox while typing.
    } catch (error) {
      setDraftStatus(session, 'error');
      throw error;
    } finally { clearTimeout(indicator); session.saving = false; }
  }).finally(() => { session.queued -= 1; });
  return session.pending;
}

function queueDraftSave() {
  if (draftSession.canceled || draftSession.busy || draftSession.switching) return;
  if (!draftNeedsSave()) {
    clearDraftSaveTimers();
    setDraftStatus(draftSession, draftSession.id ? 'saved' : 'idle');
    return;
  }
  clearTimeout(draftSaveTimer);
  if (document.getElementById('draft-state').dataset.state !== 'error') setDraftStatus(draftSession, 'pending');
  const save = () => saveCurrentDraft().catch(() => {}); // Persistent retry status, no repeated toast.
  draftSaveTimer = setTimeout(save, 3000);
  if (!draftMaxSaveTimer) draftMaxSaveTimer = setTimeout(save, 15000);
}

function composeRecipientContext() {
  const rows = [
    ['收件人', document.getElementById('compose-to').value.trim()],
    ['抄送', document.getElementById('compose-cc').value.trim()],
    ['密送', document.getElementById('compose-bcc').value.trim()],
  ].filter(([, value]) => value);
  return rows.map(([label, value]) => `${label}：${value}`).join('\n');
}

function composeAiAvailability() {
  return {
    subject: document.getElementById('compose-subject').value.trim(),
    recipients: composeRecipientContext(),
    original: composeContext.original_text.trim(),
    body: composeMessageText(),
    attachments: composeAttachments.map(item => item.filename).filter(Boolean),
  };
}

function refreshComposeAiContext() {
  const panel = document.getElementById('compose-ai-panel');
  if (!panel) return;
  const values = composeAiAvailability();
  const bodyLabel = ['reply','reply_all'].includes(composeContext.mode) ? '已有回复' : (composeContext.mode === 'forward' ? '转发说明' : '已有正文');
  const labels = {subject:'主题', recipients:'收件人', original:'原邮件', body:bodyLabel, attachments:'附件名称'};
  const selected = [];
  panel.querySelectorAll('.compose-ai-context-options input').forEach(input => {
    const available = Array.isArray(values[input.value]) ? values[input.value].length > 0 : Boolean(values[input.value]);
    input.disabled = !available;
    input.closest('label').classList.toggle('unavailable', !available);
    if (available && input.checked) selected.push(labels[input.value]);
  });
  const explicit = document.getElementById('compose-ai-instruction').value.trim();
  document.getElementById('compose-ai-basis').textContent = selected.length ? `将参考：${selected.join('、')}` : (explicit ? '仅依据你的写作要求' : '请填写写作要求或邮件内容');
  const scene = ['reply','reply_all'].includes(composeContext.mode) ? '回复' : (composeContext.mode === 'forward' ? '转发说明' : '正文');
  document.getElementById('compose-ai-scene-title').textContent = scene === '回复' ? '一起写好这封回复' : (scene === '转发说明' ? '一起补充清楚转发说明' : '告诉我这封邮件想达到什么目的');
  document.getElementById('btn-ai-generate').textContent = scene === '回复' ? '生成回复草稿' : (scene === '转发说明' ? '生成转发说明' : '生成邮件草稿');
  document.getElementById('btn-ai-append').textContent = `追加到${scene}`;
  document.getElementById('btn-ai-replace').textContent = `替换${scene}`;
  composeMessageElement().dataset.placeholder = scene === '回复' ? '在这里输入回复内容…' : (scene === '转发说明' ? '在这里输入转发说明…' : '输入邮件正文…');
}

function resetComposeAiPanel() {
  ++composeAiRevision;
  document.querySelectorAll('#btn-ai-generate, #btn-ai-regenerate, [data-ai-compose]').forEach(button => setLoading(button, false));
  composeAiSuggestion = '';
  document.getElementById('compose-ai-instruction').value = '';
  document.getElementById('compose-ai-tone').value = '正式';
  document.getElementById('compose-ai-length').value = '适中';
  document.querySelectorAll('.compose-ai-context-options input').forEach(input => { input.checked = true; });
  document.getElementById('compose-ai-output').textContent = '';
  document.getElementById('compose-ai-status').textContent = '与邮箱守护助手是同一个 AI；草稿只进入预览，不会直接覆盖正文。';
  document.getElementById('compose-ai-panel').classList.remove('is-thinking', 'has-result');
  document.getElementById('compose-ai-preview').classList.add('hidden');
  toggleComposeAiPanel(false);
  refreshComposeAiContext();
}

function toggleComposeAiPanel(force) {
  const panel = document.getElementById('compose-ai-panel');
  const trigger = document.getElementById('btn-compose-ai');
  if (!panel || !trigger) return;
  const open = typeof force === 'boolean' ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  document.body.classList.toggle('compose-ai-active', open);
  trigger.classList.toggle('active', open);
  trigger.setAttribute('aria-expanded', String(open));
  if (!open && panel.contains(document.activeElement)) trigger.focus({preventScroll:true});
  if (open) {
    refreshComposeAiContext();
    const scrollHost = panel.querySelector('.compose-ai-scroll');
    if (scrollHost) scrollHost.scrollTop = 0;
    setTimeout(() => {
      if (scrollHost) scrollHost.scrollTop = 0;
      document.getElementById('compose-ai-instruction').focus({preventScroll:true});
    }, 0);
  }
}

async function aiCompose(operation, button) {
  const session = draftSession;
  const revision = ++composeAiRevision;
  const current = () => session === draftSession && revision === composeAiRevision && !session.canceled && document.body.classList.contains('compose-open');
  const body = composeMessageElement();
  const quickRewrite = ['polish','shorten','translate_en'].includes(operation);
  if (quickRewrite && !body.innerText.trim()) return toast('请先填写需要改写的正文', 'warn');
  const selected = new Set([...document.querySelectorAll('.compose-ai-context-options input:checked:not(:disabled)')].map(input => input.value));
  const values = composeAiAvailability();
  setLoading(button, true, '生成中…');
  const panel = document.getElementById('compose-ai-panel');
  panel.classList.add('is-thinking'); panel.classList.remove('has-result');
  document.getElementById('compose-ai-status').textContent = '我正在结合你勾选的邮件上下文组织内容…';
  try {
    const result = await api('/api/mail/compose/assist', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      operation,
      user_instruction: document.getElementById('compose-ai-instruction').value.trim(),
      subject: selected.has('subject') ? values.subject : '',
      recipients: selected.has('recipients') ? values.recipients : '',
      original_text: selected.has('original') ? values.original : '',
      body_text: quickRewrite || selected.has('body') ? values.body : '',
      attachment_names: selected.has('attachments') ? values.attachments : [],
      tone: document.getElementById('compose-ai-tone').value,
      length: document.getElementById('compose-ai-length').value,
    })});
    if (!current()) return;
    composeAiSuggestion = result.content;
    document.getElementById('compose-ai-output').innerHTML = String(result.content || '').split(/\n{2,}/).filter(Boolean).map(block => `<p>${esc(block).replace(/\n/g, '<br>')}</p>`).join('');
    document.getElementById('compose-ai-preview-basis').textContent = `依据：${(result.basis || []).join('、')}`;
    document.getElementById('compose-ai-preview').classList.remove('hidden');
    panel.classList.add('has-result');
    document.getElementById('compose-ai-status').textContent = '草稿已准备好。请核对事实后，再追加或替换正文。';
    document.getElementById('compose-ai-preview').scrollIntoView({block:'nearest', behavior:'smooth'});
    toast('AI 草稿已生成，请预览后决定如何使用', 'success');
  } catch (err) {
    if (!current()) return;
    document.getElementById('compose-ai-status').textContent = '这次没有生成成功，可以调整要求后重试。';
    toast('AI 写作失败：' + err.message, 'error');
  }
  finally { if (current()) { panel.classList.remove('is-thinking'); setLoading(button, false); } }
}

function applyComposeAiSuggestion(mode) {
  if (!composeAiSuggestion) return;
  const body = composeMessageElement();
  const html = esc(composeAiSuggestion).replace(/\n/g, '<br>');
  body.innerHTML = mode === 'append' && body.innerText.trim() ? `${body.innerHTML}<br><br>${html}` : html;
  queueDraftSave(); refreshComposeAiContext();
  const target = ['reply','reply_all'].includes(composeContext.mode) ? '回复' : (composeContext.mode === 'forward' ? '转发说明' : '正文');
  toast(mode === 'append' ? `AI 草稿已追加到${target}` : `AI 草稿已替换${target}，请核对后发送`, 'success');
  body.focus();
}

async function runMailPreflight(payload) {
  const session = draftSession;
  const accountId = composeAccountId;
  const fingerprint = composePreflightFingerprint(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let result;
  try {
  result = await api('/api/mail/preflight', {accountId, signal:controller.signal, method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    to_addr:payload.to_addr,cc_addr:payload.cc_addr,bcc_addr:payload.bcc_addr,subject:payload.subject,
    body_text:composeMessageText(),attachment_count:composeAttachments.length,
    attachment_names:composeAttachments.map(item => item.filename || item.name || ''),mode:composeContext.mode,
    reply_to_email_id:composeContext.reply_to_email_id,original_text:composeContext.original_text || ''
  })});
  } catch (error) {
    if (controller.signal.aborted) throw new Error('安全检查超时，邮件尚未发送，请稍后重试');
    throw error;
  } finally { clearTimeout(timer); }
  if (session !== draftSession || session.canceled || accountId !== composeAccountId ||
      !document.body.classList.contains('compose-open') || composePreflightFingerprint() !== fingerprint) {
    throw new Error('检查期间邮件或发件账号发生了变化，请重新检查后发送');
  }
  if (result.recipients) {
    ['to_addr','cc_addr','bcc_addr'].forEach(key => {
      payload[key] = result.recipients[key] || '';
      document.getElementById(`compose-${key.replace('_addr','').replace('_','-')}`).value = payload[key];
    });
  }
  const host = document.getElementById('compose-preflight');
  host.classList.toggle('hidden', !result.issues.length);
  host.innerHTML = result.issues.length ? `<button type="button" class="preflight-backdrop" data-preflight-edit aria-label="返回修改邮件"></button><section class="preflight-dialog" role="dialog" aria-modal="true" aria-labelledby="preflight-dialog-title">
  <header class="preflight-summary"><span class="preflight-heading"><small>发送前安全确认</small><strong id="preflight-dialog-title">${esc(result.summary || '发送前检查')}</strong><em>${result.ai_reviewed ? '已结合本地规则与 AI 语义审查' : '已完成本地安全检查'}</em></span><button type="button" data-preflight-edit aria-label="关闭安全确认">×</button></header>
  <div class="preflight-list">` + result.issues.map(item => `<div class="preflight-item ${item.level}">
    <span class="preflight-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 3.2l7 12.3H3z"/><path d="M10 7.2v4.2M10 14.1h.01"/></svg></span>
    <span><b>${esc(item.message)}</b>${item.reason ? `<small>${esc(item.reason)}</small>` : ''}</span><em>${esc(item.source || '发送检查')}</em>
  </div>`).join('') + `</div><footer class="preflight-decision">
    <label><input id="compose-preflight-ack" type="checkbox"><span><b>我已逐项核对以上风险</b><small>确认收件人、正文、附件和原邮件均符合预期</small></span></label>
    <div><button type="button" data-preflight-edit>返回修改</button><button type="button" class="preflight-confirm-send" data-preflight-send disabled>确认发送</button></div>
  </footer></section>` : '';
  if (result.issues.length) toggleComposeAiPanel(false);
  composePreflightPending = result.issues.length ? {payload: {...payload}, fingerprint: composePreflightFingerprint(payload)} : null;
  return result;
}

function composePreflightFingerprint(payload = draftPayload()) {
  return JSON.stringify({
    account_id:composeAccountId,
    to_addr:payload.to_addr, cc_addr:payload.cc_addr, bcc_addr:payload.bcc_addr,
    subject:payload.subject, body_html:payload.body_html, mode:payload.mode,
    reply_to_email_id:payload.reply_to_email_id,
    attachments:(payload.attachments || []).map(item => [item.filename || item.name || '', item.size || 0, item.data_base64 || '']),
  });
}

function clearComposePreflight() {
  composePreflightPending = null;
  const host = document.getElementById('compose-preflight');
  if (!host) return;
  host.innerHTML = '';
  host.classList.add('hidden');
}

// ===== 拉取进度轮询 =====
function startFetchMonitor() {
  if (_fetchPollTimer) return;
  let inFlight = false;
  const accountId = activeMailAccount()?.id;
  showFetchOverlay();
  const timer = _fetchPollTimer = setInterval(async () => {
    if (inFlight) return;
    if (accountId !== activeMailAccount()?.id) { stopFetchMonitor(); return; }
    inFlight = true;
    const controller = _fetchPollController = new AbortController();
    try {
      const st = await api('/api/fetch_status', {accountId, signal:controller.signal});
      if (_fetchPollTimer !== timer || accountId !== activeMailAccount()?.id) return;
      mergeAccountSyncState(accountId, st);
      updateFetchOverlay(st);
      if (!st.running) {
        stopFetchMonitor();
        await loadData();
        if (st.canceled) {
          toast(st.message || '已中断拉取', 'warn');
        } else if (st.error) {
          toast(st.message || '拉取失败', 'error');
        } else {
          toast(st.message || '拉取完成', 'success');
          if ('Notification' in window && Notification.permission === 'granted' && (st.processed || 0) > 0) {
            try { new Notification('MailAI 同步完成', {body:`已完成 ${st.processed} 封邮件的同步与分析`, tag:'mailai-sync'}); } catch (_) {}
          }
        }
      }
    } catch (e) {
      // 忽略轮询中的网络抖动
    } finally {
      inFlight = false;
      if (_fetchPollController === controller) _fetchPollController = null;
    }
  }, 1200);
}

function stopFetchMonitor() {
  _fetchPollController?.abort();
  _fetchPollController = null;
  if (_fetchPollTimer) {
    clearInterval(_fetchPollTimer);
    _fetchPollTimer = null;
  }
  ['btn-poll', 'btn-fetch-more', 'btn-fetch-all'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) setLoading(btn, false);
  });
  hideFetchOverlay();
}

function showFetchOverlay() {
  const overlay = document.getElementById('fetch-overlay');
  overlay.classList.remove('hidden', 'canceled');
  setFetchSettingsContext(!document.getElementById('system-view').classList.contains('hidden'));
  updateFetchOverlay({ running: true, message: '准备中...', total: 0, processed: 0 });
}

function hideFetchOverlay() {
  const overlay = document.getElementById('fetch-overlay');
  overlay.classList.add('hidden');
  overlay.classList.remove('expanded');
}

function setFetchSettingsContext(active) {
  const overlay = document.getElementById('fetch-overlay');
  const toggle = document.getElementById('btn-toggle-fetch');
  overlay.classList.toggle('settings-context', !!active);
  if (!active) overlay.classList.remove('expanded');
  const expanded = active && overlay.classList.contains('expanded');
  toggle?.setAttribute('aria-expanded', String(expanded));
  toggle?.setAttribute('aria-label', expanded ? '收起同步详情' : '展开同步详情');
  if (toggle) toggle.title = expanded ? '收起同步详情' : '展开同步详情';
}

function updateFetchOverlay(st) {
  const opNames = { poll: '拉取新邮件', fetch_more: '加载更多历史邮件', fetch_all: '拉取全部邮件', sync_folders:'同步其他文件夹', sync_folder:'同步文件夹' };
  const phaseNames = {scanning:'扫描邮箱',analyzing:'解析与 AI 分析',finalizing:'正在收尾',completed:'同步完成',paused:'同步已暂停'};
  document.getElementById('fetch-title').textContent = st.canceled ? '已中断' : `${opNames[st.operation] || '邮件同步'} · ${phaseNames[st.phase] || '准备中'}`;
  document.getElementById('fetch-message').textContent = st.message || '请稍候...';
  const pct = st.total > 0 ? Math.round((st.processed || 0) / st.total * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('fetch-count').textContent = st.total > 0
    ? `${st.processed || 0} / ${st.total} 封`
    : '';
  const cancelBtn = document.getElementById('btn-cancel-fetch');
  if (cancelBtn) cancelBtn.disabled = !!st.canceled;
  const overlay = document.getElementById('fetch-overlay');
  if (st.canceled) overlay.classList.add('canceled');
  else overlay.classList.remove('canceled');
}

// ===== Markdown 渲染 =====
function mdToHtml(text) {
  if (!text) return '';
  let html = esc(text);
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/https?:\/\/[^\s<>"'，。；）)]+/g, url =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br/>');
  return `<p>${html}</p>`;
}

// 日报专用渲染：把 [email_id:123] 转成可点击链接
function renderDigest(text) {
  text = String(text || '').replace(/\[\s*⚠️?\s*过期\s*\]/g, '%%OVERDUE%%');
  let html = mdToHtml(text);
  html = html.replace(
    /\[email_id:(\d+)\]/g,
    '<a class="digest-email-link" data-email-id="$1" href="#" title="查看来源邮件"><svg viewBox="0 0 20 20"><path d="M3.5 5.5h13v9h-13zM4 6l6 5 6-5"/></svg>查看来源</a>'
  );
  const overdueIcon = '<span class="digest-status-icon warn"><svg viewBox="0 0 20 20"><path d="M10 3 17 16H3L10 3ZM10 8v3M10 14h.01"/></svg></span>';
  html = html.replace(/%%OVERDUE%%/g, overdueIcon + '过期').replace(/⚠️?/g, overdueIcon);
  return html;
}

function setDigestTitle(label) {
  document.getElementById('digest-title').innerHTML = `<span class="digest-title-icon"><svg viewBox="0 0 20 20"><path d="M5 3.5h10v13H5zM7.5 7h5M7.5 10h5M7.5 13h3"/></svg></span><span>${esc(label)}</span>`;
}


let _digestSelectedEmailId = null;

async function openDigestEmailDrawer(emailId) {
  _digestSelectedEmailId = emailId;
  document.getElementById('digest-email-drawer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.getElementById('digest-email-body').innerHTML = '<div class="reading-loading">加载邮件详情…</div>';
  try {
    const e = await api('/api/emails/' + emailId);
    document.getElementById('digest-email-body').innerHTML = renderDigestEmailDetail(e);
    if (e.has_rich_body && e.body_html) mountDigestRichEmailBody(e);
  } catch (err) {
    document.getElementById('digest-email-body').innerHTML = `<div class="reading-error">加载失败：${esc(err.message)}</div>`;
  }
}

function closeDigestEmailDrawer() {
  const drawer = document.getElementById('digest-email-drawer');
  if (drawer.classList.contains('closing')) return;
  drawer.classList.add('closing');
  setTimeout(() => {
    drawer.classList.add('hidden');
    drawer.classList.remove('closing');
    document.body.style.overflow = '';
    _digestSelectedEmailId = null;
  }, 200);
}

function renderDigestEmailDetail(e) {
  const parseArr = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  };
  e.findings = parseArr(e.findings);
  e.attachments = parseArr(e.attachments);
  const risk = getRiskLabel(e.score, e.verdict, e);
  const findings = renderFindings(e.findings);
  return `
    <div class="drawer-email-header">
      <h2 class="reading-subject">${esc(e.subject)}</h2>
      <div class="reading-meta">
        <div class="meta-avatar">${(e.from_name || e.from_addr || '?').charAt(0).toUpperCase()}</div>
        <div class="meta-fields">
          <div class="drawer-meta-row"><span class="meta-label">${mailaiT('read.fromShort') || '发件人'}</span>${renderSenderContact(e.from_name, e.from_addr)}</div>
          <div class="drawer-meta-row meta-recipient-row"><span class="meta-label">${mailaiT('read.toShort') || '收件人'}</span>${renderRecipients(e.to_addr, e.recipient_names)}</div>
          <div class="drawer-meta-row"><span class="meta-label">${mailaiT('read.timeShort') || '时间'}</span><span>${fmtDate(e.date)}</span></div>
        </div>
        <span class="drawer-risk tag tag-${risk.class}">${risk.text}<b>${e.score || 0}</b></span>
      </div>
    </div>
    <div class="drawer-email-body">
      <div class="reading-section drawer-summary-section"><div class="section-title"><span>${mailaiT('read.summaryTitle') || 'AI 摘要'}</span><small>${mailaiT('read.summaryHintDrawer') || '快速了解邮件重点'}</small></div>
        <div class="markdown-body summary-box">${mdToHtml(e.summary || e.snippet || (mailaiT('read.noSummary') || '暂无摘要'))}</div>
      </div>
      <div class="reading-section drawer-body-section"><div class="section-title"><span>${mailaiT('read.body') || '邮件正文'}</span><small>${e.has_rich_body ? (e.has_remote_images ? (mailaiT('read.fmtHtmlImages') || 'HTML 原始排版 · 外链图片已显示') : (mailaiT('read.fmtHtml') || 'HTML 原始排版')) : (mailaiT('read.fmtPlain') || '纯文本邮件')}</small></div>
        ${e.has_rich_body ? '<div id="digest-rich-email-body" class="email-body rich-email-body"><div class="reading-loading">正在还原邮件排版…</div></div>' : `<div class="markdown-body email-body plain-email-body">${mdToHtml(e.body_text || '')}</div>`}
      </div>
      <div class="reading-section drawer-findings-section"><div class="section-title"><span>${mailaiT('read.security') || '安全分析'}</span><small>${(mailaiT('read.ruleScore') || '规则分 {n}').replace('{n}', e.score || 0)}</small></div>
        <ul class="findings">${findings}</ul>
      </div>
    </div>
  `;
}

function mountDigestRichEmailBody(e) {
  const host = document.getElementById('digest-rich-email-body');
  if (!host || !e.body_html) return;
  const frame = document.createElement('iframe');
  frame.className = 'rich-email-frame';
  frame.setAttribute('sandbox', 'allow-same-origin allow-top-navigation-to-custom-protocols');
  frame.setAttribute('title', '来源邮件 HTML 正文');
  frame.setAttribute('scrolling', 'no');
  autoSizeRichEmailFrame(frame);
  frame.srcdoc = richEmailDocument(e.body_html, true);
  host.replaceChildren(frame);
}

// ===== 工具函数 =====
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  const icons = {
    success: '<path d="m5.5 10.2 3 3 6-6"/>',
    error: '<path d="M10 5.5v5M10 14.2h.01"/>',
    warn: '<path d="M10 3.5 17 16H3L10 3.5ZM10 8v3M10 13.7h.01"/>',
    info: '<path d="M10 9v5M10 6h.01"/>',
  };
  el.innerHTML = `<span class="toast-icon"><svg viewBox="0 0 20 20" aria-hidden="true">${icons[type] || icons.info}</svg></span><span class="toast-message">${esc(msg)}</span>`;
  el.className = 'toast ' + type;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3000);
}

async function api(path, opts = {}) {
  const composePath = /^\/api\/mail\/(?:send|outbox|preflight|contacts|signatures|compose)/.test(path) || (path.startsWith('/api/drafts') && opts.method);
  const accountId = opts.accountId || (composePath && document.body.classList.contains('compose-open') ? composeAccountId : '') || activeMailAccount()?.id;
  opts = {...opts, headers:{...(opts.headers || {}), ...(accountId ? {'X-MailAI-Account':accountId} : {})}};
  delete opts.accountId;
  // Read-only polling must finish even when the local service is unresponsive.
  // Do not time out mutations here: an accepted send/move must not be retried
  // merely because its response was slow.
  const controller = new AbortController();
  const parentSignal = opts.signal;
  const relayAbort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', relayAbort, {once:true});
  const timeout = (!opts.method || opts.method === 'GET') ? setTimeout(() => controller.abort(), 20000) : null;
  opts.signal = controller.signal;
  try {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try { message = JSON.parse(text).detail || text; } catch (_) {}
    throw new Error(message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.undo_token && typeof offerUndo === 'function') offerUndo([data.undo_token], accountId);
  return data;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', relayAbort);
  }
}

function setLoading(el, loading, text) {
  if (loading) {
    if (!el.classList.contains('loading')) el.dataset.originalHtml = el.innerHTML;
    const label = [...el.children].reverse().find(child => child.tagName === 'SPAN');
    if (label) label.textContent = text || '处理中…';
    else el.textContent = text || '处理中…';
    el.disabled = true;
    el.classList.add('loading');
  } else {
    if (Object.prototype.hasOwnProperty.call(el.dataset, 'originalHtml')) {
      el.innerHTML = el.dataset.originalHtml;
      delete el.dataset.originalHtml;
    }
    el.disabled = false;
    el.classList.remove('loading');
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function mailDateGroup(value, now = new Date()) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return {key:'unknown', label: mailaiT('list.dateUnknown') || '未知时间'};
  const keyOf = item => [item.getFullYear(), String(item.getMonth() + 1).padStart(2, '0'), String(item.getDate()).padStart(2, '0')].join('-');
  const key = keyOf(date);
  const today = keyOf(now);
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterday = keyOf(yesterdayDate);
  if (key === today) return {key, label: mailaiT('list.dateToday') || '今天'};
  if (key === yesterday) return {key, label: mailaiT('list.dateYesterday') || '昨天'};
  const label = date.getFullYear() === now.getFullYear()
    ? (mailaiT('list.dateShort') || '{m}月{d}日').replace('{m}', date.getMonth() + 1).replace('{d}', date.getDate())
    : (mailaiT('list.dateFull') || '{y}年{m}月{d}日').replace('{y}', date.getFullYear()).replace('{m}', date.getMonth() + 1).replace('{d}', date.getDate());
  return {key, label};
}

// 数字变化滚动过渡：只对模板里的数字做 tween，文字框架保持不变
const _countFrom = new WeakMap();
function animateCountText(el, target, render) {
  if (!el) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const from = _countFrom.get(el) ?? 0;
  _countFrom.set(el, target);
  if (reduced || from === target) { el.textContent = render(target); return; }
  const start = performance.now();
  const tick = now => {
    const t = Math.min(1, (now - start) / 380);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = render(Math.round(from + (target - from) * eased));
    if (t < 1 && _countFrom.get(el) === target) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 加载占位：列表与阅读区用扫光骨架代替干等文字
function skeletonRows(n = 6) {
  return Array.from({length: n}, () =>
    '<div class="skeleton-row"><div class="skeleton-bar w60"></div><div class="skeleton-bar w85"></div><div class="skeleton-bar w40"></div></div>').join('');
}

function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d)) return s.slice(0, 16);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isYesterday = new Date(now - 86400000).toDateString() === d.toDateString();
  const en = Boolean(mailaiT('list.dateToday'));
  const locale = en ? 'en-US' : 'zh-CN';
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (isToday) return (mailaiT('list.dateToday') || '今天') + ' ' + time;
  if (isYesterday) return (mailaiT('list.dateYesterday') || '昨天') + ' ' + time;
  return d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getDomain(addr) {
  if (!addr) return '';
  const m = addr.match(/@([^\s>]+)/);
  return m ? m[1].toLowerCase() : '';
}

function getRiskLabel(score, verdict, email = {}) {
  if (email.feedback === 'fp' && email.reviewed) return {text: mailaiT('risk.fp') || '已确认误报', class:'success', reviewed:true};
  if (email.feedback === 'fn') return {text: mailaiT('risk.fn') || '已举报漏报', class:'danger', reviewed:true};
  if (verdict === 'unreviewed') return {text: mailaiT('risk.unreviewed') || '未分析', class:'muted'};
  if (verdict === 'phishing' || score >= 70) return { text: mailaiT('risk.phishing') || '钓鱼', class: 'danger' };
  if (verdict === 'suspicious' || score >= 35) return { text: mailaiT('risk.suspicious') || '可疑', class: 'warn' };
  return { text: mailaiT('risk.clean') || '正常', class: 'success' };
}

// Keep sidebar risk groups identical to the badge shown on each mail card.
// This also respects manual false-positive/false-negative review results.
function mailVerdictKey(email = {}) {
  const risk = getRiskLabel(Number(email.score || 0), email.verdict || 'clean', email);
  if (risk.class === 'danger') return 'phishing';
  if (risk.class === 'warn') return 'suspicious';
  if (risk.class === 'muted') return 'unreviewed';
  return 'clean';
}

// 风险环形仪表（SVG gauge，带描边动画）
function buildRiskGauge(score, risk) {
  const colorMap = { danger: '#ef4444', warn: '#f59e0b', success: '#10b981', muted:'#85958f' };
  const color = colorMap[risk.class];
  const R = 34, C = 2 * Math.PI * R;
  const frac = Math.max(0, Math.min(100, score)) / 100;
  const dash = C * frac;
  return `
    <div class="gauge-wrap" title="${risk.reviewed ? '原始自动评分，当前结论以人工反馈为准' : '风险评分'} ${score}/100">
      <svg width="84" height="84" viewBox="0 0 84 84" class="gauge-svg">
        <circle cx="42" cy="42" r="${R}" fill="none" stroke="#eef0f4" stroke-width="8"/>
        <circle cx="42" cy="42" r="${R}" fill="none" stroke="${color}" stroke-width="8"
          stroke-linecap="round" stroke-dasharray="${dash} ${C}"
          transform="rotate(-90 42 42)" class="gauge-arc"/>
      </svg>
      <div class="gauge-center">
        <span class="gauge-score" style="color:${color}">${score}</span>
        <span class="gauge-label">${risk.text}</span>
      </div>
    </div>`;
}

function needsRiskAttention(email = {}) {
  if (email.processing_complete === 0 || email.reviewed || email.remote_missing || email.status === 'trash' || String(email.pending_action || '').startsWith('trash')) return false;
  if (email.feedback === 'fn') return true;
  return ['phishing', 'suspicious'].includes(email.verdict) || Number(email.score || 0) >= 35;
}

// ===== 数据加载 =====
let mailLoadRevision = 0;

async function loadMailPages(path, isCurrent = () => true, maxRows = Number.POSITIVE_INFINITY) {
  const rows = new Map();
  let offset = 0;
  while (isCurrent()) {
    const page = await api(`${path}&offset=${offset}`);
    if (!isCurrent()) return null;
    for (const row of page) {
      if (rows.size >= maxRows) break;
      rows.set(`${row._account_id || ''}:${row.id}`, row);
    }
    offset += page.length;
    if (rows.size >= maxRows || page.length < 1000) return [...rows.values()];
  }
  return null;
}

async function loadData({includeAncillary = true, silent = false} = {}) {
  const revision = ++mailLoadRevision;
  const accountId = typeof activeMailAccount === 'function' ? activeMailAccount()?.id : '';
  const folder = currentServerFolder;
  const status = currentFilter.status;
  const days = currentFilter.days;
  const unified = typeof unifiedMailbox !== 'undefined' && unifiedMailbox;
  const isCurrent = () => revision === mailLoadRevision && accountId === (typeof activeMailAccount === 'function' ? activeMailAccount()?.id : '') && folder === currentServerFolder && status === currentFilter.status && days === currentFilter.days && unified === (typeof unifiedMailbox !== 'undefined' && unifiedMailbox);
  // 空列表加载时给骨架屏；已有内容时保留旧列表，避免刷新闪烁
  const listNode = document.getElementById('email-list');
  if (!silent && listNode && !listNode.querySelector('.email-item')) listNode.innerHTML = skeletonRows();
  try {
    const mailPath = unified
      ? `/api/system/mail/unified-inbox?days=${days}&limit=1000`
      : currentFilter.status === 'local_archive' ? '/api/emails?days=9999&status=local_archive'
      : currentFilter.status === 'favorites' ? '/api/emails?days=9999&status=favorites'
      : currentFilter.status === 'trash' ? '/api/emails?days=9999&status=trash'
      : (folder ? `/api/emails?days=9999&folder=${encodeURIComponent(folder)}` : '/api/emails?days=' + days);
    const requests = [loadMailPages(mailPath, isCurrent)];
    if (includeAncillary) requests.push(api('/api/todos'), api('/api/mail/sent'), api('/api/drafts'));
    const [emails, todos, sent, drafts] = await Promise.all(requests);
    if (!isCurrent() || !emails) return;
    allEmails = emails;
    if (includeAncillary) {
      allTodos = todos;
      sentMessages = sent;
      savedDrafts = drafts;
    }
    updateSidebar();
    updateDomainFilter();
    applyFilters({silent});
    loadAssistantAlerts();
    return true;
  } catch (e) {
    if (isCurrent()) toast('加载数据失败：' + e.message, 'error');
    return false;
  }
}

// ===== 侧边栏统计 =====
function serverFolderForRole(role) {
  const flagPatterns = {
    trash: /\\trash/i, inbox: /\\inbox/i, sent: /\\sent/i, drafts: /\\drafts/i,
    spam: /\\(?:junk|spam)/i, quarantine: /\\quarantine/i,
  };
  const namePatterns = {
    trash: /^(?:trash|deleted(?: items| messages)?|bin|已删除|已删除邮件|垃圾箱|废纸篓)$/i,
    inbox: /^(?:inbox|收件箱)$/i,
    sent: /^(?:sent(?: items| messages)?|已发送|已发邮件)$/i,
    drafts: /^(?:drafts?|草稿箱)$/i,
    spam: /^(?:junk(?: e-mail)?|spam|垃圾邮件)$/i,
    quarantine: /^(?:quarantine|隔离区)$/i,
  };
  return mailboxFolders.find(folder => (folder.flags || []).some(flag => flagPatterns[role]?.test(flag))) ||
    mailboxFolders.find(folder => namePatterns[role]?.test(String(folder.name || '').trim()));
}

function serverMailboxCounts() {
  if (!mailboxFolders.length) return null;
  const count = role => Number(serverFolderForRole(role)?.messages || 0);
  return {
    all: mailboxFolders.filter(folder => folder.selectable !== false)
      .reduce((sum, folder) => sum + Number(folder.messages || 0), 0),
    inbox: count('inbox'), sent: count('sent'), drafts: count('drafts'),
    quarantine: count('quarantine'), spam: count('spam'), trash: count('trash'),
  };
}

function updateSidebar() {
  // This function may run after the slower server-folder request finishes.
  // Keep it limited to mailbox badges so it cannot overwrite the facet counts
  // that applyFilters() calculated for the selected mailbox and filters.
  const counts = {
    all: allEmails.length,
    inbox: allEmails.filter(e => e.status === 'inbox').length,
    quarantine: allEmails.filter(e => e.status === 'quarantine').length,
    spam: allEmails.filter(e => e.status === 'spam').length,
    trash: allEmails.filter(e => e.status === 'trash').length,
    sent: sentMessages.length,
    drafts: savedDrafts.length,
  };
  const serverCounts = serverMailboxCounts();
  if (serverCounts) {
    for (const key of ['all', 'inbox', 'sent', 'drafts', 'quarantine', 'spam', 'trash']) {
      counts[key] = Math.max(counts[key] || 0, serverCounts[key] || 0);
    }
    // Junk is a real server mailbox. Its badge must describe that mailbox,
    // not a larger historical count of locally classified messages.
    if (serverFolderForRole('spam')) counts.spam = serverCounts.spam;
    if (serverFolderForRole('quarantine')) counts.quarantine = serverCounts.quarantine;
  }
  for (const [k, v] of Object.entries(counts)) {
    const el = document.getElementById('count-' + k);
    if (el) {
      el.textContent = v;
      if (serverCounts && Object.hasOwn(serverCounts, k)) el.title = `服务器共 ${serverCounts[k]} 封`;
    }
  }

}

function currentMailboxScopeLabel() {
  if (specialMailbox === 'sent') return '已发送内';
  if (specialMailbox === 'drafts') return '草稿箱内';
  if (currentServerFolder) {
    if (serverFolderForRole('spam')?.name === currentServerFolder) return '垃圾邮件内';
    if (serverFolderForRole('quarantine')?.name === currentServerFolder) return '隔离区内';
    return `${currentServerFolder}内`;
  }
  if (unifiedMailbox) return '所有收件箱内';
  if (currentFilter.status === 'inbox') return '收件箱内';
  if (currentFilter.status === 'quarantine') return '隔离区内';
  if (currentFilter.status === 'spam') return '垃圾邮件内';
  return '全部邮件内';
}

function updateFacetScopeLabels() {
  const label = currentMailboxScopeLabel();
  document.querySelectorAll('.facet-scope-label').forEach(node => {
    node.textContent = label;
    node.title = `数量统计范围：${label}`;
  });
}

function renderCategoryNav(filteredRows) {
  const cats = {};
  filteredRows.forEach(e => {
    const c = e.category || '未分类';
    cats[c] = (cats[c] || 0) + 1;
  });
  const catNav = document.getElementById('category-nav');
  const categoryRows = Object.entries(cats)
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
    .map(([cat, count]) => `
      <button type="button" class="nav-item ${currentFilter.category === cat ? 'active' : ''}" data-filter="category" data-value="${esc(cat)}">
        <span class="icon">${categoryIcon(cat)}</span> ${esc(cat)}
        <span class="count">${count}</span>
      </button>
    `).join('');
  const hasActiveScope = currentFilter.days !== 9999 || Boolean(currentFilter.priority) ||
    Boolean(currentFilter.domain) || currentFilter.attachments || currentFilter.unread || Boolean(currentFilter.search) ||
    Boolean(currentFilter.status) || Boolean(currentFilter.verdict) || Boolean(currentFilter.category) ||
    Boolean(specialMailbox) || Boolean(currentServerFolder);
  catNav.innerHTML = categoryRows || `<div class="category-empty-state">
    <span class="category-empty-icon" aria-hidden="true">${categoryIcon('未分类')}</span>
    <b>${hasActiveScope ? '当前条件下没有邮件' : '还没有可分类的邮件'}</b>
    <small>${hasActiveScope ? '清除筛选后可查看全部分类' : '同步邮件后会自动整理到这里'}</small>
    <button type="button" data-category-empty-action="${hasActiveScope ? 'clear' : 'sync'}">${hasActiveScope ? '查看全部分类' : '同步邮件'}</button>
  </div>`;
  bindNavItems();
}

async function onNavClick(e) {
  if (bulkOperationActive) return toast('批量操作正在执行，请稍候', 'warn');
  const emptyAction = e.target.closest('[data-category-empty-action]');
  if (emptyAction) {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById(emptyAction.dataset.categoryEmptyAction === 'sync' ? 'btn-poll' : 'btn-reset-filter')?.click();
    return;
  }
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  resetReadingPane();
  const filter = btn.dataset.filter;
  const value = btn.dataset.value || '';
  if (specialMailbox && (filter === 'verdict' || filter === 'category')) {
    return toast('风险等级和 AI 分类用于收件邮件，请先选择收件箱', 'warn');
  }
  if (btn.closest('#folder-nav')) {
    unifiedMailbox = false;
    selectedMailboxAccountId = activeMailAccount()?.id || '';
  }
  const changingMailbox = filter === 'status' || filter === 'special';
  const leavingServerFolder = changingMailbox && !!currentServerFolder;
  const leavingFavorites = changingMailbox && ['favorites','local_archive'].includes(currentFilter.status);
  if (changingMailbox) currentServerFolder = '';
  console.log('[nav click]', filter, value);
  if (filter === 'status' && value === 'trash') { await openTrashMailbox(); updateActiveNav(); return; }
  if (filter === 'status' && ['quarantine', 'spam'].includes(value)) {
    const serverFolder = serverFolderForRole(value);
    if (serverFolder?.name) {
      await loadServerFolder(serverFolder.name);
      updateActiveNav();
      return;
    }
  }
  if (filter === 'special') {
    specialMailbox = value;
    currentFilter.status = ''; currentFilter.verdict = ''; currentFilter.category = '';
  } else if (filter === 'status') {
    specialMailbox = '';
    currentFilter.status = value;
    currentFilter.verdict = '';
    currentFilter.category = '';
  } else if (filter === 'verdict') {
    // Risk is a facet inside the current mailbox scope, not a new mailbox.
    currentFilter.verdict = currentFilter.verdict === value ? '' : value;
  } else if (filter === 'category') {
    // AI category and risk can be combined while preserving Inbox/folder scope.
    currentFilter.category = currentFilter.category === value ? '' : value;
  }
  const openingMailbox = filter === 'status' && ['', 'inbox', 'quarantine', 'spam', 'trash'].includes(value);
  if (openingMailbox && currentFilter.days !== 9999) {
    currentFilter.days = 9999;
    setSegmentedFilter('filter-days', '9999');
    await loadData();
  } else if (value === 'favorites' || leavingServerFolder || leavingFavorites) await loadData();
  updateActiveNav();
  applyFilters();
  const label = btn.textContent.trim().split(/\s+/)[0];
  toast(`已切换到：${label}`);
}

function bindNavItems() {
  ['folder-nav', 'risk-nav', 'category-nav'].forEach(id => {
    const nav = document.getElementById(id);
    if (!nav) return;
    nav.removeEventListener('click', onNavClick);
    nav.addEventListener('click', onNavClick);
  });
}

function updateActiveNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    const f = btn.dataset.filter;
    const v = btn.dataset.value;
    let active = false;
    if (f === 'status' && currentFilter.status === v) active = true;
    if (f === 'verdict' && currentFilter.verdict === v) active = true;
    if (f === 'category' && currentFilter.category === v) active = true;
    if (f === 'special' && specialMailbox === v) active = true;
    if (btn.dataset.accountAction === 'unified' && unifiedMailbox) active = true;
    if (specialMailbox && f !== 'special') active = false;
    if (currentServerFolder && (f === 'status' || f === 'special')) active = false;
    if (currentServerFolder && f === 'status' && v === 'spam' &&
        serverFolderForRole('spam')?.name === currentServerFolder) active = true;
    if (currentServerFolder && f === 'status' && v === 'quarantine' &&
        serverFolderForRole('quarantine')?.name === currentServerFolder) active = true;
    btn.classList.toggle('active', active);
  });
  updateFacetScopeLabels();
}

function updateDomainFilter() {
  const domains = [...new Set(allEmails.map(e => getDomain(e.from_addr)).filter(Boolean))].sort();
  const select = document.getElementById('filter-domain');
  if (!select) return;
  const current = currentFilter.domain;
  select.innerHTML = '<option value="">不限域名</option>' +
    domains.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  if (domains.includes(current) || !current) select.value = current;
  else { currentFilter.domain = ''; select.value = ''; }
}

// ===== 统计看板 =====
let _dashboardDays = 7;
let _dashboardAttention = [];

async function loadDashboard(days = 7) {
  _dashboardDays = days;
  try {
    const data = await api('/api/dashboard?days=' + days);
    renderDashboard(data);
  } catch (e) {
    toast('加载看板失败：' + e.message, 'error');
  }
}

// KPI 数字滚动动画
function animateValue(el, target, decimals = 0, duration = 800) {
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    const val = from + (target - from) * eased;
    el.textContent = decimals ? val.toFixed(decimals) : Math.round(val);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderDashboard(data) {
  const ops = data.operations || {};
  _dashboardAttention = ops.attention || [];
  animateValue(document.getElementById('kpi-pending'), ops.pending_review || 0);
  animateValue(document.getElementById('kpi-risk-count'), ops.risk_count || 0);
  animateValue(document.getElementById('kpi-auto-handled'), ops.auto_handled || 0);
  animateValue(document.getElementById('kpi-feedback'), ops.feedback_count || 0);
  document.getElementById('kpi-risk-rate').textContent = `${Number(ops.risk_rate || 0).toFixed(1)}%`;
  document.getElementById('kpi-pending-note').textContent = ops.today_risk ? (mailaiT('dash.todayRisk') || '今天新增 {n} 封风险邮件').replace('{n}', ops.today_risk) : (mailaiT('dash.noTodayRisk') || '当前没有今日新增风险');
  const modeLabels = {observe: mailaiT('dash.modeObserve') || '仅观察', review: mailaiT('dash.modeReview') || '人工确认', auto: mailaiT('dash.modeAuto') || '自动处置'};
  document.getElementById('kpi-policy-mode').textContent = (mailaiT('dash.policyMode') || '当前策略：{mode}').replace('{mode}', modeLabels[data.action_policy?.mode] || '--');
  document.getElementById('dashboard-updated').textContent = (mailaiT('dash.updatedLine') || '更新于 {time} · 统计邮件 {n} 封').replace('{time}', new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})).replace('{n}', data.total || 0);

  const priority = document.getElementById('dashboard-priority');
  const delta = Number(ops.risk_rate_delta || 0);
  let state = 'calm', title = mailaiT('dash.calmTitle') || '当前运行平稳', copy = mailaiT('dash.calmCopy') || '没有待确认风险，可以查看趋势和处置成效。';
  if (ops.pending_review > 0) {
    state = 'danger';
    title = (mailaiT('dash.pendingTitle') || '有 {n} 封风险邮件等待判断').replace('{n}', ops.pending_review);
    copy = (mailaiT('dash.pendingCopy') || '优先核对高分邮件；本期风险占比 {rate}%，{delta}。')
      .replace('{rate}', Number(ops.risk_rate || 0).toFixed(1))
      .replace('{delta}', delta > 0 ? (mailaiT('dash.deltaUp') || '较上一周期上升 {n} 个百分点').replace('{n}', delta.toFixed(1)) : (mailaiT('dash.deltaFlat') || '未出现明显上升'));
  } else if (delta > 2) {
    state = 'warn';
    title = mailaiT('dash.risingTitle') || '风险占比正在上升';
    copy = (mailaiT('dash.risingCopy') || '较上一周期上升 {n} 个百分点，建议检查近期高风险来源。').replace('{n}', delta.toFixed(1));
  }
  priority.className = `dashboard-priority ${state}`;
  document.getElementById('dashboard-status-title').textContent = title;
  document.getElementById('dashboard-status-copy').textContent = copy;
  document.getElementById('btn-dashboard-review').disabled = !_dashboardAttention.length;

  renderDashboardAttention(_dashboardAttention);
  renderDashboardCampaigns(data.campaigns || []);
  renderDashboardQuality(data.evaluation);
  renderDashboardOutcome(data, ops);
  renderTrendChart(data.trend || {});
  renderSenderChart(ops.risky_senders || []);
  const trendInsight = delta > 2 ? (mailaiT('dash.trendUp') || '↑ 上升 {n} 个百分点').replace('{n}', delta.toFixed(1)) : delta < -2 ? (mailaiT('dash.trendDown') || '↓ 下降 {n} 个百分点').replace('{n}', Math.abs(delta).toFixed(1)) : (mailaiT('dash.trendFlat') || '与上一周期基本持平');
  const trendNode = document.getElementById('dashboard-trend-insight');
  trendNode.textContent = trendInsight;
  trendNode.className = delta > 2 ? 'up' : delta < -2 ? 'down' : '';
}

function renderDashboardAttention(items) {
  const host = document.getElementById('dashboard-attention-list');
  document.getElementById('dashboard-attention-count').textContent = items.length ? (mailaiT('dash.attentionCount') || '优先显示 {n} 封').replace('{n}', items.length) : '';
  if (!items.length) {
    host.innerHTML = `<div class="dashboard-empty-state"><span>✓</span><div><b>${mailaiT('dash.queueEmpty') || '待确认队列已清空'}</b><small>${mailaiT('dash.queueEmptyHint') || '新的风险邮件会自动出现在这里。'}</small></div></div>`;
    return;
  }
  host.innerHTML = items.map(item => `<button type="button" class="dashboard-attention-item ${item.verdict === 'phishing' ? 'danger' : 'warn'}" data-dashboard-email="${item.id}">
    <span class="dashboard-attention-score"><b>${item.score || 0}</b><small>${item.verdict === 'phishing' ? (mailaiT('risk.phishing') || '钓鱼') : (mailaiT('risk.suspicious') || '可疑')}</small></span>
    <span class="dashboard-attention-main"><b>${esc(item.subject || (mailaiT('att.noSubject') || '（无主题）'))}</b><small>${esc(item.from_name || item.from_addr || (mailaiT('att.unknownSender') || '未知发件人'))} · ${fmtDate(item.date || item.created_at)}</small></span>
    <span class="dashboard-attention-action">${mailaiT('dash.viewEvidence') || '查看证据'} →</span>
  </button>`).join('');
}

// 关联研判信号是后端固定中文短语（app/security/campaigns.py），英文界面映射译文
function campaignSignalLabel(signal) {
  const keys = {'相同链接目标':'dash.signalLink', '主题高度相似':'dash.signalSubject', '正文话术相似':'dash.signalBody', '相同发件域':'dash.signalDomain'};
  return (keys[signal] && mailaiT(keys[signal])) || signal;
}

function renderDashboardCampaigns(items) {
  const host = document.getElementById('dashboard-campaign-list');
  if (!host) return;
  document.getElementById('dashboard-campaign-count').textContent = items.length ? (mailaiT('dash.campaignCount') || '{n} 组关联活动').replace('{n}', items.length) : '';
  if (!items.length) {
    host.innerHTML = `<div class="dashboard-empty-state compact"><span><svg viewBox="0 0 20 20"><path d="M5 6h5l2 2h3v6H5z"/><path d="M7 4h4l2 2"/></svg></span><div><b>${mailaiT('dash.noCampaign') || '暂未发现成组攻击'}</b><small>${mailaiT('dash.noCampaignHint') || '相同链接、附件或话术会自动归并。'}</small></div></div>`;
    return;
  }
  host.innerHTML = items.map(item => {
    const first = (item.samples || [])[0] || {};
    return `<button type="button" class="dashboard-campaign-item" data-dashboard-email="${first.id || ''}">
      <span class="campaign-node"><b>${item.size}</b><small>${mailaiT('dash.campaignLinked') || '封关联'}</small></span>
      <span class="campaign-main"><b>${esc(first.subject || (mailaiT('dash.campaignMail') || '关联风险邮件'))}</b><small>${esc((item.signals || []).map(campaignSignalLabel).join(' · ') || (mailaiT('dash.campaignSimilar') || '内容特征相似'))} · ${(mailaiT('dash.campaignMaxScore') || '最高风险分 {n}').replace('{n}', item.max_score || 0)}</small></span>
      <span class="campaign-action">${mailaiT('dash.campaignView') || '查看影响面'} →</span>
    </button>`;
  }).join('');
}

function renderDashboardOutcome(data, ops) {
  const rows = [
    [mailaiT('dash.outcomeRisk') || '识别为风险', Number(ops.risk_count || 0), 'risk'],
    [mailaiT('dash.outcomeAuto') || '系统自动处置', Number(ops.auto_handled || 0), 'auto'],
    [mailaiT('dash.outcomeResolved') || '人工已确认', Number(ops.resolved_risk || 0), 'resolved'],
    [mailaiT('dash.outcomePending') || '本期仍待判断', Number(ops.pending_period || 0), 'pending'],
  ];
  const max = Math.max(1, ...rows.map(row => row[1]));
  document.getElementById('dashboard-outcome').innerHTML = rows.map(([label, value, kind]) => `<div class="dashboard-outcome-row ${kind}"><span>${label}</span><div><i style="width:${Math.max(value ? 6 : 0, value / max * 100)}%"></i></div><b>${value}</b></div>`).join('');
  document.getElementById('dashboard-efficiency').textContent = data.saved_hours ? (mailaiT('dash.savedHours') || '约节省 {n} 小时').replace('{n}', Number(data.saved_hours).toFixed(1)) : (mailaiT('dash.savedWaiting') || '等待形成处置数据');
}

function renderDashboardQuality(evaluation) {
  const host = document.getElementById('dashboard-quality');
  if (!evaluation) {
    host.innerHTML = `<span class="dashboard-quality-empty">${mailaiT('dash.noEvaluation') || '尚无独立评测报告；日常风险识别与处置数据仍正常统计。'}</span>`;
    return;
  }
  const metrics = [
    [mailaiT('dash.metricAccuracy') || '准确率', `${((evaluation.accuracy || 0) * 100).toFixed(1)}%`],
    [mailaiT('dash.metricRecall') || '钓鱼召回率', `${((evaluation.recall || 0) * 100).toFixed(1)}%`],
    ['F1', `${((evaluation.f1 || 0) * 100).toFixed(1)}%`],
    [mailaiT('dash.metricAvgTime') || '平均处理', `${Number(evaluation.avg_process_time_ms || 0).toFixed(1)} ms`],
  ];
  host.innerHTML = metrics.map(([label, value]) => `<span><small>${label}</small><b>${value}</b></span>`).join('') + `<em>${(mailaiT('dash.metricSamples') || '样本 {n} 条').replace('{n}', evaluation.total || 0)}</em>`;
}

function renderTrendChart(trend) {
  const container = document.getElementById('trend-chart');
  const dates = Object.keys(trend).sort();
  if (dates.length === 0) {
    container.innerHTML = `<div class="chart-empty">${mailaiT('dash.noData') || '暂无数据'}</div>`;
    return;
  }
  const series = [
    { key: 'phishing', label: mailaiT('risk.phishing') || '钓鱼', color: '#ef4444' },
    { key: 'suspicious', label: mailaiT('risk.suspicious') || '可疑', color: '#f59e0b' },
    { key: 'spam', label: mailaiT('risk.spam') || '垃圾', color: '#94a3b8' },
    { key: 'clean', label: mailaiT('risk.clean') || '正常', color: '#10b981' },
  ];
  const W = Math.max(460, dates.length * 64), H = 200, padL = 30, padB = 28, padT = 14, padR = 14;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(2, ...dates.flatMap(d => series.map(s => trend[d][s.key] || 0)));
  const x = i => padL + (dates.length === 1 ? plotW / 2 : (i / (dates.length - 1)) * plotW);
  const y = v => padT + plotH - (v / maxVal) * plotH;

  let html = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="grad-phishing" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ef4444" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="#ef4444" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="grad-clean" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#10b981" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#10b981" stop-opacity="0"/>
      </linearGradient>
    </defs>`;

  // 网格线
  for (let g = 0; g <= 3; g++) {
    const gy = padT + (plotH / 3) * g;
    const gv = Math.round(maxVal * (1 - g / 3));
    html += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#eef0f4" stroke-width="1"/>
             <text x="${padL - 6}" y="${gy + 3}" font-size="9" text-anchor="end" fill="#9aa1ad">${gv}</text>`;
  }

  // 面积 + 折线（Catmull-Rom 平滑）
  series.forEach(s => {
    const pts = dates.map((d, i) => [x(i), y(trend[d][s.key] || 0)]);
    let path = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const cx = (x0 + x1) / 2;
      path += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`;
    }
    if (s.key === 'phishing' || s.key === 'clean') {
      html += `<path d="${path} L ${pts[pts.length - 1][0]} ${padT + plotH} L ${pts[0][0]} ${padT + plotH} Z"
                fill="url(#grad-${s.key})" class="trend-area"/>`;
    }
    html += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.2"
              stroke-linecap="round" class="trend-line"/>`;
    pts.forEach(([px, py], i) => {
      const val = trend[dates[i]][s.key] || 0;
      html += `<circle cx="${px}" cy="${py}" r="${val > 0 ? 3.4 : 0}" fill="#fff"
                stroke="${s.color}" stroke-width="2" class="trend-dot"><title>${dates[i]} ${s.label}: ${val}</title></circle>`;
    });
  });

  // X 轴日期
  dates.forEach((d, i) => {
    html += `<text x="${x(i)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#9aa1ad">${d.slice(5)}</text>`;
  });
  html += '</svg>';

  html += '<div class="chart-legend">' +
    series.map(s => `<span class="legend-item"><i style="background:${s.color}"></i>${s.label}</span>`).join('') +
    '</div>';
  container.innerHTML = html;
}

function renderSenderChart(senders) {
  const container = document.getElementById('sender-chart');
  if (!senders.length) {
    container.innerHTML = `<div class="chart-empty">${mailaiT('dash.noData') || '暂无数据'}</div>`;
    return;
  }
  const maxCount = Math.max(1, ...senders.map(s => s.risk_count || 0));
  const level = s => s >= 50 ? 'danger' : s >= 30 ? 'warn' : 'info';
  container.innerHTML = `<div class="sender-rank">${senders.map((s, i) => {
    const pct = Math.round(((s.risk_count || 0) / maxCount) * 100);
    const lv = level(s.max_score || 0);
    return `
    <button type="button" class="sender-row" data-dashboard-email="${s.email_id || ''}" style="animation-delay:${i * 0.08}s">
      <span class="sender-rank-no ${lv}">${i + 1}</span>
      <span class="sender-addr" title="${esc(s.sender)}"><b>${esc(s.sender)}</b><small>${(mailaiT('dash.senderLine') || '{n} 封钓鱼 · 最高 {score} 分').replace('{n}', s.phishing_count || 0).replace('{score}', s.max_score || 0)}</small></span>
      <div class="sender-bar-track">
        <div class="sender-bar ${lv}" style="width:${pct}%"></div>
      </div>
      <span class="sender-score ${lv}">${s.risk_count}</span>
    </button>`;
  }).join('')}</div>`;
}

function setTopMenuLabel(id, label) {
  const button = document.getElementById(id);
  const labelNode = button?.querySelector('.top-menu-label');
  if (labelNode) labelNode.textContent = label;
  else if (button) button.textContent = label;
}

function showDashboard() {
  closeAssistant();
  hideSystemView(true);
  hideRulesView(false);
  document.querySelector('.layout').classList.add('hidden');
  document.getElementById('dashboard-view').classList.remove('hidden');
  setTopMenuLabel('btn-dashboard', mailaiT('dash.back') || '返回邮件');
  document.getElementById('btn-dashboard').title = mailaiT('dash.backTitle') || '返回邮件列表';
  loadDashboard(_dashboardDays);
}

function hideDashboard() {
  document.getElementById('dashboard-view').classList.add('hidden');
  document.querySelector('.layout').classList.remove('hidden');
  setTopMenuLabel('btn-dashboard', mailaiT('security.dashboard') || '安全看板');
  document.getElementById('btn-dashboard').title = mailaiT('dash.openTitle') || '查看安全看板';
}

// ===== 筛选与排序 =====
function applyFilters({silent = false} = {}) {
  document.getElementById('list-footer').classList.toggle('hidden', Boolean(specialMailbox || currentFilter.search));
  for (const id of ['filter-priority','filter-domain']) document.getElementById(id).closest('label, fieldset')?.classList.toggle('hidden', Boolean(specialMailbox));
  document.getElementById('global-search').placeholder = currentFilter.status === 'trash' ? (mailaiT('search.trash') || '搜索已删除邮件的主题、发件人、摘要…') : specialMailbox === 'sent' ? (mailaiT('search.sent') || '搜索当前已发送邮件…') : specialMailbox === 'drafts' ? (mailaiT('search.drafts') || '搜索当前草稿…') : currentServerFolder ? (mailaiT('search.folder') || '搜索当前文件夹或姓名拼音…') : (mailaiT('search.all') || '搜索主题、发件人、正文或姓名拼音…');
  document.querySelector('#list-sort option[value="score-desc"]').disabled = Boolean(specialMailbox);
  if (specialMailbox && currentFilter.sort === 'score-desc') { currentFilter.sort = 'date-desc'; document.getElementById('list-sort').value = 'date-desc'; }
  document.getElementById('filter-unread').closest('label').classList.toggle('hidden', Boolean(specialMailbox));
  if (specialMailbox) { currentFilter.unread = false; document.getElementById('filter-unread').checked = false; }
  updateFilterSummary();
  if (specialMailbox) {
    for (const verdict of ['phishing','suspicious','clean','unreviewed']) {
      const badge = document.getElementById('count-' + verdict);
      if (badge) { badge.textContent = '0'; badge.title = `${currentMailboxScopeLabel()}暂不提供风险分类`; }
    }
    updateFacetScopeLabels();
    document.getElementById('category-nav').innerHTML = '<small>当前文件夹不提供 AI 分类</small>';
    renderSpecialMailbox({silent});
    return;
  }
  let list = [...(currentFilter.search && searchResults !== null ? searchResults : allEmails)];

  // 全局搜索返回完整历史；仍要遵守用户当前选择的时间范围。
  if (currentFilter.days !== 9999) {
    const cutoff = Date.now() - currentFilter.days * 24 * 60 * 60 * 1000;
    list = list.filter(e => {
      const received = new Date(e.date || e.created_at || 0).getTime();
      return Number.isFinite(received) && received >= cutoff;
    });
  }

  if (currentFilter.status === 'trash' && currentFilter.search) {
    const terms = currentFilter.search.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter(e => terms.every(term => [e.subject,e.from_addr,e.from_name,e.summary,e.snippet].join(' ').toLowerCase().includes(term)));
  }
  // 状态
  if (currentFilter.status === 'favorites') list = list.filter(e => e.is_favorite);
  else if (currentFilter.status) list = list.filter(e => e.status === currentFilter.status);
  // 风险
  // 优先级
  if (currentFilter.priority) list = list.filter(e => e.priority === currentFilter.priority);
  // 域名
  if (currentFilter.domain) list = list.filter(e => getDomain(e.from_addr) === currentFilter.domain);
  if (currentFilter.unread) list = list.filter(e => !e.is_read && !e._kind && e.direction !== 'outgoing');
  // 附件
  if (currentFilter.attachments) {
    list = list.filter(e => e.attachments && e.attachments.length > 0);
  }
  // 搜索
  if (currentFilter.search && searchResults === null) {
    const q = currentFilter.search.toLowerCase();
    list = list.filter(e =>
      (e.subject || '').toLowerCase().includes(q) ||
      (e.from_addr || '').toLowerCase().includes(q) ||
      (e.body_text || '').toLowerCase().includes(q));
  }

  // AI 分类是一个分面：统计必须遵守其他筛选条件，但不先套用分类自身，
  // 这样选中某一分类后，用户仍可看到并切换到同一筛选范围内的其他分类。
  const riskRows = currentFilter.category ? list.filter(e => (e.category || '未分类') === currentFilter.category) : list;
  for (const verdict of ['phishing','suspicious','clean','unreviewed']) {
    const badge = document.getElementById('count-' + verdict);
    if (badge) {
      badge.textContent = riskRows.filter(e => mailVerdictKey(e) === verdict).length;
      badge.title = `${currentMailboxScopeLabel()}、当前其他条件下的邮件数量`;
    }
  }
  if (currentFilter.verdict) list = list.filter(e => mailVerdictKey(e) === currentFilter.verdict);
  renderCategoryNav(list);
  if (currentFilter.category) {
    list = list.filter(e => (e.category || '未分类') === currentFilter.category);
  }

  // 排序
  list.sort((a, b) => {
    if (currentFilter.sort === 'date-desc') return new Date(b.date || 0) - new Date(a.date || 0);
    if (currentFilter.sort === 'date-asc') return new Date(a.date || 0) - new Date(b.date || 0);
    if (currentFilter.sort === 'score-desc') return (b.score || 0) - (a.score || 0);
    return 0;
  });

  renderEmailList(list, {silent});
  updateListTitle(list.length);
}

function updateListTitle(count) {
  let title = currentServerFolder && serverFolderForRole('spam')?.name === currentServerFolder
    ? '垃圾邮件' : currentServerFolder && serverFolderForRole('quarantine')?.name === currentServerFolder
      ? (mailaiT('side.quarantine') || '隔离区') : (currentServerFolder || (mailaiT('side.all') || '全部邮件'));
  if (currentServerFolder && currentServerFolder === serverFolderForRole('trash')?.name) title = mailaiT('side.trash') || '已删除';
  if (unifiedMailbox) title = mailaiT('list.allInboxes') || '所有收件箱';
  else if (currentFilter.status === 'local_archive') title = mailaiT('list.localArchive') || '本地归档';
  else if (currentFilter.status === 'favorites') title = mailaiT('side.favorites') || '我的收藏';
  else if (currentFilter.status === 'inbox') title = mailaiT('side.inbox') || '收件箱';
  else if (currentFilter.status === 'quarantine') title = mailaiT('side.quarantine') || '隔离区';
  else if (currentFilter.status === 'spam') title = mailaiT('side.spam') || '垃圾邮件';
  else if (currentFilter.status === 'trash') title = mailaiT('side.trash') || '已删除';
  const riskTitle = {phishing:mailaiT('risk.phishing') || '钓鱼邮件', suspicious:mailaiT('risk.suspicious') || '可疑邮件', clean:mailaiT('risk.clean') || '正常邮件', unreviewed:mailaiT('risk.unreviewed') || '待分析'}[currentFilter.verdict];
  if (riskTitle) title += ` · ${riskTitle}`;
  if (currentFilter.category) title += ` · ${currentFilter.category}`;
  document.getElementById('list-title').textContent = title;
  const serverCounts = serverMailboxCounts();
  const totalKey = currentFilter.status || (!currentFilter.verdict && !currentFilter.category ? 'all' : '');
  const selectedServerMailbox = currentServerFolder
    ? mailboxFolders.find(folder => folder.name === currentServerFolder) : null;
  const serverTotal = unifiedMailbox ? 0 : selectedServerMailbox
    ? Number(selectedServerMailbox.messages || 0)
    : totalKey ? Number(serverCounts?.[totalKey] || 0) : 0;
  const hasFacet = Boolean(currentFilter.verdict || currentFilter.category || currentFilter.priority ||
    currentFilter.domain || currentFilter.attachments || currentFilter.unread || currentFilter.search || currentFilter.days !== 9999);
  const countNode = document.getElementById('list-count');
  const countUnit = mailaiT('list.countMail') || ' 封';
  countNode.textContent = serverTotal > count && hasFacet
    ? (mailaiT('list.countScoped') || '{count} 封（当前范围共 {total} 封）').replace('{count}', count).replace('{total}', serverTotal)
    : count + countUnit;
  countNode.title = serverTotal > count && hasFacet
    ? (mailaiT('list.countScopedTitle') || '当前筛选结果 {count} 封；邮箱范围共 {total} 封').replace('{count}', count).replace('{total}', serverTotal)
    : '';
}

function specialMailboxRows() {
  if (specialMailbox === 'drafts') return savedDrafts.map(d => ({
    ...d, _kind:'draft', date:d.updated_at, from_name:'草稿', from_addr:d.to_addr || '尚未填写收件人',
    direction:'outgoing', direction_label:'发给', counterpart_addr:d.to_addr || '尚未填写收件人',
    summary:(d.body_html || '').replace(/<[^>]+>/g, ' '), score:0, verdict:'clean', status:'draft',
  }));
  return sentMessages.map(s => ({
    ...s, _kind:'sent', is_read:1, date:s.sent_at || s.created_at,
    from_name:s.status === 'sent' ? '已发送' : '发送失败', from_addr:s.to_addr || s.cc_addr || s.bcc_addr,
    direction:'outgoing', direction_label:'发给', counterpart_name:s.counterpart_name || '',
    counterpart_addr:s.counterpart_addr || s.to_addr || s.cc_addr || s.bcc_addr,
    counterpart_count:s.counterpart_count || (String([s.to_addr,s.cc_addr,s.bcc_addr].filter(Boolean).join(', ')).match(/@/g) || []).length,
    summary:(s.body_html || '').replace(/<[^>]+>/g, ' '), score:0, verdict:'clean', status:s.status,
  }));
}

function renderSpecialMailbox({silent = false} = {}) {
  let rows = specialMailboxRows();
  const query = (currentFilter.search || '').toLowerCase();
  if (query) rows = rows.filter(row => [row.subject,row.to_addr,row.cc_addr,row.bcc_addr,row.counterpart_name,Object.values(row.recipient_names || {}).join(' '),row.summary].some(value => String(value || '').toLowerCase().includes(query)));
  if (currentFilter.days !== 9999) rows = rows.filter(row => new Date(row.date).getTime() >= Date.now() - currentFilter.days * 86400000);
  if (currentFilter.attachments) rows = rows.filter(row => row.attachments?.length);
  rows.sort((a,b) => (currentFilter.sort === 'date-asc' ? 1 : -1) * (new Date(a.date || 0) - new Date(b.date || 0)));
  renderEmailList(rows, {silent});
  document.getElementById('list-title').textContent = specialMailbox === 'drafts' ? (mailaiT('side.drafts') || '草稿箱') : (mailaiT('side.sent') || '已发送');
  document.getElementById('list-count').textContent = rows.length + (specialMailbox === 'drafts' ? (mailaiT('list.countDraft') || ' 封草稿') : (mailaiT('list.countMail') || ' 封'));
}

// ===== 渲染邮件列表 =====
function mailListSignature(emails) {
  return JSON.stringify({
    context:[specialMailbox, unifiedMailbox, mailRenderLimit, selectedEmailId, selectedEmailAccountId, [...selectedMailIds].sort((a,b)=>a-b)],
    rows:emails.slice(0, mailRenderLimit).map(e => [
      e.id, e._account_id, e._account_user, e._kind, e.status, e.direction, e.is_read,
      e.is_favorite, e.is_starred, e.score, e.verdict, e.feedback, e.reviewed,
      e.pending_action, e.pending_error, e.recommended_status, e.counterpart_name,
      e.counterpart_addr, e.counterpart_count, e.from_name, e.from_addr, e.date,
      e.subject, e.summary, e.snippet, e.category, e.priority,
      (e.attachments || []).length,
    ]),
  });
}

function renderEmailList(emails, {silent = false} = {}) {
  const container = document.getElementById('email-list');
  renderedEmailIds = emails.filter(item => !item._kind).map(item => Number(item.id));
  const visibleEmails = emails.slice(0, mailRenderLimit);
  reconcileReadingPane(emails);
  const visibleIds = new Set(renderedEmailIds);
  selectedMailIds.forEach(id => { if (!visibleIds.has(Number(id))) selectedMailIds.delete(id); });
  const signature = mailListSignature(emails);
  if (silent && signature === emailListRenderSignature) {
    updateBulkToolbar();
    return;
  }
  const scrollTop = silent ? container.scrollTop : 0;
  const focused = silent ? document.activeElement?.closest?.('#email-list .email-item') : null;
  const focusedId = focused?.dataset.id || '';
  const focusedAccountId = focused?.dataset.accountId || '';
  container.classList.toggle('silent-refresh', silent);
  emailListRenderSignature = signature;
  if (!emails.length) {
    container.innerHTML = `<div class="email-empty">
      <div class="empty-icon empty-mail-icon" aria-hidden="true"><svg viewBox="0 0 64 64"><rect x="10" y="16" width="44" height="34" rx="10"/><path d="m14 22 18 14 18-14M17 46l10-9M47 46l-10-9"/><path class="empty-mail-spark" d="M49 9v6M46 12h6"/></svg></div>
      <div class="empty-text"><strong>这里暂时没有邮件</strong><small>换个文件夹或筛选条件看看</small></div>
    </div>`;
    updateBulkToolbar();
    if (silent) container.scrollTop = scrollTop;
    return;
  }

  // 完整年月日作为身份，避免不同年份的同月同日被合并。
  const groups = new Map();
  visibleEmails.forEach(e => {
    const group = mailDateGroup(e.date || e.created_at || '');
    if (!groups.has(group.key)) groups.set(group.key, {label:group.label, items:[]});
    groups.get(group.key).items.push(e);
  });

  container.innerHTML = [...groups.values()].map(group => {
    const items = group.items;
    return `
      <div class="email-group">
        <div class="group-header">
          <span class="group-title">${esc(group.label)}</span>
          <span class="group-count">${items.length}${mailaiT('list.countMail') || ' 封'}</span>
        </div>
        ${items.map((e, i) => renderEmailItem(e, i)).join('')}
      </div>
    `;
  }).join('') + (emails.length > visibleEmails.length ? `
    <button type="button" class="email-render-more" data-render-more-mail>
      ${mailaiT('list.showMore') || '显示更多'} <small>${(mailaiT('list.showMoreCount') || '还有 {n} 封').replace('{n}', emails.length - visibleEmails.length)}</small>
    </button>` : '');

  container.querySelectorAll('.email-item').forEach(item => {
    item.addEventListener('click', event => {
      const id = Number(item.dataset.id);
      if (!specialMailbox && !unifiedMailbox && (event.metaKey || event.ctrlKey || event.shiftKey)) {
        event.preventDefault();
        if (event.shiftKey) selectMailRange(id, event.metaKey || event.ctrlKey);
        else toggleMailSelection(id);
        return;
      }
      if (selectedMailIds.size) clearMailSelection();
      if (!specialMailbox && !unifiedMailbox) selectionAnchorId = id;
      specialMailbox ? selectSpecialMessage(id) : unifiedMailbox ? selectUnifiedEmail(id, item.dataset.accountId) : selectEmail(id);
    });
    item.addEventListener('contextmenu', event => {
      if (specialMailbox || unifiedMailbox) return;
      event.preventDefault();
      const id = Number(item.dataset.id);
      if (!selectedMailIds.has(id)) {
        if (!(event.metaKey || event.ctrlKey)) selectedMailIds.clear();
        selectedMailIds.add(id);
        selectionAnchorId = id;
        bulkStackFocusId = id;
        syncBulkSelectionVisuals();
      }
      showMailContextMenu(event.clientX, event.clientY, id);
    });
    item.addEventListener('keydown', event => {
      const id = Number(item.dataset.id);
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!specialMailbox && !unifiedMailbox) selectionAnchorId = id;
        specialMailbox ? selectSpecialMessage(id) : unifiedMailbox ? selectUnifiedEmail(id, item.dataset.accountId) : selectEmail(id);
      } else if (event.key === ' ') {
        if (specialMailbox || unifiedMailbox) return;
        event.preventDefault();
        event.shiftKey ? selectMailRange(id, event.metaKey || event.ctrlKey) : toggleMailSelection(id);
      } else if (event.key === 'F10' && event.shiftKey && !specialMailbox && !unifiedMailbox) {
        event.preventDefault();
        const rect = item.getBoundingClientRect();
        if (!selectedMailIds.has(id)) {
          selectedMailIds.clear(); selectedMailIds.add(id); selectionAnchorId = id; bulkStackFocusId = id; syncBulkSelectionVisuals();
        }
        showMailContextMenu(rect.left + 24, rect.top + 24, id);
      }
    });
  });
  container.querySelector('[data-render-more-mail]')?.addEventListener('click', () => {
    mailRenderLimit += 240;
    renderEmailList(emails);
  });
  if (silent) {
    container.scrollTop = scrollTop;
    if (focusedId) container.querySelector(`.email-item[data-id="${CSS.escape(focusedId)}"][data-account-id="${CSS.escape(focusedAccountId)}"]`)?.focus({preventScroll:true});
  }
  syncBulkSelectionVisuals();
}

function shouldShowMailDirection() {
  if (currentFilter.status === 'inbox') return false;
  if (specialMailbox === 'sent' || specialMailbox === 'drafts') return false;
  if (!currentServerFolder) return true;
  return !['inbox', 'sent', 'drafts'].some(role =>
    serverFolderForRole(role)?.name === currentServerFolder
  );
}

// 后端 LLM 分类结果以固定中文枚举入库（见 app/llm/prompts.py），
// 英文界面在这里映射为译文；不在表内的自定义值原样展示。
function mailCategoryLabel(c) {
  const keys = {'项目工作':'cat.work','会议安排':'cat.meeting','审批流程':'cat.approval','系统通知':'cat.system','外部客户':'cat.client','人事行政':'cat.hr','订阅推送':'cat.subscription','个人':'cat.personal','其他':'cat.other'};
  return (keys[c] && mailaiT(keys[c])) || c;
}
function mailPriorityLabel(p) {
  const keys = {'高':'prio.high','中':'prio.medium','低':'prio.low'};
  return (keys[p] && mailaiT(keys[p])) || `${p}优先级`;
}

function renderEmailItem(e, idx = 0) {
  const risk = getRiskLabel(e.score, e.verdict, e);
  const selected = selectedEmailId === e.id ? 'selected' : '';
  const bulkSelected = selectedMailIds.has(Number(e.id)) ? 'bulk-selected' : '';
  const hasAtt = e.attachments && e.attachments.length > 0;
  const outgoing = e.direction === 'outgoing';
  // “已读/未读”只描述收到的邮件。服务端有时会给已发送文件夹返回
  // 未设置 Seen 的记录，不能据此把用户自己发出的邮件画成未读。
  const unread = !e._kind && !outgoing && !e.is_read;
  const counterparty = e.counterpart_name || e.counterpart_addr || e.from_name || e.from_addr || '未知联系人';
  const counterpartyAddr = e.counterpart_addr || e.from_addr || '';
  const domain = getDomain(counterpartyAddr);
  const directionTitle = outgoing
    ? `你是发件人，邮件发给 ${counterpartyAddr || counterparty}`
    : `你是收件人，邮件来自 ${counterpartyAddr || counterparty}`;
  const directionIcon = outgoing
    ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 11v4.5h12V11"/><path d="M10 12V3.5m0 0L6.8 6.7M10 3.5l3.2 3.2"/></svg>'
    : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 11v4.5h12V11"/><path d="M10 3.5V12m0 0L6.8 8.8M10 12l3.2-3.2"/></svg>';
  const directionBadge = shouldShowMailDirection()
    ? `<span class="mail-direction ${outgoing ? 'outgoing' : 'incoming'}" title="${esc(directionTitle)}" aria-label="${esc(directionTitle)}">${directionIcon}</span>`
    : '';
  const moreRecipients = outgoing && Number(e.counterpart_count || 0) > 1
    ? `<span class="recipient-more">等 ${Number(e.counterpart_count)} 人</span>` : '';
  return `
    <div class="email-item ${selected} ${bulkSelected} ${e.status} ${outgoing ? 'outgoing-mail' : ''} ${unread ? 'unread' : ''} risk-${risk.class}" data-id="${e.id}" data-account-id="${esc(e._account_id || '')}" data-read-state="${outgoing ? 'not-applicable' : unread ? 'unread' : 'read'}" tabindex="0" aria-selected="${bulkSelected ? 'true' : 'false'}" style="animation-delay:${Math.min(idx, 12) * 0.035}s">
      <div class="email-row-top">
        <div class="email-sender">
          ${unread ? '<span class="unread-marker" title="未读邮件" aria-label="未读"></span>' : ''}
          ${directionBadge}
          <span class="sender-name" title="${esc(counterpartyAddr || counterparty)}">${esc(counterparty)}</span>
          ${moreRecipients}
          ${domain ? `<span class="sender-domain">${esc(domain)}</span>` : ''}
        </div>
        <div class="email-meta">
          <span class="mail-state-icons">${e.is_favorite ? '<span class="mail-state-star" title="已收藏">★</span>' : ''}${e.is_starred ? '<span class="mail-state-star" title="已加星标">★</span>' : ''}</span>
          ${e._kind === 'draft' ? '<span class="risk-badge normal">草稿</span>' : e._kind === 'sent' ? `<span class="risk-badge ${['failed','unknown'].includes(e.status) ? 'high' : 'normal'}">${({failed:'失败',unknown:'待确认',sending:'发送中',sent:'已发送',accepted:'已接受'})[e.status] || '待确认'}</span>` : `<span class="risk-badge ${risk.class}">${risk.class === 'danger' ? '<i class="risk-alert-dot" aria-hidden="true">!</i>' : ''}${risk.text} ${e.score}</span>`}${e.pending_action ? `<span class="tag">${e.pending_error ? '删除同步失败，将重试' : e.pending_action === 'trash' ? '待同步删除 · 可取消' : '正在同步删除'}</span>` : ''}
          <span class="email-date">${fmtDate(e.date)}</span>
        </div>
      </div>
      <div class="email-subject">${esc(e.subject)}</div>
      <div class="email-preview">${esc(e.summary || e.snippet || '').slice(0, 120)}${(e.summary || e.snippet || '').length > 120 ? '…' : ''}</div>
      <div class="email-tags">
        ${unifiedMailbox && e._account_user ? `<span class="mail-account-tag" title="所属邮箱 ${esc(e._account_user)}">${esc(e._account_user)}</span>` : ''}
        ${e.category ? `<span class="tag">${esc(mailCategoryLabel(e.category))}</span>` : ''}
        ${e.priority ? `<span class="tag tag-priority-${e.priority}">${esc(mailPriorityLabel(e.priority))}</span>` : ''}
        ${hasAtt ? `<span class="tag tag-attachment">📎 ${mailaiT('list.tagAttachment') || '附件'}</span>` : ''}
        ${e.status === 'quarantine' ? '<span class="tag tag-danger">已隔离</span>' : ''}
        ${e.status === 'spam' ? '<span class="tag tag-warn">垃圾邮件</span>' : ''}
        ${e.status === 'inbox' && needsRiskAttention(e) && e.recommended_status === 'quarantine' ? '<span class="tag tag-danger">待确认隔离</span>' : ''}
        ${e.status === 'inbox' && needsRiskAttention(e) && e.recommended_status === 'spam' ? '<span class="tag tag-warn">待确认垃圾</span>' : ''}
      </div>
    </div>
  `;
}

// ===== 阅读区 =====
async function selectSpecialMessage(id) {  const kind = specialMailbox;
  let row = kind === 'drafts' ? savedDrafts.find(x => x.id === id) : sentMessages.find(x => x.id === id);
  if (!row) return;
  if (!row._remote) {
    try {
      row = await api(kind === 'drafts' ? `/api/drafts/${id}` : `/api/mail/sent/${id}`);
    } catch (error) {
      toast('加载邮件详情失败：' + error.message, 'error');
      return;
    }
  }
  readingLoadRevision += 1;
  readingLoadController?.abort();
  readingLoadController = null;
  selectedEmailId = id;
  selectedEmailDetail = null;
  syncSelectedEmailVisual(id);
  const readingPane = document.querySelector('.reading-pane');
  readingPane.classList.add('show');
  readingPane.scrollTop = 0;
  document.getElementById('reading-empty').classList.add('hidden');
  const pane = document.getElementById('reading-content');
  pane.classList.remove('hidden');
  const displayRecipientField = value => {
    const addresses = recipientEmails(value);
    if (!addresses.length) return value || '';
    return addresses.map(address => {
      const name = row.recipient_names?.[address.toLowerCase()];
      return name ? `${name} <${address}>` : address;
    }).join(', ');
  };
  const recipients = [displayRecipientField(row.to_addr), row.cc_addr && `抄送：${displayRecipientField(row.cc_addr)}`, row.bcc_addr && `密送：${displayRecipientField(row.bcc_addr)}`].filter(Boolean).join(' · ');
  const failed = kind === 'sent' && row.status === 'failed';
  const originLabel = row._remote ? (kind === 'drafts' ? '服务器草稿' : '服务器已发送邮件') : (kind === 'drafts' ? '本地草稿' : failed ? '发送失败' : row.status === 'unknown' ? '发送结果待确认，请在任务与发件箱中核对' : row.status === 'sending' ? '正在发送' : '已发送邮件');
  const specialAttachments = (row.attachments || []).length ? `<div class="special-mail-attachments">
    <b>附件</b><div class="special-mail-attachment-list">${row.attachments.map((item, index) => row._remote
      ? `<a class="special-mail-attachment-item" href="${mailboxResourceUrl(`/api/emails/${row.remote_email_id}/attachments/${index}`)}" download><span class="special-mail-attachment-name">${esc(item.name || item.filename || '未命名附件')}</span><small>${formatFileSize(item.size || 0)} · 下载</small></a>`
      : kind === 'sent' ? `<a class="special-mail-attachment-item" href="${mailboxResourceUrl(`/api/mail/sent/${row.id}/attachments/${index}`)}" download="${esc(item.filename || item.name || '附件')}" title="预览附件，可下载原文件"><span class="special-mail-attachment-name">${esc(item.filename || item.name || '未命名附件')}</span><small>${formatFileSize(item.size || 0)} · 预览 / 下载</small></a>`
      : `<span class="special-mail-attachment-item"><span class="special-mail-attachment-name">${esc(item.filename || item.name || '未命名附件')}</span><small>${formatFileSize(item.size || 0)}</small></span>`).join('')}</div>
    </div>` : '';
  pane.innerHTML = `<div class="special-mail-detail">
    <div class="special-mail-actions">${kind === 'drafts' ? '<button class="action-btn action-primary compact" id="btn-edit-special"><svg viewBox="0 0 20 20"><path d="m4 14.5-.5 2 2-.5L15 6.5 13.5 5 4 14.5ZM12 6.5l1.5 1.5"/></svg>继续编辑</button><button class="action-btn compact" id="btn-delete-special"><svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2m-6 0 1 10h6l1-10M9 9v4m2-4v4"/></svg>舍弃草稿</button>' : failed ? '<button class="action-btn action-primary compact" id="btn-edit-special"><svg viewBox="0 0 20 20"><path d="m4 14.5-.5 2 2-.5L15 6.5 13.5 5 4 14.5Z"/></svg>重新编辑</button>' : (row._remote || ['sent','accepted'].includes(row.status)) ? '<button class="action-btn action-primary compact" id="btn-edit-special">再次编辑</button>' : ''}</div>
    <span class="eyebrow">${originLabel}</span>
    <h1>${esc(row.subject || '（无主题）')}</h1>
    <div class="special-mail-meta"><b>${kind === 'drafts' ? '收件人' : '发送至'}：</b>${esc(recipients || '尚未填写')}<br><b>时间：</b>${esc(fmtDate(row.sent_at || row.updated_at || row.created_at))}</div>
    ${failed ? `<div class="special-mail-error"><b>失败原因：</b>${esc(row.error || '未知错误')}</div>` : ''}
    ${specialAttachments}
    <article class="special-mail-body" id="special-mail-body"></article>
  </div>`;
  const bodyHost = document.getElementById('special-mail-body');
  if (row.body_html) {
    const frame = document.createElement('iframe');
    frame.className = 'rich-email-frame';
    frame.setAttribute('sandbox', 'allow-same-origin allow-top-navigation-to-custom-protocols');
    frame.setAttribute('title', originLabel + '正文');
    frame.setAttribute('scrolling', 'no');
    autoSizeRichEmailFrame(frame);
    frame.srcdoc = richEmailDocument(row.body_html, true);
    bodyHost.replaceChildren(frame);
  } else {
    bodyHost.textContent = row.body_text || '暂无正文';
  }
  document.getElementById('btn-edit-special')?.addEventListener('click', async () => {
    if (kind === 'sent') {
      const accountId = activeMailAccount()?.id, revision = readingLoadRevision;
      const editButton = document.getElementById('btn-edit-special');
      if (editButton.disabled) return;
      editButton.disabled = true;
      try {
        const attachments = [];
        for (const [index, item] of (row.attachments || []).entries()) {
          if (!row._remote) {
            if (typeof item.data_base64 !== 'string') throw new Error('附件内容缺失，请下载核对后重新添加');
            attachments.push({...item});
          } else {
            const response = await fetch(mailboxResourceUrl(`/api/emails/${row.remote_email_id}/attachments/${index}`, accountId));
            if (!response.ok) throw new Error('原附件读取失败，请重试');
            const file = await response.blob();
            attachments.push({filename:item.name || item.filename, size:file.size, content_type:file.type, data_base64:await readFileAsBase64(file)});
          }
        }
        if (accountId !== activeMailAccount()?.id || revision !== readingLoadRevision) return;
        openCompose({...row, account_id:accountId, id:null, source_draft_email_id:null, attachments, mode:'compose'});
        toast('已打开新邮件，请修改并核对收件人后发送', 'success');
      } catch (error) { toast(error.message, 'error'); }
      finally { editButton.disabled = false; }
      return;
    }
    if (row._remote && (row.attachments || []).length) toast('服务器草稿的原附件不会自动带入，请重新添加后再发送', 'warn');
    openCompose({...row, attachments:row._remote ? [] : row.attachments,
      source_draft_email_id:kind === 'drafts' && row._remote ? row.remote_email_id : row.source_draft_email_id,
      id:kind === 'drafts' && !row._remote ? row.id : null});
  });
  document.getElementById('btn-delete-special')?.addEventListener('click', async () => {
    if (!window.confirm(row._remote ? '确认将这封服务器草稿移入垃圾箱？' : '确认舍弃这封本地草稿？')) return;
    try {
      await api('/api/drafts/' + row.id, {method:'DELETE'});
      savedDrafts = await api('/api/drafts');
      resetReadingPane();
      renderSpecialMailbox(); updateSidebar();
      toast(row._remote ? '服务器草稿已移入垃圾箱' : '草稿已舍弃', 'success');
    } catch (err) { toast('舍弃草稿失败：' + err.message, 'error'); }
  });
}

function syncBulkSelectionVisuals() {
  const revision = ++bulkVisualRevision;
  const items = [...document.querySelectorAll('.email-item')];
  let cursor = 0;
  const paint = () => {
    if (revision !== bulkVisualRevision) return;
    const end = Math.min(cursor + 80, items.length);
    for (; cursor < end; cursor += 1) {
      const item = items[cursor];
      const chosen = selectedMailIds.has(Number(item.dataset.id));
      item.classList.toggle('bulk-selected', chosen);
      item.setAttribute('aria-selected', chosen ? 'true' : 'false');
    }
    if (cursor < items.length) {
      (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(paint);
    }
  };
  paint();
  updateBulkToolbar();
}

function clearMailSelection() {
  if (bulkOperationActive) return;
  selectedMailIds.clear();
  selectionAnchorId = null;
  bulkStackFocusId = null;
  syncBulkSelectionVisuals();
}

function toggleMailSelection(id) {
  if (bulkOperationActive) return;
  if (selectedMailIds.has(id)) selectedMailIds.delete(id);
  else selectedMailIds.add(id);
  selectionAnchorId = id;
  bulkStackFocusId = id;
  syncBulkSelectionVisuals();
}

function selectMailRange(id, additive = false) {
  if (bulkOperationActive) return;
  const end = renderedEmailIds.indexOf(Number(id));
  let start = renderedEmailIds.indexOf(Number(selectionAnchorId));
  if (end < 0) return;
  if (start < 0) { start = end; selectionAnchorId = id; }
  if (!additive) selectedMailIds.clear();
  const [from, to] = start <= end ? [start, end] : [end, start];
  renderedEmailIds.slice(from, to + 1).forEach(mailId => selectedMailIds.add(mailId));
  if (selectionAnchorId === null) selectionAnchorId = id;
  bulkStackFocusId = id;
  syncBulkSelectionVisuals();
}

function selectAllVisibleMail() {
  if (unifiedMailbox) return toast('请先选择左侧的具体邮箱，再批量处理邮件', 'warn');
  if (bulkOperationActive || specialMailbox || !renderedEmailIds.length) return;
  renderedEmailIds.forEach(id => selectedMailIds.add(id));
  selectionAnchorId = renderedEmailIds[0];
  bulkStackFocusId = renderedEmailIds[0];
  syncBulkSelectionVisuals();
}

function mailContextIcon(path) {
  return `<svg viewBox="0 0 20 20" aria-hidden="true">${path}</svg>`;
}

function hideMailContextMenu() {
  const menu = document.getElementById('mail-context-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  menu.setAttribute('aria-hidden', 'true');
}

function ensureMailContextMenu() {
  let menu = document.getElementById('mail-context-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'mail-context-menu';
  menu.className = 'mail-context-menu hidden';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-hidden', 'true');
  document.body.appendChild(menu);
  menu.addEventListener('click', async event => {
    const folderButton = event.target.closest('[data-context-folder]');
    if (folderButton) {
      const folder = folderButton.dataset.contextFolder;
      hideMailContextMenu();
      await runBulkAction('move', folder);
      return;
    }
    const button = event.target.closest('[data-context-action]');
    if (!button) return;
    const action = button.dataset.contextAction;
    const id = Number(menu.dataset.contextId);
    if (action === 'folders') {
      menu.querySelector('.mail-context-folders')?.classList.toggle('hidden');
      return;
    }
    hideMailContextMenu();
    if (action === 'open') { await selectEmail(id); return; }
    if (['reply', 'reply_all', 'forward'].includes(action)) {
      await selectEmail(id);
      await composeFromEmail(action);
      return;
    }
    if (action === 'select-all') { selectAllVisibleMail(); return; }
    if (action === 'clear') { clearMailSelection(); return; }
    await runBulkAction(action);
  });
  return menu;
}

function showMailContextMenu(x, y, id) {
  const menu = ensureMailContextMenu();
  const row = allEmails.find(item => Number(item.id) === Number(id)) || {};
  const count = selectedMailIds.size;
  const inTrash = currentFilter.status === 'trash' || row.status === 'trash';
  const pendingTrash = row.pending_action || (inTrash && [...selectedMailIds].some(id => allEmails.find(e => Number(e.id) === Number(id))?.pending_action));
  const folderOptions = mailboxFolders.filter(folder => folder.selectable !== false).map(folder =>
    `<button type="button" role="menuitem" data-context-folder="${esc(folder.name)}">${mailContextIcon('<path d="M3.5 6h5l1.5 2h6.5v8h-13z"/>')}<span>${esc(folder.name)}</span></button>`
  ).join('');
  const readStateActions = count > 1
    ? `<button type="button" role="menuitem" data-context-action="read">${mailContextIcon('<path d="M3.5 5.5h13v9h-13zM4.5 7l5.5 4 5.5-4"/>')}<span>标记为已读</span></button>
       <button type="button" role="menuitem" data-context-action="unread">${mailContextIcon('<path d="M3.5 5.5h13v9h-13zM4.5 7l5.5 4 5.5-4M14.5 3.5h2"/>')}<span>标记为未读</span></button>`
    : `<button type="button" role="menuitem" data-context-action="${row.is_read ? 'unread' : 'read'}">${mailContextIcon('<path d="M3.5 5.5h13v9h-13zM4.5 7l5.5 4 5.5-4"/>')}<span>${row.is_read ? '标记为未读' : '标记为已读'}</span></button>`;
  menu.dataset.contextId = id;
  menu.innerHTML = `
    <div class="mail-context-summary">${count > 1 ? `已选 ${count} 封邮件` : '邮件操作'}<small>${count > 1 ? '以下操作将应用到所选邮件' : '右键快捷操作'}</small></div>
    ${count === 1 ? `
      <button type="button" role="menuitem" data-context-action="open">${mailContextIcon('<path d="M3.5 5.5h13v9h-13zM5 7l5 4 5-4"/>')}<span>打开邮件</span><kbd>↵</kbd></button>
      <button type="button" role="menuitem" data-context-action="reply">${mailContextIcon('<path d="M8 5 3.5 9 8 13M4 9h6c3.5 0 5.5 1.8 6.5 5"/>')}<span>回复</span></button>
      <button type="button" role="menuitem" data-context-action="reply_all">${mailContextIcon('<path d="m9 5-4 4 4 4M5 9h5c3.5 0 5.5 1.8 6.5 5M5.5 5 2 8.2l2 1.7"/>')}<span>回复全部</span></button>
      <button type="button" role="menuitem" data-context-action="forward">${mailContextIcon('<path d="m12 5 4.5 4-4.5 4M16 9h-6c-3.5 0-5.5 1.8-6.5 5"/>')}<span>转发</span></button>
      <div class="mail-context-separator"></div>` : ''}
    ${inTrash ? `<button type="button" role="menuitem" ${pendingTrash ? 'data-context-action="cancel_trash"' : `data-context-folder="${esc(serverFolderForRole('inbox')?.name || 'INBOX')}"`}><span>${pendingTrash ? '取消删除（恢复原位置）' : '恢复到收件箱'}</span></button>` : ''}
    ${readStateActions}
    <button type="button" role="menuitem" data-context-action="star">${mailContextIcon('<path d="m10 3 2.1 4.2 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7-3.4-3.3 4.7-.7z"/>')}<span>添加星标</span></button>
    <div class="mail-context-separator"></div>
    <button type="button" role="menuitem" data-context-action="folders">${mailContextIcon('<path d="M3.5 6h5l1.5 2h6.5v8h-13z"/>')}<span>移动到文件夹</span><b>›</b></button>
    <div class="mail-context-folders hidden">${folderOptions || '<small>暂无可用文件夹</small>'}</div>
    ${!inTrash ? `<button type="button" class="danger" role="menuitem" data-context-action="trash">${mailContextIcon('<path d="M4 6h12M7 6V4h6v2M6 8l.7 8h6.6l.7-8M8.5 9.5v4M11.5 9.5v4"/>')}<span>移入已删除</span></button>` : '<div class="mail-context-summary"><small>已在回收站，可恢复；此处不执行永久删除</small></div>'}
    <div class="mail-context-separator"></div>
    <button type="button" role="menuitem" data-context-action="select-all">${mailContextIcon('<path d="M4 4h12v12H4zM7 10l2 2 4-4"/>')}<span>全选当前列表</span><kbd>⌘A</kbd></button>
    ${count > 1 ? `<button type="button" role="menuitem" data-context-action="clear">${mailContextIcon('<path d="m6 6 8 8M14 6l-8 8"/>')}<span>取消选择</span><kbd>Esc</kbd></button>` : ''}`;
  menu.classList.remove('hidden');
  menu.setAttribute('aria-hidden', 'false');
  menu.style.left = '0px'; menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  menu.querySelector('button')?.focus();
}

function updateBulkToolbar() {
  const toolbar = document.getElementById('bulk-toolbar');
  toolbar.querySelector('[data-bulk-action="trash"]')?.classList.toggle('hidden', currentFilter.status === 'trash');
  toolbar.classList.toggle('hidden', (!selectedMailIds.size && !bulkOperationActive) || !!specialMailbox);
  if (!bulkOperationActive) document.getElementById('bulk-count').textContent = `已选 ${selectedMailIds.size} 封`;
  document.querySelector('.list-pane')?.classList.toggle('selection-active', !!selectedMailIds.size && !specialMailbox);
  syncReadingSelectionStack();
}

function syncReadingSelectionStack() {
  const pane = document.getElementById('reading-pane');
  if (!pane) return;
  let stack = pane.querySelector('.reading-selection-stack');
  const ids = specialMailbox || unifiedMailbox ? [] : [...selectedMailIds];
  if (ids.length < 2) {
    bulkStackPreviewController?.abort();
    bulkStackPreviewController = null;
    stack?.remove();
    pane.classList.remove('bulk-stack-active');
    return;
  }
  const focus = ids.includes(bulkStackFocusId) ? bulkStackFocusId : ids.at(-1);
  const signature = `${ids.join(',')}|${focus}`;
  if (stack?.dataset.selection === signature) return;
  const previous = stack?.dataset.selection?.split('|')[0].split(',') || [];
  const newest = String(focus);
  const arriving = !previous.includes(newest);
  const cards = [...ids.filter(id => id !== focus).slice(-3), focus].map((id, index, visible) => {
    const row = allEmails.find(email => Number(email.id) === Number(id)) || {};
    const sender = row.from_name || row.from_addr || row.sender || '发件人';
    const subject = row.subject || '无主题';
    const offset = visible.length - index - 1;
    return `<div class="reading-selection-sheet${offset === 0 && arriving ? ' arriving' : ''}" data-depth="${offset}" aria-hidden="${offset ? 'true' : 'false'}">
      ${offset === 0 ? `<div class="reading-selection-sheet-head"><span>${esc(String(sender).charAt(0))}</span><div><b>${esc(sender)}</b><small>${esc(row.from_addr || '')}</small></div><time>${esc(fmtDate(row.date || row.created_at || ''))}</time></div>
      <div class="reading-selection-sheet-content"><h3>${esc(subject)}</h3><div class="reading-selection-sheet-preview" data-stack-body>${esc(row.body_text || row.summary || row.snippet || '正在读取邮件预览…')}</div></div>` : `<div class="reading-selection-sheet-edge"><b>${esc(sender)}</b><small>${esc(subject)}</small></div>`}
    </div>`;
  }).join('');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'reading-selection-stack';
    stack.setAttribute('role', 'status');
    pane.appendChild(stack);
  }
  stack.dataset.selection = signature;
  stack.innerHTML = `<div class="reading-selection-stack-inner"><div class="reading-selection-stack-heading"><strong>已选择 ${ids.length} 封邮件</strong><span>预览最后选入的邮件</span></div><div class="reading-selection-deck">${cards}</div><p>可在左侧继续选择，或使用批量操作</p></div>`;
  pane.classList.add('bulk-stack-active');
  pane.scrollTop = 0;
  loadReadingSelectionPreview(focus, stack);
}

async function loadReadingSelectionPreview(id, stack) {
  bulkStackPreviewController?.abort();
  const accountId = activeMailAccount()?.id || '';
  const key = `${accountId}:${id}`;
  const body = stack.querySelector('[data-stack-body]');
  if (!body) return;
  const cached = bulkStackPreviewCache.get(key);
  if (cached) { body.textContent = cached; return; }
  const controller = new AbortController();
  bulkStackPreviewController = controller;
  try {
    const mail = await api(`/api/emails/${id}`, {accountId, signal:controller.signal});
    if (controller.signal.aborted || !stack.isConnected || !selectedMailIds.has(id) || stack.querySelector('[data-stack-body]') !== body) return;
    const preview = String(mail.body_text || mail.summary || mail.snippet || '').trim().slice(0, 4000);
    if (preview) {
      body.textContent = preview;
      bulkStackPreviewCache.set(key, preview);
      if (bulkStackPreviewCache.size > 24) bulkStackPreviewCache.delete(bulkStackPreviewCache.keys().next().value);
    }
  } catch (_) { /* The list summary remains visible when detail is unavailable. */ }
  finally { if (bulkStackPreviewController === controller) bulkStackPreviewController = null; }
}

function setBulkOperationState(active, label = '', count = selectedMailIds.size) {
  bulkOperationActive = active;
  const toolbar = document.getElementById('bulk-toolbar');
  toolbar.classList.toggle('busy', active);
  toolbar.setAttribute('aria-busy', active ? 'true' : 'false');
  toolbar.querySelectorAll('button, select').forEach(control => { control.disabled = active; });
  if (active) {
    toolbar.classList.remove('hidden');
    document.getElementById('bulk-count').textContent = `${label} ${count} 封…`;
  } else {
    updateBulkToolbar();
  }
}

async function runBulkAction(action, target = '') {
  if (unifiedMailbox) return toast('请先选择具体邮箱，再批量处理邮件', 'warn');
  if (bulkOperationActive || !selectedMailIds.size) return;
  if (action === 'trash' && (currentFilter.status === 'trash' || [...selectedMailIds].some(id => allEmails.find(e => Number(e.id) === Number(id))?.status === 'trash'))) return toast('邮件已在已删除中，请使用恢复操作', 'warn');
  const payload = {ids:[...selectedMailIds], action:action === 'unread' ? 'read' : action,
                   value:action === 'unread' ? false : true, target};
  const count = selectedMailIds.size;
  const actionLabel = action === 'read' ? '正在标为已读' : action === 'unread' ? '正在标为未读' :
    action === 'star' ? '正在添加星标' : action === 'trash' ? '正在移入垃圾箱' : `正在移动到“${target}”`;
  setBulkOperationState(true, actionLabel, count);
  try {
    const result = {completed:0, failed:[]};
    const accountId = activeMailAccount()?.id;
    for (let start = 0; start < payload.ids.length; start += 100) {
      const batch = payload.ids.slice(start, start + 100);
      setBulkOperationState(true, `${actionLabel} · ${start}/${count}`, count);
      try {
        const part = await api('/api/emails/bulk', {accountId, method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload, ids:batch})});
        result.completed += part.completed; result.failed.push(...part.failed);
        if (action === 'read' || action === 'unread') {
          const failedIds = new Set((part.failed || []).map(item => Number(item.id)));
          for (const id of batch) {
            if (!failedIds.has(Number(id))) setLocalEmailReadState(id, accountId, action === 'read');
          }
        }
      } catch (error) { result.failed.push(...batch.map(id => ({id, error:error.message}))); }
    }
    const completedText = action === 'trash'
      ? `已移入已删除 ${result.completed} 封，可在那里取消删除；稍后同步服务器`
      : action === 'read' || action === 'unread'
        ? `已标记 ${result.completed} 封邮件，服务器将在后台同步`
        : `已处理 ${result.completed} 封邮件`;
    toast(`${completedText}${result.failed.length ? `，失败 ${result.failed.length} 封` : ''}`, result.failed.length ? 'warn' : 'success');
    selectedMailIds = new Set(result.failed.map(item => item.id)); selectionAnchorId = null; await loadData();
    if (result.failed.length && typeof showOperationFailures === 'function') showOperationFailures(result.failed, async () => {
      if (activeMailAccount()?.id !== accountId) await openAccountMailbox(accountId, 'inbox');
      selectedMailIds = new Set(result.failed.map(item => item.id));
      return runBulkAction(payload.action === 'read' && payload.value === false ? 'unread' : payload.action, target);
    });
  } catch (err) {
    toast('批量操作失败：' + err.message, 'error');
  } finally {
    setBulkOperationState(false);
  }
}

function readSyncKey(id, accountId) {
  return `${accountId || 'default'}:${Number(id)}`;
}

function setLocalEmailReadState(id, accountId, isRead) {
  const activeAccountId = activeMailAccount()?.id || '';
  const stillInAccount = activeAccountId === accountId;
  const local = allEmails.find(item => Number(item.id) === Number(id) &&
    (item._account_id ? item._account_id === accountId : stillInAccount));
  const changed = Boolean(local) && Boolean(local.is_read) !== Boolean(isRead);
  if (local) local.is_read = isRead ? 1 : 0;
  for (const row of searchResults || []) {
    if (Number(row.id) === Number(id) && (row._account_id ? row._account_id === accountId : stillInAccount)) row.is_read = isRead ? 1 : 0;
  }
  const selectedMatchesAccount = selectedEmailAccountId
    ? selectedEmailAccountId === accountId : stillInAccount;
  if (selectedEmailDetail && Number(selectedEmailId) === Number(id) && selectedMatchesAccount) {
    selectedEmailDetail.is_read = isRead ? 1 : 0;
  }
  if (!unifiedMailbox && !stillInAccount) return;
  const listItem = unifiedMailbox
    ? document.querySelector(`.email-item[data-id="${id}"][data-account-id="${CSS.escape(accountId)}"]`)
    : document.querySelector(`.email-item[data-id="${id}"]`);
  listItem?.classList.toggle('unread', !isRead);
  if (listItem) listItem.dataset.readState = isRead ? 'read' : 'unread';
  const marker = listItem?.querySelector('.unread-marker');
  if (isRead) marker?.remove();
  else if (listItem && !marker) {
    listItem.querySelector('.email-sender')?.insertAdjacentHTML(
      'afterbegin', '<span class="unread-marker" title="未读邮件" aria-label="未读"></span>'
    );
  }
  // Account unread badges come from /api/system/config, which is intentionally
  // polled only once a minute. Keep them in sync with the optimistic local
  // state so opening a message updates every visible unread indicator now.
  if (changed && typeof _systemConfig !== 'undefined' && _systemConfig?.accounts) {
    const account = _systemConfig.accounts.find(item => item.id === accountId) ||
      (stillInAccount ? _systemConfig.accounts.find(item => item.active) : null);
    if (account) {
      const delta = isRead ? -1 : 1;
      account.unread = Math.max(0, Number(account.unread || 0) + delta);
      if (typeof renderSidebarAccounts === 'function') renderSidebarAccounts();
    }
  }
  if (currentFilter.unread) applyFilters();
}

async function drainEmailReadSyncQueue() {
  if (readSyncRunning) return;
  readSyncRunning = true;
  try {
    while (readSyncQueue.length) {
      const job = readSyncQueue.shift();
      const key = readSyncKey(job.id, job.accountId);
      if (readSyncJobs.get(key)?.token !== job.token) continue;
      job.attempt += 1;
      try {
        await api(`/api/emails/${job.id}/read?value=true`, {method:'POST', accountId:job.accountId});
        readSyncJobs.delete(key);
      } catch (error) {
        if (job.attempt < 3) {
          if (job.attempt === 1) toast('邮箱服务器暂时无法同步已读，将自动重试', 'warn');
          job.timer = setTimeout(() => {
            job.timer = null;
            readSyncQueue.push(job);
            void drainEmailReadSyncQueue();
          }, job.attempt * 5000);
          continue;
        }
        readSyncJobs.delete(key);
        setLocalEmailReadState(job.id, job.accountId, false);
        toast('已读状态同步失败，网络恢复后重新打开该邮件即可重试', 'error');
      }
    }
  } finally {
    readSyncRunning = false;
    if (readSyncQueue.length) void drainEmailReadSyncQueue();
  }
}

function queueEmailReadSync(id, accountId) {
  const key = readSyncKey(id, accountId);
  if (readSyncJobs.has(key)) {
    setLocalEmailReadState(id, accountId, true);
    return readSyncJobs.get(key);
  }
  const job = {id:Number(id), accountId, attempt:0, timer:null, token:++readSyncSequence};
  readSyncJobs.set(key, job);
  setLocalEmailReadState(job.id, accountId, true);
  readSyncQueue.push(job);
  void drainEmailReadSyncQueue();
  return job;
}

function requestWasAborted(error, controller) {
  return Boolean(controller?.signal.aborted || error?.name === 'AbortError' ||
    /fetch is aborted|aborted/i.test(String(error?.message || '')));
}

async function selectEmail(id, options = {}) {
  const requestRevision = ++readingLoadRevision;
  const requestAccountId = options.accountId || activeMailAccount()?.id || '';
  readingLoadController?.abort();
  const controller = new AbortController();
  readingLoadController = controller;
  selectedEmailId = id;
  selectedEmailAccountId = options.accountId || '';
  selectedEmailDetail = null;
  syncSelectedEmailVisual(id, options);
  // A click is the user's read intent. Queue it before loading the detail so
  // rapid navigation cannot cancel the read action with the previous request.
  const clickedRow = allEmails.find(item => Number(item.id) === Number(id) &&
    (item._account_id ? item._account_id === requestAccountId : true));
  if (clickedRow && !clickedRow.is_read) queueEmailReadSync(id, requestAccountId);
  const readingPane = document.querySelector('.reading-pane');
  readingPane.classList.add('show');
  readingPane.scrollTop = 0;

  document.getElementById('reading-empty').classList.add('hidden');
  document.getElementById('reading-content').classList.remove('hidden');
  document.getElementById('reading-content').innerHTML = `<div class="reading-loading-skeleton" style="padding:22px">${skeletonRows(3)}</div>`;

  try {
    const e = await api('/api/emails/' + id, {accountId:requestAccountId, signal:controller.signal});
    if (requestRevision !== readingLoadRevision || selectedEmailId !== id) return;
    selectedEmailDetail = e;
    renderReadingPane(e);
    if (!e.is_read) queueEmailReadSync(id, requestAccountId);
  } catch (err) {
    if (requestWasAborted(err, controller)) return;
    if (requestRevision !== readingLoadRevision || selectedEmailId !== id) return;
    document.getElementById('reading-content').innerHTML = `<div class="reading-error">加载失败：${esc(err.message)}</div>`;
  } finally {
    if (readingLoadController === controller) readingLoadController = null;
  }
}

async function selectUnifiedEmail(id, accountId) {
  const row = allEmails.find(item => Number(item.id) === Number(id) && item._account_id === accountId);
  if (!row) return;
  if (accountId && accountId !== activeMailAccount()?.id) {
    try { await activateMailAccount(accountId, {keepMailbox:true, quiet:true}); }
    catch (err) { toast('无法打开该账号的邮件：' + err.message, 'error'); return; }
  }
  if (accountId && accountId !== activeMailAccount()?.id) return;
  await selectEmail(id, {accountId});
  if (selectedEmailDetail && selectedEmailId === id && selectedEmailAccountId === accountId) {
    selectedEmailDetail._account_id = accountId;
    selectedEmailDetail._account_user = row._account_user || '';
  }
}

function categoryIcon(category) {
  const c = String(category || '');
  let path;
  if (/项目|工作/.test(c)) path = '<path d="M3.5 6.5h13v9h-13zM7 6.5V4.2h6v2.3M3.5 10h13M8 10v1.5h4V10"/>';
  else if (/人事|行政/.test(c)) path = '<path d="M7.2 9a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 7.2 9ZM2.8 16c.3-3 2-4.6 4.4-4.6s4.1 1.6 4.4 4.6M13 7h4M15 5v4M13.2 12h3.6M13.2 15h3.6"/>';
  else if (/会议/.test(c)) path = '<path d="M4 5h12v10H4zM7 3.5v3M13 3.5v3M4 8h12M7 11h2M11 11h2"/>';
  else if (/系统|通知/.test(c)) path = '<path d="M5.2 8.2a4.8 4.8 0 0 1 9.6 0c0 4 1.5 4.4 1.5 5.4H3.7c0-1 1.5-1.4 1.5-5.4ZM8.2 16h3.6"/>';
  else if (/审批|流程/.test(c)) path = '<path d="M5 3.5h10v13H5zM8 3.5h4v2H8zM7.5 9.5l1.4 1.4 3.4-3.4M7.5 14h5"/>';
  else if (/客户|外部/.test(c)) path = '<path d="M6.5 9a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 6.5 9ZM2.5 16c.3-3 1.8-4.6 4-4.6s3.7 1.6 4 4.6M13.2 6.5h3.3M14.8 4.8v3.4M12.5 11.5h4v4h-4z"/>';
  else if (/订阅|推送/.test(c)) path = '<path d="M4 13.5A2.5 2.5 0 0 1 6.5 16M4 9a7 7 0 0 1 7 7M4 4.5A11.5 11.5 0 0 1 15.5 16"/>';
  else if (/未分类/.test(c)) path = '<path d="M3.5 6h5l1.5 2h6.5v8h-13zM3.5 6V4h5L10 6M10 11v2M10 15h.01"/>';
  else path = '<path d="M3.5 6h5l1.5 2h6.5v8h-13zM3.5 6V4h5L10 6"/>';
  return `<svg viewBox="0 0 20 20" aria-hidden="true">${path}</svg>`;
}

// ===== 规则中心 =====
let _rulesData = [];
let _ruleCategory = '全部';
let _allowlistData = [];
let _ruleScenarioData = [];

async function loadRules() {
  const data = await api('/api/rules');
  _rulesData = data.rules || [];
  _allowlistData = data.allowlist || [];
  _ruleScenarioData = data.categories || [];
  const t = data.thresholds || {};
  document.getElementById('threshold-review').value = t.review_score ?? 35;
  document.getElementById('threshold-quarantine').value = t.quarantine_score ?? 70;
  document.getElementById('threshold-spam').value = t.spam_score ?? 25;
  renderRuleTabs();
  renderRules();
  renderAllowlist();
  renderRuleScenarios();
}

function renderAllowlist() {
  const host = document.getElementById('allowlist-list');
  if (!host) return;
  host.innerHTML = _allowlistData.length ? _allowlistData.map(item => {
    const value = item.value || item.domain || item.email || '';
    const isAddress = item.kind === 'address';
    const readonly = item.readonly === true;
    return `
    <article class="allowlist-item ${item.enabled ? '' : 'disabled'} ${readonly ? 'readonly' : ''}" data-id="${esc(item.id)}" data-kind="${esc(item.kind || 'domain')}">
      <span class="allowlist-status" aria-hidden="true">${isAddress ? '@' : (item.enabled ? '✓' : '—')}</span>
      <div><b>${esc(value)}</b><small>${isAddress ? '仅此邮箱' : '整个域名及其子域名'} · ${esc(item.note || '未填写备注')}</small></div>
      ${readonly
        ? `<span class="allowlist-source" title="此项由系统配置提供，只能在对应配置中修改">${esc(item.source || '系统配置')}</span>`
        : `<label class="switch" title="启用或停用该白名单"><input class="allowlist-enabled" type="checkbox" ${item.enabled ? 'checked' : ''}><i></i></label>
           <button type="button" class="allowlist-delete" title="删除 ${esc(value)}">删除</button>`}
    </article>`;
  }).join('') : '<div class="allowlist-empty">尚未添加可信发件人。添加后，新收到的匹配邮件会减少常规误报。</div>';
}

async function saveAllowlistEntry(value, enabled = true, note = '', kind = 'domain') {
  const result = await api('/api/rules/allowlist', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain:value, kind, enabled, note})});
  const index = _allowlistData.findIndex(item => item.id === result.entry.id && item.kind === result.entry.kind);
  if (index >= 0) _allowlistData[index] = result.entry; else _allowlistData.push(result.entry);
  renderAllowlist();
  return result.entry;
}

// 规则名称/说明/命中条件来自后端中文目录（app/security/policy.py），
// 英文界面按规则编码映射译文；未收录的新规则回退原文。
const RULE_CATEGORY_KEYS = {'身份认证':'auth','发件身份':'identity','链接链路':'links','附件载荷':'attachments','社工话术':'social','行为画像':'behavior','会话变化':'thread','视觉内容':'visual','垃圾营销':'spam'};
function ruleCategoryLabel(name) { const k = RULE_CATEGORY_KEYS[name]; return (k && mailaiT('ruleCat.' + k)) || name; }
function ruleName(r) { return mailaiT('rule.name.' + r.code) || r.name; }
function ruleDesc(r) { return mailaiT('rule.desc.' + r.code) || r.description; }
function ruleTrigger(r) { return mailaiT('rule.trigger.' + r.code) || r.trigger || r.description; }
function ruleScenarioField(item, field) {
  const k = RULE_CATEGORY_KEYS[item.category];
  return (k && mailaiT(`ruleScenario.${field}.${k}`)) || item[field];
}

function renderRuleScenarios() {
  const host = document.getElementById('rule-scenario-grid');
  if (!host) return;
  const icons = {'身份认证':'证','发件身份':'人','链接链路':'链','附件载荷':'附','社工话术':'话','行为画像':'习','视觉内容':'图','垃圾营销':'邮'};
  host.innerHTML = _ruleScenarioData.map(item => {
    const enabled = item.enabled_count > 0;
    const state = item.enabled_count === item.total ? (mailaiT('rules.allOn') || '全部开启') : (enabled ? (mailaiT('rules.partialOn') || '{on}/{total} 开启').replace('{on}', item.enabled_count).replace('{total}', item.total) : (mailaiT('rules.allOff') || '已关闭'));
    return `<article class="rule-scenario-card ${enabled ? '' : 'disabled'}" data-category="${esc(item.category)}">
      <div class="scenario-card-head"><span>${icons[item.category] || '检'}</span><label class="switch" title="${(mailaiT('rules.toggleTitle') || '开启或关闭{name}').replace('{name}', esc(ruleScenarioField(item, 'title')))}"><input class="scenario-enabled" type="checkbox" ${enabled ? 'checked' : ''}><i></i></label></div>
      <h4>${esc(ruleScenarioField(item, 'title'))}</h4><p>${esc(ruleScenarioField(item, 'description'))}</p><small>${esc(ruleScenarioField(item, 'example'))}</small>
      <div class="scenario-control"><label>${mailaiT('rules.sensitivity') || '提醒敏感度'}<select class="scenario-sensitivity" ${enabled ? '' : 'disabled'}><option value="relaxed" ${item.sensitivity === 'relaxed' ? 'selected' : ''}>${mailaiT('rules.sensRelaxed') || '宽松 · 少提醒'}</option><option value="balanced" ${item.sensitivity === 'balanced' ? 'selected' : ''}>${mailaiT('rules.sensBalanced') || '均衡 · 推荐'}</option><option value="strict" ${item.sensitivity === 'strict' ? 'selected' : ''}>${mailaiT('rules.sensStrict') || '严格 · 多提醒'}</option></select></label><em>${state}</em></div>
    </article>`;
  }).join('');
}

async function saveRuleScenario(card) {
  const category = card.dataset.category;
  const enabled = card.querySelector('.scenario-enabled').checked;
  const sensitivity = card.querySelector('.scenario-sensitivity').value;
  const result = await api(`/api/rules/categories/${encodeURIComponent(category)}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled, sensitivity})});
  (result.rules || []).forEach(updated => {
    const index = _rulesData.findIndex(item => item.code === updated.code);
    if (index >= 0) _rulesData[index] = updated;
  });
  _ruleScenarioData = result.categories || _ruleScenarioData;
  renderRuleScenarios(); renderRules();
  toast((mailaiT('rules.savedToast') || '{category}已{state}，敏感度为{sens}').replace('{category}', ruleCategoryLabel(category)).replace('{state}', enabled ? (mailaiT('rules.stateOn') || '开启') : (mailaiT('rules.stateOff') || '关闭')).replace('{sens}', {relaxed: mailaiT('rules.sensRelaxedShort') || '宽松', balanced: mailaiT('rules.sensBalancedShort') || '均衡', strict: mailaiT('rules.sensStrictShort') || '严格'}[sensitivity]), 'success');
}

function renderRuleTabs() {
  const categories = ['全部', ...new Set(_rulesData.map(r => r.category))];
  document.getElementById('rule-category-tabs').innerHTML = categories.map(c =>
    `<button class="rule-tab ${c === _ruleCategory ? 'active' : ''}" data-category="${esc(c)}">${esc(c === '全部' ? (mailaiT('rules.tabAll') || '全部') : ruleCategoryLabel(c))}</button>`
  ).join('');
}

function renderRules() {
  const query = document.getElementById('rule-search').value.trim().toLowerCase();
  const filtered = _rulesData.filter(r =>
    (_ruleCategory === '全部' || r.category === _ruleCategory) &&
    (!query || `${r.name} ${r.code} ${r.description} ${r.trigger || ''}`.toLowerCase().includes(query))
  );
  const enabled = _rulesData.filter(r => r.enabled).length;
  document.getElementById('rule-summary').textContent = (mailaiT('rules.enabledCount') || '{on}/{total} 条已启用').replace('{on}', enabled).replace('{total}', _rulesData.length);
  document.getElementById('rules-grid').innerHTML = filtered.map(r => `
    <article class="rule-card ${r.enabled ? '' : 'disabled'}" data-code="${esc(r.code)}">
      <div class="rule-card-head">
        <span class="rule-category">${esc(ruleCategoryLabel(r.category))}</span>
        ${r.customized ? `<span class="rule-customized">${mailaiT('rules.customized') || '已自定义'}</span>` : ''}
        <button type="button" class="rule-help" aria-label="${(mailaiT('rules.helpAria') || '查看{name}的命中说明').replace('{name}', esc(ruleName(r)))}" aria-describedby="rule-detail-${esc(r.code)}">?</button>
        <div id="rule-detail-${esc(r.code)}" class="rule-detail-popover" role="tooltip">
          <strong>${mailaiT('rules.whenHit') || '什么时候会命中？'}</strong>
          <p>${esc(ruleTrigger(r))}</p>
          <dl>
            <div><dt>${mailaiT('rules.scoreImpact') || '计分影响'}</dt><dd>${(mailaiT('rules.scoreLine') || '当前 +{w} {kind}（默认 +{dw}）').replace('{w}', Number(r.weight || 0)).replace('{kind}', r.category === '垃圾营销' ? (mailaiT('rules.spamScore') || '垃圾营销分') : (mailaiT('rules.riskScore') || '风险分')).replace('{dw}', Number(r.default_weight || 0))}</dd></div>
            <div><dt>${mailaiT('rules.allowlist') || '白名单'}</dt><dd>${esc(mailaiT('rules.allowlist.' + (r.allowlist_behavior === '白名单邮件仍会检查此项' ? 'blocking' : 'normal')) || r.allowlist_behavior || '按系统白名单策略处理')}</dd></div>
            <div><dt>${mailaiT('rules.techId') || '技术标识'}</dt><dd><code>${esc(r.code)}</code></dd></div>
          </dl>
        </div>
        <label class="switch" title="${mailaiT('rules.toggleRule') || '启用或停用该规则'}">
          <input class="rule-enabled" type="checkbox" ${r.enabled ? 'checked' : ''}>
          <i></i>
        </label>
      </div>
      <h3>${esc(ruleName(r))}</h3>
      <code>${esc(r.code)}</code>
      <p>${esc(ruleDesc(r))}</p>
      <div class="rule-weight-row">
        <label>${mailaiT('rules.weight') || '风险权重'} <input class="rule-weight" type="number" min="0" max="100" value="${r.weight}"></label>
        <span>${(mailaiT('rules.defaultWeight') || '默认 {n}').replace('{n}', r.default_weight)}</span>
        <button class="btn-save-rule">${mailaiT('rules.save') || '保存'}</button>
      </div>
    </article>`).join('') || `<div class="rules-empty">${mailaiT('rules.noMatch') || '没有匹配的规则'}</div>`;
}

async function saveRuleCard(card) {
  const code = card.dataset.code;
  const enabled = card.querySelector('.rule-enabled').checked;
  const weight = Number(card.querySelector('.rule-weight').value);
  if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
    toast('规则权重必须是 0 到 100 的整数', 'error');
    return;
  }
  await api(`/api/rules/${encodeURIComponent(code)}?enabled=${enabled}&weight=${weight}`, {method: 'POST'});
  const item = _rulesData.find(r => r.code === code);
  if (item) Object.assign(item, {enabled, weight, customized: true});
  renderRules();
  toast(`${code} 已保存`, 'success');
}

function showRulesView() {
  closeAssistant();
  hideSystemView(true);
  hideDashboard();
  document.querySelector('.layout').classList.add('hidden');
  document.getElementById('rules-view').classList.remove('hidden');
  setTopMenuLabel('btn-rules', mailaiT('rules.backMail') || '返回邮件');
  loadRules().catch(e => toast('加载规则失败：' + e.message, 'error'));
}

function hideRulesView(showLayout = true) {
  const view = document.getElementById('rules-view');
  if (!view) return;
  view.classList.add('hidden');
  setTopMenuLabel('btn-rules', mailaiT('security.rules') || '规则中心');
  if (showLayout && document.getElementById('dashboard-view').classList.contains('hidden')) {
    document.querySelector('.layout').classList.remove('hidden');
  }
}

// ===== 后台收信后的列表自动刷新 =====
async function refreshMailboxIfChanged(force = false) {
  if (mailboxRefreshInFlight || !document.getElementById('app')) return;
  mailboxRefreshInFlight = true;
  try {
    const state = await api('/api/mailbox/revision');
    const changed = mailboxRevisionToken !== null && state.revision !== mailboxRevisionToken;
    if (force || changed) {
      // 邮件变化只刷新本地轻量列表。文件夹读取会建立 IMAP 连接，待办、草稿与
      // 已发送也有各自的刷新入口，不能在每次 AI 分析写库后一起重载。
      const loaded = await loadData({includeAncillary:false, silent:true});
      if (loaded === false) return;
    }
    mailboxRevisionToken = state.revision;
    // 账户任务状态变化不一定修改邮件，但无需每 15 秒读取完整系统配置。
    const now = Date.now();
    if (now - mailboxConfigCheckedAt >= 60000) {
      mailboxConfigCheckedAt = now;
      const latest = await api('/api/system/config');
      const activeId = activeMailAccount()?.id;
      if (_systemConfig && latest.accounts) {
        const accounts = latest.accounts.map(account => ({...account, active:account.id === activeId}));
        if (JSON.stringify(accounts) !== JSON.stringify(_systemConfig.accounts)) {
          _systemConfig.accounts = accounts;
          renderSidebarAccounts();
        }
      }
    }
  } catch (_) {
    // 后台心跳失败不打扰阅读；下次心跳或窗口重新获得焦点时重试。
  } finally {
    mailboxRefreshInFlight = false;
  }
}

function startMailboxAutoRefresh() {
  if (mailboxRefreshTimer) return;
  refreshMailboxIfChanged();
  mailboxRefreshTimer = setInterval(() => {
    if (!document.hidden) refreshMailboxIfChanged();
  }, 15000);
}

window.mailaiMailboxUpdated = () => refreshMailboxIfChanged(true);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshMailboxIfChanged();
});
window.addEventListener('focus', () => refreshMailboxIfChanged());

// ===== 系统中心 =====
let _systemConfig = null;
let _systemTab = 'preferences';

function activeMailAccount() {
  return (_systemConfig?.accounts || []).find(account => account.active) || null;
}

function accountMark(account) {
  const domain = (account?.user || '').split('@')[1]?.toLowerCase() || '';
  if (domain === 'qq.com') return 'QQ';
  if (domain.includes('outlook') || domain.includes('hotmail')) return 'MS';
  if (domain.includes('gmail')) return 'G';
  return ((account?.user || '@').match(/[a-z]/i)?.[0] || '@').toUpperCase();
}

function renderComposeAccountPicker(preferredId = '') {
  const select = document.getElementById('compose-from');
  if (!select) return;
  const accounts = (_systemConfig?.accounts || []).filter(account => account.credential_available);
  select.innerHTML = accounts.map(account => `<option value="${esc(account.id)}">${esc(account.user)}${account.active ? '（当前）' : ''}</option>`).join('');
  const chosen = accounts.find(account => account.id === preferredId) || accounts.find(account => account.active) || accounts[0];
  if (chosen) select.value = chosen.id;
  select.disabled = accounts.length < 2;
  select.closest('.compose-from-picker')?.classList.toggle('hidden', !accounts.length);
}

let mailboxSyncTrackerTimer = 0;
let mailboxSyncTrackerSignature = '';
let mailboxSyncTrackerDismissedSignature = '';
let mailboxSyncTrackerFadingSignature = '';

function dismissMailboxSyncTracker(tracker, signature) {
  if (signature !== mailboxSyncTrackerSignature) return;
  mailboxSyncTrackerFadingSignature = signature;
  tracker.classList.add('is-fading');
  mailboxSyncTrackerTimer = setTimeout(() => {
    if (signature !== mailboxSyncTrackerSignature) return;
    tracker.classList.add('hidden');
    tracker.classList.remove('is-fading');
    mailboxSyncTrackerDismissedSignature = signature;
    mailboxSyncTrackerFadingSignature = '';
    mailboxSyncTrackerTimer = 0;
  }, 460);
}

function accountSyncLabel(account) {
  if (!account.credential_available) return '需要重新登录';
  if (account.sync_status === 'running') {
    if (Number(account.sync_quiet_seconds) >= 90) return '等待服务器响应…';
    if (account.sync_total > 0) {
      const action = {poll:'同步', fetch_all:'初始化', fetch_more:'加载', sync_folders:'同步文件夹', sync_folder:'同步文件夹'}[account.sync_operation] || '同步';
      return `${action} ${account.sync_processed || 0}/${account.sync_total}`;
    }
    return {poll:'正在检查新邮件', fetch_all:'正在扫描历史邮件', fetch_more:'正在加载更多邮件', sync_folders:'正在同步文件夹', sync_folder:'正在同步文件夹'}[account.sync_operation] || '正在连接邮箱';
  }
  if (account.sync_status === 'interrupted') return '上次同步中断';
  if (account.sync_error) return '同步失败';
  if (account.sync_status === 'canceled') return '同步已暂停';
  return '';
}

function mergeAccountSyncState(accountId, state) {
  const account = (_systemConfig?.accounts || []).find(item => item.id === accountId);
  if (!account || !state) return;
  account.sync_status = state.running ? 'running' : state.canceled ? 'canceled' : state.error ? 'failed' : 'completed';
  ['message','error','operation','phase','processed','total','elapsed_seconds','quiet_seconds','current_folder','folder_progress','folder_omitted'].forEach(key => {
    account['sync_' + key] = state[key] ?? (key === 'folder_progress' ? [] : '');
  });
  renderMailboxSyncTracker(_systemConfig.accounts);
}

function renderMailboxSyncTracker(accounts = []) {
  const tracker = document.getElementById('mailbox-sync-tracker');
  if (!tracker) return;
  const running = accounts.filter(account => account.credential_available && account.sync_status === 'running');
  const tracked = accounts.filter(account => {
    const folders = Array.isArray(account.sync_folder_progress) ? account.sync_folder_progress : [];
    return account.sync_status === 'running' || (['sync_folders','sync_folder'].includes(account.sync_operation) && folders.length);
  });
  if (!tracked.length) {
    clearTimeout(mailboxSyncTrackerTimer);
    mailboxSyncTrackerTimer = 0;
    mailboxSyncTrackerSignature = '';
    mailboxSyncTrackerDismissedSignature = '';
    mailboxSyncTrackerFadingSignature = '';
    tracker.classList.add('hidden');
    tracker.classList.remove('is-fading');
    tracker.innerHTML = '';
    return;
  }
  const signature = JSON.stringify(tracked.map(account => [
    account.id, account.sync_status, account.sync_operation, account.sync_processed, account.sync_total,
    account.sync_error || '', account.sync_folder_omitted || 0,
    (account.sync_folder_progress || []).map(item => [item.name, item.status, item.processed, item.total, item.error || '']),
  ]));
  if (running.length) {
    clearTimeout(mailboxSyncTrackerTimer);
    mailboxSyncTrackerTimer = 0;
    mailboxSyncTrackerDismissedSignature = '';
    mailboxSyncTrackerFadingSignature = '';
    tracker.classList.remove('hidden', 'is-fading');
  } else if (mailboxSyncTrackerDismissedSignature === signature) {
    tracker.classList.add('hidden');
  } else if (mailboxSyncTrackerFadingSignature === signature) {
    tracker.classList.remove('hidden');
    tracker.classList.add('is-fading');
  } else {
    tracker.classList.remove('hidden', 'is-fading');
  }
  const heading = running.length
    ? `<i class="account-sync-spinner" aria-hidden="true"></i><span>后台同步 ${running.length} 个邮箱</span>`
    : `<span>最近一次文件夹同步</span>`;
  tracker.innerHTML = `<div class="mailbox-sync-tracker-title" role="status">${heading}<small>各邮箱独立更新</small></div>` + tracked.map(account => {
    const folders = (Array.isArray(account.sync_folder_progress) ? account.sync_folder_progress : []).slice(0, 100);
    const done = folders.filter(item => item.status === 'completed').length;
    const failed = folders.filter(item => item.status === 'failed').length;
    const live = account.sync_status === 'running';
    const stateText = live ? accountSyncLabel(account) : failed ? `${failed} 个失败` : account.sync_status === 'canceled' ? '同步已暂停' : '同步完成';
    const open = live && folders.length ? ' open' : '';
    const omitted = Number(account.sync_folder_omitted || 0);
    const folderRows = folders.map(item => {
      const total = Math.max(0, Number(item.total || 0));
      const processed = Math.max(0, Number(item.processed || 0));
      const pct = total ? Math.min(100, Math.round(processed / total * 100)) : item.status === 'completed' ? 100 : 0;
      const statusText = {pending:'等待',running:'同步中',completed:'完成',failed:'失败',canceled:'已取消'}[item.status] || '等待';
      return `<div class="mailbox-sync-folder ${esc(item.status || 'pending')}" title="${esc(item.error || item.name || '')}">
        <div><b>${esc(item.name || '未命名文件夹')}</b><span>${statusText}</span></div>
        <div class="mailbox-sync-folder-progress"><i style="width:${pct}%"></i></div>
        <small>${processed}/${total} 封</small>
      </div>`;
    }).join('');
    const body = folders.length ? `${folderRows}${omitted ? `<p>另有 ${omitted} 个文件夹在后台同步，详情已折叠以保证性能。</p>` : ''}`
      : `<p>${esc(account.sync_message || '正在连接邮箱服务器…')}</p>`;
    return `<details class="mailbox-sync-account"${open}>
      <summary><span>${esc(localStorage.getItem('alias:' + account.id) || account.user)}</span><b>${esc(stateText)}</b><em>${folders.length ? `${done}/${folders.length + omitted} 个文件夹` : ''}</em></summary>
      <div class="mailbox-sync-folder-list">${body}</div>
    </details>`;
  }).join('');
  if (!running.length && mailboxSyncTrackerSignature !== signature) {
    clearTimeout(mailboxSyncTrackerTimer);
    mailboxSyncTrackerSignature = signature;
    mailboxSyncTrackerTimer = setTimeout(() => dismissMailboxSyncTracker(tracker, signature), 6500);
  } else if (running.length) {
    mailboxSyncTrackerSignature = signature;
  }
}

function renderSidebarAccounts() {
  const accounts = _systemConfig?.accounts || [];
  const group = document.getElementById('account-mailbox-group');
  const primary = document.getElementById('primary-folder-group');
  const host = document.getElementById('account-mailbox-nav');
  const multiple = accounts.length > 1;
  renderMailboxSyncTracker(accounts);
  group?.classList.toggle('hidden', !multiple);
  primary?.classList.toggle('hidden', multiple);
  if (!host || !multiple) return;
  const inboxTotal = accounts.reduce((sum, account) => sum + Number(account.inbox || 0), 0);
  host.innerHTML = `<button type="button" class="nav-item unified-inbox-button ${unifiedMailbox ? 'active' : ''}" data-account-action="unified">
    <span class="icon"><svg viewBox="0 0 20 20"><path d="M3.5 6.5h13v9h-13zM6 4h8M3.5 11h3l1.4 2h4.2l1.4-2h3"/></svg></span><span>${mailaiT('list.allInboxes') || '所有收件箱'}</span><span class="count">${inboxTotal}</span></button>` + accounts.map(account => {
      const selectedAccount = selectedMailboxAccountId === account.id && !unifiedMailbox;
      const collapsed = localStorage.getItem('collapsed:' + account.id) === '1';
      const syncing = account.credential_available && account.sync_status === 'running';
      const status = accountSyncLabel(account);
      const statusVisible = Boolean(status) && (syncing || account.sync_error || !account.credential_available || ['interrupted','canceled'].includes(account.sync_status));
      const syncDetail = [account.sync_error || account.sync_message || account.user, syncing ? `已用时 ${account.sync_elapsed_seconds || 0} 秒；距上次进度更新 ${account.sync_quiet_seconds || 0} 秒` : '', account.sync_status === 'interrupted' ? '当前没有同步任务，点击顶部「同步」重新检查' : ''].filter(Boolean).join(' · ');
      return `<section class="sidebar-account ${selectedAccount ? 'active' : ''} ${collapsed ? 'collapsed' : ''}" data-sidebar-account="${esc(account.id)}">
        <div class="sidebar-account-heading">
        <button type="button" class="account-collapse" data-account-collapse="${esc(account.id)}" aria-label="${collapsed ? '展开' : '收起'} ${esc(account.user)}" aria-expanded="${!collapsed}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></button>
        <button type="button" class="sidebar-account-head" data-account-action="inbox" data-account-id="${esc(account.id)}" title="查看 ${esc(account.user)} 的收件箱">
          <span class="sidebar-account-avatar">${esc(accountMark(account))}</span><span class="sidebar-account-identity"><b>${esc(localStorage.getItem('alias:' + account.id) || account.user.split('@')[0])}</b><small>${esc(account.user.split('@')[1] || (mailaiT('acct.stateReady') || '已连接'))}</small></span>
        </button>
        ${statusVisible ? `<span class="account-sync-state ${syncing ? 'running' : 'warning'}" title="${esc(syncDetail)}">${syncing ? '<i class="account-sync-spinner" aria-hidden="true"></i>' : ''}${esc(status)}</span>` : ''}
        <details class="account-menu"><summary aria-label="管理 ${esc(account.user)}" title="${mailaiT('side.accountOptions') || '邮箱选项'}">⋯</summary><div><button type="button" data-account-alias="${esc(account.id)}">${mailaiT('side.renameAccount') || '修改显示名称'}</button><button type="button" data-account-manage="${esc(account.id)}">${mailaiT('side.manageAccount') || '管理此邮箱'}</button></div></details>
        </div>
        <div class="sidebar-account-folders">${[['favorites', mailaiT('side.favorites') || '我的收藏','m10 2 2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8Z'],['inbox', mailaiT('side.inbox') || '收件箱','M3 4h14v12H3zM3 11h4l1 2h4l1-2h4'],['sent', mailaiT('side.sent') || '已发送','m3 9 14-6-5 14-3-6-6-2Zm6 2 8-8'],['drafts', mailaiT('side.drafts') || '草稿箱','M5 2h7l4 4v12H5zM12 2v5h4M8 11h5M8 14h4'],['trash', mailaiT('side.trash') || '已删除','M4 6h12M7 6V3h6v3M6 8l1 9h6l1-9']].map(([action,label,path]) => `<button type="button" class="${selectedAccount && (action === 'local_archive' ? currentFilter.status === 'local_archive' : action === 'favorites' ? currentFilter.status === 'favorites' : action === 'trash' ? currentFilter.status === 'trash' || Boolean(currentServerFolder && currentServerFolder === serverFolderForRole('trash')?.name) : action === 'inbox' ? currentFilter.status === 'inbox' && !specialMailbox && !currentServerFolder : specialMailbox === action) ? 'active' : ''}" data-account-action="${action}" data-account-id="${esc(account.id)}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="${path}"/></svg><span>${label}</span>${action === 'inbox' && Number(account.unread) ? `<em title="未读邮件">${Number(account.unread)}</em>` : ''}</button>`).join('')}</div>
      </section>`;
    }).join('');
}

async function activateMailAccount(accountId, {keepMailbox = false, quiet = false} = {}) {
  const account = (_systemConfig?.accounts || []).find(item => item.id === accountId);
  if (!account) throw new Error('邮箱账号不存在');
  if (!account.credential_available) {
    showSystemView('account');
    selectedManagedAccountId = account.id;
    renderAccountSelection();
    throw new Error('该邮箱需要重新登录');
  }
  if (!account.active) {
    await api('/api/system/mail/preferred', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({account_id:accountId})});
    window.assistantAttachments?.clear(); assistantLastAttachments=[];
    window.assistantImages?.clear(); assistantLastImages = []; assistantLastQuestion = ''; assistantLastScope = null; assistantLastAlertContext = false;
    assistantController?.abort(); assistantController = null; ++assistantRevision;
    ++mailLoadRevision; ++readingLoadRevision; ++searchRevision;
    readingLoadController?.abort(); readingLoadController = null;
    document.getElementById('assistant-send').disabled = false;
    document.getElementById('assistant-stop').classList.add('hidden');
    document.getElementById('assistant-retry').classList.add('hidden');
    document.getElementById('assistant-scope-note').textContent = account.user + ' · 全部已同步邮件';
    assistantHistory = []; assistantConversationId = null; assistantHistoryLoaded = false; assistantAlertContextIds = [];
    assistantAlerts = null; assistantNoticeKey = ''; assistantScopeKey = '';
    ++assistantAlertRevision;
    setAssistantState('calm');
    document.getElementById('assistant-nudge').classList.add('hidden');
    assistantPinnedScope = null;
    document.getElementById('assistant-scope').value = 'account';
    if (typeof updateAssistantScopeControl === 'function') updateAssistantScopeControl();
    renderAssistantWelcome();
    document.getElementById('assistant-alert-strip').classList.add('hidden');
    document.getElementById('assistant-badge').classList.add('hidden');
    browsingAccountId = accountId;
    localStorage.setItem('mailai-browsing-account', accountId);
    _systemConfig.accounts.forEach(item => { item.active = item.id === accountId; });
    _systemConfig.mail.user = account.user;
    resetDigestAccountView();
    window.refreshSecretaryAccount?.();
    const capability = await api('/api/mail/send-capability', {accountId});
    if (activeMailAccount()?.id !== accountId) return account;
    sendCapability = capability;
    loadAssistantAlerts();
    renderSidebarAccounts();
    if (!quiet) toast(`正在使用 ${account.user}`);
  }
  if (!keepMailbox && activeMailAccount()?.id === accountId) selectedMailboxAccountId = accountId;
  return (_systemConfig?.accounts || []).find(item => item.id === accountId);
}

async function openAccountMailbox(accountId, mailbox) {
  if (bulkOperationActive) return toast('批量操作正在执行，请稍候', 'warn');
  const navigationRevision = ++mailboxNavigationRevision;
  resetReadingPane();
  // 乐观高亮：账号和文件夹状态必须一起切换，不等账号激活或列表加载。
  // 否则侧栏首次重绘仍会使用旧的 specialMailbox/currentFilter.status。
  const previousMailboxState = {
    selectedMailboxAccountId, unifiedMailbox, specialMailbox, currentServerFolder,
    status: currentFilter.status,
  };
  unifiedMailbox = false;
  selectedMailboxAccountId = accountId;
  specialMailbox = ['sent', 'drafts'].includes(mailbox) ? mailbox : '';
  currentServerFolder = '';
  currentFilter.status = ['inbox','trash','favorites','local_archive'].includes(mailbox) ? mailbox : '';
  updateActiveNav(); renderSidebarAccounts();
  try {
    const activation = mailboxActivationQueue.catch(() => {}).then(async () => {
      if (navigationRevision !== mailboxNavigationRevision) return false;
      // Keep the optimistic mailbox highlight owned by this navigation. A stale
      // activation may still finish on the server, but must not repaint or toast
      // over a newer click while the queue switches to the final account.
      await activateMailAccount(accountId, {keepMailbox:true, quiet:true});
      return navigationRevision === mailboxNavigationRevision;
    });
    mailboxActivationQueue = activation.then(() => {}, () => {});
    if (!await activation) return;
  } catch (err) {
    if (navigationRevision !== mailboxNavigationRevision) return;
    selectedMailboxAccountId = previousMailboxState.selectedMailboxAccountId;
    unifiedMailbox = previousMailboxState.unifiedMailbox;
    specialMailbox = previousMailboxState.specialMailbox;
    currentServerFolder = previousMailboxState.currentServerFolder;
    currentFilter.status = previousMailboxState.status;
    updateActiveNav(); renderSidebarAccounts();
    throw err;
  }
  if (navigationRevision !== mailboxNavigationRevision || activeMailAccount()?.id !== accountId) return;
  currentFilter.search = ''; searchResults = null; ++searchRevision; clearTimeout(globalSearchTimer);
  document.getElementById('global-search').value = '';
  currentFilter.verdict = ''; currentFilter.category = '';
  if (currentFilter.days !== 9999) { currentFilter.days = 9999; setSegmentedFilter('filter-days', '9999'); }
  if (mailbox === 'trash') {
    await loadMailboxFolders();
    if (navigationRevision !== mailboxNavigationRevision || activeMailAccount()?.id !== accountId) return;
    await openTrashMailbox({resetPane:false});
    return;
  }
  await Promise.all([loadData(), loadMailboxFolders()]);
  if (navigationRevision !== mailboxNavigationRevision || activeMailAccount()?.id !== accountId) return;
  updateActiveNav(); renderSidebarAccounts();
}

async function openTrashMailbox({resetPane = true} = {}) {
  if (resetPane) resetReadingPane();
  clearMailSelection();
  specialMailbox = ''; currentServerFolder = ''; unifiedMailbox = false;
  currentFilter.status = 'trash'; currentFilter.days = 9999;
  currentFilter.search = ''; currentFilter.verdict = ''; currentFilter.category = '';
  currentFilter.priority = ''; currentFilter.domain = ''; currentFilter.attachments = false;
  searchResults = null; ++searchRevision; clearTimeout(globalSearchTimer);
  document.getElementById('global-search').value = '';
  setSegmentedFilter('filter-days', '9999');
  setSegmentedFilter('filter-priority', '');
  document.getElementById('filter-domain').value = '';
  document.getElementById('filter-attachments').checked = false;
  currentFilter.unread = false; document.getElementById('filter-unread').checked = false;
  const accountId = activeMailAccount()?.id;
  updateActiveNav();
  renderSidebarAccounts();
  document.getElementById('list-title').textContent = mailaiT('side.trash') || '已删除';
  document.getElementById('email-list').innerHTML = `<div class="email-empty"><div class="empty-text">${mailaiT('list.loadingTrash') || '正在读取已删除邮件…'}</div></div>`;
  const folder = serverFolderForRole('trash')?.name;
  if (folder) {
    try { await api(`/api/mail/folders/sync?folder=${encodeURIComponent(folder)}`, {method:'POST',accountId}); }
    catch (err) { toast('服务器已删除邮件同步失败，将显示本地记录：' + err.message, 'warn'); }
  }
  if (currentFilter.status === 'trash' && activeMailAccount()?.id === accountId) await loadData();
}

async function openUnifiedInbox() {
  if (bulkOperationActive) return toast('批量操作正在执行，请稍候', 'warn');
  const navigationRevision = ++mailboxNavigationRevision;
  resetReadingPane(); clearMailSelection();
  unifiedMailbox = true; selectedMailboxAccountId = '';
  updateActiveNav(); renderSidebarAccounts(); // 乐观高亮，不等加载完成
  specialMailbox = ''; currentServerFolder = '';
  currentFilter.status = ''; currentFilter.verdict = ''; currentFilter.category = '';
  currentFilter.search = ''; searchResults = null; ++searchRevision; clearTimeout(globalSearchTimer);
  document.getElementById('global-search').value = '';
  await loadData();
  if (navigationRevision !== mailboxNavigationRevision) return;
  updateActiveNav(); renderSidebarAccounts();
}

function selectSystemTab(name) {
  _systemTab = name;
  document.querySelectorAll('[data-system-tab]').forEach(b => b.classList.toggle('active', b.dataset.systemTab === name));
  document.querySelectorAll('[data-system-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.systemPanel !== name));
}

let availableAppUpdate = null;
let appUpdateInstalling = false;
const MAILAI_SHARE_URL = 'https://github.com/langjiahui/MailAI/releases/latest';

function openAppShare() {
  const dialog = document.getElementById('share-app-dialog');
  document.getElementById('btn-native-share-app')?.classList.toggle('hidden', typeof navigator.share !== 'function');
  if (dialog && !dialog.open) dialog.showModal();
}

async function copyAppShareUrl() {
  const input = document.getElementById('share-app-url');
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(MAILAI_SHARE_URL);
    else throw new Error('clipboard unavailable');
    toast('下载页链接已复制，可以分享给朋友', 'success');
    return;
  } catch (_) {
    // Older desktop webviews may not expose the async clipboard API.
  }
  input.focus();
  input.select();
  let copied = false;
  try { copied = !!document.execCommand?.('copy'); } catch (_) {}
  toast(copied ? '下载页链接已复制，可以分享给朋友' : '复制失败，已选中链接，请手动复制', copied ? 'success' : 'warn');
}

async function shareAppWithSystem() {
  if (typeof navigator.share !== 'function') return;
  try {
    await navigator.share({title:'MailAI', text:'MailAI 邮件安全与效率助手', url:MAILAI_SHARE_URL});
  } catch (error) {
    if (error?.name !== 'AbortError') toast('系统分享未完成，请使用复制链接', 'warn');
  }
}

function appDeviceName(device) {
  return ({'windows-x64':'Windows x64', 'macos-arm64':'macOS · Apple 芯片'})[device] || device || '暂未识别';
}

function renderAppVersion(result) {
  const label = document.getElementById('app-version-label');
  const status = document.getElementById('app-update-status');
  const device = document.getElementById('app-device-label');
  const releaseLink = document.getElementById('app-release-link');
  if (label) label.textContent = `MailAI ${result.current_version || ''}`.trim();
  if (device) device.textContent = appDeviceName(result.device);
  if (releaseLink && result.release_url) releaseLink.href = result.release_url;
  const releaseSummary = document.getElementById('app-release-summary');
  const releaseTitle = document.getElementById('app-release-summary-title');
  const releaseNotes = document.getElementById('app-release-summary-notes');
  const notes = String(result.notes || '').trim();
  if (releaseSummary) releaseSummary.classList.toggle('hidden', !notes);
  if (releaseTitle && notes) releaseTitle.textContent = result.available
    ? `新版本 ${result.latest_version} 更新内容`
    : `MailAI ${result.current_version} 更新内容`;
  if (releaseNotes) releaseNotes.textContent = notes;
  if (!status) return;
  if (result.development) status.textContent = '源码运行模式；安装包版本会自动检查更新。';
  else if (!result.supported) status.textContent = `当前设备 ${result.device || ''} 暂无对应安装包。`;
  else if (result.available) status.textContent = `新版本 ${result.latest_version} 可以安装。`;
  else status.textContent = '当前已是最新版本。';
}

function showAppUpdate(result) {
  availableAppUpdate = result;
  const dialog = document.getElementById('update-dialog');
  if (!dialog || dialog.open) return;
  document.getElementById('update-dialog-title').textContent = `${result.current_version} → ${result.latest_version}`;
  document.getElementById('update-dialog-device').textContent = `已为这台设备匹配 ${appDeviceName(result.device)} 安装包。`;
  document.getElementById('update-dialog-notes-title').textContent = `${result.latest_version} 版本发布说明`;
  document.getElementById('update-dialog-notes').textContent = result.notes || '本版本暂未提供发布说明。';
  document.getElementById('update-dialog-warning').textContent = result.unsigned_warning || '';
  const install = document.getElementById('btn-install-update');
  install.disabled = !result.installable;
  install.textContent = result.installable ? '下载并安装' : '当前运行方式无法自动安装';
  appUpdateInstalling = false;
  const progress = document.getElementById('update-download-progress');
  progress?.classList.add('hidden');
  progress?.classList.remove('indeterminate', 'verifying', 'complete');
  dialog.showModal();
}

function formatUpdateBytes(value) {
  const size = Math.max(0, Number(value) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

function renderUpdateProgress(state) {
  const box = document.getElementById('update-download-progress');
  if (!box) return;
  const phase = state.phase || 'queued';
  const total = Math.max(0, Number(state.total) || 0);
  const downloaded = Math.max(0, Number(state.downloaded) || 0);
  const percent = total ? Math.min(100, Math.max(0, Number(state.percent) || Math.round(downloaded * 100 / total))) : 0;
  const labels = {
    queued:'正在准备更新', checking:'正在确认版本', downloading:'正在下载安装包',
    verifying:'正在校验安装包', verified:'校验完成', launching:'正在启动安装程序',
    launched:'安装程序已启动', failed:'更新未完成',
  };
  box.classList.remove('hidden');
  box.classList.toggle('indeterminate', !total && state.running);
  box.classList.toggle('verifying', phase === 'verifying' || phase === 'verified');
  box.classList.toggle('complete', phase === 'launched');
  box.setAttribute('aria-valuenow', String(percent));
  document.getElementById('update-progress-label').textContent = labels[phase] || state.message || '正在更新';
  document.getElementById('update-progress-percent').textContent = total ? `${percent}%` : '连接中';
  document.getElementById('update-progress-fill').style.width = `${total ? percent : 36}%`;
  let detail = state.message || '';
  if (phase === 'downloading' && total) {
    detail = `${formatUpdateBytes(downloaded)} / ${formatUpdateBytes(total)}`;
    if (state.speed_bps) detail += ` · ${formatUpdateBytes(state.speed_bps)}/秒`;
  } else if (phase === 'verifying') detail = '正在核对 SHA-256，确保安装包完整且未被篡改…';
  else if (phase === 'launched') detail = '请按系统提示完成安装；完成后将尝试自动打开 MailAI。';
  document.getElementById('update-progress-detail').textContent = detail;
  const button = document.getElementById('btn-install-update');
  if (button && appUpdateInstalling) button.textContent = phase === 'downloading' && total ? `下载中 ${percent}%` : (labels[phase] || '正在更新…');
}

function waitForUpdateProgress() {
  return new Promise(resolve => setTimeout(resolve, 400));
}

async function monitorAppUpdateInstall() {
  while (appUpdateInstalling) {
    await waitForUpdateProgress();
    const state = await api('/api/system/update/install/status');
    renderUpdateProgress(state);
    if (state.status === 'failed') throw new Error(state.error || '更新未完成');
    if (state.status === 'completed') return state;
  }
  return null;
}

async function checkForAppUpdate(manual = false) {
  const button = document.getElementById('btn-check-update');
  if (manual && button) setLoading(button, true, '检查中…');
  try {
    const result = await api(`/api/system/update${manual ? '?force=true' : ''}`);
    renderAppVersion(result);
    if (result.available) showAppUpdate(result);
    else if (manual) toast(result.message || (result.supported ? '当前已是最新版本' : '当前设备暂无对应安装包'), result.development ? 'info' : 'success');
    return result;
  } catch (error) {
    if (manual) toast(error.message, 'warn');
  } finally {
    if (manual && button) setLoading(button, false);
  }
}

async function installAppUpdate(event) {
  event.preventDefault();
  const button = document.getElementById('btn-install-update');
  if (appUpdateInstalling) return;
  appUpdateInstalling = true;
  setLoading(button, true, '正在准备更新…');
  try {
    const started = await api('/api/system/update/install', {method:'POST'});
    renderUpdateProgress(started);
    const result = await monitorAppUpdateInstall();
    if (result) {
      await new Promise(resolve => setTimeout(resolve, 700));
      document.getElementById('update-dialog').close();
      toast(result.message || '安装器已启动；安装完成后将尝试自动打开 MailAI', 'success');
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    appUpdateInstalling = false;
    setLoading(button, false);
  }
}

async function loadSystemConfig() {
  const data = await api('/api/system/config');
  if (data.accounts?.some(account => account.id === browsingAccountId)) {
    data.accounts.forEach(account => { account.active = account.id === browsingAccountId; });
    data.mail.user = data.accounts.find(account => account.active).user;
  }
  _systemConfig = data;
  window.mailOnboarding?.configChanged(data);
  const model = data.model || {};
  document.getElementById('model-provider').value = model.provider || 'custom';
  document.getElementById('model-extra-params').value = JSON.stringify(model.extra_params || {}, null, 2);
  document.getElementById('model-multimodal-enabled').checked = model.multimodal_enabled !== false;
  document.getElementById('model-base-url').value = model.base_url || '';
  document.getElementById('model-name').value = model.model || '';
  document.getElementById('multimodal-model').value = model.multimodal_model || '';
  document.getElementById('model-api-key').value = '';
  document.getElementById('model-api-key').placeholder = model.api_key_masked ? `已配置 ${model.api_key_masked}，留空保持不变` : '请输入 API Key';
  document.getElementById('model-verify-ssl').checked = model.verify_ssl !== false;
  const modelStatus = document.getElementById('model-status');
  modelStatus.textContent = model.verified ? '已验证' : model.available ? '已配置 · 待验证' : '未配置';
  modelStatus.className = `connection-status ${model.verified ? 'connected' : ''}`;

  const mail = data.mail || {};
  const mailStatus = document.getElementById('mail-status');
  mailStatus.textContent = mail.logged_in ? `已登录 · ${mail.user}` : '未登录';
  mailStatus.className = `connection-status ${mail.logged_in ? 'connected' : ''}`;
  const accountsHost = document.getElementById('saved-accounts');
  const accounts = data.accounts || [];
  if (accounts.length > 1 && !selectedMailboxAccountId && !specialMailbox && !currentServerFolder && !currentFilter.status) unifiedMailbox = true;
  renderSidebarAccounts();
  if (!accounts.some(account => account.id === selectedManagedAccountId)) {
    selectedManagedAccountId = (accounts.find(account => account.active) || accounts[0] || {}).id || '';
  }
  document.getElementById('account-count').textContent = String(accounts.length);
  accountsHost.classList.toggle('hidden', accounts.length < 1);
  accountsHost.innerHTML = accounts.length ? `<div class="saved-account-list">${accounts.map(account => {
    const state = account.active ? (mailaiT('acct.stateActive') || '当前发件账号') : account.credential_available ? (mailaiT('acct.stateReady') || '已连接') : (mailaiT('acct.stateReauth') || '需重新登录');
    const stateClass = account.active ? 'current' : account.credential_available ? 'ready' : 'reauth';
    const selected = account.id === selectedManagedAccountId;
    return `<button type="button" class="saved-account ${account.active ? 'active' : ''} ${selected ? 'selected' : ''}" data-account-id="${esc(account.id)}" aria-pressed="${selected}" title="管理 ${esc(account.user)}">
      <span class="saved-account-avatar">${esc(accountMark(account))}</span>
      <span class="saved-account-identity"><b>${esc(account.user)}</b><small><i></i>${esc(account.host)}</small></span>
      <span class="saved-account-state ${stateClass}"><i></i>${esc(state)}</span>
      <svg class="saved-account-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 10 3 3 6-6"/></svg>
    </button>`;
  }).join('')}</div>` : '';
  renderAccountSelection();
  return data;
}

function selectedManagedAccount() {
  return (_systemConfig?.accounts || []).find(account => account.id === selectedManagedAccountId) || null;
}

function renderAccountSelection() {
  const account = selectedManagedAccount();
  const panel = document.getElementById('account-selection-actions');
  const status = document.getElementById('mail-status');
  const editing = !document.getElementById('mail-add-panel').classList.contains('hidden');
  panel.classList.toggle('hidden', !account || editing);
  document.getElementById('account-empty-state').classList.toggle('hidden', Boolean(account) || editing);
  document.querySelectorAll('.saved-account').forEach(button => {
    const selected = button.dataset.accountId === selectedManagedAccountId;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  status.textContent = account ? (account.credential_available ? (mailaiT('acct.credOk') || '授权码可用') : (mailaiT('acct.credNeeded') || '需要登录')) : (mailaiT('acct.notConnected') || '未连接');
  status.className = `connection-status ${account?.credential_available ? 'connected' : account ? 'failed' : ''}`;
  if (!account) return;
  document.getElementById('selected-account-avatar').textContent = accountMark(account);
  document.getElementById('selected-account-role').textContent = account.active ? (mailaiT('acct.stateActive') || '当前发件账号') : (mailaiT('acct.roleConnected') || '已连接邮箱');
  document.getElementById('selected-account-name').textContent = account.user;
  document.getElementById('selected-account-help').textContent = account.credential_available
    ? (account.credential_storage === 'session' ? (mailaiT('acct.helpSession') || '授权码仅本次运行有效，退出软件后需要重新登录') : (mailaiT('acct.helpSaved') || '连接信息已保存，可随时更新授权码'))
    : (mailaiT('acct.helpMissing') || '本机没有可用授权码，请重新登录');
  document.getElementById('btn-manage-mail').textContent = account.credential_available ? (mailaiT('acct.updateBtn') || '更新登录信息') : (mailaiT('acct.reloginBtn') || '重新登录');
  document.getElementById('selected-account-state').textContent = account.sync_error ? (mailaiT('acct.syncFailed') || '最近同步失败') : account.last_sync ? (mailaiT('acct.lastSync') || '最近同步：') + fmtDate(account.last_sync) : (mailaiT('acct.noSync') || '尚无成功同步记录');
  document.getElementById('selected-account-host').textContent = account.host || (mailaiT('acct.autoHost') || '自动识别');
}

function resetMailAddForm(account = null) {
  const userInput = document.getElementById('mail-user');
  const hostInput = document.getElementById('mail-host');
  userInput.value = account?.user || '';
  userInput.readOnly = Boolean(account);
  document.getElementById('mail-password').value = '';
  document.getElementById('mail-password').placeholder = '请输入密码或客户端授权码';
  hostInput.value = account?.host || '';
  hostInput.readOnly = Boolean(account);
  document.getElementById('mail-port').value = account?.port || 993;
  document.getElementById('mail-smtp-host').value = account?.smtp_host || '';
  document.getElementById('mail-smtp-port').value = account?.smtp_port || 465;
  document.getElementById('mail-ssl').checked = account?.ssl !== false;
  document.getElementById('mail-smtp-ssl').checked = account?.smtp_ssl !== false;
  document.getElementById('mail-smtp-starttls').checked = account?.smtp_starttls === true;
  document.getElementById('mail-verify-ssl').checked = account?.verify_ssl !== false;
  document.getElementById('mail-provider-hint').textContent = account
    ? '邮箱账号和收件服务器保持不变，可更新授权码及发件设置'
    : '输入邮箱地址后自动识别收发服务器';
}

function openMailAddPanel(account = null) {
  resetMailAddForm(account);
  document.getElementById('mail-add-panel').dataset.accountId = account?.id || '';
  document.getElementById('mail-add-title').textContent = account ? (mailaiT('acct.updateBtn') || '更新登录信息') : (mailaiT('acct.addTitle') || '新增邮箱');
  document.getElementById('btn-connect-mail').querySelector('span').textContent = account ? '验证并保存' : '新增邮箱';
  document.getElementById('mail-add-panel').classList.remove('hidden');
  document.getElementById('btn-add-mail').classList.add('hidden');
  document.getElementById('account-selection-actions').classList.add('hidden');
  document.getElementById('account-empty-state').classList.add('hidden');
  document.getElementById('mail-config-form').classList.add('editor-open');
  document.getElementById('mail-user').focus();
  if (account?.user && !account.smtp_host) discoverMailProvider(account.user, 'mail');
}

function closeMailAddPanel() {
  document.getElementById('mail-add-panel').classList.add('hidden');
  document.getElementById('btn-add-mail').classList.remove('hidden');
  document.getElementById('mail-config-form').classList.remove('editor-open');
  resetMailAddForm();
  document.getElementById('mail-add-panel').dataset.accountId = '';
  renderAccountSelection();
}

function showSystemView(tab = 'preferences') {
  closeAssistant();
  hideDashboard();
  hideRulesView(false);
  document.querySelector('.layout').classList.add('hidden');
  document.getElementById('system-view').classList.remove('hidden');
  setFetchSettingsContext(true);
  selectSystemTab(tab);
  if (typeof loadWorkspacePreferences === 'function') loadWorkspacePreferences();
  loadSystemConfig().catch(e => toast('加载系统配置失败：' + e.message, 'error'));
  if (tab === 'maintenance') loadBackups();
}

function hideSystemView(force = false) {
  if (!force && _systemConfig && !_systemConfig.mail?.logged_in) {
    selectSystemTab('account');
    toast('请先登录邮箱账号', 'error');
    return;
  }
  document.getElementById('system-view').classList.add('hidden');
  setFetchSettingsContext(false);
  if (document.getElementById('dashboard-view').classList.contains('hidden') &&
      document.getElementById('rules-view').classList.contains('hidden')) {
    document.querySelector('.layout').classList.remove('hidden');
  }
}

function renderRecipients(raw, names = {}) {
  const recipients = recipientEmails(raw);
  if (!recipients.length) return '<span class="recipient-empty">-</span>';
  const button = address => {
    const name = names?.[address.toLowerCase()] || '';
    const label = name ? `${name}，${address}` : address;
    return `<button type="button" class="recipient-chip ${name ? 'has-name' : ''}" data-compose-recipient="${esc(address)}" title="给 ${esc(label)} 写邮件" aria-label="给 ${esc(label)} 写邮件"><span>${esc(name || address)}</span>${name ? `<small>${esc(address)}</small>` : ''}</button>`;
  };
  if (recipients.length <= 3) return `<span class="recipient-simple recipient-compact-list">${recipients.map(button).join('')}</span>`;

  const preview = recipients.slice(0, 2).map(button).join('');
  return `
    <span class="recipient-field">
      <span class="recipient-summary">${preview}</span>
      <span class="recipient-count">等 ${recipients.length} 人</span>
      <button type="button" class="recipient-toggle" aria-expanded="false" onclick="toggleRecipients(this)">展开</button>
      <span class="recipient-list hidden">${recipients.map(button).join('')}</span>
    </span>
  `;
}

function renderSenderContact(name, address) {
  const senderAddress = String(address || '').trim();
  const senderName = String(name || '').trim();
  if (!senderAddress) return `<span>${esc(senderName || '-')}</span>`;
  const hasUsefulName = senderName && senderName.toLowerCase() !== senderAddress.toLowerCase();
  const label = hasUsefulName ? `${senderName}，${senderAddress}` : senderAddress;
  return `<button type="button" class="sender-contact-link ${hasUsefulName ? 'has-name' : ''}" data-compose-recipient="${esc(senderAddress)}" title="给 ${esc(label)} 写邮件" aria-label="给 ${esc(label)} 写邮件"><span>${esc(hasUsefulName ? senderName : senderAddress)}</span>${hasUsefulName ? `<small>${esc(senderAddress)}</small>` : ''}</button>`;
}

document.addEventListener('click', event => {
  const recipient = event.target.closest?.('[data-compose-recipient]');
  if (!recipient) return;
  event.preventDefault();
  event.stopPropagation();
  openCompose({to_addr:recipient.dataset.composeRecipient});
}, true);

function toggleRecipients(button) {
  const field = button.closest('.recipient-field');
  const list = field.querySelector('.recipient-list');
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!expanded));
  button.textContent = expanded ? (mailaiT('common.expand') || '展开') : (mailaiT('common.collapse') || '收起');
  list.classList.toggle('hidden', expanded);
  field.classList.toggle('expanded', !expanded);
}

function closeReadingPane() {
  removeSecurityFlyout();
  document.querySelector('.reading-pane').classList.remove('show');
}

function externalLinkUrl(value, base = location.href) {
  try {
    const url = new URL(String(value || '').trim(), base);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return '';
    if (['http:', 'https:'].includes(url.protocol) && url.origin === location.origin) return '';
    return url.href;
  } catch (_) { return ''; }
}

function protectRichEmailLinks(html) {
  // Keep real hrefs so WKWebView's native policy can route links if the frame
  // callback is unavailable. Its mailto fallback returns to MailAI's composer;
  // only http(s) destinations are allowed to leave the application.
  let content = String(html || '').replace(/<!doctype[^>]*>/ig, '');
  content = content.replace(/<base\b[^>]*>/ig, '');
  content = content.replace(/<meta\b[^>]*http-equiv\s*=\s*(?:["']?refresh["']?)[^>]*>/ig, '');
  return content.replace(/<(a|area)\b[^>]*>/ig, tag => {
    const match = tag.match(/\shref\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
    if (!match) return tag;
    const quote = match[1] || '"';
    const raw = (match[2] ?? match[3] ?? '').slice(0, 4096);
    const safeRaw = quote === '"' ? raw.replace(/"/g, '&quot;') : raw.replace(/'/g, '&#39;');
    const inert = tag.replace(match[0], '')
      .replace(/\s(?:target|ping|onclick)\s*=\s*(?:(["']).*?\1|[^\s>]+)/ig, '');
    return inert.replace(/^<(a|area)\b/i, `<$1 data-mailai-href=${quote}${safeRaw}${quote} href=${quote}${safeRaw}${quote}`);
  });
}

function mailtoComposeSeed(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'mailto:') return null;
    let path = url.pathname || '';
    try { path = decodeURIComponent(path); } catch (_) {}
    const cleanRecipients = input => normalizeRecipientText(String(input || '').replace(/[\r\n]/g, '').slice(0, 4000));
    const params = url.searchParams;
    const to = [path, ...params.getAll('to')].filter(Boolean).join(', ');
    const body = (params.get('body') || '').replace(/\r\n?/g, '\n').slice(0, 20000);
    return {
      mode: 'compose',
      to_addr: cleanRecipients(to),
      cc_addr: cleanRecipients(params.getAll('cc').join(', ')),
      bcc_addr: cleanRecipients(params.getAll('bcc').join(', ')),
      subject: (params.get('subject') || '').replace(/[\r\n]/g, ' ').trim().slice(0, 998),
      message_html: esc(body).replace(/\n/g, '<br>'),
    };
  } catch (_) { return null; }
}

function openMailtoCompose(value) {
  const seed = mailtoComposeSeed(value);
  if (!seed || !seed.to_addr) {
    toast('邮箱地址无效，无法打开写邮件', 'warn');
    return false;
  }
  openCompose(seed);
  return true;
}
window.mailaiOpenMailto = openMailtoCompose;

function openSafeMailLink(url) {
  if (String(url || '').toLowerCase().startsWith('mailto:')) {
    openMailtoCompose(url);
    return Promise.resolve();
  }
  return openExternalLink(url);
}

async function openExternalLink(url) {
  if (window.pywebview?.api?.open_external_url) {
    const result = await window.pywebview.api.open_external_url(url);
    if (!result?.ok) throw new Error('系统浏览器未能打开链接');
    return;
  }
  // noopener deliberately returns null even when the browser opens the tab.
  window.open(url, '_blank', 'noopener,noreferrer');
}

function handleExternalLinkClick(event) {
  const anchor = event.target.closest?.('a[href]');
  if (!anchor || anchor.hasAttribute('download')) return;
  const url = externalLinkUrl(anchor.getAttribute('href'));
  if (!url) return;
  event.preventDefault();
  event.stopPropagation();
  openSafeMailLink(url).catch(error => toast('链接打开失败：' + (error?.message || error), 'error'));
}

document.addEventListener('click', handleExternalLinkClick, true);

function richEmailDocument(html, allowRemote = true) {
  const content = protectRichEmailLinks(html).replace(/\/api\/emails\/\d+\/inline\/\d+(?:\?mailai_account=[a-zA-Z0-9_-]+)?/g, path => path.includes('?') ? path : mailboxResourceUrl(path));
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  return `<!doctype html><html data-mailai-theme="${theme}"><head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:${allowRemote ? ' http: https:' : ''}; style-src 'unsafe-inline'; font-src data:;">
    <style>
      :root{color-scheme:light}*{box-sizing:border-box}html,body{margin:0;padding:0;overflow:hidden;background:transparent;color:#252d29}
      body{padding:6px 4px 18px;font:14px/1.65 Arial,'PingFang SC','Microsoft YaHei',sans-serif;overflow-wrap:anywhere}
      img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}a{color:#28705a;text-decoration:none}
      blockquote{margin:16px 0;padding-left:14px;border-left:3px solid #d9dfdb;color:#66736c}pre{white-space:pre-wrap}
      html[data-mailai-theme="dark"]{color-scheme:dark;background:#16271f}
      html[data-mailai-theme="dark"] body{color:#e4eee8;background:#16271f!important}
      html[data-mailai-theme="dark"] body a{color:#8ddfb2}
      html[data-mailai-theme="dark"] body blockquote{color:#b5c8bc;border-color:#486354}
    </style></head><body>${content}</body></html>`;
}

const richEmailFrames = new Set();
function richEmailColor(value) {
  const parts = String(value || '').match(/[\d.]+/g)?.map(Number) || [];
  if (parts.length < 3) return null;
  return {rgb:parts.slice(0, 3), alpha:parts.length > 3 ? parts[3] : 1};
}

function richEmailLuminance(rgb) {
  const channels = rgb.map(value => {
    const channel = Math.max(0, Math.min(255, value)) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}

function restoreRichEmailThemeOverrides(frame) {
  for (const item of frame._mailThemeOverrides || []) {
    if (!item.node?.isConnected) continue;
    if (item.value) item.node.style.setProperty(item.property, item.value, item.priority);
    else item.node.style.removeProperty(item.property);
  }
  frame._mailThemeOverrides = [];
}

function applyRichEmailFrameTheme(frame, theme = document.documentElement.dataset.theme) {
  const doc = frame.contentDocument;
  if (!doc?.body) return;
  restoreRichEmailThemeOverrides(frame);
  doc.documentElement.setAttribute('data-mailai-theme', theme === 'dark' ? 'dark' : 'light');
  if (theme !== 'dark') return;
  const overrides = frame._mailThemeOverrides = [];
  const override = (node, property, value) => {
    overrides.push({node, property, value:node.style.getPropertyValue(property), priority:node.style.getPropertyPriority(property)});
    node.style.setProperty(property, value, 'important');
  };
  const nodes = [doc.body, ...doc.body.querySelectorAll('*')].slice(0, 3000);
  // Convert light message surfaces together with their text. Inline important
  // backgrounds need inline overrides too; stylesheet rules alone lose to them.
  for (const node of nodes) {
    if (node.matches?.('img,svg,path,video,canvas,picture,source')) continue;
    const background = richEmailColor(doc.defaultView.getComputedStyle(node).backgroundColor);
    if (background?.alpha > .55 && richEmailLuminance(background.rgb) > .5) override(node, 'background-color', '#16271f');
  }
  const backgroundCache = new WeakMap();
  const effectiveBackground = node => {
    if (!node) return {rgb:[22, 39, 31], alpha:1};
    if (backgroundCache.has(node)) return backgroundCache.get(node);
    const own = richEmailColor(doc.defaultView.getComputedStyle(node).backgroundColor);
    const result = own?.alpha > .55 ? own : effectiveBackground(node.parentElement);
    backgroundCache.set(node, result);
    return result;
  };
  for (const node of nodes) {
    if (node.matches?.('img,svg,path,video,canvas,picture,source')) continue;
    const style = doc.defaultView.getComputedStyle(node);
    const foreground = richEmailColor(style.color);
    if (!foreground || foreground.alpha < .15) continue;
    const background = effectiveBackground(node);
    const foregroundLum = richEmailLuminance(foreground.rgb);
    const backgroundLum = richEmailLuminance(background.rgb);
    const contrast = (Math.max(foregroundLum, backgroundLum) + .05) / (Math.min(foregroundLum, backgroundLum) + .05);
    if (contrast < 4.5) override(node, 'color', backgroundLum > .5 ? '#29372f' : node.matches?.('a') ? '#8ddfb2' : '#e4eee8');
  }
}

function syncRichEmailFrameTheme(theme = document.documentElement.dataset.theme) {
  for (const frame of richEmailFrames) {
    try { applyRichEmailFrameTheme(frame, theme); } catch (_) {}
  }
}
document.addEventListener('mailai:themechange', event => syncRichEmailFrameTheme(event.detail?.theme));
// The frame stays script-disabled; only the parent-installed click listener can
// route web links externally or mail links into MailAI's composer.
let richEmailCleanupObserver;
function autoSizeRichEmailFrame(frame) {
  // One owner for detached frames: observers and image callbacks must not keep
  // whole email documents alive after the user selects another message.
  if (!richEmailCleanupObserver) {
    richEmailCleanupObserver = new MutationObserver(() => {
      for (const item of richEmailFrames) if (!item.isConnected) item._disposeRichEmail?.();
    });
    richEmailCleanupObserver.observe(document.body, {childList:true, subtree:true});
  }
  frame.addEventListener('load', () => {
    try {
      frame._disposeRichEmail?.();
      const doc = frame.contentDocument;
      if (!doc?.body || !frame.isConnected) return;
      richEmailFrames.add(frame);
      applyRichEmailFrameTheme(frame);
      let queued = 0, disposed = false, measured = '';
      const listeners = [];
      const sizeKey = () => `${frame.clientWidth}:${doc.body.getBoundingClientRect().height}:${doc.body.scrollHeight}`;
      frame._disposeRichEmail = () => {
        disposed = true;
        cancelAnimationFrame(queued);
        frame._contentResizeObserver?.disconnect();
        listeners.forEach(([node, event, callback]) => node.removeEventListener(event, callback));
        richEmailFrames.delete(frame);
        frame._disposeRichEmail = null;
      };
      const resize = () => {
        if (queued || disposed) return;
        queued = requestAnimationFrame(() => {
          queued = 0;
          if (!frame.isConnected) { frame._disposeRichEmail?.(); return; }
          // Measure from a fixed viewport, not from the height we just assigned.
          // Otherwise 100%/vh email layouts + padding can grow on every callback.
          frame.style.height = '280px';
          const natural = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 280);
          const height = Math.min(natural, 30000);
          frame.style.height = `${height}px`;
          // Viewport-relative templates can expand again at the final height.
          // Keep their remainder reachable without entering another sizing loop.
          doc.body.style.setProperty('overflow-y', 'visible', 'important');
          const overflow = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight) > height;
          frame.setAttribute('scrolling', overflow ? 'auto' : 'no');
          doc.documentElement.style.setProperty('overflow-y', overflow ? 'auto' : 'hidden', 'important');
          measured = sizeKey();
        });
      };
      const openMailLink = event => {
        const anchor = event.target.closest?.('a[data-mailai-href],area[data-mailai-href]');
        if (!anchor) return;
        event.preventDefault();
        event.stopPropagation();
        const url = externalLinkUrl(anchor.getAttribute('data-mailai-href'));
        if (!url) {
          toast('出于安全考虑，仅支持打开 http、https 或 mailto 链接', 'warn');
          return;
        }
        openSafeMailLink(url).catch(error => toast('链接打开失败：' + (error?.message || error), 'error'));
      };
      doc.addEventListener('click', openMailLink, true);
      listeners.push([doc, 'click', openMailLink]);
      const blockMailForm = event => { event.preventDefault(); toast('请使用邮件中的网页链接，表单不能在邮件正文内提交', 'warn'); };
      doc.addEventListener('submit', blockMailForm, true);
      listeners.push([doc, 'submit', blockMailForm]);
      resize();
      doc.querySelectorAll('img').forEach(image => {
        if (!image.complete) for (const event of ['load', 'error']) {
          image.addEventListener(event, resize, {once:true});
          listeners.push([image, event, resize]);
        }
      });
      if ('ResizeObserver' in window) {
        frame._contentResizeObserver = new ResizeObserver(() => {
          if (sizeKey() !== measured) resize();
        });
        frame._contentResizeObserver.observe(doc.body);
        frame._contentResizeObserver.observe(frame);
      }
    } catch (_) {}
  });
}

function mountRichEmailBody(e, allowRemote = true) {
  const host = document.getElementById('rich-email-body');
  if (!host || !e.body_html) return;
  const frame = document.createElement('iframe');
  frame.className = 'rich-email-frame';
  frame.setAttribute('sandbox', 'allow-same-origin allow-top-navigation-to-custom-protocols');
  frame.setAttribute('title', '邮件原始 HTML 正文');
  frame.setAttribute('scrolling', 'no');
  autoSizeRichEmailFrame(frame);
  frame.srcdoc = richEmailDocument(e.body_html, allowRemote);
  host.replaceChildren(frame);
  const remoteButton = document.getElementById('btn-load-remote-images');
  if (remoteButton) {
    remoteButton.textContent = allowRemote ? '外部图片已显示' : '显示外部图片';
    remoteButton.disabled = allowRemote;
  }
}

function renderFindings(items) {
  if (!Array.isArray(items) || !items.length) return '<li class="finding-empty">未发现需要特别留意的安全信号</li>';
  return items.map(f => {
    const title = f.title || f.name || '需要留意的安全信号';
    const explanation = f.explanation || f.detail || '请结合邮件内容确认是否符合预期。';
    const code = f.technical_code || f.code || '';
    const technicalDetail = f.technical_detail || f.detail || '';
    return `<li class="finding-item">
      <span class="finding-copy">
        <strong>${esc(title)}</strong>
        <span class="finding-detail">${esc(explanation)}</span>
        ${code ? `<span class="finding-tech" title="${esc(technicalDetail)}">技术标识 ${esc(code)}</span>` : ''}
      </span>
      <span class="finding-weight" title="该信号计入规则分">+${Number(f.weight || 0)}</span>
    </li>`;
  }).join('');
}

function renderReadingPane(e) {
  removeSecurityFlyout();
  document.body.classList.remove('security-flyout-open');
  // 防御性处理：后端 JSON 字段在某些旧数据/异常场景下可能是字符串
  const parseArr = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  };
  e.findings = parseArr(e.findings);
  e.llm_reasons = parseArr(e.llm_reasons);
  e.attachments = parseArr(e.attachments);
  e.url_chain = parseArr(e.url_chain);
  e.attachment_analysis = parseArr(e.attachment_analysis);

  const risk = getRiskLabel(e.score, e.verdict, e);
  const riskScore = Number(e.score || 0);
  const riskNeedsAttention = needsRiskAttention(e);
  const gauge = buildRiskGauge(riskScore, risk);
  const riskSummary = risk.class === 'danger'
    ? '检测到高风险信号，请勿直接点击链接或打开可疑附件。'
    : risk.class === 'warn'
      ? '发现需要核实的信号，建议确认发件人和邮件意图。'
      : risk.class === 'muted'
        ? '这封邮件尚未完成智能安全分析。'
        : risk.reviewed
          ? '已结合人工反馈确认，可继续阅读邮件内容。'
          : '暂未发现明显安全风险，可正常阅读并保持必要警惕。';
  const findings = renderFindings(e.findings);

  const llmReasons = (e.llm_reasons || []).length ? `
    <div class="reading-section">
      <div class="section-title">🤖 LLM 复核理由</div>
      <ul class="findings">${e.llm_reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>
  ` : '';

  const evidenceSummary = e.evidence_summary || {};
  const evidenceDimensions = (evidenceSummary.dimensions || []).length ? `
    <div class="reading-section insight-section evidence-fusion">
      <div class="section-title"><span>风险线索概览</span><small>${evidenceSummary.dimension_count} 类线索 · ${evidenceSummary.signal_count} 项发现</small></div>
      <div class="evidence-dimensions">
        ${evidenceSummary.dimensions.map(d => `
          <div class="evidence-dimension" title="${esc((d.evidence || []).join('；'))}">
            <span>${esc(d.name)}</span><b>+${d.weight}</b><small>${d.count} 项</small>
          </div>`).join('')}
      </div>
    </div>` : '';

  const attachments = (e.attachments || []).length ? `
    <div class="reading-section">
      <div class="section-title">📎 附件（${e.attachments.length}）</div>
      <div class="attachments">${e.attachments.map((a, i) => `
        <a class="attachment" href="${mailboxResourceUrl(`/api/emails/${e.id}/attachments/${i}`)}" download="${esc(a.name)}" target="_blank">
          <span class="att-icon">📄</span>
          <span class="att-name">${esc(a.name)}</span>
          <span class="att-size">${fmtSize(a.size)}</span>
        </a>
      `).join('')}</div>
    </div>
  ` : '';

  // 操作按钮
  let replyActions = '<button type="button" class="btn-ghost mobile-back" onclick="closeReadingPane()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18"/></svg><span>返回列表</span></button>';
  replyActions += `<div class="reading-reply-group" role="toolbar" aria-label="邮件回复操作">
    <button type="button" class="btn-ghost reading-icon-action" aria-label="回复" data-tooltip="回复" onclick="composeFromEmail('reply')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6-6 6 6 6M4 12h9c4 0 6.5 2 7 6"/></svg><span class="reading-action-label">回复</span></button>
    <button type="button" class="btn-ghost reading-icon-action" aria-label="回复全部" data-tooltip="回复全部" onclick="composeFromEmail('reply_all')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6-6 6 6 6m5-12-6 6 6 6M9 12h5c3.5 0 6 2 6.5 6"/></svg><span class="reading-action-label">回复全部</span></button>
    <button type="button" class="btn-ghost reading-icon-action" aria-label="转发" data-tooltip="转发" onclick="composeFromEmail('forward')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6 6 6-6 6m6-6h-9c-4 0-6.5 2-7 6"/></svg><span class="reading-action-label">转发</span></button>
    <span class="reading-reply-divider" aria-hidden="true"></span>
    <button type="button" class="btn-ghost reading-icon-action btn-correspondence" aria-label="查看往来邮件" data-tooltip="查看往来邮件" onclick="openCorrespondence()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/></svg><span class="reading-action-label">往来</span></button>
  </div>`;
  const actionIcon = path => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const restoreIcon = actionIcon('M4 11a8 8 0 1 1 2 7M4 5v6h6');
  const checkIcon = actionIcon('M4 12l5 5L20 6');
  const shieldIcon = actionIcon('M12 2 4 5v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V5zM9 12l2 2 4-4');
  const flagIcon = actionIcon('M5 21V4m0 1c3-2 5 2 8 0s5-1 6 0v10c-3-1-4-2-7 0s-5-2-7 0');
  let decisionActions = '';
  if (e.status === 'quarantine' || e.status === 'spam') {
    decisionActions += `<button class="btn-success" onclick="restoreEmail(${e.id})">${restoreIcon}<span>恢复回收件箱</span></button>`;
    if (!e.reviewed) decisionActions += `<button class="btn-danger" onclick="confirmEmail(${e.id}, '保留隔离', this)">${shieldIcon}<span>保留隔离</span></button>`;
    decisionActions += `<button class="btn-ghost" onclick="feedbackEmail(${e.id}, 'fp')">${checkIcon}<span>标记为正常</span></button>`;
  } else if (needsRiskAttention(e) && (e.recommended_status === 'quarantine' || e.recommended_status === 'spam')) {
    const label = e.recommended_status === 'quarantine' ? '隔离' : '移入垃圾邮件';
    decisionActions += `<button class="btn-danger" onclick="confirmEmail(${e.id}, '${label}', this)">${shieldIcon}<span>执行${label}</span></button>`;
    decisionActions += `<button class="btn-ghost" onclick="feedbackEmail(${e.id}, 'fp')">${checkIcon}<span>标记为正常</span></button>`;
  } else if (e.verdict === 'phishing' || e.verdict === 'suspicious') {
    decisionActions += `<button class="btn-ghost" onclick="feedbackEmail(${e.id}, 'fp')">${checkIcon}<span>标记为正常</span></button>`;
  } else {
    if (!e.reviewed) decisionActions += `<button class="btn-success" onclick="confirmEmail(${e.id}, '无风险', this)">${shieldIcon}<span>确认无风险</span></button>`;
    decisionActions += `<button class="btn-ghost" onclick="feedbackEmail(${e.id}, 'fn')">${flagIcon}<span>报告风险</span></button>`;
  }

  document.getElementById('reading-content').innerHTML = `
    <div class="reading-header">
      <div class="reading-header-inner">
        ${risk.class === 'danger' && riskNeedsAttention ? `
          <button type="button" class="phishing-alert-banner" aria-live="assertive" onclick="toggleSecurityAnalysis(true)">
            <span class="phishing-alert-icon" aria-hidden="true">!</span>
            <span class="phishing-alert-copy"><b>${mailaiT('read.alertTitle') || '高风险邮件，请先核实再操作'}</b><small>${mailaiT('read.alertHint') || '不要直接点击链接、回复敏感信息或打开可疑附件'}</small></span>
            <em>${mailaiT('read.alertAction') || '查看安全依据'} <span aria-hidden="true">→</span></em>
          </button>` : ''}
        <div class="reading-heading-row">
          <h2 class="reading-subject">${esc(e.subject)}</h2>
          <button type="button" class="security-result-trigger security-${risk.class} ${riskNeedsAttention ? 'needs-attention' : ''} ${risk.class === 'danger' && riskNeedsAttention ? 'risk-attention-intro' : ''}" aria-expanded="false" onclick="toggleSecurityAnalysis()" title="打开智能研判明细">
            <span aria-hidden="true">${risk.class === 'danger' || risk.class === 'warn' ? '!' : risk.class === 'muted' ? '…' : '✓'}</span>
            <small>${mailaiT('read.securityResult') || '安全结果'}</small><b>${esc(risk.text)}</b><em>${riskScore}</em>
          </button>
        </div>
        <div class="reading-meta">
          <div class="meta-avatar">${(e.from_name || e.from_addr || '?').charAt(0).toUpperCase()}</div>
          <div class="meta-fields">
            <div class="meta-sender-row"><span class="meta-label">${mailaiT('read.from') || '发件人：'}</span>${renderSenderContact(e.from_name, e.from_addr)}</div>
            <div class="meta-recipient-row"><span class="meta-label">${mailaiT('read.to') || '收件人：'}</span>${renderRecipients(e.to_addr, e.recipient_names)}</div>
            <div><span class="meta-label">${mailaiT('read.time') || '时间：'}</span>${fmtDate(e.date)}</div>
          </div>
          <div class="meta-badges">
            ${e.category ? `<span class="tag">${esc(mailCategoryLabel(e.category))}</span>` : ''}
            ${e.priority ? `<span class="tag tag-priority-${e.priority}">${esc(mailPriorityLabel(e.priority))}</span>` : ''}
          </div>
        </div>
        <div class="reading-actions">
          <section class="reading-action-group reading-mail-group" aria-label="邮件操作"><span class="reading-action-group-title">${mailaiT('read.groupMail') || '邮件操作'}</span><div class="reading-mail-controls"><div class="reading-reply-actions">${replyActions}</div></div></section>
          <section class="reading-action-group reading-ai-group" aria-label="AI 助手"><span class="reading-action-group-title">${mailaiT('read.groupAi') || 'AI 助手'}</span></section>
          <section class="reading-action-group reading-risk-group" aria-label="风险封控"><span class="reading-action-group-title">${mailaiT('read.groupRisk') || '风险封控'}</span><div class="reading-decision-actions">${decisionActions}</div></section>
        </div>
      </div>
    </div>

    <button type="button" class="security-flyout-backdrop hidden" aria-label="关闭智能研判明细" onclick="toggleSecurityAnalysis(false)"></button>
    <aside id="security-analysis-panel" class="security-flyout hidden" aria-label="智能研判明细" tabindex="-1">
      <div class="security-flyout-head">
        <div><span class="eyebrow">${mailaiT('read.verdictEyebrow') || '智能研判'}</span><h3>${mailaiT('read.verdictTitle') || '安全结果与证据'}</h3></div>
        <button type="button" aria-label="关闭智能研判明细" onclick="toggleSecurityAnalysis(false)">✕</button>
      </div>
      <div class="security-flyout-result security-${risk.class}">
        ${gauge}
        <div><span>${mailaiT('read.verdictCurrent') || '当前结论'}</span><h4>${esc(risk.text)}</h4><p>${esc(riskSummary)}</p></div>
      </div>
      <div class="security-analysis-grid">
        ${evidenceDimensions}
        <div class="reading-section insight-section">
          <div class="section-title"><span>${mailaiT('read.findings') || '具体发现'}</span><small>${(mailaiT('read.findingsScore') || '累计风险分 {n}').replace('{n}', riskScore)}</small></div>
          <ul class="findings">${findings}</ul>
        </div>
        ${llmReasons}
        ${renderSenderProfile(e.sender_profile)}
        ${renderCampaignInsight(e.campaign)}
        ${renderThreadContext(e.thread_context)}
        ${renderUrlChains(e.url_chain)}
        ${renderAttachmentAnalysis(e.attachment_analysis)}
      </div>
    </aside>

    <div class="reading-workspace">
      <main class="reading-main">
        <div class="reading-section summary-section primary-summary">
          <div class="section-title"><span>${mailaiT('read.summaryTitle') || 'AI 摘要'}</span><small>${mailaiT('read.summaryHint') || '提炼重点，完整展示'}</small></div>
          <div class="summary-quick-meta">
            ${e.category ? `<span>${esc(mailCategoryLabel(e.category))}</span>` : ''}
            ${e.priority ? `<span>${esc(mailPriorityLabel(e.priority))}</span>` : ''}
            ${(e.attachments || []).length ? `<span>${(mailaiT('read.attachCount') || '{n} 个附件').replace('{n}', e.attachments.length)}</span>` : ''}
          </div>
          <div id="primary-summary-content" class="markdown-body summary-box">${mdToHtml(e.summary || e.snippet || (mailaiT('read.noSummary') || '暂无摘要'))}</div>
        </div>

        <div class="reading-section body-section">
          <div class="section-title"><span>${mailaiT('read.body') || '邮件正文'}</span><div class="body-format-actions"><small>${e.has_rich_body ? (e.has_remote_images ? (mailaiT('read.fmtHtmlImages') || 'HTML 原始排版 · 外链图片已显示') : (mailaiT('read.fmtHtml') || 'HTML 原始排版')) : (mailaiT('read.fmtPlainOpt') || '纯文本邮件 · 优化排版')}</small></div></div>
          ${e.has_rich_body ? `<div id="rich-email-body" class="email-body rich-email-body"><div class="reading-loading">${mailaiT('read.restoring') || '正在还原邮件排版…'}</div></div>` : `<div class="markdown-body email-body plain-email-body">${mdToHtml(e.body_text || '')}</div>`}
        </div>

        ${attachments}
      </main>
    </div>
  `;
  const readingContent = document.getElementById('reading-content');
  const securityBackdrop = readingContent.querySelector('.security-flyout-backdrop');
  const securityFlyout = readingContent.querySelector('.security-flyout');
  if (securityBackdrop && securityFlyout) document.body.append(securityBackdrop, securityFlyout);
  mountRichEmailBody(e);
}

function removeSecurityFlyout() {
  document.body.classList.remove('security-flyout-open');
  document.querySelectorAll('body > .security-flyout, body > .security-flyout-backdrop').forEach(element => element.remove());
}

function toggleSecurityAnalysis(forceOpen = null) {
  const panel = document.getElementById('security-analysis-panel');
  const backdrop = document.querySelector('.security-flyout-backdrop');
  const trigger = document.querySelector('.security-result-trigger');
  if (!panel || !backdrop || !trigger) return;
  const opening = forceOpen === null ? panel.classList.contains('hidden') : Boolean(forceOpen);
  panel.classList.toggle('hidden', !opening);
  backdrop.classList.toggle('hidden', !opening);
  trigger.setAttribute('aria-expanded', String(opening));
  document.body.classList.toggle('security-flyout-open', opening);
  if (opening) panel.focus();
  else trigger.focus();
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const panel = document.getElementById('security-analysis-panel');
  if (panel && !panel.classList.contains('hidden')) toggleSecurityAnalysis(false);
});

function renderSenderProfile(prof) {
  if (!prof || !prof.sender_key) return '';
  const parseArr = (v) => Array.isArray(v) ? v : (typeof v === 'string' ? JSON.parse(v) : []);
  const commonHours = parseArr(prof.common_hours);
  const categories = parseArr(prof.typical_categories);
  const attTypes = parseArr(prof.attachment_types);
  return `
    <div class="reading-section">
      <div class="section-title">👤 发件人画像（风险分 ${prof.risk_score || 0}）</div>
      <div class="info-grid">
        <div><span class="info-label">邮箱</span>${esc(prof.sender_key)}</div>
        <div><span class="info-label">首次出现</span>${fmtDate(prof.first_seen)}</div>
        <div><span class="info-label">历史邮件</span>${prof.message_count || 0} 封</div>
        <div><span class="info-label">常见时段</span>${commonHours.join(', ') || '-'}</div>
        <div><span class="info-label">常见分类</span>${categories.join(', ') || '-'}</div>
        <div><span class="info-label">附件类型</span>${attTypes.join(', ') || '-'}</div>
      </div>
    </div>
  `;
}

function renderCampaignInsight(campaign) {
  if (!campaign || !campaign.size) return '';
  const samples = Array.isArray(campaign.samples) ? campaign.samples : [];
  return `<div class="reading-section campaign-insight">
    <div class="section-title"><span class="campaign-title-icon"><svg viewBox="0 0 20 20"><circle cx="5" cy="6" r="2"/><circle cx="15" cy="5" r="2"/><circle cx="10" cy="15" r="2"/><path d="M6.8 6.8l6.1-1M6.2 7.7l2.8 5.5M13.9 6.8l-3 6.4"/></svg></span><span>同源攻击关联</span><small>${campaign.size} 封邮件</small></div>
    <p class="campaign-explain">系统发现这些邮件共享${esc((campaign.signals || []).join('、') || '相似内容特征')}，可能属于同一批攻击。建议联动核查，而不是只处理当前一封。</p>
    <div class="campaign-impact"><span><b>${campaign.phishing_count || 0}</b><small>封高风险</small></span><span><b>${campaign.pending_count || 0}</b><small>封待确认</small></span><span><b>${campaign.max_score || 0}</b><small>最高风险分</small></span></div>
    <div class="campaign-samples">${samples.slice(0, 4).map(item => `<button type="button" onclick="openCampaignEmail(${Number(item.id)})"><span>${esc(item.subject || '（无主题）')}</span><small>${esc(item.from_addr || '')} · ${esc(fmtDate(item.date))}</small></button>`).join('')}</div>
  </div>`;
}

async function openCampaignEmail(emailId) {
  toggleSecurityAnalysis(false);
  await revealEmailFromSource(Number(emailId));
}

let correspondenceRevision = 0;
let correspondenceData = null;
let correspondenceCurrentId = null;
let correspondenceAccountId = '';
let correspondenceSource = null;
let correspondenceSelectedIds = new Set();
let correspondenceBusy = false;
let correspondenceOperationCount = 0;
let correspondenceProcessedCount = 0;

function closeCorrespondence() {
  if (correspondenceBusy) {
    toast('邮件正在移入垃圾箱，请等待当前操作完成', 'warn');
    return;
  }
  correspondenceRevision += 1;
  correspondenceData = null;
  correspondenceCurrentId = null;
  correspondenceAccountId = '';
  correspondenceSource = null;
  correspondenceSelectedIds.clear();
  const drawer = document.getElementById('correspondence-drawer');
  if (!drawer) return;
  drawer.classList.add('hidden');
  drawer.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.drawer:not(.hidden), .modal:not(.hidden)')) document.body.style.overflow = '';
}

function correspondenceRisk(item) {
  const risk = getRiskLabel(item.score, item.verdict, item);
  return `<span class="correspondence-risk security-${risk.class}">${esc(risk.text)}</span>`;
}

function correspondenceSelectableItems() {
  return (correspondenceData?.emails || []).filter(item => item.status !== 'trash');
}

function syncCorrespondenceSelection() {
  const available = new Set(correspondenceSelectableItems().map(item => Number(item.id)));
  correspondenceSelectedIds.forEach(id => { if (!available.has(Number(id))) correspondenceSelectedIds.delete(id); });
  document.querySelectorAll('[data-correspondence-select]').forEach(control => {
    const id = Number(control.dataset.correspondenceSelect);
    control.checked = correspondenceSelectedIds.has(id);
    control.closest('.correspondence-item')?.classList.toggle('selected', control.checked);
    control.disabled = correspondenceBusy || !available.has(id);
  });
  const count = correspondenceSelectedIds.size;
  const total = available.size;
  const countNode = document.getElementById('correspondence-selected-count');
  if (countNode) countNode.textContent = count ? `已选 ${count} 封` : '请选择要移入垃圾箱的邮件';
  const allButton = document.querySelector('[data-correspondence-select-all]');
  if (allButton) {
    allButton.disabled = correspondenceBusy || !total;
    allButton.textContent = count === total && total ? '取消全选' : `全选${total ? `（${total}）` : ''}`;
  }
  const deleteButton = document.querySelector('[data-correspondence-delete]');
  if (deleteButton) {
    deleteButton.disabled = correspondenceBusy || !count;
    deleteButton.classList.toggle('loading', correspondenceBusy);
    deleteButton.querySelector('span').textContent = correspondenceBusy ? `正在处理 ${count} 封…` : '移入垃圾箱';
  }
  const drawer = document.getElementById('correspondence-drawer');
  const processing = document.getElementById('correspondence-processing');
  drawer?.setAttribute('aria-busy', correspondenceBusy ? 'true' : 'false');
  processing?.classList.toggle('hidden', !correspondenceBusy);
  const processingDetail = document.getElementById('correspondence-processing-detail');
  if (processingDetail && correspondenceBusy) processingDetail.textContent =
    `正在移入垃圾箱：已处理 ${correspondenceProcessedCount}/${correspondenceOperationCount || count} 封。正在等待邮件服务器确认，请勿重复操作。`;
}

function renderCorrespondence(data, currentId) {
  const allItems = Array.isArray(data?.emails) ? data.emails : [];
  const items = allItems.filter(item => item.status !== 'trash');
  const notice = data?.operationNotice ? `<p class="correspondence-result" role="status">${esc(data.operationNotice)}</p>` : '';
  if (!items.length) return `<div class="correspondence-empty">
    <span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h16v11H4zM5 8l7 6 7-6"/></svg></span>
    <h4>${allItems.length ? '往来邮件已清空' : '还没有往来邮件'}</h4>
    <p>${allItems.length ? '已移入垃圾箱的邮件不再显示，可前往垃圾箱查看或恢复。' : '当前邮箱已同步的记录中没有找到该联系人的邮件。'}</p>${notice}
  </div>`;
  const selectable = items.filter(item => item.status !== 'trash').length;
  return `${notice}<div class="correspondence-toolbar" role="toolbar" aria-label="选择并删除往来邮件">
    <button type="button" data-correspondence-select-all ${selectable ? '' : 'disabled'}>全选${selectable ? `（${selectable}）` : ''}</button>
    <span id="correspondence-selected-count" role="status" aria-live="polite">请选择要移入垃圾箱的邮件</span>
    <button type="button" class="correspondence-delete" data-correspondence-delete disabled><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M7 6V4h6v2M6 8l.7 8h6.6l.7-8M8.5 9.5v4M11.5 9.5v4"/></svg><span>移入垃圾箱</span></button>
  </div><div class="correspondence-list" role="list" aria-label="往来邮件查找结果">
    ${items.map(item => {
      const isCurrent = Number(item.id) === Number(currentId);
      const inTrash = item.status === 'trash';
      const direction = item.direction === 'sent' ? '发出' : '收到';
      const sender = item.from_name || item.from_addr || '未知联系人';
      const checked = correspondenceSelectedIds.has(Number(item.id));
      return `<div class="correspondence-item${isCurrent ? ' current' : ''}${checked ? ' selected' : ''}${inTrash ? ' in-trash' : ''}" role="listitem">
        <label class="correspondence-check" title="${inTrash ? '该邮件已在垃圾箱' : '选择这封邮件'}"><input type="checkbox" data-correspondence-select="${Number(item.id)}" ${checked ? 'checked' : ''} ${inTrash || correspondenceBusy ? 'disabled' : ''} aria-label="选择邮件：${esc(item.subject || '无主题')}"><span aria-hidden="true"></span></label>
        <button type="button" class="correspondence-open" data-correspondence-email="${Number(item.id)}" ${isCurrent ? 'disabled aria-current="true"' : ''}>
          <span class="correspondence-direction ${item.direction === 'sent' ? 'sent' : 'received'}">${direction}</span>
          <span class="correspondence-copy"><span class="correspondence-item-head"><strong>${esc(item.subject || '（无主题）')}</strong><time>${esc(fmtDate(item.date))}</time></span><small>${esc(sender)}</small><p>${esc(item.snippet || '暂无内容预览')}</p></span>
          <span class="correspondence-side">${inTrash ? '<em>已在垃圾箱</em>' : isCurrent ? '<em>当前邮件</em>' : correspondenceRisk(item)}${isCurrent ? '' : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>'}</span>
        </button>
      </div>`;
    }).join('')}
  </div>`;
}

async function loadCorrespondence(source) {
  if (!source) return;
  correspondenceSource = source;
  const currentId = source.kind === 'email' ? Number(source.id) : null;
  const revision = ++correspondenceRevision;
  correspondenceData = null;
  correspondenceCurrentId = currentId;
  correspondenceAccountId = source.accountId || activeMailAccount()?.id || '';
  correspondenceSelectedIds.clear();
  const drawer = document.getElementById('correspondence-drawer');
  const body = document.getElementById('correspondence-body');
  const subtitle = document.getElementById('correspondence-subtitle');
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  subtitle.textContent = source.kind === 'contact' ? `正在查找与 ${source.email} 的历史邮件…` : '正在识别联系人并查找历史邮件…';
  body.innerHTML = '<div class="correspondence-loading"><span></span><b>正在查找往来邮件</b><small>范围为当前邮箱已同步的邮件</small></div>';
  try {
    const path = source.kind === 'contact'
      ? `/api/mail/contacts/correspondence?email=${encodeURIComponent(source.email)}&limit=50`
      : `/api/emails/${source.id}/correspondence?limit=50`;
    const data = await api(path, {accountId:correspondenceAccountId});
    if (revision !== correspondenceRevision) return;
    const visibleCount = (data.emails || []).filter(item => item.status !== 'trash').length;
    const counterpart = source.name && source.name !== data.counterpart ? `${source.name} · ${data.counterpart}` : data.counterpart;
    subtitle.textContent = counterpart ? `${counterpart} · 当前显示 ${visibleCount} 封往来邮件` : '未识别到对方联系人';
    correspondenceData = data;
    body.innerHTML = renderCorrespondence(data, currentId);
    syncCorrespondenceSelection();
  } catch (err) {
    if (revision !== correspondenceRevision) return;
    subtitle.textContent = '历史邮件暂时无法加载';
    body.innerHTML = `<div class="correspondence-empty error"><h4>加载失败</h4><p>${esc(err.message)}</p><button type="button" data-retry-correspondence>重新加载</button></div>`;
  }
}

async function openCorrespondence() {
  const email = selectedEmailDetail;
  if (!email?.id) return toast('请先选择一封邮件', 'warn');
  return loadCorrespondence({kind:'email', id:Number(email.id), accountId:selectedEmailAccountId || activeMailAccount()?.id || ''});
}

async function openContactCorrespondence(contact, accountId) {
  const email = String(contact?.email || '').trim();
  if (!email) return toast('联系人邮箱无效', 'warn');
  closeContactCenter();
  return loadCorrespondence({kind:'contact', email, name:String(contact?.name || '').trim(), accountId:accountId || activeMailAccount()?.id || ''});
}

function reloadCorrespondence() {
  return correspondenceSource ? loadCorrespondence({...correspondenceSource}) : openCorrespondence();
}

async function deleteSelectedCorrespondence() {
  if (correspondenceBusy || !correspondenceSelectedIds.size) return;
  const accountId = correspondenceAccountId || selectedEmailAccountId || activeMailAccount()?.id || '';
  const ids = [...correspondenceSelectedIds];
  const counterpart = correspondenceData?.counterpart || '该联系人';
  if (!window.confirm(`确认将选中的 ${ids.length} 封与 ${counterpart} 的往来邮件移入垃圾箱？\n\n移入后可在垃圾箱中恢复。`)) return;
  const viewRevision = correspondenceRevision;
  correspondenceBusy = true;
  correspondenceOperationCount = ids.length;
  correspondenceProcessedCount = 0;
  syncCorrespondenceSelection();
  const completedIds = new Set();
  const failed = [];
  try {
    for (let start = 0; start < ids.length; start += 5) {
      const batch = ids.slice(start, start + 5);
      try {
        const result = await api('/api/emails/bulk', {accountId, method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ids:batch, action:'trash'})});
        const failedIds = new Set((result.failed || []).map(item => Number(item.id)));
        batch.forEach(id => { if (!failedIds.has(Number(id))) completedIds.add(Number(id)); });
        failed.push(...(result.failed || []));
      } catch (error) {
        failed.push(...batch.map(id => ({id, error:error.message})));
      }
      correspondenceProcessedCount += batch.length;
      if (correspondenceData && viewRevision === correspondenceRevision) {
        correspondenceData.emails = correspondenceData.emails.map(item => completedIds.has(Number(item.id)) ? {...item, status:'trash'} : item);
        const subtitle = document.getElementById('correspondence-subtitle');
        if (subtitle) subtitle.textContent = `${counterpart} · 当前显示 ${correspondenceSelectableItems().length} 封往来邮件`;
        document.getElementById('correspondence-body').innerHTML = renderCorrespondence(correspondenceData, correspondenceCurrentId);
      }
      syncCorrespondenceSelection();
    }
    if (correspondenceData && viewRevision === correspondenceRevision) {
      correspondenceData.emails = correspondenceData.emails.map(item => completedIds.has(Number(item.id)) ? {...item, status:'trash'} : item);
      correspondenceSelectedIds = new Set(failed.map(item => Number(item.id)));
      correspondenceData.operationNotice = `已将 ${completedIds.size} 封邮件移入垃圾箱${failed.length ? `；${failed.length} 封未完成，已保留选中，可再次点击移入垃圾箱重试。原因：${failed[0].error || '服务器未确认'}` : '，可前往垃圾箱恢复。'}`;
      document.getElementById('correspondence-body').innerHTML = renderCorrespondence(correspondenceData, correspondenceCurrentId);
    }
    toast(`已将 ${completedIds.size} 封邮件移入垃圾箱${failed.length ? `，失败 ${failed.length} 封` : ''}`, failed.length ? 'warn' : 'success');
    if (failed.length && typeof showOperationFailures === 'function') showOperationFailures(failed, deleteSelectedCorrespondence);
  } finally {
    correspondenceBusy = false;
    syncCorrespondenceSelection();
    correspondenceOperationCount = 0;
  }
  // The remote mutation is complete at this point. Do not keep the deletion
  // overlay up while the much larger mailbox view refreshes in the background.
  if (accountId === (activeMailAccount()?.id || '')) {
    loadData().catch(error => toast(`邮件列表后台刷新失败：${error.message}`, 'warn'));
  }
}

async function openCorrespondenceEmail(emailId) {
  closeCorrespondence();
  await revealEmailFromSource(Number(emailId));
}

function renderThreadContext(ctx) {
  if (!ctx || !ctx.thread_id) return '';
  const parseArr = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return []; } }
    return [];
  };
  const history = parseArr(ctx.history);
  if (!history.length) return '';
  const summary = String(ctx.summary || '').trim();
  const summaryLooksRaw = /(^|\n)\s*(?:-\s*\[|发件人\s*:|主题\s*:|时间\s*:|正文摘要\s*:)/m.test(summary);
  return `
    <div class="reading-section thread-context-section">
      <div class="section-title thread-context-title"><span class="thread-context-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.5h12v8H9l-3.5 3v-3H4z"/></svg></span><span>历史会话</span><small>${history.length} 封往来邮件</small></div>
      ${summary && !summaryLooksRaw ? `<div class="thread-summary"><span>会话概览</span><p>${esc(summary)}</p></div>` : ''}
      <div class="thread-timeline">
        ${history.map(h => {
          const sender = h.from_name || h.from_addr || '未知发件人';
          const initial = String(sender).trim().charAt(0).toUpperCase() || '?';
          return `<article class="thread-item">
            <span class="thread-avatar" aria-hidden="true">${esc(initial)}</span>
            <div class="thread-content">
              <div class="thread-item-head"><strong>${esc(h.subject || '（无主题）')}</strong><time datetime="${esc(h.date || '')}">${esc(fmtDate(h.date))}</time></div>
              <div class="thread-sender"><span>${esc(sender)}</span>${h.from_name && h.from_addr ? `<small>&lt;${esc(h.from_addr)}&gt;</small>` : ''}</div>
              ${h.snippet ? `<p class="thread-snippet">${esc(h.snippet)}</p>` : ''}
            </div>
          </article>`;
        }).join('')}
      </div>
    </div>
  `;
}

function renderUrlChains(chains) {
  // 防御性处理：后端可能返回 null / 字符串 / 对象
  if (typeof chains === 'string') {
    try { chains = JSON.parse(chains); } catch { chains = null; }
  }
  if (!Array.isArray(chains) || !chains.length) return '';

  // 节点流程图：短链 → 中间跳 → 最终落地。只有连接失败/阻断才标红；
  // 过去只要存在最终域名就标红，会把正常解析出的 IP 错画成风险 IP。
  const host = u => { try { return new URL(u).hostname; } catch { return u || '-'; } };
  return `
    <div class="reading-section">
      <div class="section-title">🔗 链接链路信息</div>
      ${chains.map(c => {
        const steps = (c.chain || []);
        const trusted = c.trusted_final === true;
        const failed = c.status === 'error' || c.status === 'timeout' || steps.some(step => step.status === 0 || step.status >= 400);
        const nodes = steps.map((s, i) => {
          const isLast = i === steps.length - 1;
          const bad = s.status >= 400 || s.status === 0;
          const cls = bad ? 'danger' : (isLast && trusted ? 'trusted' : (i === 0 ? 'start' : 'mid'));
          return `
            <div class="chain-node ${cls}">
              <div class="chain-node-dot"></div>
              <div class="chain-node-info">
                <div class="chain-node-host">${esc(host(s.url))}</div>
                <div class="chain-node-url" title="${esc(s.url)}">${esc(s.url)}</div>
                <div class="chain-node-status ${s.status >= 400 || s.status === 0 ? 'bad' : ''}">${s.status || '连接失败'}</div>
              </div>
            </div>
            ${!isLast ? '<div class="chain-link"></div>' : ''}
          `;
        }).join('');
        return `
        <div class="chain-box">
          <div class="chain-final ${trusted ? 'trusted' : (failed ? 'danger' : '')}">
            ${trusted ? '✓ 可信域名' : (failed ? '⚠ 链路异常' : '→ 最终落地')}：${esc(c.final_domain || '-')}${c.final_ip ? `（解析 IP: ${esc(c.final_ip)}）` : ''}
            ${steps.length > 1 ? `<span class="chain-hops">共 ${steps.length} 次跳转</span>` : ''}
          </div>
          <div class="chain-flow">${nodes}</div>
        </div>`;
      }).join('')}
    </div>
  `;
}

function renderAttachmentAnalysis(list) {
  // 防御性处理：后端可能返回 null / 字符串 / 对象
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = null; }
  }
  if (!Array.isArray(list) || !list.length) return '';
  return `
    <div class="reading-section">
      <div class="section-title">🔍 附件深度分析</div>
      ${list.map(a => `
        <div class="att-analysis">
          <div class="att-analysis-name">${esc(a.name)}</div>
          <div class="info-grid">
            <div><span class="info-label">SHA256</span><code>${esc(a.sha256)}</code></div>
            <div><span class="info-label">真实类型</span>${esc(a.real_type)}</div>
            <div><span class="info-label">含宏</span>${a.has_macro ? '⚠️ 是' : '否'}</div>
            ${a.archive_contents && a.archive_contents.length ? `<div><span class="info-label">压缩包内容</span>${esc(a.archive_contents.join(', '))}</div>` : ''}
          </div>
          ${a.findings && a.findings.length ? `<ul class="findings">${renderFindings(a.findings)}</ul>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// ===== 操作 =====
async function restoreEmail(id) {
  await api('/api/emails/' + id + '/restore', { method: 'POST' });
  toast('已恢复回收件箱', 'success');
  resetReadingPane();
  await loadData();
}

async function confirmEmail(id, label = '结果', button = null) {
  if (button?.disabled) return;
  if (button) setLoading(button, true, '正在处置…');
  try {
    const result = await api('/api/emails/' + id + '/confirm', { method: 'POST' });
    const target = result.folder ? `「${result.folder}」` : '';
    if (result.recovered === 'already_moved') {
      toast(`服务器中已完成${label}，本地状态已同步`, 'success');
    } else if (result.moved && result.status === 'spam') {
      toast(`已移入服务器垃圾邮件文件夹${target}`, 'success');
    } else if (result.moved && result.status === 'quarantine') {
      toast(`已移入隔离区${target}`, 'success');
    } else {
      toast(`已确认${label}`, 'success');
    }
    resetReadingPane();
    await Promise.all([loadData(), loadMailboxFolders()]);
  } catch (e) {
    const missing = e.message.includes('服务器中已找不到这封邮件');
    toast(missing ? e.message : '确认处置失败：' + e.message.replace(/^确认处置失败[：:]\s*/, ''), missing ? 'warn' : 'error');
    if (missing) { resetReadingPane(); await Promise.all([loadData(), loadMailboxFolders()]); }
  } finally {
    if (button?.isConnected) setLoading(button, false);
  }
}

const feedbackReasonOptions = {
  fp: ['发件人可信', '业务内容正常', '链接或附件已核实', '内部系统通知', '规则判断不准确', '其他'],
  fn: ['发件人身份可疑', '包含可疑链接', '附件存在风险', '索要敏感信息', '内容明显异常', '其他'],
};
let feedbackDraft = {id: null, kind: 'fp', reasons: new Set(), storedAway: false};

function renderFeedbackImpact() {
  const {kind, reasons, storedAway} = feedbackDraft;
  const trustedSender = kind === 'fp' && reasons.has('发件人可信');
  document.getElementById('feedback-impact').innerHTML = kind === 'fp'
    ? (trustedSender
      ? `<b>处理当前邮件并信任发件人</b><span>${storedAway ? '邮件将恢复到收件箱' : '邮件将保留在当前文件夹'}；该邮箱地址会加入本机白名单，今后不再触发常规误报，但高危证据仍会报警。</span>`
      : `<b>只处理当前邮件</b><span>${storedAway ? '邮件将标记为正常，并恢复到收件箱。' : '邮件将标记为正常，并保留在当前文件夹。'}</span>`)
    : '<b>只处理当前邮件</b><span>邮件将标记为风险邮件，并移入隔离区。</span>';
  document.getElementById('feedback-privacy').textContent = trustedSender
    ? '该发件邮箱将加入本机白名单并写入审计记录，不会回复发件人；可在设置中随时停用或删除。'
    : '反馈仅用于本机规则校准和审计记录，不会回复发件人。';
}

function feedbackEmail(id, kind) {
  const isFalsePositive = kind === 'fp';
  const email = selectedEmailDetail?.id === id ? selectedEmailDetail : allEmails.find(item => item.id === id);
  const isStoredAway = email && (email.status === 'quarantine' || email.status === 'spam');
  feedbackDraft = {id, kind, reasons: new Set(), storedAway: Boolean(isStoredAway)};
  const modal = document.getElementById('feedback-modal');
  modal.classList.toggle('feedback-fp', isFalsePositive);
  modal.classList.toggle('feedback-fn', !isFalsePositive);
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('feedback-title').textContent = isFalsePositive ? '这是一封正常邮件' : '这是一封风险邮件';
  document.getElementById('feedback-subtitle').textContent = isFalsePositive ? '告诉我们本次判断为什么不准确' : '告诉我们遗漏了哪些风险信号';
  renderFeedbackImpact();
  document.getElementById('feedback-reasons').innerHTML = feedbackReasonOptions[kind].map(reason => `<button type="button" data-feedback-reason="${esc(reason)}"><span>✓</span>${esc(reason)}</button>`).join('');
  const note = document.getElementById('feedback-note');
  note.value = '';
  note.placeholder = isFalsePositive ? '例如：该发件人为长期合作方，邮件内容与当前项目一致' : '例如：链接域名与官方域名不一致，并要求立即登录验证';
  document.getElementById('feedback-note-count').textContent = '0';
  document.getElementById('btn-submit-feedback').textContent = isFalsePositive ? '确认标记为正常' : '确认标记为风险';
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open', 'feedback-open');
  modal.querySelector('[data-feedback-reason]').focus();
}

function closeFeedbackDialog() {
  const modal = document.getElementById('feedback-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open', 'feedback-open');
  feedbackDraft = {id: null, kind: 'fp', reasons: new Set(), storedAway: false};
}

document.getElementById('feedback-reasons').addEventListener('click', event => {
  const button = event.target.closest('[data-feedback-reason]');
  if (!button) return;
  const reason = button.dataset.feedbackReason;
  if (feedbackDraft.reasons.has(reason)) feedbackDraft.reasons.delete(reason);
  else feedbackDraft.reasons.add(reason);
  button.classList.toggle('selected', feedbackDraft.reasons.has(reason));
  button.setAttribute('aria-pressed', String(feedbackDraft.reasons.has(reason)));
  renderFeedbackImpact();
  if (reason === '其他' && feedbackDraft.reasons.has(reason)) document.getElementById('feedback-note').focus();
});
document.getElementById('feedback-note').addEventListener('input', event => {
  document.getElementById('feedback-note-count').textContent = String(event.target.value.length);
});
document.getElementById('btn-close-feedback').addEventListener('click', closeFeedbackDialog);
document.getElementById('btn-cancel-feedback').addEventListener('click', closeFeedbackDialog);
document.querySelector('#feedback-modal [data-close-feedback]').addEventListener('click', closeFeedbackDialog);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.getElementById('feedback-modal').classList.contains('hidden')) closeFeedbackDialog();
});
document.getElementById('btn-submit-feedback').addEventListener('click', async () => {
  const {id, kind, reasons} = feedbackDraft;
  if (!id) return;
  const detail = document.getElementById('feedback-note').value.trim();
  const parts = [];
  if (reasons.size) parts.push(`原因：${[...reasons].join('、')}`);
  if (detail) parts.push(`说明：${detail}`);
  const note = parts.join('；');
  const trustedSender = kind === 'fp' && reasons.has('发件人可信');
  const button = document.getElementById('btn-submit-feedback');
  setLoading(button, true, '正在提交…');
  try {
    const result = await api('/api/emails/' + id + '/feedback?feedback=' + kind + '&trusted_sender=' + trustedSender + '&note=' + encodeURIComponent(note), { method: 'POST' });
    closeFeedbackDialog();
    toast(result.trusted_sender
      ? `已标记为正常，并将 ${result.trusted_sender} 加入发件人白名单`
      : (kind === 'fp' ? '已将当前邮件标记为正常' : '已将当前邮件标记为风险'), 'success');
    resetReadingPane();
    await Promise.all([loadData(), loadMailboxFolders()]);
  } catch (e) {
    toast('反馈失败：' + e.message, 'error');
  } finally {
    setLoading(button, false);
  }
});

async function toggleTodo(id, status) {
  await api('/api/todos/' + id + '/' + (status === 'done' ? 'reopen' : 'done'), { method: 'POST' });
  const item = allTodos.find(row => row.id === Number(id));
  if (item) item.status = status === 'done' ? 'open' : 'done';
  toast('待办状态已更新', 'success');
  window.mailaiTasksChanged?.();
  updateSidebar();
}

let _digestHistory = [];

// "今日日报" 标题与 "YYYY-MM-DD 日报" 的本地化封装
function digestTodayLabel() { return mailaiT('digest.title') || '今日日报'; }
function digestDateLabel(date) { return (mailaiT('digest.dateTitle') || '{d} 日报').replace('{d}', date); }
let _digestAccountId = '';
let digestViewRevision = 0;
let digestHistoryRevision = 0;
let digestReadController = null;
const digestGenerationJobs = new Map();

function nextDigestView() {
  digestReadController?.abort(); digestReadController = null;
  return ++digestViewRevision;
}
function digestViewCurrent(revision, accountId) {
  return revision === digestViewRevision && accountId === _digestAccountId && !document.getElementById('digest-modal').classList.contains('hidden');
}
function closeDigestModal() {
  nextDigestView(); ++digestHistoryRevision;
  document.getElementById('digest-modal').classList.add('hidden');
}

function digestAccountLabel(account = activeMailAccount()) {
  if (!account) return '未选择邮箱';
  const alias = localStorage.getItem('alias:' + account.id) || '';
  return alias && alias !== account.user ? `${alias} · ${account.user}` : account.user;
}

function resetDigestAccountView() {
  nextDigestView(); ++digestHistoryRevision;
  _digestHistory = [];
  _digestAccountId = '';
  const modal = document.getElementById('digest-modal');
  if (!modal.classList.contains('hidden')) openDigestModal();
}

async function openDigestModal() {
  const revision = nextDigestView();
  closeAssistant();
  const account = activeMailAccount();
  const accountId = account?.id || '';
  _digestAccountId = accountId;
  document.getElementById('digest-account-label').textContent = digestAccountLabel(account);
  document.getElementById('digest-modal').classList.remove('hidden');
  document.getElementById('digest-body').innerHTML = '<p>正在加载日报…</p>';
  const loaded = await loadDigestHistory(accountId);
  if (!digestViewCurrent(revision, accountId)) return;
  if (!loaded) { document.getElementById('digest-body').textContent = '日报历史加载失败，请关闭后重试；已保存的日报不会被删除。'; return; }
  // 默认显示今天的日报：优先从历史记录里取，没有才提示生成
  const today = localDateKey();
  const todayDigest = _digestHistory.find(d => d.digest_date === today);
  if (todayDigest) {
    document.getElementById('digest-history-select').value = todayDigest.id;
    await loadDigestById(todayDigest.id, accountId);
  } else {
    document.getElementById('digest-history-select').value = '';
    showDigestGeneratePrompt();
  }
}

function showDigestGeneratePrompt() {
  nextDigestView();
  setDigestTitle(digestTodayLabel());
  document.getElementById('digest-body').innerHTML = `
    <div class="digest-empty">
      <p>${mailaiT('digest.notGenerated') || '今日日报尚未生成。'}</p>
      <button id="btn-generate-today" class="action-btn action-primary"><svg viewBox="0 0 20 20"><path d="M15.5 6V3.5M15.5 3.5H13M15.2 6A6.5 6.5 0 1 0 16 12"/></svg>${mailaiT('digest.generateToday') || '生成今日日报'}</button>
    </div>
  `;
  document.getElementById('btn-generate-today').addEventListener('click', generateDigest);
}

async function generateDigest() {
  const revision = nextDigestView();
  const accountId = _digestAccountId || activeMailAccount()?.id || '';
  const btn = document.getElementById('btn-digest');
  setLoading(btn, true, mailaiT('digest.generating') || '生成中…');
  document.getElementById('digest-body').innerHTML = `<p>${mailaiT('digest.generatingBody') || '正在生成日报…'}</p>`;
  setDigestTitle(digestTodayLabel());
  document.getElementById('digest-history-select').value = '';
  try {
    let job = digestGenerationJobs.get(accountId);
    if (!job) {
      job = api('/api/digest', {accountId});
      digestGenerationJobs.set(accountId, job);
      job.finally(() => { if (digestGenerationJobs.get(accountId) === job) digestGenerationJobs.delete(accountId); }).catch(() => {});
    }
    const data = await job;
    if (!digestViewCurrent(revision, accountId)) return;
    document.getElementById('digest-body').innerHTML = renderDigest(data.digest);
    toast(mailaiT('digest.done') || '日报生成完毕', 'success');
    await loadDigestHistory(accountId);
    if (!digestViewCurrent(revision, accountId)) return;
    // 生成后把下拉框切到今天
    const today = localDateKey();
    const todayDigest = _digestHistory.find(d => d.digest_date === today);
    if (todayDigest) {
      document.getElementById('digest-history-select').value = todayDigest.id;
      setDigestTitle(digestDateLabel(today));
    }
  } catch (e) {
    if (!digestViewCurrent(revision, accountId)) return;
    let msg = e.message;
    try {
      const parsed = JSON.parse(msg);
      if (parsed.detail) msg = parsed.detail;
    } catch {}
    document.getElementById('digest-body').innerHTML = `<p class="reading-error">${mailaiT('digest.failed') || '生成失败：'}${esc(msg)}</p>`;
    toast((mailaiT('digest.failedToast') || '日报生成失败：') + msg, 'error');
  } finally {
    if (!digestGenerationJobs.size) setLoading(btn, false);
  }
}

async function loadDigestHistory(accountId = _digestAccountId || activeMailAccount()?.id || '') {
  const revision = ++digestHistoryRevision;
  try {
    const digests = await api('/api/digests', {accountId});
    if (accountId !== _digestAccountId || revision !== digestHistoryRevision) return false;
    _digestHistory = digests;
    const select = document.getElementById('digest-history-select');
    const current = select.value;
    select.innerHTML = `<option value="">${digestTodayLabel()}</option>`;
    digests.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.digest_date;
      select.appendChild(opt);
    });
    // 如果当前值仍有效则保留
    if (current && digests.some(d => String(d.id) === current)) {
      select.value = current;
    }
    return true;
  } catch (e) {
    console.error('加载日报历史失败', e);
    return false;
  }
}

async function loadDigestById(id, accountId = _digestAccountId || activeMailAccount()?.id || '') {
  const revision = nextDigestView();
  const controller = new AbortController(); digestReadController = controller;
  document.getElementById('digest-body').innerHTML = '<p>正在加载历史日报…</p>';
  try {
    const data = await api('/api/digests/' + id, {accountId, signal:controller.signal});
    if (!digestViewCurrent(revision, accountId)) return;
    document.getElementById('digest-body').innerHTML = renderDigest(data.content);
    setDigestTitle(digestDateLabel(data.digest_date));
  } catch (e) {
    if (!digestViewCurrent(revision, accountId) || controller.signal.aborted) return;
    document.getElementById('digest-body').innerHTML = `<p class="reading-error">加载失败：${esc(e.message)}</p>`;
  }
}

// ===== 事件绑定 =====
function closeTopMenus(except = null) {
  document.querySelectorAll('.top-menu').forEach(menu => {
    if (menu === except) return;
    menu.querySelector('.top-menu-popover')?.classList.add('hidden');
    menu.querySelector('.nav-menu-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

document.querySelectorAll('.nav-menu-trigger').forEach(trigger => {
  trigger.addEventListener('click', event => {
    event.stopPropagation();
    const menu = trigger.closest('.top-menu');
    const popover = menu.querySelector('.top-menu-popover');
    const willOpen = popover.classList.contains('hidden');
    closeTopMenus(menu);
    popover.classList.toggle('hidden', !willOpen);
    trigger.setAttribute('aria-expanded', String(willOpen));
  });
});
document.querySelectorAll('.top-menu-popover button').forEach(button => {
  button.addEventListener('click', () => closeTopMenus());
});
document.addEventListener('click', event => {
  if (!event.target.closest('.top-menu')) closeTopMenus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeTopMenus();
});

document.getElementById('btn-poll').addEventListener('click', async () => {
  const btn = document.getElementById('btn-poll');
  setLoading(btn, true, '拉取中…');
  try {
    const result = await api('/api/poll', { method: 'POST' });
    if (result.queued) toast(result.msg);
    startFetchMonitor();
  } catch (e) {
    toast('拉取失败：' + e.message, 'error');
    setLoading(btn, false);
  }
});

document.getElementById('btn-digest').addEventListener('click', openDigestModal);

document.getElementById('btn-dashboard').addEventListener('click', () => {
  const dashboard = document.getElementById('dashboard-view');
  if (dashboard.classList.contains('hidden')) {
    showDashboard();
  } else {
    hideDashboard();
  }
});

document.getElementById('bulk-toolbar').addEventListener('click', event => {
  const action = event.target.closest('[data-bulk-action]')?.dataset.bulkAction;
  if (action) runBulkAction(action);
});
document.getElementById('bulk-folder').addEventListener('change', event => {
  if (event.target.value) runBulkAction('move', event.target.value);
  event.target.value = '';
});
document.getElementById('bulk-cancel').addEventListener('click', () => {
  clearMailSelection();
});
document.addEventListener('click', event => {
  if (!event.target.closest('#mail-context-menu')) hideMailContextMenu();
});
document.getElementById('email-list').addEventListener('scroll', hideMailContextMenu, {passive:true});
document.addEventListener('keydown', event => {
  const target = event.target;
  const editing = target instanceof HTMLElement && (
    target.matches('input, textarea, select, [contenteditable="true"]') ||
    !!target.closest('[contenteditable="true"]')
  );
  const overlayOpen = !!document.querySelector('.compose-modal:not(.hidden), .modal:not(.hidden)');
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !editing && !overlayOpen && !specialMailbox) {
    event.preventDefault();
    selectAllVisibleMail();
    return;
  }
  if (event.key === 'Escape') {
    hideMailContextMenu();
    if (selectedMailIds.size && !editing && !overlayOpen) clearMailSelection();
  }
});

async function loadMailboxFolders() {
  const accountId = activeMailAccount()?.id || '';
  if (mailboxFoldersAccountId !== accountId) {
    mailboxFolders = [];
    mailboxFoldersAccountId = accountId;
  }
  try {
    const folders = await api('/api/mail/folders');
    if (accountId !== activeMailAccount()?.id) return false;
    mailboxFolders = folders;
    mailboxFoldersAccountId = accountId;
    const select = document.getElementById('bulk-folder');
    select.innerHTML = '<option value="">移动到…</option>' + mailboxFolders.filter(folder => folder.selectable !== false).map(folder => `<option value="${esc(folder.name)}">${esc(folder.name)}</option>`).join('');
    const protectedNames = new Set([mailboxFolders.find(folder => (folder.flags || []).some(flag => /inbox/i.test(flag)))?.name || 'INBOX']);
    const host = document.getElementById('server-folder-nav');
    host.innerHTML = mailboxFolders.filter(folder => folder.selectable !== false && !protectedNames.has(folder.name)).map(folder => `<button type="button" class="nav-item" data-server-folder="${esc(folder.name)}" title="共 ${Number(folder.messages || 0)} 封，未读 ${Number(folder.unseen || 0)} 封；点击同步">
      <span class="icon"><svg viewBox="0 0 20 20"><path d="M3.5 5.5h5l1.5 2h6.5v8h-13z"/></svg></span><span class="server-folder-name">${esc(folder.name)}</span><span class="count">${Number(folder.messages || 0)}</span></button>`).join('') || '<small>没有其他文件夹</small>';
    updateSidebar();
    return true;
  } catch (error) {
    if (accountId === activeMailAccount()?.id) {
      mailboxFolders = [];
      mailboxFoldersAccountId = accountId;
      document.getElementById('bulk-folder').innerHTML = '<option value="">移动到…</option>';
      document.getElementById('server-folder-nav').innerHTML = '<small>文件夹暂时无法读取</small>';
      toast('服务器文件夹读取失败，将显示本地邮件记录：' + error.message, 'warn');
    }
    return false;
  }
}

async function loadServerFolder(folder) {
  resetReadingPane();
  const revision = ++mailLoadRevision;
  const isCurrent = () => revision === mailLoadRevision && currentServerFolder === folder;
  currentServerFolder = folder; specialMailbox = '';
  currentFilter.status = ''; currentFilter.verdict = ''; currentFilter.category = ''; currentFilter.search = '';
  currentFilter.priority = ''; currentFilter.domain = ''; currentFilter.attachments = false;
  searchResults = null; ++searchRevision; clearTimeout(globalSearchTimer);
  selectedMailIds.clear(); updateBulkToolbar();
  setSegmentedFilter('filter-priority', '');
  document.getElementById('filter-domain').value = '';
  document.getElementById('filter-attachments').checked = false;
  currentFilter.unread = false; document.getElementById('filter-unread').checked = false;
  document.getElementById('global-search').value = '';
  document.querySelectorAll('[data-server-folder]').forEach(button => button.classList.toggle('active', button.dataset.serverFolder === folder));
  document.getElementById('list-title').textContent = serverFolderForRole('spam')?.name === folder
    ? (mailaiT('side.spam') || '垃圾邮件') : serverFolderForRole('quarantine')?.name === folder ? (mailaiT('side.quarantine') || '隔离区') : folder;
  document.getElementById('email-list').innerHTML = `<div class="email-empty"><div class="empty-text">${mailaiT('list.loadingFolder') || '正在同步服务端文件夹…'}</div></div>`;
  try {
    const result = await api(`/api/mail/folders/sync?folder=${encodeURIComponent(folder)}`, {method:'POST'});
    const rows = await loadMailPages(`/api/emails?days=9999&folder=${encodeURIComponent(folder)}`, isCurrent);
    if (!isCurrent() || !rows) return;
    allEmails = rows;
    applyFilters(); toast(`${folder} 已同步 ${result.imported} 封`, 'success');
  } catch (err) { if (isCurrent()) toast('文件夹同步失败：' + err.message, 'error'); }
}
document.getElementById('server-folder-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-server-folder]'); if (button) loadServerFolder(button.dataset.serverFolder);
});
document.getElementById('btn-create-folder').addEventListener('click', async () => {
  const name = prompt('新建服务端文件夹名称：')?.trim(); if (!name) return;
  try { await api('/api/mail/folders', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}); toast('文件夹已创建', 'success'); await loadMailboxFolders(); }
  catch (err) { toast('创建失败：' + err.message, 'error'); }
});

function attachmentTypeLabel(contentType = '', name = '') {
  const ext = (name.split('.').pop() || '').slice(0, 5).toUpperCase();
  if (ext && ext !== name.toUpperCase()) return ext;
  if (contentType.includes('image')) return mailaiT('att.typeImage') || '图片';
  if (contentType.includes('pdf')) return 'PDF';
  return mailaiT('att.typeFile') || '文件';
}

function attachmentType(item = {}) {
  const contentType = String(item.content_type || '').toLowerCase();
  const ext = String(item.name || '').split('.').pop().toLowerCase();
  if (contentType.includes('pdf') || ext === 'pdf') return 'pdf';
  if (contentType.includes('spreadsheet') || ['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'sheet';
  if (contentType.includes('word') || ['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext)) return 'document';
  if (contentType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (contentType.includes('zip') || ['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return 'archive';
  return 'other';
}

function attachmentTypeName(type) {
  const key = ({pdf:'att.typePdf', sheet:'att.typeSheet', document:'att.typeDoc', image:'att.typeImage', archive:'att.typeArchive', other:'att.typeOther'})[type];
  return (key && mailaiT(key)) || ({pdf:'PDF', sheet:'表格', document:'文档', image:'图片', archive:'压缩包', other:'其他'})[type] || (mailaiT('att.typeFile') || '文件');
}

function updateAttachmentTypeFilters() {
  const counts = {all:attachmentItems.length, pdf:0, sheet:0, document:0, image:0, archive:0, other:0};
  attachmentItems.forEach(item => counts[attachmentType(item)]++);
  document.querySelectorAll('[data-attachment-type]').forEach(button => {
    const type = button.dataset.attachmentType;
    const label = type === 'all' ? (mailaiT('att.typeAll') || '全部') : attachmentTypeName(type);
    button.innerHTML = `${label}<span>${counts[type] || 0}</span>`;
    button.classList.toggle('active', type === attachmentTypeFilter);
  });
}

function renderAttachmentCenter() {
  const query = document.getElementById('attachment-search').value.trim().toLowerCase();
  const rows = attachmentItems.filter(item => (attachmentTypeFilter === 'all' || attachmentType(item) === attachmentTypeFilter) &&
    (!query || [item.name, item.subject, item.from_addr].some(value => String(value || '').toLowerCase().includes(query))));
  const sourceCount = new Set(rows.map(item => item.email_id)).size;
  animateCountText(document.getElementById('attachment-count'), rows.length, n => (mailaiT('att.countLine') || '{n} 个附件 · 来自 {m} 封邮件').replace('{n}', n).replace('{m}', sourceCount));
  updateAttachmentTypeFilters();
  document.getElementById('attachment-grid').innerHTML = rows.length ? rows.map(item => `
    <a class="attachment-card type-${attachmentType(item)}" href="${mailboxResourceUrl(`/api/emails/${item.email_id}/attachments/${item.index}`)}" download="${esc(item.name)}" title="${(mailaiT('att.previewTitle') || '预览 {name}').replace('{name}', esc(item.name))}">
      <span class="attachment-file-icon"><strong>${esc(attachmentTypeLabel(item.content_type, item.name))}</strong><small>${attachmentType(item) === 'pdf' ? attachmentTypeName('document') : attachmentTypeName(attachmentType(item))}</small></span>
      <span class="attachment-card-main">
        <b title="${esc(item.name)}">${esc(item.name)}</b>
        <span class="attachment-facts"><small>${formatFileSize(item.size || 0)}</small><small>${fmtDate(item.date)}</small></span>
        <small class="attachment-source"><i>${mailaiT('att.source') || '来源'}</i><span>${esc(item.subject || (mailaiT('att.noSubject') || '（无主题）'))}</span></small>
        <small class="attachment-sender">${esc(item.from_addr || (mailaiT('att.unknownSender') || '未知发件人'))}</small>
      </span>
      <span class="attachment-card-side">
        ${['danger', 'warn'].includes(getRiskLabel(item.score, item.verdict, item).class) ? `<em class="attachment-risk">${getRiskLabel(item.score, item.verdict, item).text}</em>` : ''}
        <span class="attachment-download-action" aria-hidden="true"><svg class="attachment-download" viewBox="0 0 20 20"><path d="M10 3v9m-3-3 3 3 3-3M4 15h12"/></svg></span>
      </span>
    </a>`).join('') : `<div class="attachment-empty">${mailaiT('att.noMatch') || '没有找到匹配的附件'}</div>`;
}

async function openAttachmentCenter() {
  closeAssistant();
  const modal = document.getElementById('attachment-center');
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  attachmentTypeFilter = 'all';
  document.getElementById('attachment-search').value = '';
  document.getElementById('attachment-grid').innerHTML = '<div class="attachment-empty">正在整理附件…</div>';
  try { attachmentItems = await api('/api/attachments?limit=1000'); renderAttachmentCenter(); }
  catch (err) { document.getElementById('attachment-grid').innerHTML = `<div class="attachment-empty">加载失败：${esc(err.message)}</div>`; }
}

function closeAttachmentCenter() {
  document.getElementById('attachment-center').classList.add('hidden');
  document.body.classList.remove('modal-open');
}

function mailboxResourceUrl(path, accountId = activeMailAccount()?.id || '') {
  const url = new URL(path, location.origin);
  if (accountId) url.searchParams.set('mailai_account', accountId);
  return url.pathname + url.search;
}

async function downloadAttachmentInDesktop(event) {
  const link = event.target.closest('a[href*="/api/emails/"][href*="/attachments/"], a[href*="/api/mail/sent/"][href*="/attachments/"], a[href*="/api/drafts/"][href*="/attachments/"]');
  if (!link) return;
  const accountId = new URL(link.href).searchParams.get('mailai_account') || activeMailAccount()?.id || '';
  link.href = mailboxResourceUrl(link.getAttribute('href'), accountId);
  if (!link.hasAttribute('data-preview-download') && window.openAttachmentPreview) {
    event.preventDefault();
    event.stopImmediatePropagation();
    window.openAttachmentPreview(link);
    return;
  }
  if (!window.pywebview?.api?.download_attachment) return;
  const match = link.getAttribute('href')?.match(/\/api\/emails\/(\d+)\/attachments\/(\d+)/);
  const sentMatch = link.getAttribute('href')?.match(/\/api\/mail\/sent\/(\d+)\/attachments\/(\d+)/);
  const draftMatch = link.getAttribute('href')?.match(/\/api\/drafts\/(\d+)\/attachments\/(\d+)/);
  const attachmentMatch = match || sentMatch || draftMatch;
  if (!attachmentMatch) return;
  event.preventDefault();
  event.stopPropagation();
  const filename = link.getAttribute('download') || link.querySelector('b')?.textContent || link.textContent.trim() || '附件';
  try {
    const result = await window.pywebview.api.download_attachment(Number(attachmentMatch[1]), Number(attachmentMatch[2]), filename, accountId, sentMatch ? 'sent' : draftMatch ? 'draft' : 'email');
    if (result?.ok) toast(`附件已保存：${result.filename || filename}`, 'success');
  } catch (err) {
    toast('附件下载失败：' + (err?.message || err), 'error');
  }
}

document.addEventListener('click', downloadAttachmentInDesktop, true);

let todoRenderLimit = 160;

function renderTodoCenter() {
  const showDone = document.getElementById('todo-show-done').checked;
  const rows = allTodos.filter(item => showDone || item.status !== 'done');
  const visibleIds = new Set(rows.map(item => item.id));
  selectedTodoIds = new Set([...selectedTodoIds].filter(id => visibleIds.has(id)));
  const now = localDateKey();
  const openCount = rows.filter(item => item.status !== 'done').length;
  animateCountText(document.getElementById('todo-count'), openCount, n => (mailaiT('todo.openCount') || '{n} 项未完成').replace('{n}', n));
  const visibleRows = rows.slice(0, todoRenderLimit);
  document.getElementById('todo-list').innerHTML = rows.length ? visibleRows.map(item => {
    const date = String(item.deadline || '').slice(0, 10);
    const sourceDate = item.email_date || item.email_indexed_at || item.created_at || '';
    const overdue = item.status !== 'done' && date && date < now;
    return `<article class="todo-center-item ${item.status === 'done' ? 'done' : ''} ${overdue ? 'overdue' : ''}" data-todo-id="${item.id}">
      <label class="todo-select" title="${item.status === 'done' ? (mailaiT('todo.selectDoneTitle') || '已完成待办不可批量选择') : (mailaiT('todo.selectTitle') || '选择此待办')}"><input type="checkbox" data-todo-select="${item.id}" ${selectedTodoIds.has(item.id) ? 'checked' : ''} ${item.status === 'done' ? 'disabled' : ''}><span></span></label>
      <div class="todo-main"><input class="todo-title-input" value="${esc(item.title)}" aria-label="${mailaiT('todo.titleAria') || '待办标题'}"><div class="todo-source-meta"><button type="button" class="todo-source" data-todo-email="${item.email_id}">${esc(item.email_subject || (mailaiT('todo.viewSource') || '查看来源邮件'))}</button><time datetime="${esc(sourceDate)}" title="${(mailaiT('todo.sourceTimeTitle') || '来源邮件时间：{d}').replace('{d}', esc(sourceDate))}">${mailaiT('todo.sourceTime') || '邮件时间'} ${esc(fmtDate(sourceDate))}</time></div></div>
      <label class="todo-date ${overdue ? 'overdue' : ''}"><span>${overdue ? (mailaiT('todo.overdue') || '已过期') : item.stage === 'waiting' ? (mailaiT('todo.followUp') || '跟进日期') : (mailaiT('todo.deadline') || '截止日期')}</span><input type="date" value="${esc(date)}" aria-label="${mailaiT('todo.deadline') || '截止日期'}"></label>
      <span class="todo-plan-actions"><button type="button" class="todo-status-action" data-todo-plan="${item.id}">${item.stage === 'waiting' ? (mailaiT('todo.waitingPlan') || '等待反馈 · 安排') : (mailaiT('todo.plan') || '安排 / 提醒')}</button>
      <button type="button" class="todo-status-action" data-todo-toggle="${item.id}">${item.status === 'done' ? (mailaiT('todo.restore') || '恢复') : `<span>✓</span> ${mailaiT('todo.done') || '完成'}`}</button></span>
    </article>`;
  }).join('') + (rows.length > visibleRows.length ? `
    <button type="button" class="todo-render-more" data-todo-render-more>
      ${mailaiT('todo.showMore') || '显示更多待办'} <small>${(mailaiT('todo.showMoreCount') || '还有 {n} 项').replace('{n}', rows.length - visibleRows.length)}</small>
    </button>` : '') : `<div class="attachment-empty">${mailaiT('todo.empty') || '暂无待办事项'}</div>`;
  updateTodoBatchToolbar(rows);
}

let selectedTodoIds = new Set();

function updateTodoBatchToolbar(rows = allTodos.filter(item => document.getElementById('todo-show-done').checked || item.status !== 'done')) {
  const selectable = rows.filter(item => item.status !== 'done');
  const selectedOpen = selectable.filter(item => selectedTodoIds.has(item.id));
  const selectAll = document.getElementById('todo-select-all');
  selectAll.checked = selectable.length > 0 && selectedOpen.length === selectable.length;
  selectAll.indeterminate = selectedOpen.length > 0 && selectedOpen.length < selectable.length;
  selectAll.disabled = selectable.length === 0;
  const selectedButton = document.getElementById('todo-complete-selected');
  selectedButton.disabled = selectedOpen.length === 0;
  selectedButton.textContent = selectedOpen.length ? (mailaiT('todo.completeSelectedN') || '完成所选 {n}').replace('{n}', selectedOpen.length) : (mailaiT('todo.completeSelected') || '完成所选');
  document.getElementById('todo-complete-all').disabled = selectable.length === 0;
}

async function setTodoBatchStatus(ids, status = 'done') {
  if (!ids.length) return;
  let updated = 0;
  const changed = new Set();
  try {
    for (let start = 0; start < ids.length; start += 200) {
      const batch = ids.slice(start, start + 200);
      const result = await api('/api/todos/bulk/status', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ids:batch, status}),
      });
      updated += Number(result.updated || 0);
      batch.forEach(id => changed.add(Number(id)));
      allTodos.forEach(item => { if (changed.has(Number(item.id))) item.status = status; });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    changed.forEach(id => selectedTodoIds.delete(id));
    renderTodoCenter();
    updateSidebar();
  }
  toast(`已更新 ${updated} 项待办`, 'success');
  window.mailaiTasksChanged?.();
}

async function openTodoCenter() {
  closeAssistant();
  document.getElementById('todo-center').classList.remove('hidden');
  document.body.classList.add('modal-open');
  selectedTodoIds.clear();
  todoRenderLimit = 160;
  allTodos = await api('/api/todos?include_done=true'); renderTodoCenter();
}
function closeTodoCenter() { document.getElementById('todo-center').classList.add('hidden'); document.body.classList.remove('modal-open'); }
async function saveTodoItem(article) {
  const id = Number(article.dataset.todoId);
  const title = article.querySelector('.todo-title-input').value.trim();
  const deadline = article.querySelector('input[type="date"]').value;
  try { await api(`/api/todos/${id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,deadline})}); toast('待办已保存', 'success'); window.mailaiTasksChanged?.(); }
  catch (err) { toast('保存失败：' + err.message, 'error'); }
}

document.getElementById('btn-attachments').addEventListener('click', openAttachmentCenter);
document.getElementById('btn-close-attachments').addEventListener('click', closeAttachmentCenter);
document.querySelector('#attachment-center .attachment-center-backdrop').addEventListener('click', closeAttachmentCenter);
document.getElementById('attachment-search').addEventListener('input', renderAttachmentCenter);
document.getElementById('attachment-type-filters').addEventListener('click', event => {
  const button = event.target.closest('[data-attachment-type]');
  if (!button) return;
  attachmentTypeFilter = button.dataset.attachmentType;
  renderAttachmentCenter();
});
document.getElementById('btn-todos').addEventListener('click', openTodoCenter);
document.getElementById('btn-contacts').addEventListener('click', () => openContactCenter());
document.getElementById('btn-close-contacts').addEventListener('click', closeContactCenter);
document.querySelector('#contact-center > .attachment-center-backdrop').addEventListener('click', closeContactCenter);
document.getElementById('btn-new-contact').addEventListener('click', () => openContactEditor());
document.querySelectorAll('[data-close-contact-editor]').forEach(button => button.addEventListener('click', closeContactEditor));
let contactSearchTimer = null;
document.getElementById('contact-center-search').addEventListener('input', () => {
  clearTimeout(contactSearchTimer); contactSearchTimer = setTimeout(loadContactCenter, 150);
});
document.getElementById('contact-center-filters').addEventListener('click', event => {
  const button = event.target.closest('[data-contact-filter]');
  if (!button) return;
  contactCenterFilter = button.dataset.contactFilter;
  document.querySelectorAll('[data-contact-filter]').forEach(item => item.classList.toggle('active', item === button));
  loadContactCenter();
});
document.getElementById('contact-center-list').addEventListener('click', async event => {
  const session = contactCenterSession;
  if (!session) return;
  const accountId = session.accountId;
  const pick = event.target.closest('[data-contact-pick]');
  if (pick) {
    const email = pick.dataset.contactPick;
    if (selectedContactEmails.has(email)) selectedContactEmails.delete(email); else selectedContactEmails.add(email);
    renderContactCenter(); return;
  }
  const favorite = event.target.closest('[data-contact-favorite]');
  if (favorite) {
    try {
      await api('/api/mail/contacts/favorite', {accountId, method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:favorite.dataset.contactFavorite, favorite:favorite.dataset.favorite !== '1'})});
      if (session === contactCenterSession) await loadContactCenter();
    } catch (error) { toast('更新常用联系人失败：' + error.message, 'error'); }
    return;
  }
  const correspondence = event.target.closest('[data-contact-correspondence]');
  if (correspondence) {
    const email = correspondence.dataset.contactCorrespondence;
    const contact = contactCenterItems.find(item => item.email === email) || contactPickerContacts.get(email);
    await openContactCorrespondence(contact || {email}, accountId);
    return;
  }
  const compose = event.target.closest('[data-contact-compose]');
  if (compose) { const email = compose.dataset.contactCompose; const contact = contactPickerContacts.get(email); closeContactCenter(); openCompose({account_id:accountId, to_addr:contactRecipientValue(contact || email)}); return; }
  const edit = event.target.closest('[data-contact-edit]');
  if (edit) { openContactEditor(contactCenterItems.find(item => item.email === edit.dataset.contactEdit)); return; }
  const remove = event.target.closest('[data-contact-delete]');
  if (remove && window.confirm('从通讯录中移除这位联系人？邮件往来记录不会删除。')) {
    try { await api(`/api/mail/contacts?email=${encodeURIComponent(remove.dataset.contactDelete)}`, {accountId, method:'DELETE'}); if (session !== contactCenterSession) return; await loadContactCenter(); await loadData({silent:true}); toast('已从通讯录移除', 'success'); }
    catch (error) { toast('移除失败：' + error.message, 'error'); }
  }
});
document.getElementById('contact-form').addEventListener('submit', async event => {
  event.preventDefault();
  const session = contactEditorSession;
  if (!session || session !== contactCenterSession) return;
  const accountId = session.accountId;
  const button = event.currentTarget.querySelector('[type="submit"]');
  setLoading(button, true, '保存中…');
  try {
    await api('/api/mail/contacts', {accountId, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      email:document.getElementById('contact-email').value.trim(), name:document.getElementById('contact-name').value.trim(),
      company:document.getElementById('contact-company').value.trim(), note:document.getElementById('contact-note').value.trim(),
      group_name:document.getElementById('contact-group-name')?.value || '',
      favorite:document.getElementById('contact-favorite').checked,
    })});
    if (session !== contactCenterSession) return;
    closeContactEditor(); await loadContactCenter(); await loadData({silent:true}); toast('联系人已保存，邮件列表姓名已更新', 'success');
  } catch (error) { toast('保存失败：' + error.message, 'error'); }
  finally { setLoading(button, false); }
});
document.getElementById('btn-cancel-contact-picker').addEventListener('click', closeContactCenter);
document.getElementById('btn-apply-contacts').addEventListener('click', () => {
  const target = document.getElementById(contactPickerTarget);
  if (!target) return;
  if (contactCenterSession?.draft !== draftSession || contactAccountId() !== composeAccountId || !document.body.classList.contains('compose-open')) {
    closeContactCenter(); return toast('写信窗口或发件账号已变化，请重新选择收件人', 'warn');
  }
  applyContactSelection(target, selectedContactEmails, contactPickerContacts);
  const count = selectedContactEmails.size;
  closeContactCenter(); target.focus(); contactInput = null; hideContactSuggestions(); toast(`收件人已更新，已选择 ${count} 位`, 'success');
});
document.getElementById('btn-close-todos').addEventListener('click', closeTodoCenter);
document.querySelector('#todo-center .attachment-center-backdrop').addEventListener('click', closeTodoCenter);
document.getElementById('todo-show-done').addEventListener('change', () => {
  todoRenderLimit = 160;
  renderTodoCenter();
});
document.getElementById('todo-select-all').addEventListener('change', event => {
  const showDone = document.getElementById('todo-show-done').checked;
  const selectable = allTodos.filter(item => item.status !== 'done' && (showDone || item.status !== 'done'));
  if (event.target.checked) selectable.forEach(item => selectedTodoIds.add(item.id));
  else selectable.forEach(item => selectedTodoIds.delete(item.id));
  document.querySelectorAll('#todo-list [data-todo-select]').forEach(input => {
    input.checked = event.target.checked;
  });
  updateTodoBatchToolbar();
});
document.getElementById('todo-complete-selected').addEventListener('click', async () => {
  const ids = allTodos.filter(item => item.status !== 'done' && selectedTodoIds.has(item.id)).map(item => item.id);
  try { await setTodoBatchStatus(ids); }
  catch (err) { toast('批量完成失败：' + err.message, 'error'); }
});
document.getElementById('todo-complete-all').addEventListener('click', async () => {
  const ids = allTodos.filter(item => item.status !== 'done').map(item => item.id);
  if (!ids.length || !window.confirm(`确认将全部 ${ids.length} 项未完成待办标记为完成？`)) return;
  try { await setTodoBatchStatus(ids); }
  catch (err) { toast('全部完成失败：' + err.message, 'error'); }
});
document.getElementById('todo-list').addEventListener('change', event => {
  const selector = event.target.closest('[data-todo-select]');
  if (selector) {
    const id = Number(selector.dataset.todoSelect);
    if (selector.checked) selectedTodoIds.add(id); else selectedTodoIds.delete(id);
    updateTodoBatchToolbar();
    return;
  }
  const article = event.target.closest('[data-todo-id]'); if (article) saveTodoItem(article);
});
document.getElementById('todo-list').addEventListener('click', async event => {
  const plan = event.target.closest('[data-todo-plan]');
  if (plan) { await window.openTaskPlanner({todoId:Number(plan.dataset.todoPlan)}); return; }
  const toggle = event.target.closest('[data-todo-toggle]');
  if (toggle) {
    const item = allTodos.find(row => row.id === Number(toggle.dataset.todoToggle));
    if (item) { await toggleTodo(item.id, item.status); renderTodoCenter(); }
    return;
  }
  if (event.target.closest('[data-todo-render-more]')) {
    todoRenderLimit += 160;
    renderTodoCenter();
    return;
  }
  const source = event.target.closest('[data-todo-email]');
  if (source) { closeTodoCenter(); await revealEmailFromSource(Number(source.dataset.todoEmail)); }
});
document.getElementById('btn-preferences').addEventListener('click', () => showSystemView('preferences'));
document.getElementById('btn-toggle-fetch').addEventListener('click', () => {
  const overlay = document.getElementById('fetch-overlay');
  overlay.classList.toggle('expanded');
  setFetchSettingsContext(true);
});
document.getElementById('btn-close-system').addEventListener('click', () => hideSystemView());
document.getElementById('system-tabs').addEventListener('click', e => {
  const button = e.target.closest('[data-system-tab]');
  if (button) { selectSystemTab(button.dataset.systemTab); if (button.dataset.systemTab === 'maintenance') loadBackups(); }
});
document.querySelectorAll('[data-about-target]').forEach(button => {
  button.addEventListener('click', () => {
    const target = button.dataset.aboutTarget;
    selectSystemTab(target);
    if (target === 'maintenance') loadBackups();
    document.querySelector(`[data-system-tab="${target}"]`)?.focus();
  });
});
document.getElementById('btn-check-update')?.addEventListener('click', () => checkForAppUpdate(true));
document.getElementById('btn-share-app')?.addEventListener('click', openAppShare);
document.getElementById('btn-copy-share-app')?.addEventListener('click', copyAppShareUrl);
document.getElementById('btn-native-share-app')?.addEventListener('click', shareAppWithSystem);
document.getElementById('btn-install-update')?.addEventListener('click', installAppUpdate);
document.getElementById('show-server-folders').addEventListener('change', async event => {
  const visible = event.target.checked;
  try { localStorage.setItem(SERVER_FOLDER_VISIBILITY_KEY, String(visible)); }
  catch (_) {}
  applyServerFolderVisibility();
  if (!visible && currentServerFolder) {
    document.querySelector('#folder-nav [data-filter="status"][data-value=""]')?.click();
  } else if (visible && !mailboxFolders.length) {
    await loadMailboxFolders();
  }
  toast(visible ? '已在左侧显示服务端文件夹' : '已隐藏左侧服务端文件夹', 'success');
});
document.getElementById('model-provider').addEventListener('change', async e => {
  const provider = e.target.value;
  if ((_systemConfig?.model?.saved_providers || []).includes(provider)) {
    if (!document.getElementById('start-model')?.classList.contains('hidden')) {
      const saved = _systemConfig?.model?.profiles?.[provider] || {};
      document.getElementById('model-base-url').value = saved.base_url || '';
      document.getElementById('model-name').value = saved.model || '';
      document.getElementById('multimodal-model').value = saved.multimodal_model || '';
      document.getElementById('model-multimodal-enabled').checked = saved.multimodal_enabled !== false;
      document.getElementById('model-extra-params').value = JSON.stringify(saved.extra_params || {}, null, 2);
      document.getElementById('model-api-key').value = '';
      document.getElementById('model-api-key').placeholder = '已安全保存此服务商的 API Key';
      document.getElementById('model-verify-ssl').checked = saved.verify_ssl !== false;
      document.getElementById('model-status').textContent = '待验证';
      return;
    }
    e.target.disabled = true;
    try {
      await api('/api/system/model', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({provider})});
      await loadSystemConfig();
      toast('已切换到本地保存的模型配置', 'success');
    } catch (error) {
      e.target.value = _systemConfig?.model?.provider || 'custom';
      toast('切换模型失败：' + error.message, 'error');
    } finally { e.target.disabled = false; }
    return;
  }
  const preset = (_systemConfig?.model?.presets || []).find(p => p.id === e.target.value);
  if (!preset) return;
  if (preset.base_url || preset.id === 'other') {
    document.getElementById('model-base-url').value = preset.base_url;
    document.getElementById('model-name').value = preset.model;
  }
  document.getElementById('multimodal-model').value = '';
  document.getElementById('model-multimodal-enabled').checked = !!preset.multimodal_enabled;
  document.getElementById('model-extra-params').value = '{}';
  document.getElementById('model-api-key').value = '';
  document.getElementById('model-api-key').placeholder = '请填写此服务对应的 API Key';
  document.getElementById('model-verify-ssl').checked = true;
  document.getElementById('model-status').textContent = '待测试 / 未保存';
  document.getElementById('model-status').className = 'connection-status';
});
function modelFormPayload() {
  let extra;
  try { extra = JSON.parse(document.getElementById('model-extra-params').value.trim() || '{}'); }
  catch (_) { throw new Error('扩展参数必须是有效 JSON 对象'); }
  if (!extra || Array.isArray(extra) || typeof extra !== 'object') throw new Error('扩展参数必须是 JSON 对象');
  return {
    provider: document.getElementById('model-provider').value,
    extra_params: extra,
    multimodal_enabled: document.getElementById('model-multimodal-enabled').checked,
    base_url: document.getElementById('model-base-url').value.trim(),
    model: document.getElementById('model-name').value.trim(),
    multimodal_model: document.getElementById('multimodal-model').value.trim(),
    api_key: document.getElementById('model-api-key').value,
    verify_ssl: document.getElementById('model-verify-ssl').checked,
  };
}
document.getElementById('model-config-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const payload = modelFormPayload();
    await api('/api/system/model', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    await loadSystemConfig();
    toast('模型配置已保存', 'success');
  } catch (err) { toast('保存模型配置失败：' + err.message, 'error'); }
});
document.getElementById('btn-test-model').addEventListener('click', async () => {
  const button = document.getElementById('btn-test-model');
  setLoading(button, true, '测试中…');
  const status = document.getElementById('model-status');
  status.textContent = '测试中…';
  try {
    const payload = modelFormPayload();
    const result = await api('/api/system/model/test', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    const visionUnavailable = result.multimodal && result.multimodal.checked && !result.multimodal.supported;
    status.textContent = !result.ok ? '连接失败' : visionUnavailable ? '图片识别不可用' : '连接成功';
    status.className = `connection-status ${!result.ok || visionUnavailable ? 'failed' : 'connected'}`;
    toast(result.message || status.textContent, !result.ok || visionUnavailable ? 'error' : 'success');
  } catch (err) { status.textContent = '连接失败'; status.className = 'connection-status failed'; toast(err.message, 'error'); }
  finally { setLoading(button, false); }
});
function diagnosticAdvice(item) {
  // 诊断条目名称随界面语言变化，匹配必须走后端下发的稳定 id
  const id = item.id || '';
  const mail = ['imap', 'smtp', 'vault'].includes(id) || (!id && (item.name === '邮箱收信' || item.name === 'SMTP 发信' || item.name === '系统凭据库'));
  if (mail) {
    const smtp = id === 'smtp' || (!id && item.name === 'SMTP 发信');
    const advice = {
      authentication: mailaiT('diag.a.authentication') || '请重新填写该邮箱的客户端授权码，并确认邮箱服务已允许客户端登录。',
      credential_missing: mailaiT('diag.a.credentialMissing') || '本机没有可用授权码，请重新填写客户端授权码。',
      credential_session: mailaiT('diag.a.credentialSession') || '授权码只在本次运行有效；退出后需重新登录，可检查系统凭据库权限。',
      certificate: mailaiT('diag.a.certificate') || '请核对服务器地址和证书。仅在可信内网使用自签名证书时考虑关闭证书校验。',
      timeout: mailaiT('diag.a.timeout') || '请先检查网络或 VPN，再核对服务器地址与端口。',
      dns: mailaiT('diag.a.dns') || '请检查网络或 VPN 及服务器地址；若服务商更换了地址，请重新添加账号并暂时保留旧数据。',
      refused: mailaiT('diag.a.refused') || '服务器已找到但拒绝该端口，请核对端口及 SSL/STARTTLS 设置。',
      configuration: mailaiT('diag.a.configuration') || '请补全服务器地址、端口和授权码。',
      connection: mailaiT('diag.a.connection') || '请核对服务器地址、端口和加密方式，并检查网络或 VPN。',
    }[item.issue] || (mailaiT('diag.a.fallback') || '请在邮箱账号中检查连接设置。');
    return {advice, action:mailaiT('diag.openAccount') || '打开邮箱设置', target:'account', field:
      ['authentication','credential_missing','credential_session'].includes(item.issue) ? 'mail-password' :
      smtp ? 'mail-smtp-host' : 'mail-port'};
  }
  if (id === 'model' || (!id && item.name === 'AI 模型')) return {advice:item.issue === 'authentication' ? (mailaiT('diag.a.modelAuth') || '请检查模型 API Key 是否有效。') :
    (mailaiT('diag.a.modelGeneral') || '请检查模型地址、API Key 和网络连接。'), action:mailaiT('diag.openModel') || '打开模型设置', target:'maintenance', field:'model-base-url'};
  return null;
}

document.getElementById('diagnostic-results').addEventListener('click', event => {
  const action = event.target.closest('[data-diagnostic-target]');
  if (!action) return;
  selectSystemTab(action.dataset.diagnosticTarget);
  if (action.dataset.diagnosticTarget === 'account') {
    const current = (_systemConfig?.accounts || []).find(account => account.active);
    if (current) { selectedManagedAccountId = current.id; renderAccountSelection(); openMailAddPanel(current); }
    else openMailAddPanel();
  }
  const field = document.getElementById(action.dataset.diagnosticField);
  field?.closest('details.admin-settings')?.setAttribute('open', '');
  if (field && !field.readOnly) field.focus({preventScroll:true});
  (field || document.querySelector(`[data-system-panel="${action.dataset.diagnosticTarget}"]`))?.scrollIntoView({block:'center', behavior:'smooth'});
});

document.getElementById('btn-run-diagnostics').addEventListener('click', async () => {
  const button = document.getElementById('btn-run-diagnostics');
  const results = document.getElementById('diagnostic-results');
  setLoading(button, true, mailaiT('diag.checking') || '检查中…');
  try {
    const data = await api(`/api/system/diagnostics?lang=${encodeURIComponent(currentI18nLanguage())}`);
    const activeAccount = (_systemConfig?.accounts || []).find(account => account.active);
    results.innerHTML = `<p class="diagnostic-scope">${activeAccount ? (mailaiT('diag.scope') || '本次检查：{user}。').replace('{user}', esc(activeAccount.user)) : (mailaiT('diag.scopeNone') || '本次未检测到正在使用的邮箱。')}${mailaiT('diag.scopeNote') || '诊断会实测当前邮箱和已配置的模型服务。'}</p>` + data.checks.map((item, index) => {
      const status = item.status || (item.ok ? 'pass' : 'fail');
      const icon = status === 'pass' ? '✓' : status === 'warning' ? 'i' : '!';
      const label = item.probe === 'live' ? (mailaiT('diag.live') || '实测') : (mailaiT('diag.local') || '本地');
      const guidance = status === 'pass' ? null : diagnosticAdvice(item);
      return `<div class="diagnostic-item ${esc(status)}" style="animation-delay:${index*45}ms"><span>${icon}</span><b>${esc(item.name)}<em>${label}</em></b><small title="${esc(item.detail)}">${esc(item.detail)}</small>${guidance ?
        `<p class="diagnostic-advice">${esc(guidance.advice)}</p><button type="button" class="diagnostic-action" data-diagnostic-target="${guidance.target}" data-diagnostic-field="${guidance.field}">${guidance.action} →</button>` : ''}</div>`;
    }).join('');
    results.classList.remove('hidden');
    toast(data.ok ? (mailaiT('diag.pass') || '真实检查通过') : (mailaiT('diag.fail') || '检查发现连接或配置失败'), data.ok ? 'success' : 'error');
  } catch (err) { toast((mailaiT('diag.failed') || '诊断失败：') + err.message, 'error'); }
  finally { setLoading(button, false); }
});
document.getElementById('btn-enable-notifications').addEventListener('click', async () => {
  if (window.pywebview?.api?.enable_notifications) {
    try {
      const result = await window.pywebview.api.enable_notifications();
      toast(result?.message || '已发送测试通知', result?.ok === false ? 'warn' : 'success');
    } catch (err) {
      toast('开启系统通知失败：' + err.message, 'error');
    }
    return;
  }
  if (!('Notification' in window)) { toast('当前运行环境不支持系统通知', 'warn'); return; }
  const permission = await Notification.requestPermission();
  toast(permission === 'granted' ? '系统通知已开启' : '未获得通知权限', permission === 'granted' ? 'success' : 'warn');
});
function renderBackupItem(item, index) {
  const date = new Date(item.created_at);
  const locale = currentI18nLanguage() === 'en' ? 'en-US' : 'zh-CN';
  const label = Number.isNaN(date.getTime()) ? (mailaiT('backup.localFallback') || '本地备份') : new Intl.DateTimeFormat(locale, {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date);
  const tSave = mailaiT('backup.saveAs') || '另存为';
  const tDelete = mailaiT('backup.delete') || '删除';
  const tRestore = mailaiT('backup.restore') || '恢复';
  const tPortable = mailaiT('backup.portable') || '迁移包';
  const download = `<button type="button" data-download-backup="${esc(item.filename)}" data-portable="${item.portable ? 'true' : 'false'}" aria-label="${item.portable ? (mailaiT('backup.ariaExport') || '导出迁移包到指定位置') : (mailaiT('backup.ariaDownload') || `下载 ${esc(label)} 的备份`)}">${tSave}</button>`;
  const remove = `<button type="button" data-delete-backup="${esc(item.filename)}" data-portable="${item.portable ? 'true' : 'false'}" aria-label="${mailaiT('backup.ariaDelete') || '删除'} ${item.portable ? tPortable : (mailaiT('backup.ariaBackup') || '备份')}">${tDelete}</button>`;
  const actions = item.portable ? `${download}${remove}` : `<button type="button" data-restore-backup="${esc(item.filename)}" aria-label="${mailaiT('backup.ariaRestore') || `恢复 ${esc(label)} 的备份`}">${tRestore}</button>${download}${remove}`;
  return `<div class="backup-item"><div class="backup-record-copy"><b>${esc(label)}${item.portable ? `<em>${tPortable}</em>` : index === 0 ? `<em>${mailaiT('backup.latest') || '最新'}</em>` : ''}</b><small title="${esc(item.filename)}">${esc(item.filename)}</small></div><small class="backup-record-size">${formatFileSize(item.size)}</small><div class="backup-record-actions">${actions}</div></div>`;
}
async function loadBackups() {
  const accountId = activeMailAccount()?.id;
  const host = document.getElementById('backup-list');
  try {
    const [localItems, portableItems] = await Promise.all([api('/api/system/backups', {accountId}), api('/api/system/portable-backups', {accountId})]);
    const items = [...portableItems, ...localItems].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
    if (accountId !== activeMailAccount()?.id) return;
    host.innerHTML = items.length ? items.slice(0, 3).map(renderBackupItem).join('') + (items.length > 3 ? `<details class="older-backups"><summary>${mailaiT('backup.showOlder') || '查看更早备份'} (${items.length - 3})</summary>${items.slice(3).map((item,index)=>renderBackupItem(item,index+3)).join('')}</details>` : '') : `<div class="backup-empty"><b>${mailaiT('backup.emptyTitle') || '还没有备份'}</b><small>${mailaiT('backup.emptyHint') || '创建第一份备份，为邮件留一份本地副本。'}</small></div>`;
    window.refreshCleanupHistory?.(accountId);
  } catch (_) {
    if (accountId === activeMailAccount()?.id) host.innerHTML = `<div class="backup-empty"><b>${mailaiT('backup.loadFailTitle') || '暂时无法读取备份'}</b><small>${mailaiT('backup.loadFailHint') || '请稍后重新打开此页。'}</small></div>`;
  }
}
document.getElementById('btn-create-backup').addEventListener('click', async () => {
  const button = document.getElementById('btn-create-backup'); setLoading(button, true, '备份中…');
  try { const result = await api('/api/system/backups?include_raw=true', {method:'POST'}); toast(`备份完成 · ${formatFileSize(result.size)}`, 'success'); await loadBackups(); }
  catch (err) { toast(err.message, 'error'); } finally { setLoading(button, false); }
});
function askMigrationPassword(mode) {
  const dialog = document.getElementById('migration-password-dialog');
  const form = dialog.querySelector('form');
  const password = document.getElementById('migration-password');
  const confirmation = document.getElementById('migration-password-confirm');
  const confirmationRow = document.getElementById('migration-password-confirm-row');
  const noPasswordRow = document.getElementById('migration-no-password-row');
  const noPassword = document.getElementById('migration-no-password');
  const error = document.getElementById('migration-password-error');
  const importing = mode === 'import';
  document.getElementById('migration-password-title').textContent = importing ? '输入迁移密码' : '保护迁移包';
  document.getElementById('migration-password-help').textContent = importing ? '该迁移包已加密。请输入旧设备导出时设置的密码。密码只用于本次解密。' : '迁移包包含邮件正文和附件。设置密码后，即使文件遗失也无法直接读取内容。';
  password.value = ''; confirmation.value = ''; noPassword.checked = false; error.textContent = '';
  confirmationRow.classList.toggle('hidden', importing); noPasswordRow.classList.toggle('hidden', importing);
  password.disabled = false; confirmation.disabled = importing;
  return new Promise(resolve => {
    let completed = false;
    const finish = value => { if (completed) return; completed = true; cleanup(); resolve(value); };
    const cleanup = () => { form.removeEventListener('submit', submit); noPassword.removeEventListener('change', toggle); dialog.removeEventListener('close', close); };
    const close = () => { if (dialog.returnValue !== 'migration-ok') finish(null); };
    const toggle = () => { password.disabled = noPassword.checked; confirmation.disabled = noPassword.checked; error.textContent = ''; };
    const submit = event => {
      event.preventDefault();
      if (event.submitter?.value === 'cancel') { dialog.close('cancel'); return; }
      if (!importing && noPassword.checked) { dialog.close('migration-ok'); finish(''); return; }
      if (password.value.length < 12 && !importing) { error.textContent = '迁移密码至少需要 12 位'; password.focus(); return; }
      if (!password.value && importing) { error.textContent = '请输入迁移密码'; password.focus(); return; }
      if (!importing && password.value !== confirmation.value) { error.textContent = '两次输入的密码不一致'; confirmation.focus(); return; }
      const value = password.value; dialog.close('migration-ok'); finish(value);
    };
    form.addEventListener('submit', submit); noPassword.addEventListener('change', toggle); dialog.addEventListener('close', close);
    dialog.showModal(); setTimeout(() => password.focus(), 0);
  });
}
document.getElementById('btn-export-portable').addEventListener('click', async () => {
  const button = document.getElementById('btn-export-portable');
  const since = document.getElementById('portable-export-since')?.value || '';
  const until = document.getElementById('portable-export-until')?.value || '';
  if (since && until && since > until) { toast('导出起始日期不能晚于截止日期', 'warn'); return; }
  const password = await askMigrationPassword('export');
  if (password === null) return;
  setLoading(button, true, '导出中…');
  try {
    const result = await api('/api/system/portable-backups', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({include_raw:true,password,since,until})});
    if (window.pywebview?.api?.save_portable_backup) {
      const saved = await window.pywebview.api.save_portable_backup(result.filename);
      if (saved?.ok) toast(`迁移包已保存到 ${saved.path}`, 'success');
      else if (saved?.canceled) toast('已取消选择位置；迁移包仍保存在下方记录中，可随时重新下载', 'warn');
      else throw new Error('无法保存迁移包');
    } else {
      const link = document.createElement('a'); link.href = result.download_url; link.download = result.filename; document.body.appendChild(link); link.click(); link.remove();
      toast(`迁移包已交给浏览器下载 · ${formatFileSize(result.size)}，请在下载列表中查看位置`, 'success');
    }
    await loadBackups();
  } catch (err) { toast(err.message, 'error'); } finally { setLoading(button, false); }
});
document.getElementById('btn-import-portable').addEventListener('click', () => document.getElementById('portable-backup-file').click());

// 语言切换：静态标记由 applyI18n 处理，这里重渲染 JS 动态区域
document.addEventListener('mailai:language-changed', () => {
  try { applyFilters(); } catch (_) {}
  try { addReadingActions(true); } catch (_) {}
  try { loadSemanticStatus(); } catch (_) {}
});
document.getElementById('portable-backup-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const encrypted = [77,65,73,76,65,73,51,0].every((value,index) => signature[index] === value);
  let password = '';
  if (encrypted) {
    password = await askMigrationPassword('import');
    if (password === null) return;
  }
  const button = document.getElementById('btn-import-portable'); setLoading(button, true, '检查中…');
  try {
    const accountId = activeMailAccount()?.id || '';
    const response = await fetch('/api/system/portable-backups/inspect', {method:'POST', headers:{'Content-Type':'application/octet-stream','X-Migration-Password':password,...(accountId ? {'X-MailAI-Account':accountId} : {})}, body:file});
    const preview = await response.json(); if (!response.ok) throw new Error(preview.detail || '迁移包检查失败');
    const content = preview.content || {}, account = preview.account || {};
    if (!preview.current_account_matches) {
      await api(`/api/system/portable-backups/import/${encodeURIComponent(preview.import_token)}`, {method:'DELETE'}).catch(()=>{});
      throw new Error(`迁移包属于 ${account.email || '未知账号'}，请先切换或登录该邮箱后再导入`);
    }
    const sourceDate = preview.created_at ? new Date(preview.created_at).toLocaleString('zh-CN') : '未知时间';
    const rawState = content.includes_raw_mail ? `${content.raw_messages || 0} 份邮件原文` : '不含邮件原文';
    const missing = content.missing_raw_messages ? `\n注意：源设备有 ${content.missing_raw_messages} 份原文缺失。` : '';
    const confirmed = window.confirm(`迁移包检查通过\n\n账号：${account.email}\n来源：${preview.source_platform || '未知系统'}\n导出时间：${sourceDate}\n内容：${content.emails || 0} 封邮件，${rawState}\n文件大小：${formatFileSize(preview.source_size || file.size)}${missing}\n\n导入会替换当前账号的本地数据，并先自动创建安全备份。服务器邮件不会被删除或修改。继续吗？`);
    if (!confirmed) { await api(`/api/system/portable-backups/import/${encodeURIComponent(preview.import_token)}`, {method:'DELETE'}).catch(()=>{}); return; }
    setLoading(button, true, '导入中…');
    const result = await api('/api/system/portable-backups/restore', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({import_token:preview.import_token,password})});
    if (window.confirm(`已导入 ${result.emails || 0} 封邮件。\n\n是否现在重新同步邮箱，以建立新设备的服务器关联？邮件较多时可能需要较长时间。`)) {
      await api('/api/fetch_all', {method:'POST'});
    }
    window.location.reload();
  } catch (err) { toast(err.message, 'error'); } finally { setLoading(button, false); }
});
document.getElementById('backup-list').addEventListener('click', event => {
  const restoreButton = event.target.closest('[data-restore-backup]');
  if (restoreButton) { window.openBackupRestore(restoreButton.dataset.restoreBackup); return; }
  const downloadButton = event.target.closest('[data-download-backup]');
  const deleteButton = event.target.closest('[data-delete-backup]');
  if (deleteButton) {
    const filename = deleteButton.dataset.deleteBackup;
    const portable = deleteButton.dataset.portable === 'true';
    if (!window.confirm(`确定永久删除这个${portable ? '迁移包' : '本机备份'}吗？\n\n${filename}\n\n删除后无法恢复。`)) return;
    (async () => {
      setLoading(deleteButton, true, '删除中…');
      try {
        const path = portable ? `/api/system/portable-backups/stored/${encodeURIComponent(filename)}` : `/api/system/backups/${encodeURIComponent(filename)}`;
        await api(path, {method:'DELETE'});
        toast(`${portable ? '迁移包' : '备份'}已删除`, 'success');
        await loadBackups();
      } catch (err) { toast(`删除失败：${err.message}`, 'error'); }
      finally { setLoading(deleteButton, false); }
    })();
    return;
  }
  if (!downloadButton) return;
  const filename = downloadButton.dataset.downloadBackup;
  const portable = downloadButton.dataset.portable === 'true';
  (async () => {
    setLoading(downloadButton, true, '选择位置…');
    try {
      if (window.pywebview?.api) {
        const method = portable ? window.pywebview.api.save_portable_backup : window.pywebview.api.save_local_backup;
        if (typeof method === 'function') {
          const result = await method(filename);
          if (result?.ok) toast(`已保存到 ${result.path}`, 'success');
          else if (result?.canceled) toast('已取消另存为，原备份仍保留在应用中', 'warn');
          else throw new Error('保存失败');
          return;
        }
      }
      const href = portable ? `/api/system/portable-backups/download/${encodeURIComponent(filename)}` : `/api/system/backups/${encodeURIComponent(filename)}`;
      const link = document.createElement('a'); link.href = href; link.download = filename; link.hidden = true; document.body.appendChild(link); link.click(); link.remove();
      toast('已交给浏览器下载，请在下载列表中查看保存位置', 'success');
    } catch (err) { toast(`备份另存失败：${err.message}`, 'error'); }
    finally { setLoading(downloadButton, false); }
  })();
});
document.getElementById('mail-config-form').addEventListener('submit', async e => {
  e.preventDefault();
  const payload = {
    host: document.getElementById('mail-host').value.trim(),
    port: Number(document.getElementById('mail-port').value),
    user: document.getElementById('mail-user').value.trim(),
    password: document.getElementById('mail-password').value,
    ssl: document.getElementById('mail-ssl').checked,
    verify_ssl: document.getElementById('mail-verify-ssl').checked,
    smtp_host: document.getElementById('mail-smtp-host').value.trim(),
    smtp_port: Number(document.getElementById('mail-smtp-port').value),
    smtp_ssl: document.getElementById('mail-smtp-ssl').checked,
    smtp_starttls: document.getElementById('mail-smtp-starttls').checked,
    smtp_verify_ssl: document.getElementById('mail-verify-ssl').checked,
  };
  const status = document.getElementById('mail-status');
  const managedAccountId = document.getElementById('mail-add-panel').dataset.accountId || '';
  status.textContent = '连接中…';
  try {
    let connectionResult;
    if (managedAccountId) {
      connectionResult = await api('/api/system/mail/account/update', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...payload, account_id:managedAccountId})});
    } else {
      connectionResult = await api('/api/system/mail/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    }
    selectedManagedAccountId = '';
    await loadSystemConfig();
    closeMailAddPanel();
    toast(managedAccountId ? `已更新 ${payload.user} 的登录信息` : `已登录 ${payload.user}，正在后台初始化邮箱`, 'success');
    if (connectionResult?.credential_warning) toast(connectionResult.credential_warning, 'warn');
    if (connectionResult?.smtp_warning) toast(connectionResult.smtp_warning, 'warn');
    if (!managedAccountId) { startFetchMonitor(); window.mailOnboarding?.connected(true); }
  } catch (err) { status.textContent = '登录失败'; status.className = 'connection-status failed'; toast(err.message, 'error'); }
});
document.getElementById('saved-accounts').addEventListener('click', async event => {
  const button = event.target.closest('[data-account-id]');
  if (!button) return;
  if (!document.getElementById('mail-add-panel').classList.contains('hidden')) closeMailAddPanel();
  selectedManagedAccountId = button.dataset.accountId;
  renderAccountSelection();
});
document.getElementById('btn-add-mail').addEventListener('click', () => openMailAddPanel());
document.getElementById('btn-cancel-add-mail').addEventListener('click', closeMailAddPanel);
document.getElementById('btn-manage-mail').addEventListener('click', () => {
  const account = selectedManagedAccount();
  if (account) openMailAddPanel(account);
});
function openLogoutDialog(accountId = selectedManagedAccountId) {
  const modal = document.getElementById('logout-modal');
  const accounts = _systemConfig?.accounts || [];
  const target = accounts.find(account => account.id === accountId);
  if (!target) return toast('请先选择要删除的邮箱', 'error');
  modal.dataset.accountId = target.id;
  document.getElementById('logout-account-label').textContent = `${target.user} · 删除后将移除本机保存的邮箱授权码`;
  const keep = modal.querySelector('input[value="keep"]');
  keep.checked = true;
  modal.querySelectorAll('.logout-choice').forEach(choice => choice.classList.toggle('selected', choice.contains(keep)));
  document.getElementById('logout-warning').classList.add('hidden');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  keep.focus();
}

function closeLogoutDialog() {
  const modal = document.getElementById('logout-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

async function stopFetchBeforeLogout() {
  let state = await api('/api/fetch_status');
  if (!state.running) return;
  await api('/api/cancel_fetch', {method: 'POST'});
  toast('正在安全停止邮件同步…');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    state = await api('/api/fetch_status');
    if (!state.running) return;
  }
  throw new Error('邮件同步仍在停止中，请稍后再次删除');
}

document.getElementById('btn-delete-mail').addEventListener('click', () => openLogoutDialog());
document.getElementById('btn-close-logout').addEventListener('click', closeLogoutDialog);
document.getElementById('btn-cancel-logout').addEventListener('click', closeLogoutDialog);
document.querySelector('#logout-modal [data-close-logout]').addEventListener('click', closeLogoutDialog);
document.querySelectorAll('input[name="logout-history"]').forEach(input => input.addEventListener('change', () => {
  document.querySelectorAll('.logout-choice').forEach(choice => choice.classList.toggle('selected', choice.contains(input)));
  document.getElementById('logout-warning').classList.toggle('hidden', input.value !== 'clear');
}));
document.getElementById('btn-confirm-logout').addEventListener('click', async () => {
  const button = document.getElementById('btn-confirm-logout');
  const clearHistory = document.querySelector('input[name="logout-history"]:checked').value === 'clear';
  setLoading(button, true, clearHistory ? '正在清空…' : '正在删除…');
  try {
    await stopFetchBeforeLogout();
    const accountId = document.getElementById('logout-modal').dataset.accountId || '';
    const targetWasActive = (_systemConfig?.accounts || []).some(account => account.id === accountId && account.active);
    await api('/api/system/mail/logout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({clear_history: clearHistory, account_id: accountId})});
    closeLogoutDialog();
    selectedManagedAccountId = '';
    await loadSystemConfig();
    if (targetWasActive) {
      ++mailLoadRevision;
      allEmails = []; allTodos = []; sentMessages = []; savedDrafts = [];
      resetReadingPane(); updateSidebar(); applyFilters();
    }
    selectSystemTab('account');
    document.querySelector('.layout').classList.add('hidden');
    document.getElementById('system-view').classList.remove('hidden');
    toast(clearHistory ? '已删除邮箱并清空本地邮件历史' : '已删除邮箱，本地邮件历史已保留', 'success');
  } catch (err) { toast('删除失败：' + err.message, 'error'); }
  finally { setLoading(button, false); }
});
document.getElementById('btn-rules').addEventListener('click', () => {
  const view = document.getElementById('rules-view');
  if (view.classList.contains('hidden')) showRulesView();
  else hideRulesView();
});
document.getElementById('btn-close-rules').addEventListener('click', () => hideRulesView());
document.getElementById('rule-search').addEventListener('input', renderRules);
document.getElementById('rule-category-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.rule-tab');
  if (!tab) return;
  _ruleCategory = tab.dataset.category;
  renderRuleTabs();
  renderRules();
});
document.getElementById('rules-grid').addEventListener('click', async e => {
  const button = e.target.closest('.btn-save-rule');
  if (!button) return;
  try { await saveRuleCard(button.closest('.rule-card')); }
  catch (err) { toast('保存规则失败：' + err.message, 'error'); }
});
document.getElementById('rules-grid').addEventListener('change', async e => {
  if (!e.target.classList.contains('rule-enabled')) return;
  try { await saveRuleCard(e.target.closest('.rule-card')); }
  catch (err) { toast('保存规则失败：' + err.message, 'error'); loadRules(); }
});
document.getElementById('allowlist-form').addEventListener('submit', async event => {
  event.preventDefault();
  const domainInput = document.getElementById('allowlist-domain');
  const noteInput = document.getElementById('allowlist-note');
  const kind = document.getElementById('allowlist-kind').value;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  setLoading(button, true, '正在添加…');
  try {
    const entry = await saveAllowlistEntry(domainInput.value, true, noteInput.value, kind);
    domainInput.value = '';
    noteInput.value = '';
    toast(`${entry.value} 已加入可信${kind === 'address' ? '邮箱' : '域名'}`, 'success');
  } catch (err) { toast('添加白名单失败：' + err.message, 'error'); }
  finally { setLoading(button, false); }
});
document.getElementById('allowlist-kind').addEventListener('change', event => {
  const address = event.target.value === 'address';
  document.getElementById('allowlist-value-label').textContent = address ? '邮箱地址' : '域名';
  const input = document.getElementById('allowlist-domain');
  input.placeholder = address ? '例如 name@partner.example.com' : '例如 partner.example.com';
  input.inputMode = address ? 'email' : 'url';
});
document.getElementById('allowlist-list').addEventListener('change', async event => {
  if (!event.target.classList.contains('allowlist-enabled')) return;
  const item = event.target.closest('.allowlist-item');
  const entry = _allowlistData.find(row => row.id === Number(item.dataset.id) && row.kind === item.dataset.kind);
  if (!entry) return;
  try {
    await saveAllowlistEntry(entry.value, event.target.checked, entry.note || '', entry.kind);
    toast(`${entry.value} 已${event.target.checked ? '启用' : '停用'}`, 'success');
  } catch (err) { event.target.checked = !event.target.checked; toast('更新白名单失败：' + err.message, 'error'); }
});
document.getElementById('allowlist-list').addEventListener('click', async event => {
  const button = event.target.closest('.allowlist-delete');
  if (!button) return;
  const item = button.closest('.allowlist-item');
  const entry = _allowlistData.find(row => row.id === Number(item.dataset.id) && row.kind === item.dataset.kind);
  if (!entry || !window.confirm(`确定从白名单中删除 ${entry.value}？`)) return;
  try {
    await api(`/api/rules/allowlist/${entry.kind}/${entry.id}`, {method:'DELETE'});
    _allowlistData = _allowlistData.filter(row => !(row.id === entry.id && row.kind === entry.kind));
    renderAllowlist();
    toast(`${entry.value} 已从白名单删除`, 'success');
  } catch (err) { toast('删除白名单失败：' + err.message, 'error'); }
});
document.getElementById('rule-scenario-grid').addEventListener('change', async event => {
  if (!event.target.matches('.scenario-enabled,.scenario-sensitivity')) return;
  const card = event.target.closest('.rule-scenario-card');
  card.classList.add('saving');
  try { await saveRuleScenario(card); }
  catch (err) { toast('保存常用规则失败：' + err.message, 'error'); await loadRules(); }
  finally { card.classList.remove('saving'); }
});
document.getElementById('btn-toggle-advanced-rules').addEventListener('click', event => {
  const content = document.getElementById('advanced-rules-content');
  const opening = content.classList.contains('hidden');
  content.classList.toggle('hidden', !opening);
  event.currentTarget.setAttribute('aria-expanded', String(opening));
  event.currentTarget.querySelector('i').textContent = opening ? (mailaiT('rules.collapse') || '收起') : (mailaiT('rules.expand') || '展开');
});
document.getElementById('btn-save-thresholds').addEventListener('click', async () => {
  const review = Number(document.getElementById('threshold-review').value);
  const quarantine = Number(document.getElementById('threshold-quarantine').value);
  const spam = Number(document.getElementById('threshold-spam').value);
  try {
    await api(`/api/rules/thresholds/update?review_score=${review}&quarantine_score=${quarantine}&spam_score=${spam}`, {method: 'POST'});
    toast('判定阈值已保存', 'success');
  } catch (e) { toast('保存阈值失败：' + e.message, 'error'); }
});
document.getElementById('btn-reset-rules').addEventListener('click', async () => {
  if (!window.confirm('确定恢复全部规则权重、启停状态和判定阈值的默认值吗？')) return;
  try {
    await api('/api/rules/actions/reset', {method: 'POST'});
    await loadRules();
    toast('已恢复默认规则配置', 'success');
  } catch (e) { toast('恢复默认失败：' + e.message, 'error'); }
});
document.getElementById('btn-close-dashboard').addEventListener('click', hideDashboard);
document.getElementById('dashboard-days').addEventListener('change', (e) => {
  loadDashboard(parseInt(e.target.value));
});
document.getElementById('btn-refresh-dashboard').addEventListener('click', async event => {
  setLoading(event.currentTarget, true, '刷新中…');
  try { await loadDashboard(_dashboardDays); }
  finally { setLoading(event.currentTarget, false); }
});
document.getElementById('btn-dashboard-review').addEventListener('click', async () => {
  const first = _dashboardAttention[0];
  if (!first) return;
  hideDashboard();
  await revealEmailFromSource(first.id);
});
document.getElementById('dashboard-view').addEventListener('click', async event => {
  const target = event.target.closest('[data-dashboard-email]');
  const emailId = Number(target?.dataset.dashboardEmail);
  if (!emailId) return;
  hideDashboard();
  await revealEmailFromSource(emailId);
});

document.getElementById('btn-fetch-more').addEventListener('click', async () => {
  const btn = document.getElementById('btn-fetch-more');
  setLoading(btn, true, '加载中…');
  try {
    await api('/api/fetch_more', { method: 'POST' });
    startFetchMonitor();
  } catch (e) {
    toast('加载失败：' + e.message, 'error');
    setLoading(btn, false);
  }
});

document.getElementById('btn-fetch-all').addEventListener('click', async () => {
  const btn = document.getElementById('btn-fetch-all');
  if (!confirm('确定要拉取收件箱全部历史邮件吗？\n邮件较多时会消耗一定时间和 LLM 额度。')) return;
  setLoading(btn, true, '拉取中…');
  try {
    await api('/api/fetch_all', { method: 'POST' });
    startFetchMonitor();
  } catch (e) {
    toast('拉取失败：' + e.message, 'error');
    setLoading(btn, false);
  }
});

document.getElementById('btn-cancel-fetch').addEventListener('click', async () => {
  const btn = document.getElementById('btn-cancel-fetch');
  btn.disabled = true;
  btn.textContent = '正在中断...';
  try {
    await api('/api/cancel_fetch', { method: 'POST' });
    toast('已请求中断拉取', 'warn');
  } catch (e) {
    toast('中断请求失败：' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '⏹ 中断拉取';
  }
});

document.querySelector('.modal-close').addEventListener('click', () => {
  closeDigestModal();
});
document.querySelector('.modal-backdrop').addEventListener('click', () => {
  closeDigestModal();
});

// 日报历史切换
document.getElementById('digest-history-select').addEventListener('change', (e) => {
  const id = e.target.value;
  if (id) {
    loadDigestById(id);
  } else {
    const today = localDateKey();
    const todayDigest = _digestHistory.find(d => d.digest_date === today);
    if (todayDigest) {
      loadDigestById(todayDigest.id);
    } else {
      showDigestGeneratePrompt();
    }
  }
});
document.getElementById('btn-regenerate-digest').addEventListener('click', generateDigest);

// 日报里的来源邮件链接 → 抽屉预览
document.getElementById('digest-body').addEventListener('click', (e) => {
  const link = e.target.closest('.digest-email-link');
  if (!link) return;
  e.preventDefault();
  const id = parseInt(link.dataset.emailId);
  if (id) openDigestEmailDrawer(id);
});

// 来源邮件抽屉
document.querySelector('#digest-email-drawer .drawer-close').addEventListener('click', closeDigestEmailDrawer);
document.querySelector('#digest-email-drawer .drawer-backdrop').addEventListener('click', closeDigestEmailDrawer);
document.getElementById('btn-go-to-email').addEventListener('click', () => {
  if (!_digestSelectedEmailId) return;
  closeDigestEmailDrawer();
  closeDigestModal();
  revealEmailFromSource(_digestSelectedEmailId);
});

// 往来邮件抽屉
document.getElementById('btn-close-correspondence').addEventListener('click', closeCorrespondence);
document.querySelector('#correspondence-drawer .drawer-backdrop').addEventListener('click', closeCorrespondence);
document.getElementById('correspondence-body').addEventListener('click', event => {
  const retry = event.target.closest('[data-retry-correspondence]');
  if (retry) return reloadCorrespondence();
  const selectAll = event.target.closest('[data-correspondence-select-all]');
  if (selectAll) {
    const available = correspondenceSelectableItems().map(item => Number(item.id));
    correspondenceSelectedIds = correspondenceSelectedIds.size === available.length ? new Set() : new Set(available);
    syncCorrespondenceSelection();
    return;
  }
  if (event.target.closest('[data-correspondence-delete]')) return deleteSelectedCorrespondence();
  const item = event.target.closest('[data-correspondence-email]');
  if (item && !item.disabled) openCorrespondenceEmail(Number(item.dataset.correspondenceEmail));
});
document.getElementById('correspondence-body').addEventListener('change', event => {
  const checkbox = event.target.closest('[data-correspondence-select]');
  if (!checkbox || correspondenceBusy) return;
  const id = Number(checkbox.dataset.correspondenceSelect);
  if (checkbox.checked) correspondenceSelectedIds.add(id); else correspondenceSelectedIds.delete(id);
  syncCorrespondenceSelection();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.getElementById('correspondence-drawer').classList.contains('hidden')) closeCorrespondence();
});

document.getElementById('global-search').addEventListener('input', (e) => {
  const query = e.target.value.trim();
  const revision = ++searchRevision;
  // Search keeps the selected folder, including local drafts and sent mail.
  currentFilter.search = query;
  resetReadingPane();
  searchResults = null;
  clearTimeout(globalSearchTimer);
  globalSearchTimer = setTimeout(async () => {
    if (!query || specialMailbox || currentFilter.status === 'trash') { applyFilters(); return; }
    try {
      const path = unifiedMailbox ? '/api/system/mail/unified-inbox?days=9999' : '/api/emails/search?days=9999';
      const results = await loadMailPages(`${path}&q=${encodeURIComponent(query)}&limit=1000${currentServerFolder ? '&folder=' + encodeURIComponent(currentServerFolder) : ''}`, () => revision === searchRevision);
      if (revision !== searchRevision) return;
      searchResults = results;
      selectedMailIds.clear(); updateBulkToolbar(); applyFilters();
    } catch (err) { toast('搜索失败：' + err.message, 'error'); }
  }, 260);
});

async function applySidebarFilter(reload = false) {
  resetReadingPane();
  if (reload) await loadData(); else applyFilters();
}

document.getElementById('filter-days').addEventListener('click', event => {
  const button = event.target.closest('[data-value]'); if (!button) return;
  currentFilter.days = Number(button.dataset.value);
  setSegmentedFilter('filter-days', button.dataset.value);
  applySidebarFilter(true);
});

document.getElementById('filter-priority').addEventListener('click', event => {
  const button = event.target.closest('[data-value]'); if (!button) return;
  currentFilter.priority = button.dataset.value;
  setSegmentedFilter('filter-priority', button.dataset.value);
  applySidebarFilter();
});

document.getElementById('filter-domain').addEventListener('change', event => {
  currentFilter.domain = event.target.value;
  applySidebarFilter();
});

document.getElementById('list-sort').addEventListener('change', event => {
  currentFilter.sort = event.target.value; applyFilters();
});

document.getElementById('filter-unread').addEventListener('change', e => {
  currentFilter.unread = e.target.checked;
  applySidebarFilter();
});

document.getElementById('filter-attachments').addEventListener('change', (e) => {
  currentFilter.attachments = e.target.checked;
  applySidebarFilter();
});

document.getElementById('btn-reset-filter').addEventListener('click', async () => {
  resetReadingPane();
  ++searchRevision; clearTimeout(globalSearchTimer); searchResults = null;
  specialMailbox = ''; currentServerFolder = '';
  currentFilter = { status: '', verdict: '', category: '', days: 9999, priority: '', domain: '', search: '', attachments: false, sort: 'date-desc' };
  document.getElementById('global-search').value = '';
  setSegmentedFilter('filter-days', '9999');
  setSegmentedFilter('filter-priority', '');
  document.getElementById('filter-domain').value = '';
  document.getElementById('filter-attachments').checked = false;
  currentFilter.unread = false; document.getElementById('filter-unread').checked = false;
  document.getElementById('list-sort').value = 'date-desc';
  updateActiveNav();
  await loadData();
  toast('筛选已清除，正在显示全部邮件', 'success');
});

// ===== 初始化 =====
bindNavItems();
document.getElementById('assistant-orb').addEventListener('click', openAssistant);
initAssistantLayout();
document.getElementById('assistant-close').addEventListener('click', closeAssistant);
document.getElementById('assistant-history').addEventListener('click', showAssistantHistory);
document.getElementById('assistant-new').addEventListener('click', resetAssistantConversation);
document.getElementById('assistant-history-back').addEventListener('click', () => document.getElementById('assistant-history-panel').classList.add('hidden'));
document.getElementById('assistant-history-list').addEventListener('click', event => { const item = event.target.closest('[data-conversation-id]'); if (item) loadAssistantConversation(Number(item.dataset.conversationId)); });
const assistantInput = document.getElementById('assistant-input');
function resizeAssistantInput() {
  const minimum = 36, maximum = Math.min(128, Math.max(88, Math.round(window.innerHeight * .18)));
  assistantInput.style.height = 'auto';
  const height = Math.max(minimum, Math.min(assistantInput.scrollHeight, maximum));
  assistantInput.style.height = `${height}px`;
  assistantInput.style.overflowY = assistantInput.scrollHeight > maximum ? 'auto' : 'hidden';
  document.getElementById('assistant-form').classList.toggle('assistant-form-expanded', height > 48);
}
window.resizeAssistantInput = resizeAssistantInput;
assistantInput.addEventListener('input', resizeAssistantInput);
window.addEventListener('resize', resizeAssistantInput);
resizeAssistantInput();
document.getElementById('assistant-form').addEventListener('submit', event => { event.preventDefault(); if(assistantController)return; if(window.assistantImages?.busy())return toast('图片正在读取，请稍候','warn'); const input = assistantInput; const value = input.value; const images=window.assistantImages?.snapshot()||[]; const attachments=window.assistantAttachments?.snapshot()||[]; askAssistant(value,null,images,attachments); if(assistantController){input.value='';resizeAssistantInput();} });
assistantInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); document.getElementById('assistant-form').requestSubmit(); } });
renderAssistantWelcome();
document.getElementById('assistant-messages').addEventListener('click', event => {
  const button = event.target.closest('[data-assistant-question]');
  if (button) askAssistant(button.dataset.assistantQuestion);
});
document.getElementById('assistant-alert-strip').addEventListener('click', event => {
  if (event.target.closest('[data-analyze-alert]')) analyzeNewAssistantAlerts();
  if (event.target.closest('[data-dismiss-alert]')) markAssistantAlertsSeen().then(loadAssistantAlerts);
});
document.getElementById('assistant-messages').addEventListener('click', event => { const link = event.target.closest('[data-email-id]'); if (link) goToAssistantEmail(Number(link.dataset.emailId)); });
document.getElementById('btn-compose').addEventListener('click', () => openCompose());
document.getElementById('account-mailbox-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-account-action]');
  if (!button) return;
  const action = button.dataset.accountAction;
  if (action === 'unified') openUnifiedInbox().catch(err => toast('加载所有收件箱失败：' + err.message, 'error'));
  else openAccountMailbox(button.dataset.accountId, action).catch(err => toast('打开邮箱失败：' + err.message, 'error'));
});
document.getElementById('btn-sidebar-add-account').addEventListener('click', () => showSystemView('account'));
document.getElementById('compose-from').addEventListener('change', async event => {
  const accountId = event.target.value;
  const session = draftSession;
  if (session.busy || session.closing || session.switching || session.canceled) { event.target.value = composeAccountId; return; }
  hideContactSuggestions();
  if (draftSession.attachmentReads) { event.target.value = composeAccountId; return toast('附件正在读取，请稍候再切换发件账号', 'warn'); }
  const previous = composeAccountId || activeMailAccount()?.id || '';
  if (accountId === previous) return;
  const previousSignature = {state:signatureState, id:currentSignatureId, html:document.getElementById('compose-signature-content').innerHTML};
  const previousContext = {...composeContext};
  const previousCapability = sendCapability;
  const card = document.querySelector('#compose-modal .compose-card');
  session.switching = true;
  card.inert = true;
  ++composeAiRevision;
  event.target.disabled = true;
  try {
    await saveCurrentDraft();
    const [capability, signatures] = await Promise.all([
      api('/api/mail/send-capability', {accountId}), api('/api/mail/signatures', {accountId})
    ]);
    if (session !== draftSession || session.canceled) return;
    composeContext.source_draft_email_id = null;
    composeAccountId = accountId;
    composeContext.reply_to_email_id = null;
    sendCapability = capability;
    signatureState = signatures;
    renderComposeSignature(signatureState.default_id || '');
    currentDraftId = null;
    draftSession = {id:null, accountId, pending:Promise.resolve(), canceled:false, busy:false, switching:true,
      initialEdit:session.id ? null : session.initialEdit};
    await saveCurrentDraft();
    if (session.id) {
      try { await api('/api/drafts/' + session.id, {accountId:previous, method:'DELETE'}); }
      catch (_) { toast('新账号草稿已保存；旧账号副本未能移除，可稍后在草稿箱清理', 'warn'); }
    }
    session.canceled = true;
    renderComposeAccountPicker(accountId);
    const send = document.getElementById('btn-send-mail');
    send.disabled = !sendCapability.configured;
    send.textContent = sendCapability.configured ? '发送' : '发送（当前邮箱未配置）';
    send.title = sendCapability.reason || '发送邮件';
    clearComposePreflight();
    resetComposeAiPanel();
    refreshDraftList(previous).catch(() => {});
  } catch (err) {
    draftSession = session; currentDraftId = session.id;
    composeContext = previousContext;
    sendCapability = previousCapability;
    signatureState = previousSignature.state;
    renderComposeSignature(previousSignature.id, previousSignature.html);
    composeAccountId = previous; renderComposeAccountPicker(previous);
    setDraftStatus(session, draftNeedsSave(session) ? 'error' : session.id ? 'saved' : 'idle');
    toast('选择发件账号失败：' + err.message, 'error');
  } finally { session.switching = false; draftSession.switching = false; card.inert = false; event.target.disabled = false; }
});
document.getElementById('btn-mobile-nav').addEventListener('click', () => {
  const open = document.body.classList.toggle('mobile-nav-open');
  document.getElementById('btn-mobile-nav').setAttribute('aria-expanded', String(open));
});
document.getElementById('sidebar-backdrop').addEventListener('click', () => {
  document.body.classList.remove('mobile-nav-open');
  document.getElementById('btn-mobile-nav').setAttribute('aria-expanded', 'false');
});
document.querySelector('.sidebar').addEventListener('click', event => {
  const action = event.target.closest('[data-mobile-action]')?.dataset.mobileAction;
  if (action === 'system') showSystemView();
  if (action === 'rules') showRulesView();
  if (action === 'dashboard') showDashboard();
  if (action === 'contacts') openContactCenter();
  if (action === 'attachments') openAttachmentCenter();
  if (action === 'todos') openTodoCenter();
  if (window.innerWidth <= 1024 && event.target.closest('.nav-item')) {
    document.body.classList.remove('mobile-nav-open');
    document.getElementById('btn-mobile-nav').setAttribute('aria-expanded', 'false');
  }
});
document.getElementById('btn-close-compose').addEventListener('click', closeCompose);
document.querySelector('#compose-modal .compose-backdrop').addEventListener('click', closeCompose);
['compose-to','compose-cc','compose-bcc','compose-subject','compose-message'].forEach(id => document.getElementById(id).addEventListener('input', () => { clearComposePreflight(); queueDraftSave(); refreshComposeAiContext(); }));
document.addEventListener('selectionchange', rememberComposeSelection);
document.getElementById('compose-quote-toggle').addEventListener('click', event => {
  const quote = document.getElementById('compose-quote');
  const collapsed = quote.classList.toggle('collapsed');
  event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
});
document.querySelectorAll('.contact-input').forEach(input => {
  input.addEventListener('focus', () => loadContactSuggestions(input));
  input.addEventListener('input', () => { clearTimeout(contactTimer); contactTimer = setTimeout(() => loadContactSuggestions(input), 140); });
  input.addEventListener('keydown', event => {
    if (document.getElementById('contact-suggestions').classList.contains('hidden')) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); highlightContact(contactIndex + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); highlightContact(contactIndex - 1); }
    else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); chooseContact(contactIndex); }
    else if (event.key === 'Escape') hideContactSuggestions();
  });
  input.addEventListener('blur', () => {
    input.value = normalizeRecipientText(input.value);
    queueDraftSave(); refreshComposeAiContext();
  });
});
document.querySelectorAll('.recipient-book-button').forEach(button => button.addEventListener('click', () => openContactCenter(button.dataset.contactTarget)));
document.getElementById('contact-suggestions').addEventListener('mousedown', event => {
  const option = event.target.closest('.contact-option');
  if (option) { event.preventDefault(); chooseContact(Number(option.dataset.index)); }
});
document.addEventListener('mousedown', event => {
  if (!event.target.closest('.contact-input') && !event.target.closest('#contact-suggestions')) hideContactSuggestions();
});
document.getElementById('btn-save-draft').addEventListener('click', closeCompose);
document.getElementById('draft-state').addEventListener('click', () => saveCurrentDraft().catch(() => {}));
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && document.body.classList.contains('compose-open')) {
    event.preventDefault();
    if (!draftSession.switching) saveCurrentDraft({force:true}).catch(() => {});
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && document.body.classList.contains('compose-open') && !draftSession.switching) saveCurrentDraft().catch(() => {});
});
window.addEventListener('beforeunload', event => {
  if (document.body.classList.contains('compose-open') && !draftSession.canceled &&
      (draftNeedsSave() || draftSession.queued || draftSession.attachmentReads || draftSession.switching)) {
    event.preventDefault(); event.returnValue = '';
  }
});
window.mailaiPrepareExit = async () => {
  if (!document.body.classList.contains('compose-open')) return true;
  if (draftSession.busy || draftSession.switching || draftSession.attachmentReads) {
    toast('邮件或附件正在处理，请稍候再退出', 'warn'); return false;
  }
  return closeCompose();
};
document.getElementById('btn-add-attachment').addEventListener('click', () => document.getElementById('compose-attachments-input').click());
document.getElementById('btn-insert-compose-image').addEventListener('click', () => { rememberComposeSelection(); document.getElementById('compose-image-input').click(); });
document.getElementById('compose-image-input').addEventListener('change', event => {
  insertComposeImage(event.target.files[0]).catch(err => toast('插入图片失败：' + err.message, 'error'));
  event.target.value = '';
});
async function pasteDesktopAttachments(showEmpty = true) {
  const session = draftSession, accountId = composeAccountId;
  try {
    if (!window.pywebview?.api?.clipboard_attachments) {
      if (showEmpty) toast('请在写信窗口按 Ctrl+V / ⌘V 粘贴文件，或直接拖入', 'info');
      return;
    }
    const items = await window.pywebview.api.clipboard_attachments();
    if (session !== draftSession || session.canceled || accountId !== composeAccountId) return;
    if (!items.length) { if (showEmpty) toast('请先在文件管理器中复制文件，再粘贴附件', 'info'); return; }
    const files = items.map(item => new File([Uint8Array.from(atob(item.data_base64), c => c.charCodeAt(0))], item.filename, {type:item.content_type}));
    await addComposeAttachments(files);
  } catch (error) { toast('粘贴附件失败：' + error.message, 'error'); }
}
document.getElementById('btn-paste-attachment').addEventListener('click', () => pasteDesktopAttachments());
const composeDropHost = document.querySelector('#compose-modal .compose-card');
composeDropHost.addEventListener('dragover', event => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  composeDropHost.classList.add('attachment-drag-over');
});
composeDropHost.addEventListener('dragleave', event => {
  if (!composeDropHost.contains(event.relatedTarget)) composeDropHost.classList.remove('attachment-drag-over');
});
composeDropHost.addEventListener('drop', event => {
  composeDropHost.classList.remove('attachment-drag-over');
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault(); event.stopPropagation();
  if ([...(event.dataTransfer.items || [])].some(item => item.webkitGetAsEntry?.()?.isDirectory)) return toast('请先将文件夹压缩后再添加', 'warn');
  addComposeAttachments(event.dataTransfer.files).catch(error => toast(error.message, 'error'));
});
composeDropHost.addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) {
    if (!event.clipboardData?.getData('text/plain') && !event.clipboardData?.getData('text/html')) pasteDesktopAttachments(false);
    return;
  }
  event.preventDefault(); event.stopImmediatePropagation();
  addComposeAttachments(files).catch(error => toast(error.message, 'error'));
}, true);
document.getElementById('btn-compose-preview').addEventListener('click', openComposePreview);
document.querySelectorAll('[data-close-compose-preview]').forEach(button => button.addEventListener('click', closeComposePreview));
document.getElementById('compose-signature-select').addEventListener('change', event => { renderComposeSignature(event.target.value); queueDraftSave(); });
document.getElementById('btn-manage-signatures').addEventListener('click', openSignatureManager);
document.querySelectorAll('[data-close-signatures]').forEach(button => button.addEventListener('click', closeSignatureManager));
document.getElementById('btn-new-signature').addEventListener('click', () => editSignature(''));
document.getElementById('signature-list').addEventListener('click', event => { const button = event.target.closest('[data-signature-id]'); if (button) editSignature(button.dataset.signatureId); });
document.getElementById('btn-save-signature').addEventListener('click', () => saveSignature().catch(err => toast('保存签名失败：' + err.message, 'error')));
document.getElementById('btn-delete-signature').addEventListener('click', async () => {
  if (!editingSignatureId || !window.confirm('确定删除这套签名？')) return;
  const removed = editingSignatureId;
  signatureState = await api(`/api/mail/signatures/${encodeURIComponent(removed)}`, {method:'DELETE'});
  editingSignatureId = '';
  if (currentSignatureId === removed) renderComposeSignature('');
  renderSignatureManager(); renderSignatureSelect(); queueDraftSave();
  toast('签名已删除', 'success');
});
document.getElementById('btn-ai-generate-signature').addEventListener('click', event => generateSignatures(event.currentTarget));
document.getElementById('signature-ai-options').addEventListener('click', event => {
  const button = event.target.closest('[data-ai-signature]');
  if (!button) return;
  const item = event.currentTarget._options?.[Number(button.dataset.aiSignature)];
  if (!item) return;
  editingSignatureId = '';
  document.getElementById('signature-name').value = item.name;
  document.getElementById('signature-editor').innerHTML = item.html;
  document.getElementById('signature-make-default').checked = !signatureState.default_id;
  toast('已放入编辑区，确认后点击保存', 'success');
});
document.getElementById('compose-attachments-input').addEventListener('change', event => {
  addComposeAttachments(event.target.files).catch(e => toast('读取附件失败：' + e.message, 'error'));
  event.target.value = '';
});
document.getElementById('compose-attachments').addEventListener('click', async event => {
  const preview = event.target.closest('[data-preview-compose-attachment]');
  if (preview) {
    const session = draftSession, accountId = composeAccountId;
    const index = Number(preview.dataset.previewComposeAttachment), item = composeAttachments[index];
    if (session.busy || session.attachmentReads) return toast('请等待附件读取完成', 'warn');
    try {
      await saveCurrentDraft({force:true});
      if (session !== draftSession || session.canceled || composeAttachments[index] !== item) return;
      const link = document.createElement('a');
      link.href = mailboxResourceUrl(`/api/drafts/${session.id}/attachments/${index}`, accountId);
      link.download = item.filename || '附件';
      window.openAttachmentPreview(link);
    } catch (error) { toast('预览失败：' + error.message, 'error'); }
    return;
  }
  const button = event.target.closest('[data-remove-attachment]');
  if (!button) return;
  composeAttachments.splice(Number(button.dataset.removeAttachment), 1);
  renderComposeAttachments(); queueDraftSave();
});
document.getElementById('btn-discard-draft').addEventListener('click', async () => {
  const session = draftSession;
  if (session.busy || session.closing || session.switching || session.canceled) return;
  if ((session.id || draftHasContent(draftPayload())) && !window.confirm('舍弃这封邮件？已保存的本地草稿也会删除，无法撤销。')) return;
  const accountId = session.accountId || composeAccountId;
  session.canceled = true;
  clearDraftSaveTimers();
  try {
    await session.pending.catch(() => {});
    if (session.id) await api('/api/drafts/' + session.id, {accountId, method:'DELETE'});
    if (session === draftSession) { currentDraftId = null; hideCompose(); }
    await refreshDraftList(accountId);
  } catch (e) { session.canceled = false; toast('舍弃草稿失败：' + e.message, 'error'); }
});
async function submitComposeMail(payload, preflightConfirmed = false) {
  if (draftSession.attachmentReads) { toast('附件正在读取，请稍候再发送', 'warn'); return false; }
  if (draftSession.busy || draftSession.closing || draftSession.switching || draftSession.canceled) return false;
  let sent = false;
  payload.preflight_confirmed = preflightConfirmed;
  const btn = document.getElementById('btn-send-mail');
  const session = draftSession;
  const accountId = session.accountId || composeAccountId;
  const fingerprint = composePreflightFingerprint(payload);
  const saved = saveCurrentDraft({force:true});
  session.busy = true;
  clearDraftSaveTimers();
  setLoading(btn, true);
  try {
    await saved;
    await session.pending;
    if (session !== draftSession || session.canceled || composePreflightFingerprint() !== fingerprint) {
      throw new Error('保存期间邮件内容发生了变化，请重新检查后发送');
    }
    payload.id = session.id;
    session.sendToken ||= crypto.randomUUID();
    const result = await api('/api/mail/outbox', {accountId, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...payload, request_token:session.sendToken})});
    session.canceled = true;
    if (session === draftSession) { currentDraftId = null; clearComposePreflight(); hideCompose(); }
    [sentMessages, savedDrafts] = await Promise.all([api('/api/mail/sent'), api('/api/drafts')]); updateSidebar();
    toast('已加入发件箱，10 秒内可撤销发送', 'success');
    if (typeof showQueuedMail === 'function') showQueuedMail(result, accountId);
    sent = true;
  } catch (e) { toast(e.message, 'error'); }
  finally { session.busy = false; setLoading(btn, false); }
  return sent;
}

document.getElementById('btn-send-mail').addEventListener('click', async () => {
  if (draftSession.attachmentReads) return toast('附件正在读取，请稍候再发送', 'warn');
  if (draftSession.busy || draftSession.closing || draftSession.switching || draftSession.canceled) return;
  const payload = draftPayload();
  if (!payload.to_addr && !payload.cc_addr && !payload.bcc_addr) return toast('请填写收件人', 'warn');
  if (!composeMessageText()) return toast(composeContext.mode === 'forward' ? '请填写转发说明' : (['reply','reply_all'].includes(composeContext.mode) ? '请填写回复内容' : '请填写邮件正文'), 'warn');
  const btn = document.getElementById('btn-send-mail');
  setLoading(btn, true, '安全检查中…');
  const preflight = await runMailPreflight(payload).catch(err => { toast('发送前检查失败：' + err.message, 'error'); return null; });
  setLoading(btn, false);
  if (!preflight) return;
  if (composePreflightFingerprint() !== composePreflightFingerprint(payload)) {
    clearComposePreflight();
    toast('检查期间邮件内容发生了变化，请再次点击发送', 'warn');
    return;
  }
  if (preflight.issues.length) {
    const riskPanel = document.getElementById('compose-preflight');
    riskPanel.setAttribute('tabindex', '-1');
    riskPanel.focus({preventScroll:true});
    toast(`请先阅读并核对 ${preflight.issues.length} 项发送风险`, 'warn');
    return;
  }
  await submitComposeMail(payload, false);
});

document.getElementById('compose-preflight').addEventListener('change', event => {
  if (event.target.id === 'compose-preflight-ack') {
    event.currentTarget.querySelector('[data-preflight-send]').disabled = !event.target.checked;
  }
});
document.getElementById('compose-preflight').addEventListener('click', async event => {
  if (event.target.closest('[data-preflight-edit]')) {
    clearComposePreflight();
    composeMessageElement().focus();
    return;
  }
  const confirm = event.target.closest('[data-preflight-send]');
  if (!confirm || confirm.disabled || !composePreflightPending) return;
  if (composePreflightFingerprint() !== composePreflightPending.fingerprint) {
    clearComposePreflight();
    toast('邮件内容已有变化，请重新执行发送检查', 'warn');
    return;
  }
  const payload = {...composePreflightPending.payload};
  confirm.disabled = true;
  confirm.textContent = '正在发送…';
  const sent = await submitComposeMail(payload, true);
  if (!sent && document.body.classList.contains('compose-open')) {
    confirm.disabled = false;
    confirm.textContent = '确认发送';
  }
});
document.getElementById('btn-compose-ai').addEventListener('click', () => toggleComposeAiPanel());
document.getElementById('btn-close-compose-ai').addEventListener('click', () => toggleComposeAiPanel(false));
document.getElementById('compose-ai-instruction').addEventListener('input', refreshComposeAiContext);
document.querySelector('.compose-ai-context-options').addEventListener('change', refreshComposeAiContext);
document.querySelector('.compose-ai-quick-actions').addEventListener('click', event => {
  const button = event.target.closest('[data-ai-compose]');
  if (button) aiCompose(button.dataset.aiCompose, button);
});
document.getElementById('btn-ai-generate').addEventListener('click', event => {
  const operation = ['reply','reply_all'].includes(composeContext.mode) ? 'reply' : (composeContext.mode === 'forward' ? 'forward' : 'draft');
  aiCompose(operation, event.currentTarget);
});
document.getElementById('btn-ai-regenerate').addEventListener('click', event => {
  const operation = ['reply','reply_all'].includes(composeContext.mode) ? 'reply' : (composeContext.mode === 'forward' ? 'forward' : 'draft');
  aiCompose(operation, event.currentTarget);
});
document.getElementById('btn-ai-append').addEventListener('click', () => applyComposeAiSuggestion('append'));
document.getElementById('btn-ai-replace').addEventListener('click', () => applyComposeAiSuggestion('replace'));
document.querySelectorAll('.compose-toolbar [data-command]').forEach(btn => {
  btn.addEventListener('mousedown', event => { event.preventDefault(); rememberComposeSelection(); });
  btn.addEventListener('click', () => runComposeCommand(btn.dataset.command));
});
document.querySelectorAll('.compose-toolbar [data-format-command]').forEach(select => select.addEventListener('change', () => runComposeCommand(select.dataset.formatCommand, select.value)));
document.getElementById('compose-text-color').addEventListener('input', event => runComposeCommand('foreColor', event.target.value));
document.getElementById('compose-highlight-color').addEventListener('input', event => runComposeCommand('hiliteColor', event.target.value));
async function loadActionPolicy() {
  try {
    const policy = await api('/api/action_policy');
    document.getElementById('action-mode').value = policy.mode;
    document.querySelector('.policy-control')?.setAttribute('data-mode', policy.mode);
  } catch (e) {
    toast('加载处置策略失败：' + e.message, 'error');
  }
}

document.getElementById('action-mode').addEventListener('change', async (e) => {
  const mode = e.target.value;
  document.querySelector('.policy-control')?.setAttribute('data-mode', mode);
  try {
    await api('/api/action_policy?mode=' + encodeURIComponent(mode), { method: 'POST' });
    const labels = { observe: '仅观察', review: '人工确认', auto: '自动处置' };
    toast('处置模式已切换为：' + labels[mode], 'success');
  } catch (err) {
    toast('切换失败：' + err.message, 'error');
    loadActionPolicy();
  }
});

document.getElementById('btn-rollback-auto').addEventListener('click', async () => {
  if (!window.confirm('将恢复最近 10 封仍在隔离区或垃圾箱中的自动处置邮件，是否继续？')) return;
  try {
    const result = await api('/api/actions/rollback-recent?limit=10', { method: 'POST' });
    toast(`已回滚 ${result.restored} 封${result.failed ? `，失败 ${result.failed} 封` : ''}`);
    await Promise.all([loadData(), loadDashboard(_dashboardDays)]);
  } catch (e) {
    toast('回滚失败：' + e.message, 'error');
  }
});

let assistantAlertTimer = null;
const initialLoad = loadSystemConfig().then(async cfg => {
  if (!cfg.mail?.logged_in) {
    const overlay = document.getElementById('onboarding-overlay');
    document.getElementById('onboarding-host').value = cfg.mail?.host || '';
    document.getElementById('onboarding-port').value = cfg.mail?.port || 993;
    document.getElementById('onboarding-smtp-host').value = cfg.smtp?.host || '';
    document.getElementById('onboarding-smtp-port').value = cfg.smtp?.port || 465;
    const manageAccounts = document.getElementById('onboarding-manage-accounts');
    const savedCount = (cfg.accounts || []).length;
    manageAccounts.classList.toggle('hidden', savedCount === 0);
    manageAccounts.textContent = savedCount ? `管理已保存账号（${savedCount}）` : '管理已保存账号';
    overlay.classList.remove('hidden');
    window.mailOnboarding?.disconnected(cfg);
    return;
  }
  await Promise.all([loadData(), loadMailboxFolders(), loadActionPolicy(), loadAssistantAlerts(), loadSignatures()]);
  startMailboxAutoRefresh();
  window.mailOnboarding?.connected(false);
  api('/api/mail/send-capability').then(cap => { sendCapability = cap; }).catch(() => {});
  if (!assistantPollTimer) assistantPollTimer = setInterval(loadAssistantAlerts, 60000);
}).catch(() => {});

document.getElementById('onboarding-manage-accounts')?.addEventListener('click', () => {
  document.getElementById('onboarding-overlay').classList.add('hidden');
  showSystemView('account');
});

document.getElementById('onboarding-form').addEventListener('submit', async e => {
  e.preventDefault();
  const button = document.getElementById('onboarding-submit');
  const error = document.getElementById('onboarding-error');
  error.classList.add('hidden');
  button.disabled = true;
  button.querySelector('span').textContent = '正在验证邮箱…';
  const payload = {
    host: document.getElementById('onboarding-host').value.trim(),
    port: Number(document.getElementById('onboarding-port').value),
    user: document.getElementById('onboarding-user').value.trim(),
    password: document.getElementById('onboarding-password').value,
    ssl: true,
    verify_ssl: document.getElementById('onboarding-verify-ssl').checked,
    smtp_host: document.getElementById('onboarding-smtp-host').value.trim(),
    smtp_port: Number(document.getElementById('onboarding-smtp-port').value),
    smtp_ssl: document.getElementById('onboarding-smtp-ssl').checked,
    smtp_starttls: document.getElementById('onboarding-smtp-starttls').checked,
    smtp_verify_ssl: document.getElementById('onboarding-verify-ssl').checked,
  };
  try {
    const connectionResult = await api('/api/system/mail/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if (connectionResult.credential_warning) toast(connectionResult.credential_warning, 'warn');
    if (connectionResult.smtp_warning) toast(connectionResult.smtp_warning, 'warn');
    document.getElementById('onboarding-overlay').classList.add('hidden');
    await loadSystemConfig();
    await Promise.all([loadData(), loadMailboxFolders(), loadActionPolicy(), loadAssistantAlerts()]);
    startMailboxAutoRefresh();
    if (!assistantPollTimer) assistantPollTimer = setInterval(loadAssistantAlerts, 60000);
    startFetchMonitor();
    document.getElementById('onboarding-password').value = '';
    window.mailOnboarding?.connected(true);
  } catch (err) {
    error.textContent = err.message || '连接失败，请检查账号、授权码和服务器设置';
    error.classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = '连接邮箱';
  }
});

let providerLookupTimer;
async function discoverMailProvider(email, prefix) {
  if (!email.includes('@')) return;
  try {
    const profile = await api(`/api/system/mail/discover?email=${encodeURIComponent(email)}`);
    document.getElementById(`${prefix}-host`).value = profile.imap_host;
    document.getElementById(`${prefix}-port`).value = profile.imap_port;
    document.getElementById(`${prefix}-smtp-host`).value = profile.smtp_host;
    document.getElementById(`${prefix}-smtp-port`).value = profile.smtp_port;
    const smtpSsl = document.getElementById(`${prefix}-smtp-ssl`);
    const smtpStarttls = document.getElementById(`${prefix}-smtp-starttls`);
    if (smtpSsl) smtpSsl.checked = profile.smtp_ssl;
    if (smtpStarttls) smtpStarttls.checked = profile.smtp_starttls;
    const hint = document.getElementById(`${prefix}-provider-hint`);
    hint.textContent = profile.detected
      ? `已识别为 ${profile.provider} · 将同时验证收件与发件服务`
      : '未收录该服务商，已按域名推测服务器；连接失败时可展开高级设置修改';
    hint.classList.toggle('manual', !profile.detected);
  } catch (_) {}
}

['onboarding', 'mail'].forEach(prefix => {
  document.getElementById(`${prefix}-user`).addEventListener('input', event => {
    clearTimeout(providerLookupTimer);
    providerLookupTimer = setTimeout(() => discoverMailProvider(event.target.value.trim(), prefix), 260);
  });
});

// macOS 可强制常驻原生滚动槽；三栏改用不受系统设置影响的悬浮圆角指示器。
const MAIN_SCROLL_SELECTOR = '.sidebar, .email-list, .reading-pane';
const scrollIndicators = new WeakMap();
const scrollTimers = new WeakMap();

function ensureScrollIndicator(target) {
  let indicator = scrollIndicators.get(target);
  if (indicator) return indicator;
  indicator = document.createElement('span');
  indicator.className = 'mailai-scroll-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = '<i></i>';
  document.body.appendChild(indicator);
  scrollIndicators.set(target, indicator);
  return indicator;
}

function syncScrollIndicator(target) {
  const indicator = ensureScrollIndicator(target);
  const rect = target.getBoundingClientRect();
  const overflow = target.scrollHeight - target.clientHeight;
  const inset = window.innerWidth <= 760 ? 9 : 13;
  const trackHeight = Math.max(0, rect.height - inset * 2);
  if (overflow <= 1 || trackHeight < 34 || rect.width <= 0 || rect.height <= 0) {
    indicator.hidden = true;
    indicator.classList.remove('is-visible');
    return;
  }
  indicator.hidden = false;
  indicator.style.left = `${Math.round(rect.right - (window.innerWidth <= 760 ? 7 : 9))}px`;
  indicator.style.top = `${Math.round(rect.top + inset)}px`;
  indicator.style.height = `${Math.round(trackHeight)}px`;
  const thumb = indicator.firstElementChild;
  const thumbHeight = Math.min(trackHeight, Math.max(34, trackHeight * target.clientHeight / target.scrollHeight));
  const travel = trackHeight - thumbHeight;
  const offset = travel * Math.min(1, Math.max(0, target.scrollTop / overflow));
  thumb.style.height = `${Math.round(thumbHeight)}px`;
  thumb.style.transform = `translateY(${Math.round(offset)}px)`;
}

function showScrollIndicator(target) {
  syncScrollIndicator(target);
  const indicator = scrollIndicators.get(target);
  if (!indicator || indicator.hidden) return;
  indicator.classList.add('is-visible');
  clearTimeout(scrollTimers.get(target));
  scrollTimers.set(target, setTimeout(() => {
    indicator.classList.remove('is-visible');
    scrollTimers.delete(target);
  }, 520));
}

function initMainScrollIndicators() {
  const targets = [...document.querySelectorAll(MAIN_SCROLL_SELECTOR)];
  targets.forEach(target => {
    syncScrollIndicator(target);
    target.addEventListener('scroll', () => showScrollIndicator(target), {passive:true});
  });
  const syncAll = () => targets.forEach(syncScrollIndicator);
  window.addEventListener('resize', syncAll, {passive:true});
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(syncAll);
    targets.forEach(target => observer.observe(target));
  }
}

initMainScrollIndicators();

function hideAppPreloader() {
  const preloader = document.getElementById('app-preloader');
  if (!preloader || preloader.classList.contains('leaving')) return;
  preloader.classList.add('leaving');
  setTimeout(() => preloader.remove(), 460);
}

// ===== 三栏宽度拖拽与本地记忆 =====
const PANE_SIZE_KEY = 'mailai.workspace.paneSizes.v1';
const PANE_DEFAULTS = {sidebar: 226, list: 405};

function readPaneSizes() {
  try { return {...PANE_DEFAULTS, ...JSON.parse(localStorage.getItem(PANE_SIZE_KEY) || '{}')}; }
  catch (_) { return {...PANE_DEFAULTS}; }
}

function constrainPaneSizes(input) {
  const layout = document.querySelector('.layout');
  const total = layout?.clientWidth || window.innerWidth;
  const readingMin = Math.min(440, Math.max(360, total * .32));
  let sidebar = Math.max(180, Math.min(380, Number(input.sidebar) || PANE_DEFAULTS.sidebar));
  let list = Math.max(300, Math.min(720, Number(input.list) || PANE_DEFAULTS.list));
  const available = Math.max(480, total - 24 - readingMin);
  if (sidebar + list > available) list = Math.max(300, available - sidebar);
  if (sidebar + list > available) sidebar = Math.max(180, available - list);
  return {sidebar:Math.round(sidebar), list:Math.round(list)};
}

function applyPaneSizes(sizes, persist = false) {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  const value = constrainPaneSizes(sizes);
  layout.style.setProperty('--sidebar-width', value.sidebar + 'px');
  layout.style.setProperty('--list-width', value.list + 'px');
  document.querySelector('[data-resizer="sidebar"]')?.setAttribute('aria-valuenow', value.sidebar);
  document.querySelector('[data-resizer="list"]')?.setAttribute('aria-valuenow', value.list);
  if (persist) localStorage.setItem(PANE_SIZE_KEY, JSON.stringify(value));
  return value;
}

function initPaneResizers() {
  let sizes = applyPaneSizes(readPaneSizes());
  document.querySelectorAll('.pane-resizer').forEach(handle => {
    const kind = handle.dataset.resizer;
    handle.setAttribute('aria-valuemin', kind === 'sidebar' ? '180' : '300');
    handle.setAttribute('aria-valuemax', kind === 'sidebar' ? '380' : '720');
    handle.addEventListener('pointerdown', event => {
      if (window.innerWidth <= 1024) return;
      event.preventDefault();
      const startX = event.clientX;
      const start = {...sizes};
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging'); document.body.classList.add('pane-resizing');
      const move = moveEvent => {
        const delta = moveEvent.clientX - startX;
        sizes = applyPaneSizes({...start, [kind]:start[kind] + delta});
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.classList.remove('dragging'); document.body.classList.remove('pane-resizing');
        sizes = applyPaneSizes(sizes, true);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end, {once:true});
      handle.addEventListener('pointercancel', end, {once:true});
    });
    handle.addEventListener('dblclick', () => { sizes = applyPaneSizes(PANE_DEFAULTS, true); toast('已恢复默认栏宽', 'success'); });
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      sizes = applyPaneSizes({...sizes, [kind]:sizes[kind] + (event.key === 'ArrowRight' ? 16 : -16)}, true);
    });
  });
  window.addEventListener('resize', () => { sizes = applyPaneSizes(sizes); });
}

initPaneResizers();

Promise.all([
  initialLoad,
  new Promise(resolve => setTimeout(resolve, 650)),
]).then(hideAppPreloader);
// 网络异常时也必须允许用户进入界面查看错误提示。
setTimeout(hideAppPreloader, 6000);
setTimeout(() => {
  // Check on every application start so Settings can show the installed
  // version's release notes immediately after an upgrade.
  checkForAppUpdate(false);
}, 1800);
(async () => {
  try {
    const st = await api('/api/fetch_status');
    if (st.running) startFetchMonitor();
  } catch (e) {
    // ignore
  }
})();
