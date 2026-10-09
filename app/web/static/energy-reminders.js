/* In-app reminders remain independent of the task-center panel. A single,
 * lightweight read is scheduled at the nearest deadline, with a safety refresh. */
(() => {
  let revision = 0, account = '';
  const owner = () => activeMailAccount()?.id || '';
  function notifyDue(items) {
    const due = items.filter(item => new Date(item.at).getTime() <= Date.now()).filter(item => {
      const key = 'reminder:' + item.account_id + ':' + (item.todo_id || item.email_id) + ':' + item.at;
      if (sessionStorage.getItem(key)) return false;
      sessionStorage.setItem(key, '1');
      return true;
    });
    if (due.length) taskNotice(due.length + mailaiText(' 项待办已到提醒时间'), mailaiText('查看提醒'),
      () => window.mailaiOpenTaskReminder?.(), 8000);
  }
  async function refresh() {
    const id = owner(), ticket = ++revision;
    if (!id) return;
    account = id;
    try {
      const items = await api('/api/reminders/all', {accountId:id});
      if (ticket !== revision || id !== owner() || account !== id) return;
      if (!window.mailaiEnergy.active()) {
        window.mailaiEnergy.run('reminders', true);
        return; // Do not consume the alert while its window is hidden.
      }
      // Always verify against saved tasks before showing an alert; canceled or
      // rescheduled tasks must not be revived from a stale browser cache.
      notifyDue(items);
      const times = items.map(item => new Date(item.at).getTime()).filter(at => at > Date.now());
      window.mailaiEnergy.reschedule('reminders', times.length
        ? Math.min(60000, Math.min(...times) - Date.now()) : 60000);
    } catch (_) {
      // Keep the scheduled safety retry; failed reads never imply "no reminders".
    }
  }
  window.mailaiEnergy.register('reminders', refresh, 60000, () => Boolean(owner()));
  window.addEventListener('mailai-tasks-changed', () => {
    ++revision;
    window.mailaiEnergy.run('reminders', true);
  });
  initialLoad.then(() => window.mailaiEnergy.run('reminders', true));
})();
