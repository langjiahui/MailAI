/* Mail labels share the existing AI-category facet and account-scoped mail state. */
(() => {
  const state = {account:'', tags:[], rules:[], revision:0, query:'', rows:[]};
  const group = document.getElementById('mail-tag-group');
  const nav = document.getElementById('mail-tag-nav');
  const ordered = tags => [...tags].sort((a,b)=>a.name.localeCompare(b.name,currentI18nLanguage(),{numeric:true,sensitivity:'base'}));
  const post = body => ({method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const selected = () => currentFilter.mailTags || [];
  const isCurrent = account => account === (activeMailAccount()?.id || '');
  const color = tag => /^#[a-f\d]{6}$/i.test(tag.color) ? tag.color : '#548879';
  const chip = tag => `<span class="mail-label-chip" data-user-content title="${esc(tag.name)}"><i style="--mail-label-color:${color(tag)}"></i><span class="mail-label-name">${esc(tag.name)}</span></span>`;
  window.mailaiMailTagChips = (email, limit = Number.POSITIVE_INFINITY) => {
    const tags = email.tags || [];
    return tags.slice(0,limit).map(chip).join('') + (tags.length>limit ? `<span class="mail-label-overflow" title="${esc(tags.slice(limit).map(t=>t.name).join(' · '))}">+${tags.length-limit}</span>` : '');
  };
  window.mailaiMatchMailTags = email => {
    const names = new Set((email.tags || []).map(tag => tag.name));
    return !selected().length || (currentFilter.mailTagMode === 'all' ? selected().every(name => names.has(name)) : selected().some(name => names.has(name)));
  };
  window.mailaiRefreshTags = async (account, strict = false) => {
    const revision = ++state.revision;
    if (state.account !== account) {
      state.account = account; state.tags = []; state.rules = [];
      currentFilter.mailTags = []; currentFilter.mailTagMode = 'any'; state.query='';
      group.querySelector('[data-mail-label-search]').value='';
      if(dialog.open && !busy) dialog.close();
    }
    try {
      const data = await api('/api/mail/tags', {accountId:account});
      if (revision !== state.revision || !isCurrent(account)) return;
      state.tags = ordered(data.tags); state.rules = data.rules;
    } catch (error) { if(strict)throw error; }
  };
  const search = document.createElement('input');
  search.type='search';search.dataset.mailLabelSearch='';search.className='mail-label-search';
  group.querySelector('.mail-tag-heading').after(search);
  mailaiBindUI(search,'@aria-label',()=>mailaiText('查找邮件标签'));
  mailaiBindUI(search,'placeholder',()=>mailaiText('查找标签…'));
  search.oninput=()=>{state.query=search.value.trim().toLocaleLowerCase();window.mailaiRenderMailTags(state.rows);};
  window.mailaiRenderMailTags = rows => {
    state.rows=rows;
    group.hidden = Boolean(specialMailbox);
    const tags = new Map((isCurrent(state.account) ? state.tags : []).map(tag => [tag.name, {...tag, count:0}]));
    for (const email of rows) for (const tag of email.tags || []) {
      if (!tags.has(tag.name)) tags.set(tag.name, {...tag, count:0});
      tags.get(tag.name).count++;
    }
    for (const name of selected()) if (!tags.has(name)) tags.set(name, {name, color:'#548879', count:0});
    const scroll=nav.scrollTop, focus=nav.querySelector('button:focus')?.dataset.mailTag;
    search.hidden=tags.size<7 && !state.query;
    nav.innerHTML = [...tags.values()].filter(tag=>!state.query || tag.name.toLocaleLowerCase().includes(state.query)).sort((a,b) => a.name.localeCompare(b.name,currentI18nLanguage(),{numeric:true,sensitivity:'base'})).map(tag => `<button type="button" class="nav-item mail-tag-filter ${selected().includes(tag.name) ? 'active' : ''}" data-mail-tag="${esc(tag.name)}" aria-pressed="${selected().includes(tag.name)}"><span class="mail-label-check" aria-hidden="true">${selected().includes(tag.name) ? '✓' : ''}</span><span class="mail-label-dot" style="--mail-label-color:${color(tag)}"></span><span class="mail-tag-name" data-user-content>${esc(tag.name)}</span><span class="count">${tag.count}</span></button>`).join('') || `<p class="mail-tags-empty">${state.query ? mailaiText('没有匹配的标签') : mailaiText("用标签整理项目、客户和日常邮件")}</p>`;
    nav.scrollTop=scroll;
    if(focus)nav.querySelector(`[data-mail-tag="${CSS.escape(focus)}"]`)?.focus({preventScroll:true});
    group.querySelector('[data-mail-tag-selection]').hidden = !selected().length;
    group.querySelector('[data-mail-tag-mode]').value = currentFilter.mailTagMode || 'any';
    group.querySelector('[data-mail-tag-mode]').hidden = selected().length < 2;
  };
  nav.onclick = event => {
    const button = event.target.closest('[data-mail-tag]');
    if (!button || bulkOperationActive) return;
    const names = new Set(selected()), name = button.dataset.mailTag;
    if (names.has(name)) names.delete(name); else names.add(name);
    currentFilter.mailTags = [...names];
    applyFilters();
  };
  group.querySelector('[data-mail-tag-clear]').onclick = () => { currentFilter.mailTags = []; applyFilters(); };
  group.querySelector('[data-mail-tag-mode]').onchange = event => { currentFilter.mailTagMode = event.target.value; applyFilters(); };

  const dialog = document.createElement('dialog');
  dialog.id = 'mail-tags-dialog'; dialog.className = 'mail-tags-dialog';
  dialog.setAttribute('aria-labelledby', 'mail-tags-title');
  document.body.append(dialog);
  dialog.addEventListener('close', () => { if (!dialog.open) dialog.replaceChildren(); });
  let busy = false, session = 0, opening = 0, dirty=false;
  function message(text, error=false) {
    const host=dialog.querySelector('.mail-tags-message');if(!host)return;
    const source=mailaiCopySource(text);
    mailaiBindUI(host,'textContent',()=>mailaiSystemMessage(source));host.classList.toggle('error',error);
  }
  function requestClose() {
    if(busy)return;
    if(!dirty){dialog.close();return;}
    if(dialog.querySelector('.mail-tags-unsaved'))return;
    const box=document.createElement('div');box.className='mail-tags-unsaved mail-tags-confirm';
    box.innerHTML=`<p><span data-i18n="mailTags.84a95d1b38c6">${mailaiText('有尚未保存的修改')}</span></p><button type="button" data-keep-editing><span data-i18n="ui.fd4b9e3b6c68">${mailaiText('继续编辑')}</span></button><button type="button" data-discard><span data-i18n="mailTags.9b7824cefa1e">${mailaiText('放弃修改')}</span></button>`;
    dialog.querySelector('header').after(box);
    box.querySelector('[data-keep-editing]').onclick=()=>box.remove();
    box.querySelector('[data-discard]').onclick=()=>{dirty=false;dialog.close();};
    box.querySelector('[data-keep-editing]').focus();
  }
  function requestDiscard(action) {
    if(!dirty){action();return;}
    if(dialog.querySelector('.mail-tags-unsaved'))return;
    requestClose();
    const discard=dialog.querySelector('[data-discard]');
    if(discard)discard.onclick=()=>{dirty=false;dialog.querySelector('.mail-tags-unsaved')?.remove();action();};
  }
  dialog.addEventListener('input',event=>{if(!event.target.matches('[type=search]'))dirty=true;});
  dialog.addEventListener('change',event=>{if(!event.target.matches('[type=search]'))dirty=true;});
  // Keep the local catalogue usable even when a successful write's refresh fails.
  async function write(path, opts) {
    const result=await api(path,opts);
    if(state.account===opts.accountId){
      const payload=opts.body ? JSON.parse(opts.body) : {};
      if(path==='/api/mail/tags')state.tags=[...state.tags.filter(t=>t.id!==result.id),{count:0,...state.tags.find(t=>t.id===result.id),...result}];
      else if(path==='/api/mail/tag-rules')state.rules=[...state.rules.filter(r=>r.id!==result.id),{...payload,id:result.id}];
      else if(opts.method==='DELETE' && path.startsWith('/api/mail/tag-rules/'))state.rules=state.rules.filter(r=>r.id!==Number(path.split('/').at(-1)));
      else if(opts.method==='DELETE' && path.startsWith('/api/mail/tags/')){
        const id=Number(path.split('/').at(-1));state.tags=state.tags.filter(t=>t.id!==id);
        state.rules=state.rules.map(r=>({...r,tag_ids:r.tag_ids.filter(t=>t!==id)})).filter(r=>r.tag_ids.length);
      }
    }
    return result;
  }
  function shell(title, subtitle) {
    ++session;dirty=false;
    dialog.innerHTML = `<header><div><h2 id="mail-tags-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button type="button" class="mail-tags-close" aria-label="${mailaiText("关闭")}" data-i18n-aria="ui.3fd47edce45b">×</button></header><div class="mail-tags-message" role="status" aria-live="polite"></div><div class="mail-tags-body"></div>`;
    const titleSource=mailaiCopySource(title),subtitleSource=mailaiCopySource(subtitle);
    mailaiBindUI(dialog.querySelector('#mail-tags-title'),'textContent',()=>mailaiSystemMessage(titleSource));
    mailaiBindUI(dialog.querySelector('header p'),'textContent',()=>mailaiSystemMessage(subtitleSource));
    dialog.querySelector('.mail-tags-close').onclick = requestClose;
    if (!dialog.open) dialog.showModal();
    return dialog.querySelector('.mail-tags-body');
  }
  dialog.addEventListener('cancel', event => { event.preventDefault();requestClose(); });
  // A pending mutation stays attached to its original account even if the UI changes.
  async function mutate(account, action, after) {
    if (busy) return;
    busy = true;
    const revision = session, activeAtStart = activeMailAccount()?.id || '', navigationAtStart=mailboxNavigationRevision;
    const controls = [...dialog.querySelectorAll('button,input,select')].map(node => [node,node.disabled]);
    controls.forEach(([node]) => node.disabled = true);
    dialog.setAttribute('aria-busy','true');
    dialog.querySelector('.mail-tags-body').inert = true;
    const statusNode = dialog.querySelector('.mail-tags-message');
    statusNode.textContent = mailaiText("正在保存…"); statusNode.classList.remove('error');
    try {
      const result = await action();
      dirty=false;
      let refreshError=false;
      if (revision !== session) return;
      if (isCurrent(activeAtStart) && navigationAtStart===mailboxNavigationRevision) {
        try { if (isCurrent(account)) await window.mailaiRefreshTags(account,true); } catch (_) { refreshError=true; }
        try { await after?.(result); } catch (_) { refreshError=true; }
        if(refreshError){
          const text=mailaiText('已保存，但列表刷新失败；请刷新列表查看最新标签');
          if(dialog.open)message(text);else toast(text,'warn');
        }
      } else dialog.close();
    } catch (error) {
      if (revision === session) { statusNode.textContent = mailaiSystemMessage(error.message); statusNode.classList.add('error'); }
    } finally {
      busy = false; dialog.removeAttribute('aria-busy');
      const body = dialog.querySelector('.mail-tags-body'); if(body)body.inert = false;
      controls.forEach(([node,disabled]) => { if (node.isConnected) node.disabled = disabled; });
    }
  }
  function checks(tags, ids = []) {
    return (tags.length>6?`<input class="mail-label-search mail-picker-search" type="search" data-picker-search aria-label="${mailaiText('查找邮件标签')}" placeholder="${mailaiText('查找标签…')}" data-i18n-placeholder="mailTags.5a2d271ad581" data-i18n-aria="mailTags.25e5b30852f6">`:'') + ordered(tags).map(tag => `<label class="mail-tag-choice" data-label-option="${esc(tag.name.toLocaleLowerCase())}"><input type="checkbox" name="tag_ids" value="${tag.id}" ${ids.includes(tag.id) ? 'checked' : ''}>${chip(tag)}</label>`).join('') || `<p class="mail-tags-empty"><span data-i18n="mailTags.3ec239688fa7">${mailaiText("还没有标签，先在下方创建一个。")}</span></p>`;
  }
  dialog.addEventListener('input',event=>{
    if(!event.target.matches('[data-picker-search]'))return;
    const host=event.target.closest('.mail-tag-choices'),q=event.target.value.trim().toLocaleLowerCase();
    for(const option of host.querySelectorAll('[data-label-option]'))option.hidden=Boolean(q&&!option.dataset.labelOption.includes(q));
    let empty=host.querySelector('[data-label-no-match]');
    if(!empty){empty=document.createElement('p');empty.dataset.labelNoMatch='';empty.className='mail-tags-empty';host.append(empty);mailaiBindUI(empty,'textContent',()=>mailaiText('没有匹配的标签'));}
    empty.hidden=Boolean(host.querySelector('[data-label-option]:not([hidden])'));
  });
  function chosen(host) { return [...host.querySelectorAll('[name=tag_ids]:checked')].map(node => Number(node.value)); }
  async function refreshMailbox(account) {
    const activeAtStart = activeMailAccount()?.id || '';
    if (!isCurrent(account) && !unifiedMailbox) return;
    const reader = selectedEmailDetail, readerAccount = selectedEmailAccountId || account;
    const navigation=mailboxNavigationRevision;
    const live=()=>isCurrent(activeAtStart) && navigation===mailboxNavigationRevision;
    const searchSnapshot=searchResults;
    if(searchSnapshot){
      const ids=[...new Set(searchSnapshot.filter(row=>(!row._account_id || row._account_id===account)&&!row._kind).map(row=>row.id))];
      for(let start=0;start<ids.length && live();start+=1000){
        const result=await api('/api/mail/tags/snapshot',{...post({ids:ids.slice(start,start+1000)}),accountId:account});
        if(!live() || searchSnapshot!==searchResults)return;
        const byId=new Map(result.items.map(item=>[item.id,item.tags]));
        for(const row of searchSnapshot)if((!row._account_id || row._account_id===account)&&byId.has(row.id))row.tags=byId.get(row.id);
      }
    }
    if(!live())return;
    if(!await loadData({includeAncillary:false,silent:true}))throw new Error('refresh');
    if(!live())return;
    if (reader && selectedEmailId === reader.id && readerAccount === (selectedEmailAccountId || account)) {
      const result = await api('/api/mail/tags/snapshot', {...post({ids:[reader.id]}),accountId:readerAccount});
      if(live() && selectedEmailDetail===reader && selectedEmailId===reader.id && readerAccount===(selectedEmailAccountId||account)){
        const fresh=result.items[0];
        if(!fresh)return;
        selectedEmailDetail.tags=fresh.tags;
        const host=document.querySelector('[data-reading-mail-tags]');
        if(host)host.innerHTML=window.mailaiMailTagChips(fresh);
      }
    }
  }

  window.mailaiEditMailTags = async (bulk = false) => {
    if (busy || bulkOperationActive) return;
    if (bulk && unifiedMailbox) return toast(mailaiText("请先选择具体邮箱，再批量设置标签"), 'warn');
    const openRevision=++opening, navigation=mailboxNavigationRevision;
    const account = bulk ? activeMailAccount()?.id || '' : selectedEmailAccountId || activeMailAccount()?.id || '';
    let ids = bulk ? [...selectedMailIds] : selectedEmailId ? [selectedEmailId] : [];
    if (!ids.length) return;

    try {
      const [data, snapshot] = await Promise.all([api('/api/mail/tags', {accountId:account}),
        bulk ? Promise.resolve(null) : api('/api/mail/tags/snapshot',{...post({ids}),accountId:account})]);
      if(openRevision!==opening || navigation!==mailboxNavigationRevision || busy)return;
      if (bulk ? !isCurrent(account) : account !== (selectedEmailAccountId || activeMailAccount()?.id || '') || ids[0] !== selectedEmailId) return;
      const initial = !bulk ? (snapshot.items[0]?.tags || []).map(tag => tag.id) : [];
      if(!bulk && !snapshot.items.length)return toast(mailaiText('邮件已不存在，请刷新列表'),'warn');
      if(bulk && (ids.length!==selectedMailIds.size || ids.some(id=>!selectedMailIds.has(id))))return;
      const body = shell(bulk ? mailaiTemplate`设置标签 · ${ids.length} 封邮件` : mailaiText("设置邮件标签"), mailaiText("可设置多个标签；标签只在当前邮箱中使用。"));
      body.innerHTML = `<form data-assign-form><div class="mail-tag-choices">${checks(data.tags,initial)}</div>${bulk ? `<label class="mail-tags-field"><span data-i18n="mailTags.2fa505cac3fc">${mailaiText("操作方式")}</span><select name="mode"><option value="add" data-i18n="mailTags.fa33f0a971aa">${mailaiText("添加所选标签（保留原有标签）")}</option><option value="remove" data-i18n="mailTags.a88c33102e08">${mailaiText("移除所选标签")}</option></select></label>` : ''}<footer><button type="button" data-dismiss><span data-i18n="ui.2cd0f3be8738">${mailaiText("取消")}</span></button><button class="primary-action" type="submit"><span data-i18n="mailTags.277c532bb96c">${mailaiText("保存标签")}</span></button></footer></form><form class="mail-tags-inline-create"><label class="mail-tags-field"><span data-i18n="mailTags.040692852ad5">${mailaiText("新建标签")}</span><input name="name" required maxlength="80" placeholder="${mailaiText("例如：项目 A、待跟进")}" data-i18n-placeholder="mailTags.d2d2792be958"></label><button type="submit"><span data-i18n="ui.cde2cd071d25">${mailaiText("创建")}</span></button></form>`;
      dirty=false;
      body.querySelector('[data-dismiss]').onclick = requestClose;
      body.querySelector('[data-assign-form]').onsubmit = event => {
        event.preventDefault();
        const tagIds = chosen(body), mode = bulk ? body.querySelector('[name=mode]').value : 'replace';
        if(bulk && tagIds.length>50)return message(mailaiText('批量操作每次最多选择 50 个标签'),true);
        if (bulk && !tagIds.length) return message(mailaiText('请至少选择一个标签'),true);
        void mutate(account, async () => {
          const result={items:[],failed:[],completed:0};
          for(let start=0;start<ids.length;start+=100){
            const batch=ids.slice(start,start+100);
            message(mailaiTemplate`正在设置标签 · ${start} / ${ids.length}`);
            try{
              const part=await write('/api/mail/tags/members',{...post({ids:batch,tag_ids:tagIds,mode,...(!bulk?{original_tag_ids:initial}:{})}),accountId:account});
              result.items.push(...part.items);result.completed+=batch.length;
            }catch(error){result.failed.push(...batch);result.error=mailaiSystemMessage(error.message);}
          }
          return result;
        }, async result => {
          if(result.failed.length){
            ids=result.failed;dirty=true;
            mailaiBindUI(body.querySelector('[data-assign-form] [type=submit]'),'textContent',()=>mailaiTemplate`重试剩余 ${ids.length} 封`);
            if(bulk){selectedMailIds=new Set(ids);syncBulkSelectionVisuals();}
            message(mailaiTemplate`已完成 ${result.completed} 封，剩余 ${ids.length} 封未完成；保存可重试剩余邮件。${result.error}`,true);
            try{await refreshMailbox(account);}catch(_){}
            return;
          }
          dialog.close(); await refreshMailbox(account); toast(mailaiText("邮件标签已保存"),'success');
        });
      };
      body.querySelector('.mail-tags-inline-create').onsubmit = event => {
        event.preventDefault();
        const form = event.target, previous = chosen(body);
        void mutate(account, () => write('/api/mail/tags',{...post({name:form.elements.name.value}),accountId:account}), result => {
          data.tags.push(result);
          body.querySelector('.mail-tag-choices').innerHTML = checks(data.tags,[...previous,result.id]);
          form.reset(); dirty=true; dialog.querySelector('.mail-tags-message').textContent = mailaiText("已创建，保存后添加到邮件");
        });
      };
    } catch (error) { toast(error.message,'error'); }
  };

  function conditionRow(condition = {field:'sender',operator:'contains',value:''}) {
    return `<div class="mail-tag-condition"><select aria-label="${mailaiText("匹配字段")}" data-field data-i18n-aria="mailTags.55fde6c2daae">${[['sender',mailaiText("发件人")],['subject',mailaiText("主题")],['body',mailaiText("正文")]].map(([value,label]) => `<option value="${value}" data-i18n="${mailaiUICopyKeys.get(mailaiCopySource(label))}" ${condition.field === value ? 'selected' : ''}>${label}</option>`).join('')}</select><select aria-label="${mailaiText("匹配方式")}" data-operator data-i18n-aria="mailTags.e1f0f1cb1ab4">${[['contains',mailaiText("包含")],['equals',mailaiText("等于")],['not_contains',mailaiText("不包含")]].map(([value,label]) => `<option value="${value}" data-i18n="${mailaiUICopyKeys.get(mailaiCopySource(label))}" ${condition.operator === value ? 'selected' : ''}>${label}</option>`).join('')}</select><input aria-label="${mailaiText("匹配内容")}" required maxlength="500" placeholder="${mailaiText("输入地址、域名或关键词")}" value="${esc(condition.value)}" data-i18n-placeholder="mailTags.f9c794b20df9" data-i18n-aria="mailTags.f56dd05e1d51"><button type="button" data-remove-condition aria-label="${mailaiText("移除此条件")}" data-i18n-aria="mailTags.cde3b661f757">×</button></div>`;
  }
  async function manage(tab='tags') {
    if (busy) return;
    const account = activeMailAccount()?.id || '', openRevision=++opening, navigation=mailboxNavigationRevision;
    try {
      const data = await api('/api/mail/tags',{accountId:account});
      if (!isCurrent(account)||openRevision!==opening||navigation!==mailboxNavigationRevision||busy) return;
      state.account=account; state.tags=ordered(data.tags); state.rules=data.rules;
      const body = shell(mailaiText("邮件标签"), mailaiTemplate`${activeMailAccount()?.user || mailaiText("当前邮箱")} · 标签筛选可与 AI 分类同时使用`);
      body.innerHTML = `<div class="mail-tags-tabs" role="tablist" aria-label="${mailaiText("标签管理")}" data-i18n-aria="mailTags.5d033fdc3269"><button type="button" role="tab" id="mail-label-tab-tags" aria-controls="mail-label-manager" tabindex="${tab==='tags'?0:-1}" aria-selected="${tab==='tags'}" data-tab="tags"><span data-i18n="mailTags.5d033fdc3269">${mailaiText("标签管理")}</span></button><button type="button" role="tab" id="mail-label-tab-rules" aria-controls="mail-label-manager" tabindex="${tab==='rules'?0:-1}" aria-selected="${tab==='rules'}" data-tab="rules"><span data-i18n="mailTags.49c87837d794">${mailaiText("自动打标规则 ")}</span><span>${state.rules.length}</span></button></div><section id="mail-label-manager" role="tabpanel" data-manager-panel></section>`;
      for (const button of body.querySelectorAll('[data-tab]')) button.onclick = () => { if(dirty){requestDiscard(()=>button.click());return;} for (const item of body.querySelectorAll('[data-tab]')) {item.setAttribute('aria-selected',String(item===button));item.tabIndex=item===button?0:-1;} renderPanel(button.dataset.tab); };
      function renderPanel(view) {
        dirty=false;
        dialog.querySelector('.mail-tags-unsaved')?.remove();
        body.querySelector('[data-tab=rules] span').textContent=state.rules.length;
        const panel = body.querySelector('[data-manager-panel]');
        panel.setAttribute('aria-labelledby',`mail-label-tab-${view}`);
        if (view === 'tags') {
          panel.innerHTML = `<div class="mail-tags-list">${state.tags.map(tag => `<article>${chip(tag)}<small>${tag.count}<span data-i18n="ui.a5a7f147d294">${mailaiText(" 封")}</span></small><button type="button" data-edit-tag="${tag.id}"><span data-i18n="mailTags.051836569928">${mailaiText("编辑")}</span></button><button type="button" data-delete-tag="${tag.id}"><span data-i18n="ui.2f9daa828907">${mailaiText("删除")}</span></button></article>`).join('') || `<p class="mail-tags-empty"><span data-i18n="mailTags.fd8d47324bff">${mailaiText("创建标签后，可手动设置或按规则自动添加。")}</span></p>`}</div><form data-tag-form><h3 data-tag-form-title><span data-i18n="mailTags.040692852ad5">${mailaiText("新建标签")}</span></h3><div class="mail-tags-create"><label class="mail-tags-field"><span data-i18n="mailTags.88ca83c0374a">${mailaiText("标签名称")}</span><input name="name" required maxlength="80" placeholder="${mailaiText("例如：客户、项目 A、发票")}" data-i18n-placeholder="mailTags.0fff42b8624f"></label><label class="mail-tags-field"><span data-i18n="mailTags.070a8016fcc3">${mailaiText("颜色")}</span><input type="color" name="color" value="#548879"></label><button class="primary-action" type="submit"><span data-i18n="ui.a3030bf8f16d">${mailaiText("保存")}</span></button><button type="button" data-reset-tag hidden><span data-i18n="mailTags.4b29ce8e4093">${mailaiText("取消编辑")}</span></button></div></form>`;
          let editing = null;
          const form = panel.querySelector('form');
          const reset = () => { dirty=false;editing=null; form.reset(); panel.querySelector('[data-tag-form-title]').textContent=mailaiText("新建标签"); panel.querySelector('[data-reset-tag]').hidden=true; };
          panel.querySelector('[data-reset-tag]').onclick = reset;
          for (const button of panel.querySelectorAll('[data-edit-tag]')) button.onclick = () => { if(dirty){requestDiscard(()=>button.click());return;} const tag=state.tags.find(t=>t.id===Number(button.dataset.editTag)); editing=tag.id; form.elements.name.value=tag.name; form.elements.color.value=tag.color; panel.querySelector('[data-tag-form-title]').textContent=mailaiText("编辑标签"); panel.querySelector('[data-reset-tag]').hidden=false; form.elements.name.focus(); };
          form.onsubmit = event => {
            event.preventDefault();
            const previous = state.tags.find(t=>t.id===editing)?.name;
            void mutate(account, () => write('/api/mail/tags',{...post({id:editing,name:form.elements.name.value,color:form.elements.color.value}),accountId:account}), async result => {
              if(previous) currentFilter.mailTags=selected().map(name=>name===previous?result.name:name);
              renderPanel('tags'); await refreshMailbox(account);
              dialog.querySelector('.mail-tags-message').textContent=mailaiText("标签已保存");
            });
          };
          for (const button of panel.querySelectorAll('[data-delete-tag]')) button.onclick = () => {
            if(dirty){requestDiscard(()=>button.click());return;}
            const tag=state.tags.find(t=>t.id===Number(button.dataset.deleteTag));
            const affected=state.rules.filter(rule=>rule.tag_ids.includes(tag.id)).length;
            confirmInline(button, mailaiTemplate`删除“${tag.name}”？将移除邮件上的此标签${affected ? mailaiText("，并更新相关自动规则") : ''}。邮件会保留。`, () => void mutate(account, () => write(`/api/mail/tags/${tag.id}`,{method:'DELETE',accountId:account}), async () => {
              currentFilter.mailTags=selected().filter(name=>name!==tag.name); renderPanel('tags'); await refreshMailbox(account);
              dialog.querySelector('.mail-tags-message').textContent=mailaiText("标签已删除");
            }));
          };
        } else {
          panel.innerHTML = `<p class="mail-tags-hint"><span data-i18n="mailTags.169762cededd">${mailaiText("新收取的邮件会自动匹配已启用规则，命中后追加标签。匹配不区分大小写。")}</span></p><div class="mail-tags-list">${state.rules.map(rule => `<article><div><b data-user-content>${esc(rule.name)}</b><small>${rule.enabled?mailaiText("已启用"):mailaiText("已停用")} · ${rule.match_mode==='all'?mailaiText("满足全部"):mailaiText("满足任意")} ${rule.conditions.length}<span data-i18n="mailTags.79ab0dbf4e8b">${mailaiText(" 条条件 → ")}</span>${esc(rule.tag_ids.map(id=>state.tags.find(t=>t.id===id)?.name).filter(Boolean).join(currentI18nLanguage()==='en'?', ':'、'))}</small></div><button type="button" data-toggle-rule="${rule.id}">${rule.enabled?mailaiText("停用"):mailaiText("启用")}</button><button type="button" data-edit-rule="${rule.id}"><span data-i18n="mailTags.051836569928">${mailaiText("编辑")}</span></button><button type="button" data-delete-rule="${rule.id}"><span data-i18n="ui.2f9daa828907">${mailaiText("删除")}</span></button></article>`).join('') || `<p class="mail-tags-empty"><span data-i18n="mailTags.b65704e74505">${mailaiText("按发件人、主题或正文关键词，自动整理收件。")}</span></p>`}</div><div class="mail-tags-rule-actions"><button type="button" class="primary-action" data-new-rule ${!state.tags.length?'disabled':''}><span data-i18n="mailTags.af89131d3056">${mailaiText("新建规则")}</span></button><button type="button" data-apply-rules ${!state.rules.some(r=>r.enabled)?'disabled':''}><span data-i18n="mailTags.2f98c3668c3f">${mailaiText("应用到已有邮件")}</span></button></div><div data-rule-editor></div>${!state.tags.length?`<p class="mail-tags-hint"><span data-i18n="mailTags.11a370a1d7dc">${mailaiText("请先在“标签管理”中创建标签。")}</span></p>`:''}`;
          panel.querySelector('[data-new-rule]').onclick = () => editRule();
          for(const button of panel.querySelectorAll('[data-edit-rule]')) button.onclick=()=>editRule(state.rules.find(r=>r.id===Number(button.dataset.editRule)));
          for(const button of panel.querySelectorAll('[data-toggle-rule]')) button.onclick=()=>{ const rule=state.rules.find(r=>r.id===Number(button.dataset.toggleRule)); void mutate(account,()=>write('/api/mail/tag-rules',{...post({...rule,enabled:!rule.enabled}),accountId:account}),()=>{renderPanel('rules');dialog.querySelector('.mail-tags-message').textContent=mailaiText("规则已更新");}); };
          for(const button of panel.querySelectorAll('[data-delete-rule]')) button.onclick=()=>confirmInline(button,mailaiText("删除此规则？已添加到邮件的标签会保留。"),()=>void mutate(account,()=>write(`/api/mail/tag-rules/${button.dataset.deleteRule}`,{method:'DELETE',accountId:account}),()=>{renderPanel('rules');dialog.querySelector('.mail-tags-message').textContent=mailaiText("规则已删除");}));
          panel.querySelector('[data-apply-rules]').onclick=()=>void mutate(account,()=>write('/api/mail/tag-rules/apply',{method:'POST',accountId:account}),async result=>{await refreshMailbox(account);renderPanel('rules');dialog.querySelector('.mail-tags-message').textContent=mailaiTemplate`已为 ${result.count} 封邮件添加标签`;});
          function editRule(rule) {
            if(dirty){requestDiscard(()=>editRule(rule));return;}
            dirty=false;
            const host=panel.querySelector('[data-rule-editor]');
            panel.querySelector('.mail-tags-list').hidden=true;
            panel.querySelector('.mail-tags-rule-actions').hidden=true;
            host.innerHTML=`<form data-rule-form><h3>${rule?mailaiText("编辑规则"):mailaiText("新建自动规则")}</h3><label class="mail-tags-field"><span data-i18n="mailTags.18dba51b47c8">${mailaiText("规则名称")}</span><input name="name" required maxlength="80" value="${esc(rule?.name||'')}" placeholder="${mailaiText("例如：客户合同自动归档")}" data-i18n-placeholder="mailTags.a4873c83cfc1"></label><label class="mail-tags-field"><span data-i18n="mailTags.cbdfb8401c2e">${mailaiText("匹配条件")}</span><select name="match_mode"><option value="all" ${rule?.match_mode!=='any'?'selected':''} data-i18n="mailTags.13c7fe62a93c">${mailaiText("满足全部条件")}</option><option value="any" ${rule?.match_mode==='any'?'selected':''} data-i18n="mailTags.c81426ef298c">${mailaiText("满足任意条件")}</option></select></label><div data-conditions>${(rule?.conditions||[undefined]).map(conditionRow).join('')}</div><button type="button" data-add-condition><span data-i18n="mailTags.ec4e73603d7f">${mailaiText("＋ 添加条件")}</span></button><fieldset><legend><span data-i18n="mailTags.c51c6e6657db">${mailaiText("自动添加标签（可多选）")}</span></legend><div class="mail-tag-choices">${checks(state.tags,rule?.tag_ids)}</div></fieldset><label class="mail-tag-choice"><input name="enabled" type="checkbox" ${rule?.enabled!==false?'checked':''}><span data-i18n="mailTags.d23ee5171cce">${mailaiText("启用规则")}</span></label><div class="mail-rule-preview" data-rule-preview role="status" aria-live="polite"></div><footer><button type="button" data-preview-rule><span data-i18n="mailTags.608ea5151e98">${mailaiText('测试匹配')}</span></button><button type="button" data-cancel-rule><span data-i18n="ui.2cd0f3be8738">${mailaiText("取消")}</span></button><button type="submit" class="primary-action"><span data-i18n="mailTags.b5aa919e9a97">${mailaiText("保存规则")}</span></button></footer></form>`;
            host.querySelector('[data-cancel-rule]').onclick=()=>requestDiscard(()=>{host.replaceChildren();panel.querySelector('.mail-tags-list').hidden=false;panel.querySelector('.mail-tags-rule-actions').hidden=false;});
            const syncConditions=()=>{
              const rows=[...host.querySelectorAll('.mail-tag-condition')];
              for(const row of rows)row.querySelector('[data-remove-condition]').disabled=rows.length===1;
              host.querySelector('[data-add-condition]').disabled=rows.length>=20;
            };
            host.querySelector('[data-add-condition]').onclick=()=>{if(host.querySelectorAll('.mail-tag-condition').length<20){host.querySelector('[data-conditions]').insertAdjacentHTML('beforeend',conditionRow());dirty=true;syncConditions();invalidatePreview();}};
            host.querySelector('[data-conditions]').onclick=event=>{const button=event.target.closest('[data-remove-condition]');if(button&&host.querySelectorAll('.mail-tag-condition').length>1){button.closest('.mail-tag-condition').remove();dirty=true;syncConditions();invalidatePreview();}};
            syncConditions();
            mailaiBindUI(host.querySelector('h3'),'textContent',()=>rule?mailaiText('编辑规则'):mailaiText('新建自动规则'));
            const form=host.querySelector('form');
            const conditions=()=>[...form.querySelectorAll('.mail-tag-condition')].map(row=>({field:row.querySelector('[data-field]').value,operator:row.querySelector('[data-operator]').value,value:row.querySelector('input').value}));
            let previewRevision=0;
            const invalidatePreview=()=>{++previewRevision;host.querySelector('[data-rule-preview]').replaceChildren();};
            host.addEventListener('input',invalidatePreview);host.addEventListener('change',invalidatePreview);
            host.querySelector('[data-preview-rule]').onclick=async event=>{
              const button=event.currentTarget, revision=++previewRevision, editorSession=session;
              if(conditions().some(condition=>!condition.value.trim()))return message(mailaiText('请先填写匹配内容'),true);
              button.disabled=true;
              const output=host.querySelector('[data-rule-preview]');output.textContent=mailaiText('正在测试匹配…');
              try{
                const result=await api('/api/mail/tag-rules/preview',{...post({conditions:conditions(),match_mode:form.elements.match_mode.value}),accountId:account});
                if(revision!==previewRevision||editorSession!==session||!form.isConnected||!isCurrent(account))return;
                output.innerHTML=`<b>${esc(mailaiTemplate`已有 ${result.count} 封邮件满足条件`)}</b><p><span data-i18n="mailTags.d9d70e607ad0">${mailaiText('仅预览匹配结果，不会修改邮件标签。')}</span></p>`+result.examples.map(item=>`<div data-user-content><span>${esc(item.subject||mailaiText('无主题'))}</span><small>${esc(item.from_addr||'')}</small></div>`).join('');
              }catch(error){if(revision===previewRevision&&editorSession===session&&form.isConnected)output.textContent=mailaiSystemMessage(error.message);}
              finally{if(button.isConnected)button.disabled=false;}
            };
            form.onsubmit=event=>{
              event.preventDefault(); const tagIds=chosen(form);
              if(!tagIds.length){dialog.querySelector('.mail-tags-message').textContent=mailaiText("请至少选择一个标签");return;}
              ++previewRevision;
              const payload={id:rule?.id||null,name:form.elements.name.value,enabled:form.elements.enabled.checked,match_mode:form.elements.match_mode.value,tag_ids:tagIds,conditions:[...form.querySelectorAll('.mail-tag-condition')].map(row=>({field:row.querySelector('[data-field]').value,operator:row.querySelector('[data-operator]').value,value:row.querySelector('input').value}))};
              void mutate(account,()=>write('/api/mail/tag-rules',{...post(payload),accountId:account}),()=>{renderPanel('rules');dialog.querySelector('.mail-tags-message').textContent=mailaiText("规则已保存，下次收件时自动生效");});
            };
            form.elements.name.focus();
          }
        }
      }
      function confirmInline(button,text,action) {
        const old=body.querySelector('.mail-tags-confirm');old?.remove();
        const confirm=document.createElement('div');confirm.className='mail-tags-confirm';
        confirm.innerHTML=`<p>${esc(text)}</p><button type="button" data-no><span data-i18n="ui.2cd0f3be8738">${mailaiText("取消")}</span></button><button type="button" data-yes><span data-i18n="mailTags.a3ea3c17b401">${mailaiText("确认删除")}</span></button>`;
        button.closest('article').after(confirm);confirm.querySelector('[data-no]').onclick=()=>confirm.remove();confirm.querySelector('[data-yes]').onclick=action;
        confirm.querySelector('[data-no]').focus();
      }
      body.querySelector('.mail-tags-tabs').addEventListener('keydown',event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();const tabs=[...body.querySelectorAll('[data-tab]')];
        const target=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(tabs.indexOf(document.activeElement)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];
        target.click();target.focus();
      });
      renderPanel(tab);
    } catch(error){toast(error.message,'error');}
  }
  document.addEventListener('mailai:language-changed',()=>{
    const host=dialog.querySelector('.mail-tags-message');
    if(host && host.textContent){const source=mailaiCopySource(host.textContent);message(mailaiSystemMessage(source),host.classList.contains('error'));}
    if(group.isConnected)window.mailaiRenderMailTags(state.rows);
  });
  group.querySelector('[data-mail-tag-manage]').onclick=()=>void manage();
  document.addEventListener('click',event=>{
    if(event.target.closest('[data-edit-mail-tags]'))void window.mailaiEditMailTags();
    if(event.target.closest('[data-bulk-mail-tags]'))void window.mailaiEditMailTags(true);
  });
})();
