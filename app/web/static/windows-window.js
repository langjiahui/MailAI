// Windows retains its native caption, Snap, resize edges and system menu.
(() => {
  const root = document.documentElement;
  if (!root.classList.contains('windows-native-window')) return;
  const header = document.querySelector('.topbar');
  let regionFrame, pendingTheme = Promise.resolve(), themeRevision = 0, acting = false;
  const fullscreenButton = document.createElement('button');
  fullscreenButton.id = 'btn-window-fullscreen';
  fullscreenButton.type = 'button';
  fullscreenButton.className = 'nav-action';
  fullscreenButton.hidden = true;
  const enterIcon = '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>';
  const exitIcon = '<path d="M3 8h5V3M16 3v5h5M8 21v-5H3M21 16h-5v5"/>';
  function showState(state) {
    if (!state?.ok) return;
    root.classList.toggle('windows-native-fullscreen', state.fullscreen === true);
    fullscreenButton.hidden = false;
    fullscreenButton.setAttribute('aria-pressed', String(state.fullscreen === true));
    const english = root.lang?.startsWith('en');
    const label = state.fullscreen ? (english ? 'Exit full screen (F11)' : '退出全屏（F11）') : (english ? 'Full screen (F11)' : '全屏（F11）');
    fullscreenButton.title = label;
    fullscreenButton.setAttribute('aria-label', label);
    fullscreenButton.innerHTML = `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${state.fullscreen ? exitIcon : enterIcon}</svg>`;
  }
  header?.querySelector('.global-actions')?.append(fullscreenButton);
  function alignWorkspace() {
    cancelAnimationFrame(regionFrame);
    regionFrame = requestAnimationFrame(() => {
      const sidebar = document.querySelector('.layout>.sidebar');
      if (!sidebar) return;
      const style = getComputedStyle(sidebar), width = parseFloat(style.width);
      if (Number.isFinite(width)) {
        root.style.setProperty('--mac-sidebar-width', `${width}px`);
        root.style.setProperty('--mac-rail-width', style.position === 'fixed' ? '0px' : `${width}px`);
      }
    });
  }
  const sidebar = document.querySelector('.layout>.sidebar');
  if (sidebar) new ResizeObserver(alignWorkspace).observe(sidebar);
  window.addEventListener('resize', alignWorkspace);
  alignWorkspace();
  async function act(action) {
    const method = window.pywebview?.api?.[action];
    if (!method || acting) return;
    acting = true;
    try { showState(await method()); } catch (_) { /* Native controls remain available. */ }
    finally { acting = false; }
  }
  header?.addEventListener('dblclick', event => {
    if (event.button !== 0 || event.target.closest('button,input,select,a,[role=button],.global-search')) return;
    if (root.classList.contains('windows-native-fullscreen')) return;
    event.preventDefault();
    act('toggle_window_maximized');
  });
  fullscreenButton.addEventListener('click', () => act('toggle_window_fullscreen'));
  document.addEventListener('keydown', event => {
    if (event.key !== 'F11' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return;
    if (!window.pywebview?.api?.toggle_window_fullscreen) return;
    event.preventDefault();
    if (!event.repeat) act('toggle_window_fullscreen');
  });
  async function syncTheme() {
    const method = window.pywebview?.api?.set_window_theme;
    if (!method) return;
    const revision = ++themeRevision, theme = root.dataset.theme === 'dark' ? 'dark' : 'light';
    const mode = root.dataset.themeMode || 'system';
    pendingTheme = pendingTheme.catch(() => {}).then(() => revision === themeRevision ? method(theme, mode) : null);
    try { await pendingTheme; } catch (_) { /* Windows 10 may retain the OS caption colors. */ }
  }
  function ready() { syncTheme(); act('get_window_state'); }
  document.addEventListener('mailai:themechange', syncTheme);
  window.addEventListener('pywebviewready', ready);
  ready();
})();
