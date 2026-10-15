/* Remove the idle native scrollbar: WKWebView can ignore transparent thumb
   colors. Reserve its measured width so the contents never shift. */
(() => {
  const view = document.getElementById('system-view');
  if (!view) return;
  let active = null, timer, dragging = false;
  const hide = () => { clearTimeout(timer); active?.classList.remove('scrollbar-visible'); active = null; };
  const panelFor = target => target instanceof Element ? target.closest('#system-view > .system-panel') : null;
  const overflows = panel => panel.scrollHeight > panel.clientHeight || panel.scrollWidth > panel.clientWidth;
  const panels = [...view.querySelectorAll(':scope > .system-panel')];
  // A persistent overflow probe avoids older WKWebView deferring native gutter
  // creation until the first real scroll. Never toggle the live panel to measure.
  const probe = document.createElement('div');
  probe.className = 'settings-scrollbar-probe';
  probe.setAttribute('aria-hidden', 'true');
  document.body.append(probe);
  const measure = panel => {
    if (!panel.getClientRects().length || !panel.clientHeight) return;
    const nativeSize = Math.max(0, probe.offsetWidth - probe.clientWidth);
    const customSize = parseFloat(getComputedStyle(probe, '::-webkit-scrollbar').width) || 0;
    const size = CSS.supports('scrollbar-width', 'thin') ? nativeSize : Math.max(nativeSize, customSize);
    panel.style.setProperty('--settings-scrollbar-size', `${size}px`);
  };
  const resize = new ResizeObserver(() => panels.forEach(measure));
  panels.forEach(panel => resize.observe(panel));
  resize.observe(probe);
  const atEdge = (panel, event) => {
    const rect = panel.getBoundingClientRect();
    return event.clientX >= rect.right - 16 && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  };
  const reveal = panel => {
    if (!overflows(panel)) return;
    if (active !== panel) hide();
    measure(panel);
    active = panel; clearTimeout(timer); panel.classList.add('scrollbar-visible');
    timer = setTimeout(() => { if (!dragging) hide(); }, 900);
  };
  view.addEventListener('scroll', event => { const panel = panelFor(event.target); if (panel) reveal(panel); }, {capture:true, passive:true});
  view.addEventListener('pointermove', event => { const panel = panelFor(event.target); if (panel && atEdge(panel, event)) reveal(panel); }, {passive:true});
  view.addEventListener('pointerdown', event => {
    const panel = panelFor(event.target);
    if (event.button === 0 && panel && atEdge(panel, event) && overflows(panel)) { dragging = true; reveal(panel); }
  }, {passive:true});
  const release = () => { if (dragging) { dragging = false; if (active) reveal(active); } };
  window.addEventListener('pointermove', event => { if (dragging && !(event.buttons & 1)) release(); }, {capture:true, passive:true});
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', () => { dragging = false; hide(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { dragging = false; hide(); } });
  view.addEventListener('click', event => { if (event.target.closest('[data-system-tab],#btn-close-system')) { dragging = false; hide(); } });
})();

/* Todo list: scrolling reveals the thumb; idle fades back to a clear gutter. */
(() => {
  const list = document.getElementById('todo-list');
  if (!list) return;
  let timer, dragging = false;
  const hide = () => { clearTimeout(timer); list.classList.remove('scrollbar-visible'); };
  const show = () => {
    clearTimeout(timer);
    list.classList.add('scrollbar-visible');
    timer = setTimeout(() => { if (!dragging) hide(); }, 900);
  };
  list.addEventListener('scroll', show, {passive:true});
  list.addEventListener('pointerdown', event => {
    const rect = list.getBoundingClientRect();
    if (event.clientX >= rect.right - 14 && list.scrollHeight > list.clientHeight) {
      dragging = true; show();
    }
  }, {passive:true});
  const release = () => { if (dragging) { dragging = false; show(); } };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', () => { dragging = false; hide(); });
})();
