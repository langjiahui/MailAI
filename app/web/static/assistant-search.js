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
    document.querySelectorAll('[data-search-loop-action],[data-search-edit],[data-search-loop-clue],[data-search-loop-more],[data-search-loop-source],[data-search-loop-retry],.assistant-search-clue :is(input,select,button)').forEach(button=>{button.disabled=Boolean(assistantController||opening);});
    for(const [id,node] of messages){
      node.querySelectorAll('[data-search-loop-source]').forEach(button=>{
        const busy=opening?.runId===id && opening.emailId===Number(button.dataset.searchLoopSource);
        button.classList.toggle('is-opening',busy);
        if(busy)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
        const label=button.querySelector('[data-search-open-label]');if(label)label.textContent=busy?t('openingMail'):t('openMail');
        if(runs.get(id)?.reviewedId===Number(button.dataset.searchLoopSource))button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');
      });
      const status=node.querySelector('.assistant-search-open-status');
      node.querySelectorAll('[data-search-source-details]').forEach(button=>{
        if(runs.get(id)?.reviewedId===Number(button.dataset.searchSourceDetails))button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');
      });
      if(status)status.hidden=opening?.runId!==id;
    }
  }
  function summary(run,editable){
    const labels={sender:t('sender'),recipient:t('recipient'),subject:t('subject'),filename:t('filename'),after:t('after'),before:t('before'),state:t('state'),category:t('category'),mailbox:mailaiText('邮件范围')};
    const mailboxes={inbox:mailaiText('收件箱'),sent:mailaiText('已发送'),drafts:mailaiText('草稿'),trash:mailaiText('已删除'),spam:mailaiText('垃圾邮件'),quarantine:mailaiText('隔离区')};
    const states={unhandled:mailaiText('待处理'),reply:mailaiText('待回复'),waiting:mailaiText('等待反馈'),later:mailaiText('稍后处理'),done:mailaiText('已完成'),due:mailaiText('等待反馈已到期'),focus:mailaiText('重点邮件')};
    const chips=(run.conditions || []).filter(c=>c.field!=='mailbox'||c.value!=='all').map(c=>{
      const value=c.field==='state' ? states[c.value] || c.value : c.field==='mailbox'?mailboxes[c.value] || c.value:c.value;
      const text=c.field==='has_attachment'?t('withAttachments'):c.field==='unread'?t('unread'):`${labels[c.field] || c.field}: ${value}`;
      if(editable&&c.field==='sender')return `<button type="button" class="assistant-search-condition" data-search-edit="set_sender" aria-expanded="false" aria-controls="search-clue-${esc(run.id)}" aria-label="${esc(t('editSender'))}" title="${esc(t('editSender')+' · '+text)}"><span>${esc(text)}</span><span aria-hidden="true">✎</span></button>`;
      return `<span title="${esc(text)}">${esc(text)}</span>`;
    });
    if(run.keywords?.length){
      const text=`${t('keywordsLabel')}: ${run.keywords.join(' · ')}`;
      chips.push(editable?`<button type="button" class="assistant-search-condition" data-search-edit="set_keywords" aria-expanded="false" aria-controls="search-clue-${esc(run.id)}" aria-label="${esc(t('editKeywords'))}" title="${esc(t('editKeywords')+' · '+text)}"><span>${esc(text)}</span><span aria-hidden="true">✎</span></button>`:`<span title="${esc(text)}">${esc(text)}</span>`);
    }
    return chips.join('');
  }
  function clueVisibility(node,visible,trigger){
    const form=node.querySelector('.assistant-search-clue');if(!form)return;
    if(trigger)form._returnFocus=trigger;
    form.hidden=!visible;
    node.querySelectorAll('[data-search-edit],[data-search-loop-clue]').forEach(button=>button.setAttribute('aria-expanded',String(visible&&button===form._returnFocus)));
    if(visible){form.querySelector('input').focus();form.querySelector('input').select();}
    else if(form._returnFocus?.isConnected)form._returnFocus.focus({preventScroll:true});
  }
  function openClue(node,run,trigger,action){
    const form=node.querySelector('.assistant-search-clue');if(!form)return;
    const sender=action?action==='set_sender':!(run.conditions||[]).some(c=>c.field==='sender');
    form.querySelector('select').value=sender?'set_sender':'set_keywords';
    form.querySelector('.assistant-search-clue-label').textContent=t(sender?'sender':'topicWord');
    const input=form.querySelector('input');input.placeholder=t(sender?'senderPlaceholder':'keywordPlaceholder');
    input.value=action?(sender?(run.conditions||[]).find(c=>c.field==='sender')?.value||'':(run.keywords||[]).join(' ')):'';
    form.dataset.originalValue=input.value.trim();form.dataset.originalAction=form.querySelector('select').value;
    clueVisibility(node,true,trigger);
  }
  function sourceTime(value){
    const date=new Date(value);
    return Number.isNaN(date.getTime())?String(value).slice(0,16):date.toLocaleString(currentI18nLanguage(),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  }
  function render(id){
    const run=runs.get(id),node=messages.get(id);if(!run||!node?.isConnected)return;
    node.dataset.searchRunId=id;
    node.querySelector('.assistant-sources')?.remove();
    node.querySelector('.assistant-search-result')?.remove();
    const sources=run.sources || [];
    const found=sources.find(source=>Number(source.id)===Number(run.found_id));
    const shown=found?[found]:sources;
    const expanded=Boolean(run.expanded)&&!found;
    const active=id===latest && run.status==='complete';
    const adjustment={relax_dates:'datesChanged',relax_keywords:'keywordsChanged',set_sender:'senderChanged',set_keywords:'clueChanged',undo:'undone'}[run.adjustment];
    const actions=(run.actions || []).filter(action=>action!=='undo').slice(0,2);
    const clueIsSender=!(run.conditions || []).some(condition=>condition.field==='sender');
    const sourceRows=shown.map((source,index)=>{
      const details=run.details?.has(Number(source.id))||false,subject=source.subject||mailaiText('（无主题）');
      const detailId=`search-source-${run.id}-${Number(source.id)}`;
      return `<div class="assistant-search-candidate" ${index>=3&&!expanded?'hidden':''}>
        <button type="button" class="assistant-search-source" data-search-source-details="${Number(source.id)}" aria-expanded="${details}" aria-controls="${esc(detailId)}" aria-label="${esc((details?t('hideDetails'):t('showDetails'))+': '+subject)}" title="${esc([subject,source.from_name,source.from_addr].filter(Boolean).join('\n'))}" ${index>=3&&!expanded?'hidden':''}>
          <span class="assistant-search-source-index">${index+1}</span><span><b>${esc(subject)}</b><small>${esc([source.from_name || source.from_addr,String(source.date || '').slice(0,10)].filter(Boolean).join(' · '))}</small></span><span class="assistant-search-source-chevron" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m6 8 4 4 4-4"/></svg></span>
        </button>
        <div class="assistant-search-detail" id="${esc(detailId)}" ${details?'':'hidden'}>
          <dl><dt>${esc(t('sender'))}</dt><dd>${esc(source.from_addr||source.from_name||'')}</dd>${source.date?`<dt>${esc(t('date'))}</dt><dd><time datetime="${esc(source.date)}">${esc(sourceTime(source.date))}</time></dd>`:''}</dl>
          ${source.preview?`<p class="assistant-search-excerpt"><strong>${esc(t('preview'))}</strong>${esc(source.preview)}</p>`:''}
          <footer class="assistant-search-detail-actions"><button type="button" class="assistant-search-open-mail" data-search-loop-source="${Number(source.id)}" aria-label="${esc(t('openMail')+': '+subject)}" title="${esc(subject)}"><span data-search-open-label>${esc(t('openMail'))}</span><span class="assistant-search-source-open" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M4 10h12m-5-5 5 5-5 5"/></svg></span></button></footer>
        </div>
      </div>`;
    }).join('');
    const html=`<section class="assistant-search-result${found?' is-found':''}" aria-label="${esc(t('results'))}">
      <header><b>${esc(found?t('found'):sources.length?t('candidates'):t('empty'))}</b><small>${sources.length&&!found?String(sources.length):''}</small></header>
      <div class="assistant-search-conditions">${summary(run,active&&!found)}</div>
      <small class="assistant-search-scope">${esc(run.account_user)} · ${esc(t('localScope'))}</small>
      ${adjustment?`<small class="assistant-search-change" role="status">${esc(t(adjustment))}</small>`:''}
      ${run.excluded_count?`<small class="assistant-search-skipped">${esc(t('skipped').replace('{0}',run.excluded_count))}</small>`:''}
      <p class="assistant-search-open-status" role="status" hidden>${esc(t('opening'))}</p>
      <div class="assistant-search-source-list">${sourceRows}</div>
      ${shown.length>3?`<button type="button" class="assistant-search-more" data-search-loop-more data-expanded="${expanded}" aria-expanded="${expanded}">${esc(expanded?t('collapseSources'):t('more').replace('{0}',shown.length-3))}</button>`:''}
      ${active?`<div class="assistant-search-controls">${found?`<button type="button" data-search-loop-action="resume">${esc(t('continue'))}</button>`:
      `<div class="assistant-search-actions">${actions.map(action=>`<button type="button" data-search-loop-action="${action}" title="${esc(action==='exclude_results'?t('wrongHint'):t(actionNames[action]))}">${esc(t(actionNames[action]))}</button>`).join('')}<button type="button" data-search-loop-clue aria-expanded="false" aria-controls="search-clue-${esc(run.id)}">${esc(t('clue'))}</button></div>
      <form id="search-clue-${esc(run.id)}" class="assistant-search-clue" hidden><label><span>${esc(t('clueType'))}</span><select aria-label="${esc(t('clueType'))}"><option value="set_sender" ${clueIsSender?'selected':''}>${esc(t('sender'))}</option><option value="set_keywords" ${clueIsSender?'':'selected'}>${esc(t('topicWord'))}</option></select></label><label><span class="assistant-search-clue-label">${esc(t(clueIsSender?'sender':'topicWord'))}</span><input maxlength="250" placeholder="${esc(t(clueIsSender?'senderPlaceholder':'keywordPlaceholder'))}" required></label><div><button type="submit">${esc(t('searchAgain'))}</button><button type="button" data-search-loop-cancel>${esc(t('cancel'))}</button></div></form>`}
      <div class="assistant-search-secondary">${!found&&run.actions?.includes('undo')?`<button type="button" data-search-loop-action="undo">${esc(t('undo'))}</button>`:''}<button type="button" data-search-loop-action="new">${esc(t('new'))}</button></div></div>`:
      run.status==='error'?`<button type="button" data-search-loop-action="retry">${esc(t('retry'))}</button>`:`<small>${esc(t('previous'))}</small>`}
    </section>`;
    node.querySelector('.assistant-bubble').insertAdjacentHTML('beforeend',html);
    if(!found){const controls=node.querySelector('.assistant-search-controls');if(controls)node.querySelector('.assistant-search-source-list').before(controls);}
    idle();
  }
  function remember(node,meta,sources){
    const previous=runs.get(meta.id);
    const run={...meta,account:owner(),sources,details:previous?.details,expanded:previous?.expanded};runs.set(run.id,run);messages.set(run.id,node);
    if(run.status==='complete')latest=run.id;
    render(run.id);
  }
  function focusLatest(){const node=messages.get(latest);if(!node?.isConnected)return;window.mailaiAssistantScroll?.pause();const host=document.getElementById('assistant-messages');const box=host.getBoundingClientRect();host.scrollTop+=(node.getBoundingClientRect().top-box.top)/(box.height/host.clientHeight || 1);}
  function complete(node,meta,sources){const follow=window.mailaiAssistantScroll?.isFollowing()??true;remember(node,meta,sources);for(const id of runs.keys())if(id!==meta.id)render(id);if(follow)queueMicrotask(focusLatest);}
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
  async function restorePosition(context){
    await new Promise(resolve=>requestAnimationFrame(resolve));
    if(context.account!==owner()||context.conversation!==assistantConversationId)return;
    const node=messages.get(context.runId),run=runs.get(context.runId);
    if(!node||!run)return;
    let changed=false;
    if(context.expanded&&!run.expanded&&!run.found_id){run.expanded=true;changed=true;}
    if(context.detailsExpanded&&!run.details?.has(context.emailId)){if(!run.details)run.details=new Set();run.details.add(context.emailId);changed=true;}
    if(changed)render(run.id);
    const source=node.querySelector(`[data-search-source-details="${context.emailId}"]`);
    source?.focus({preventScroll:true});
    window.mailaiAssistantScroll?.restore(context.scrollTop);
  }
  async function returnToResults(){
    const context=reader;if(!context||context.account!==owner())return;
    if(assistantConversationId!==context.conversation)await loadAssistantConversation(context.conversation);
    if(context.account!==owner())return;
    openAssistant();await restorePosition(context);
  }
  async function openSource(run,emailId){
    if(!current(run)||assistantController||opening)return;
    const account=owner(),conversation=assistantConversationId;
    const ticket={account,conversation,emailId,runId:run.id,expanded:Boolean(run.expanded),detailsExpanded:Boolean(run.details?.has(emailId)),scrollTop:host.scrollTop};opening=ticket;idle();
    try{
      await goToAssistantEmail(emailId);
      if(opening!==ticket||account!==owner()||conversation!==assistantConversationId||selectedEmailId!==emailId)return;
      if(!selectedEmailDetail){
        openAssistant();const node=messages.get(run.id);node?.querySelector('.assistant-search-open-error')?.remove();
        node?.querySelector('.assistant-search-source-list')?.insertAdjacentHTML('beforebegin',`<p class="assistant-search-open-error" role="alert">${esc(t('openFailed'))}</p>`);
        await restorePosition(ticket);return;
      }
      if(run.status!=='complete')return;
      run.reviewedId=emailId;
      reader=ticket;
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
    }catch(error){if(account===owner()&&conversation===assistantConversationId){openAssistant();await restorePosition(ticket);toast(mailaiSystemMessage(error.message),'error');}}
    finally{if(opening===ticket)opening=null;idle();}
  }
  const host=document.getElementById('assistant-messages');
  host.addEventListener('click',async event=>{
    const node=event.target.closest('[data-search-run-id]'),run=runs.get(node?.dataset.searchRunId);
    if(node&&!run&&assistantController&&event.target.closest('[data-email-id]')){event.preventDefault();event.stopImmediatePropagation();return;}
    if(event.target.closest('[data-search-loop-retry]')){event.stopImmediatePropagation();if(failedNode===event.target.closest('.assistant-message')&&!assistantController)document.getElementById('assistant-retry').click();return;}
    if(!run)return;
    const detail=event.target.closest('[data-search-source-details]');
    if(detail){
      event.preventDefault();event.stopImmediatePropagation();
      const id=Number(detail.dataset.searchSourceDetails),expanded=detail.getAttribute('aria-expanded')!=='true';
      if(!run.details)run.details=new Set();if(expanded)run.details.add(id);else run.details.delete(id);
      detail.focus({preventScroll:true});
      window.mailaiAssistantScroll?.pause();detail.setAttribute('aria-expanded',String(expanded));
      const source=run.sources.find(source=>Number(source.id)===id);
      detail.setAttribute('aria-label',(expanded?t('hideDetails'):t('showDetails'))+': '+(source?.subject||mailaiText('（无主题）')));
      document.getElementById(detail.getAttribute('aria-controls')).hidden=!expanded;
      window.mailaiAssistantScroll?.changed();return;
    }
    const edit=event.target.closest('[data-search-edit]');
    if(edit){if(!assistantController&&!opening)openClue(node,run,edit,edit.dataset.searchEdit);return;}
    const source=event.target.closest('[data-search-loop-source],[data-email-id]');
    if(source){event.preventDefault();event.stopImmediatePropagation();openSource(run,Number(source.dataset.searchLoopSource || source.dataset.emailId));return;}
    if(event.target.closest('[data-search-loop-more]')){
      const button=event.target.closest('button'),expanded=button.dataset.expanded==='true';
      const sources=[...node.querySelectorAll('.assistant-search-source')];
      sources.forEach((source,index)=>{if(index>=3){source.hidden=expanded;source.closest('.assistant-search-candidate').hidden=expanded;}});
      run.expanded=!expanded;
      button.dataset.expanded=String(!expanded);button.setAttribute('aria-expanded',String(!expanded));button.textContent=expanded?t('more').replace('{0}',sources.length-3):t('collapseSources');
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
    const trigger=event.target.closest('[data-search-loop-clue]');
    if(trigger&&clue){if(clue.hidden)openClue(node,run,trigger);else clueVisibility(node,false);}
    if(event.target.closest('[data-search-loop-cancel]')&&clue)clueVisibility(node,false);
  },true);
  host.addEventListener('change',event=>{
    const form=event.target.closest('.assistant-search-clue');if(!form||event.target.tagName!=='SELECT')return;
    const sender=event.target.value==='set_sender';form.querySelector('.assistant-search-clue-label').textContent=t(sender?'sender':'topicWord');form.querySelector('input').placeholder=t(sender?'senderPlaceholder':'keywordPlaceholder');form.querySelector('input').focus();
  });
  host.addEventListener('submit',event=>{
    const form=event.target.closest('.assistant-search-clue');if(!form)return;event.preventDefault();
    const run=runs.get(form.closest('[data-search-run-id]').dataset.searchRunId);
    const value=form.querySelector('input').value.trim(),action=form.querySelector('select').value;
    if(value&&value===form.dataset.originalValue&&action===form.dataset.originalAction){clueVisibility(form.closest('.assistant-message'),false);return;}
    if(value)refine(run,action,value);
  });
  host.addEventListener('keydown',event=>{
    if(event.isComposing||event.keyCode===229)return;
    const form=event.target.closest('.assistant-search-clue');
    if(form&&event.key==='Escape'){event.preventDefault();clueVisibility(form.closest('.assistant-message'),false);event.stopPropagation();return;}
    const detail=event.target.closest('.assistant-search-candidate')?.querySelector('[data-search-source-details][aria-expanded=true]');
    if(detail&&event.key==='Escape'){event.preventDefault();event.stopPropagation();detail.click();detail.focus({preventScroll:true});return;}
    const source=event.target.closest('[data-search-source-details]');
    if(!source||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const rows=[...source.closest('.assistant-search-source-list').querySelectorAll('[data-search-source-details]')].filter(button=>!button.disabled&&!button.hidden);
    const index=rows.indexOf(source),next=event.key==='Home'?0:event.key==='End'?rows.length-1:Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowDown'?1:-1)));
    event.preventDefault();event.stopPropagation();rows[next]?.focus({preventScroll:true});rows[next]?.scrollIntoView({block:'nearest',inline:'nearest'});
  });
  document.addEventListener('mailai:language-changed',()=>{
    const top=host.scrollTop,following=window.mailaiAssistantScroll?.isFollowing();
    const focused=document.activeElement,focusRun=focused?.closest('[data-search-run-id]')?.dataset.searchRunId;
    const focusAttribute=['data-search-source-details','data-search-loop-source','data-search-edit','data-search-loop-action','data-search-loop-clue','data-search-loop-more','data-search-loop-cancel'].find(name=>focused?.hasAttribute(name));
    const focusValue=focusAttribute?focused.getAttribute(focusAttribute):null;
    const focusField=focused?.closest('.assistant-search-clue')?focused.tagName.toLowerCase():null;
    const selection=focused?.matches('.assistant-search-clue input')?[focused.selectionStart,focused.selectionEnd,focused.selectionDirection]:null;
    for(const id of runs.keys()){
      const node=messages.get(id),form=node?.querySelector('.assistant-search-clue');
      const draft=form&&!form.hidden?{
        action:form.querySelector('select').value,value:form.querySelector('input').value,
        originalAction:form.dataset.originalAction,originalValue:form.dataset.originalValue,
        edit:form._returnFocus?.dataset.searchEdit,
      }:null;
      render(id);
      if(!draft)continue;
      const next=node.querySelector('.assistant-search-clue');if(!next)continue;
      const sender=draft.action==='set_sender';
      next.hidden=false;next.querySelector('select').value=draft.action;next.querySelector('input').value=draft.value;
      next.querySelector('.assistant-search-clue-label').textContent=t(sender?'sender':'topicWord');
      next.querySelector('input').placeholder=t(sender?'senderPlaceholder':'keywordPlaceholder');
      next.dataset.originalAction=draft.originalAction;next.dataset.originalValue=draft.originalValue;
      next._returnFocus=draft.edit?node.querySelector(`[data-search-edit="${draft.edit}"]`):node.querySelector('[data-search-loop-clue]');
      next._returnFocus?.setAttribute('aria-expanded','true');
    }
    const node=messages.get(focusRun);
    const target=focusAttribute?[...node?.querySelectorAll(`[${focusAttribute}]`)||[]].find(element=>element.getAttribute(focusAttribute)===focusValue):focusField?node?.querySelector('.assistant-search-clue '+focusField):null;
    target?.focus({preventScroll:true});if(selection&&target?.tagName==='INPUT')target.setSelectionRange(...selection);
    if(following)window.mailaiAssistantScroll?.follow();else if(window.mailaiAssistantScroll)window.mailaiAssistantScroll.restore(top);else host.scrollTop=top;
  });
  let scopeDialog=null;
  function chooseScope(query){
    if(scopeDialog?.open){scopeDialog.focus();return;}
    const previous=[document.activeElement,document.getElementById('search-ai-assist'),document.querySelector('[data-search-recover=assistant]')].find(node=>node?.tagName==='BUTTON'&&node.getClientRects().length)||document.activeElement;
    const dialog=document.createElement('dialog');scopeDialog=dialog;
    dialog.className='mailai-question assistant-search-scope';
    dialog.setAttribute('aria-labelledby','assistant-search-scope-title');
    const accounts=()=>_systemConfig?.accounts || [];
    const options=accounts().map(account=>`<option value="${esc(account.id)}">${esc(account.user)}${Number.isFinite(account.inbox)?' · '+esc(t('scopeInbox').replace('{0}',account.inbox)):''}</option>`).join('');
    dialog.innerHTML=`<form><h2 id="assistant-search-scope-title" data-i18n="searchLoop.scopeTitle">${esc(t('scopeTitle'))}</h2><p class="question-message" data-i18n="searchLoop.scopeHelp">${esc(t('scopeHelp'))}</p><label class="question-field"><span data-i18n="searchLoop.scopeAccount">${esc(t('scopeAccount'))}</span><select required aria-label="${esc(t('scopeAccount'))}"><option value="">${esc(t('scopePlaceholder'))}</option>${options}</select></label><p class="assistant-search-open-error" role="alert" hidden></p><footer><button type="button" data-search-scope-all data-confirm>${esc(t('scopeAll'))}</button><button type="submit" data-search-scope-submit>${esc(t('scopeContinue'))}</button><button type="button" data-search-scope-cancel>${esc(t('cancel'))}</button></footer></form>`;
    document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-search-scope-all]').focus();
    dialog.addEventListener('close',()=>{if(scopeDialog===dialog)scopeDialog=null;dialog.remove();if(previous?.isConnected&&!document.querySelector('dialog[open]'))previous.focus({preventScroll:true});},{once:true});
    dialog.querySelector('[data-search-scope-cancel]').onclick=()=>dialog.close();
    dialog.querySelector('[data-search-scope-all]').onclick=()=>{
      dialog.close();
      window.mailaiProductivity.openSearch({query,mailbox:'inbox'},true);
      document.getElementById('productivity-search-form')?.requestSubmit();
    };
    dialog.querySelector('form').onsubmit=async event=>{
      event.preventDefault();
      const id=dialog.querySelector('select').value;
      const error=dialog.querySelector('[role=alert]');
      if(!accounts().some(account=>account.id===id)){error.hidden=false;error.textContent=t('scopeMissing');return;}
      const controls=dialog.querySelectorAll('select,[data-search-scope-submit],[data-search-scope-all]');
      controls.forEach(control=>control.disabled=true);error.hidden=true;
      const revision=mailboxNavigationRevision+1;
      try{
        await openAccountMailbox(id,'inbox');
        // Cancel, failed activation and a newer navigation must not start a
        // request against an old account merely because its ID is still cached.
        if(!dialog.open||mailboxNavigationRevision!==revision||unifiedMailbox||activeMailAccount()?.id!==id)return;
        dialog.close();
        document.getElementById('global-search').value=query;
        runGlobalSearch();
        startSearchInAssistant();
      }catch(failure){if(dialog.open){error.hidden=false;error.textContent=mailaiSystemMessage(failure.message);}}
      finally{controls.forEach(control=>control.disabled=false);}
    };
  }

  window.mailaiAssistantSearch={chooseScope,reset,base,begin,idle,complete,restore,failed,clearReader,focusLatest};
})();
