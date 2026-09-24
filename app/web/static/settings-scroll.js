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
