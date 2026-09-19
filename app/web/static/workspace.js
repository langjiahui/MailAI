/* Workspace interaction layer: preferences, task feedback and mail actions. */
let undoTokens = [];
let operationRetry = null;
let preferencesAccount = '';
let preferencesLoadRevision = 0;
let preferencesSaving = false;
let taskPollActive = false;
let taskCenterPollTimer = 0;
let taskCenterReminders = [];
let taskCenterLastFocus = null;
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
  const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', '关闭提示'); close.onclick = () => hideTaskNotice(host); host.append(close);
  host.classList.remove('is-fading');
  host.classList.remove('hidden');
  if (dismissAfter > 0) host._dismissTimer = setTimeout(() => hideTaskNotice(host), dismissAfter);
}

function offerUndo(tokens, accountId) {
  undoTokens.push(...tokens.map(token => ({token, accountId, at:Date.now()})));
  undoTokens = undoTokens.filter(item => Date.now() - item.at < 120000);
  const perform = async () => {
    if (undoInProgress) return;
    undoTokens = undoTokens.filter(item => Date.now() - item.at < 120000);
    const pending = undoTokens.splice(0);
    if (!pending.length) {
      latestUndoAction = null;
      taskNotice('撤销时间已超过 2 分钟', '', null, 3500);
      return;
    }
    undoInProgress = true;
    let failed = 0;
    try {
      for (const item of pending.reverse()) {
        try {
          const result = await api(`/api/mail/undo/${item.token}`, {method:'POST', accountId:item.accountId}); failed += result.failed.length;
          if (result.retry_token) undoTokens.push({...item, token:result.retry_token, at:Date.now()});
        } catch (_) { failed++; undoTokens.push(item); }
      }
      latestUndoAction = failed ? perform : null;
      taskNotice(failed ? `部分操作未能撤销（${failed} 项），请核对邮件状态` : '已撤销', failed ? '重试撤销' : '', failed ? perform : null, failed ? 0 : 3500);
      await loadData();
    } finally {
      undoInProgress = false;
    }
  };
  latestUndoAction = perform;
  taskNotice('操作已完成，2 分钟内可撤销（⌘Z / Ctrl+Z）', '撤销', perform, 6500);
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
  taskNotice(`${items.length} 封未完成：${items.slice(0, 2).map(item => item.error).join('；')}`, '仅重试失败项', retry);
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
  if (result.status !== 'queued') {
    const label = {sent:'这封邮件已发送，请勿重复发送',sending:'这封邮件正在发送',canceled:'这封邮件已撤销，内容保留在草稿箱',failed:'发送失败，内容保留在草稿箱',unknown:'发送结果待确认，请先核对已发送邮件'};
    taskNotice(label[result.status] || '请查看发件箱状态', '查看发件箱', openTaskCenter); return;
  }
  refreshAfterQueuedSend(result.token, accountId);
  taskNotice('邮件已加入发件箱，发送前可撤销', '撤销发送', async () => {
    try { await api(`/api/mail/outbox/${result.token}/cancel`, {method:'POST', accountId}); taskNotice('已撤销发送，内容保留在草稿箱'); }
    catch (error) { taskNotice(error.message, '查看发件箱', openTaskCenter); }
  });
}

async function openTaskCenter() {
  window.closeAssistant?.();
  taskCenterLastFocus = document.activeElement;
  const panel = document.getElementById('task-center');
  const host = document.getElementById('task-center-list');
  if (host.dataset.accountId !== (activeMailAccount()?.id || '')) {
    host.innerHTML = '<div class="task-loading"><i></i><span>正在读取任务状态…</span></div>';
  }
  panel.classList.remove('hidden');
  document.getElementById('task-center-backdrop').classList.remove('hidden');
  document.getElementById('btn-task-center').setAttribute('aria-expanded', 'true');
  panel.querySelector('button').focus();
  await refreshTaskCenter();
}

function closeTaskCenter() {
  clearTimeout(taskCenterPollTimer); taskCenterPollTimer = 0;
  document.getElementById('task-center').classList.add('hidden');
  document.getElementById('task-center-backdrop').classList.add('hidden');
  document.getElementById('btn-task-center').setAttribute('aria-expanded', 'false');
  (taskCenterLastFocus?.isConnected ? taskCenterLastFocus : document.getElementById('btn-task-center'))?.focus();
}

function scheduleTaskCenterRefresh(enabled) {
  clearTimeout(taskCenterPollTimer); taskCenterPollTimer = 0;
  if (!enabled || document.getElementById('task-center').classList.contains('hidden')) return;
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
  if (taskPollActive) {
    clearTimeout(taskCenterPollTimer);
    taskCenterPollTimer = setTimeout(() => refreshTaskCenter({lightweight}), 250);
    return;
  }
  taskPollActive = true;
  const accountId = activeMailAccount()?.id;
  const host = document.getElementById('task-center-list');
  try {
    let rows, sync, reminders, allReminders;
    if (lightweight) {
      [rows, sync] = await Promise.all([api('/api/mail/outbox', {accountId}), api('/api/fetch_status', {accountId})]);
      reminders = taskCenterReminders;
      allReminders = [];
    } else {
      [rows, sync, reminders, allReminders] = await Promise.all([api('/api/mail/outbox', {accountId}), api('/api/fetch_status', {accountId}), api('/api/reminders', {accountId}), api('/api/reminders/all', {accountId})]);
      taskCenterReminders = reminders;
    }
    rows.forEach(row => { try { row.error = row.error || JSON.parse(row.result || '{}').warning || ''; } catch (_) {} });
    if (accountId !== activeMailAccount()?.id) { host.dataset.live = '0'; return; }
    host.dataset.accountId = accountId || '';
    const labels = {queued:'等待发送', sending:'发送中', sent:'已发送', failed:'发送失败', unknown:'发送结果待确认', canceled:'已撤销'};
    const visibleRows = actionableOutboxRows(rows);
    const showSync = Boolean(sync.running || sync.error || sync.canceled || sync.resumable);
    const syncRetryPath = ['fetch_all','sync_folders','sync_folder'].includes(sync.operation) ? '/api/fetch_all'
      : sync.operation === 'fetch_more' ? '/api/fetch_more' : '/api/poll';
    const syncBlock = showSync ? `<section class="task-section"><h3>${sync.running ? '进行中的任务' : '需要处理'} <span>1</span></h3><article class="task-row ${sync.error || sync.resumable ? 'needs-attention' : ''}"><div class="task-row-main"><b>邮箱同步</b><span class="task-status ${sync.running ? 'running' : 'warning'}">${sync.running ? '进行中' : '需处理'}</span></div><small>${esc(sync.message || (sync.running ? '正在同步…' : '同步已中断'))}${sync.error ? `<br>${esc(sync.error)}` : ''}</small>${!sync.running ? `<div class="task-row-actions"><button class="primary" data-sync-retry="${syncRetryPath}">重新同步</button></div>` : ''}</article></section>` : '';
    const outboxBlock = visibleRows.length ? `<section class="task-section"><h3>发件箱 <span>${visibleRows.length}</span></h3>${visibleRows.map(row => `<article class="task-row ${['failed','unknown'].includes(row.status) ? 'needs-attention' : ''}" data-outbox-token="${esc(row.token)}"><div class="task-row-main"><b>${esc(row.subject || '无主题')}</b><span class="task-status status-${esc(row.status)}">${esc(labels[row.status] || row.status)}</span></div><small>${esc(row.to_addr || '')}${row.error ? ` · ${esc(row.error)}` : ''}${row.status === 'unknown' ? '<br>请核对服务器已发送邮件，避免重复发送。' : ''}</small><div class="task-row-actions">${row.status === 'queued' ? `<button data-cancel-queue="${esc(row.token)}">撤销发送</button>` : ''}${row.status === 'failed' && row.draft_id ? `<button class="primary" data-outbox-draft="${esc(row.draft_id)}">编辑草稿后重试</button>` : ''}</div></article>`).join('')}</section>` : '';
    const reminderBlock = reminders.length ? `<section class="task-section"><h3>稍后提醒 <span>${reminders.length}</span></h3>${reminders.map(item => `<article class="task-row"><div class="task-row-main"><b>${esc(item.subject)}</b><span class="task-status">${esc(fmtDate(item.at))}</span></div><small>到期后提醒你处理这封邮件</small><div class="task-row-actions"><button class="primary" data-reminder-open="${item.email_id}">查看邮件</button><button data-reminder-dismiss="${item.email_id}" data-task-reminder="${item.todo_id || ''}">关闭提醒</button></div></article>`).join('')}</section>` : '';
    const content = syncBlock + outboxBlock + reminderBlock;
    const attentionCount = visibleRows.filter(row => ['failed','unknown'].includes(row.status)).length + (showSync && !sync.running ? 1 : 0);
    const activeCount = visibleRows.filter(row => ['queued','sending'].includes(row.status)).length + (sync.running ? 1 : 0);
    host.dataset.live = activeCount ? '1' : '0';
    host.innerHTML = `<div class="task-overview"><div><span>当前邮箱</span><b>${esc(activeMailAccount()?.user || '')}</b></div><div class="task-overview-counts">${attentionCount ? `<span class="attention">${attentionCount} 项需处理</span>` : ''}${activeCount ? `<span>${activeCount} 项进行中</span>` : ''}${reminders.length ? `<span>${reminders.length} 项提醒</span>` : ''}${!attentionCount && !activeCount && !reminders.length ? '<span class="healthy">状态正常</span>' : ''}</div></div>` + (content || `<div class="task-empty"><b>目前没有需要处理的任务</b><span>正常同步进度会显示在左侧邮箱区域；发送失败或待确认邮件会出现在这里。</span></div>`);
    for (const row of visibleRows.filter(row => row.status === 'unknown')) {
      const article = [...host.querySelectorAll('[data-outbox-token]')].find(item => item.dataset.outboxToken === row.token);
      if (!article) continue;
      const actions = article.querySelector('.task-row-actions');
      for (const delivered of [true, false]) {
        const button = document.createElement('button'); button.textContent = delivered ? '确认已送达' : '确认未送达';
        if (!delivered) button.className = 'primary';
        button.onclick = async () => {
          if (!confirm(delivered ? '已核对服务器或收件人，确认这封邮件已送达？' : '已核对服务器或收件人，确认未送达？确认后才允许从草稿重新发送。')) return;
          try { await api(`/api/mail/outbox/${row.token}/resolve?delivered=${delivered}`, {accountId, method:'POST'}); refreshTaskCenter(); }
          catch (error) { toast(error.message, 'error'); }
        }; actions.append(button);
      }
    }
    document.getElementById('btn-task-center').textContent = `${mailaiT('task.title') || '任务与发件箱'}${attentionCount ? (mailaiT('task.badgeAttention') || ' · {n} 项需处理').replace('{n}', attentionCount) : activeCount ? (mailaiT('task.badgeActive') || ' · {n} 项进行中').replace('{n}', activeCount) : ''}`;
    for (const reminder of allReminders.filter(item => new Date(item.at).getTime() <= Date.now())) {
      const reminderAccount = reminder.account_id;
      const key = `reminder:${reminderAccount}:${reminder.todo_id || reminder.email_id}:${reminder.at}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        taskNotice(`到时间了：${reminder.subject} · ${reminder.account_user}`, '查看邮件', async () => { await openAccountMailbox(reminderAccount, 'inbox'); await revealEmailFromSource(reminder.email_id); });
      }
    }
  } catch (error) { host.innerHTML = `<div class="task-load-error"><b>状态暂时无法更新</b><span>${esc(error.message)}</span><button data-task-refresh>重新加载</button></div>`; }
  finally { taskPollActive = false; scheduleTaskCenterRefresh(host.dataset.live === '1'); }
}

function updateFilterChips() {
  const labels = {unread:currentFilter.unread ? '未读邮件' : '', days:currentFilter.days !== 9999 ? `近 ${currentFilter.days} 天` : '', priority:currentFilter.priority ? `${currentFilter.priority}重要程度` : '', domain:currentFilter.domain, attachments:currentFilter.attachments ? '含附件' : '', search:currentFilter.search, category:currentFilter.category, verdict:currentFilter.verdict ? ({clean:'正常', suspicious:'可疑', phishing:'高风险'})[currentFilter.verdict] : ''};
  document.getElementById('filter-chips').innerHTML = Object.entries(labels).filter(([,value]) => value).map(([key,value]) => `<button type="button" data-remove-filter="${key}">${esc(value)} ×</button>`).join('');
}

let semanticPollTimer = null;

function renderSemanticProgress(stats) {
  const wrap = document.getElementById('semantic-progress');
  const status = document.getElementById('semantic-status');
  if (!wrap || !status) return false;
  const p = stats?.progress || {};
  if (!p.running) { wrap.classList.add('hidden'); return false; }
  wrap.classList.remove('hidden');
  const fill = wrap.querySelector('i');
  if (p.phase === 'index' && p.total) {
    wrap.classList.add('determinate');
    fill.style.width = `${Math.round(100 * p.done / p.total)}%`;
    status.textContent = (mailaiT('semantic.progress') || '正在重建索引 {done}/{total}…').replace('{done}', p.done).replace('{total}', p.total);
  } else {
    // 首个批次返回前都在下载/加载模型，无法预估进度，用滚动条示意
    wrap.classList.remove('determinate');
    fill.style.width = '';
    status.textContent = mailaiT('semantic.downloading') || '正在下载模型（约 100MB，仅首次）…';
  }
  return true;
}

function pollSemanticProgress() {
  clearInterval(semanticPollTimer);
  semanticPollTimer = setInterval(async () => {
    const accountId = activeMailAccount()?.id;
    if (!accountId) { clearInterval(semanticPollTimer); return; }
    try {
      if (!renderSemanticProgress(await api('/api/assistant/semantic', {accountId}))) clearInterval(semanticPollTimer);
    } catch (_) { /* 状态轮询失败不影响重建本身 */ }
  }, 800);
}

function stopSemanticProgress() {
  clearInterval(semanticPollTimer);
  semanticPollTimer = null;
  document.getElementById('semantic-progress')?.classList.add('hidden');
}

async function loadSemanticStatus() {
  const status = document.getElementById('semantic-status');
  const reindex = document.getElementById('semantic-reindex');
  const toggle = document.getElementById('semantic-enabled');
  if (!status || !reindex || !toggle) return;
  const accountId = activeMailAccount()?.id;
  if (!accountId) {
    status.textContent = mailaiT('semantic.needAccount') || '添加邮箱后即可启用';
    toggle.checked = false;
    reindex.classList.add('hidden');
    return;
  }
  try {
    const [prefs, stats] = await Promise.all([
      api('/api/preferences', {accountId}),
      api('/api/assistant/semantic', {accountId}),
    ]);
    if (!stats.deps_available) {
      // 依赖缺失时禁止打开开关，避免"开了但静默空转"
      toggle.checked = false;
      toggle.disabled = true;
      toggle.closest('label')?.setAttribute('title', mailaiT('semantic.noDeps') || '未安装可选依赖（requirements-semantic.txt）');
      status.textContent = mailaiT('semantic.noDeps') || '未安装可选依赖（requirements-semantic.txt）';
      reindex.classList.add('hidden');
      return;
    }
    toggle.disabled = false;
    toggle.closest('label')?.removeAttribute('title');
    toggle.checked = !!prefs.semantic_enabled;
    status.textContent = stats.indexed
      ? (mailaiT('semantic.indexed') || '已索引 {n} 封邮件').replace('{n}', stats.indexed) +
        (stats.last_indexed_at ? ` · ${String(stats.last_indexed_at).slice(0, 16)}` : '')
      : (mailaiT('semantic.notIndexed') || '尚未建立索引');
    reindex.classList.toggle('hidden', !stats.enabled);
    // 重建进行中（例如刚触发后切换了页签再回来）时恢复进度条与轮询
    if (renderSemanticProgress(stats)) pollSemanticProgress();
  } catch (_) {
    status.textContent = mailaiT('semantic.error') || '暂时无法读取状态';
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
  document.getElementById('notification-account').textContent = activeMailAccount()?.user || '尚未连接邮箱';
  document.getElementById('notification-account').title = activeMailAccount()?.user || '';
  document.getElementById('notification-retry-load').classList.add('hidden');
  if (!accountId) { status.textContent = '添加邮箱后即可设置提醒'; syncPreferenceChoices(); return; }
  status.textContent = '正在读取设置…';
  try {
    const prefs = await api('/api/preferences', {accountId});
    if (revision !== preferencesLoadRevision || accountId !== activeMailAccount()?.id) return;
    preferencesAccount = accountId;
    document.getElementById('notification-preference').value = prefs.notifications;
    options.disabled = false;
    status.textContent = '已保存';
    syncPreferenceChoices();
  } catch (_) {
    if (revision !== preferencesLoadRevision || accountId !== activeMailAccount()?.id) return;
    status.textContent = '暂时无法读取设置，请重试';
    document.getElementById('notification-retry-load').classList.remove('hidden');
  }
}

function syncPreferenceChoices() {
  for (const [name,id] of [['theme-mode-choice','theme-mode'],['workspace-density-choice','workspace-density'],['notification-mode','notification-preference']]) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => { input.checked = input.value === document.getElementById(id).value; });
  }
}

function addReadingActions(force = false) {
  const host = document.querySelector('.reading-header .reading-actions');
  if (!host) return;
  if (host.querySelector('.reading-work-actions')) {
    if (!force) return;
    host.querySelector('.reading-work-actions')?.remove();
    host.querySelectorAll('[data-reading-action="summary"],[data-reading-action="image"],[data-reading-action="ask"]').forEach(node => node.remove());
  }
  const div = document.createElement('div'); div.className = 'reading-work-actions';
  const icon = paths => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths}"/></svg>`;
  div.innerHTML = `<button type="button" data-reading-action="favorite" aria-pressed="${Boolean(selectedEmailDetail?.is_favorite)}">${icon('m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z')}<span data-action-label>${selectedEmailDetail?.is_favorite ? (mailaiT('read.favorited') || '已收藏') : (mailaiT('read.favorite') || '收藏')}</span></button>
    <button type="button" data-reading-action="todo">${icon('M6 4h12v16H6zM9 12l2 2 4-4')}<span>${mailaiT('read.todo') || '加入待办'}</span></button>
    <button type="button" data-reading-action="remind">${icon('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2')}<span>${mailaiT('read.remind') || '稍后提醒'}</span></button>`;
  host.querySelector('.reading-mail-controls')?.appendChild(div);
  host.querySelector('.reading-ai-group')?.insertAdjacentHTML('beforeend', `<button type="button" data-reading-action="summary">${icon('M4 6h16M4 11h12M4 16h8m5-2 1 2 2 1-2 1-1 2-1-2-2-1 2-1z')}<span>${mailaiT('read.summary') || '总结邮件'}</span></button>
    <button type="button" data-reading-action="image">${icon('M3 5h18v14H3zM7 10h.01M5 17l5-5 3 3 2-2 4 4')}<span>${mailaiT('read.image') || '识别邮件图片'}</span></button>
    <button type="button" data-reading-action="ask">${icon('M4 4h16v12H9l-5 4zM8 9h8m-8 3h5')}<span>${mailaiT('read.ask') || '问小邮'}</span></button>`);
  host.querySelectorAll('button').forEach(button => {
    const label = button.getAttribute('aria-label') || button.textContent.trim();
    if (label) {
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  });
  host.onclick = async event => {
    const actionButton = event.target.closest('button[data-reading-action]');
    const action = actionButton?.dataset.readingAction;
    if (!action || !selectedEmailDetail) return;
    const row = selectedEmailDetail;
    const accountId = activeMailAccount()?.id;
    try {
      if (action === 'favorite') {
        const button = actionButton; button.disabled = true;
        try {
          const result = await api(`/api/emails/${row.id}/favorite?value=${!row.is_favorite}`, {accountId,method:'POST'});
          row.is_favorite = result.is_favorite;
          for (const item of [...allEmails,...(searchResults || [])]) if (item.id === row.id && (!item.account_id || item.account_id === accountId)) item.is_favorite = result.is_favorite;
          button.querySelector('[data-action-label]').textContent = result.is_favorite ? '已收藏' : '收藏';
          button.setAttribute('aria-pressed', String(result.is_favorite));
          applyFilters();
          toast(result.is_favorite ? '已加入我的收藏' : '已取消收藏', 'success');
        } finally { button.disabled = false; }
      } else if (action === 'summary') { document.getElementById('assistant-scope').value = 'selected'; openAssistant(); askAssistant('总结这封邮件的重点和需要我处理的事项', [row.id]); }
      else if (action === 'image') { document.getElementById('assistant-scope').value = 'selected'; openAssistant(); askAssistant('请读取这封邮件内嵌图片中可辨识的文字、表格和关键信息；看不清的内容请明确说明。', [row.id]); }
      else if (action === 'ask') { document.getElementById('assistant-scope').value = 'selected'; openAssistant(); }
      else if (action === 'todo') { await window.openTaskPlanner({emailId:row.id,title:row.subject}); }
      else if (action === 'remind') {
        await window.openTaskPlanner({emailId:row.id,title:row.subject,remind:true});
      }
    } catch (error) { toast(error.message, 'error'); }
  };
}

function updateAssistantScopeControl() {
  const mode = document.getElementById('assistant-scope').value;
  const ids = assistantPinnedScope || (mode === 'selected' && selectedEmailId ? [selectedEmailId] : null);
  let label = mode === 'filtered' ? '当前列表 · 本邮箱' : mode === 'selected' ? '正在阅读的邮件' : '当前邮箱';
  if (ids?.length === 1) {
    const row = selectedEmailDetail?.id === ids[0] ? selectedEmailDetail : allEmails.find(item => item.id === ids[0] && (!item.account_id || item.account_id === activeMailAccount()?.id));
    label = row?.subject || '这封邮件';
  } else if (ids?.length) label = `${ids.length} 封指定邮件`;
  const node = document.getElementById('assistant-scope-label');
  node.textContent = label;
  node.title = `${activeMailAccount()?.user || '当前邮箱'} · ${label}`;
  document.querySelector('#assistant-scope-picker summary').setAttribute('aria-label', `参考范围：${label}，点击更改`);
  document.getElementById('assistant-scope-clear').classList.toggle('hidden', mode === 'account');
  document.querySelectorAll('[data-assistant-scope]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.assistantScope === mode));
    button.disabled = button.dataset.assistantScope === 'selected' && !selectedEmailId && !assistantPinnedScope;
  });
}

function updateAssistantPlacement() {
  const visible = document.body.classList.contains('assistant-visible');
  const floating = document.body.classList.contains('assistant-floating');
  const pane = document.querySelector('.reading-pane');
  const layout = document.querySelector('.layout');
  const reading = !document.getElementById('reading-content').classList.contains('hidden');
  const workspaceVisible = layout.getClientRects().length > 0;
  const home = visible && !floating && workspaceVisible && !reading && innerWidth > 1024;
  const docked = visible && !floating && workspaceVisible && reading && innerWidth >= 1600;
  for (const [name, enabled] of [['assistant-home',home],['assistant-docked',docked]]) {
    if (document.body.classList.contains(name) !== enabled) document.body.classList.toggle(name, enabled);
  }
  if (docked) document.getElementById('assistant-panel').style.setProperty('--assistant-dock-top', `${layout.getBoundingClientRect().top}px`);
  if (home) {
    const rect = pane.getBoundingClientRect();
    const panel = document.getElementById('assistant-panel');
    for (const [key,value] of Object.entries({left:rect.left,top:rect.top,width:rect.width,height:rect.height})) {
      panel.style.setProperty('--assistant-home-' + key, `${value}px`);
    }
  }
  const displayButton = document.getElementById('assistant-float');
  const displayLabel = floating ? '恢复自动布局' : '切换为浮动窗口';
  displayButton.title = displayLabel;
  displayButton.setAttribute('aria-label', displayLabel);
}

function initializeAssistantPolish() {
  const scope = document.getElementById('assistant-scope');
  scope.onchange = () => {
    assistantPinnedScope = null; assistantScopeKey = '';
    resetAssistantConversation(); updateAssistantScopeControl();
    document.getElementById('assistant-scope-note').textContent = `${activeMailAccount()?.user || '当前邮箱'} · 每次最多分析 20 封；仅检索已同步邮件`;
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
  document.getElementById('account-mailbox-nav').addEventListener('click', event => {
    const id = event.target.closest('[data-account-collapse]')?.dataset.accountCollapse;
    if (id) { localStorage.setItem('collapsed:' + id, localStorage.getItem('collapsed:' + id) === '1' ? '0' : '1'); renderSidebarAccounts(); [...document.querySelectorAll('[data-account-collapse]')].find(button => button.dataset.accountCollapse === id)?.focus(); }
    const managedId = event.target.closest('[data-account-manage]')?.dataset.accountManage;
    if (managedId) { showSystemView('account'); selectedManagedAccountId = managedId; renderAccountSelection(); }
    const aliasId = event.target.closest('[data-account-alias]')?.dataset.accountAlias;
    if (aliasId) { const value = prompt('邮箱显示名称（留空恢复邮箱地址）：', localStorage.getItem('alias:' + aliasId) || ''); if (value !== null) { localStorage.setItem('alias:' + aliasId, value.trim().slice(0,40)); renderSidebarAccounts(); } }
  });
  document.body.insertAdjacentHTML('beforeend', `<div id="workspace-notice" class="workspace-notice hidden" role="status" aria-live="polite"></div>
    <div id="task-center-backdrop" class="task-center-backdrop hidden"></div>
    <section id="task-center" class="task-center hidden" role="dialog" aria-modal="true" aria-labelledby="task-center-title"><header><div class="task-center-heading"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg></span><div><h2 id="task-center-title" data-i18n="task.title">任务与发件箱</h2><p data-i18n="task.subtitle">只展示进行中或需要你处理的事项</p></div></div><button type="button" id="close-task-center" aria-label="关闭任务与发件箱" data-i18n-aria="task.close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header><div id="task-center-list"><div class="task-loading"><i></i><span data-i18n="task.loading">正在读取任务状态…</span></div></div></section>
    <dialog id="reminder-dialog"><form method="dialog"><h3 data-i18n="task.remindTitle">稍后提醒</h3><label><span data-i18n="task.remindTime">提醒时间</span> <input type="datetime-local" id="reminder-time" required></label><p><button value="cancel" data-i18n="common.cancel">取消</button><button type="button" id="save-reminder" data-i18n="task.remindSave">保存提醒</button></p></form></dialog>`);
  const listHeader = document.querySelector('.list-header');
  listHeader.insertAdjacentHTML('afterend', `<div class="list-workspace-tools"><button id="btn-filter-panel" aria-expanded="false" data-i18n="filter.toggle">筛选</button><button id="btn-task-center" aria-expanded="false" aria-controls="task-center" data-i18n="task.title">任务与发件箱</button><div id="filter-chips"></div></div>`);
  const filters = document.querySelector('.mail-filter-group');
  filters.id = 'workspace-filters'; filters.classList.add('hidden'); document.querySelector('.list-workspace-tools').after(filters);
  document.getElementById('btn-filter-panel').onclick = event => { const hidden = filters.classList.toggle('hidden'); event.currentTarget.setAttribute('aria-expanded', String(!hidden)); };
  document.getElementById('btn-task-center').onclick = openTaskCenter;
  document.getElementById('close-task-center').onclick = closeTaskCenter;
  document.getElementById('task-center-backdrop').onclick = closeTaskCenter;
  document.getElementById('task-center').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeTaskCenter(); } });
  document.getElementById('filter-chips').onclick = event => {
    const key = event.target.dataset.removeFilter; if (!key) return;
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
  const themeMode = document.getElementById('theme-mode');
  themeMode.value = savedThemeMode();
  themeMode.onchange = () => {
    const mode = themeMode.value;
    try { localStorage.setItem(THEME_MODE_KEY, mode); } catch (_) {}
    applyTheme(mode);
    toast(mode === 'system' ? '已改为跟随系统主题' : `已切换为${mode === 'dark' ? '暗色' : '浅色'}主题`, 'success');
  };
  for (const [name,id] of [['theme-mode-choice','theme-mode'],['workspace-density-choice','workspace-density'],['notification-mode','notification-preference']]) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => input.onchange = () => {
      const control = document.getElementById(id); control.value = input.value; control.onchange({target:control});
    });
  }
  syncPreferenceChoices();
  document.getElementById('notification-retry-load').onclick = loadWorkspacePreferences;
  document.getElementById('semantic-enabled').onchange = async event => {
    const accountId = activeMailAccount()?.id;
    if (!accountId) { event.target.checked = false; return; }
    const enabledValue = event.target.checked;
    const status = document.getElementById('semantic-status');
    status.textContent = mailaiT('semantic.saving') || '正在保存…';
    try {
      const prefs = await api('/api/preferences', {accountId});
      await api('/api/preferences', {accountId, method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...prefs, semantic_enabled:enabledValue})});
      toast(enabledValue ? (mailaiT('semantic.enabledToast') || '已启用语义检索') : (mailaiT('semantic.disabledToast') || '已关闭语义检索'), 'success');
      loadSemanticStatus();
    } catch (error) {
      event.target.checked = !enabledValue;
      status.textContent = mailaiT('semantic.saveFailed') || '保存失败，请重试';
      toast(error.message, 'error');
    }
  };
  document.getElementById('semantic-reindex').onclick = async event => {
    const button = event.currentTarget;
    const status = document.getElementById('semantic-status');
    setLoading(button, true, mailaiT('semantic.reindexingShort') || '重建中…');
    status.textContent = mailaiT('semantic.reindexing') || '正在重建索引（首次需下载模型，请稍候）…';
    pollSemanticProgress();
    try {
      const result = await api('/api/assistant/semantic/reindex', {accountId:activeMailAccount()?.id, method:'POST'});
      toast((mailaiT('semantic.reindexed') || '语义索引已重建：{n} 封邮件').replace('{n}', result.indexed), 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      stopSemanticProgress();
      setLoading(button, false);
      loadSemanticStatus();
    }
  };
  document.getElementById('notification-preference').onchange = async event => {
    const accountId = activeMailAccount()?.id; const notification = event.target.value;
    if (!accountId || preferencesSaving || preferencesAccount !== accountId) return loadWorkspacePreferences();
    preferencesSaving = true; ++preferencesLoadRevision;
    document.getElementById('notification-options').disabled = true;
    document.getElementById('notification-save-status').textContent = '正在保存…';
    try {
      const prefs = await api('/api/preferences', {accountId});
      await api('/api/preferences', {accountId, method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...prefs, notifications:notification})});
      if (accountId === activeMailAccount()?.id) { document.getElementById('notification-save-status').textContent = '已保存'; loadAssistantAlerts(); }
    } catch (error) {
      if (accountId === activeMailAccount()?.id) {
        document.getElementById('notification-save-status').textContent = '保存失败，请重新读取后再试';
        document.getElementById('notification-retry-load').classList.remove('hidden');
        toast(error.message, 'error');
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
  document.getElementById('assistant-retry').onclick = () => askAssistant(assistantLastQuestion, assistantLastScope, assistantLastImages, assistantLastAttachments);
  document.body.classList.toggle('assistant-floating', localStorage.getItem('mailai-assistant-floating') === 'true');
  initializeAssistantPolish();
  document.getElementById('task-center-list').onclick = async event => {
    const accountId = event.currentTarget.dataset.accountId;
    try {
      if (event.target.dataset.cancelQueue) await api(`/api/mail/outbox/${event.target.dataset.cancelQueue}/cancel`, {accountId, method:'POST'});
      if (event.target.dataset.taskRefresh !== undefined) return refreshTaskCenter();
      if (event.target.dataset.syncRetry) {
        await api(event.target.dataset.syncRetry, {accountId, method:'POST'});
        startFetchMonitor();
        taskNotice('已重新开始邮箱同步');
      }
      if (event.target.dataset.outboxDraft) { const draft = await api(`/api/drafts/${event.target.dataset.outboxDraft}`, {accountId}); openCompose({...draft,account_id:accountId}); closeTaskCenter(); return; }
      if (event.target.dataset.reminderOpen) { await openAccountMailbox(accountId, 'inbox'); await revealEmailFromSource(Number(event.target.dataset.reminderOpen)); closeTaskCenter(); return; }
      if (event.target.dataset.reminderDismiss) {
        await api(event.target.dataset.taskReminder ? `/api/task-reminders/${event.target.dataset.taskReminder}` : `/api/reminders/${event.target.dataset.reminderDismiss}`, {accountId, method:'DELETE'});
        window.mailaiTasksChanged?.(accountId);
      }
      refreshTaskCenter();
    } catch (error) { toast(error.message, 'error'); }
  };
  document.getElementById('save-reminder').onclick = async () => {
    const dialog = document.getElementById('reminder-dialog');
    try { await api(`/api/emails/${dialog.dataset.emailId}/remind`, {accountId:dialog.dataset.accountId, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({at:document.getElementById('reminder-time').value})}); window.mailaiTasksChanged?.(dialog.dataset.accountId); dialog.close(); toast('提醒已保存；MailAI 运行时会提示', 'success'); }
    catch (error) { toast(error.message, 'error'); }
  };
  initializeContactGroups();
  new MutationObserver(addReadingActions).observe(document.getElementById('reading-content'), {childList:true});
  new MutationObserver(updateFilterChips).observe(document.getElementById('list-title'), {childList:true});
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { document.getElementById('task-center').classList.add('hidden'); }
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
  setInterval(() => {
    if (!document.hidden && activeMailAccount()) {
      refreshTaskCenter();
      if (preferencesAccount !== activeMailAccount()?.id) loadWorkspacePreferences();
    }
  }, 15000);
  initialLoad.then(() => { loadWorkspacePreferences(); refreshTaskCenter(); });
  updateFilterChips();
}

initializeWorkspace();
