/* Send saves validated pictures to local, account-isolated history. Preview never calls the model. */
(() => {
  const form=document.getElementById('assistant-form'), input=document.getElementById('assistant-input');
  form.insertAdjacentHTML('beforebegin', `<section id="assistant-image-stage" hidden aria-label="本次图片" data-i18n-aria="ui.10f091096cc3"><div id="assistant-image-previews"></div><div class="assistant-image-prompts"><button type="button" data-image-prompt="请提炼图片重点，区分事实、待确认信息和建议下一步。"><span data-i18n="ui.f681df1242b3">提炼重点</span></button><button type="button" data-image-prompt="请读取图片中可辨识的表格，整理为清晰的文字表格；看不清的数字请标明。"><span data-i18n="ui.7451a9f6a4b5">整理表格</span></button><button type="button" data-image-compare><span data-i18n="ui.4623ef64cf8a">对照当前邮件</span></button></div><small><span data-i18n="ui.0db907983cb1">发送后图片保存在本机会话中，并交给已配置的模型分析。请先遮挡敏感信息。</span></small></section>`);
  form.insertAdjacentHTML('afterbegin', `<button type="button" id="assistant-add-image" aria-label="添加图片" title="添加图片，也可粘贴或拖入截图" data-i18n-title="ui.a16b7029b344" data-i18n-aria="ui.9f0d4e4656ee"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg></button><input type="file" id="assistant-image-file" accept="image/png,image/jpeg,image/webp" multiple hidden>`);
  const stage=document.getElementById('assistant-image-stage'), previews=document.getElementById('assistant-image-previews'), picker=document.getElementById('assistant-image-file');
  let items=[], generation=0, busy=false;
  const zoom=document.createElement('dialog');zoom.id='assistant-image-zoom';
  zoom.innerHTML="<button type=\"button\" aria-label=\"关闭图片预览\" data-i18n-aria=\"ui.b097f500ba2b\"><span data-i18n=\"ui.3fd47edce45b\">关闭</span></button><button type=\"button\" id=\"assistant-image-size\"><span data-i18n=\"ui.61f9618db877\">查看原尺寸</span></button><p role=\"status\" hidden><span data-i18n=\"ui.3afb7f2c7c1e\">图片无法加载，可能已被清理，请重新添加。</span></p><div class=\"assistant-image-viewport\"><img alt=\"图片预览\" data-i18n-alt=\"ui.ba8b49f3fd10\"></div>";document.body.append(zoom);
  zoom.querySelector('button').onclick=()=>zoom.close();
  zoom.addEventListener('close',()=>{zoom.querySelector('img').removeAttribute('src');zoom.classList.remove('original-size');});
  zoom.querySelector('img').onerror=()=>{if(zoom.open)zoom.querySelector('p').hidden=false;};
  document.getElementById('assistant-image-size').onclick=()=>{const original=zoom.classList.toggle('original-size');mailaiBindUI(document.getElementById('assistant-image-size'), "textContent", () => (original?mailaiText('适应窗口'):mailaiText('查看原尺寸')));};
  function preview(img) {
    img.tabIndex=0;img.setAttribute('role','button');mailaiBindUI(img, "title", () => (mailaiText('查看大图')));
    const open=()=>{zoom.classList.remove('original-size');zoom.querySelector('p').hidden=true;mailaiBindUI(document.getElementById('assistant-image-size'), "textContent", () => (mailaiText('查看原尺寸')));zoom.querySelector('img').src=img.dataset.fullSrc||img.src;zoom.showModal();};
    img.onclick=open;img.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}};
  }
  function render() {
    stage.hidden=!items.length;
    input.required=!items.length&&!window.assistantAttachments?.snapshot().length;
    previews.replaceChildren();
    items.forEach((item,index)=>{
      const figure=document.createElement('figure'), img=document.createElement('img'), caption=document.createElement('figcaption'), remove=document.createElement('button');
      img.src=item.data_url;mailaiBindUI(img, "alt", () => (mailaiTemplate`图片 ${index+1} 预览`));preview(img);
      mailaiBindUI(caption, "textContent", () => (mailaiTemplate`图片 ${index+1}`));caption.title=item.name;
      remove.type='button';remove.textContent='×';mailaiBindUI(remove, "@aria-label", () => (mailaiTemplate`移除图片 ${index+1}`));
      remove.onclick=()=>{items.splice(index,1);render();};figure.append(img,caption,remove);previews.append(figure);
    });
  }
  function clear() {++generation;items=[];busy=false;picker.value='';if(zoom.open)zoom.close();render();}
  function fileData(file) {return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error(mailaiText('无法读取图片')));reader.readAsDataURL(file);});}
  function imageSize(dataUrl) {return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(new Error(mailaiText('图片无法读取或文件已损坏')));image.src=dataUrl;});}
  async function add(files) {
    if(assistantController || busy)return toast(mailaiText('请等待当前处理完成，再添加图片'),'warn');
    const list=Array.from(files);if(!list.length)return;
    if(items.length+list.length>3)return toast(mailaiText('每次最多添加 3 张图片'),'warn');
    const ticket=generation;busy=true;
    try {
      const added=[];let longScreenshots=0,totalPixels=items.reduce((sum,item)=>sum+(item.width||0)*(item.height||0),0);
      for(const file of list) {
        if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error(mailaiText('仅支持 PNG、JPEG、WebP 图片'));
        if(file.size>5*1024*1024)throw new Error(mailaiText('每张图片不得超过 5 MB，请先裁剪或压缩'));
        // Read the original bytes; backend validates pixels, normalizes orientation and removes metadata.
        const data_url=await fileData(file),size=await imageSize(data_url),pixels=size.width*size.height;totalPixels+=pixels;
        if(size.width>32768||size.height>32768||pixels>64000000)throw new Error(mailaiText('图片尺寸超出安全处理范围，请裁剪长截图或分成两张后上传'));
        if(totalPixels>80000000)throw new Error(mailaiText('本次图片总尺寸过大，请减少图片数量或分批分析'));
        if(pixels>20000000)longScreenshots+=1;
        added.push({data_url,name:file.name,width:size.width,height:size.height});
      }
      if(ticket!==generation)return;
      if([...items,...added].reduce((n,i)=>n+i.data_url.length*0.75,0)>12*1024*1024)throw new Error(mailaiText('图片合计不能超过 12 MB'));
      items.push(...added);render();if(longScreenshots)toast(mailaiTemplate`${longScreenshots} 张长截图将在发送时自动优化尺寸`,'success');input.focus();
    }catch(e){if(ticket===generation)toast(mailaiSystemMessage(e.message),'warn');}finally{if(ticket===generation)busy=false;picker.value='';}
  }
  document.getElementById('assistant-add-image').onclick=()=>picker.click();
  picker.onchange=()=>add(picker.files);
  input.addEventListener('paste',event=>{const files=Array.from(event.clipboardData?.items||[]).filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();add(files);}});
  const panel=document.getElementById('assistant-panel');
  panel.addEventListener('dragover',event=>{if(Array.from(event.dataTransfer?.types||[]).includes('Files')){event.preventDefault();form.classList.add('image-drop-active');}});
  panel.addEventListener('dragleave',event=>{if(!panel.contains(event.relatedTarget))form.classList.remove('image-drop-active');});
  panel.addEventListener('drop',event=>{if(event.dataTransfer?.files.length){event.preventDefault();form.classList.remove('image-drop-active');window.showSecretaryChat?.();add(event.dataTransfer.files);}});
  stage.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.hasAttribute('data-image-compare')){if(!selectedEmailId)return toast(mailaiText('请先打开要对照的邮件'),'warn');assistantPinnedScope=null;document.getElementById('assistant-scope').value='selected';updateAssistantScopeControl();input.value=mailaiText('请对比本次图片与所选邮件，列出一致、不同和无法确认的地方，分别引用图片与邮件来源。');}else if(button.dataset.imagePrompt){input.value=button.dataset.imagePrompt;}window.resizeAssistantInput?.();input.focus();});
  window.assistantImages={clear,snapshot:()=>items.map(({data_url})=>({data_url})),busy:()=>busy,
    showSent:(element,images)=>{const wrap=document.createElement('div');wrap.className='assistant-sent-images';const accountId=activeMailAccount()?.id||'';images.forEach((item,index)=>{const img=document.createElement('img');img.loading='lazy';img.decoding='async';img.src=item.data_url||mailboxResourceUrl(item.thumbnail_url,accountId);img.dataset.fullSrc=item.data_url||mailboxResourceUrl(item.url,accountId);mailaiBindUI(img, "alt", () => (mailaiTemplate`图片 ${index+1}，点击预览`));preview(img);wrap.append(img);});element.querySelector('.assistant-bubble').prepend(wrap);}};
})();
