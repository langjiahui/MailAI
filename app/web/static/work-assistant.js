/* Work guidance belongs to XiaoYou's existing mail context, never the reader. */
(() => {
  const w = key => mailaiT(`work.${key}`) || MAILAI_UI_COPY[`work.${key}`]?.[0] || key;
  const button = (action, label) => `<button type="button" data-work="${action}" data-i18n="work.${label}">${esc(w(label))}</button>`;
  const post = body => ({headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const assistant = document.getElementById('assistant-panel');
  let memoryScheduler=null,scheduledAccount=null;
  const scopePicker = document.getElementById('assistant-scope-picker');
  const eligible = row => !['trash','spam','quarantine','draft','sent'].includes(row?.status);
  const inputPlaceholder = () => target() ? w('talkPlaceholder') : mailaiText('问问你的邮箱…');
  function target() {
    const account = activeMailAccount()?.id;
    const ids = assistantPinnedScope || (document.getElementById('assistant-scope').value === 'selected' && selectedEmailId ? [selectedEmailId] : null);
    if (!account || document.getElementById('assistant-scope').value !== 'selected' || assistantSearchMode || ids?.length !== 1) return null;
    if (assistantScopeKey) {
      try { if (JSON.parse(assistantScopeKey)[0] !== account) return null; } catch (_) { return null; }
    }
    const id = Number(ids[0]);
    if (!Number.isInteger(id) || id <= 0) return null;
    const row = Number(selectedEmailDetail?.id) === id && (selectedEmailAccountId || account) === account ? selectedEmailDetail :
      allEmails.find(item => Number(item.id) === id && (item._account_id || item.account_id || account) === account);
    if (row && !eligible(row)) return null;
    return {account,id,row,key:`${account}:${id}`,revision:assistantRevision};
  }
  const tools = document.createElement('section');
  tools.id = 'assistant-work-tools'; tools.hidden = true;
  tools.innerHTML = `<button type="button" data-work-context><span data-i18n="work.savedContext">${esc(w('savedContext'))}</span></button>`;
  scopePicker.querySelector('.assistant-scope-options').append(tools);
  function positionReferenceTools() {
    if (!scopePicker.open) return;
    const menu = scopePicker.querySelector('.assistant-scope-options');
    const anchor = scopePicker.querySelector('summary').getBoundingClientRect();
    const panelBounds = assistant.getBoundingClientRect();
    const top = Math.max(8,panelBounds.top+8), bottom = Math.min(innerHeight-8,panelBounds.bottom-8);
    const left = Math.max(8,panelBounds.left+8), right = Math.min(innerWidth-8,panelBounds.right-8);
    menu.style.transform = 'none';
    const scale = menu.getBoundingClientRect().width / menu.offsetWidth || 1;
    const above = Math.max(0,anchor.top-top-8*scale), below = Math.max(0,bottom-anchor.bottom-8*scale);
    const upward = above >= below;
    menu.style.boxSizing = 'border-box';
    menu.style.maxHeight = `${(upward ? above : below)/scale}px`;
    menu.style.top = upward ? 'auto' : 'calc(100% + 8px)';
    menu.style.bottom = upward ? 'calc(100% + 8px)' : 'auto';
    const bounds = menu.getBoundingClientRect();
    const x = Math.max(left,Math.min(bounds.left,right-bounds.width));
    menu.style.transform = `translateX(${(x-bounds.left)/scale}px)`;
  }
  let positionFrame = 0;
  const schedulePosition = () => {
    if (positionFrame || !scopePicker.open) return;
    positionFrame = requestAnimationFrame(() => { positionFrame=0; positionReferenceTools(); });
  };
  scopePicker.addEventListener('toggle',schedulePosition);
  window.addEventListener('resize',schedulePosition);
  new ResizeObserver(schedulePosition).observe(assistant);
  function refresh() {
    const account=activeMailAccount()?.id;
    if(account!==scheduledAccount){scheduledAccount=account;memoryScheduler?.();}
    const state = target();
    mailaiBindUI(document.getElementById('assistant-input'),'@placeholder',inputPlaceholder);
    tools.hidden = !state;
    schedulePosition();
    const welcome = document.querySelector('#assistant-messages .assistant-welcome');
    if (!welcome || (welcome.dataset.workScope || '') === (state?.key || '')) return;
    const title = welcome.querySelector('h3'), hint = welcome.querySelector(':scope>p'), quick = welcome.querySelector('.assistant-quick');
    if (state) {
      welcome.dataset.workScope = state.key;
      welcome.classList.add('assistant-conversation-guide');
      title.dataset.i18n = 'work.welcomeTitle'; title.textContent = w('welcomeTitle');
      hint.dataset.i18n = 'work.welcomeHint'; hint.textContent = w('welcomeHint');
      quick.innerHTML = `<button type="button" data-assistant-question="${esc(w('understandPrompt'))}"><span data-i18n="work.talkUnderstand">${esc(w('talkUnderstand'))}</span></button><button type="button" data-assistant-question="${esc(w('replyPrompt'))}"><span data-i18n="work.talkReply">${esc(w('talkReply'))}</span></button>`;
    } else {
      delete welcome.dataset.workScope;
      welcome.classList.remove('assistant-conversation-guide');
      const template = document.getElementById('assistant-welcome-template').content;
      title.replaceWith(template.querySelector('h3').cloneNode(true));
      hint.replaceWith(template.querySelector('.assistant-welcome>p').cloneNode(true));
      quick.replaceChildren(...template.querySelector('.assistant-quick').cloneNode(true).childNodes);
    }
    applyI18n(welcome);
  }
  window.mailaiWorkGuide = {refresh};
  assistant.addEventListener('click', event => {
    if (!event.target.closest('[data-work-context]')) return;
    const state = target();
    if (!state) return;
    scopePicker.open = false;
    if (assistantController) return toast(mailaiText('请先等待当前回答完成，或停止生成'),'warn');
    askAssistant(w('contextPrompt'),[state.id]);
  });
  const input = document.getElementById('assistant-input');
  input.removeAttribute('data-i18n-placeholder');
  mailaiBindUI(input,'@placeholder',inputPlaceholder);
  document.addEventListener('mailai:language-changed', refresh);
  refresh();

  const memoryControls=document.getElementById('xiaoyou-memory-controls');
  const memoryPanel=document.querySelector('[data-system-panel="xiaoyou"]');
  const memoryUse=memoryControls.querySelector('[data-memory-enabled]'), memoryAuto=memoryControls.querySelector('[data-memory-auto]'), memoryClear=memoryControls.querySelector('[data-memory-clear]'), memoryStatus=memoryControls.querySelector('[data-memory-control-status]');
  let memoryState=null,memoryAccount=null,memoryBusy=false,memoryTicket=0;
  function renderMemoryState(data){
    memoryState=data;memoryUse.checked=data.enabled;memoryAuto.checked=data.auto_analyze;
    memoryUse.disabled=false;memoryAuto.disabled=!data.enabled;memoryClear.disabled=false;
    const summary=memoryControls.querySelector('[data-memory-summary]');
    const rows=data.summary;
    summary.innerHTML=`${data.writing_requirements?`<p><small>${esc(w('style'))}</small><br><span class="memory-summary-value">${esc(data.writing_requirements)}</span></p>`:''}${rows.length?rows.slice(0,3).map(row=>`<p><small>${esc(w('kind.'+row.kind))}${row.user_edited?' · '+esc(w('manuallyEdited')):''}</small><br><span class="memory-summary-value">${esc(row.preference)}</span></p>`).join(''):''}${rows.length>3?`<p class="memory-summary-more">${esc(w('summaryMore').replace('{count}',data.total||rows.length))}</p>`:''}${!data.writing_requirements&&!rows.length?`<p>${esc(w('summaryEmpty'))}</p>`:''}`;
  }
  async function loadMemoryState(){
    const account=activeMailAccount()?.id;if(!account)return;
    const ticket=++memoryTicket,switched=memoryAccount!==account;memoryAccount=account;
    memoryControls.querySelector('[data-memory-account]').textContent=`${w('memoryAccount')}${activeMailAccount()?.user||account}`;
    if(switched){memoryState=null;memoryControls.querySelector('[data-memory-summary]').textContent='';}
    clearConfirm.hidden=true;
    memoryUse.disabled=memoryAuto.disabled=memoryClear.disabled=true;
    try{
      const data=await api('/api/work/memory/settings',{accountId:account});
      if(ticket!==memoryTicket||activeMailAccount()?.id!==account)return;
      renderMemoryState(data);memoryStatus.textContent='';
    }catch(error){if(ticket===memoryTicket)memoryStatus.textContent=mailaiSystemMessage(error.message);}
  }
  new MutationObserver(()=>{if(!memoryPanel.classList.contains('hidden'))loadMemoryState();}).observe(memoryPanel,{attributes:true,attributeFilter:['class']});
  for(const control of[memoryUse,memoryAuto])control.onchange=async()=>{
    if(!memoryState||memoryBusy||activeMailAccount()?.id!==memoryAccount)return;
    const account=memoryAccount,previous=memoryState;
    memoryBusy=true;memoryUse.disabled=memoryAuto.disabled=memoryClear.disabled=true;
    try{
      const data=await api('/api/work/memory/settings',{accountId:account,method:'PUT',...post({enabled:memoryUse.checked,auto_analyze:memoryAuto.checked,revision:previous.revision})});
      if(activeMailAccount()?.id!==account)return;renderMemoryState(data);memoryStatus.textContent=w('memorySettingsSaved');
    }catch(error){if(activeMailAccount()?.id===account){renderMemoryState(previous);memoryStatus.textContent=mailaiSystemMessage(error.message);}}
    finally{memoryBusy=false;}
  };
  const clearConfirm=memoryControls.querySelector('[data-memory-clear-confirm]');
  memoryClear.onclick=()=>{clearConfirm.hidden=false;memoryControls.querySelector('[data-memory-clear-no]').focus();};
  memoryControls.querySelector('[data-memory-clear-no]').onclick=()=>{clearConfirm.hidden=true;memoryClear.focus();};
  memoryControls.querySelector('[data-memory-clear-yes]').onclick=async()=>{
    if(!memoryState||memoryBusy||activeMailAccount()?.id!==memoryAccount)return;
    memoryBusy=true;const account=memoryAccount;
    memoryControls.querySelectorAll('button,input').forEach(node=>node.disabled=true);
    try{
      const data=await api('/api/work/memory/clear',{accountId:account,method:'POST',...post({revision:memoryState.revision})});
      if(activeMailAccount()?.id!==account)return;renderMemoryState(data);clearConfirm.hidden=true;memoryStatus.textContent=w('memoriesCleared');
    }catch(error){if(activeMailAccount()?.id===account){renderMemoryState(memoryState);memoryStatus.textContent=mailaiSystemMessage(error.message);}}
    finally{memoryBusy=false;memoryControls.querySelectorAll('[data-memory-clear-confirm] button').forEach(node=>node.disabled=false);}
  };
  document.addEventListener('mailai:language-changed',()=>{if(memoryState)renderMemoryState(memoryState);});
  // Run only after a completed conversation, while this window remains idle.
  // The server rechecks switches, account, idle sources and generation revision.
  let learnTimer=null,lastInteraction=Date.now();
  for(const name of['pointerdown','keydown','input'])document.addEventListener(name,()=>{lastInteraction=Date.now();},{passive:true});
  const scheduleLearning=event=>{
    clearTimeout(learnTimer);const account=event.detail?.account||activeMailAccount()?.id;
    const attempt=async()=>{
      if(activeMailAccount()?.id!==account)return;
      const remaining=95000-(Date.now()-lastInteraction);
      if(assistantController||remaining>0){learnTimer=setTimeout(attempt,Math.max(1000,remaining));return;}
      try{const data=await api('/api/work/memory/analyze?idle=true',{accountId:account,method:'POST'});if(data.more)learnTimer=setTimeout(attempt,95000);}catch(_){/* User work must never depend on background learning. */}
    };
    learnTimer=setTimeout(attempt,95000);
  };
  document.addEventListener('mailai:assistant-finished',scheduleLearning);
  memoryScheduler=()=>scheduleLearning({detail:{account:activeMailAccount()?.id}});
  setTimeout(()=>scheduleLearning({detail:{}}),1000);

  document.getElementById('work-style-settings').addEventListener('click', async event => {
    const account = activeMailAccount();
    if (!account?.id) return toast(w('chooseAccount'),'warn');
    const trigger = event.currentTarget, dialog = document.createElement('dialog');
    dialog.id = 'work-preferences-dialog'; dialog.className = 'work-dialog work-memory-dialog';
    dialog.setAttribute('aria-labelledby','work-preferences-title');
    dialog.innerHTML = `<form><header><h2 id="work-preferences-title">${esc(w('settingsTitle'))}</h2><button type="button" data-close aria-label="${esc(w('close'))}">✕</button></header><p class="work-dialog-source">${esc(account.user || account.id)}</p><p>${esc(w('settingsHint'))}</p><label>${esc(w('style'))}<textarea name="style" maxlength="1000" placeholder="${esc(w('stylePlaceholder'))}" disabled></textarea></label><div class="work-memory-edit-actions"><button type="button" data-reload>${esc(w('reload'))}</button>${button('clear','clear')}<button type="submit" disabled>${esc(w('save'))}</button></div><p role="status" data-status>${esc(w('loadingPreferences'))}</p><section class="work-memory-learning"><div class="work-memory-learning-head"><h3>${esc(w('learningTitle'))}</h3><button type="button" data-analyze>${esc(w('analyze'))}</button></div><p>${esc(w('learningHint'))}</p><div data-memory-list></div><footer class="work-memory-pagination"><button type="button" data-page-prev>${esc(w('previous'))}</button><span data-page-label></span><button type="button" data-page-next>${esc(w('next'))}</button></footer></section></form>`;
    document.body.append(dialog);
    const editor=dialog.querySelector('[name="style"]'), status=dialog.querySelector('[data-status]'), submit=dialog.querySelector('[type="submit"]'), clear=dialog.querySelector('[data-work="clear"]'), reload=dialog.querySelector('[data-reload]'), analyze=dialog.querySelector('[data-analyze]'), list=dialog.querySelector('[data-memory-list]');
    let revision=null, baseStyle='', loading=false, busy=false, filter='adopted', offset=0, pageData=null, ticket=0,learningEnabled=true;
    const active=()=>dialog.isConnected&&dialog.open&&activeMailAccount()?.id===account.id;
    const dirty=()=>editor.value!==baseStyle;
    const updateControls=()=>{
      const editing=list.querySelector('[data-memory-editor]:not([hidden])');
      editor.disabled=submit.disabled=clear.disabled=revision===null||loading||busy||Boolean(editing);
      submit.disabled ||= !dirty();clear.disabled ||= !editor.value;
      reload.disabled=loading||busy||Boolean(editing);analyze.disabled=!learningEnabled||loading||busy||dirty()||Boolean(editing);
      dialog.querySelectorAll('[data-memory-action],[data-page-prev],[data-page-next]').forEach(node=>node.disabled=loading||busy||dirty()||Boolean(editing&&!editing.contains(node)));
      dialog.querySelector('[data-page-prev]').disabled ||= offset===0;
      dialog.querySelector('[data-page-next]').disabled ||= !pageData||offset+pageData.items.length>=pageData.total;
    };
    const applyPreferences=data=>{editor.value=data.style;baseStyle=data.style;revision=data.revision;};
    function renderList(data){
      pageData=data;dialog.querySelector('.work-memory-pagination').hidden=data.total<=20;

      list.innerHTML=data.items.length?data.items.map(row=>`<article class="work-memory-item" data-memory-id="${row.id}"><small>${esc(w('kind.'+row.kind))}${row.user_edited?' · '+esc(w('manuallyEdited')):''}</small><p class="work-memory-value">${esc(row.preference)}</p>${row.reason?`<p class="work-memory-reason">${esc(row.reason)}</p>`:''}<details><summary>${esc(w('evidence'))} · ${row.evidence.length}</summary>${row.evidence.length?row.evidence.map(source=>`<blockquote>${esc(source.quote)}<cite>${esc(source.title||w('confirmedInChat'))} · ${esc(source.created_at||'')}</cite></blockquote>`).join(''):`<p>${esc(w('confirmedInChat'))}</p>`}</details><div class="work-memory-item-actions"><button type="button" data-memory-action="edit">${esc(w('edit'))}</button><button type="button" data-memory-action="delete">${esc(w('deleteMemory'))}</button></div><div data-memory-editor hidden><textarea maxlength="300" aria-label="${esc(w('memoryContent'))}">${esc(row.preference)}</textarea><button type="button" data-memory-action="save">${esc(w('saveEdit'))}</button><button type="button" data-memory-action="cancel">${esc(w('cancelEdit'))}</button></div></article>`).join(''):`<p class="work-memory-empty">${esc(w('noSavedMemories'))}</p>`;
      dialog.querySelector('[data-page-label]').textContent=data.total?`${offset+1}–${offset+data.items.length} / ${data.total}`:'0';
      updateControls();
    }
    const loadList=async()=>{
      const request=++ticket;
      const data=await api(`/api/work/memory?status=${filter}&offset=${offset}&limit=20`,{accountId:account.id});
      if(active()&&request===ticket)renderList(data);
    };
    const load=async()=>{
      if(!active()||loading||busy)return;
      loading=true;updateControls();status.textContent=w('loadingPreferences');
      try{
        const [data,settings]=await Promise.all([api('/api/work/preferences',{accountId:account.id}),api('/api/work/memory/settings',{accountId:account.id}),loadList()]);
        if(!active())return;applyPreferences(data);learningEnabled=settings.enabled;status.textContent=learningEnabled?'':w('memoryPaused');
      }catch(error){if(active())status.textContent=mailaiSystemMessage(error.message);}
      finally{loading=false;if(active())updateControls();}
    };
    editor.oninput=()=>{updateControls();status.textContent=dirty()?w('saveBeforeLearning'):'';};
    clear.onclick=()=>{editor.value='';editor.dispatchEvent(new Event('input'));editor.focus();};
    reload.onclick=load;
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{++ticket;dialog.remove();if(trigger.isConnected)trigger.focus({preventScroll:true});if(!memoryPanel.classList.contains('hidden'))loadMemoryState();},{once:true});
    dialog.querySelector('form').onsubmit=async e=>{
      e.preventDefault();if(!active()||revision===null||busy)return;
      busy=true;updateControls();
      try{
        const data=await api('/api/work/preferences',{accountId:account.id,method:'PUT',...post({style:editor.value,revision})});
        if(!active())return;applyPreferences(data);status.textContent=w('preferencesSaved');await loadList();
      }catch(error){if(active())status.textContent=mailaiSystemMessage(error.message);}
      finally{busy=false;if(active())updateControls();}
    };
    analyze.onclick=async()=>{
      if(!active()||busy||dirty())return;
      busy=true;updateControls();status.textContent=w('analyzing');
      try{
        const data=await api('/api/work/memory/analyze',{accountId:account.id,method:'POST'});
        if(!active())return;filter='adopted';offset=0;await loadList();status.textContent=w(data.more?'analysisMore':data.analyzed?'analysisDone':'noNewConversations');analyze.textContent=w(data.more?'continueAnalysis':'analyze');
      }catch(error){if(active())status.textContent=mailaiSystemMessage(error.message);}
      finally{busy=false;if(active())updateControls();}
    };
    for(const [selector,delta]of[['[data-page-prev]',-20],['[data-page-next]',20]])dialog.querySelector(selector).onclick=async()=>{
      if(busy||dirty())return;offset=Math.max(0,offset+delta);
      try{await loadList();}catch(error){if(active())status.textContent=mailaiSystemMessage(error.message);}
    };
    list.onclick=async event=>{
      const control=event.target.closest('[data-memory-action]'),article=control?.closest('[data-memory-id]');
      if(!control||!article||control.disabled||busy||dirty())return;
      const row=pageData.items.find(item=>item.id===Number(article.dataset.memoryId));if(!row)return;
      const editBox=article.querySelector('[data-memory-editor]');
      if(control.dataset.memoryAction==='edit'){editBox.hidden=false;editBox.querySelector('textarea').focus();updateControls();return;}
      if(control.dataset.memoryAction==='cancel'){editBox.hidden=true;updateControls();return;}
      busy=true;updateControls();
      try{
        const op=control.dataset.memoryAction;
        const data=await api(`/api/work/memory/${row.id}`,{accountId:account.id,method:op==='save'?'PUT':'DELETE',...post(op==='save'?{preference:editBox.querySelector('textarea').value,revision:row.revision,pref_revision:revision}:{revision:row.revision,pref_revision:revision})});
        if(!active())return;applyPreferences(data);status.textContent=w(op==='delete'?'memoryDeleted':'memoryUpdated');if(op==='delete'&&pageData.items.length===1&&offset)offset=Math.max(0,offset-20);await loadList();
      }catch(error){if(active())status.textContent=mailaiSystemMessage(error.message);}
      finally{busy=false;if(active())updateControls();}
    };
    dialog.showModal();await load();
  });

  // Compose controls remain separate from generation, so users can check their
  // own text and retain explicit control over whether to use linked sources.
  const panel = document.getElementById('compose-ai-panel');
  const controls = document.createElement('section');
  controls.className = 'work-compose';
  controls.innerHTML = `<label><input type="checkbox" id="work-use-preferences" checked><span data-i18n="work.useStyle">${esc(w('useStyle'))}</span></label><p data-i18n="work.linkedHint">${esc(w('linkedHint'))}</p>${button('review','review')}<div data-work-review role="status"></div>`;
  panel.querySelector('.compose-ai-scroll').append(controls);
  let reviewSnapshot = null;
  const reviewFingerprint = () => JSON.stringify([composeMessageElement().innerText,
    composeAttachments.map(item => [item.filename || item.name || '', item.size || 0, item.sha256 || ''])]);
  const sameFiles = files => files.length === composeAttachments.length && files.every((item,index) => item === composeAttachments[index]);
  const invalidateReview = () => {
    if (!reviewSnapshot) return;
    if (reviewSnapshot.session !== draftSession) { reviewSnapshot = null; return; }
    if (reviewSnapshot.fingerprint !== reviewFingerprint() || !sameFiles(reviewSnapshot.files)) {
      controls.querySelector('[data-work-review]').textContent = w('edited');
      reviewSnapshot = null;
    }
  };
  new MutationObserver(invalidateReview).observe(document.getElementById('compose-body'),{subtree:true,childList:true,characterData:true});
  new MutationObserver(invalidateReview).observe(document.getElementById('compose-attachments'),{subtree:true,childList:true});
  controls.querySelector('[data-work="review"]').onclick = async event => {
    const session = draftSession, account = composeAccountId, id = composeContext.reply_to_email_id;
    const output = controls.querySelector('[data-work-review]'), control = event.currentTarget;
    if (!id) { output.textContent = w('replyOnly'); return; }
    const body = composeMessageElement().innerText;
    const names = composeAttachments.map(item => item.filename || item.name || '');
    const current = () => session === draftSession && !session.canceled && account === composeAccountId && document.body.classList.contains('compose-open');
    const original = reviewFingerprint(), files = [...composeAttachments];
    reviewSnapshot = null;
    control.disabled = true;
    output.textContent = w('reviewing');
    const finish = globalThis.mailaiCompanionWork?.begin();
    try {
      const result = await api('/api/work/review',{accountId:account,method:'POST',...post({email_id:id,body,attachment_names:names,semantic:true})});
      if (!current()) return;
      if (reviewFingerprint() !== original || !sameFiles(files)) { output.textContent = w('edited'); return; }
      reviewSnapshot = {session,fingerprint:original,files};
      output.innerHTML = result.items.length ? result.items.map(item => `<p>${item.question ? `<q>${esc(item.question)}</q><br>` : ''}${esc(mailaiSystemMessage(item.note))}</p>`).join('') : `<p>${esc(result.model_used ? w('noOmissions') : mailaiSystemMessage(result.note || ''))}</p>`;
      output.insertAdjacentHTML('beforeend',`<small>${esc(w('reviewHint'))}</small>`);
      if (result.limited) output.insertAdjacentHTML('beforeend',`<p>${esc(w('limited'))}</p>`);
    } catch (error) { if (current()) output.textContent = mailaiSystemMessage(error.message); }
    finally { finish?.(); control.disabled = false; }
  };
  new MutationObserver(() => {
    if (!document.body.classList.contains('compose-open')) {
      controls.querySelector('[data-work-review]').textContent = '';
      reviewSnapshot = null;
      document.getElementById('work-use-preferences').checked = true;
    }
  }).observe(document.body,{attributes:true,attributeFilter:['class']});
  window.mailaiPrepareFollowup = async (sentId, account) => {
    const active = activeMailAccount()?.id;
    const seed = await api(`/api/work/followups/${Number(sentId)}/prepare`,{accountId:account});
    if (active !== activeMailAccount()?.id) return;
    const opened = await openCompose({...seed,account_id:account});
    if (opened) {
      document.getElementById('compose-ai-instruction').value = w('followupInstruction');
      toggleComposeAiPanel(true);
    }
  };
  window.mailaiOpenWork = async (id, account) => {
    if (account !== activeMailAccount()?.id) return;
    await revealEmailFromSource(id);
    if (account !== activeMailAccount()?.id || Number(selectedEmailDetail?.id) !== Number(id)) return;
    openAssistantForEmail(selectedEmailDetail);
    await askAssistant(w('understandPrompt'), [Number(id)]);
  };
})();
