/* Workspace interaction layer: preferences, task feedback and mail actions. */
let undoOperations = [];
let operationRetry = null;
let preferencesAccount = '';
let preferencesLoadRevision = 0;
let preferencesSaving = false;
let taskPollActive = false;
let taskCenterRefreshRequested = null;
let taskCenterPollTimer = 0;
let taskCenterReminders = [];
let taskCenterLastFocus = null;
let taskCenterAccountId = '';
function taskCenterScope() {
  return document.getElementById('task-center')?.classList.contains('hidden')
    ? activeMailAccount()?.id : taskCenterAccountId || activeMailAccount()?.id;
}
function updateWorkspaceToolScope() {
  const account = activeMailAccount();
  window.mailaiTaskActivity?.scopeChanged();
  for (const [id, name] of [['btn-contacts',mailaiText('联系人')],['btn-attachments',mailaiText('附件')],['btn-todos',mailaiText('待办')],['btn-digest',mailaiText('日报')]]) {
    const button = document.getElementById(id);
    if (button) { mailaiBindUI(button, "title", () => (`${name} · ${account?.user || mailaiText('未选择邮箱')}`)); button.setAttribute('aria-label', button.title); }
  }
}
let latestUndoAction = null;
let undoInProgress = false;
const THEME_MODE_KEY = 'mailai.preferences.theme.v1';
const themeMediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)');

function savedThemeMode() {
  try {
    const value = localStorage.getItem(THEME_MODE_KEY);
    return ['light', 'dark', 'system'].includes(value) ? value : 'system';
  } catch (_) { return 'system'; }
}

function applyTheme(mode = savedThemeMode()) {
  const resolved = mode === 'system' ? (themeMediaQuery?.matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  document.dispatchEvent(new CustomEvent('mailai:themechange', {detail:{theme:resolved}}));
  const control = document.getElementById('theme-mode');
  if (control) control.value = mode;
  syncPreferenceChoices();
}

themeMediaQuery?.addEventListener?.('change', () => {
  if (savedThemeMode() === 'system') applyTheme('system');
});

function hideTaskNotice(host) {
  clearTimeout(host._dismissTimer);
  clearTimeout(host._hideTimer);
  host.classList.add('is-fading');
  host._hideTimer = setTimeout(() => {
    host.classList.add('hidden');
    host.classList.remove('is-fading');
  }, 360);
}

function taskNotice(message, actionText = '', action = null, dismissAfter = 0) {
  const host = document.getElementById('workspace-notice');
  clearTimeout(host._dismissTimer);
  clearTimeout(host._hideTimer);
  host.replaceChildren();
  const copy = document.createElement('span'); copy.textContent = message; host.append(copy);
  if (actionText) { const button = document.createElement('button'); button.textContent = actionText; button.onclick = action; host.append(button); }
  const close = document.createElement('button'); close.textContent = '×'; mailaiBindUI(close, "@aria-label", () => (mailaiText('关闭提示'))); close.onclick = () => hideTaskNotice(host); host.append(close);
  host.classList.remove('is-fading');
  host.classList.remove('hidden');
  if (dismissAfter > 0) host._dismissTimer = setTimeout(() => hideTaskNotice(host), dismissAfter);
}

function describeMailUndo(path, body, result, accountId) {
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch (_) {}
  const query = new URLSearchParams(path.split('?')[1] || '');
  const action = payload.action || path.split('?')[0].split('/').at(-1);
  const value = payload.value !== false && query.get('value') !== 'false';
  const label = {read:value ? mailaiText('标为已读') : mailaiText('标为未读'), star:value ? mailaiText('添加星标') : mailaiText('取消星标'),
    get trash() { return mailaiText('移入已删除'); }, move:mailaiTemplate`移动到“${payload.target || result.folder || query.get('target') || mailaiText('目标文件夹')}”`}[action] || mailaiText('邮件操作');
  const account = typeof _systemConfig !== 'undefined' ? _systemConfig?.accounts?.find(item => item.id === accountId) : null;
  return {label, count:Math.max(0, (result.completed ?? 1) - (result.reconciled || 0)), accountLabel:account?.user || accountId || mailaiText('当前邮箱')};
}

function refreshUndoAction() {
  undoOperations = undoOperations.filter(operation => operation.items.some(item => Date.now() - item.at < 120000));
  const latest = undoOperations.at(-1);
  latestUndoAction = latest ? () => performMailUndo(latest) : null;
}

async function performMailUndo(operation) {
  if (undoInProgress) return;
  // A notice always refers to its own operation, even after another one arrives.
  if (!undoOperations.includes(operation)) return;
  const pending = operation.items.filter(item => Date.now() - item.at < 120000);
  const expired = pending.length !== operation.items.length;
  if (!pending.length) {
    refreshUndoAction();
    taskNotice(mailaiText('这次操作的撤销时间已超过 2 分钟'), '', null, 3500);
    return;
  }
  undoInProgress = true;
  let failed = 0;
  const retry = [];
  try {
    for (const item of [...pending].reverse()) {
      try {
        const result = await api(`/api/mail/undo/${item.token}`, {method:'POST', accountId:operation.accountId});
        failed += result.failed.length;
        if (result.retry_token) retry.unshift({token:result.retry_token, at:Date.now()});
      } catch (_) { failed++; retry.unshift(item); }
    }
    const hasNewer = undoOperations.at(-1) !== operation;
    operation.items = retry;
    refreshUndoAction();
    if (!hasNewer) {
      const message = failed ? mailaiTemplate`${operation.description}：${failed} 项未能撤销，请核对邮件状态`
        : expired ? mailaiTemplate`${operation.description}：已撤销有效部分，部分记录已过期` : mailaiTemplate`已撤销：${operation.description}`;
      const next = undoOperations.at(-1);
      const retryAction = retry.length ? () => performMailUndo(operation) : null;
      taskNotice(message, retryAction ? mailaiText('重试本次撤销') : next ? mailaiTemplate`撤销上一步：${next.description}` : '',
        retryAction || latestUndoAction, failed || expired ? 0 : 6500);
    }
    // Refresh failure must not requeue an already completed undo.
    try { await loadData(); }
    catch (_) { if (typeof toast === 'function') toast(mailaiText('撤销已处理，邮件列表暂时未刷新'), 'warn'); }
  } finally { undoInProgress = false; }
}

function offerUndo(tokens, accountId, details = {}) {
  if (!tokens.length) return;
  const description = `${details.accountLabel || accountId || mailaiText('当前邮箱')} · ${details.label || mailaiText('邮件操作')}${details.count ? mailaiTemplate` ${details.count} 封` : ''}`;
  const operation = {accountId, description, items:tokens.map(item => typeof item === 'string' ? {token:item, at:Date.now()} : item)};
  undoOperations.push(operation);
  refreshUndoAction();
  if (!undoOperations.includes(operation)) return;
  const remaining = Math.ceil(Math.min(...operation.items.map(item => item.at + 120000 - Date.now())) / 1000);
  const expiry = remaining > 0 ? mailaiTemplate`约 ${remaining} 秒内可撤销` : mailaiText('部分记录已过期，可撤销有效部分');
  taskNotice(`${description}，${expiry}（⌘Z / Ctrl+Z）`, mailaiText('撤销本次'), () => performMailUndo(operation), 6500);
}

document.addEventListener('keydown', event => {
  const target = event.target;
  const editing = target?.matches?.('input, textarea, select, [contenteditable="true"]') || target?.closest?.('[contenteditable="true"]');
  if (!editing && (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && latestUndoAction) {
    event.preventDefault();
    latestUndoAction();
  }
});

function showOperationFailures(items, retry) {
  operationRetry = retry;
  taskNotice(mailaiTemplate`${items.length} 封未完成：${items.slice(0, 2).map(item => mailaiSystemMessage(item.error)).join('；')}`, mailaiText('仅重试失败项'), retry);
}

async function refreshAfterQueuedSend(token, accountId) {
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    try {
      const rows = await api('/api/mail/outbox', {accountId});
      const row = rows.find(item => item.token === token);
      if (!row || ['queued','sending'].includes(row.status)) continue;
      if (accountId === activeMailAccount()?.id) await loadData();
      return;
    } catch (_) { return; }
  }
}

function showQueuedMail(result, accountId) {
  window.mailaiTaskActivity?.refresh();
  if (result.status !== 'queued') {
    const label = {get sent() { return mailaiText('这封邮件已发送，请勿重复发送'); },get sending() { return mailaiText('这封邮件正在发送'); },get canceled() { return mailaiText('这封邮件已撤销，内容保留在草稿箱'); },get failed() { return mailaiText('发送失败，内容保留在草稿箱'); },get unknown() { return mailaiText('发送结果待确认，请先核对已发送邮件'); }};
    taskNotice(label[result.status] || mailaiText('请查看发件箱状态'), mailaiText('查看发件箱'), openTaskCenter); return;
  }
  if (!result.scheduled) refreshAfterQueuedSend(result.token, accountId);
  taskNotice(result.scheduled ? mailaiTemplate`邮件已安排 ${new Date(result.due_at).toLocaleString(currentI18nLanguage())} 发送；可在发件箱中编辑或调整时间` : mailaiText('邮件已加入发件箱，发送前可撤销'), mailaiText('撤销发送'), async () => {
    try { await api(`/api/mail/outbox/${result.token}/cancel`, {method:'POST', accountId}); window.mailaiTaskActivity?.refresh(); taskNotice(mailaiText('已撤销发送，内容保留在草稿箱'), '', null, 3500); }
    catch (error) { taskNotice(mailaiSystemMessage(error.message), mailaiText('查看发件箱'), openTaskCenter); }
  }, 6500);
}

async function openTaskCenter() {
  window.closeAssistant?.();
  taskCenterLastFocus = document.activeElement;
  taskCenterAccountId = activeMailAccount()?.id || '';
  const selector = document.getElementById('task-center-account');
  selector.innerHTML = (_systemConfig?.accounts || []).map(account => `<option value="${esc(account.id)}">${esc(account.user)}</option>`).join('');
  selector.value = taskCenterAccountId;
  const panel = document.getElementById('task-center');
  const host = document.getElementById('task-center-list');
  if (host.dataset.accountId !== (activeMailAccount()?.id || '')) {
    host.innerHTML = "<div class=\"task-loading\"><i></i><span><span data-i18n=\"ui.801012d91506\">正在读取任务状态…</span></span></div>";
  }
  panel.classList.remove('hidden');
  document.getElementById('task-center-backdrop').classList.remove('hidden');
  document.getElementById('btn-task-center').setAttribute('aria-expanded', 'true');
  window.mailaiTaskActivity?.scopeChanged();
  panel.querySelector('button').focus();
  await refreshTaskCenter();
}

function closeTaskCenter() {
  clearTimeout(taskCenterPollTimer); taskCenterPollTimer = 0;
  document.getElementById('task-center').classList.add('hidden');
  document.getElementById('task-center-backdrop').classList.add('hidden');
  document.getElementById('btn-task-center').setAttribute('aria-expanded', 'false');
  window.mailaiTaskActivity?.scopeChanged();
  (taskCenterLastFocus?.isConnected ? taskCenterLastFocus : document.getElementById('btn-task-center'))?.focus();
}

function scheduleTaskCenterRefresh(enabled) {
  clearTimeout(taskCenterPollTimer); taskCenterPollTimer = 0;
  if (!enabled || document.hidden || (window.mailaiEnergy && !window.mailaiEnergy.active()) || document.getElementById('task-center').classList.contains('hidden')) return;
  taskCenterPollTimer = setTimeout(() => refreshTaskCenter({lightweight:true}), 2500);
}

function actionableOutboxRows(rows = []) {
  const seenDrafts = new Set();
  return rows.filter(row => {
    if (row.status === 'unknown') return true;
    if (row.draft_id) {
      const key = String(row.draft_id);
      if (seenDrafts.has(key)) return false;
      seenDrafts.add(key);
    }
    return ['queued','sending','failed','unknown'].includes(row.status);
  });
}

async function refreshTaskCenter({lightweight = false} = {}) {
  if (document.getElementById('task-center')?.classList.contains?.('hidden') || document.hidden) return;
  if (taskPollActive) {
    // Keep explicit refreshes even when the in-flight response has no live jobs.
    // A full user refresh takes precedence over a background lightweight one.
    taskCenterRefreshRequested = {lightweight: lightweight && (taskCenterRefreshRequested?.lightweight ?? true)};
    return;
  }
  taskPollActive = true;
  const accountId = taskCenterScope();
  const host = document.getElementById('task-center-list');
  try {
    const useCachedReminders = lightweight && host.dataset.accountId === accountId && host.dataset.partial !== '1';
    const requests = [
      [mailaiText('发件箱'), () => api('/api/mail/outbox', {accountId}), []],
      [mailaiText('邮箱同步'), () => api('/api/fetch_status', {accountId}), {}],
      [mailaiText('稍后提醒'), () => useCachedReminders ? taskCenterReminders : api('/api/reminders', {accountId}), []],
      [mailaiText('到期提醒'), () => useCachedReminders ? [] : api('/api/reminders/all', {accountId}), []],
      [mailaiText('删除同步'), () => api('/api/mail/action-sync' + (window.mailaiShowPausedSync ? '?include_paused=true' : ''), {accountId}), {rows:[],total:0}],
      [mailaiText('已删除邮件清理'), () => api('/api/trash/purge/status', {accountId}), {}],
    ];
    const results = await Promise.allSettled(requests.map(([, read]) => Promise.resolve().then(read)));
    const errors = results.flatMap((result, index) => result.status === 'rejected' ? [requests[index][0]] : []);
    const [rows, sync, reminders, allReminders, actions, purge] = results.map((result, index) => result.status === 'fulfilled' ? result.value : requests[index][2]);
    actions.rows = Array.isArray(actions.rows) ? actions.rows : [];
    rows.forEach(row => { try { row.error = row.error || JSON.parse(row.result || '{}').warning || ''; } catch (_) {} });
    if (accountId !== taskCenterScope()) return;
    taskCenterReminders = reminders;
    host.dataset.accountId = accountId || '';
    const labels = {get queued() { return mailaiText('等待发送'); }, get sending() { return mailaiText('发送中'); }, get sent() { return mailaiText('已发送'); }, get failed() { return mailaiText('发送失败'); }, get unknown() { return mailaiText('发送结果待确认'); }, get canceled() { return mailaiText('已撤销'); }};
    const visibleRows = actionableOutboxRows(rows);
    const showSync = Boolean(sync.running || sync.error || sync.canceled || sync.resumable);
    const syncRetryPath = ['fetch_all','sync_folders','sync_folder'].includes(sync.operation) ? '/api/fetch_all'
      : sync.operation === 'fetch_more' ? '/api/fetch_more' : '/api/poll';
    const syncBlock = showSync ? `<section class="task-section"><h3>${sync.running ? mailaiText('进行中的任务') : mailaiText('需要处理')} <span>1</span></h3><article class="task-row ${mailaiSystemMessage(sync.error) || sync.resumable ? 'needs-attention' : ''}"><div class="task-row-main"><b><span data-i18n="ui.4da9233eb5da">邮箱同步</span></b><span class="task-status ${sync.running ? 'running' : 'warning'}">${sync.running ? mailaiText('进行中') : mailaiText('需处理')}</span></div><small>${esc(mailaiSystemMessage(sync.message) || (sync.running ? mailaiText('正在同步…') : mailaiText('同步已中断')))}${mailaiSystemMessage(sync.error) ? `<br>${esc(mailaiSystemMessage(sync.error))}` : ''}</small>${!sync.running ? `<div class="task-row-actions"><button class="primary" data-sync-retry="${syncRetryPath}"><span data-i18n="ui.4a7af23b6505">重新同步</span></button></div>` : ''}</article></section>` : '';
    const outboxBlock = visibleRows.length ? `<section class="task-section"><h3><span data-i18n="ui.02d55e8b9e34">发件箱</span> <span>${visibleRows.length}</span></h3>${visibleRows.map(row => `<article class="task-row ${['failed','unknown'].includes(row.status) ? 'needs-attention' : ''}" data-outbox-token="${esc(row.token)}"><div class="task-row-main"><b>${esc(row.subject || mailaiText('无主题'))}</b><span class="task-status status-${esc(row.status)}">${esc(labels[row.status] || row.status)}</span></div><small>${esc(row.to_addr || '')}${row.status === 'queued' ? `<br><span data-i18n="ui.d05a31c6bd88">计划发送：${esc(new Date(row.due_at).toLocaleString(currentI18nLanguage()))}</span>` : ''}${mailaiSystemMessage(row.error) ? ` · ${esc(mailaiSystemMessage(row.error))}` : ''}${row.status === 'unknown' ? "<br><span data-i18n=\"ui.025deda378be\">请核对服务器已发送邮件，避免重复发送。</span>" : ''}</small><div class="task-row-actions">${row.status === 'queued' ? `<button data-edit-queue="${esc(row.token)}"><span data-i18n="ui.51726c4a26ab">编辑邮件</span></button><button data-time-queue="${esc(row.token)}"><span data-i18n="ui.fd094431c8ca">调整时间</span></button><button data-cancel-queue="${esc(row.token)}"><span data-i18n="ui.554bfa5fa81c">取消发送</span></button>` : ''}${row.status === 'failed' && row.draft_id ? `<button class="primary" data-outbox-draft="${esc(row.draft_id)}"><span data-i18n="ui.9a2717984f6e">编辑草稿后重试</span></button>` : ''}</div></article>`).join('')}</section>` : '';
    const reminderBlock = reminders.length ? `<section class="task-section"><h3><span data-i18n="ui.879d8543c3f3">稍后提醒</span> <span>${reminders.length}</span></h3>${reminders.map(item => `<article class="task-row"><div class="task-row-main"><b>${esc(item.subject)}</b><span class="task-status">${esc(fmtDate(item.at))}</span></div><small><span data-i18n="ui.8aa2aaf9660e">到期后提醒你处理这封邮件</span></small><div class="task-row-actions"><button class="primary" data-reminder-open="${item.email_id}"><span data-i18n="ui.ac711aa9178c">查看邮件</span></button><button data-reminder-dismiss="${item.email_id}" data-task-reminder="${item.todo_id || ''}"><span data-i18n="ui.56f252b08c5a">关闭提醒</span></button></div></article>`).join('')}</section>` : '';
    const purgeAttention = Boolean(purge.unacknowledged || purge.cleanup_pending);
    const purgeBlock = purge.pending || purgeAttention ? `<section class="task-section"><h3><span data-i18n="ui.d6fb20548442">已删除邮件清理</span></h3><article class="task-row"><div class="task-row-main"><b><span data-i18n="ui.955433eb5cec">本地邮件已移除</span></b><span class="task-status">${purge.pending ? mailaiText('远端待同步') : mailaiText('仅本地完成')}</span></div><small><span data-i18n="ui.e7dca6979cc1">${purge.pending ? mailaiTemplate`${Number(purge.pending)} 封等待服务器删除，联网后自动退避重试。` : ''}${purge.unacknowledged ? mailaiTemplate`${Number(purge.unacknowledged)} 封无法安全确认远端删除，服务器可能仍保留；可在网页邮箱核对。` : ''}${purge.cleanup_pending ? mailaiTemplate`${Number(purge.cleanup_pending)} 个原文文件待清理，将在后台重试。` : ''}不影响本地邮件查看、搜索与写信。</span></small>${purge.unacknowledged ? `<div class="task-row-actions"><button data-purge-ack="${esc(JSON.stringify(purge.notice_ids || []))}"><span data-i18n="ui.2fd7bd21a2f6">已知晓</span></button></div>` : ''} </article></section>` : '';
    const unavailableBlock = errors.length ? `<div class="task-load-error task-partial-error" role="status"><b><span data-i18n="ui.3234ff9269f3">部分状态暂时无法读取</span></b><span>${esc(errors.join('、'))}<span data-i18n="ui.d1adc449f9bf">未能加载，请重试确认。已加载的事项仍可处理。</span></span><button data-task-refresh><span data-i18n="ui.7bdd5ce1e298">重新加载</span></button></div>` : '';
    const actionBlock = actions.total || actions.paused_count ? `<section class="task-section"><h3><span data-i18n="ui.06be274af039">删除同步</span> <span>${Number(actions.total)}</span></h3>${actions.paused_count ? `<button class="sync-paused-toggle" data-sync-paused-toggle aria-pressed="${!!window.mailaiShowPausedSync}">${window.mailaiShowPausedSync ? mailaiText('收起已暂停') : mailaiText('查看已暂停')}（${Number(actions.paused_count)}）</button>` : ''}${actions.rows.map(row => `<article class="task-row"><div class="task-row-main"><b>${esc(row.subject || mailaiText('无主题'))}</b><span class="task-status ${row.pending_error && !row.paused ? 'warning' : ''}">${row.paused ? mailaiText('已暂停') : row.pending_error ? mailaiText('同步待处理') : mailaiText('等待服务器同步')}</span></div><small>${row.paused ? mailaiText('已停止自动重试，本地仍保持删除状态。服务器端是否删除尚未确认，可核对网页邮箱后恢复同步。') : row.pending_error ? mailaiText('已在本地删除。后台最多重试两次，仍未成功就自动结束，不影响本地使用。') : mailaiText('本地已移除，服务器操作尚未完成。')} </small>${row.pending_error ? `<details class="sync-error-details"><summary><span data-i18n="ui.c776f5b86412">查看失败详情 · 已尝试 ${Number(row.pending_attempts || 0)} 次</span></summary><small>${esc(row.pending_error)}</small></details>` : ''}${row.pending_error || row.paused ? `<div class="task-row-actions"><button data-action-sync-retry="${row.id}">${row.paused ? mailaiText('恢复同步') : mailaiText('重新核对并重试')}</button>${!row.paused ? `<button data-action-sync-pause="${row.id}"><span data-i18n="ui.052e30e39429">暂停同步</span></button>` : ''}</div>` : ''}</article>`).join('')}</section>` : '';

    const content = unavailableBlock + syncBlock + actionBlock + purgeBlock + outboxBlock + reminderBlock;
    host.dataset.partial = errors.length ? '1' : '0';
    document.getElementById('task-center').classList.toggle('is-empty', !content);
    const attentionCount = visibleRows.filter(row => ['failed','unknown'].includes(row.status)).length + (showSync && !sync.running ? 1 : 0) + (purgeAttention ? 1 : 0) + actions.rows.filter(row => row.pending_error && !row.paused).length;
    const activeCount = visibleRows.filter(row => ['queued','sending'].includes(row.status)).length + (sync.running ? 1 : 0) + (purge.pending ? 1 : 0) + (actions.rows.some(row => !row.paused && !row.pending_error) ? 1 : 0);
    host.dataset.live = activeCount || actions.rows.some(row => !row.paused) ? '1' : '0';
    host.innerHTML = (content ? `<div class="task-overview"><span><span data-i18n="ui.3b0ab91f6fca">需要你关注的事项</span></span><div class="task-overview-counts">${attentionCount ? `<span class="attention"><span data-i18n="ui.2f107a978338">${attentionCount} 项需处理</span></span>` : ''}${activeCount ? `<span><span data-i18n="ui.03e4c949512a">${activeCount} 项进行中</span></span>` : ''}${reminders.length ? `<span><span data-i18n="ui.8d64726be90c">${reminders.length} 项提醒</span></span>` : ''}${errors.length ? "<span class=\"attention\"><span data-i18n=\"ui.ea1b1f517e26\">状态未完整</span></span>" : ''}</div></div>${content}` : `<div class="task-empty"><span class="task-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg></span><div><b><span data-i18n="ui.6d335bd93c50">目前没有待处理事项</span></b><span><span data-i18n="ui.d4584d380fdd">发送中和异常邮件会显示在这里。</span></span></div><button type="button" data-task-open-sent><span data-i18n="ui.c259135be1d3">查看已发送邮件</span> <span aria-hidden="true">↗</span></button></div>`);
    for (const row of visibleRows.filter(row => row.status === 'unknown')) {
      const article = [...host.querySelectorAll('[data-outbox-token]')].find(item => item.dataset.outboxToken === row.token);
      if (!article) continue;
      const actions = article.querySelector('.task-row-actions');
      for (const delivered of [true, false]) {
        const button = document.createElement('button'); mailaiBindUI(button, "textContent", () => (delivered ? mailaiText('确认已送达') : mailaiText('确认未送达')));
        if (!delivered) button.className = 'primary';
        button.onclick = async () => {
          if (!confirm(delivered ? mailaiText('已核对服务器或收件人，确认这封邮件已送达？') : mailaiText('已核对服务器或收件人，确认未送达？确认后才允许从草稿重新发送。'))) return;
          try { await api(`/api/mail/outbox/${row.token}/resolve?delivered=${delivered}`, {accountId, method:'POST'}); refreshTaskCenter(); }
          catch (error) { toast(mailaiSystemMessage(error.message), 'error'); }
        }; actions.append(button);
      }
    }
    const taskButton = document.getElementById('btn-task-center');
    const taskCount = taskButton.querySelector('[data-task-count]');
    const pending = attentionCount + activeCount;
    if (taskCount) { taskCount.textContent = pending; taskCount.hidden = !pending; }
    mailaiBindUI(taskButton, "title", () => (mailaiTemplate`任务与发件箱${attentionCount ? mailaiTemplate` · ${attentionCount} 项需处理` : activeCount ? mailaiTemplate` · ${activeCount} 项进行中` : errors.length ? mailaiText(' · 状态待确认') : ''}`));
    window.mailaiTaskActivity?.update(accountId, {active:activeCount, attention:attentionCount, unknown:Boolean(errors.length)});

    const freshDue = allReminders.filter(item => new Date(item.at).getTime() <= Date.now()).filter(item => {
      const key=`reminder:${item.account_id}:${item.todo_id || item.email_id}:${item.at}`;
      if(sessionStorage.getItem(key))return false;
      sessionStorage.setItem(key,'1');return true;
    });
    if(freshDue.length)taskNotice(mailaiTemplate`${freshDue.length} 项待办已到提醒时间`, mailaiText('查看提醒'),()=>window.mailaiOpenTaskReminder(),8000);

  } catch (error) { if (accountId !== taskCenterScope()) return; host.dataset.live = '0'; host.innerHTML = `<div class="task-load-error"><b><span data-i18n="ui.643dd66e3037">状态暂时无法更新</span></b><span>${esc(mailaiSystemMessage(error.message))}</span><button data-task-refresh><span data-i18n="ui.7bdd5ce1e298">重新加载</span></button></div>`; }
  finally {
    taskPollActive = false;
    const requested = taskCenterRefreshRequested;
    taskCenterRefreshRequested = null;
    if (requested) {
      clearTimeout(taskCenterPollTimer);
      taskCenterPollTimer = setTimeout(() => refreshTaskCenter(requested), 0);
    } else scheduleTaskCenterRefresh(host.dataset.live === '1');
  }
}

function updateFilterChips() {
  const labels = {workflow:window.mailaiWorkflowFilterLabel?.() || '', unread:currentFilter.unread ? mailaiText('未读邮件') : '', days:currentFilter.days !== 9999 ? mailaiTemplate`近 ${currentFilter.days} 天` : '', priority:currentFilter.priority ? mailaiTemplate`${currentFilter.priority}重要程度` : '', domain:currentFilter.domain, attachments:currentFilter.attachments ? mailaiText('含附件') : '', search:currentFilter.search, category:currentFilter.category, verdict:currentFilter.verdict ? ({get clean() { return mailaiText('正常'); }, get suspicious() { return mailaiText('可疑'); }, get phishing() { return mailaiText('高风险'); }})[currentFilter.verdict] : ''};
  document.getElementById('filter-chips').innerHTML = Object.entries(labels).filter(([,value]) => value).map(([key,value]) => `<button type="button" data-remove-filter="${key}" title="${esc(value)}" aria-label="移除筛选：${esc(value)}" data-i18n-aria="ui.f398b052d41d"><span class="filter-chip-label">${esc(value)}</span><span class="filter-chip-close" aria-hidden="true">×</span></button>`).join('');
}

let semanticPollTimer = null;
let semanticViewRevision = 0;

function renderSemanticProgress(stats) {
  const wrap = document.getElementById('semantic-progress');
  const status = document.getElementById('semantic-status');
  if (!wrap || !status) return false;
  const p = stats?.progress || {};
  const reindex = document.getElementById('semantic-reindex');
  if (reindex) reindex.disabled = !!p.running;
  if (!p.running) { wrap.classList.add('hidden'); return false; }
  wrap.classList.remove('hidden');
  const fill = wrap.querySelector('i');
  if (p.phase === 'index' && p.total) {
    wrap.classList.add('determinate');
    fill.style.width = `${Math.round(100 * p.done / p.total)}%`;
    mailaiBindUI(status, "textContent", () => ((mailaiT('semantic.progress') || '正在更新索引 {done}/{total}…').replace('{done}', p.done).replace('{total}', p.total)));
  } else if (p.phase === 'queued') {
    mailaiBindUI(status, "textContent", () => (mailaiT('semantic.queued') || '等待后台更新，邮件可正常使用'));
    wrap.classList.remove('determinate');
    fill.style.width = '';
  } else {
    // 首个批次返回前都在下载/加载模型，无法预估进度，用滚动条示意
    wrap.classList.remove('determinate');
    fill.style.width = '';
    mailaiBindUI(status, "textContent", () => (mailaiT('semantic.downloading') || '正在下载模型（约 100MB，仅首次）…'));
  }
  return true;
}

function pollSemanticProgress() {
  clearInterval(semanticPollTimer);
  const accountId = activeMailAccount()?.id;
  const revision = semanticViewRevision;
  let pending = false;
  semanticPollTimer = setInterval(async () => {
    if (!accountId || accountId !== activeMailAccount()?.id || revision !== semanticViewRevision) return;
    if (pending) return;
    pending = true;
    try {
      const stats = await api('/api/assistant/semantic', {accountId});
      if (accountId !== activeMailAccount()?.id || revision !== semanticViewRevision) return;
      if (!renderSemanticProgress(stats)) {
        clearInterval(semanticPollTimer);
        loadSemanticStatus();
      }
    } catch (_) { /* 状态轮询失败不影响重建本身 */ }
    finally { pending = false; }
  }, 800);
}

function stopSemanticProgress() {
  ++semanticViewRevision;
  clearInterval(semanticPollTimer);
  semanticPollTimer = null;
  document.getElementById('semantic-progress')?.classList.add('hidden');
}

async function loadSemanticStatus() {
  const revision = ++semanticViewRevision;
  const status = document.getElementById('semantic-status');
  const reindex = document.getElementById('semantic-reindex');
  const toggle = document.getElementById('semantic-enabled');
  if (!status || !reindex || !toggle) return;
  const accountId = activeMailAccount()?.id;
  if (!accountId) {
    mailaiBindUI(status, "textContent", () => (mailaiT('semantic.needAccount') || '添加邮箱后即可启用'));
    toggle.checked = false;
    reindex.classList.add('hidden');
    return;
  }
  try {
    const [prefs, stats] = await Promise.all([
      api('/api/preferences', {accountId}),
      api('/api/assistant/semantic', {accountId}),
    ]);
    if (revision !== semanticViewRevision || accountId !== activeMailAccount()?.id) return;
    if (!stats.deps_available) {
      // 依赖缺失时禁止打开开关，避免"开了但静默空转"
      toggle.checked = false;
      toggle.disabled = true;
      mailaiBindUI(toggle.closest('label'), "@title", () => (mailaiT('semantic.noDeps') || '未安装可选依赖（requirements-semantic.txt）'));
      mailaiBindUI(status, "textContent", () => (mailaiT('semantic.noDeps') || '未安装可选依赖（requirements-semantic.txt）'));
      reindex.classList.add('hidden');
      return;
    }
    toggle.disabled = false;
    toggle.closest('label')?.removeAttribute('title');
    toggle.checked = !!prefs.semantic_enabled;
    mailaiBindUI(status, "textContent", () => (stats.indexed
      ? (mailaiT('semantic.indexed') || '已索引 {n} 封邮件').replace('{n}', stats.indexed) +
        (stats.last_indexed_at ? ` · ${String(stats.last_indexed_at).slice(0, 16)}` : '')
      : (mailaiT('semantic.notIndexed') || '尚未建立索引')));
    if (stats.progress?.error) mailaiBindUI(status, "textContent", () => (mailaiT('semantic.indexFailed') || '索引更新未完成，可重试；关键词搜索仍可使用'));
    reindex.classList.toggle('hidden', !stats.enabled);
    // 重建进行中（例如刚触发后切换了页签再回来）时恢复进度条与轮询
    if (renderSemanticProgress(stats)) pollSemanticProgress();
  } catch (_) {
    if (revision !== semanticViewRevision || accountId !== activeMailAccount()?.id) return;
    mailaiBindUI(status, "textContent", () => (mailaiT('semantic.error') || '暂时无法读取状态'));
  }
}

async function loadWorkspacePreferences() {
  loadSemanticStatus();
  if (preferencesSaving) return;
  const accountId = activeMailAccount()?.id;
  const revision = ++preferencesLoadRevision;
  const options = document.getElementById('notification-options');
  const status = document.getElementById('notification-save-status');
  options.disabled = true;
  mailaiBindUI(document.getElementById('notification-account'), "textContent", () => (activeMailAccount()?.user || mailaiText('尚未连接邮箱')));
  document.getElementById('notification-account').title = activeMailAccount()?.user || '';
  document.getElementById('notification-retry-load').classList.add('hidden');
  if (!accountId) { mailaiBindUI(status, "textContent", () => (mailaiText('添加邮箱后即可设置提醒'))); syncPreferenceChoices(); return; }
  mailaiBindUI(status, "textContent", () => (mailaiText('正在读取设置…')));
  try {
    const prefs = await api('/api/preferences', {accountId});
    if (revision !== preferencesLoadRevision || accountId !== activeMailAccount()?.id) return;
    preferencesAccount = accountId;
    document.getElementById('notification-preference').value = prefs.notifications;
    options.disabled = false;
    mailaiBindUI(status, "textContent", () => (mailaiText('已保存')));
    syncPreferenceChoices();
  } catch (_) {
    if (revision !== preferencesLoadRevision || accountId !== activeMailAccount()?.id) return;
    mailaiBindUI(status, "textContent", () => (mailaiText('暂时无法读取设置，请重试')));
    document.getElementById('notification-retry-load').classList.remove('hidden');
  }
}

function syncPreferenceChoices() {
  for (const [name,id] of [['theme-mode-choice','theme-mode'],['workspace-density-choice','workspace-density'],['font-size-choice','font-size'],['notification-mode','notification-preference'],['interface-language-choice','interface-language']]) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => { input.checked = input.value === document.getElementById(id).value; });
  }
}

function openAssistantForEmail(row) {
  const ids = [Number(row.id)];
  const scopeKey = JSON.stringify([activeMailAccount()?.id, 'selected', ids]);
  // An explicit mail entry starts a new context; reopening the same one keeps
  // its conversation. Invalidate any pending history restore before opening.
  if (assistantScopeKey !== scopeKey) resetAssistantConversation({focus:false});
  assistantHistoryLoaded = true;
  assistantPinnedScope = ids;
  assistantScopeKey = scopeKey;
  document.getElementById('assistant-scope').value = 'selected';
  updateAssistantScopeControl();
  window.showSecretaryChat?.();
  openAssistant();
}

function addReadingActions(force = false) {
  const host = document.querySelector('.reading-header .reading-actions');
  if (!host) return;
  if (host.querySelector('.reading-work-actions')) {
    if (!force) return;
    host.querySelector('.reading-work-actions')?.remove();
    host.querySelector('[data-reading-action="remind"]')?.remove();
    host.querySelectorAll('[data-reading-action="summary"],[data-reading-action="image"],[data-reading-action="ask"]').forEach(node => node.remove());
  }
  const div = document.createElement('div'); div.className = 'reading-work-actions';
  const icon = paths => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths}"/></svg>`;
  div.innerHTML = `<button type="button" data-reading-action="favorite" aria-pressed="${Boolean(selectedEmailDetail?.is_favorite)}">${icon('m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z')}<span data-action-label>${selectedEmailDetail?.is_favorite ? (mailaiT('read.favorited') || '已收藏') : (mailaiT('read.favorite') || '收藏')}</span></button>
    <button type="button" data-reading-action="todo">${icon('M3.5 7.5 5.5 9.5 9 6M12.5 8h8M3.5 16.5 5.5 18.5 9 15M12.5 17h8')}<span>${mailaiT('read.todo') || '加入待办'}</span></button>
    <button type="button" data-reading-action="remind">${icon('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2')}<span>${mailaiT('read.remind') || '稍后提醒'}</span></button>`;
  host.querySelector('.reading-mail-controls')?.appendChild(div);
  host.querySelector('.reading-ai-group')?.insertAdjacentHTML('beforeend', `<button type="button" data-reading-action="summary">${icon('M4 6h16M4 11h12M4 16h8m5-2 1 2 2 1-2 1-1 2-1-2-2-1 2-1z')}<span>${mailaiT('read.summary') || '总结邮件'}</span></button>
    <button type="button" data-reading-action="image">${icon('M3 5h18v14H3zM7 10h.01M5 17l5-5 3 3 2-2 4 4')}<span>${mailaiT('read.image') || '识别邮件图片'}</span></button>
    <button type="button" data-reading-action="ask">${icon('M4 4h16v12H9l-5 4zM8 9h8m-8 3h5')}<span>${mailaiT('read.ask') || '问小邮'}</span></button>`);
  const morePanel = host.querySelector('.reading-more-panel');
  if (morePanel) {
    // Keep rare actions discoverable without crowding the reading toolbar.
    const secondary = document.createElement('div');
    secondary.className = 'reading-secondary-actions';
    for (const selector of ['.btn-correspondence', '[data-reading-action="remind"]', '[data-reading-action="image"]']) {
      const button = host.querySelector(selector);
      if (button) secondary.appendChild(button);
    }
    morePanel.querySelector('.reading-secondary-actions')?.remove();
    morePanel.prepend(secondary);
    morePanel.querySelector('[data-reading-action="delete-current"]')?.remove();
    if (selectedEmailDetail?.status !== 'trash') {
      morePanel.insertAdjacentHTML('beforeend', `<button type="button" data-reading-action="delete-current" data-action-hint="${esc(mailaiText('将这封邮件移入已删除'))}">${icon('M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7')}<span><span data-i18n="ui.2f9d72d5133f">删除邮件</span></span></button>`);
    }
  }
  applyI18n(host);
  host.querySelectorAll('button').forEach(button => {
    const label = button.getAttribute('aria-label') || button.textContent.trim();
    if (label) {
      const source = mailaiCopySource(label);
      mailaiBindUI(button, '@aria-label', () => mailaiText(source));
      const hint = mailaiCopySource(button.dataset.actionHint || label);
      mailaiBindUI(button, 'title', () => mailaiText(hint));
    }
  });
  host.onclick = async event => {
    const more = event.target.closest('.reading-more-actions');
    if (more && event.target.closest('button:not(:disabled)')) more.open = false;
    const actionButton = event.target.closest('button[data-reading-action]');
    const action = actionButton?.dataset.readingAction;
    if (!action || !selectedEmailDetail) return;
    const row = selectedEmailDetail;
    const accountId = selectedEmailAccountId || activeMailAccount()?.id;
    try {
      if (action === 'delete-current') {
        if (actionButton.disabled || bulkOperationActive) return;
        actionButton.disabled = true;
        try {
          const result = await api('/api/emails/bulk', {accountId, method:'POST',
            headers:{'Content-Type':'application/json'}, body:JSON.stringify({ids:[Number(row.id)], action:'trash'})});
          if (result.failed?.length) throw new Error(result.failed[0].error || mailaiText('删除失败，请重试'));
          if (selectedEmailDetail === row) resetReadingPane();
          if (activeMailAccount()?.id === accountId) {
            selectedMailIds.delete(Number(row.id));
            if (!selectedMailIds.size) mailSelectionExplicit = false;
          }
          await loadData();
          toast(mailaiText('当前邮件已移入已删除'), 'success');
        } finally { actionButton.disabled = false; }
      } else if (action === 'favorite') {
        const button = actionButton; button.disabled = true;
        try {
          const result = await api(`/api/emails/${row.id}/favorite?value=${!row.is_favorite}`, {accountId,method:'POST'});
          row.is_favorite = result.is_favorite;
          for (const item of [...allEmails,...(searchResults || [])]) if (item.id === row.id && (!item.account_id || item.account_id === accountId)) item.is_favorite = result.is_favorite;
          mailaiBindUI(button.querySelector('[data-action-label]'), "textContent", () => (result.is_favorite ? mailaiText('已收藏') : mailaiText('收藏')));
          button.setAttribute('aria-pressed', String(result.is_favorite));
          applyFilters();
          toast(result.is_favorite ? mailaiText('已加入我的收藏') : mailaiText('已取消收藏'), 'success');
        } finally { button.disabled = false; }
      } else if (action === 'summary') { openAssistantForEmail(row); askAssistant(mailaiText('总结这封邮件的重点和需要我处理的事项'), [row.id]); }
      else if (action === 'image') { openAssistantForEmail(row); askAssistant(mailaiText('请读取这封邮件内嵌图片中可辨识的文字、表格和关键信息；看不清的内容请明确说明。'), [row.id]); }
      else if (action === 'ask') { openAssistantForEmail(row); }
      else if (action === 'todo') { await window.openTaskPlanner({emailId:row.id,title:row.subject}); }
      else if (action === 'remind') {
        await window.openTaskPlanner({emailId:row.id,title:row.subject,remind:true});
      }
    } catch (error) { toast(mailaiSystemMessage(error.message), 'error'); }
  };
}

function updateAssistantScopeControl() {
  const mode = document.getElementById('assistant-scope').value;
  const ids = assistantPinnedScope || (mode === 'selected' && selectedEmailId ? [selectedEmailId] : null);
  let label = mode === 'filtered' ? mailaiText('当前列表 · 本邮箱') : mode === 'selected' ? mailaiText('正在阅读的邮件') : mailaiText('当前邮箱');
  if (ids?.length === 1) {
    const row = selectedEmailDetail?.id === ids[0] ? selectedEmailDetail : allEmails.find(item => {
      const owner = item._account_id || item.account_id;
      return item.id === ids[0] && (!owner || owner === activeMailAccount()?.id);
    });
    label = row?.subject || mailaiText('这封邮件');
  } else if (ids?.length) label = mailaiTemplate`${ids.length} 封指定邮件`;
  const node = document.getElementById('assistant-scope-label');
  node.textContent = label;
  mailaiBindUI(node, "title", () => (`${activeMailAccount()?.user || mailaiText('当前邮箱')} · ${label}`));
  const note = document.getElementById('assistant-scope-note');
  if (note) mailaiBindUI(note, "textContent", () => (mailaiTemplate`${activeMailAccount()?.user || mailaiText('当前邮箱')} · ${ids?.length ? mailaiTemplate`已固定 ${ids.length} 封邮件` : mode === 'filtered' ? mailaiText('列表中属于本邮箱的邮件') : mailaiText('全部已同步邮件')} · 每次最多分析 20 封`));
  mailaiBindUI(document.querySelector('#assistant-scope-picker summary'), "@aria-label", () => (mailaiTemplate`参考范围：${label}，点击更改`));
  document.getElementById('assistant-scope-clear').classList.toggle('hidden', mode === 'account');
  document.querySelectorAll('[data-assistant-scope]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.assistantScope === mode));
    button.disabled = button.dataset.assistantScope === 'selected' && !selectedEmailId && !assistantPinnedScope;
  });
}

let assistantListScroll = null;
function updateAssistantPlacement() {
  const visible = document.body.classList.contains('assistant-visible');
  const floating = document.body.classList.contains('assistant-floating');
  const pane = document.querySelector('.reading-pane');
  const layout = document.querySelector('.layout');
  const reading = !document.getElementById('reading-content').classList.contains('hidden');
  const workspaceVisible = layout.getClientRects().length > 0;
  const scale = Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--fz')) || 1;
  const width = innerWidth / scale;
  const home = visible && !floating && workspaceVisible && !reading && width > 1024;
  const docked = visible && !floating && workspaceVisible && reading && width >= 1600;
  const split = visible && !floating && workspaceVisible && reading && width >= 1024 && width < 1600;
  const compact = visible && !floating && workspaceVisible && reading && width < 1024;
  const wasSplit = document.body.classList.contains('assistant-split');
  const list = document.getElementById('email-list');
  if (split && !wasSplit && list) assistantListScroll = {top:list.scrollTop, account:activeMailAccount()?.id};
  const modeChanged = wasSplit !== split || document.body.classList.contains('assistant-docked') !== docked || document.body.classList.contains('assistant-compact') !== compact;
  const readingTop = pane.scrollTop;
  const readingNode = document.getElementById('reading-content').firstElementChild;
  for (const [name, enabled] of [['assistant-home',home],['assistant-docked',docked],['assistant-split',split],['assistant-split-narrow',split && width < 1200],['assistant-compact',compact]]) {
    if (document.body.classList.contains(name) !== enabled) document.body.classList.toggle(name, enabled);
  }
  if (modeChanged && readingNode) requestAnimationFrame(() => { if (document.getElementById('reading-content').firstElementChild === readingNode) pane.scrollTop = readingTop; });
  if (!split && wasSplit && list && assistantListScroll) {
    const saved = assistantListScroll; assistantListScroll = null;
    requestAnimationFrame(() => { if (!document.body.classList.contains('assistant-split') && saved.account === activeMailAccount()?.id) list.scrollTop = saved.top; });
  }
  if (docked || split) document.getElementById('assistant-panel').style.setProperty('--assistant-dock-top', `${layout.getBoundingClientRect().top / scale}px`);
  if (home) {
    const rect = pane.getBoundingClientRect();
    const panel = document.getElementById('assistant-panel');
    for (const [key,value] of Object.entries({left:rect.left,top:rect.top,width:rect.width,height:rect.height})) {
      panel.style.setProperty('--assistant-home-' + key, `${value / scale}px`);
    }
  }
  const displayButton = document.getElementById('assistant-float');
  const displayLabel = floating ? mailaiText('恢复自动布局') : mailaiText('切换为浮动窗口');
  displayButton.title = displayLabel;
  displayButton.setAttribute('aria-label', displayLabel);
}

function returnToMailFromAssistant() {
  const returnToList = document.body.classList.contains('assistant-split');
  closeAssistant();
  requestAnimationFrame(() => {
    const target = returnToList ? document.querySelector('#email-list .email-item.selected') : null;
    (target || document.querySelector('.reading-pane'))?.focus({preventScroll:true});
  });
}

function initializeAssistantPolish() {
  const scope = document.getElementById('assistant-scope');
  scope.onchange = () => {
    assistantPinnedScope = scope.value === 'selected' && selectedEmailId ? [selectedEmailId] : null;
    assistantScopeKey = '';
    resetAssistantConversation(); updateAssistantScopeControl();
  };
  document.querySelectorAll('[data-assistant-scope]').forEach(button => button.onclick = () => {
    scope.value = button.dataset.assistantScope; scope.onchange();
    document.getElementById('assistant-scope-picker').open = false;
    document.getElementById('assistant-input').focus();
  });
  document.getElementById('assistant-scope-clear').onclick = () => { scope.value = 'account'; scope.onchange(); };
  document.getElementById('assistant-scope-picker').addEventListener('toggle', updateAssistantScopeControl);
  document.getElementById('assistant-float').onclick = () => {
    const floating = document.body.classList.toggle('assistant-floating');
    localStorage.setItem('mailai-assistant-floating', String(floating));
    updateAssistantPlacement();
  };
  document.addEventListener('click', event => {
    document.querySelectorAll('.account-menu[open], .assistant-menu[open], .assistant-scope-picker[open]').forEach(menu => {
      if (!menu.contains(event.target) || event.target.closest('.assistant-menu-items button')) menu.open = false;
    });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.account-menu[open], .assistant-menu[open], .assistant-scope-picker[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus(); });
  });
  const observer = new MutationObserver(updateAssistantPlacement);
  observer.observe(document.body, {attributes:true,attributeFilter:['class']});
  observer.observe(document.querySelector('.layout'), {attributes:true,attributeFilter:['class']});
  observer.observe(document.getElementById('reading-content'), {attributes:true,attributeFilter:['class']});
  new MutationObserver(updateAssistantScopeControl).observe(document.getElementById('reading-content'), {childList:true});
  new ResizeObserver(updateAssistantPlacement).observe(document.querySelector('.reading-pane'));
  window.addEventListener('resize', updateAssistantPlacement);
  updateAssistantPlacement(); updateAssistantScopeControl();
}

function initializeWorkspace() {
  document.getElementById('account-mailbox-nav').addEventListener('click', async event => {
    const id = event.target.closest('[data-account-collapse]')?.dataset.accountCollapse;
    if (id) { localStorage.setItem('collapsed:' + id, localStorage.getItem('collapsed:' + id) === '1' ? '0' : '1'); renderSidebarAccounts(); [...document.querySelectorAll('[data-account-collapse]')].find(button => button.dataset.accountCollapse === id)?.focus(); }
    const managedId = event.target.closest('[data-account-manage]')?.dataset.accountManage;
    if (managedId) { showSystemView('account'); selectedManagedAccountId = managedId; renderAccountSelection(); }
    const aliasId = event.target.closest('[data-account-alias]')?.dataset.accountAlias;
    if (aliasId) { const value = await mailaiAsk({get title() { return mailaiText('修改邮箱显示名称'); }, get message() { return mailaiText('只更改本机显示，不影响邮箱地址。留空可恢复邮箱地址。'); }, get label() { return mailaiText('显示名称'); }, value:localStorage.getItem('alias:' + aliasId) || '', maxLength:40, get confirmText() { return mailaiText('保存名称'); }}); if (value !== null) { localStorage.setItem('alias:' + aliasId, value.trim().slice(0,40)); renderSidebarAccounts(); } }
  });
  document.body.insertAdjacentHTML('beforeend', `<div id="workspace-notice" class="workspace-notice hidden" role="status" aria-live="polite"></div>
    <div id="task-center-backdrop" class="task-center-backdrop hidden"></div>
    <section id="task-center" class="task-center hidden" role="dialog" aria-modal="true" aria-labelledby="task-center-title"><header><div class="task-center-heading"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg></span><div><h2 id="task-center-title" data-i18n="task.title">任务与发件箱</h2><p data-i18n="task.subtitle">只展示进行中或需要你处理的事项</p></div></div><button type="button" id="close-task-center" aria-label="关闭任务与发件箱" data-i18n-aria="task.close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header><label class="task-account-picker"><span data-i18n="ui.c0b982db77ae">查看邮箱</span><select id="task-center-account" aria-label="任务与发件箱所属邮箱" data-i18n-aria="ui.4dbe539ef7cc"></select></label><div id="task-center-list"><div class="task-loading"><i></i><span data-i18n="task.loading">正在读取任务状态…</span></div></div></section>
    <dialog id="reminder-dialog"><form method="dialog"><h3 data-i18n="task.remindTitle">稍后提醒</h3><label><span data-i18n="task.remindTime">提醒时间</span> <input type="datetime-local" id="reminder-time" required></label><p><button value="cancel" data-i18n="common.cancel">取消</button><button type="button" id="save-reminder" data-i18n="task.remindSave">保存提醒</button></p></form></dialog>`);
  const listHeader = document.querySelector('.list-header');
  listHeader.insertAdjacentHTML('afterend', `<div class="list-workspace-tools"><button id="btn-filter-panel" aria-expanded="false" aria-controls="workspace-filters" data-i18n="filter.toggle">筛选</button><div id="filter-chips"></div><button id="btn-task-center" aria-expanded="false" aria-controls="task-center" data-i18n="task.title">任务与发件箱</button></div>`);
  const filters = document.querySelector('.mail-filter-group');
  filters.id = 'workspace-filters'; filters.classList.add('hidden'); document.querySelector('.list-workspace-tools').after(filters);
  filters.setAttribute('aria-hidden', 'true'); filters.inert = true;
  const filterHeader = document.createElement('div');
  filterHeader.className = 'filter-panel-header';
  filterHeader.append(filters.querySelector('.filter-heading'), filters.querySelector('#btn-reset-filter'));
  const filterBody = document.createElement('div');
  filterBody.className = 'filter-panel-content';
  filterBody.append(filters.querySelector('.filter-form'));
  filters.append(filterHeader, filterBody);
  const filterButton = document.getElementById('btn-filter-panel');
  let filterOpen = false, filterAnimation = null, filterContentAnimation = null;
  filterButton.onclick = () => {
    const opening = !filterOpen;
    const previousHeight = filterAnimation ? filters.getBoundingClientRect().height : opening ? 0 : filters.getBoundingClientRect().height;
    const previousOpacity = filterAnimation ? Number(getComputedStyle(filters).opacity) : opening ? 0 : 1;
    const previousContentTransform = filterContentAnimation ? getComputedStyle(filterBody).transform : opening ? 'translateY(-10px)' : 'translateY(0)';
    const previousContentOpacity = filterContentAnimation ? Number(getComputedStyle(filterBody).opacity) : opening ? .65 : 1;
    filterAnimation?.cancel(); filterContentAnimation?.cancel();
    filterOpen = opening;
    filterButton.setAttribute('aria-expanded', String(opening));
    if (opening) { filters.classList.remove('hidden'); filters.inert = false; filters.setAttribute('aria-hidden', 'false'); }
    else { filters.inert = true; filters.setAttribute('aria-hidden', 'true'); }
    filters.style.height = 'auto'; filters.style.opacity = '1';
    const targetHeight = opening ? filters.getBoundingClientRect().height : 0;
    filters.style.height = `${previousHeight}px`;
    filters.style.opacity = String(previousOpacity);
    const finish = () => {
      filters.style.height = ''; filters.style.opacity = '';
      if (!opening) { filters.classList.add('hidden'); filters.inert = true; filters.setAttribute('aria-hidden', 'true'); }
      filterAnimation = null;
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !filters.animate) { finish(); return; }
    const animation = filters.animate([
      {height:`${previousHeight}px`, opacity:previousOpacity},
      {height:`${targetHeight}px`, opacity:opening ? 1 : 0},
    ], {duration:opening ? 340 : 260, easing:'cubic-bezier(.22,.8,.24,1)', fill:'forwards'});
    filterAnimation = animation;
    filterContentAnimation = filterBody.animate([
      {transform:previousContentTransform, opacity:previousContentOpacity},
      {transform:opening ? 'translateY(0)' : 'translateY(-8px)', opacity:opening ? 1 : .55},
    ], {duration:opening ? 340 : 260, easing:'cubic-bezier(.22,.8,.24,1)', fill:'forwards'});
    animation.onfinish = () => {
      if (filterAnimation !== animation) return;
      finish(); animation.cancel(); filterContentAnimation?.cancel(); filterContentAnimation = null;
    };
  };
  updateWorkspaceToolScope();
  document.getElementById('task-center-account').onchange = event => {
    taskCenterAccountId = event.target.value;
    window.mailaiTaskActivity?.scopeChanged();
    const host = document.getElementById('task-center-list');
    host.dataset.live = '0';
    host.innerHTML = "<div class=\"task-loading\"><i></i><span><span data-i18n=\"ui.801012d91506\">正在读取任务状态…</span></span></div>";
    refreshTaskCenter();
  };
  document.getElementById('btn-task-center').onclick = openTaskCenter;
  document.getElementById('close-task-center').onclick = closeTaskCenter;
  document.getElementById('task-center-backdrop').onclick = closeTaskCenter;
  document.getElementById('task-center').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeTaskCenter(); } });
  document.getElementById('filter-chips').onclick = event => {
    const key = event.target.closest('button[data-remove-filter]')?.dataset.removeFilter; if (!key) return;
    if (key === 'workflow') window.mailaiClearWorkflowFilter?.();
    currentFilter[key] = key === 'days' ? 9999 : ['attachments','unread'].includes(key) ? false : '';
    setSegmentedFilter('filter-days', String(currentFilter.days)); setSegmentedFilter('filter-priority', currentFilter.priority);
    document.getElementById('filter-unread').checked = Boolean(currentFilter.unread);
    document.getElementById('filter-domain').value = currentFilter.domain; document.getElementById('filter-attachments').checked = currentFilter.attachments;
    document.getElementById('global-search').value = currentFilter.search;
    searchResults = null; ++searchRevision; clearTimeout(globalSearchTimer);
    applySidebarFilter(key === 'days'); updateFilterChips();
  };
  const density = document.getElementById('workspace-density'); density.value = localStorage.getItem('mailai-density') || 'comfortable';
  document.body.dataset.density = density.value;
  density.onchange = () => { document.body.dataset.density = density.value; localStorage.setItem('mailai-density', density.value); syncPreferenceChoices(); };
  // 界面字号：用 CSS zoom 整体等比缩放（布局随文字一起放大，样式不走样），仅保存本机。
  // zoom 不缩放 vw/vh，浮层的视口单位统一写成 calc(Nvw / var(--fz,1))，这里同步 --fz 补偿
  const fontSize = document.getElementById('font-size');
  const applyFontScale = value => {
    const scale = parseFloat(value);
    const valid = Number.isFinite(scale) && scale > 0;
    document.body.style.zoom = valid ? String(scale) : '';
    document.documentElement.style.setProperty('--fz', valid ? String(scale) : '1');
  };
  fontSize.value = localStorage.getItem('mailai-font-scale') || '1';
  applyFontScale(fontSize.value);
  fontSize.onchange = () => { applyFontScale(fontSize.value); localStorage.setItem('mailai-font-scale', fontSize.value); syncPreferenceChoices(); };
  const themeMode = document.getElementById('theme-mode');
  themeMode.value = savedThemeMode();
  themeMode.onchange = () => {
    const mode = themeMode.value;
    try { localStorage.setItem(THEME_MODE_KEY, mode); } catch (_) {}
    applyTheme(mode);
    toast(mode === 'system' ? mailaiText('已改为跟随系统主题') : mailaiTemplate`已切换为${mode === 'dark' ? mailaiText('暗色') : mailaiText('浅色')}主题`, 'success');
  };
  for (const [name,id] of [['theme-mode-choice','theme-mode'],['workspace-density-choice','workspace-density'],['font-size-choice','font-size'],['notification-mode','notification-preference'],['interface-language-choice','interface-language']]) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => input.onchange = () => {
      const control = document.getElementById(id); control.value = input.value;
      if (typeof control.onchange === 'function') control.onchange({target:control}); else control.dispatchEvent(new Event('change'));
    });
  }
  syncPreferenceChoices();
  document.getElementById('notification-retry-load').onclick = loadWorkspacePreferences;
  document.getElementById('semantic-enabled').onchange = async event => {
    const accountId = activeMailAccount()?.id;
    if (!accountId) { event.target.checked = false; return; }
    const enabledValue = event.target.checked;
    const status = document.getElementById('semantic-status');
    mailaiBindUI(status, "textContent", () => (mailaiT('semantic.saving') || '正在保存…'));
    try {
      const prefs = await api('/api/preferences', {accountId});
      await api('/api/preferences', {accountId, method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...prefs, semantic_enabled:enabledValue})});
      toast(enabledValue ? (mailaiT('semantic.enabledToast') || '已启用语义检索') : (mailaiT('semantic.disabledToast') || '已关闭语义检索'), 'success');
      loadSemanticStatus();
    } catch (error) {
      event.target.checked = !enabledValue;
      mailaiBindUI(status, "textContent", () => (mailaiT('semantic.saveFailed') || '保存失败，请重试'));
      toast(mailaiSystemMessage(error.message), 'error');
    }
  };
  document.getElementById('semantic-reindex').onclick = async event => {
    const button = event.currentTarget;
    const status = document.getElementById('semantic-status');
    setLoading(button, true, mailaiT('semantic.reindexingShort') || '重建中…');
    mailaiBindUI(status, "textContent", () => (mailaiT('semantic.reindexing') || '正在重建索引（首次需下载模型，请稍候）…'));
    const accountId = activeMailAccount()?.id;
    try {
      await api('/api/assistant/semantic/reindex', {accountId, method:'POST'});
      if (accountId === activeMailAccount()?.id) toast(mailaiT('semantic.queued') || '等待后台更新，邮件可正常使用', 'success');
    } catch (error) {
      if (accountId === activeMailAccount()?.id) toast(mailaiSystemMessage(error.message), 'error');
    } finally {
      setLoading(button, false);
      loadSemanticStatus();
    }
  };
  document.getElementById('notification-preference').onchange = async event => {
    const accountId = activeMailAccount()?.id; const notification = event.target.value;
    if (!accountId || preferencesSaving || preferencesAccount !== accountId) return loadWorkspacePreferences();
    preferencesSaving = true; ++preferencesLoadRevision;
    document.getElementById('notification-options').disabled = true;
    mailaiBindUI(document.getElementById('notification-save-status'), "textContent", () => (mailaiText('正在保存…')));
    try {
      const prefs = await api('/api/preferences', {accountId});
      await api('/api/preferences', {accountId, method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...prefs, notifications:notification})});
      if (accountId === activeMailAccount()?.id) { mailaiBindUI(document.getElementById('notification-save-status'), "textContent", () => (mailaiText('已保存'))); loadAssistantAlerts(); }
    } catch (error) {
      if (accountId === activeMailAccount()?.id) {
        mailaiBindUI(document.getElementById('notification-save-status'), "textContent", () => (mailaiText('保存失败，请重新读取后再试')));
        document.getElementById('notification-retry-load').classList.remove('hidden');
        toast(mailaiSystemMessage(error.message), 'error');
        return;
      }
    } finally {
      preferencesSaving = false;
      if (accountId !== activeMailAccount()?.id) loadWorkspacePreferences();
      else if (document.getElementById('notification-retry-load').classList.contains('hidden')) document.getElementById('notification-options').disabled = false;
      syncPreferenceChoices();
    }
  };
  document.getElementById('assistant-stop').onclick = () => assistantController?.abort();
  document.getElementById('assistant-retry').onclick = () => {
    document.querySelector('#assistant-messages .assistant-message.bot:last-child')?.remove();
    askAssistant(assistantLastQuestion, assistantLastScope, assistantLastImages, assistantLastAttachments, assistantLastAlertContext, {retry:true});
  };
  document.body.classList.toggle('assistant-floating', localStorage.getItem('mailai-assistant-floating') === 'true');
  initializeAssistantPolish();
  document.getElementById('task-center-list').onclick = async event => {
    const accountId = event.currentTarget.dataset.accountId;
    try {
      if (event.target.closest('[data-task-open-sent]')) { await openAccountMailbox(accountId, 'sent'); closeTaskCenter(); return; }
      if (event.target.dataset.editQueue) {
        const node = event.target;
        if (node.disabled) return;
        node.disabled = true;
        try {
          const result = await api(`/api/mail/outbox/${encodeURIComponent(node.dataset.editQueue)}/edit`, {accountId, method:'POST'});
          const draft = await api(`/api/drafts/${result.draft_id}`, {accountId});
          closeTaskCenter();
          await openCompose({...draft, account_id:accountId});
          toast(mailaiText('发送任务已暂停，请编辑后重新确认发送安排'), 'success');
        } finally { if (node.isConnected) node.disabled = false; }
        return;
      }
      if (event.target.dataset.timeQueue) { window.mailaiProductivity?.scheduleTime(event.target.dataset.timeQueue, accountId); return; }
      if (event.target.dataset.cancelQueue) await api(`/api/mail/outbox/${event.target.dataset.cancelQueue}/cancel`, {accountId, method:'POST'});
      if (event.target.dataset.purgeAck) {
        const button = event.target;
        if (button.disabled) return;
        button.disabled = true;
        try {
          await api('/api/trash/purge/acknowledge', {accountId, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ids:JSON.parse(button.dataset.purgeAck)})});
        } finally { button.disabled = false; }
      }
      if (event.target.dataset.taskRefresh !== undefined) return refreshTaskCenter();
      if (event.target.dataset.syncRetry) {
        await api(event.target.dataset.syncRetry, {accountId, method:'POST'});
        if (accountId === activeMailAccount()?.id) startFetchMonitor();
        taskNotice(mailaiText('已重新开始邮箱同步 · ') + ((_systemConfig?.accounts || []).find(account => account.id === accountId)?.user || ''));
      }
      if (event.target.dataset.outboxDraft) { const draft = await api(`/api/drafts/${event.target.dataset.outboxDraft}`, {accountId}); openCompose({...draft,account_id:accountId}); closeTaskCenter(); return; }
      if (event.target.dataset.reminderOpen) { await openAccountMailbox(accountId, 'inbox'); await revealEmailFromSource(Number(event.target.dataset.reminderOpen)); closeTaskCenter(); return; }
      if (event.target.dataset.reminderDismiss) {
        await api(event.target.dataset.taskReminder ? `/api/task-reminders/${event.target.dataset.taskReminder}` : `/api/reminders/${event.target.dataset.reminderDismiss}`, {accountId, method:'DELETE'});
        window.mailaiTasksChanged?.(accountId);
      }
      refreshTaskCenter();
    } catch (error) { toast(mailaiSystemMessage(error.message), 'error'); }
  };
  document.getElementById('save-reminder').onclick = async () => {
    const dialog = document.getElementById('reminder-dialog');
    try { await api(`/api/emails/${dialog.dataset.emailId}/remind`, {accountId:dialog.dataset.accountId, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({at:document.getElementById('reminder-time').value})}); window.mailaiTasksChanged?.(dialog.dataset.accountId); dialog.close(); toast(mailaiText('提醒已保存；MailAI 运行时会提示'), 'success'); }
    catch (error) { toast(mailaiSystemMessage(error.message), 'error'); }
  };
  initializeContactGroups();
  new MutationObserver(addReadingActions).observe(document.getElementById('reading-content'), {childList:true});
  new MutationObserver(updateFilterChips).observe(document.getElementById('list-title'), {childList:true});
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.getElementById('task-center').classList.contains('hidden')) closeTaskCenter();
    if (event.key === 'Tab') {
      if (document.querySelector('dialog[open]')) return; // Native modal dialogs own their focus trap.
      const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].reverse().find(node => node.getClientRects().length);
      if (!dialog) return;
      const focus = [...dialog.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(node => !node.disabled && node.getClientRects().length);
      const first = focus[0], last = focus.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
  });
  const refreshWorkspace = () => {
    if (activeMailAccount()) {
      if (!document.getElementById('task-center').classList.contains('hidden')) refreshTaskCenter();
      if (preferencesAccount !== activeMailAccount()?.id) loadWorkspacePreferences();
    }
  };
  if (window.mailaiEnergy) window.mailaiEnergy.register('workspace', refreshWorkspace, 60000,
    () => Boolean(activeMailAccount()) && (!document.getElementById('task-center').classList.contains('hidden') || preferencesAccount !== activeMailAccount()?.id));
  else setInterval(() => { if (!document.hidden) refreshWorkspace(); }, 60000);
  initialLoad.then(() => { loadWorkspacePreferences(); });
  updateFilterChips();
}

initializeWorkspace();

// Dismiss only this disclosure; Escape returns the keyboard to its trigger.
document.addEventListener('keydown', event => {
  const more = document.querySelector('.reading-more-actions[open]');
  if (event.key === 'Escape' && more) {
    more.open = false;
    more.querySelector('summary')?.focus();
  }
});
document.addEventListener('click', event => {
  const more = document.querySelector('.reading-more-actions[open]');
  if (more && !more.contains(event.target)) more.open = false;
});

document.getElementById('task-center-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-action-sync-retry]');
  if (!button || button.disabled) return;
  const accountId = taskCenterScope(); button.disabled = true;
  try {
    await api(`/api/mail/action-sync/${Number(button.dataset.actionSyncRetry)}/retry`, {accountId, method:'POST'});
    if (accountId === taskCenterScope()) { toast(mailaiText('已安排后台重试，可继续处理其他邮件'), 'info'); await refreshTaskCenter(); }
  } catch (error) { if (accountId === taskCenterScope()) toast(mailaiSystemMessage(error.message), 'error'); }
  finally { if (button.isConnected) button.disabled = false; }
});

document.getElementById('task-center-list').addEventListener('click', async event => {
  if (event.target.closest('[data-sync-paused-toggle]')) { window.mailaiShowPausedSync = !window.mailaiShowPausedSync; await refreshTaskCenter(); return; }
  const button = event.target.closest('[data-action-sync-pause]');
  if (!button || button.disabled) return;
  const accountId = taskCenterScope(), id = Number(button.dataset.actionSyncPause);
  button.disabled = true;
  try {
    if (!await mailaiAsk({get title() { return mailaiText('暂停这封邮件的删除同步？'); }, get message() { return mailaiText('停止自动重试并移出待处理列表。本地仍保持删除状态；服务器邮件可能仍在原文件夹或垃圾箱。你可以在“已暂停”中恢复同步。'); },get confirmText() { return mailaiText('暂停同步'); }})) return;
    await api(`/api/mail/action-sync/${id}/pause`,{accountId,method:'POST'});
    if (accountId === taskCenterScope()) { await refreshTaskCenter(); toast(mailaiText('已暂停，可在已暂停列表恢复'),'info'); }
  } catch(error) { toast(mailaiSystemMessage(error.message),'error'); } finally { if(button.isConnected) button.disabled=false; }
});
