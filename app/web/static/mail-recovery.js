/* Account-pinned sync repair. Closing the dialog keeps a requested download alive. */
(() => {
  const dialog = document.createElement('dialog');
  dialog.id = 'mail-recovery-dialog'; dialog.className = 'mail-import-dialog';
  dialog.setAttribute('aria-labelledby','mail-recovery-title');
  dialog.innerHTML = `<header><div><h2 id="mail-recovery-title">${esc(mailaiText('同步与问题邮件'))}</h2><p>${esc(mailaiText('查看原因、定位邮件并重试，不影响其他邮箱。'))}</p></div><button type="button" data-recovery-close aria-label="${esc(mailaiText('关闭'))}">×</button></header><div class="mail-import-body"><label class="mail-import-destination"><span>${esc(mailaiText('查看邮箱'))}</span><select data-recovery-account></select></label><p data-recovery-sync role="status"></p><p data-recovery-error role="alert"></p><div class="mail-recovery-actions"><button type="button" data-recovery-poll>${esc(mailaiText('重新同步此邮箱'))}</button><button type="button" data-recovery-full>${esc(mailaiText('完整同步所有文件夹'))}</button><button type="button" data-recovery-manage>${esc(mailaiText('管理此邮箱'))}</button></div><p>${esc(mailaiText('大邮件会自动分段下载，单封最多 256 MB。失败会保留问题记录并重试；下载仅保存本机副本，不修改服务器邮件。'))}</p><section data-recovery-task role="status" aria-live="polite"></section><div data-recovery-items></div><button type="button" data-recovery-more hidden>${esc(mailaiText('查看更多问题'))}</button></div><footer><span></span><button type="button" data-recovery-refresh>${esc(mailaiText('刷新状态'))}</button><button type="button" data-recovery-close>${esc(mailaiText('关闭'))}</button></footer>`;
  document.body.append(dialog);
  dialog.querySelectorAll('h2,header p,label > span,button,.mail-import-body > p:not([data-recovery-sync]):not([data-recovery-error])').forEach(node=>{
    const value=node.textContent;
    const source=Object.values(MAILAI_UI_COPY).find(pair=>pair.includes(value))?.[0] || value;
    if(source.trim()) mailaiBindUI(node,'textContent',()=>mailaiText(source));
  });
  const $ = query => dialog.querySelector(query);
  let accountId = '', state = null, rows = [], metadata = new Map(), timer = 0, generation = 0, working = false, renderedRows = '', returnFocus;
  const request = (path, options={}) => api(path, {accountId,...options});
  const post = (path, body) => request(path,{method:'POST', ...(body ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
  const key = row => JSON.stringify([row.folder,row.uid]);
  function paint() {
    const task = state?.task || {}, sync = state?.sync || {};
    const account = _systemConfig?.accounts?.find(row=>row.id===accountId);
    $('[data-recovery-account]').disabled = working;
    const syncError = Object.prototype.hasOwnProperty.call(sync, 'error') ? sync.error : account?.sync_error;
    const issue = sync.issue_kind || account?.sync_issue_kind;
    $('[data-recovery-manage]').textContent = issue === 'credentials' ? mailaiText('重新连接邮箱') : mailaiText('管理此邮箱');
    $('[data-recovery-sync]').textContent = sync.running ? mailaiSystemMessage(sync.message) || mailaiText('正在同步，请稍候…') : syncError ? mailaiText('同步失败：') + mailaiSystemMessage(syncError) : mailaiSystemMessage(sync.message) || mailaiText('当前没有正在运行的同步任务。');
    if (!sync.running && syncError && issue === 'connection') $('[data-recovery-sync]').textContent = mailaiText('正在重新连接，状态会自动更新。');
    if (!sync.running && syncError && issue === 'credentials') $('[data-recovery-sync]').textContent = mailaiText('邮箱登录已失效，请重新登录或更新授权码。');
    for (const selector of ['[data-recovery-poll]','[data-recovery-full]']) $(selector).disabled = working || Boolean(task.running) || Boolean(sync.running);
    $('[data-recovery-refresh]').disabled = working;
    $('[data-recovery-task]').replaceChildren();
    if (task.running) {
      const text = document.createElement('p'); text.textContent = mailaiTemplate`正在补下载：${formatFileSize(task.received || 0)} / ${formatFileSize(task.size || 0)}。关闭窗口后会继续。`;
      const progress=document.createElement('progress');progress.max=task.size || 1;progress.value=task.received || 0;progress.setAttribute('aria-label',mailaiText('补下载进度'));
      $('[data-recovery-task]').append(text,progress);
      const stop=document.createElement('button');stop.type='button';stop.dataset.recoveryStop='';stop.textContent=mailaiText('停止补下载');stop.disabled=working;
      $('[data-recovery-task]').append(stop);
    } else if (task.error) $('[data-recovery-task]').textContent = mailaiSystemMessage(task.error);
    else if (task.email_id) $('[data-recovery-task]').innerHTML = `<p>${esc(mailaiText('补下载完成，问题记录已移除。'))} <button type="button" data-recovery-open="${Number(task.email_id)}">${esc(mailaiText('打开邮件'))}</button></p>`;
    const signature = JSON.stringify([rows,[...metadata],working,task.running,sync.running]);
    if (signature !== renderedRows) {
      $('[data-recovery-items]').innerHTML = rows.length ? rows.map((row,index)=>{
        const details=metadata.get(key(row));
        return `<article class="mail-recovery-item"><h3>${esc(details?.subject || mailaiText('未下载邮件'))}</h3>${details ? `<p>${esc(details.sender)} · ${esc(details.date)}</p>` : ''}<p>${esc(row.folder)} · ${esc(mailaiTemplate`邮件编号 ${row.uid}`)} · ${esc(row.size ? formatFileSize(row.size) : mailaiText('大小待确认'))}</p><p>${esc(mailaiSystemMessage(row.error))}</p><div><button type="button" data-recovery-inspect="${index}" ${working?'disabled':''}>${esc(mailaiText('查看邮件信息'))}</button><button type="button" data-recovery-retry="${index}" ${working || task.running || sync.running || row.size>256*1024**2?'disabled':''}>${esc(mailaiText('补下载这封邮件'))}</button></div>${row.size>256*1024**2?`<p>${esc(mailaiText('超过 256 MB，请在原邮箱下载原件，另存较小副本后通过导入邮件补入。'))}</p>`:''}</article>`;
      }).join('') : `<p>${esc(mailaiText('没有待补下载的邮件。若邮箱同步失败，请先使用上方的重新同步或管理此邮箱。'))}</p>`;
      renderedRows=signature;
    }
    $('[data-recovery-more]').hidden = rows.length >= (state?.total || 0);
    $('[data-recovery-more]').disabled = working;
  }
  function poll() {
    clearTimeout(timer);
    if (!dialog.open) return;
    const version=generation;
    timer=setTimeout(async()=>{if(version!==generation)return;await load();},document.hidden?10000:2500);
  }
  async function load(more=false) {
    const version=generation;
    try {
      let result;
      if(more) result=await request('/api/mail/sync-issues?offset='+rows.length+'&limit=30');
      else {
        const items=[];
        for(let offset=0;offset<Math.max(30,rows.length);offset+=100){
          const page=await request('/api/mail/sync-issues?offset='+offset+'&limit='+Math.min(100,Math.max(30,rows.length)-offset));
          if(version!==generation)return;
          result=page;items.push(...page.items);
          if(items.length>=page.total)break;
        }
        result={...result,items};
      }
      if(version!==generation || !dialog.open)return;
      const finished=state?.task?.running && !result.task?.running && result.task?.email_id;
      const syncFinished=state?.sync?.running && !result.sync?.running || state?.sync?.error && !result.sync?.error;
      state=result;rows=more?[...rows,...result.items]:result.items;paint();
      if(finished || syncFinished) {await loadSystemConfig(); if(activeMailAccount()?.id===accountId)await loadData({silent:true});}
    } catch(error) {if(version===generation)$('[data-recovery-error]').textContent=mailaiSystemMessage(error.message);}
    finally {if(version===generation)poll();}
  }
  async function open(id) {
    clearTimeout(timer);generation++;state=null;rows=[];metadata=new Map();renderedRows='';working=false;
    accountId=id || activeMailAccount()?.id || _systemConfig?.accounts?.[0]?.id || '';
    $('[data-recovery-account]').innerHTML=(_systemConfig?.accounts || []).map(row=>`<option value="${esc(row.id)}">${esc(row.user)}</option>`).join('');
    $('[data-recovery-account]').value=accountId;
    $('[data-recovery-error]').textContent='';
    if(!dialog.open){returnFocus=document.activeElement;dialog.showModal();}
    paint();await load();
  }
  function close() { clearTimeout(timer);generation++;dialog.close();returnFocus?.focus({preventScroll:true}); }
  dialog.querySelectorAll('[data-recovery-close]').forEach(n=>n.onclick=close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  $('[data-recovery-account]').onchange=()=>open($('[data-recovery-account]').value);
  $('[data-recovery-refresh]').onclick=()=>load();
  $('[data-recovery-more]').onclick=()=>load(true);
  async function operate(action) {
    if(working)return;
    const version=generation;working=true;$('[data-recovery-error]').textContent='';paint();
    try {await action();if(version===generation){await load();await loadSystemConfig();}}
    catch(error){if(version===generation)$('[data-recovery-error]').textContent=mailaiSystemMessage(error.message);}
    finally{if(version===generation){working=false;paint();}}
  }
  $('[data-recovery-poll]').onclick=()=>operate(()=>post('/api/poll'));
  $('[data-recovery-full]').onclick=()=>operate(()=>post('/api/fetch_all'));
  $('[data-recovery-manage]').onclick=()=>{const id=accountId;close();showSystemView('account');selectedManagedAccountId=id;renderAccountSelection();};
  $('[data-recovery-items]').onclick=event=>{
    const inspect=event.target.closest('[data-recovery-inspect]'), retry=event.target.closest('[data-recovery-retry]');
    const row=rows[Number(inspect?.dataset.recoveryInspect ?? retry?.dataset.recoveryRetry)];
    if(!row)return;
    void operate(async()=>{const payload={folder:row.folder,uid:row.uid};if(inspect)metadata.set(key(row),await post('/api/mail/sync-issues/inspect',payload));else await post('/api/mail/sync-issues/retry',payload);});
  };
  $('[data-recovery-task]').onclick=async event=>{
    if(event.target.closest('[data-recovery-stop]')) { void operate(()=>post('/api/cancel_fetch')); return; }
    const node=event.target.closest('[data-recovery-open]');if(!node)return;
    const id=accountId, emailId=Number(node.dataset.recoveryOpen);close();hideSystemView(true);
    await openAccountMailbox(id,'inbox');await selectEmail(emailId,{accountId:id});
  };
  document.addEventListener('click',event=>{
    const node=event.target.closest('[data-account-recovery]');
    if(node){event.preventDefault();node.closest('details')?.removeAttribute('open');void open(node.dataset.accountRecovery || activeMailAccount()?.id);}
  });
  document.addEventListener('mailai:language-changed',()=>{renderedRows='';if(dialog.open)paint();});
  window.mailaiMailRecovery={open};
})();
