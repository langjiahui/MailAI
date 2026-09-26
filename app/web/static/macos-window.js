// The native titlebar keeps its system hit targets; only its appearance changes.
(() => {
  let revision = 0;
  let pending = Promise.resolve();
  let regionFrame;
  function updateDragRegion() {
    cancelAnimationFrame(regionFrame);
    regionFrame = requestAnimationFrame(() => {
      if (!document.documentElement.classList.contains('macos-native-window')) return;
      const sidebar = document.querySelector('.layout > .sidebar');
      if (sidebar && sidebar.getBoundingClientRect().width) {
        const style = getComputedStyle(sidebar);
        const width = parseFloat(style.width);
        if (Number.isFinite(width)) {
          document.documentElement.style.setProperty('--mac-sidebar-width', `${width}px`);
          document.documentElement.style.setProperty('--mac-rail-width', style.position === 'fixed' ? '0px' : `${width}px`);
        }
      }
      const rect = document.querySelector('.topbar .brand')?.getBoundingClientRect();
      if (rect?.width) {
        // Native drag/double-click applies to empty header space, never controls.
        const occupied = [...header.querySelectorAll('.global-search,button,input,select,a,[role=button]')]
          .map(el => el.getBoundingClientRect()).filter(r => r.width && r.height)
          .sort((a,b) => a.left - b.left);
        const gaps = [];
        let edge = 108; // Native traffic lights use physical points, independent of font zoom.
        for (const r of occupied) {
          if (r.left > edge) gaps.push([edge, Math.min(r.left, innerWidth)]);
          edge = Math.max(edge, r.right);
        }
        if (edge < innerWidth) gaps.push([edge, innerWidth]);
        window.pywebview?.api?.set_window_drag_region?.(rect.left, rect.right, innerWidth, gaps)?.catch(() => {});
      }
    });
  }
  const header = document.querySelector('.topbar');
  if (header) new ResizeObserver(updateDragRegion).observe(header);
  const sidebar = document.querySelector('.layout > .sidebar');
  if (sidebar) new ResizeObserver(updateDragRegion).observe(sidebar);
  window.addEventListener('resize', updateDragRegion);
  window.addEventListener('mailai:native-fullscreen', event => {
    const root = document.documentElement;
    if (!root.classList.contains('macos-native-window')) return;
    root.classList.toggle('macos-native-fullscreen', event.detail?.fullscreen === true);
    updateDragRegion();
  });
  async function syncNativeTheme() {
    const method = window.pywebview?.api?.set_window_theme;
    if (!method) return;
    const token = ++revision;
    try {
      const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      const mode = document.documentElement.dataset.themeMode || 'system';
      pending = pending.catch(() => {}).then(() => token === revision ? method(theme, mode) : null);
      const result = await pending;
      if (token === revision && result?.ok) {
        document.documentElement.classList.add('macos-native-window');
        updateDragRegion();
      }
    } catch (_) { /* A missing/older desktop bridge keeps the standard web canvas. */ }
  }
  window.addEventListener('pywebviewready', syncNativeTheme);
  document.addEventListener('mailai:themechange', syncNativeTheme);
  syncNativeTheme();
})();
