/* One mail conversation includes its body and attachments; cataloging is local. */
(() => {
  const row=document.querySelector('.assistant-context-row'),stage=document.createElement('section');
  stage.id='assistant-mail-context';stage.hidden=true;row.append(stage);
  const t=key=>mailaiT(`mailContext.${key}`)||MAILAI_UI_COPY[`mailContext.${key}`][0];
  let context=null,account='',conversation=null,ticket=0,fileMode=false;
  const active=()=>context&&account===activeMailAccount()?.id;
  function snapshot(){return active()?{email_id:context.email_id,excluded:[...(context.excluded||[])]}:null;}
  function close(focus=false){const trigger=stage.querySelector('[data-mail-materials]'),popup=stage.querySelector('.assistant-mail-materials');if(popup)popup.hidden=true;trigger?.setAttribute('aria-expanded','false');if(focus)trigger?.focus();}
  function render(){
    stage.hidden=!active();if(stage.hidden){stage.replaceChildren();return;}
    const items=context.items||[],excluded=new Set(context.excluded||[]),included=items.filter(r=>!excluded.has(r.index));
    const label=(excluded.size?t('selected'):t('contents')).replace('{count}',included.length).replace('{total}',items.length);
    const different=selectedEmailDetail&&selectedEmailDetail.id!==context.email_id&&(!selectedEmailAccountId||selectedEmailAccountId===account);
    const wasOpen=stage.querySelector('[aria-expanded="true"]');
    stage.innerHTML=`<button type="button" data-mail-materials aria-expanded="false" aria-controls="assistant-mail-materials" title="${esc(t('manage'))}"><span>${esc(context.unavailable?t('sourceGone'):context.loading?t('loading'):label)}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>${different?`<button type="button" data-mail-switch title="${esc(t('switch'))}" aria-label="${esc(t('switch'))}">↪</button>`:''}<div id="assistant-mail-materials" class="assistant-mail-materials" hidden><b>${esc(context.subject||t('thisMail'))}</b><small>${esc(context.unavailable?t('sourceGone'):context.body_partial?t('bodyPartial').replace('{count}',context.body_limit):t('body'))}</small>${context.error?`<p role="status">${esc(t('catalogError'))}</p>`:''}${items.map(item=>`<label class="assistant-mail-material"><input type="checkbox" data-mail-include="${item.index}" ${excluded.has(item.index)?'':'checked'} ${assistantController?'disabled':''}><span><b>${esc(item.name)}</b><small data-mail-status="${excluded.has(item.index)?'excluded':item.status||'pending'}">${esc(excluded.has(item.index)?t('excluded'):t(item.status||'pending'))}</small>${item.detail?`<small>${esc(mailaiSystemMessage(item.detail))}</small>`:''}</span></label>`).join('')}<p>${esc(t('notice'))}</p>${different?`<button type="button" data-mail-switch>${esc(t('switch'))}</button>`:''}</div>`;
    if(wasOpen)toggle();
  }
  function toggle(){
    const popup=stage.querySelector('.assistant-mail-materials'),trigger=stage.querySelector('[data-mail-materials]');if(!popup)return;
    if(!popup.hidden){close();return;}
    const panel=document.getElementById('assistant-panel'),zoom=trigger.getBoundingClientRect().height/trigger.offsetHeight||1;
    popup.style.width=Math.min(340,panel.clientWidth-28)+'px';
    popup.style.maxHeight=Math.max(70,Math.min(300,(trigger.getBoundingClientRect().top-panel.getBoundingClientRect().top)/zoom-12))+'px';
    popup.hidden=false;trigger.setAttribute('aria-expanded','true');trigger.focus({preventScroll:true});
  }
  function clear(){++ticket;context=null;account='';conversation=null;fileMode=false;render();}
  function restore(value,id=assistantConversationId){++ticket;context={...value,items:(value.items||[]).map(r=>({...r}))};account=activeMailAccount()?.id||'';conversation=id;fileMode=false;window.assistantAttachments?.clear();render();}
  function bind(mail){
    if(active()&&context.email_id===Number(mail.id)){render();return;}
    const owner=activeMailAccount()?.id||'',revision=++ticket;
    context={email_id:Number(mail.id),subject:mail.subject||'',excluded:[],items:(mail.attachments||[]).map((a,index)=>({...a,index,status:'pending'})),loading:true};account=owner;conversation=null;fileMode=false;window.assistantAttachments?.clear();render();
    api(`/api/emails/${mail.id}/assistant-context`,{accountId:owner}).then(value=>{
      if(ticket!==revision||owner!==activeMailAccount()?.id)return;
      // Keep choices made while the metadata request was in flight.
      context={...value,excluded:context.excluded||[]};render();
    }).catch(()=>{if(ticket===revision){context.loading=false;context.error=true;render();}});
  }
  function request(ids,attachments,skip=false){
    if(attachments.length){clear();fileMode=true;return null;}
    if(skip||!ids||ids.length!==1){clear();return null;}
    if(fileMode)return null;
    if(!active()||context.email_id!==Number(ids[0]))bind(selectedEmailDetail?.id===Number(ids[0])?selectedEmailDetail:{id:Number(ids[0]),subject:allEmails.find(r=>r.id===Number(ids[0]))?.subject||''});
    ++ticket;context.loading=false;
    context.items=(context.items||[]).map(item=>({...item,status:'pending',detail:''}));render();
    return snapshot();
  }
  async function persist(){
    if(!conversation||!active())return;
    try{await api(`/api/assistant/conversations/${conversation}/mail-context`,{accountId:account,method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot())});}
    catch(e){toast(mailaiSystemMessage(e.message),'warn');}
  }
  stage.addEventListener('click',event=>{
    if(event.target.closest('[data-mail-materials]')){toggle();return;}
    if(event.target.closest('[data-mail-switch]')&&selectedEmailDetail){openAssistantForEmail(selectedEmailDetail);return;}
  });
  stage.addEventListener('change',event=>{const input=event.target.closest('[data-mail-include]');if(!input||assistantController)return;const index=Number(input.dataset.mailInclude);context.excluded=(context.excluded||[]).filter(n=>n!==index);if(!input.checked)context.excluded.push(index);const items=context.items||[],included=items.filter(r=>!context.excluded.includes(r.index));stage.querySelector('[data-mail-materials]>span').textContent=(context.excluded.length?t('selected'):t('contents')).replace('{count}',included.length).replace('{total}',items.length);persist();});
  stage.addEventListener('keydown',event=>{if(event.key==='Escape'&&stage.querySelector('[aria-expanded="true"]')){event.preventDefault();event.stopPropagation();close(true);}});
  document.addEventListener('click',event=>{if(!stage.contains(event.target))close();});
  document.addEventListener('mailai:language-changed',render);window.addEventListener('resize',()=>close());
  new MutationObserver(()=>{if(active())render();}).observe(document.getElementById('reading-content'),{childList:true});
  window.assistantMail={bind,clear,restore,request,snapshot,refresh:render,
    id:()=>active()?context.email_id:null,subject:id=>active()&&context.email_id===Number(id)?context.subject:'',
    filesOnly:()=>{clear();fileMode=true;},include:()=>!fileMode,
    conversation:id=>{conversation=id;},coverage:items=>{if(active()){context.items=(context.items||[]).map(item=>({...item,...items.find(r=>r.index===item.index)}));render();}}};
})();
