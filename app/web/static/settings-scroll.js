/* Keep the native draggable scrollbar, revealing it only on intent. */
(() => {
  const view = document.getElementById('system-view');
  if (!view) return;
  view.querySelectorAll(':scope > .system-panel').forEach(panel => {
    let timer;
    let nearEdge = false;
    let dragging = false;
    const show = () => {
      clearTimeout(timer);
      panel.classList.add('scrollbar-visible');
      timer = setTimeout(() => {
        if (!nearEdge && !dragging) panel.classList.remove('scrollbar-visible');
      }, 800);
    };
    panel.addEventListener('scroll', show, {passive:true});
    panel.addEventListener('pointermove', event => {
      const rect = panel.getBoundingClientRect();
      const wasNearEdge = nearEdge;
      nearEdge = rect.right - event.clientX < 20;
      if (nearEdge || wasNearEdge) show();
    }, {passive:true});
    panel.addEventListener('pointerleave', () => { nearEdge = false; if (panel.classList.contains('scrollbar-visible')) show(); });
    panel.addEventListener('pointerdown', () => { if (nearEdge) { dragging = true; show(); } });
    window.addEventListener('pointerup', () => { if (dragging) { dragging = false; show(); } });
    window.addEventListener('blur', () => { dragging = nearEdge = false; clearTimeout(timer); panel.classList.remove('scrollbar-visible'); });
  });
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
