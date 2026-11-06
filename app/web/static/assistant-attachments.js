/* Explicit account-bound file context. Only Send/Start analysis invokes the model. */
(() => {
  const t=key=>mailaiT(`files.${key}`)||MAILAI_UI_COPY[`files.${key}`][0], form=document.getElementById('assistant-form'),input=document.getElementById('assistant-input');
  document.querySelector('.assistant-context-row').insertAdjacentHTML('beforeend','<section id="assistant-attachment-stage" hidden></section>');
  const stage=document.getElementById('assistant-attachment-stage');
  const dialog=document.createElement('dialog');dialog.id='assistant-attachment-picker';
  dialog.innerHTML=`<header><div><small data-i18n="files.subtitle"></small><h3 data-i18n="files.title"></h3></div><button type="button" data-attachment-close data-i18n-aria="files.close">×</button></header><p id="attachment-picker-source"></p><div class="attachment-picker-grid"><div id="attachment-picker-list"></div><section id="attachment-picker-preview" aria-live="polite"></section></div><div class="attachment-question"><label for="attachment-picker-question" data-i18n="files.prompt"></label><textarea id="attachment-picker-question" rows="2" maxlength="12000"></textarea><div class="file-question-prompts"><button type="button" data-file-prompt="defaultQuestion" data-i18n="files.summary"></button><button type="button" data-file-prompt="tableQuestion" data-i18n="files.table"></button><button type="button" data-file-prompt="compareQuestion" data-i18n="files.compare"></button></div></div><p id="attachment-picker-status" role="status"></p><footer><small><span data-i18n="files.sendNotice"></span><br><span data-i18n="files.limit"></span></small><button type="button" id="attachment-picker-add" disabled data-i18n="files.start"></button></footer>`;
  document.body.append(dialog);
  const list=document.getElementById('attachment-picker-list'),preview=document.getElementById('attachment-picker-preview'),status=document.getElementById('attachment-picker-status'),add=document.getElementById('attachment-picker-add'),question=document.getElementById('attachment-picker-question');
  let pending=[],boundAccount='',boundConversation=null,revision=0,context=null;
  const key=r=>`${r.email_id}:${r.index}`;
  const refs=rows=>rows.map(({email_id,index,digest})=>({email_id,index,digest}));
  function reading(r){
    const model=_systemConfig?.model||{},ext=(r.name||'').split('.').pop().toLowerCase();
    const mode=ext==='pdf'?(model.document_input_mode==='native_pdf'?'native_pdf':model.document_input_mode!=='text'&&model.multimodal_enabled?'pages':'text'):r.reading||'text';
    const target=['pages','image','native_pdf'].includes(mode)?(model.multimodal_model||model.model):model.model;
    return `${t(mode)}${r.page_count?' · '+t('pagesCount').replace('{count}',r.page_count):''}${target?' · '+target:''}`;
  }
  function render(){
    stage.hidden=!pending.length;stage.setAttribute('aria-label',t('session'));
    const label=pending.length===1?pending[0].name:t('count').replace('{count}',pending.length);
    const names=pending.map(r=>r.name).join(' · ');
    stage.innerHTML=pending.length?`<button type="button" class="assistant-file-chip" data-file-context-toggle aria-expanded="false" aria-controls="assistant-file-popover" title="${esc(names)}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 10 5-5a3 3 0 0 1 4 4l-7 7a4 4 0 0 1-6-6l7-7m-4 9 6-6"/></svg><span>${esc(label)}</span><svg class="file-chip-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><button type="button" class="assistant-file-add" data-file-add aria-label="${esc(t('add'))}" title="${esc(t('add'))}">+</button><div id="assistant-file-popover" class="assistant-file-popover" hidden><b class="assistant-file-popover-title">${t('session')}</b>`+pending.map((r,i)=>`<div class="assistant-file-card ${r.unavailable?'unavailable':''}">${attachmentFileIcon(r)}<span><b title="${esc(r.name)}">${esc(r.name)}</b><small>${esc(r.unavailable?t('unavailable'):reading(r))}</small></span>${attachmentPreviewAction(mailboxResourceUrl(`/api/emails/${r.email_id}/attachments/${r.index}`),r.name)}<button type="button" data-attachment-remove="${i}" aria-label="${esc(t('remove'))}">×</button></div>`).join('')+`<small class="assistant-file-hint">${t('continue')}</small></div>`:'';
    input.required=!pending.length&&!window.assistantImages?.snapshot().length;
    window.mailaiAssistantScroll?.changed();
  }
  function closeFiles(focus=false){
    const trigger=stage.querySelector('[data-file-context-toggle]'),popup=stage.querySelector('.assistant-file-popover');
    if(popup)popup.hidden=true;
    trigger?.setAttribute('aria-expanded','false');
    if(focus)trigger?.focus();
  }
  function toggleFiles(){
    const trigger=stage.querySelector('[data-file-context-toggle]'),popup=stage.querySelector('.assistant-file-popover');
    if(!popup)return;
    if(!popup.hidden){closeFiles();return;}
    const panel=stage.closest('#assistant-panel');
    const zoom=trigger.getBoundingClientRect().height/trigger.offsetHeight||1;
    popup.style.width=Math.min(320,panel.clientWidth-32)+'px';
    popup.style.maxHeight=Math.min(280,Math.max(80,(trigger.getBoundingClientRect().top-panel.getBoundingClientRect().top)/zoom-12))+'px';
    popup.hidden=false;trigger.setAttribute('aria-expanded','true');trigger.focus({preventScroll:true});
  }

  function retain(rows,conversation=assistantConversationId){pending=rows.map(r=>({...r}));boundAccount=activeMailAccount()?.id||'';boundConversation=conversation;render();}
  function clear(){++revision;pending=[];boundAccount='';boundConversation=null;context=null;if(dialog.open)dialog.close();preview.replaceChildren();render();}
  async function persist(){
    const accountId=boundAccount,id=boundConversation,items=refs(pending);
    if(!id)return;
    try{await api(`/api/assistant/conversations/${id}/attachments`,{accountId,method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({attachments:items})});}
    catch(e){if(accountId===activeMailAccount()?.id)toast(mailaiSystemMessage(e.message),'warn');}
  }
  stage.onclick=event=>{
    if(event.target.closest('[data-file-context-toggle]')){toggleFiles();return;}
    if(event.target.closest('.attachment-preview-action'))return;
    if(assistantController)return toast(t('wait'),'warn');
    const remove=event.target.closest('[data-attachment-remove]');
    if(remove){pending.splice(Number(remove.dataset.attachmentRemove),1);render();persist();}
    if(event.target.closest('[data-file-add]'))selectedEmailDetail?open(selectedEmailDetail.id):toast(t('noMail'),'warn');
  };
  document.addEventListener('click',event=>{if(!stage.contains(event.target))closeFiles();});
  stage.addEventListener('keydown',event=>{if(event.key==='Escape'&&stage.querySelector('[aria-expanded="true"]')){event.preventDefault();event.stopPropagation();closeFiles(true);}});
  window.addEventListener('resize',()=>closeFiles());
  dialog.querySelector('[data-attachment-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{++revision;context=null;preview.replaceChildren();});
  dialog.querySelectorAll('[data-file-prompt]').forEach(b=>b.onclick=()=>{question.value=t(b.dataset.filePrompt);question.focus();});
  async function join(rows,text,send=false){
    const accountId=activeMailAccount()?.id;
    if(rows.length>3)return toast(t('limitError'),'warn');
    if(!assistantHistoryLoaded)await restoreLatestAssistantConversation();
    if(accountId!==activeMailAccount()?.id)return;
    openAssistant();window.showSecretaryChat?.();window.assistantMail?.filesOnly();retain(rows);
    assistantPinnedScope=[...new Set(rows.map(r=>r.email_id))];document.getElementById('assistant-scope').value='selected';updateAssistantScopeControl();
    input.value=text||input.value||t('defaultQuestion');window.resizeAssistantInput?.();input.focus();
    if(send){askAssistant(input.value,null,[],rows);if(assistantController){input.value='';window.resizeAssistantInput?.();}}
  }
  async function direct(emailId,index){
    if(assistantController)return toast(t('wait'),'warn');
    const accountId=activeMailAccount()?.id,ticket=++revision;
    try{
      const item=await api(`/api/emails/${emailId}/assistant-attachments/${index}/reference`,{accountId});
      if(ticket!==revision||accountId!==activeMailAccount()?.id)return;
      const rows=pending.filter(r=>key(r)!==key(item));rows.push(item);await join(rows,'');
    }catch(e){if(ticket===revision)toast(mailaiSystemMessage(e.message),'warn');}
  }
  function showPreview(item){
    preview.replaceChildren();const head=document.createElement('div');head.className='attachment-reading-card';
    head.innerHTML=`${attachmentFileIcon(item)}<div><h4>${esc(item.name)}</h4><p>${esc(reading(item))}</p></div>`;preview.append(head);
    const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('pre');summary.textContent=t('details');details.append(summary,body);preview.append(details);
    let loaded=false;
    details.ontoggle=async()=>{if(!details.open||loaded)return;loaded=true;body.textContent=t('preparing');
      try{const result=await api(`/api/emails/${item.email_id}/assistant-attachments/${item.index}`,{accountId:context?.accountId||boundAccount});body.textContent=`${result.note}\n\n${result.text||t('image')}`;}
      catch(e){body.textContent=mailaiSystemMessage(e.message);}};
  }
  async function open(emailId){
    if(assistantController)return toast(t('wait'),'warn');
    const ticket=++revision,accountId=activeMailAccount()?.id;
    context={emailId,accountId,selected:new Map(),loading:false};
    list.textContent=t('preparing');preview.textContent=t('preview');status.textContent='';question.value=input.value||t('defaultQuestion');add.disabled=true;dialog.showModal();
    try{
      const data=await api(`/api/emails/${emailId}/assistant-attachments`,{accountId});
      if(ticket!==revision||accountId!==activeMailAccount()?.id)return;
      document.getElementById('attachment-picker-source').textContent=`${activeMailAccount()?.user||''} · ${data.subject}`;
      list.innerHTML=data.items.map(item=>`<label class="attachment-picker-item"><input type="checkbox" value="${item.index}" ${item.supported?'':'disabled'}>${attachmentFileIcon(item)}<span><b>${esc(item.name)}</b><small>${esc(item.supported?formatFileSize(item.size):item.reason)}</small></span></label>`).join('')||`<p>${t('empty')}</p>`;
    }catch(e){if(ticket===revision)status.textContent=mailaiSystemMessage(e.message);}
  }
  list.onchange=async event=>{
    const box=event.target,c=context,ticket=revision;if(!c||box.type!=='checkbox')return;
    const index=Number(box.value);
    if(!box.checked){c.selected.delete(index);add.disabled=!c.selected.size;return;}
    if(c.selected.size>=3){box.checked=false;status.textContent=t('limitError');return;}
    if(c.loading){box.checked=false;return;}
    c.loading=true;add.disabled=true;status.textContent=t('preparing');
    list.querySelectorAll('input:not(:disabled)').forEach(n=>{n.dataset.temporarilyDisabled='true';n.disabled=true;});
    try{
      const item=await api(`/api/emails/${c.emailId}/assistant-attachments/${index}/reference`,{accountId:c.accountId});
      if(ticket!==revision||c.accountId!==activeMailAccount()?.id)return;
      c.selected.set(index,item);showPreview(item);status.textContent=t('selected').replace('{count}',c.selected.size);
    }catch(e){if(ticket===revision){box.checked=false;status.textContent=mailaiSystemMessage(e.message);}}
    finally{if(ticket===revision){c.loading=false;list.querySelectorAll('[data-temporarily-disabled]').forEach(n=>{n.disabled=false;delete n.dataset.temporarilyDisabled;});add.disabled=!c.selected.size;}}
  };
  add.onclick=async()=>{
    const c=context;if(!c||!c.selected.size||c.loading||c.accountId!==activeMailAccount()?.id)return;
    const rows=[...pending.filter(r=>r.email_id!==c.emailId),...c.selected.values()],text=question.value;
    if(rows.length>3){status.textContent=t('limitError');return;}
    dialog.close();await join(rows,text,true);
  };
  document.addEventListener('mailai:language-changed',render);
  document.addEventListener('click',event=>{const button=event.target.closest('[data-assistant-file]');if(!button)return;closeAttachmentCenter();direct(Number(button.dataset.emailId),Number(button.dataset.attachmentIndex));});
  window.assistantAttachments={clear,retain,open,direct,restore:retain,refresh:render,conversation:id=>{boundConversation=id;},snapshot:()=>boundAccount===activeMailAccount()?.id?pending.map(r=>({...r})):[]};
})();
