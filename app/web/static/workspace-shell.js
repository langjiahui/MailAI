// Keep the toolbar's search and gradient aligned with the resizable mail panes.
(() => {
  const root = document.documentElement;
  const layout = document.querySelector('.layout');
  const list = layout?.querySelector(':scope > .list-pane');
  const reading = layout?.querySelector(':scope > .reading-pane');
  if (!list || !reading) return;
  let frame;
  function update() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const width = parseFloat(getComputedStyle(list).width);
      if (!list.getBoundingClientRect().width || !Number.isFinite(width)) return;
      const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
      root.style.setProperty('--workspace-list-inset', getComputedStyle(list.querySelector('.list-header')).paddingLeft);
      root.style.setProperty('--workspace-list-width', `${width}px`);
      root.style.setProperty('--workspace-reading-left', `${reading.getBoundingClientRect().left / zoom}px`);
    });
  }
  const sizes = new ResizeObserver(update);
  sizes.observe(layout);
  sizes.observe(list);
  sizes.observe(reading);
  window.addEventListener('resize', update);
  update();
})();
