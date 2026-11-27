/* Workspace resizers and the manually collapsed mailbox rail. */
const PANE_SIZE_KEY = 'mailai.workspace.paneSizes.v1';
const PANE_DEFAULTS = {sidebar: 226, list: 405};
const SIDEBAR_COMPACT_KEY = 'mailai.workspace.sidebarCompact.v1';
const SIDEBAR_RAIL_WIDTH = 56;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_SNAP_WIDTH = 126;

function paneSizePreferenceKey() {
  return document.body.dataset.mailListView === 'table' ? 'mailai.workspace.tablePaneSizes.v1' : PANE_SIZE_KEY;
}

function currentPaneDefaults() {
  return {...PANE_DEFAULTS, list:document.body.dataset.mailListView === 'table' ? 720 : PANE_DEFAULTS.list};
}

function readPaneSizes() {
  try { return {...currentPaneDefaults(), ...JSON.parse(localStorage.getItem(paneSizePreferenceKey()) || '{}')}; }
  catch (_) { return currentPaneDefaults(); }
}

function constrainPaneSizes(input, totalWidth) {
  const layout = document.querySelector('.layout');
  const total = totalWidth || layout?.clientWidth || window.innerWidth;
  const readingMin = Math.min(440, Math.max(360, total * .32));
  const compact = layout?.classList.contains('sidebar-compact') && innerWidth > 1024;
  const sidebarMin = compact ? SIDEBAR_RAIL_WIDTH : SIDEBAR_MIN_WIDTH;
  let sidebar = compact ? SIDEBAR_RAIL_WIDTH : Math.max(sidebarMin, Math.min(380, Number(input.sidebar) || PANE_DEFAULTS.sidebar));
  let list = Math.max(300, Math.min(720, Number(input.list) || PANE_DEFAULTS.list));
  const available = Math.max(sidebarMin + 300, total - 24 - readingMin);
  if (sidebar + list > available) list = Math.max(300, available - sidebar);
  if (sidebar + list > available) sidebar = Math.max(sidebarMin, available - list);
  return {sidebar:Math.round(sidebar), list:Math.round(list)};
}

function applyPaneSizes(sizes, persist = false, totalWidth) {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  const value = constrainPaneSizes(sizes, totalWidth);
  layout.style.setProperty('--sidebar-width', value.sidebar + 'px');
  layout.style.setProperty('--list-width', value.list + 'px');
  document.querySelector('[data-resizer="sidebar"]')?.setAttribute('aria-valuenow', value.sidebar);
  document.querySelector('[data-resizer="list"]')?.setAttribute('aria-valuenow', value.list);
  if (persist) localStorage.setItem(paneSizePreferenceKey(), JSON.stringify(sizes));
  return value;
}

function syncMailboxRail() {
  const rail = document.getElementById('mailbox-rail');
  const accounts = _systemConfig?.accounts || [];
  const accountId = selectedMailboxAccountId || activeMailAccount()?.id;
  const activeFolder = unifiedMailbox ? 'inbox' : currentServerFolder ? '' : specialMailbox || currentFilter.status;
  for (const button of rail.querySelectorAll('[data-rail-folder]')) {
    if (button.dataset.railFolder === activeFolder) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  rail.querySelector('i').hidden = !accounts.some(account =>
    (unifiedMailbox || account.id === accountId) && Number(account.unread) > 0);
}

function initPaneResizers() {
  const layout = document.querySelector('.layout');
  const sidebar = document.getElementById('mailbox-sidebar');
  const rail = document.getElementById('mailbox-rail');
  const folderToggle = document.getElementById('mailbox-rail-folders');
  const assistant = document.getElementById('mailbox-rail-assistant');
  let compact = localStorage.getItem(SIDEBAR_COMPACT_KEY) === '1';
  let cancelDrag;
  const renderCompact = value => layout.classList.toggle('sidebar-compact', value);
  const setFoldersOpen = (open, restoreFocus = false) => {
    sidebar.classList.toggle('rail-flyout', open);
    folderToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      const firstFolder = [...sidebar.querySelectorAll('#account-mailbox-nav button, #folder-nav button')]
        .find(button => button.getClientRects().length);
      firstFolder?.focus({preventScroll:true});
    } else if (restoreFocus) folderToggle.focus({preventScroll:true});
  };
  renderCompact(compact);
  let preferredSizes = readPaneSizes();
  let sizes = applyPaneSizes(preferredSizes);
  const commit = (preferred, collapsed) => {
    if (compact !== collapsed) localStorage.setItem(SIDEBAR_COMPACT_KEY, collapsed ? '1' : '0');
    compact = collapsed;
    renderCompact(compact);
    preferredSizes = preferred;
    sizes = applyPaneSizes(preferredSizes, true);
    if (!compact) setFoldersOpen(false);
    window.mailaiAssistantDivider?.update();
  };
  folderToggle.onclick = () => setFoldersOpen(!sidebar.classList.contains('rail-flyout'), true);
  rail.addEventListener('click', event => {
    const folder = event.target.closest('[data-rail-folder]')?.dataset.railFolder;
    if (!folder) return;
    setFoldersOpen(false);
    const accounts = _systemConfig?.accounts || [];
    const account = activeMailAccount();
    const open = folder === 'inbox' && accounts.length > 1
      ? openUnifiedInbox()
      : account ? openAccountMailbox(account.id, folder, {fromStart:folder === 'inbox'}) : null;
    open?.catch(error => toast(mailaiText('打开邮箱失败：') + mailaiSystemMessage(error.message), 'error'));
  });
  assistant.onclick = () => {
    setFoldersOpen(false);
    if (document.body.classList.contains('assistant-visible')) closeAssistant();
    else openAssistant();
  };
  new MutationObserver(() => {
    const open = String(document.body.classList.contains('assistant-visible'));
    if (assistant.getAttribute('aria-expanded') !== open) assistant.setAttribute('aria-expanded', open);
  }).observe(document.body, {attributes:true, attributeFilter:['class']});
  const closeOutside = event => {
    if (sidebar.classList.contains('rail-flyout') && !sidebar.contains(event.target) && !rail.contains(event.target))
      setFoldersOpen(false);
  };
  document.addEventListener('pointerdown', closeOutside);
  document.addEventListener('focusin', closeOutside);
  sidebar.addEventListener('click', event => {
    if (sidebar.classList.contains('rail-flyout') &&
        event.target.closest('[data-account-action], [data-mobile-action], [data-server-folder], .nav-item[data-filter="status"], .nav-item[data-filter="special"]'))
      setFoldersOpen(false, true);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const closeFolders = sidebar.classList.contains('rail-flyout') && !sidebar.querySelector('.account-menu[open]');
    if (!cancelDrag && !closeFolders) return;
    event.preventDefault();
    event.stopPropagation();
    if (cancelDrag) cancelDrag();
    else setFoldersOpen(false, true);
  }, true);
  document.querySelectorAll('.pane-resizer').forEach(handle => {
    const kind = handle.dataset.resizer;
    const isSidebar = kind === 'sidebar';
    handle.setAttribute('aria-valuemin', isSidebar ? String(SIDEBAR_RAIL_WIDTH) : '300');
    handle.setAttribute('aria-valuemax', kind === 'sidebar' ? '380' : '720');
    handle.addEventListener('pointerdown', event => {
      if (window.innerWidth <= 1024 || event.button !== 0 || cancelDrag) return;
      event.preventDefault();
      handle.focus({preventScroll:true});
      const startX = event.clientX;
      const startWidth = sizes[kind];
      // Cache geometry before writes and coalesce pointer bursts per frame.
      const totalWidth = layout.clientWidth;
      const scale = layout.getBoundingClientRect().width / totalWidth || 1;
      const pointerId = event.pointerId;
      let latestX = startX, frame = 0, candidate = preferredSizes, collapsed = compact;
      const flush = () => {
        frame = 0;
        const width = startWidth + (latestX - startX) / scale;
        collapsed = isSidebar ? width < SIDEBAR_SNAP_WIDTH : compact;
        candidate = isSidebar && collapsed ? preferredSizes : {...preferredSizes, [kind]:width};
        renderCompact(collapsed);
        sizes = applyPaneSizes(candidate, false, totalWidth);
      };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging'); document.body.classList.add('pane-resizing');
      const move = moveEvent => {
        if (moveEvent.pointerId !== pointerId) return;
        latestX = moveEvent.clientX;
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const finish = save => {
        cancelAnimationFrame(frame);
        cancelDrag = null;
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        handle.removeEventListener('lostpointercapture', end);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        handle.removeEventListener('pointermove', move);
        handle.classList.remove('dragging'); document.body.classList.remove('pane-resizing');
        if (save && Math.abs(latestX - startX) > 2) {
          flush();
          commit(isSidebar && collapsed ? preferredSizes : {...preferredSizes, [kind]:sizes[kind]}, collapsed);
        } else {
          renderCompact(compact);
          sizes = applyPaneSizes(preferredSizes);
        }
      };
      const end = endEvent => {
        if (endEvent.pointerId !== pointerId) return;
        const released = endEvent.type === 'pointerup';
        if (released) latestX = endEvent.clientX;
        finish(released);
      };
      cancelDrag = () => finish(false);
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('lostpointercapture', end);
    });
    handle.addEventListener('dblclick', () => {
      commit({...preferredSizes, [kind]:currentPaneDefaults()[kind]}, isSidebar ? false : compact);
      toast(mailaiText('已恢复默认栏宽'), 'success');
    });
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight'].includes(event.key) &&
          !(isSidebar && ['Home','End','Enter'].includes(event.key))) return;
      event.preventDefault();
      const width = sizes[kind] + (event.key === 'ArrowRight' ? 16 : -16);
      if (!isSidebar) commit({...preferredSizes, list:Math.max(300, Math.min(720,width))}, compact);
      else if (event.key === 'Home' || event.key === 'Enter' && !compact || event.key === 'ArrowLeft' && width < SIDEBAR_MIN_WIDTH)
        commit(preferredSizes, true);
      else if (compact) commit(preferredSizes, false);
      else commit({...preferredSizes, sidebar:event.key === 'End' ? 380 : Math.min(380,width)}, false);
    });
  });
  window.addEventListener('mailai:list-view-changed', () => { preferredSizes = readPaneSizes(); sizes = applyPaneSizes(preferredSizes); });
  window.addEventListener('resize', () => {
    cancelDrag?.();
    if (innerWidth <= 1024) setFoldersOpen(false);
    sizes = applyPaneSizes(preferredSizes);
  });
  window.mailaiMailboxRail = {sync:syncMailboxRail};
  syncMailboxRail();
}

initPaneResizers();

globalThis.MailAIModules?.register('paneResizers', {
  readPaneSizes,
  constrainPaneSizes,
  applyPaneSizes,
  initPaneResizers,
});
