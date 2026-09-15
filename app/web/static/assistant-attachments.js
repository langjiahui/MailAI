/* Explicit, account-bound attachment selection. Preview is local, Send invokes the model. */
(() => {
  const form=document.getElementById('assistant-form'),input=document.getElementById('assistant-input');
  form.insertAdjacentHTML('beforebegin','<section id="assistant-attachment-stage" hidden aria-label="本次附件"></section>');
  const stage=document.getElementById('assistant-attachment-stage');
  const dialog=document.createElement('dialog');dialog.id='assistant-attachment-picker';
  dialog.innerHTML=`<header><div><small>附件与正文一起分析</small><h3>选择邮件附件</h3></div><button type="button" data-attachment-close aria-label="关闭">×</button></header><p id="attachment-picker-source"></p><div class="attachment-picker-grid"><div id="attachment-picker-list"></div><section id="attachment-picker-preview" aria-live="polite">选择附件后在这里查看本地提取预览，不会调用模型。</section></div><p id="attachment-picker-status" role="status"></p><footer><small>每次最多 3 个，单个 10 MB。发送后，所选内容与正文会交给配置的模型；图片不能自动脱敏。</small><button type="button" id="attachment-picker-add" disabled>加入对话</button></footer>`;
  document.body.append(dialog);
  const list=document.getElementById('attachment-picker-list'),preview=document.getElementById('attachment-picker-preview'),status=document.getElementById('attachment-picker-status'),add=document.getElementById('attachment-picker-add');
  let pending=[],boundAccount='',revision=0,context=null;
  function render() {
    stage.hidden=!pending.length;
    stage.innerHTML=pending.map((r,i)=>`<div><span title="${esc(r.name)}">附件${i+1} · ${esc(r.name)}</span><button type="button" data-attachment-remove="${i}" aria-label="移除附件 ${i+1}">×</button></div>`).join('')+(pending.length?'<small>仅本次分析；自动带上来源邮件正文。可修改问题后发送。</small>':'');
    input.required=!pending.length&&!window.assistantImages?.snapshot().length;
  }
  function clear(){++revision;pending=[];boundAccount='';context=null;if(dialog.open)dialog.close();preview.replaceChildren();render();}
  stage.onclick=event=>{const b=event.target.closest('[data-attachment-remove]');if(b){pending.splice(Number(b.dataset.attachmentRemove),1);render();}};
  dialog.querySelector('[data-attachment-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{++revision;context=null;preview.replaceChildren();});
  function showPreview(item){
    preview.replaceChildren();const title=document.createElement('h4'),note=document.createElement('p');title.textContent=item.name;note.textContent=item.note;preview.append(title,note);
    if(item.image){const img=document.createElement('img');img.src=item.image.data_url;img.alt='图片附件预览';preview.append(img);}else{const pre=document.createElement('pre');pre.textContent=item.text;preview.append(pre);const info=document.createElement('small');info.textContent='预览最多显示 2200 字；实际提取范围见上方说明。';preview.append(info);}
  }
  async function open(emailId) {
    if(assistantController)return toast('请等待当前分析完成再选择附件','warn');
    const ticket=++revision,accountId=activeMailAccount()?.id;
    context={emailId,accountId,selected:new Map(),loading:false};
    list.textContent='正在读取附件列表…';preview.textContent='勾选后可预览提取内容，暂不发送至模型。';status.textContent='';add.disabled=true;dialog.showModal();
    try {
      const data=await api(`/api/emails/${emailId}/assistant-attachments`,{accountId});
      if(ticket!==revision||accountId!==activeMailAccount()?.id)return;
      context.subject=data.subject;
      document.getElementById('attachment-picker-source').textContent=activeMailAccount()?.user+' · '+data.subject;
      list.innerHTML=data.items.map(item=>`<label class="attachment-picker-item"><input type="checkbox" value="${item.index}" ${item.supported?'':'disabled'}><span><b>${esc(item.name)}</b><small>${esc(item.supported?formatFileSize(item.size):item.reason)}</small></span></label>`).join('')||'<p>这封邮件没有可用附件。</p>';
    }catch(e){if(ticket===revision)status.textContent=e.message;}
  }
  list.onchange=async event=>{
    const checkbox=event.target,c=context,ticket=revision;if(!c||checkbox.type!=='checkbox')return;
    const index=Number(checkbox.value);
    if(!checkbox.checked){c.selected.delete(index);add.disabled=!c.selected.size;return;}
    if(c.selected.size>=3){checkbox.checked=false;status.textContent='每次最多选择 3 个附件';return;}
    if(c.loading){checkbox.checked=false;return;}
    c.loading=true;add.disabled=true;status.textContent='正在本地提取内容…';list.querySelectorAll('input:not(:disabled)').forEach(n=>{n.dataset.temporarilyDisabled='true';n.disabled=true;});
    try {
      const item=await api(`/api/emails/${c.emailId}/assistant-attachments/${index}`,{accountId:c.accountId});
      if(ticket!==revision||c.accountId!==activeMailAccount()?.id)return;
      c.selected.set(index,item);showPreview(item);status.textContent=`已选 ${c.selected.size} 个；点击“加入对话”后仍需确认发送。`;
    }catch(e){if(ticket===revision){checkbox.checked=false;status.textContent=e.message;}}
    finally{if(ticket===revision){c.loading=false;list.querySelectorAll('[data-temporarily-disabled]').forEach(n=>{n.disabled=false;delete n.dataset.temporarilyDisabled;});add.disabled=!c.selected.size;}}
  };
  add.onclick=async()=>{
    const c=context;if(!c||!c.selected.size||c.loading||c.accountId!==activeMailAccount()?.id)return;
    const refs=[...c.selected.values()].map(({email_id,index,digest,name})=>({email_id,index,digest,name}));
    dialog.close();
    if(!assistantHistoryLoaded)await restoreLatestAssistantConversation();
    if(c.accountId!==activeMailAccount()?.id)return;
    openAssistant();window.showSecretaryChat?.();pending=refs;boundAccount=c.accountId;render();
    assistantPinnedScope=[c.emailId];document.getElementById('assistant-scope').value='selected';updateAssistantScopeControl();
    input.value='请总结所选附件，并核对与邮件正文不一致的地方。';window.resizeAssistantInput?.();input.focus();
  };
  function install(){
    const attachments=document.querySelector('#reading-content .attachments');if(!attachments||!selectedEmailDetail)return;
    const section=attachments.closest('.reading-section'),header=section?.querySelector('.section-title');
    if(!header||header.querySelector('[data-assistant-attachments]'))return;
    const b=document.createElement('button');b.type='button';b.dataset.assistantAttachments='true';b.className='attachment-analyze-button';b.textContent='让小邮分析';const id=selectedEmailDetail.id;
    b.onclick=()=>open(id);header.append(b);
  }
  new MutationObserver(install).observe(document.getElementById('reading-content'),{childList:true,subtree:true});install();
  window.assistantAttachments={clear,snapshot:()=>boundAccount===activeMailAccount()?.id?pending.map(r=>({...r})):[]};
})();
