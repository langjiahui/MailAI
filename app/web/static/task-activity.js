/* Foreground task indicator; reads local status only, without opening mailboxes. */
(() => {
  const states = new Map(), syncStates = new Map(), revisions = new Map();
  let reading = false;
  const owner = () => activeMailAccount()?.id || '';
  function paint() {
    const current = owner();
    for (const [node, accountId] of [
      [document.getElementById('btn-task-center'), current],
      [document.getElementById('task-center'), taskCenterScope()],
    ]) {
      if (!node) continue;
      const state = states.get(accountId);
      const sync = syncStates.get(accountId) || {};
      const attention = (state?.attention || 0) + Number(taskSyncNeedsAttention(sync));
      node.classList.toggle('task-activity-running', Boolean(state?.active));
      if (node.id !== 'btn-task-center') continue;
      const label = mailaiT('task.title') || '任务与发件箱';
      const details = [sync.running ? mailaiText('同步中') : '',
        state?.active ? mailaiTemplate`${state.active} 项进行中` : '',
        attention ? mailaiTemplate`${attention} 项需处理` : '', state?.unknown ? mailaiText('状态待确认') : ''].filter(Boolean);
      node.title = [label, ...details].join(' · ');
      node.setAttribute('aria-label', node.title);
      const badge = node.querySelector('[data-task-count]');
      if (badge) { badge.textContent = attention; badge.hidden = !attention; }
      const indicator = node.querySelector('[data-task-sync-indicator]');
      if (indicator) indicator.hidden = !sync.running || sync.canceled;
    }
  }
  function update(accountId, state) {
    revisions.set(accountId, (revisions.get(accountId) || 0) + 1);
    states.set(accountId, state);
    paint();
  }
  function setSync(accountId, sync) {
    syncStates.set(accountId, sync);
    paint();
    if (accountId === owner()) renderFolderSyncHint();
  }
  function counts(rows, actions, purge) {
    const visible = actionableOutboxRows(Array.isArray(rows) ? rows : []);
    const changes = Array.isArray(actions.rows) ? actions.rows : [];
    return {
      active: visible.filter(row => ['queued','sending'].includes(row.status)).length +
        (purge.pending ? 1 : 0) +
        (changes.some(row => !row.paused && !row.pending_error) ? 1 : 0),
      attention: visible.filter(row => ['failed','unknown'].includes(row.status) || outboxNeedsAttention(row)).length +
        (purge.unacknowledged || purge.cleanup_pending ? 1 : 0) +
        changes.filter(row => row.pending_error && !row.paused).length,
    };
  }
  async function refresh() {
    const accountId = owner();
    if (!accountId || reading || document.hidden ||
        !document.getElementById('task-center')?.classList.contains('hidden')) return;
    reading = true;
    const revision = revisions.get(accountId) || 0;
    const previousSync = syncStates.get(accountId);
    try {
      const results = await Promise.allSettled([
        '/api/mail/outbox', '/api/fetch_status', '/api/mail/action-sync', '/api/trash/purge/status',
      ].map(path => api(path, {accountId})));
      if (revision !== (revisions.get(accountId) || 0)) return;
      const [rows, sync, actions, purge] = results.map(result => result.status === 'fulfilled' ? result.value : {});
      if (results[1].status === 'fulfilled' && previousSync === syncStates.get(accountId)) setSync(accountId, sync);
      update(accountId, {...counts(rows || [], actions || {}, purge || {}),
        unknown:results.some(result => result.status === 'rejected')});
    } finally {
      reading = false;
      if (owner() !== accountId) refresh();
    }
  }
  function visibility() {
    document.documentElement.classList.toggle('task-activity-background', document.hidden || !document.hasFocus());
  }
  window.mailaiTaskActivity = {update, setSync, refresh, syncState(accountId) { return syncStates.get(accountId); },
    scopeChanged() { paint(); renderFolderSyncHint(); refresh(); }};
  if (window.mailaiEnergy) window.mailaiEnergy.register('task-activity', refresh, 5000,
    () => Boolean(owner()) && document.getElementById('task-center')?.classList.contains('hidden'));
  initialLoad.then(() => { paint(); refresh(); });
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('mailai:language-changed', paint);
  window.addEventListener('blur', visibility);
  window.addEventListener('focus', visibility);
  visibility();
})();
