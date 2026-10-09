/* Show actual check transitions as they arrive, without inventing percentages. */
(() => {
  const terminal = new Set(['pass','warning','fail']);
  const translate = (zh, en) => currentI18nLanguage() === 'en' ? en : zh;
  const names = [['db','本地数据库','Local database'],['isolation','账号隔离','Account isolation'],['disk','本机可用空间','Free disk space'],['backup','自动备份','Automatic backup'],['vault','系统凭据库','System credential vault'],['imap','邮箱收信','Mailbox receiving'],['smtp','SMTP 发信','SMTP sending'],['model','AI 模型','AI model'],['init','历史邮件初始化','Initial mail import']];
  let running = false;
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
    let complete = false;
    setLoading(button,true,translate('检查中…','Checking…')); button.setAttribute('aria-expanded','true');
    host.classList.remove('hidden'); host.setAttribute('aria-busy','true');
    host.innerHTML=`<p class="diagnostic-scope">${account?.user ? (mailaiT('diag.scope') || '本次检查：{user}。').replace('{user}',esc(account.user)) : (mailaiT('diag.scopeNone') || '本次未检测到正在使用的邮箱。')}${mailaiT('diag.scopeNote') || '诊断会实测当前邮箱和已配置的模型服务。'}</p><div class="diagnostic-overall"><span data-diagnostic-summary role="status" aria-live="polite"></span><progress data-diagnostic-progress value="0" max="9" aria-label="检查完成进度" data-i18n-aria="ui.c022bbfed35e"></progress></div>`;
    const summary=host.querySelector('[data-diagnostic-summary]'), progress=host.querySelector('[data-diagnostic-progress]');
    const rowFor = (item) => [...host.querySelectorAll('[data-check-id]')].find(n=>n.dataset.checkId===item.id);
    const updateSummary=()=>{
      const rows=[...items.values()], done=rows.filter(item=>terminal.has(item.status)).length;
      const active=rows.filter(item=>item.status==='running').map(item=>item.name);
      const failed=rows.filter(item=>item.status==='fail').length, warnings=rows.filter(item=>item.status==='warning').length;
      const outcome=failed ? translate(` · ${failed} 项失败`,` · ${failed} failed`) : warnings ? translate(` · ${warnings} 项需要注意`,` · ${warnings} need attention`) : '';
      progress.max=rows.length; progress.value=done;
      mailaiBindUI(summary, "textContent", () => (complete ? translate(`检查完成 · ${done}/${rows.length} 项 · 用时 ${Math.round((Date.now()-start)/1000)} 秒`,`Finished · ${done}/${rows.length} checks · ${Math.round((Date.now()-start)/1000)}s`)+outcome : translate(`已完成 ${done}/${rows.length} 项${active.length ? mailaiText(' · 正在检查：')+active.join('、') : ''}`,`${done}/${rows.length} complete${active.length ? ' · Checking: '+active.join(', ') : ''}`)));
    };
    const update = item => {
      items.set(item.id,item);
      let row=rowFor(item);
      if (!row) { row=document.createElement('div'); row.dataset.checkId=item.id; host.append(row); }
      const status=item.status || (item.ok?'pass':'fail');
      const labels={queued:translate('等待检查','Waiting'),running:translate('正在检查','Checking'),pass:translate('通过','Passed'),warning:translate('需要注意','Attention'),fail:translate('失败','Failed'),interrupted:translate('未完成','Not completed')};
      const icon=status==='pass'?'✓':status==='running'?'':status==='queued'?'·':status==='warning'?'i':'!';
      const guidance=['warning','fail'].includes(status)?diagnosticAdvice(item):null;
      row.className='diagnostic-item '+status;
      row.innerHTML=`<span class="diagnostic-state-icon" aria-hidden="true">${icon}</span><b>${esc(item.name)}<em>${item.probe==='live' ? (mailaiT('diag.live')||'实测'):(mailaiT('diag.local')||'本地')}</em></b><small title="${esc(mailaiSystemMessage(item.detail) || '')}">${esc(mailaiSystemMessage(item.detail) || '')}</small><div class="diagnostic-item-state"><strong>${labels[status] || esc(status)}</strong>${terminal.has(status) && Number.isFinite(item.duration_ms) && item.duration_ms >= 100 ? `<time>${(item.duration_ms/1000).toFixed(1)}s</time>`:''}</div>${guidance ? `<details class="diagnostic-help"><summary>${translate('如何处理','How to fix')}</summary><p class="diagnostic-advice">${esc(guidance.advice)}</p><button type="button" class="diagnostic-action" data-diagnostic-target="${guidance.target}" data-diagnostic-field="${guidance.field}">${guidance.action} →</button></details>`:''}`;
      updateSummary();
    };
    items.forEach(update);
    const timeout=setTimeout(()=>controller.abort(),120000);
    try {
      const response=await fetch(API+`/api/system/diagnostics/stream?lang=${encodeURIComponent(currentI18nLanguage())}`,{headers:accountId?{'X-MailAI-Account':accountId}:{},signal:controller.signal});
      if (!response.ok) { let message=''; try {message=(await response.json()).detail;}catch(_){} throw Error(message || `HTTP ${response.status}`); }
      await readStream(response,event=>{
        if (event.type==='plan') event.checks.forEach(update);
        else if (event.type==='check') update(event.check);
        else if (event.type==='error') throw Error(event.message);
        else if (event.type==='done') { event.data.checks.forEach(item=>update({...items.get(item.id),...item})); complete=true; updateSummary(); const warnings=event.data.checks.filter(item=>item.status==='warning').length; toast(!event.data.ok ? (mailaiT('diag.fail')||'检查发现连接或配置失败') : warnings ? translate(`检查完成，${warnings} 项需要注意`,`Finished; ${warnings} checks need attention`) : (mailaiT('diag.pass')||'检查通过'),!event.data.ok?'error':warnings?'warn':'success'); }
      });
      if (!complete) throw Error(translate('检查连接已中断，请重新检查','Connection interrupted; run diagnostics again'));
    } catch(error) {
      const message=error.name==='AbortError'?translate('检查超时，请检查网络后重试','Diagnostics timed out; check the network and retry'):error.message;
      for (const item of items.values()) if (!terminal.has(item.status)) update({...item,status:'interrupted',detail:message});
      summary.textContent=translate(`检查未完成，已保留 ${[...items.values()].filter(item=>terminal.has(item.status)).length}/${items.size} 项结果。`,`Diagnostics incomplete; ${[...items.values()].filter(item=>terminal.has(item.status)).length}/${items.size} results retained.`);
      toast((mailaiT('diag.failed')||'诊断失败：')+message,'error');
    } finally { clearTimeout(timeout); host.setAttribute('aria-busy','false'); setLoading(button,false); running=false; }
  };
})();
