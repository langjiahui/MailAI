/* Visibility is local to the form and resets whenever its context changes. */
(() => {
  const field = document.getElementById('model-api-key');
  const toggle = document.getElementById('model-key-visibility');
  if (!field || !toggle) return;
  function render() {
    const visible = field.type === 'text';
    toggle.setAttribute('aria-pressed', String(visible));
    mailaiBindUI(toggle, "@aria-label", () => (mailaiT(visible ? 'model.keyHideLabel' : 'model.keyShowLabel') || (visible ? '隐藏 API Key' : '显示 API Key')));
    mailaiBindUI(toggle.querySelector('span'), "textContent", () => (mailaiT(visible ? 'model.keyHide' : 'model.keyShow') || (visible ? '隐藏' : '显示')));
  }
  const conceal = () => { field.type = 'password'; render(); };
  toggle.addEventListener('click', () => { field.type = field.type === 'password' ? 'text' : 'password'; render(); });
  document.getElementById('model-provider').addEventListener('change', conceal, true);
  document.getElementById('model-config-form').addEventListener('submit', conceal, true);
  document.getElementById('btn-test-model').addEventListener('click', conceal, true);
  document.getElementById('btn-save-model-only').addEventListener('click', conceal, true);
  document.addEventListener('click', event => {
    if (event.target.closest('[data-system-tab], #btn-close-system, #start-model-later, #start-enable, [data-help-settings]')) conceal();
  }, true);
  const panel = document.querySelector('[data-system-panel="ai"]');
  if (panel) new MutationObserver(() => { if (panel.classList.contains('hidden')) conceal(); }).observe(panel, {attributes:true, attributeFilter:['class']});
  document.addEventListener('mailai:language-changed', render);
  render();
})();

/* Validate and activate one immutable draft; optional diagnostic actions stay separate. */
(() => {
  const form=document.getElementById('model-config-form'),primary=document.getElementById('btn-save-model');
  const feedback=document.getElementById('model-action-feedback'),status=document.getElementById('model-status');
  const more=document.getElementById('model-more-actions');
  const copy=key=>mailaiT(`model.${key}`)||MAILAI_UI_COPY[`model.${key}`][0];
  let busy=false,dirty=false,allowReload=false;
  function message(key,phase='idle',detail=''){
    feedback.dataset.state=phase;
    feedback.setAttribute('role',phase==='error'?'alert':'status');
    mailaiBindUI(feedback,'textContent',()=>copy(key)+(detail?' '+mailaiSystemMessage(detail):''));
  }
  function badge(key,phase=''){
    status.className=`connection-status ${phase}`;
    mailaiBindUI(status,'textContent',()=>copy(key));
  }
  function changed(){
    if(busy)return;
    dirty=true;message('unsaved');badge('draftStatus');
  }
  form.addEventListener('input',changed);
  form.addEventListener('change',changed);
  window.mailaiModelForm={
    retainDraft:()=>!form.closest('#start-model')&&!allowReload&&(dirty||busy),
    loaded:()=>{dirty=false;message('actionHint');},
  };
  async function run(mode){
    if(busy||!form.reportValidity())return;
    more.open=false;
    let payload;
    try{payload=modelFormPayload();}catch(error){message('invalidDraft','error',error.message);feedback.focus();return;}
    const serialized=JSON.stringify(payload);
    const controls=[...form.elements].map(node=>[node,node.disabled]);
    busy=true;form.setAttribute('aria-busy','true');more.inert=true;
    controls.forEach(([node])=>{node.disabled=true;});
    let saving=mode==='save';
    try{
      if(mode!=='save'){
        message('checking','loading');badge('checking');
        mailaiBindUI(primary.querySelector('span'),'textContent',()=>copy('checking'));
        const result=await api('/api/system/model/test',{method:'POST',headers:{'Content-Type':'application/json'},body:serialized});
        if(!result.ok)throw new Error(result.message||copy('checkFailed'));
        if(result.multimodal?.checked&&!result.multimodal.supported)throw new Error(result.multimodal.message||copy('visionFailed'));
        if(JSON.stringify(modelFormPayload())!==serialized){dirty=true;message('changedDuringCheck','error');badge('draftStatus');return;}
        if(mode==='test'){message('testPassed','success');badge('testPassedStatus','connected');return;}
      }
      saving=true;message('saving','loading');badge('saving');
      mailaiBindUI(primary.querySelector('span'),'textContent',()=>copy('saving'));
      const saved=await api('/api/system/model',{method:'POST',headers:{'Content-Type':'application/json'},body:serialized});
      allowReload=true;
      await loadSystemConfig(saved.config||null);
      message(mode==='save'?'savedOnly':'savedEnabled','success');
    }catch(error){
      message(saving?'saveFailed':'checkFailed','error',error.message);
      badge(saving?'saveFailed':'checkFailed','failed');
      feedback.focus({preventScroll:true});feedback.scrollIntoView({block:'nearest'});
    }finally{
      allowReload=false;busy=false;more.inert=false;form.removeAttribute('aria-busy');
      controls.forEach(([node,disabled])=>{node.disabled=disabled;});
      mailaiBindUI(primary.querySelector('span'),'textContent',()=>copy('validateSave'));
    }
  }
  form.addEventListener('submit',event=>{event.preventDefault();run('validate-save');});
  document.getElementById('btn-test-model').addEventListener('click',()=>run('test'));
  document.getElementById('btn-save-model-only').addEventListener('click',()=>run('save'));
  more.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();more.open=false;more.querySelector('summary').focus();}});
  document.addEventListener('click',event=>{if(!more.contains(event.target))more.open=false;});
})();
