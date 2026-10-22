// The native titlebar keeps its system hit targets; only its appearance changes.
(() => {
  if (document.documentElement.classList.contains('windows-native-window')) return;
  let revision = 0;
  let pending = Promise.resolve();
  let dragRevision = 0, pendingDrag = Promise.resolve(), lastDragRegion = '';
  let regionFrame;
  function updateDragRegion() {
    cancelAnimationFrame(regionFrame);
    regionFrame = requestAnimationFrame(() => {
      if (!document.documentElement.matches('.macos-native-window,.integrated-workspace')) return;
      const sidebar = document.querySelector('.layout > .sidebar');
      if (sidebar && sidebar.getBoundingClientRect().width) {
        const style = getComputedStyle(sidebar);
        const width = parseFloat(style.width);
        if (Number.isFinite(width)) {
          document.documentElement.style.setProperty('--mac-sidebar-width', `${width}px`);
          document.documentElement.style.setProperty('--mac-rail-width', style.position === 'fixed' ? '0px' : `${width}px`);
        }
      }
      if (!document.documentElement.classList.contains('macos-native-window')) return;
      const rect = document.querySelector('.topbar .brand')?.getBoundingClientRect();
      if (rect?.width) {
        // Native drag/double-click applies to empty header space, never controls.
        const occupied = [...header.querySelectorAll('.global-search,button,input,select,a,[role=button]')]
          .map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
        // The floating pet lives outside the header DOM, but can be docked over
        // its native hit layer. Exclude its button even in the top 5px drag strip.
        const excluded = [], pet = document.getElementById('assistant-orb');
        if (pet) {
          const box = pet.getBoundingClientRect(), style = getComputedStyle(pet);
          const topbar = header.getBoundingClientRect();
          if (box.width && box.height && style.visibility !== 'hidden' && style.pointerEvents !== 'none'
              && box.bottom > topbar.top && box.top < topbar.bottom) {
            const left = Math.max(0, box.left - 4), right = Math.min(innerWidth, box.right + 4);
            if (right > left) { excluded.push([left, right]); occupied.push({left, right}); }
          }
        }
        occupied.sort((a,b) => a.left - b.left);
        const gaps = [];
        let edge = 108; // Native traffic lights use physical points, independent of font zoom.
        for (const r of occupied) {
          if (r.left > edge) gaps.push([edge, Math.min(r.left, innerWidth)]);
          edge = Math.max(edge, r.right);
        }
        if (edge < innerWidth) gaps.push([edge, innerWidth]);
        const method = window.pywebview?.api?.set_window_drag_region;
        const region = [rect.left, rect.right, innerWidth, gaps, excluded], signature = JSON.stringify(region);
        if (method && signature !== lastDragRegion) {
          const token = ++dragRevision; lastDragRegion = signature;
          // Native bridge calls can finish out of order during a drag. Apply
          // only the latest queued geometry after the previous call settles.
          pendingDrag = pendingDrag.catch(() => {}).then(() => token === dragRevision ? method(...region) : null)
            .catch(() => { if (token === dragRevision) lastDragRegion = ''; });
        }
      }
    });
  }
  const header = document.querySelector('.topbar');
  if (header) new ResizeObserver(updateDragRegion).observe(header);
  const sidebar = document.querySelector('.layout > .sidebar');
  if (sidebar) new ResizeObserver(updateDragRegion).observe(sidebar);
  const petRoot = document.getElementById('mail-assistant'), pet = document.getElementById('assistant-orb');
  if (petRoot) new MutationObserver(updateDragRegion).observe(petRoot, {attributes:true, attributeFilter:['style','class','data-pet-dock']});
  if (pet) new ResizeObserver(updateDragRegion).observe(pet);
  // Font zoom and opening/closing chat also change the pet's native hit target.
  new MutationObserver(updateDragRegion).observe(document.body, {attributes:true, attributeFilter:['class','style']});
  window.addEventListener('resize', updateDragRegion);
  updateDragRegion();
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
        document.documentElement.classList.add('desktop-native-window', 'macos-native-window');
        updateDragRegion();
      }
    } catch (_) { /* A missing/older desktop bridge keeps the standard web canvas. */ }
  }
  window.addEventListener('pywebviewready', syncNativeTheme);
  document.addEventListener('mailai:themechange', syncNativeTheme);
  syncNativeTheme();
})();
