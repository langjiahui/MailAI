/* Show actual check transitions as they arrive, without inventing percentages. */
(() => {
  const terminal = new Set(['pass','warning','fail']);
  const translate = (zh, en) => currentI18nLanguage() === 'en' ? en : zh;
  const names = [['db','本地数据库','Local database'],['isolation','账号隔离','Account isolation'],['disk','本机可用空间','Free disk space'],['backup','自动备份','Automatic backup'],['vault','系统凭据库','System credential vault'],['imap','邮箱收信','Mailbox receiving'],['smtp','SMTP 发信','SMTP sending'],['model','AI 模型','AI model'],['init','历史邮件初始化','Initial mail import']];
  let running = false, refreshLanguage = null;
  window.mailaiOpenDiagnostics = () => {
    const drawer=document.getElementById('diagnostics-drawer');
    if (!drawer || !document.getElementById('diagnostic-results')?.childElementCount) return;
    if (!drawer.open) drawer.showModal();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('mailai:language-changed', () => refreshLanguage?.());
    document.getElementById('btn-view-diagnostics')?.addEventListener('click',window.mailaiOpenDiagnostics);
    document.getElementById('btn-close-diagnostics')?.addEventListener('click',()=>document.getElementById('diagnostics-drawer').close());
    document.getElementById('btn-rerun-diagnostics')?.addEventListener('click',()=>window.mailaiRunDiagnostics());
    const drawer=document.getElementById('diagnostics-drawer');
    drawer?.addEventListener('click',event=>{
      if (event.target!==drawer) return;
      const rect=drawer.getBoundingClientRect();
      if (event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom) drawer.close();
    });
    drawer?.addEventListener('keydown',event=>{if(event.key==='Escape')event.stopPropagation();});
    drawer?.addEventListener('close',()=>{
      const view=document.getElementById('btn-view-diagnostics');
      if (view?.getClientRects().length) view.focus({preventScroll:true});
    });
  }
  async function readStream(response, onEvent) {
    if (!response.body?.getReader) {
      for (const line of (await response.text()).split('\n')) if (line.trim()) await onEvent(JSON.parse(line));
      return;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const {value,done} = await reader.read();
        buffer += decoder.decode(value, {stream:!done});
        let newline;
        while ((newline=buffer.indexOf('\n')) !== -1) {
          const line=buffer.slice(0,newline); buffer=buffer.slice(newline+1);
          if (line.trim()) await onEvent(JSON.parse(line));
        }
        if (buffer.length > 1024*1024) throw Error(mailaiText('检查结果过大，请重试'));
        if (done) { if (buffer.trim()) await onEvent(JSON.parse(buffer)); break; }
      }
    } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  }
  window.mailaiReadDiagnosticStream = readStream;
  window.mailaiRunDiagnostics = async () => {
    if (running) return;
    running = true;
    const button=document.getElementById('btn-run-diagnostics'), host=document.getElementById('diagnostic-results');
    const account=activeMailAccount(), accountId=account?.id || '', start=Date.now(), controller=new AbortController();
    const items=new Map(names.map(([id,zh,en])=>[id,{id,name:translate(zh,en),status:'queued',probe:['imap','smtp','model'].includes(id)?'live':'local',detail:translate('等待检查','Waiting')}])) ;
    let complete = false, interrupted = false, finishedAt = 0;
    setLoading(button,true,translate('检查中…','Checking…'));
    document.getElementById('btn-rerun-diagnostics').disabled=true;
    document.getElementById('btn-view-diagnostics').disabled=false;
    host.classList.remove('hidden'); host.setAttribute('aria-busy','true');
    host.innerHTML=`<div class="diagnostic-overall"><span class="diagnostic-overall-icon" aria-hidden="true"></span><div class="diagnostic-overall-copy"><b data-diagnostic-title></b><span data-diagnostic-summary role="status" aria-live="polite"></span></div><progress data-diagnostic-progress value="0" max="9" aria-label="检查完成进度" data-i18n-aria="ui.c022bbfed35e"></progress></div><p class="diagnostic-scope"></p><div class="diagnostic-attention"><b data-diagnostic-attention-title></b><div class="diagnostic-list" data-diagnostic-attention></div></div><div class="diagnostic-list" data-diagnostic-pending></div><details class="diagnostic-passed"><summary><span data-diagnostic-passed-title></span><small data-diagnostic-toggle></small></summary><div class="diagnostic-list" data-diagnostic-passed></div></details>`;
    host.scrollTop=0;
    window.mailaiOpenDiagnostics();
    const summary=host.querySelector('[data-diagnostic-summary]'), progress=host.querySelector('[data-diagnostic-progress]');
    const overall=host.querySelector('.diagnostic-overall'), title=host.querySelector('[data-diagnostic-title]');
    const attention=host.querySelector('.diagnostic-attention'), attentionList=host.querySelector('[data-diagnostic-attention]');
    const pendingList=host.querySelector('[data-diagnostic-pending]'), passed=host.querySelector('.diagnostic-passed'), passedList=host.querySelector('[data-diagnostic-passed]');
    const rowNodes=new Map();
    const itemName=item=>{const source=mailaiCopySource(item.name && item.name!==item.id?item.name:'');if(source&&mailaiUICopyKeys.has(source))return mailaiText(source);const entry=names.find(([id])=>id===item.id);return entry?translate(entry[1],entry[2]):mailaiSystemMessage(source || item.id);};
    const updateSummary=()=>{
      const rows=[...items.values()], done=rows.filter(item=>terminal.has(item.status)).length;
      const active=rows.filter(item=>item.status==='running').map(itemName);
      const failed=rows.filter(item=>item.status==='fail').length, warnings=rows.filter(item=>item.status==='warning').length;
      const passedCount=rows.filter(item=>item.status==='pass').length;
      const concerns=rows.filter(item=>['fail','warning','interrupted'].includes(item.status));
      const phase=interrupted?'interrupted':!complete?'running':failed?'fail':warnings?'warning':'pass';
      overall.dataset.state=phase;
      const cardStatus=document.getElementById('diagnostic-card-status');
      cardStatus.classList.remove('hidden'); cardStatus.dataset.state=phase;
      mailaiBindUI(cardStatus,'textContent',()=>phase==='running'?translate('检查中','Checking'):phase==='pass'?translate('全部通过','All passed'):phase==='interrupted'?translate('未完成','Incomplete'):translate('需要处理','Needs attention'));
      overall.querySelector('.diagnostic-overall-icon').textContent=phase==='pass'?'✓':phase==='running'?'':'!';
      mailaiBindUI(title,'textContent',()=>interrupted?translate('检查未完成','Diagnostics incomplete'):!complete?translate('正在检查…','Checking…'):failed?translate(`${failed} 项检查失败`,`${failed} ${failed===1?'check':'checks'} failed`):warnings?translate(`${warnings} 项需要注意`,`${warnings} ${warnings===1?'check needs':'checks need'} attention`):(mailaiT('diag.pass') || '检查通过'));
      progress.max=rows.length; progress.value=done;
      progress.classList.toggle('hidden',complete || interrupted);
      const outcome=(failed?translate(` · ${failed} 项失败`,` · ${failed} failed`):'')+(warnings?translate(` · ${warnings} 项需要注意`,` · ${warnings} need attention`):'');
      mailaiBindUI(summary,'textContent',()=>interrupted?translate(`已保留 ${done}/${rows.length} 项结果，请重新检查。`,`${done}/${rows.length} results retained. Run diagnostics again.`):complete?translate(`${done}/${rows.length} 项完成 · 用时 ${Math.round((finishedAt-start)/1000)} 秒`,`${done}/${rows.length} checks complete · ${Math.round((finishedAt-start)/1000)}s`)+outcome:translate(`已完成 ${done}/${rows.length} 项${active.length ? ' · '+active.join('、') : ''}`,`${done}/${rows.length} complete${active.length ? ' · '+active.join(', ') : ''}`));
      mailaiBindUI(host.querySelector('.diagnostic-scope'),'textContent',()=>account?.user?translate(`检查邮箱：${account.user}`,`Mailbox checked: ${account.user}`):(mailaiT('diag.scopeNone') || '本次未检测到正在使用的邮箱。'));
      attention.classList.toggle('hidden',!concerns.length);
      pendingList.classList.toggle('hidden',!active.length);
      passed.classList.toggle('hidden',!passedCount);
      mailaiBindUI(host.querySelector('[data-diagnostic-attention-title]'),'textContent',()=>translate(`需要留意 · ${concerns.length} 项`,`Needs attention · ${concerns.length} ${concerns.length===1?'check':'checks'}`));
      mailaiBindUI(host.querySelector('[data-diagnostic-passed-title]'),'textContent',()=>translate(`已通过 · ${passedCount} 项`,`Passed · ${passedCount} ${passedCount===1?'check':'checks'}`));
      mailaiBindUI(host.querySelector('[data-diagnostic-toggle]'),'textContent',()=>passed.open?translate('收起详情','Hide details'):translate('查看详情','View details'));
      const order={fail:0,warning:1,interrupted:2};
      concerns.sort((a,b)=>order[a.status]-order[b.status]).forEach(item=>{const row=rowNodes.get(item.id);if(row)attentionList.append(row);});
    };
    const renderRow = item => {
      let row=rowNodes.get(item.id);
      if (!row) { row=document.createElement('div'); row.dataset.checkId=item.id; rowNodes.set(item.id,row); }
      const status=item.status || (item.ok?'pass':'fail');
      const labels={queued:translate('等待检查','Waiting'),running:translate('正在检查','Checking'),pass:translate('通过','Passed'),warning:translate('需要注意','Attention'),fail:translate('失败','Failed'),interrupted:translate('未完成','Not completed')};
      const icon=status==='pass'?'✓':status==='running'?'':status==='queued'?'·':status==='warning'?'i':'!';
      const guidance=['warning','fail'].includes(status)?diagnosticAdvice(item):null;
      const helpOpen=row.querySelector('.diagnostic-help')?.open;
      row.className='diagnostic-item '+status;
      row.classList.toggle('hidden',status==='queued');
      const source=mailaiCopySource(item.detail || '');
      const importProgress=item.id==='init' && source.match(/^([^·]+) · (\d+\/\d+)(?: · (.*))?$/);
      const liveFailure=source.match(/^(?:实测失败：|Live check failed: )(.*)$/s);
      const detail=importProgress ? `${mailaiText(mailaiCopySource(importProgress[1].trim()))} · ${importProgress[2]}${importProgress[3]?' · '+mailaiSystemMessage(mailaiCopySource(importProgress[3])):''}` : liveFailure ? translate('实测失败：','Live check failed: ')+mailaiSystemMessage(mailaiCopySource(liveFailure[1])) : mailaiSystemMessage(source);
      row.innerHTML=`<span class="diagnostic-state-icon" aria-hidden="true">${icon}</span><b>${esc(itemName(item))}<em>${item.probe==='live' ? (mailaiT('diag.live')||'实测'):(mailaiT('diag.local')||'本地')}</em></b><small title="${esc(detail)}">${esc(detail)}</small><div class="diagnostic-item-state"><strong>${labels[status] || esc(status)}</strong>${terminal.has(status) && Number.isFinite(item.duration_ms) && item.duration_ms >= 100 ? `<time>${(item.duration_ms/1000).toFixed(1)}s</time>`:''}</div>${guidance ? `<details class="diagnostic-help"${helpOpen?' open':''}><summary>${translate('如何处理','How to fix')}</summary><p class="diagnostic-advice">${esc(guidance.advice)}</p><button type="button" class="diagnostic-action" data-diagnostic-target="${guidance.target}" data-diagnostic-field="${guidance.field}">${esc(guidance.action)} →</button></details>`:''}`;
      (status==='pass'?passedList:['warning','fail','interrupted'].includes(status)?attentionList:pendingList).append(row);
    };
    const update = item => {
      item={...items.get(item.id),...item,status:item.status || (item.ok?'pass':'fail')};
      items.set(item.id,item);
      renderRow(item);
      updateSummary();
    };
    passed.addEventListener('toggle',updateSummary);
    refreshLanguage=()=>{items.forEach(renderRow);updateSummary();};
    items.forEach(update);
    const timeout=setTimeout(()=>controller.abort(),120000);
    try {
      const response=await fetch(API+`/api/system/diagnostics/stream?lang=${encodeURIComponent(currentI18nLanguage())}`,{headers:accountId?{'X-MailAI-Account':accountId}:{},signal:controller.signal});
      if (!response.ok) { let message=''; try {message=(await response.json()).detail;}catch(_){} throw Error(message || `HTTP ${response.status}`); }
      await readStream(response,event=>{
        if (event.type==='plan') event.checks.forEach(update);
        else if (event.type==='check') update(event.check);
        else if (event.type==='error') throw Error(event.message);
        else if (event.type==='done') { event.data.checks.forEach(item=>update({...items.get(item.id),...item})); complete=true; finishedAt=Date.now(); updateSummary(); const warnings=event.data.checks.filter(item=>item.status==='warning').length; toast(!event.data.ok ? (mailaiT('diag.fail')||'检查发现连接或配置失败') : warnings ? translate(`检查完成，${warnings} 项需要注意`,`Finished; ${warnings} checks need attention`) : (mailaiT('diag.pass')||'检查通过'),!event.data.ok?'error':warnings?'warn':'success'); }
      });
      if (!complete) throw Error(translate('检查连接已中断，请重新检查','Connection interrupted; run diagnostics again'));
    } catch(error) {
      const message=error.name==='AbortError'?translate('检查超时，请检查网络后重试','Diagnostics timed out; check the network and retry'):error.message;
      interrupted=true; finishedAt=Date.now();
      for (const item of items.values()) if (!terminal.has(item.status)) update({...item,status:'interrupted',detail:message});
      updateSummary();
      toast((mailaiT('diag.failed')||'诊断失败：')+message,'error');
    } finally { clearTimeout(timeout); host.setAttribute('aria-busy','false'); setLoading(button,false); document.getElementById('btn-rerun-diagnostics').disabled=false; running=false; }
  };
})();
