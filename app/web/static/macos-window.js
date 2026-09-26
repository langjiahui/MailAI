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
      if (rect?.width) window.pywebview?.api?.set_window_drag_region?.(rect.left, rect.right, window.innerWidth)?.catch(() => {});
    });
  }
  const header = document.querySelector('.topbar');
  if (header) new ResizeObserver(updateDragRegion).observe(header);
  const sidebar = document.querySelector('.layout > .sidebar');
  if (sidebar) new ResizeObserver(updateDragRegion).observe(sidebar);
  window.addEventListener('resize', updateDragRegion);
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
