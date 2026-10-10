/* One mailbox entry; provider-specific credentials stay in existing account forms. */
(() => {
  const el = id => document.getElementById(id);
  const t = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  const providers = {
    qq: {name:'QQ / Foxmail', mark:'Q', note:()=>t('客户端授权码连接', 'Client authorization code'), url:'https://mail.qq.com/', domains:['qq.com','foxmail.com'], host:'imap.qq.com', smtp:'smtp.qq.com', guide:()=>t('打开 QQ 邮箱网页版，在设置中找到 POP3 / IMAP / SMTP 服务，开启 IMAP / SMTP 并生成授权码，再回到这里填写。网页版支持的扫码仅用于登录网页。', 'Open QQ Mail settings, enable IMAP / SMTP and generate a client authorization code. Return here to enter it. Website QR login signs you into the website only.')},
    exmail: {name:()=>t('腾讯企业邮箱', 'Tencent Enterprise Mail'), get mark() { return mailaiText('企'); }, note:()=>t('企业邮箱 · 客户端专用密码', 'Enterprise client password'), url:'https://exmail.qq.com/', host:'imap.exmail.qq.com', smtp:'smtp.exmail.qq.com', guide:()=>t('在企业邮箱网页版开启 IMAP / SMTP 服务；开启安全登录的邮箱，请获取客户端专用密码。没有相关设置时，请联系企业管理员。', 'Enable IMAP / SMTP in your enterprise mailbox. If secure sign-in is enabled, get a client-specific password. Contact your administrator if these settings are unavailable.')},
    google: {name:'Google / Gmail', mark:'G', note:()=>t('在 Google 官方页面授权', 'Authorize with Google'), oauth:true},
    microsoft: {name:'Microsoft / Outlook', mark:'M', note:()=>t('Outlook · Microsoft 365 国际版', 'Outlook · Microsoft 365 global'), oauth:true},
    netease: {name:()=>t('网易邮箱', 'NetEase Mail'), get mark() { return mailaiText('易'); }, note:()=>t('163 · 126 · Yeah 授权码', '163 · 126 · Yeah authorization code'), url:'https://mail.163.com/', domains:['163.com','126.com','yeah.net'], guide:()=>t('打开对应的网易邮箱网页版，在设置中开启 IMAP / SMTP 服务，按页面提示生成客户端授权密码。', 'Open your NetEase mailbox settings, enable IMAP / SMTP and generate a client authorization password.')},
    other: {name:()=>t('其他邮箱', 'Other mailbox'), mark:'@', note:()=>t('iCloud · 企业邮箱 · 自定义 IMAP', 'iCloud · Enterprise · Custom IMAP'), guide:()=>t('使用邮箱服务商提供的客户端授权码或应用专用密码。企业邮箱可向管理员获取 IMAP / SMTP 服务器信息，在高级设置中填写。', 'Use the client code or app password provided by your mail service. Ask your administrator for IMAP / SMTP settings if needed.')},
  };
  const text = value => typeof value === 'function' ? value() : value;
  const selection = {mail:'', onboarding:''};
  const manualServers = {mail:false, onboarding:false};
  let session, context, returnFocus;
  const dialog = document.createElement('dialog');
  dialog.id = 'mail-login-dialog'; dialog.className = 'mail-login-dialog';
  dialog.setAttribute('aria-labelledby', 'mail-login-title');
  document.body.append(dialog);
  const request = (path, data) => api('/api/oauth/' + path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
  const current = run => session === run && dialog.open;
  function dispose() {
    const previous = session; session = null;
    if (!previous) return;
    clearTimeout(previous.timer);
    if (previous.flow && !previous.finished) request('cancel', {state:previous.flow}).catch(()=>{});
  }
  function header(title, subtitle, back = false) {
    dialog.dataset.step = back ? 'connect' : 'provider';
    dialog.dataset.busy = 'false';
    dialog.innerHTML = `<header class="mail-login-head"><div><small>MailAI · ${back ? t('连接邮箱', 'Connect mailbox') : t('选择邮箱', 'Choose mailbox')}</small><h2 id="mail-login-title">${title}</h2><p>${subtitle}</p></div><button type="button" class="mail-login-close" aria-label="${t('关闭', 'Close')}">×</button></header><div class="mail-login-body"></div><footer class="mail-login-foot"><span>${t('邮箱数据保存在本机，账号之间独立存储。', 'Mailbox data is stored locally, separately for each account.')}</span>${back && !context.account ? `<button type="button" data-login-back>${t('更换服务商', 'Change provider')}</button>` : ''}</footer>`;
    dialog.querySelector('.mail-login-close').onclick = () => dialog.close();
    dialog.querySelector('[data-login-back]')?.addEventListener('click', () => { context.user = el('mail-login-email')?.value.trim() || context.user; picker(); });
  }
  function providerForEmail(address) {
    const domain = address.toLowerCase().split('@').pop();
    if (['gmail.com','googlemail.com'].includes(domain)) return 'google';
    if (['outlook.com','hotmail.com','live.com','office365.com'].includes(domain)) return 'microsoft';
    if (['icloud.com','me.com','mac.com','yahoo.com','aliyun.com','sina.com','sohu.com','139.com'].includes(domain)) return 'other';
    return Object.keys(providers).find(key => providers[key].domains?.includes(domain)) || '';
  }
  function picker() {
    dispose();
    header(t('添加邮箱', 'Add mailbox'), t('选择邮箱服务商，使用对应的方式连接。', 'Choose your provider to connect your mailbox.'));
    const body = dialog.querySelector('.mail-login-body');
    const addressForm = document.createElement('form'); addressForm.className = 'mail-login-address-form';
    addressForm.innerHTML = `<label for="mail-login-address">${t('输入邮箱快速识别', 'Find your provider by email')}<span>${t('也可以直接选择下方服务商', 'Or choose a provider below')}</span></label><div class="mail-login-address-row"><input id="mail-login-address" type="email" autocomplete="email" placeholder="name@example.com" required><button type="submit" disabled>${t('继续', 'Continue')}<span aria-hidden="true"> →</span></button></div><p id="mail-login-address-hint" aria-live="polite"></p>`;
    const address = addressForm.querySelector('input'), next = addressForm.querySelector('button'), addressHint = addressForm.querySelector('p');
    address.value = context.user;
    address.oninput = () => {
      context.user = address.value.trim();
      const key = address.validity.valid ? providerForEmail(context.user) : '';
      next.disabled = !key;
      grid.querySelectorAll('button').forEach(button => {
        const match = button.dataset.loginProvider === key;
        button.dataset.recommended = String(match);
        button.querySelector('.mail-login-provider-badge')?.remove();
        if (match) {
          const badge = document.createElement('span'); badge.className = 'mail-login-provider-badge'; badge.textContent = t('已识别', 'Matched'); button.append(badge);
        }
      });
      addressHint.textContent = key ? t('已识别邮箱服务商，可按回车继续。', 'Provider found. Press Enter to continue.') : context.user && address.validity.valid ? t('企业域名无法自动确认服务商，请在下方选择。', 'Choose the provider below for this company domain.') : '';
    };
    addressForm.onsubmit = event => {
      event.preventDefault(); const key = providerForEmail(address.value.trim());
      if (key && addressForm.reportValidity()) providers[key].oauth ? oauth(key) : credentials(key);
    };
    body.append(addressForm);
    const grid = document.createElement('div'); grid.className = 'mail-login-providers';
    for (const [key, provider] of Object.entries(providers)) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.loginProvider = key;
      const mark = document.createElement('span'); mark.className = 'mail-login-mark'; mark.textContent = provider.mark; mark.setAttribute('aria-hidden','true');
      const copy = document.createElement('span'), name = document.createElement('b'), note = document.createElement('small');
      name.textContent = text(provider.name); note.textContent = provider.note(); copy.append(name, note);
      button.append(mark, copy); button.onclick = () => { context.user = address.value.trim(); provider.oauth ? oauth(key) : credentials(key); };
      grid.append(button);
    }
    body.append(grid);
    grid.onkeydown = event => {
      const buttons = [...grid.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
      const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      const offset = {ArrowRight:1, ArrowLeft:-1, ArrowDown:columns, ArrowUp:-columns}[event.key];
      if (index >= 0 && offset !== undefined) { event.preventDefault(); buttons[(index + offset + buttons.length) % buttons.length].focus(); }
    };
    address.oninput();
    const hint = document.createElement('p'); hint.className = 'mail-login-caption';
    hint.textContent = t('企业自建 Exchange 或 Microsoft 365 国内版，请选择其他邮箱并使用管理员提供的 IMAP 设置。', 'For self-hosted Exchange or Microsoft 365 China, choose Other mailbox if your administrator supports IMAP.');
    body.append(hint);
    if (dialog.open) address.focus();
  }
  function infer(account) {
    const host = (account?.host || '').toLowerCase(), domain = (account?.user || '').split('@').pop().toLowerCase();
    if (host.includes('exmail.qq.com')) return 'exmail';
    if (host.includes('gmail.com')) return account.auth_type === 'oauth2' ? 'google' : 'other';
    if (account?.auth_type === 'oauth2' && host.includes('outlook.office365.com')) return 'microsoft';
    return Object.keys(providers).find(key => providers[key].domains?.includes(domain)) || 'other';
  }
  function open(options = {}) {
    if (session?.connecting) return;
    dispose(); context = {source:options.source || 'mail', account:options.account || null, user:options.user || (options.source === 'onboarding' ? el('onboarding-user').value.trim() : '')};
    returnFocus = document.activeElement;
    if (context.account) {
      const key = infer(context.account);
      if (context.account.auth_type === 'oauth2') {
        if (!providers[key].oauth) { toast(t('无法识别该邮箱的官方授权服务，请检查账号配置。', 'Cannot identify the OAuth provider for this account.'), 'error'); return; }
        oauth(key);
      } else { credentials(key); return; }
    } else picker();
    if (!dialog.open) dialog.showModal();
    (el('mail-login-address') || el('mail-login-email'))?.focus();
  }
  dialog.addEventListener('close', () => { if (dialog.open) return; dispose(); returnFocus?.isConnected && returnFocus.focus(); });
  dialog.addEventListener('cancel', event => { if (session?.connecting) event.preventDefault(); });
  function profile(prefix) {
    const provider = providers[selection[prefix]];
    return provider?.host ? {provider:text(provider.name), detected:true, imap_host:provider.host, imap_port:993, smtp_host:provider.smtp, smtp_port:465, smtp_ssl:true, smtp_starttls:false} : null;
  }
  function decorate(prefix, key, account) {
    if (selection[prefix] !== key) { el(`${prefix}-password`).value = ''; el(`${prefix}-password`).type = 'password'; }
    selection[prefix] = key;
    el(`${prefix}-user`).setCustomValidity('');
    const provider = providers[key], form = el(prefix === 'mail' ? 'mail-add-panel' : 'onboarding-form');
    form.dataset.loginProvider = key;
    form.querySelector('.mail-login-credential-guide')?.remove();
    const guide = document.createElement('div'); guide.className = 'mail-login-credential-guide';
    const row = document.createElement('div'); row.className = 'mail-login-credential-heading';
    const name = document.createElement('b'); name.textContent = text(provider.name); row.append(name);
    if (!account) {
      const change = document.createElement('button'); change.type = 'button'; change.textContent = t('更换', 'Change');
      change.onclick = () => open({source:prefix, user:el(`${prefix}-user`).value.trim()}); row.append(change);
    }
    const details = document.createElement('details'), summary = document.createElement('summary'), copy = document.createElement('p');
    summary.textContent = t('如何获取授权码或客户端密码？', 'How do I get a client code or password?'); copy.textContent = provider.guide(); details.append(summary, copy);
    if (provider.url) {
      const link = document.createElement('a'); link.href = provider.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = key === 'exmail' ? t('获取客户端密码 ↗', 'Get client password ↗') : t('获取授权码 ↗', 'Get authorization code ↗');
      link.onclick = event => { if (window.pywebview?.api?.open_external_url) { event.preventDefault(); window.pywebview.api.open_external_url(provider.url).catch(error=>toast(mailaiSystemMessage(error.message),'error')); } };
      const links = document.createElement('div'); links.className = 'mail-login-guide-actions'; links.append(details, link);
      guide.append(row, links);
    }
    if (!provider.url) guide.append(row, details);
    form.querySelector('label').before(guide);
    form.querySelector('.mail-login-credential-error')?.remove();
    const error = document.createElement('p'); error.className = 'mail-login-credential-error'; error.hidden = true;
    error.setAttribute('role','status'); error.setAttribute('aria-live','polite');
    form.append(error);
    const label = el(`${prefix}-password`).closest('label').querySelector('span');
    label.removeAttribute('data-i18n'); label.textContent = key === 'qq' || key === 'netease' ? t('客户端授权码', 'Client authorization code') : t('客户端密码或授权码', 'Client password or authorization code');
    const input = el(`${prefix}-password`); input.removeAttribute('data-i18n-placeholder');
    input.placeholder = t('请输入邮箱提供的客户端密码或授权码', 'Enter the client password or authorization code');
    if (!input.parentElement.classList.contains('mail-login-password-wrap')) {
      const wrap = document.createElement('div'); wrap.className = 'mail-login-password-wrap'; input.before(wrap); wrap.append(input);
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'mail-login-password-toggle';
      toggle.setAttribute('aria-controls', input.id);
      wrap.append(toggle); toggle.onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; updatePasswordToggle(prefix); };
    }
    updatePasswordToggle(prefix);
    const errorId = `${prefix}-login-address-error`;
    if (!el(errorId)) {
      const mismatch = document.createElement('small'); mismatch.id = errorId; mismatch.className = 'mail-login-address-error'; mismatch.hidden = true;
      el(`${prefix}-user`).after(mismatch); el(`${prefix}-user`).setAttribute('aria-describedby', errorId);
    }
    validateAddress(prefix);
    const preset = profile(prefix);
    if (preset) {
      if (!account) { el(`${prefix}-host`).value = preset.imap_host; el(`${prefix}-port`).value = 993; }
      el(`${prefix}-smtp-host`).value = preset.smtp_host; el(`${prefix}-smtp-port`).value = 465;
      el(`${prefix}-smtp-ssl`).checked = true; el(`${prefix}-smtp-starttls`).checked = false;
      el(`${prefix}-provider-hint`).textContent = t('收发服务器已配置，连接时会同时验证收件与发件。', 'Servers are configured; connecting checks receiving and sending.');
    } else if (!account && el(`${prefix}-user`).value) discoverMailProvider(el(`${prefix}-user`).value.trim(), prefix);
  }
  function updatePasswordToggle(prefix) {
    const input = el(`${prefix}-password`), toggle = input.parentElement.querySelector('.mail-login-password-toggle');
    if (!toggle) return;
    const shown = input.type === 'text'; toggle.setAttribute('aria-pressed', String(shown));
    toggle.setAttribute('aria-label', shown ? t('隐藏客户端密码', 'Hide client password') : t('显示客户端密码', 'Show client password'));
    toggle.title = toggle.getAttribute('aria-label');
    toggle.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z"/><circle cx="10" cy="10" r="2"/>${shown ? '<path d="m3 3 14 14"/>' : ''}</svg>`;
  }
  function validateAddress(prefix) {
    const input = el(`${prefix}-user`), domains = providers[selection[prefix]]?.domains;
    const domain = input.value.trim().toLowerCase().split('@').pop();
    const message = domains && input.value.includes('@') && !domains.includes(domain) ? t('邮箱地址与所选服务商不符，请更换服务商。', 'This address does not match the provider. Please change provider.') : '';
    input.setCustomValidity(message); input.setAttribute('aria-invalid', String(!!message || input.validity.typeMismatch));
    const hint = el(`${prefix}-login-address-error`); if (hint) { hint.textContent = message; hint.hidden = !message; }
  }
  function credentials(key) {
    const {source, account} = context;
    manualServers[source] = false;
    if (dialog.open) dialog.close();
    if (source === 'onboarding') {
      el('onboarding-form').classList.remove('mail-login-await-provider');
      el('mail-login-onboarding').hidden = true;
      el('onboarding-user').value = context.user;
    } else {
      openMailAddPanel(account, true);
      if (!account) {
        el('mail-user').value = context.user;
        el('mail-add-title').textContent = t('连接邮箱', 'Connect mailbox');
        el('btn-connect-mail').querySelector('span').textContent = t('验证并连接', 'Verify and connect');
      }
    }
    el(`${source}-password`).type = 'password';
    const advanced = el(source === 'mail' ? 'mail-add-panel' : 'onboarding-form').querySelector('.mail-advanced,.onboarding-advanced');
    if (advanced) advanced.open = false;
    decorate(source, key, account);
    const user = el(`${source}-user`);
    (user.value && user.validity.valid ? el(`${source}-password`) : user).focus();
  }
  async function oauth(key) {
    dispose();
    const provider = providers[key], run = {key, flow:'', busy:false, clients:null, finished:false, attempt:0}; session = run;
    header(text(provider.name), t('在系统浏览器中授权，返回后自动验证并连接邮箱。', 'Authorize in your browser; MailAI then verifies and connects the mailbox.'), true);
    dialog.querySelector('.mail-login-body').innerHTML = `<form id="mail-login-oauth-form"><label>${t('要连接的邮箱', 'Mailbox to connect')}<input id="mail-login-email" type="email" required autocomplete="email" placeholder="name@example.com"></label><p class="mail-login-caption">${t('请在官方页面选择同一个邮箱。MailAI 不收集你的登录密码。', 'Choose the same mailbox on the official page. MailAI does not collect your sign-in password.')}</p><div id="mail-login-capability" class="mail-login-capability" role="status"></div><button type="submit" id="mail-login-authorize" class="mail-login-primary" disabled>${t('前往官方授权', 'Authorize with provider')}</button><a id="mail-login-browser-link" target="_blank" rel="noopener noreferrer" hidden>${t('重新打开官方授权页面 ↗', 'Reopen official authorization ↗')}</a><p id="mail-login-status" role="status" aria-live="polite"></p></form><details class="mail-login-admin"><summary>${t('管理员接入设置', 'Administrator setup')}</summary><p>${t('由应用维护者或企业管理员配置已注册的桌面应用。普通用户无需填写客户端信息。', 'An app maintainer or administrator configures the registered desktop application. Mailbox users do not need to enter client details.')}</p><form id="mail-login-admin-form"><label>Client ID<input id="mail-login-client" required maxlength="300" autocomplete="off"></label>${key === 'google' ? `<label>${t('桌面应用客户端密钥（如需）', 'Desktop client secret (if required)')}<input id="mail-login-secret" type="password" autocomplete="new-password" placeholder="${t('已有密钥可留空', 'Leave blank to keep the saved secret')}"></label>` : ''}<p>${key === 'google' ? t('使用 Google 桌面应用客户端，启用邮箱访问权限，并完成适用的应用验证。回调使用 127.0.0.1 随机端口。', 'Use a Google desktop client with mail access and the applicable app verification. Callback uses 127.0.0.1 on a random port.') : t('使用 Microsoft 桌面公共客户端，启用 IMAP / SMTP 委派权限及离线访问；企业可能要求管理员许可。回调使用 localhost 随机端口。', 'Use a Microsoft desktop public client with delegated IMAP / SMTP and offline access. Enterprise policy may require admin consent. Callback uses localhost on a random port.')}</p><button type="submit">${t('保存接入配置', 'Save configuration')}</button><p id="mail-login-admin-status" role="status" aria-live="polite"></p></form></details>`;
    const email = el('mail-login-email'), action = el('mail-login-authorize'), status = el('mail-login-status'), capability = el('mail-login-capability');
    const cancel = document.createElement('button'); cancel.id = 'mail-login-cancel-auth'; cancel.type = 'button'; cancel.hidden = true;
    cancel.textContent = t('取消授权', 'Cancel authorization'); action.after(cancel);
    const isAttempt = attempt => current(run) && run.attempt === attempt;
    const client = el('mail-login-client'), adminForm = el('mail-login-admin-form'), oauthForm = el('mail-login-oauth-form'), link = el('mail-login-browser-link');
    link.onclick = event => {
      if (!window.pywebview?.api?.open_external_url) return;
      event.preventDefault();
      window.pywebview.api.open_external_url(link.href).catch(() => { if (current(run)) status.textContent = t('未能打开浏览器，请稍后重试此链接。', 'Could not open the browser. Try this link again.'); });
    };
    adminForm.querySelectorAll('input,button').forEach(node => node.disabled = true);
    email.value = context.account?.user || context.user || (context.source === 'onboarding' ? el('onboarding-user').value : '');
    email.readOnly = !!context.account;
    if (dialog.open) email.focus();
    function available() {
      const ready = !!run.clients?.[key]?.client_id;
      capability.textContent = ready ? t('官方授权已配置', 'Official authorization configured') : t('官方授权暂未配置，请联系应用维护者或企业管理员。', 'Official authorization is not configured. Contact the app maintainer or administrator.');
      capability.dataset.ready = String(ready); action.disabled = !ready || run.busy;
    }
    function lock(value) {
      run.busy = value;
      email.readOnly = value || !!context.account;
      adminForm.querySelectorAll('input,button').forEach(node => node.disabled = value);
      dialog.querySelector('[data-login-back]')?.toggleAttribute('disabled', value);
      action.disabled = value || !run.clients?.[key]?.client_id;
      action.textContent = value ? t('等待官方授权…', 'Waiting for authorization…') : t('前往官方授权', 'Authorize with provider');
      status.setAttribute('aria-busy', String(value));
      dialog.dataset.busy = String(value);
    }
    function failure(message) {
      if (!current(run)) return;
      run.connecting = false; dialog.querySelector('.mail-login-close').disabled = false;
      clearTimeout(run.timer); cancel.hidden = true; link.hidden = true;
      status.textContent = message; status.dataset.error = 'true'; lock(false);
      action.textContent = t('重新授权', 'Try authorization again');
    }
    cancel.onclick = () => {
      if (run.connecting) return;
      const flow = run.flow; ++run.attempt; run.flow = ''; clearTimeout(run.timer);
      if (flow) request('cancel', {state:flow}).catch(()=>{});
      cancel.hidden = true; link.hidden = true; delete status.dataset.error; lock(false);
      status.textContent = t('已取消本次授权，邮箱地址仍保留。', 'Authorization canceled. Your email address is kept.');
    };
    async function finish(attempt) {
      if (!isAttempt(attempt)) return;
      run.connecting = true; dialog.querySelector('.mail-login-close').disabled = true;
      cancel.hidden = true;
      action.textContent = t('正在验证邮箱…', 'Verifying mailbox…');
      status.textContent = t('授权成功，正在验证收件和发件服务…', 'Authorized. Verifying receiving and sending…');
      try {
        const result = await request('complete', {state:run.flow});
        run.finished = true;
        if (!current(run)) return;
        // Do not cancel a completed session when closing the dialog.
        dialog.close();
        el('onboarding-overlay').classList.add('hidden');
        if (!el('mail-add-panel').classList.contains('hidden')) closeMailAddPanel();
        await loadSystemConfig();
        await Promise.all([loadData(), loadMailboxFolders(), loadActionPolicy(), loadAssistantAlerts()]);
        startMailboxAutoRefresh(); startFetchMonitor(); window.mailOnboarding?.connected(true);
        toast(t('邮箱已连接，正在后台同步邮件', 'Mailbox connected. Syncing mail in the background.'), 'success');
        if (result.smtp_warning) toast(result.smtp_warning, 'warn');
        if (result.credential_warning) toast(result.credential_warning, 'warn');
      } catch (error) { if (run.finished) toast(t('邮箱已连接，但界面刷新失败：', 'Mailbox connected, but the view could not refresh: ') + mailaiSystemMessage(error.message), 'warn'); else failure(error.message); }
    }
    async function poll(attempt) {
      if (!isAttempt(attempt)) return;
      try {
        const result = await api('/api/oauth/status?state=' + encodeURIComponent(run.flow));
        if (!isAttempt(attempt)) return;
        if (result.status === 'ready') return finish(attempt);
        if (['waiting','exchanging','connecting'].includes(result.status)) {
          status.textContent = result.status === 'waiting' ? t('请在官方页面完成授权，完成后会自动连接。', 'Complete authorization on the official page to connect automatically.') : t('正在核对官方授权…', 'Checking authorization…');
          run.timer = setTimeout(() => poll(attempt), 1800);
        } else failure(result.message || t('授权未完成或已过期，请重试。', 'Authorization failed or expired. Please try again.'));
      } catch (_) {
        if (isAttempt(attempt)) { status.textContent = t('暂时无法读取授权状态，正在重试…', 'Cannot read authorization status; retrying…'); run.timer = setTimeout(() => poll(attempt), 4000); }
      }
    }
    oauthForm.onsubmit = async event => {
      event.preventDefault(); if (run.busy || !run.clients?.[key]?.client_id || !oauthForm.reportValidity()) return;
      const attempt = ++run.attempt;
      lock(true); delete status.dataset.error; link.hidden = true;
      cancel.hidden = false;
      status.textContent = t('正在打开官方授权页面…', 'Opening official authorization…');
      try {
        if (run.flow) await request('cancel', {state:run.flow});
        if (!isAttempt(attempt)) return;
        run.flow = '';
        const result = await request('start', {provider:key, user:email.value.trim()});
        if (!isAttempt(attempt)) { await request('cancel', {state:result.state}); return; }
        run.flow = result.state;
        link.href = result.url; link.hidden = false;
        status.textContent = t('请在浏览器中完成授权，MailAI 会自动连接邮箱。', 'Finish authorization in your browser. MailAI will connect automatically.');
        // Browser failures still leave a usable link and a polled session.
        run.timer = setTimeout(() => poll(attempt), 1000);
        if (window.pywebview?.api?.open_external_url) {
          const opened = await window.pywebview.api.open_external_url(result.url);
          if (opened?.ok === false && isAttempt(attempt)) status.textContent = t('请点击上方链接打开官方授权页面。', 'Use the link above to open the authorization page.');
        } else link.click();
      } catch (error) { if (!isAttempt(attempt)) return; if (run.flow) status.textContent = t('请点击上方链接完成授权。', 'Use the link above to finish authorization.'); else failure(error.message); }
    };
    adminForm.onsubmit = async event => {
      event.preventDefault(); if (run.busy || !adminForm.reportValidity()) return;
      lock(true); const adminStatus = el('mail-login-admin-status');
      adminStatus.textContent = t('正在保存…', 'Saving…');
      try {
        await request('clients', {provider:key, client_id:client.value.trim(), client_secret:el('mail-login-secret')?.value || ''});
        if (!current(run)) return;
        if (el('mail-login-secret')) el('mail-login-secret').value = '';
        run.clients = await api('/api/oauth/clients');
        if (current(run)) { available(); adminStatus.textContent = t('接入配置已保存，可以开始官方授权。', 'Configuration saved. Official authorization is ready.'); }
      } catch (error) { if (current(run)) adminStatus.textContent = mailaiSystemMessage(error.message); }
      finally { if (current(run)) lock(false); }
    };
    capability.textContent = t('正在检查官方授权配置…', 'Checking authorization configuration…');
    try {
      run.clients = await api('/api/oauth/clients');
      if (!current(run)) return;
      client.value = run.clients[key]?.client_id || ''; available();
      adminForm.querySelectorAll('input,button').forEach(node => node.disabled = false);
    } catch (error) { if (current(run)) { capability.textContent = t('读取授权配置失败，请关闭后重试。', 'Could not load authorization settings. Close and try again.'); failure(error.message); } }
  }
  const welcomeButton = document.createElement('button');
  welcomeButton.id = 'mail-login-onboarding'; welcomeButton.type = 'button'; welcomeButton.className = 'onboarding-submit';
  welcomeButton.textContent = t('添加邮箱', 'Add mailbox'); welcomeButton.onclick = () => open({source:'onboarding'});
  el('onboarding-form').before(welcomeButton); el('onboarding-form').classList.add('mail-login-await-provider');
  ['mail','onboarding'].forEach(prefix => {
    el(`${prefix}-user`).addEventListener('input', () => validateAddress(prefix));
    const form = el(prefix === 'mail' ? 'mail-add-panel' : 'onboarding-form');
    form.addEventListener('invalid', event => { const details = event.target.closest('details'); if (details) details.open = true; }, true);
    for (const field of ['host','port','smtp-host','smtp-port','smtp-ssl','smtp-starttls']) {
      el(`${prefix}-${field}`).addEventListener('input', () => { manualServers[prefix] = true; });
    }
  });
  // Returning to the ordinary editor must not retain a previous provider restriction.
  const cancel = el('btn-cancel-add-mail');
  cancel.addEventListener('click', () => { selection.mail = ''; el('mail-user').setCustomValidity(''); });
  const addHint = el('btn-add-mail').querySelector('small'); addHint.removeAttribute('data-i18n');
  function refreshCopy() {
    welcomeButton.textContent = t('添加邮箱', 'Add mailbox');
    addHint.textContent = t('选择服务商，连接你的邮箱', 'Choose your provider and connect');
    for (const prefix of ['mail','onboarding']) {
      const form = el(prefix === 'mail' ? 'mail-add-panel' : 'onboarding-form'), guide = form.querySelector('.mail-login-credential-guide');
      const provider = providers[selection[prefix]];
      if (!guide || !provider) continue;
      guide.querySelector('b').textContent = text(provider.name);
      const change = guide.querySelector('button'); if (change) change.textContent = t('更换', 'Change');
      guide.querySelector('summary').textContent = t('如何获取授权码或客户端密码？', 'How do I get a client code or password?');
      guide.querySelector('p').textContent = provider.guide();
      const link = guide.querySelector('a'); if (link) link.textContent = selection[prefix] === 'exmail' ? t('获取客户端密码 ↗', 'Get client password ↗') : t('获取授权码 ↗', 'Get authorization code ↗');
      el(`${prefix}-password`).closest('label').querySelector('span').textContent = ['qq','netease'].includes(selection[prefix]) ? t('客户端授权码', 'Client authorization code') : t('客户端密码或授权码', 'Client password or authorization code');
      el(`${prefix}-password`).placeholder = t('请输入邮箱提供的客户端密码或授权码', 'Enter the client password or authorization code');
      updatePasswordToggle(prefix); validateAddress(prefix);
    }
  }
  document.addEventListener('mailai:language-changed', refreshCopy); refreshCopy();
  const credentialLocks = new Map();
  window.mailaiMailLogin = {open, selection:prefix=>selection[prefix], manualServers:prefix=>manualServers[prefix], profile, connectionState(prefix, message = '') {
    const error = el(prefix === 'mail' ? 'mail-add-panel' : 'onboarding-form').querySelector('.mail-login-credential-error');
    if (error) { error.hidden = !message; error.textContent = message; }
  }, connectionPending(prefix, pending) {
    const form = el(prefix === 'mail' ? 'mail-add-panel' : 'onboarding-form');
    form.dataset.loginBusy = String(pending);
    if (pending) {
      const controls = [...form.querySelectorAll('input,button'), ...(prefix === 'mail' ? document.querySelectorAll('.account-directory button') : [])].filter(node => node.id !== 'btn-connect-mail' && node.id !== 'onboarding-submit');
      credentialLocks.set(prefix, controls.map(node => [node,node.disabled]));
      controls.forEach(node => node.disabled = true);
    } else {
      for (const [node,disabled] of credentialLocks.get(prefix) || []) if (node.isConnected) node.disabled = disabled;
      credentialLocks.delete(prefix);
    }
  }};
})();
