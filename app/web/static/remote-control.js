// Local settings; external connections begin only after an explicit user action.
(() => {
  const panel = document.querySelector('[data-system-panel="remote"]');
  if (!panel) return;
  const byId = id => document.getElementById(id);
  const visible = () => !panel.classList.contains('hidden') && !byId('system-view').classList.contains('hidden');
  const channels = [
    {prefix:'weixin', form:byId('weixin-control-form'), url:'/api/system/remote-control/weixin'},
    {prefix:'remote', form:byId('remote-control-form'), url:'/api/system/remote-control'}
  ];
  let timer = 0, qrTimer = 0, login = null, pairing = false, qrPolling = null;
  const field = (c, id) => byId(c.prefix + '-' + id);
  function feedback(c, text, error=false) {
    const node = field(c, 'config-feedback'); node.textContent = text; node.dataset.error = String(error);
  }
  function buttons(c) {
    c.form.querySelectorAll('input,button').forEach(el => el.disabled = !!c.busy || !c.loaded);
    field(c, 'reconnect').disabled = !!c.busy || !c.enabled;
    field(c, 'disable').disabled = !!c.busy || !c.enabled;
    field(c, 'reconnect').classList.toggle('hidden',!c.enabled);
    field(c, 'disable').classList.toggle('hidden',!c.enabled);
    field(c, 'retry').disabled = !!c.refreshing || !!c.busy;
    const selected = field(c,'account-options').querySelectorAll('input:checked').length;
    field(c,'save').disabled = !!c.busy || !c.loaded || !c.dirty || (field(c,'enabled').checked && (!selected || (c.prefix === 'weixin' && !c.bound)));
    field(c,'save').textContent = c.busy ? '正在更新…' : !c.loaded ? '正在读取…' : !c.dirty ? '已保存' : field(c,'enabled').checked && !c.enabled ? '启用并保存' : '保存更改';
    c.form.setAttribute('aria-busy',String(!!c.busy || !!c.refreshing));
    if (c.prefix === 'weixin') {
      field(c, 'login').disabled = !!c.busy || !c.loaded || c.enabled || pairing;
      field(c, 'enabled').disabled = !!c.busy || !c.loaded || !c.bound;
      field(c,'login').textContent = pairing ? '正在获取…' : c.bound ? '重新扫码' : '扫码连接';
      field(c,'login').classList.toggle('hidden',!!c.enabled || !!login);
      field(c,'next-step').textContent = !c.loaded ? '正在读取连接设置…' : !c.bound ? '先扫码连接；也可以提前选择要使用的邮箱。' : !selected ? '选择至少一个邮箱后，即可启用手机控制。' : c.dirty ? `已选 ${selected} 个邮箱 · 保存后生效` : c.enabled ? '已启用，在手机机器人单聊发送“最新邮件”开始。' : '邮箱已选好，打开手机控制开关并保存即可。';
      for (const [step,done,current] of [['pair',c.bound,!c.bound],['accounts',selected>0,c.bound&&!selected],['enable',c.enabled,c.bound&&selected>0&&!c.enabled]]) {
        const node = panel.querySelector(`[data-remote-step="${step}"]`);
        node.classList.toggle('complete',!!done); node.classList.toggle('current',!!current);
        if (current) node.setAttribute('aria-current','step'); else node.removeAttribute('aria-current');
      }
    }
  }
  function status(c, data) {
    const phase = data.connection?.phase || 'disabled';
    const labels = {connected:'已连接',connecting:'连接中',reconnecting:'自动重连中',stopping:'更新连接中',expired:'需要重新扫码',error:'连接异常',reply_failed:'回传失败',disabled:'未启用'};
    field(c, 'connection-state').textContent = labels[phase] || '等待连接';
    field(c,'connection-state').dataset.phase = phase;
    field(c,'connection-state').title = data.connection?.message || '';
    field(c, 'connection-state').classList.toggle('connected',data.connection?.phase === 'connected');
    if (c.prefix === 'weixin') field(c,'state-detail').textContent = ['connected','disabled'].includes(phase) ? '' : data.connection?.message || '';
    if ('enabled' in data) {c.enabled = data.enabled;c.saved = data;}
    buttons(c);
  }
  function render(c, data) {
    c.loaded = true;
    c.saved = data; c.dirty = false;
    field(c,'retry').classList.add('hidden');
    if (c.prefix === 'remote') {
      for (const id of ['client-id','corp-id','staff-id']) field(c,id).value = data[id.replaceAll('-','_')] || '';
      field(c,'client-secret').value = '';
      field(c,'client-secret').placeholder = data.secret_saved ? '已保存，留空保留现有密钥' : '保存在本机凭据库';
    } else {
      c.bound = !!data.bot_id && data.secret_saved;
      field(c,'identity').textContent = c.bound ? '本人微信已绑定' : '扫码连接本人微信';
    }
    field(c,'enabled').checked = !!data.enabled;
    field(c,'ai-enabled').checked = !!data.ai_enabled;
    field(c,'ai-hint').textContent = data.ai_available ? '复用已有模型；总结或起草时会发送对应邮件内容，可能产生 API 费用。发信仍需预览和确认。' : '尚未配置可用模型。请先在 AI 设置配置；常用指令无需模型即可使用。';
    const options = field(c,'account-options'); options.replaceChildren();
    for (const account of data.accounts || []) {
      const label = document.createElement('label'); label.className = 'check-row remote-account-option';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = account.id;
      input.checked = (data.account_ids || []).includes(account.id);
      const span = document.createElement('span'); span.textContent = account.user;
      label.append(input,span); options.append(label);
    }
    if (!options.childNodes.length) {
      const empty = document.createElement('p'); empty.className = 'form-hint'; empty.textContent = '还没有可选择的邮箱。';
      const add = document.createElement('button'); add.type = 'button'; add.className = 'action-btn action-secondary'; add.textContent = '去连接邮箱';
      add.onclick = () => showSystemView('account'); options.append(empty,add);
    }
    status(c,data);
    if (!data.keychain_available) feedback(c,'系统凭据库不可用，无法安全保存连接凭证。',true);
  }
  async function refresh(c) {
    if (c.busy || c.refreshing) return;
    c.refreshing = true;
    try {
      const data = await api(c.url);
      // Preserve unsaved fields while polling only the connection state.
      if (!c.loaded || (c.reload && !c.dirty && !(c.prefix === 'weixin' && (login || pairing)))) render(c,data); else status(c,data);
      c.reload=false;
      field(c,'retry').classList.add('hidden');
      if (c.readError) {feedback(c,'连接状态已恢复。');c.readError=false;}
    } catch (_) { c.readError=true;feedback(c,'暂时无法读取连接状态，请重试。',true);field(c,'retry').classList.remove('hidden'); }
    finally { c.refreshing = false; buttons(c); }
  }
  function payload(c) {
    const data = {enabled:field(c,'enabled').checked, ai_enabled:field(c,'ai-enabled').checked,
      account_ids:[...field(c,'account-options').querySelectorAll('input:checked')].map(el => el.value)};
    if (c.prefix === 'remote') Object.assign(data, {client_id:field(c,'client-id').value.trim(),
      client_secret:field(c,'client-secret').value, corp_id:field(c,'corp-id').value.trim(),staff_id:field(c,'staff-id').value.trim()});
    return data;
  }
  async function action(c,path,body={}) {
    if (c.busy || !c.loaded) return;
    c.busy = true; buttons(c); feedback(c,'正在更新连接…');
    try {
      const data = await api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if ('enabled' in data) render(c,data); else status(c,data);
      feedback(c,body.enabled ? '已启用，在手机机器人单聊发送“最新邮件”开始。' : path.endsWith('/reconnect') ? '正在重新连接，状态会自动更新。' : '设置已保存。');
    } catch (err) { feedback(c,err.message || '操作未完成，请重试。',true); }
    finally { c.busy = false; buttons(c); }
  }
  for (const c of channels) {
    buttons(c);
    c.form.addEventListener('submit',e => {e.preventDefault(); action(c,c.url,payload(c));});
    field(c,'reconnect').addEventListener('click',() => action(c,c.url+'/reconnect'));
    field(c,'disable').addEventListener('click',() => action(c,c.url,{...c.saved,enabled:false,client_secret:''}));
    field(c,'retry').addEventListener('click',() => refresh(c));
    c.form.addEventListener('input',() => {c.dirty=true;buttons(c);});
    c.form.addEventListener('change',() => {c.dirty=true;buttons(c);});
  }
  const wc = channels[0];
  function clearQR() {
    clearTimeout(qrTimer);
    const previous = login; login = null;
    field(wc,'qr-panel').classList.add('hidden'); field(wc,'qr-image').removeAttribute('src');
    field(wc,'verify-code').value = '';
    buttons(wc);
    if (previous) api(wc.url+'/login/'+encodeURIComponent(previous)+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(() => {});
  }
  async function pollQR(verify='') {
    const current = login;
    if (!current || !visible() || qrPolling === current) return;
    clearTimeout(qrTimer);
    qrPolling = current;field(wc,'verify').disabled = true;
    try {
      const data = await api(wc.url+'/login/'+encodeURIComponent(current)+'/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({verify_code:verify})});
      if (login !== current) return;
      field(wc,'qr-message').textContent = data.message;
      for (const id of ['verify-label','verify']) field(wc,id).classList.toggle('hidden',data.status !== 'need_verifycode');
      if (data.status === 'confirmed') {
        const selections = payload(wc).account_ids, aiEnabled = field(wc,'ai-enabled').checked;
        login = null; clearQR(); render(wc,data.config);
        for (const input of field(wc,'account-options').querySelectorAll('input')) input.checked = selections.includes(input.value) || input.checked;
        field(wc,'ai-enabled').checked = aiEnabled;
        wc.dirty = selections.length > 0 || aiEnabled !== !!data.config.ai_enabled;buttons(wc);feedback(wc,'微信已绑定。选择邮箱，打开控制开关并保存。');
        field(wc,'enabled').focus({preventScroll:true}); return;
      }
      if (['expired','verify_code_blocked','binded_redirect'].includes(data.status)) {
        clearQR(); feedback(wc,data.message,true); return;
      }
      if (data.status === 'need_verifycode') return;
    } catch (err) {
      if (login !== current) return;
      field(wc,'qr-message').textContent = err.message || '网络暂不可用，正在重试…';
    } finally {if (qrPolling === current) {qrPolling = null;field(wc,'verify').disabled = false;}}
    if (login === current) qrTimer = setTimeout(pollQR,3000);
  }
  field(wc,'login').addEventListener('click',async () => {
    if (pairing || wc.busy) return;
    clearQR(); pairing = true; buttons(wc); feedback(wc,'正在获取微信二维码…');
    try {
      const data = await api(wc.url+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if (!visible()) {
        api(wc.url+'/login/'+encodeURIComponent(data.login_id)+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(() => {}); return;
      }
      login = data.login_id;
      field(wc,'qr-image').src = data.image; field(wc,'qr-message').textContent = data.message;
      for (const id of ['verify-label','verify']) field(wc,id).classList.add('hidden');
      field(wc,'qr-panel').classList.remove('hidden'); feedback(wc,'在手机确认后，选择邮箱并保存启用。');
      field(wc,'cancel-login').focus({preventScroll:true});
      qrTimer = setTimeout(pollQR,1500);
    } catch (err) { feedback(wc,err.message || '获取二维码失败，请重试。',true); }
    finally { pairing = false; buttons(wc); }
  });
  field(wc,'cancel-login').addEventListener('click',clearQR);
  field(wc,'verify').addEventListener('click',() => pollQR(field(wc,'verify-code').value.trim()));
  field(wc,'verify-code').addEventListener('keydown',e => {if (e.key === 'Enter') {e.preventDefault();pollQR(e.target.value.trim());}});
  field(channels[1],'show-secret').addEventListener('click',() => {
    const input=field(channels[1],'client-secret'),button=field(channels[1],'show-secret');
    input.type=input.type==='password'?'text':'password';button.textContent=input.type==='password'?'显示':'隐藏';button.setAttribute('aria-pressed',String(input.type==='text'));
  });
  panel.addEventListener('click',async e => {
    const button=e.target.closest('[data-remote-copy]');if (!button) return;
    const text=button.dataset.remoteCopy,node=byId('remote-copy-feedback');
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const input=document.createElement('textarea');input.value=text;input.style.cssText='position:fixed;opacity:0;';panel.append(input);input.select();
        const copied=document.execCommand('copy');input.remove();button.focus({preventScroll:true});if (!copied) throw new Error('copy');
      }
      node.textContent='已复制。请在机器人单聊中使用这条指令。';
    } catch (_) {node.textContent='无法自动复制，请手动复制指令：'+text;}
  });
  function watch() {
    clearInterval(timer);
    if (!visible()) {
      clearQR();field(channels[1],'client-secret').type='password';field(channels[1],'show-secret').textContent='显示';field(channels[1],'show-secret').setAttribute('aria-pressed','false');return;
    }
    channels.forEach(c=>{c.reload=true;refresh(c);});
    timer = setInterval(() => {if (!document.hidden) channels.forEach(refresh);},5000);
  }
  new MutationObserver(watch).observe(panel,{attributes:true,attributeFilter:['class']});
  new MutationObserver(watch).observe(byId('system-view'),{attributes:true,attributeFilter:['class']});
  byId('system-tabs').addEventListener('click',e => {if (e.target.closest('[data-system-tab="remote"]')) watch();});
})();
