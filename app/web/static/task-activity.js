/* Foreground task indicator; reads local status only, without opening mailboxes. */
(() => {
  const states = new Map(), revisions = new Map();
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
      node.classList.toggle('task-activity-running', Boolean(state?.active));
      if (node.id !== 'btn-task-center') continue;
      const label = mailaiT('task.title') || '任务与发件箱';
      const details = [state?.active ? mailaiTemplate`${state.active} 项进行中` : '',
        state?.attention ? mailaiTemplate`${state.attention} 项需处理` : '', state?.unknown ? mailaiText('状态待确认') : ''].filter(Boolean);
      node.title = [label, ...details].join(' · ');
      node.setAttribute('aria-label', node.title);
      const badge = node.querySelector('[data-task-count]');
      if (badge) { badge.textContent = (state?.active || 0) + (state?.attention || 0); badge.hidden = !Number(badge.textContent); }
    }
  }
  function update(accountId, state) {
    revisions.set(accountId, (revisions.get(accountId) || 0) + 1);
    states.set(accountId, state);
    paint();
  }
  function counts(rows, sync, actions, purge) {
    const visible = actionableOutboxRows(Array.isArray(rows) ? rows : []);
    const changes = Array.isArray(actions.rows) ? actions.rows : [];
    return {
      active: visible.filter(row => ['queued','sending'].includes(row.status)).length +
        (sync.running ? 1 : 0) + (purge.pending ? 1 : 0) +
        (changes.some(row => !row.paused && !row.pending_error) ? 1 : 0),
      attention: visible.filter(row => ['failed','unknown'].includes(row.status)).length +
        (!sync.running && (sync.error || sync.canceled || sync.resumable) ? 1 : 0) +
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
    try {
      const results = await Promise.allSettled([
        '/api/mail/outbox', '/api/fetch_status', '/api/mail/action-sync', '/api/trash/purge/status',
      ].map(path => api(path, {accountId})));
      if (revision !== (revisions.get(accountId) || 0)) return;
      const [rows, sync, actions, purge] = results.map(result => result.status === 'fulfilled' ? result.value : {});
      update(accountId, {...counts(rows || [], sync || {}, actions || {}, purge || {}),
        unknown:results.some(result => result.status === 'rejected')});
    } finally {
      reading = false;
      if (owner() !== accountId) refresh();
    }
  }
  function visibility() {
    document.documentElement.classList.toggle('task-activity-background', document.hidden || !document.hasFocus());
  }
  window.mailaiTaskActivity = {update, refresh, scopeChanged() { paint(); refresh(); }};
  if (window.mailaiEnergy) window.mailaiEnergy.register('task-activity', refresh, 5000,
    () => Boolean(owner()) && document.getElementById('task-center')?.classList.contains('hidden'));
  initialLoad.then(() => { paint(); refresh(); });
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', visibility);
  window.addEventListener('focus', visibility);
  visibility();
})();
