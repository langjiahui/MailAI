/* General address-book facets. Personal tags and imported labels keep their origins. */
(() => {
  const center = document.getElementById('contact-center');
  const legacy = center.querySelector('.contact-group-toolbar');
  const directory = center.querySelector('.directory-toolbar');
  if (!legacy || !directory) return;
  const state = {account:'', tags:new Set(), mode:'any', company:'', selected:new Set(), bulk:false, facets:{tags:[],companies:[],total:0}, revision:0};
  const bar = document.createElement('div');
  bar.className = 'contact-filter-bar';
  bar.innerHTML = `<details class="contact-filter-menu" data-tag-menu><summary><span data-i18n="ui.1d0fd5f9336d">标签</span> <span data-tag-count hidden></span><span aria-hidden="true">⌄</span></summary><section class="contact-filter-popover"><label class="contact-tag-search"><span data-i18n="ui.6158fd863c28">查找标签</span><input type="search" data-tag-search placeholder="输入标签名称" autocomplete="off" data-i18n-placeholder="ui.4919d0b20893"></label><div data-tag-options class="contact-tag-options"></div><label class="contact-tag-mode"><span data-i18n="ui.6e0634298099">多个标签</span><select data-tag-mode aria-label="多个标签的匹配方式" data-i18n-aria="ui.00cff074af26"><option value="any" data-i18n="ui.200fcebff6bd">包含任意标签</option><option value="all" data-i18n="ui.d811aabc3fd1">同时包含全部标签</option></select></label><footer><button type="button" data-tag-manage><span data-i18n="ui.e8b481c247b1">管理个人标签</span></button><button type="button" data-filter-done><span data-i18n="ui.c0b3fbff51cc">完成</span></button></footer></section></details><details class="contact-filter-menu" data-more-menu><summary><span data-i18n="ui.dbdccc3594d6">更多筛选</span><span aria-hidden="true">⌄</span></summary><section class="contact-filter-popover"><label data-company-field><span data-i18n="ui.e06ff957ed48">公司</span><select data-contact-company><option value="" data-i18n="ui.a6c7411df887">全部公司</option></select></label><div data-department-field></div><p class="contact-filter-hint"><span data-i18n="ui.1c066c0d4300">部门等资料用于筛选，个人标签可自由分类。</span></p><button type="button" data-filter-done><span data-i18n="ui.c0b3fbff51cc">完成</span></button></section></details><button type="button" data-bulk-toggle><span data-i18n="ui.3ffa953cc8f6">批量标记</span></button><span data-contact-results role="status" aria-live="polite"></span>`;
  legacy.after(bar);
  const bulkToggle=bar.querySelector('[data-bulk-toggle]');
  bar.querySelector('[data-tag-menu] footer').insertBefore(bulkToggle,bar.querySelector('[data-tag-menu] [data-filter-done]'));
  mailaiBindUI(bar.querySelector('[data-tag-manage]'), "textContent", () => (mailaiText('管理标签')));
  const chips = document.createElement('div');
  chips.className = 'contact-filter-chips'; chips.hidden = true;
  bar.after(chips);
  const bulkBar = document.createElement('div');
  bulkBar.className = 'contact-tag-bulk'; bulkBar.hidden = true;
  bulkBar.innerHTML = "<span data-bulk-count><span data-i18n=\"ui.7d0d6595c125\">已选 0 位</span></span><button type=\"button\" data-bulk-select><span data-i18n=\"ui.0972ab74ce09\">选择当前列表</span></button><button type=\"button\" data-bulk-apply disabled><span data-i18n=\"ui.04d82d140e11\">标记标签</span></button><button type=\"button\" data-bulk-exit><span data-i18n=\"ui.c0b3fbff51cc\">完成</span></button>";
  chips.after(bulkBar);
  const dept = document.getElementById('directory-department-filter');
  bar.querySelector('[data-department-field]').append(dept.parentElement);
  bar.append(document.getElementById('group-select-all'));
  // Keep legacy controls for compatibility; personal groups appear as tags.
  legacy.hidden = true;
  const groupLabel = document.getElementById('contact-group-name')?.parentElement;
  if (groupLabel) groupLabel.hidden = true;
  directory.hidden = true;
  mailaiBindUI(document.getElementById('contact-center-search'), "placeholder", () => (mailaiText('搜索姓名、拼音、邮箱、公司或标签')));
  document.getElementById('contact-center-search').removeAttribute('data-i18n-placeholder');

  const importEntry = center.querySelector('.productivity-panel-entry');
  const pending = document.getElementById('directory-pending-button');
  if (importEntry && pending) {
    importEntry.classList.add('contact-import-entry');
    importEntry.innerHTML="<svg viewBox=\"0 0 20 20\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M10 3v9m-3-3 3 3 3-3M4 12v4h12v-4\"/></svg><span><span data-i18n=\"ui.30a8cd826353\">导入通讯录</span></span>";
    const update = () => {
      const count = pending.hidden ? '' : (pending.textContent.match(/\d+$/)?.[0] || '');
      if (count) importEntry.dataset.pendingCount=count; else delete importEntry.dataset.pendingCount;
      mailaiBindUI(importEntry, "@aria-label", () => (mailaiText('导入通讯录')+(count ? mailaiTemplate`，${count}条待核对资料` : '')));
      mailaiBindUI(importEntry, "title", () => (mailaiText('导入新联系人或更新已有资料')+(count ? mailaiTemplate` · ${count} 条待核对资料` : '')));
    };
    new MutationObserver(update).observe(pending,{attributes:true,attributeFilter:['hidden'],childList:true,subtree:true}); update();
    const baseImport=window.mailaiDirectoryImport;
    window.mailaiDirectoryImport=(...args)=>{
      baseImport(...args);
      const links=document.querySelector('#contact-directory-dialog .directory-secondary-links');
      const count=importEntry.dataset.pendingCount;
      if(links && count) {
        const button=document.createElement('button');button.type='button';button.dataset.importPending='';mailaiBindUI(button, "textContent", () => (mailaiTemplate`待核对资料 · ${count}`));
        button.onclick=()=>pending.click();links.prepend(button);
      }
      const title=document.getElementById('directory-dialog-title');if(title)mailaiBindUI(title, "textContent", () => (mailaiText('导入通讯录')));
      const intro=document.querySelector('#contact-directory-dialog .directory-dialog-body>h3');if(intro)mailaiBindUI(intro, "textContent", () => (mailaiText('导入联系人，或更新已有资料')));
    };
  }

  function query() {
    const params=new URLSearchParams({company:state.company,tag_mode:state.mode});
    for(const tag of state.tags)params.append('tag',tag);
    return '&'+params;
  }
  const baseQuery=window.mailaiDirectoryQuery;
  window.mailaiDirectoryQuery=() => (baseQuery?.() || '')+query();
  window.mailaiContactFiltersReset=() => {
    ++state.revision;
    state.account=contactAccountId();state.tags.clear();state.company='';state.mode='any';state.selected.clear();state.bulk=false;
    state.facets={tags:[],companies:[],total:0};dept.value='';
    for(const menu of center.querySelectorAll('.contact-filter-menu'))menu.open=false;
    if(dialog.open)dialog.close();
    renderControls();
  };

  function renderTags() {
    const previous=bar.querySelector('[data-tag-options] input:focus')?.value;
    const scroll=bar.querySelector('[data-tag-options]').scrollTop;
    const search=bar.querySelector('[data-tag-search]').value.trim().toLocaleLowerCase();
    const tags=state.facets.tags.filter(t => !search || t.name.toLocaleLowerCase().includes(search));
    bar.querySelector('[data-tag-options]').innerHTML=['personal','directory'].map(source => {
      const rows=tags.filter(t=>t.source===source);
      return rows.length ? `<p class="contact-tag-section">${source==='personal' ? mailaiText('个人标签') : mailaiText('导入标签')}</p>`+rows.map(t=>`<label class="contact-tag-option"><input type="checkbox" value="${esc(t.id)}" ${state.tags.has(t.id)?'checked':''}><span>${esc(t.name)}</span><small>${t.count}</small></label>`).join('') : '';
    }).join('') || '<p class="contact-filter-hint">'+(search ? mailaiText('没有匹配的标签') : mailaiText('暂无标签，可先创建个人标签'))+'</p>';
    bar.querySelector('[data-tag-options]').scrollTop=scroll;
    if(previous)bar.querySelector(`[data-tag-options] input[value="${CSS.escape(previous)}"]`)?.focus({preventScroll:true});
  }
  function renderControls() {
    renderTags();
    const count=bar.querySelector('[data-tag-count]');count.hidden=!state.tags.size;count.textContent=state.tags.size;
    bar.querySelector('[data-tag-mode]').value=state.mode;
    bar.querySelector('.contact-tag-mode').hidden=state.tags.size<2;
    const company=bar.querySelector('[data-contact-company]');
    company.innerHTML="<option value=\"\" data-i18n=\"ui.a6c7411df887\">全部公司</option>"+state.facets.companies.map(c=>`<option value="${esc(c.name)}">${esc(c.name)} (${c.count})</option>`).join('');company.value=state.company;
    bar.querySelector('[data-company-field]').hidden=!state.facets.companies.length;
    bar.querySelector('[data-department-field]').hidden=dept.options.length<=1;
    bar.querySelector('[data-more-menu]').hidden=!state.facets.companies.length&&dept.options.length<=1;
    const labels=[...[...state.tags].map(id=>({kind:'tag',value:id,label:(state.facets.tags.find(t=>t.id===id)?.name || id.split(':').slice(1).join(':'))+(id.startsWith('directory:')?mailaiText(' · 导入'):'')})),...(state.company?[{kind:'company',value:'',label:mailaiText('公司：')+state.company}]:[]),...(dept.value?[{kind:'department',value:'',label:mailaiText('部门：')+dept.value}]:[])];
    chips.hidden=!labels.length;
    chips.innerHTML="<span><span data-i18n=\"ui.7ecf1cde6486\">已选</span></span>"+labels.map(l=>`<button type="button" data-clear-kind="${l.kind}" data-clear-value="${esc(l.value)}" aria-label="清除${esc(l.label)}" data-i18n-aria="ui.4b42ba52e07b">${esc(l.label)} <span aria-hidden="true">×</span></button>`).join('')+"<button type=\"button\" data-clear-all><span data-i18n=\"ui.657d9cbf45ec\">清除筛选</span></button>";
    mailaiBindUI(bar.querySelector('[data-contact-results]'), "textContent", () => (mailaiTemplate`${state.facets.total} 位联系人`));
    bar.querySelector('[data-bulk-toggle]').hidden=Boolean(contactPickerTarget)||state.bulk;
    bulkBar.hidden=!state.bulk;
    mailaiBindUI(bulkBar.querySelector('[data-bulk-count]'), "textContent", () => (mailaiTemplate`已选 ${state.selected.size} 位`));
    bulkBar.querySelector('[data-bulk-apply]').disabled=!state.selected.size;
  }
  const baseRefresh=window.mailaiDirectoryRefresh;
  window.mailaiDirectoryRefresh=async () => {
    const account=contactAccountId(),session=contactCenterSession,revision=++state.revision;
    await baseRefresh?.();
    if(account!==contactAccountId()||session!==contactCenterSession||revision!==state.revision)return;
    const params=new URLSearchParams({q:document.getElementById('contact-center-search').value.trim(),favorites_only:contactCenterFilter==='favorite',department:dept.value});
    try {
      const result=await api('/api/mail/contact-tags?'+params+query(),{accountId:account});
      if(account!==contactAccountId()||session!==contactCenterSession||revision!==state.revision)return;
      state.facets=result;renderControls();
    } catch(error) {
      if(account===contactAccountId()&&session===contactCenterSession&&revision===state.revision) {
        mailaiBindUI(bar.querySelector('[data-contact-results]'), "textContent", () => (mailaiText('筛选信息加载失败')));
        toast(mailaiText('标签加载失败：')+mailaiSystemMessage(error.message),'error');
      }
    }
  };
  window.mailaiDirectoryContactLabel=item => {
    const tags=[...(item.tags || [])].sort((a,b)=>Number(state.tags.has(b.id))-Number(state.tags.has(a.id)));
    const department=item.profile?.department || '';
    return department||tags.length ? `<div class="directory-contact-label contact-labels">${department?`<span>${esc(department)}</span>`:''}${tags.slice(0,2).map(t=>`<em title="${t.source==='directory'?mailaiText('导入标签'):mailaiText('个人标签')}">${esc(t.name)}</em>`).join('')}${tags.length>2?`<small title="${esc(tags.slice(2).map(t=>t.name).join('、'))}">+${tags.length-2}</small>`:''}</div>` : '';
  };
  window.mailaiContactFiltersRendered=() => {
    center.classList.toggle('contact-tag-selecting',state.bulk&&!contactPickerTarget);
    for(const row of center.querySelectorAll('.contact-center-item')) {
      const email=row.dataset.contactEmail;
      if(state.bulk&&!contactPickerTarget) {
        const label=document.createElement('label');label.className='contact-tag-check';
        label.innerHTML=`<input type="checkbox" data-tag-contact="${esc(email)}" aria-label="选择 ${esc(email)}" ${state.selected.has(email)?'checked':''} data-i18n-aria="ui.5fbeed0b1e4c">`;row.prepend(label);
      }
    }
    if((state.tags.size||state.company||dept.value) && !contactCenterItems.length) {
      center.querySelector('.contact-empty').innerHTML="<span>◎</span><b><span data-i18n=\"ui.d4f05580de89\">没有符合筛选条件的联系人</span></b><small><span data-i18n=\"ui.b0b399a3f383\">试试减少标签或其他筛选条件</span></small><button type=\"button\" data-reset-contact-filters><span data-i18n=\"ui.657d9cbf45ec\">清除筛选</span></button>";
    }
    renderControls();
  };

  bar.querySelector('[data-tag-search]').oninput=renderTags;
  bar.querySelector('[data-tag-options]').onchange=event => {
    const checkbox=event.target.closest('input[type=checkbox]');if(!checkbox)return;
    if(checkbox.checked)state.tags.add(checkbox.value);else state.tags.delete(checkbox.value);
    renderControls();void loadContactCenter();
  };
  bar.querySelector('[data-tag-mode]').onchange=event=>{state.mode=event.target.value;void loadContactCenter();};
  bar.querySelector('[data-contact-company]').onchange=event=>{state.company=event.target.value;renderControls();void loadContactCenter();};
  for(const done of bar.querySelectorAll('[data-filter-done]'))done.onclick=()=>{done.closest('details').open=false;};
  chips.onclick=event=>{
    const clear=event.target.closest('[data-clear-kind]');
    if(clear){if(clear.dataset.clearKind==='tag')state.tags.delete(clear.dataset.clearValue);else if(clear.dataset.clearKind==='company')state.company='';else dept.value='';}
    else if(event.target.closest('[data-clear-all]')){state.tags.clear();state.company='';dept.value='';}else return;
    renderControls();void loadContactCenter();
  };
  function setBulk(value){state.bulk=value;if(!value)state.selected.clear();renderContactCenter();}
  bar.querySelector('[data-bulk-toggle]').onclick=()=>{bar.querySelector('[data-tag-menu]').open=false;setBulk(true);};
  bulkBar.querySelector('[data-bulk-exit]').onclick=()=>setBulk(false);
  bulkBar.querySelector('[data-bulk-select]').onclick=()=>{const next=new Set([...state.selected,...contactCenterItems.map(item=>item.email)]);if(next.size>300){toast(mailaiText('每次最多标记 300 位，请分批选择'),'warn');return;}state.selected=next;renderContactCenter();};
  center.addEventListener('change',event=>{
    const input=event.target.closest('[data-tag-contact]');if(!input)return;
    if(input.checked&&state.selected.size>=300){input.checked=false;toast(mailaiText('每次最多标记 300 位，请分批选择'),'warn');return;}
    if(input.checked)state.selected.add(input.dataset.tagContact);else state.selected.delete(input.dataset.tagContact);renderControls();
  });
  center.addEventListener('click',event=>{
    if(event.target.closest('[data-reset-contact-filters]')){state.tags.clear();state.company='';dept.value='';renderControls();void loadContactCenter();}
  });
  bulkBar.querySelector('[data-bulk-apply]').onclick=()=>openTagDialog([...state.selected]);
  bar.querySelector('[data-tag-manage]').onclick=()=>openTagDialog();

  const dialog=document.createElement('dialog');dialog.className='contact-tags-dialog';dialog.id='contact-tags-dialog';
  dialog.setAttribute('aria-labelledby','contact-tags-title');document.body.append(dialog);
  let dialogRevision=0,returnFocus;
  // Keep row actions compact: individual label editing belongs in the contact editor.
  const editorTags=document.createElement('div');editorTags.className='contact-editor-tags';
  editorTags.innerHTML="<div><span><span data-i18n=\"ui.1d0fd5f9336d\">标签</span></span><div class=\"contact-editor-tag-values\"></div></div><button type=\"button\"><span data-i18n=\"ui.b819b0dd5668\">设置标签</span></button>";
  center.querySelector('.contact-editor-fields .contact-favorite-check').before(editorTags);
  let editorEmail='',editorOriginal=null;
  function renderEditorTags(item) {
    editorEmail=item?.email||'';
    editorTags.querySelector('button').disabled=!editorEmail;
    editorTags.querySelector('.contact-editor-tag-values').innerHTML=item?.tags?.length ? item.tags.map(t=>`<em title="${t.source==='directory'?mailaiText('导入标签'):mailaiText('个人标签')}">${esc(t.name)}</em>`).join('') : `<small>${editorEmail?mailaiText('尚未设置标签'):mailaiText('保存联系人后可设置标签')}</small>`;
  }
  const baseEdit=window.mailaiDirectoryEdit;
  window.mailaiDirectoryEdit=item=>{baseEdit?.(item);editorOriginal=item?structuredClone(item):null;renderEditorTags(item);};
  editorTags.querySelector('button').onclick=()=>{if(editorEmail)openTagDialog([editorEmail]);};
  dialog.addEventListener('close',()=>{++dialogRevision;returnFocus?.isConnected&&returnFocus.focus({preventScroll:true});});
  async function openTagDialog(emails=[]) {
    for(const menu of bar.querySelectorAll('details'))menu.open=false;
    const account=contactAccountId(),session=contactCenterSession,revision=++dialogRevision;
    const personal=state.facets.tags.filter(t=>t.source==='personal');
    returnFocus=document.activeElement;
    dialog.innerHTML=`<header><div><h2 id="contact-tags-title">${emails.length?mailaiText('标记标签'):mailaiText('管理个人标签')}</h2><p>${emails.length?mailaiTemplate`已选择 ${emails.length} 位联系人；添加标签会保留原有分类。`:mailaiText('标签可用于项目、客户、合作伙伴等分类。')}</p></div><button type="button" data-tags-close aria-label="关闭标签管理" data-i18n-aria="ui.ddb7eb41411d">×</button></header><form><section>${emails.length?`<label><span data-i18n="ui.5ccafb30bde0">选择个人标签</span><select data-member-tag ${personal.length?'':'disabled'}>${personal.map(t=>`<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}</select></label><div class="contact-tag-member-actions"><button type="button" data-member-add class="primary-action" ${personal.length?'':'disabled'}><span data-i18n="ui.795cbff909c4">添加标签</span></button><button type="button" data-member-remove ${personal.length?'':'disabled'}><span data-i18n="ui.6fe8fc1819da">移除标签</span></button></div>`:`<div class="contact-tag-manager">${personal.map(t=>`<div><span>${esc(t.name)}</span><small><span data-i18n="ui.afb106888ff7">${t.count} 位</span></small><button type="button" data-tag-rename="${esc(t.name)}"><span data-i18n="ui.0d0cbac2eee5">重命名</span></button><button type="button" data-tag-delete="${esc(t.name)}"><span data-i18n="ui.2f9daa828907">删除</span></button></div>`).join('')||"<p><span data-i18n=\"ui.42fe077821b8\">暂无个人标签</span></p>"}</div>`}<p class="contact-filter-hint"><span data-i18n="ui.7780b19b9c68">导入标签由原始名单维护，在“导入 / 更新”中更新。</span></p><div class="contact-tag-create"><label><span data-tag-edit-label><span data-i18n="ui.0afd507dc2ea">新建个人标签</span></span><input data-new-tag maxlength="80" required placeholder="例如：项目A、客户" autocomplete="off" data-i18n-placeholder="ui.1baa448eaa68"></label><button type="submit"><span data-i18n="ui.cde2cd071d25">创建</span></button><button type="button" data-cancel-rename hidden><span data-i18n="ui.e3d4c9787ab0">取消重命名</span></button></div><p data-tags-message role="status" aria-live="polite"></p></section><footer><button type="button" data-tags-close><span data-i18n="ui.c0b3fbff51cc">完成</span></button></footer></form>`;
    if(!dialog.open)dialog.showModal();
    dialog.querySelector('[data-new-tag]').focus();
    const live=()=>dialog.open && revision===dialogRevision && session===contactCenterSession && account===contactAccountId();
    const message=dialog.querySelector('[data-tags-message]');
    for(const close of dialog.querySelectorAll('[data-tags-close]'))close.onclick=()=>dialog.close();
    let previous=null;
    async function mutate(action, success) {
      const controls=[...dialog.querySelectorAll('button,input,select')].map(n=>[n,n.disabled]);
      controls.forEach(([n])=>n.disabled=true);dialog.setAttribute('aria-busy','true');mailaiBindUI(message, "textContent", () => (mailaiText('正在保存…')));
      const prevent=event=>event.preventDefault();dialog.addEventListener('cancel',prevent);
      try {
        await action();if(!live())return;
        await loadContactCenter();if(!live())return;
        if(editorEmail && !document.getElementById('contact-editor').classList.contains('hidden')) {
          const items=await api('/api/mail/contacts?q='+encodeURIComponent(editorEmail),{accountId:account});
          if(!live())return;
          const current=items.find(item=>item.email===editorEmail);
          // Only advance the editor's revision when the tag operation changed a
          // legacy group and all other saved fields still match the opened item.
          if(current && editorOriginal && ['name','company','note','favorite'].every(key=>current[key]===editorOriginal[key]) && JSON.stringify(current.profile||{})===JSON.stringify(editorOriginal.profile||{})) {
            document.getElementById('contact-group-name').value=current.group_name||'';
            document.querySelector('.directory-editor-details').dataset.revision=current.directory_revision||'';
            editorOriginal=structuredClone(current);
          }
          renderEditorTags(current);
        }
        dialog.close();toast(success,'success');
      } catch(error) {if(live()){message.textContent=mailaiSystemMessage(error.message);message.classList.add('contact-tag-error');}}
      finally {controls.forEach(([n,disabled])=>n.disabled=disabled);dialog.removeAttribute('aria-busy');dialog.removeEventListener('cancel',prevent);}
    }
    const post=body=>({accountId:account,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    dialog.querySelector('form').onsubmit=event=>{event.preventDefault();const name=dialog.querySelector('[data-new-tag]').value.trim();if(!name)return;void mutate(async()=>{await api('/api/mail/contact-tags',post({name,previous}));if(live()&&previous&&state.tags.delete('personal:'+previous))state.tags.add('personal:'+name);},previous?mailaiText('标签已重命名'):mailaiText('标签已创建'));};
    for(const button of dialog.querySelectorAll('[data-tag-rename]'))button.onclick=()=>{previous=button.dataset.tagRename;dialog.querySelector('[data-new-tag]').value=previous;mailaiBindUI(dialog.querySelector('[data-tag-edit-label]'), "textContent", () => (mailaiText('重命名标签')));mailaiBindUI(dialog.querySelector('[type=submit]'), "textContent", () => (mailaiText('保存')));dialog.querySelector('[data-cancel-rename]').hidden=false;dialog.querySelector('[data-new-tag]').focus();};
    dialog.querySelector('[data-cancel-rename]').onclick=()=>{previous=null;dialog.querySelector('[data-new-tag]').value='';mailaiBindUI(dialog.querySelector('[data-tag-edit-label]'), "textContent", () => (mailaiText('新建个人标签')));mailaiBindUI(dialog.querySelector('[type=submit]'), "textContent", () => (mailaiText('创建')));dialog.querySelector('[data-cancel-rename]').hidden=true;};
    for(const button of dialog.querySelectorAll('[data-tag-delete]'))button.onclick=async()=>{
      const name=button.dataset.tagDelete;
      if(await mailaiAsk({get title() { return mailaiText('删除标签'); },message:mailaiTemplate`删除“${name}”？联系人和邮件都会保留。`,get confirmText() { return mailaiText('删除标签'); },danger:true}) && live())void mutate(async()=>{await api('/api/mail/contact-tags?name='+encodeURIComponent(name),{accountId:account,method:'DELETE'});if(live())state.tags.delete('personal:'+name);},mailaiText('标签已删除'));
    };
    for(const button of dialog.querySelectorAll('[data-member-add],[data-member-remove]'))button.onclick=()=>{
      const name=dialog.querySelector('[data-member-tag]').value;
      void mutate(()=>api('/api/mail/contact-tags/members',post({name,emails,remove:button.hasAttribute('data-member-remove')})),mailaiText('联系人标签已更新'));
    };
  }
  // Native disclosures remain keyboard-accessible and close on Escape/outside click.
  document.addEventListener('click',event=>{for(const menu of center.querySelectorAll('.contact-filter-menu[open]'))if(!menu.contains(event.target))menu.open=false;});
  center.addEventListener('keydown',event=>{if(event.key==='Escape'){const menu=center.querySelector('.contact-filter-menu[open]');if(menu){event.stopPropagation();menu.open=false;menu.querySelector('summary').focus();}}});
  for(const menu of bar.querySelectorAll('details'))menu.addEventListener('toggle',()=>{if(menu.open)for(const other of center.querySelectorAll('.contact-filter-menu'))if(other!==menu)other.open=false;});
  renderControls();
})();
