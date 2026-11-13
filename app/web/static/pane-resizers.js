/* Three-pane workspace resizer handles, constraints, and persistence. */
const PANE_SIZE_KEY = 'mailai.workspace.paneSizes.v1';
const PANE_DEFAULTS = {sidebar: 226, list: 405};

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
  let sidebar = Math.max(180, Math.min(380, Number(input.sidebar) || PANE_DEFAULTS.sidebar));
  let list = Math.max(300, Math.min(720, Number(input.list) || PANE_DEFAULTS.list));
  const available = Math.max(480, total - 24 - readingMin);
  if (sidebar + list > available) list = Math.max(300, available - sidebar);
  if (sidebar + list > available) sidebar = Math.max(180, available - list);
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
  if (persist) localStorage.setItem(paneSizePreferenceKey(), JSON.stringify(value));
  return value;
}

function initPaneResizers() {
  let preferredSizes = readPaneSizes();
  let sizes = applyPaneSizes(preferredSizes);
  document.querySelectorAll('.pane-resizer').forEach(handle => {
    const kind = handle.dataset.resizer;
    handle.setAttribute('aria-valuemin', kind === 'sidebar' ? '180' : '300');
    handle.setAttribute('aria-valuemax', kind === 'sidebar' ? '380' : '720');
    handle.addEventListener('pointerdown', event => {
      if (window.innerWidth <= 1024 || event.button !== 0 || handle.classList.contains('dragging')) return;
      event.preventDefault();
      const startX = event.clientX;
      const start = {...sizes};
      const layout = document.querySelector('.layout');
      // Cache geometry before writes and coalesce pointer bursts per frame.
      const totalWidth = layout.clientWidth;
      const scale = layout.getBoundingClientRect().width / totalWidth || 1;
      const pointerId = event.pointerId;
      let latestX = startX, frame = 0;
      const flush = () => {
        frame = 0;
        sizes = applyPaneSizes({...start, [kind]:start[kind] + (latestX - startX) / scale}, false, totalWidth);
      };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging'); document.body.classList.add('pane-resizing');
      const move = moveEvent => {
        if (moveEvent.pointerId !== pointerId) return;
        latestX = moveEvent.clientX;
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const end = endEvent => {
        if (endEvent.pointerId !== pointerId) return;
        if (endEvent.type === 'pointerup') latestX = endEvent.clientX;
        cancelAnimationFrame(frame);
        flush();
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        handle.removeEventListener('lostpointercapture', end);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        handle.removeEventListener('pointermove', move);
        handle.classList.remove('dragging'); document.body.classList.remove('pane-resizing');
        sizes = applyPaneSizes(sizes, true);
        preferredSizes = {...sizes};
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('lostpointercapture', end);
    });
    handle.addEventListener('dblclick', () => { preferredSizes = currentPaneDefaults(); sizes = applyPaneSizes(preferredSizes, true); toast(mailaiText('已恢复默认栏宽'), 'success'); });
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      sizes = applyPaneSizes({...sizes, [kind]:sizes[kind] + (event.key === 'ArrowRight' ? 16 : -16)}, true);
      preferredSizes = {...sizes};
    });
  });
  window.addEventListener('mailai:list-view-changed', () => { preferredSizes = readPaneSizes(); sizes = applyPaneSizes(preferredSizes); });
  window.addEventListener('resize', () => { sizes = applyPaneSizes(preferredSizes); });
}

initPaneResizers();

globalThis.MailAIModules?.register('paneResizers', {
  readPaneSizes,
  constrainPaneSizes,
  applyPaneSizes,
  initPaneResizers,
});
