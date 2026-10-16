/* Native menus navigate existing features; update installation keeps its own confirmation. */
(() => {
  let checking = false;
  window.mailaiNativeMenu = async action => {
    const routes = {about:'about', settings:'preferences', updates:'about', help:'guide', shortcuts:'guide'};
    if (action === 'feedback') {
      try { await openExternalLink('https://github.com/langjiahui/MailAI/issues'); }
      catch (error) { toast(mailaiSystemMessage(error.message), 'warn'); return false; }
      return true;
    }
    if (['font-larger','font-smaller','font-reset'].includes(action)) {
      const control = document.getElementById('font-size');
      if (!control?.onchange) return false;
      const options = [...control.options].map(option => Number(option.value));
      const current = Number(control.value);
      const next = action === 'font-reset' ? 1 : action === 'font-larger'
        ? options.find(value => value > current) ?? options.at(-1)
        : [...options].reverse().find(value => value < current) ?? options[0];
      control.value = String(next);
      control.dispatchEvent(new Event('change', {bubbles:true}));
      return true;
    }
    if (!Object.hasOwn(routes, action)) return false;
    if (document.querySelector('dialog[open], .modal:not(.hidden), .compose-modal:not(.hidden), .attachment-center:not(.hidden)')) {
      toast(mailaiText('请先完成或关闭当前弹窗，再使用此菜单'), 'info');
      return false;
    }
    if (!document.getElementById('task-center').classList.contains('hidden')) closeTaskCenter();
    showSystemView(routes[action]);
    if (action === 'shortcuts') {
      document.querySelector('[data-system-panel="guide"] [data-help-reset]')?.click();
      const shortcuts = document.querySelector('.help-shortcuts');
      shortcuts.hidden = false;
      shortcuts.tabIndex = -1;
      shortcuts.focus({preventScroll:true});
      shortcuts.scrollIntoView({block:'center'});
    }
    if (action === 'updates' && !checking) {
      checking = true;
      try { await checkForAppUpdate(true); }
      finally { checking = false; }
    }
    return true;
  };
})();
