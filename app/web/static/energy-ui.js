/* One foreground heartbeat for optional UI work. Sending and reminder delivery
 * stay in the backend and do not depend on the window being visible. */
(() => {
  const jobs = new Map();
  let timer = 0, paused = false, nativeHidden = false, nativeRevision = -1;
  const active = () => !paused && !nativeHidden && !document.hidden && (!document.hasFocus || document.hasFocus());
  const enabled = job => active() && (!job.visible || job.visible());
  const schedule = () => {
    clearTimeout(timer); timer = 0;
    if (!active()) return;
    const due = [...jobs.values()].filter(job => enabled(job) && !job.running).map(job => job.force ? Date.now() : job.next);
    if (due.length) timer = setTimeout(tick, Math.max(100, Math.min(...due) - Date.now()));
  };
  const run = async (job, force = false) => {
    job.force = job.force || force;
    if (job.running || !enabled(job)) return;
    job.running = true;
    job.next = Date.now() + job.interval;
    const requested = job.force; job.force = false;
    try { await job.callback(requested); }
    catch (error) { console.warn('后台界面更新未完成', error.message); }
    finally { job.running = false; schedule(); }
  };
  const tick = () => {
    const now = Date.now();
    for (const job of jobs.values()) if ((job.force || job.next <= now) && enabled(job)) run(job);
    schedule();
  };
  window.mailaiEnergy = {
    active,
    register(name, callback, interval, visible) {
      jobs.set(name, {callback, interval, visible, next:Date.now()+interval, running:false}); schedule();
    },
    run(name, force = false) { const job = jobs.get(name); if (job) return run(job, force); },
    pause() { paused = true; clearTimeout(timer); timer = 0; },
    resume() { paused = false; for (const job of jobs.values()) run(job, true); schedule(); },
    nativeVisibility(revision, visible) {
      if (revision < nativeRevision) return;
      nativeRevision = revision; nativeHidden = !visible;
      if (visible) window.mailaiEnergy.resume();
      else window.mailaiEnergy.pause();
    },
    reschedule(name, delay) {
      const job = jobs.get(name);
      if (job) { job.next = Date.now() + Math.max(100, delay); schedule(); }
    },
    refresh: schedule,
  };
  const observe = new MutationObserver(schedule);
  for (const node of document.querySelectorAll('.layout,#task-center')) observe.observe(node,{attributes:true,attributeFilter:['class']});
  observe.observe(document.body,{attributes:true,attributeFilter:['class']});
  const accounts=document.getElementById('account-mailbox-nav');
  if (accounts) observe.observe(accounts,{childList:true});
  window.addEventListener('blur', () => { clearTimeout(timer); timer=0; });
  window.addEventListener('focus', () => window.mailaiEnergy.resume());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timer); timer=0; }
    else window.mailaiEnergy.resume();
  });
})();
