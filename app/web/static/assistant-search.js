/* Search follow-through: reliable refinements, visible conditions and reader return. */
(() => {
  const runs=new Map(), messages=new Map();
  let latest='', reader=null, failedNode=null, opening=null;
  const owner=()=>activeMailAccount()?.id || '';
  const t=key=>mailaiText(MAILAI_UI_COPY['searchLoop.'+key][0]);
  const actionNames={exclude_results:'wrong',relax_dates:'dates',relax_keywords:'keywords',undo:'undo',retry:'retry'};
  function current(run){return run && run.account===owner() && run.conversation_id===assistantConversationId;}
  function clearReader(){reader=null;document.querySelector('.assistant-search-return')?.remove();}
  function reset(){runs.clear();messages.clear();latest='';failedNode=null;opening=null;clearReader();}
  function base(){const run=runs.get(latest);return current(run)&&run.status==='complete'?{search_run_id:run.id}:null;}
  function idle(){
    if(!assistantController)document.querySelectorAll('[data-search-pending]').forEach(node=>delete node.dataset.searchPending);
    document.querySelectorAll('[data-search-loop-action],[data-search-loop-clue],[data-search-loop-more],[data-search-loop-source],[data-search-loop-retry],.assistant-search-clue :is(input,select,button)').forEach(button=>{button.disabled=Boolean(assistantController||opening);});
  }
  function summary(run){
    const labels={sender:t('sender'),recipient:t('recipient'),subject:t('subject'),filename:t('filename'),after:t('after'),before:t('before'),state:t('state'),category:t('category'),mailbox:mailaiText('邮件范围')};
    const mailboxes={inbox:mailaiText('收件箱'),sent:mailaiText('已发送'),drafts:mailaiText('草稿'),trash:mailaiText('已删除'),spam:mailaiText('垃圾邮件'),quarantine:mailaiText('隔离区')};
    const states={unhandled:mailaiText('待处理'),reply:mailaiText('待回复'),waiting:mailaiText('等待反馈'),later:mailaiText('稍后处理'),done:mailaiText('已完成'),due:mailaiText('等待反馈已到期'),focus:mailaiText('重点邮件')};
    const chips=(run.conditions || []).filter(c=>c.field!=='mailbox'||c.value!=='all').map(c=>{
      const value=c.field==='state' ? states[c.value] || c.value : c.field==='mailbox'?mailboxes[c.value] || c.value:c.value;
      const text=c.field==='has_attachment'?t('withAttachments'):c.field==='unread'?t('unread'):`${labels[c.field] || c.field}: ${value}`;
      return `<span title="${esc(text)}">${esc(text)}</span>`;
    });
    if(run.keywords?.length)chips.push(`<span title="${esc(run.keywords.join(' · '))}">${esc(t('keywordsLabel'))}: ${esc(run.keywords.join(' · '))}</span>`);
    return chips.join('');
  }
  function render(id){
    const run=runs.get(id),node=messages.get(id);if(!run||!node?.isConnected)return;
    node.dataset.searchRunId=id;
    node.querySelector('.assistant-sources')?.remove();
    node.querySelector('.assistant-search-result')?.remove();
    const sources=run.sources || [];
    const found=sources.find(source=>Number(source.id)===Number(run.found_id));
    const shown=found?[found]:sources;
    const active=id===latest && run.status==='complete';
    const adjustment={relax_dates:'datesChanged',relax_keywords:'keywordsChanged',set_sender:'senderChanged',set_keywords:'clueChanged',undo:'undone'}[run.adjustment];
    const actions=(run.actions || []).filter(action=>action!=='undo').slice(0,2);
    const clueIsSender=!(run.conditions || []).some(condition=>condition.field==='sender');
    const sourceRows=shown.map((source,index)=>`<button type="button" class="assistant-search-source" data-search-loop-source="${Number(source.id)}" ${index>=3?'hidden':''}>
      <span class="assistant-search-source-index">${index+1}</span><span><b>${esc(source.subject || mailaiText('（无主题）'))}</b><small>${esc([source.from_name || source.from_addr,String(source.date || '').slice(0,10)].filter(Boolean).join(' · '))}</small></span><span aria-hidden="true">↗</span></button>`).join('');
    const html=`<section class="assistant-search-result${found?' is-found':''}" aria-label="${esc(t('results'))}">
      <header><b>${esc(found?t('found'):sources.length?t('candidates'):t('empty'))}</b><small>${sources.length&&!found?String(sources.length):''}</small></header>
      <div class="assistant-search-conditions">${summary(run)}</div>
      <small class="assistant-search-scope">${esc(run.account_user)} · ${esc(t('localScope'))}</small>
      ${adjustment?`<small class="assistant-search-change" role="status">${esc(t(adjustment))}</small>`:''}
      ${run.excluded_count?`<small class="assistant-search-skipped">${esc(t('skipped').replace('{0}',run.excluded_count))}</small>`:''}
      <div class="assistant-search-source-list">${sourceRows}</div>
      ${shown.length>3?`<button type="button" class="assistant-search-more" data-search-loop-more>${esc(t('more').replace('{0}',shown.length-3))}</button>`:''}
      ${active?`<div class="assistant-search-controls">${found?`<button type="button" data-search-loop-action="resume">${esc(t('continue'))}</button>`:
      `<div class="assistant-search-actions">${actions.map(action=>`<button type="button" data-search-loop-action="${action}" title="${esc(action==='exclude_results'?t('wrongHint'):t(actionNames[action]))}">${esc(t(actionNames[action]))}</button>`).join('')}<button type="button" data-search-loop-clue>${esc(t('clue'))}</button></div>
      <form class="assistant-search-clue" hidden><label><span>${esc(t('clueType'))}</span><select aria-label="${esc(t('clueType'))}"><option value="set_sender" ${clueIsSender?'selected':''}>${esc(t('sender'))}</option><option value="set_keywords" ${clueIsSender?'':'selected'}>${esc(t('topicWord'))}</option></select></label><label><span class="assistant-search-clue-label">${esc(t(clueIsSender?'sender':'topicWord'))}</span><input maxlength="250" placeholder="${esc(t(clueIsSender?'senderPlaceholder':'keywordPlaceholder'))}" required></label><div><button type="submit">${esc(t('searchAgain'))}</button><button type="button" data-search-loop-cancel>${esc(t('cancel'))}</button></div></form>`}
      <div class="assistant-search-secondary">${!found&&run.actions?.includes('undo')?`<button type="button" data-search-loop-action="undo">${esc(t('undo'))}</button>`:''}<button type="button" data-search-loop-action="new">${esc(t('new'))}</button></div></div>`:
      run.status==='error'?`<button type="button" data-search-loop-action="retry">${esc(t('retry'))}</button>`:`<small>${esc(t('previous'))}</small>`}
    </section>`;
    node.querySelector('.assistant-bubble').insertAdjacentHTML('beforeend',html);
    if(!found){const controls=node.querySelector('.assistant-search-controls');if(controls)node.querySelector('.assistant-search-source-list').before(controls);}
    idle();
  }
  function remember(node,meta,sources){
    const run={...meta,account:owner(),sources};runs.set(run.id,run);messages.set(run.id,node);
    if(run.status==='complete')latest=run.id;
    render(run.id);
  }
  function focusLatest(){const node=messages.get(latest);if(!node?.isConnected)return;const host=document.getElementById('assistant-messages');const box=host.getBoundingClientRect();host.scrollTop+=(node.getBoundingClientRect().top-box.top)/(box.height/host.clientHeight || 1);}
  function complete(node,meta,sources){remember(node,meta,sources);for(const id of runs.keys())if(id!==meta.id)render(id);queueMicrotask(focusLatest);}
  function restore(node,meta,sources){const previous=latest;remember(node,meta,sources);if(previous&&previous!==latest)render(previous);}
  function begin(node,mode){failedNode=null;document.querySelectorAll('[data-search-loop-retry]').forEach(button=>button.remove());if(mode)node.dataset.searchPending='true';idle();}
  function failed(node){failedNode=node;node.querySelector('.assistant-bubble').insertAdjacentHTML('beforeend',`<button type="button" class="assistant-search-inline-retry" data-search-loop-retry>${esc(t('retry'))}</button>`);}
  function refine(run,action,value=''){
    if(!current(run)||assistantController||opening)return;
    if(action==='new'){
      resetAssistantConversation();assistantSearchMode=true;assistantPinnedScope=null;
      document.getElementById('assistant-scope').value='account';
      const input=document.getElementById('assistant-input');input.value='';input.placeholder=t('newPlaceholder');input.focus();return;
    }
    const question=action==='set_sender'?t('senderQuestion').replace('{0}',value):action==='set_keywords'?t('keywordQuestion').replace('{0}',value):t(actionNames[action]);
    askAssistant(question,null,[],[],false,{searchMode:true,searchRequest:{search_run_id:run.id,search_action:action,search_value:value}});
  }
  async function mark(run,emailId){
    const account=owner();
    const meta=await api(`/api/assistant/search-runs/${run.id}/found`,{accountId:account,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email_id:emailId})});
    if(account!==owner()||!current(run))return;
    runs.set(run.id,{...run,...meta});render(run.id);return true;
  }
  async function returnToResults(){
    const context=reader;if(!context||context.account!==owner())return;
    if(assistantConversationId!==context.conversation)await loadAssistantConversation(context.conversation);
    if(context.account!==owner())return;
    openAssistant();messages.get(context.runId)?.scrollIntoView({block:'nearest'});
  }
  async function openSource(run,emailId){
    if(!current(run)||assistantController||opening)return;
    const account=owner(),conversation=assistantConversationId;
    const ticket={account,conversation,emailId};opening=ticket;idle();
    try{
      await goToAssistantEmail(emailId);
      if(account!==owner()||conversation!==assistantConversationId||selectedEmailId!==emailId)return;
      if(!selectedEmailDetail){
        openAssistant();const node=messages.get(run.id);node?.querySelector('.assistant-search-open-error')?.remove();
        node?.querySelector('.assistant-search-source-list')?.insertAdjacentHTML('beforebegin',`<p class="assistant-search-open-error" role="alert">${esc(t('openFailed'))}</p>`);
        node?.scrollIntoView({block:'nearest'});return;
      }
      if(run.status!=='complete')return;
      reader={account,conversation,runId:run.id,emailId};
      const bar=document.createElement('div');bar.className='assistant-search-return';
      bar.innerHTML=`<span>${esc(t('reviewing'))}</span><div><button type="button" data-search-return>${esc(t('back'))}</button><button type="button" data-search-found>${esc(t('thisOne'))}</button></div>`;
      document.getElementById('reading-content').before(bar);
      bar.querySelector('[data-search-return]').onclick=returnToResults;
      bar.querySelector('[data-search-found]').onclick=async()=>{
        const context=reader;if(!context)return;
        bar.querySelectorAll('button').forEach(button=>button.disabled=true);
        try{if(await mark(run,emailId) && reader===context){await returnToResults();clearReader();}}
        catch(error){if(account===owner())toast(mailaiSystemMessage(error.message),'error');}
        finally{bar.querySelectorAll('button').forEach(button=>button.disabled=false);}
      };
    }catch(error){if(account===owner())toast(mailaiSystemMessage(error.message),'error');}
    finally{if(opening===ticket)opening=null;idle();}
  }
  const host=document.getElementById('assistant-messages');
  host.addEventListener('click',async event=>{
    const node=event.target.closest('[data-search-run-id]'),run=runs.get(node?.dataset.searchRunId);
    if(node&&!run&&assistantController&&event.target.closest('[data-email-id]')){event.preventDefault();event.stopImmediatePropagation();return;}
    if(event.target.closest('[data-search-loop-retry]')){event.stopImmediatePropagation();if(failedNode===event.target.closest('.assistant-message')&&!assistantController)document.getElementById('assistant-retry').click();return;}
    if(!run)return;
    const source=event.target.closest('[data-search-loop-source],[data-email-id]');
    if(source){event.preventDefault();event.stopImmediatePropagation();openSource(run,Number(source.dataset.searchLoopSource || source.dataset.emailId));return;}
    if(event.target.closest('[data-search-loop-more]')){
      const button=event.target.closest('button'),expanded=button.dataset.expanded==='true';
      const sources=[...node.querySelectorAll('.assistant-search-source')];
      sources.forEach((source,index)=>{if(index>=3)source.hidden=expanded;});
      button.dataset.expanded=String(!expanded);button.textContent=expanded?t('more').replace('{0}',sources.length-3):t('collapseSources');
      if(expanded)button.scrollIntoView({block:'nearest'});return;
    }
    const button=event.target.closest('[data-search-loop-action]');
    if(button){
      if(assistantController||!current(run))return;
      const action=button.dataset.searchLoopAction;
      if(action==='resume'){try{if(await mark(run,null))render(run.id);}catch(error){toast(mailaiSystemMessage(error.message),'error');}return;}
      refine(run,action);return;
    }
    const clue=node.querySelector('.assistant-search-clue');
    if(event.target.closest('[data-search-loop-clue]')&&clue){clue.hidden=!clue.hidden;if(!clue.hidden)clue.querySelector('input').focus();}
    if(event.target.closest('[data-search-loop-cancel]')&&clue){clue.hidden=true;node.querySelector('[data-search-loop-clue]').focus();}
  },true);
  host.addEventListener('change',event=>{
    const form=event.target.closest('.assistant-search-clue');if(!form||event.target.tagName!=='SELECT')return;
    const sender=event.target.value==='set_sender';form.querySelector('.assistant-search-clue-label').textContent=t(sender?'sender':'topicWord');form.querySelector('input').placeholder=t(sender?'senderPlaceholder':'keywordPlaceholder');form.querySelector('input').focus();
  });
  host.addEventListener('submit',event=>{
    const form=event.target.closest('.assistant-search-clue');if(!form)return;event.preventDefault();
    const run=runs.get(form.closest('[data-search-run-id]').dataset.searchRunId);
    const value=form.querySelector('input').value.trim();if(value)refine(run,form.querySelector('select').value,value);
  });
  host.addEventListener('keydown',event=>{const form=event.target.closest('.assistant-search-clue');if(form&&event.key==='Escape'){form.hidden=true;form.closest('.assistant-search-result').querySelector('[data-search-loop-clue]').focus();event.stopPropagation();}});
  document.addEventListener('mailai:language-changed',()=>{for(const id of runs.keys())render(id);focusLatest();});
  window.mailaiAssistantSearch={reset,base,begin,idle,complete,restore,failed,clearReader,focusLatest};
})();
