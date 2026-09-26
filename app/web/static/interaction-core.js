/* Shared interaction primitives. Loaded before app.js so modal keys are contained. */
(() => {
  let activeDialog = null;
  window.mailaiAsk = ({title, message = '', confirmText = '确认', danger = false, value, label = title, maxLength = 200}) => {
    // A repeated click must not open another confirmation for the same action.
    if (activeDialog) return Promise.resolve(value === undefined ? false : null);
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'mailai-question';
    dialog.setAttribute('aria-labelledby', 'mailai-question-title');
    dialog.innerHTML = '<form><h2 id="mailai-question-title"></h2><p class="question-message" id="mailai-question-message"></p><label class="question-field"><span></span><input autocomplete="off"></label><footer><button type="button" data-cancel>取消</button><button type="submit" data-confirm></button></footer></form>';
    dialog.querySelector('h2').textContent = title;
    const messageNode = dialog.querySelector('.question-message');
    messageNode.textContent = message; messageNode.hidden = !message;
    if (message) dialog.setAttribute('aria-describedby', 'mailai-question-message');
    const field = dialog.querySelector('.question-field'), input = field.querySelector('input');
    field.hidden = value === undefined;
    field.querySelector('span').textContent = label;
    input.value = value ?? ''; input.maxLength = maxLength;
    const confirm = dialog.querySelector('[data-confirm]');
    confirm.textContent = confirmText; confirm.classList.toggle('danger', danger);
    document.body.append(dialog); activeDialog = dialog; dialog.showModal();
    (value === undefined ? dialog.querySelector('[data-cancel]') : input).focus();
    if (value !== undefined) input.select();
    return new Promise(resolve => {
      let result = value === undefined ? false : null;
      dialog.querySelector('form').onsubmit = e => { e.preventDefault(); result = value === undefined ? true : input.value; dialog.close(); };
      dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
      dialog.addEventListener('close', () => {
        activeDialog = null; dialog.remove();
        if (previous?.isConnected && previous.getClientRects().length) previous.focus({preventScroll:true});
        resolve(result);
      }, {once:true});
    });
  };
  document.addEventListener('keydown', e => {
    if (!activeDialog || e.isComposing || e.keyCode === 229) return;
    // Keep editor/global shortcuts from acting behind a confirmation.
    if (e.key === 'Escape') { e.preventDefault(); activeDialog.close(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // Keep unchanged nodes, input focus and scroll when background data refreshes.
  window.mailaiPatchRows = (host, html, keyAttribute, preserve = () => false) => {
    const template = document.createElement('template'); template.innerHTML = html;
    const existing = new Map([...host.children].filter(n => n.hasAttribute(keyAttribute)).map(n => [n.getAttribute(keyAttribute), n]));
    const focused = document.activeElement;
    const focusRow = focused?.closest('[' + keyAttribute + ']');
    const controls = 'button,input,select,textarea,a[href]';
    const focusKey = focusRow?.getAttribute(keyAttribute);
    const focusIndex = focusRow ? [...focusRow.querySelectorAll(controls)].indexOf(focused) : -1;
    const selection = (focused?.tagName === 'TEXTAREA' || (focused?.tagName === 'INPUT' && focused.type === 'text')) ? [focused.selectionStart,focused.selectionEnd] : null;
    const scroll = []; for (let n = host; n; n = n.parentElement) if (n.scrollHeight > n.clientHeight) scroll.push([n,n.scrollTop]);
    const desired = [...template.content.children].map(next => {
      const old = existing.get(next.getAttribute(keyAttribute));
      if (!old) return next;
      if (old.outerHTML === next.outerHTML || preserve(old)) return old;
      return next;
    });
    const keep = new Set(desired);
    for (const child of [...host.childNodes]) if (!keep.has(child)) child.remove();
    desired.forEach((node,i) => { if (host.children[i] !== node) host.insertBefore(node,host.children[i] || null); });
    if (focusIndex >= 0 && !focused.isConnected) {
      const row = [...host.children].find(n => n.getAttribute(keyAttribute) === focusKey);
      const control = row?.querySelectorAll(controls)[focusIndex];
      control?.focus({preventScroll:true});
      if (selection && (control?.tagName === 'TEXTAREA' || control?.type === 'text')) control.setSelectionRange(...selection);
    }
    scroll.forEach(([node,top]) => { node.scrollTop = top; });
  };

  let banner, checking = false, dismissedIssue = '', currentIssue = '', targetAccount = '';
  let recoveryAction = null;
  function getBanner() {
    if (banner) return banner;
    banner = document.createElement('aside'); banner.id = 'connection-recovery'; banner.hidden = true;
    banner.innerHTML = '<span role="status"></span><button type="button">检查连接</button><button type="button" aria-label="关闭连接提示">×</button>';
    banner.querySelector('button').onclick = () => recoveryAction ? recoveryAction() : check();
    banner.lastElementChild.onclick = () => { dismissedIssue = currentIssue; banner.hidden = true; };
    document.body.append(banner); return banner;
  }
  async function check() {
    if (checking) return; checking = true;
    const bar = getBanner(), button = bar.querySelector('button'); recoveryAction = null; currentIssue = 'local'; button.textContent = '检查连接'; button.disabled = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),5000);
    try {
      const result = await fetch('/api/health',{signal:controller.signal,cache:'no-store'});
      if (!result.ok) throw new Error('health');
      const data = await result.json();
      if (!('imap_configured' in data)) throw new Error('health');
      bar.querySelector('span').textContent = '本地服务已连接。请重试未完成的操作；发送状态不明时，先到任务与发件箱核对。';
      bar.hidden = false;
    } catch (_) {
      bar.querySelector('span').textContent = '暂时连接不到本地服务。请确认 MailAI 正在运行，并使用启动时显示的地址。当前页面内容已保留。';
      bar.hidden = false;
    } finally { clearTimeout(timeout); checking = false; button.disabled = false; }
  }
  window.mailaiConnectionFailed = () => { if (!checking && currentIssue !== 'local' && dismissedIssue !== 'local') check(); };
  window.mailaiServiceFailed = (kind, accountId = '') => {
    if (checking || currentIssue === 'local') return;
    const issue = kind + ':' + accountId;
    if (dismissedIssue === issue) return;
    const bar = getBanner(); currentIssue = issue; targetAccount = accountId;
    const account = (typeof _systemConfig !== 'undefined' ? _systemConfig?.accounts : [])?.find(a => a.id === accountId);
    bar.querySelector('span').textContent = kind === 'model'
      ? 'AI 服务暂时未能完成请求。邮件内容已保留，可重试或检查模型连接。'
      : `邮箱操作未完成${account?.user ? '（' + account.user + '）' : ''}。请检查邮箱连接；发送或移动结果不明时，先核对状态再重试。`;
    bar.querySelector('button').textContent = kind === 'model' ? '模型设置' : '邮箱设置';
    recoveryAction = async () => {
      const selected = targetAccount;
      if (document.body.classList.contains('compose-open') && !(await closeCompose())) return;
      bar.hidden = true; dismissedIssue = currentIssue;
      showSystemView(kind === 'model' ? 'maintenance' : 'account');
      if (kind !== 'model' && selected) { selectedManagedAccountId = selected; renderAccountSelection(); }
      if (kind === 'model') document.getElementById('model-base-url')?.scrollIntoView({block:'center'});
    };
    bar.hidden = false;
  };
  window.mailaiConnectionRestored = () => {
    if (currentIssue !== 'local' || checking) return;
    currentIssue = ''; dismissedIssue = ''; if (banner) banner.hidden = true;
  };
})();
