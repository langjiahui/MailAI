/* Department directory imports and extended profiles stay local to their mailbox. */
(() => {
  const fields = {get employee_id() { return mailaiText('工号'); },get department() { return mailaiText('部门'); },get admin_group() { return mailaiText('行政组'); },get gender() { return mailaiText('性别'); },get mobile() { return mailaiText('手机号'); },get work_phone() { return mailaiText('工作电话'); },get title() { return mailaiText('职务'); },get address() { return mailaiText('办公地点'); },get directory_note1() { return mailaiText('部门备注1'); },get directory_note2() { return mailaiText('部门备注2'); },get directory_tags() { return mailaiText('名单标签'); }};
  const post = data => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  let modal, revision=0, focusReturn, deptAccount='';
  const inputFields = (profile={}, prefix='directory') => Object.entries(fields).map(([key,label])=>{
    const multiline=key.includes('note') || key==='address';
    const type=['mobile','work_phone'].includes(key) ? 'tel' : 'text';
    return `<label class="${multiline ? 'directory-field-wide' : ''}"><span>${mailaiLabelHTML(label)}</span>${multiline ? `<textarea id="${prefix}-${key}" rows="${key==='address' ? 2 : 3}" maxlength="1000">${esc(profile[key] || '')}</textarea>` : `<input id="${prefix}-${key}" type="${type}" value="${esc(profile[key] || '')}" maxlength="120" autocomplete="off">`}</label>`;
  }).join('');
  const customFields = (profile={}, prefix='directory') => Object.entries(profile.custom_fields || {}).map(([key,value])=>{
    const multiline=/备注|说明|描述/.test(key) || String(value).length>90 || /[\n\r]/.test(value);
    return `<label class="${multiline ? 'directory-field-wide' : ''}"><span>${esc(key)}</span>${multiline ? `<textarea data-${prefix}-custom="${esc(key)}" rows="3" maxlength="1000">${esc(value)}</textarea>` : `<input data-${prefix}-custom="${esc(key)}" value="${esc(value)}" maxlength="1000">`}</label>`;
  }).join('');
  const readFields = (host,prefix='directory') => ({...Object.fromEntries(Object.keys(fields).map(key=>[key,host.querySelector('#'+prefix+'-'+key)?.value || ''])),custom_fields:Object.fromEntries([...host.querySelectorAll('[data-'+prefix+'-custom]')].map(node=>[node.getAttribute('data-'+prefix+'-custom'),node.value]))});
  const extra = document.createElement('details');
  extra.className='directory-editor-details';
  extra.innerHTML="<summary><span data-i18n=\"ui.7523035d2123\">详细资料</span> <small><span data-i18n=\"ui.83fa0675d237\">部门、工号、电话等，仅在这里展开显示</span></small></summary><div class=\"directory-profile-fields\" data-profile-fields></div>";
  document.querySelector('.contact-editor-fields').append(extra);
  window.mailaiDirectoryEdit = item => {
    extra.open=false;
    extra.querySelector('[data-profile-fields]').innerHTML=(item?.directory_source ? `<p class="directory-editor-source"><span data-i18n="ui.ae6ab8b1429f">最近导入来源：${esc(item.directory_source)}</span></p>` : '')+inputFields(item?.profile)+customFields(item?.profile);
    extra.dataset.revision=item?.directory_revision || '';
  };
  window.mailaiDirectoryFields = () => readFields(extra);
  window.mailaiDirectoryEditRevision = () => extra.dataset.revision || null;
  window.mailaiDirectoryContactLabel = item => {
    const profile=item.profile || {};
    const tags=String(profile.directory_tags || '').split(/[、,，;]/).filter(Boolean).slice(0,3);
    return profile.department || tags.length ? `<div class="directory-contact-label">${profile.department ? `<span>${esc(profile.department)}</span>` : ''}${tags.map(tag=>`<em>${esc(tag)}</em>`).join('')}</div>` : '';
  };
  const tools=document.createElement('div');tools.className='directory-toolbar';
  tools.innerHTML="<label><span><span data-i18n=\"ui.f128cdf1dae2\">部门</span></span><select id=\"directory-department-filter\" aria-label=\"按部门筛选\" data-i18n-aria=\"ui.c69ac077be0d\"><option value=\"\" data-i18n=\"ui.3ddd922ab3fe\">全部部门</option></select></label><button type=\"button\" id=\"directory-pending-button\" hidden><span data-i18n=\"ui.c6c0fe393ee1\">待补充资料</span></button>";
  document.querySelector('.contact-group-toolbar').after(tools);
  document.getElementById('directory-department-filter').onchange=()=>loadContactCenter();
  const importEntry=document.querySelector('.contact-center-tools .productivity-panel-entry');if(importEntry)mailaiBindUI(importEntry, "textContent", () => (mailaiText('导入 / 更新')));
  document.getElementById('directory-pending-button').onclick=()=>openPending(contactAccountId());
  window.mailaiDirectoryQuery = () => {
    const select=document.getElementById('directory-department-filter');
    if (deptAccount !== contactAccountId()) {select.value='';deptAccount=contactAccountId();}
    return '&department='+encodeURIComponent(select.value);
  };
  window.mailaiDirectoryRefresh = async () => {
    const account=contactAccountId(),session=contactCenterSession;
    try {
      const data=await api('/api/mail/contacts/directory/summary',{accountId:account});
      if (session !== contactCenterSession || account !== contactAccountId()) return;
      const select=document.getElementById('directory-department-filter'), value=select.value;
      select.innerHTML="<option value=\"\" data-i18n=\"ui.3ddd922ab3fe\">全部部门</option>"+data.departments.map(d=>`<option value="${esc(d.name)}">${esc(d.name)} (${d.count})</option>`).join('');
      select.value=value;deptAccount=account;
      const pending=document.getElementById('directory-pending-button');pending.hidden=!data.pending;mailaiBindUI(pending, "textContent", () => (mailaiText('待补充资料 · ')+data.pending));
    } catch (_) { /* The core address book remains usable if a summary is unavailable. */ }
  };
  document.getElementById('contact-center-list').addEventListener('click',event=>{if (event.target.closest('[data-directory-more]')) loadContactCenter(true);});
  function open(account,title,body) {
    if (!modal) {
      modal=document.createElement('dialog');modal.className='directory-dialog';modal.id='contact-directory-dialog';modal.setAttribute('aria-labelledby','directory-dialog-title');document.body.append(modal);
      modal.addEventListener('close',()=>{if(modal.open)return;++revision;modal.removeAttribute('aria-busy');focusReturn?.isConnected && focusReturn.focus({preventScroll:true});});
      modal.addEventListener('cancel',event=>{if(modal.getAttribute('aria-busy')==='true') event.preventDefault();});
    }
    if (!modal.open) focusReturn=document.activeElement;
    const rev=++revision;
    const owner=_systemConfig?.accounts?.find(row=>row.id===account)?.user || mailaiText('当前邮箱');
    modal.removeAttribute('aria-busy');
    modal.innerHTML=`<header><div><h2 id="directory-dialog-title">${mailaiLabelHTML(title)}</h2><p>${esc(owner)}</p></div><button type="button" data-directory-close aria-label="关闭${esc(title)}" data-i18n-aria="ui.e79b0795daff">×</button></header><div class="directory-dialog-body">${body}<p data-directory-message role="status" aria-live="polite"></p></div>`;
    const footer=modal.querySelector('.directory-dialog-body>footer');if(footer)modal.append(footer);
    modal.querySelector('[data-directory-close]').onclick=()=>modal.close();
    if (!modal.open) modal.showModal();
    const first=modal.querySelector('input:not([type=checkbox]),textarea') || modal.querySelector('select') || modal.querySelector('.primary-action') || modal.querySelector('[data-directory-close]');
    first?.focus({preventScroll:true});
    return rev;
  }
  const live = rev => modal?.open && revision===rev;
  function message(value,error=false) {const node=modal?.querySelector('[data-directory-message]');if(node){node.textContent=value;node.className=error?'directory-error':'directory-hint';}}
  async function busy(node, rev, action, mutation=false) {
    if (node.disabled) return;
    const frozen=[...modal.querySelectorAll('input,textarea,select,button:not([data-directory-close])')].map(control=>[control,control.disabled]);
    for(const [control] of frozen)control.disabled=true;
    const previousLabel=node.textContent;
    node.disabled=true;node.setAttribute('aria-busy','true');
    mailaiBindUI(node, "textContent", () => (node.matches('[data-directory-next]') ? mailaiText('正在读取…') : node.matches('[data-preview]') ? mailaiText('生成预览…') : node.matches('[data-apply-import],[data-resolve-pending]') ? mailaiText('正在保存…') : mailaiText('处理中…')));
    if (mutation) {modal.setAttribute('aria-busy','true');modal.querySelector('[data-directory-close]').disabled=true;}
    try {await action();} catch(error) {if(live(rev)) message(error.message,true);}
    finally {for(const [control,disabled] of frozen)if(control.isConnected)control.disabled=disabled;if(node.isConnected){node.textContent=previousLabel;node.removeAttribute('aria-busy');}if(live(rev)){modal.removeAttribute('aria-busy');modal.querySelector('[data-directory-close]').disabled=false;}}
  }
  window.mailaiDirectoryImport = (account, basic) => {
    let source, selected=[], policy='fill', mapping={};
    function selectFile() {
      const rev=open(account,mailaiText('导入部门通讯录'), `<ol class="directory-steps"><li class="active"><span data-i18n="ui.822fb37dba29">选择文件</span></li><li><span data-i18n="ui.09c5f2cbb3ae">选择名单</span></li><li><span data-i18n="ui.2be4c3810371">核对变更</span></li><li><span data-i18n="ui.c0b3fbff51cc">完成</span></li></ol><h3><span data-i18n="ui.0a5cb933d4e9">导入部门发布的通讯录，或更新已有资料</span></h3><p class="directory-hint"><span data-i18n="ui.9a511ccb0c3c">支持 Excel .xlsx 和 CSV。自动识别姓名、邮箱、部门、工号和电话等字段；导入前会显示新增、变化及冲突。</span></p><label class="directory-file"><input type="file" data-directory-file accept=".xlsx,.csv"><strong><span data-i18n="ui.8016b845abb9">选择通讯录文件</span></strong><span><span data-i18n="ui.6d04cc374431">可点击选择 · 最大 5 MB</span></span></label><div class="directory-import-options"><p><span data-i18n="ui.66cb68ee6bb6">导入和更新只影响当前邮箱的通讯录。没有有效邮箱的记录直接忽略，不会按工号匹配或补配邮箱。</span></p><p><span data-i18n="ui.50f9104c34fa">默认以现有通讯录为准，仅补全空白资料。个人分组、常用标记和个人备注会保留；文件里的空白不会清除已有资料。</span></p></div><footer><span class="directory-secondary-links">${basic?"<button type=\"button\" data-basic-import><span data-i18n=\"ui.a52c68e8e14e\">基础 vCard 导入 / 导出</span></button>":''}<button type="button" data-full-export><span data-i18n="ui.84cdf254a103">导出完整资料 CSV</span></button><button type="button" data-import-history><span data-i18n="ui.2b9c5201742d">最近导入记录</span></button></span><button type="button" data-directory-next disabled><span data-i18n="ui.407dd16f938f">读取文件</span></button></footer>`);
      let file;
      const next=modal.querySelector('[data-directory-next]');
      modal.querySelector('[data-directory-file]').onchange=event=>{file=event.target.files[0];next.disabled=!file || file.size===0 || file.size>5*1024*1024;mailaiBindUI(modal.querySelector('.directory-file span'), "textContent", () => (file?.name || mailaiText('可点击选择 · 最大 5 MB')));message(file?.size===0?mailaiText('这个文件是空的，请重新选择'):file?.size>5*1024*1024?mailaiText('文件超过 5 MB，请拆分后导入'):'',file?.size===0 || file?.size>5*1024*1024);};
      next.onclick=()=>busy(next,rev,async()=>{
        if (!file) throw Error(mailaiText('请先选择文件'));message(mailaiText('正在识别工作表和人员字段…'));
        const data=await api('/api/mail/contacts/directory/file?filename='+encodeURIComponent(file.name),{accountId:account,method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
        if (!live(rev))return;source=data;selected=data.sheets.filter(s=>s.selected).map(s=>s.name);mapping={};selectSheets();
      });
      modal.querySelector('[data-basic-import]')?.addEventListener('click',()=>{modal.close();basic();});
      modal.querySelector('[data-full-export]').onclick=event=>busy(event.currentTarget,rev,async()=>{
        const response=await fetch('/api/mail/contacts/directory/export',{headers:{'X-MailAI-Account':account},signal:AbortSignal.timeout(20000)});
        if(!response.ok)throw Error(mailaiText('导出失败，请稍后重试'));
        const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='contacts-full.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);if(live(rev))message(mailaiText('完整资料已导出到电脑'));
      });
      modal.querySelector('[data-import-history]').onclick=event=>busy(event.currentTarget,rev,async()=>{
        const data=await api('/api/mail/contacts/directory/summary',{accountId:account});if(!live(rev))return;
        const history=modal.querySelector('.directory-history') || document.createElement('section');history.className='directory-history';history.innerHTML="<h3><span data-i18n=\"ui.2b9c5201742d\">最近导入记录</span></h3>"+(data.recent.map(r=>`<p><strong>${esc(r.filename)}</strong><small><span data-i18n="ui.d8ccebd4148a">${esc(new Date(r.created_at).toLocaleString(currentI18nLanguage()))} · 新增 ${r.result.new} · 更新 ${r.result.update} · 待补充 ${r.result.pending}</span></small></p>`).join('')||"<p><span data-i18n=\"ui.b76eb4ef538c\">还没有导入记录。</span></p>");modal.querySelector('.directory-dialog-body').append(history);
      });
    }
    function selectSheets() {
      const rev=open(account,mailaiText('选择通讯录名单'), `<ol class="directory-steps"><li><span data-i18n="ui.822fb37dba29">选择文件</span></li><li class="active"><span data-i18n="ui.09c5f2cbb3ae">选择名单</span></li><li><span data-i18n="ui.2be4c3810371">核对变更</span></li><li><span data-i18n="ui.c0b3fbff51cc">完成</span></li></ol><p class="directory-source-name"><span data-i18n="ui.bc4fe5981109">${esc(source.filename)} · ${esc(source.sheets.length)} 张工作表 · 默认选择带邮箱的名单汇总表</span></p><div class="directory-sheets">${source.sheets.map((s,index)=>`<section class="directory-sheet"><label><input type="checkbox" data-sheet-index="${index}" ${selected.includes(s.name)?'checked':''}><span><strong>${esc(s.name)}</strong><small><span data-i18n="ui.a2f69862cf5f">${s.count} 条人员记录 · ${s.email_count} 条有有效邮箱${s.hidden?mailaiText(' · 隐藏工作表'):''}</span></small></span></label><details data-sheet-config="${index}"><summary><span data-i18n="ui.f14ac68f738f">字段识别与调整</span></summary><p class="directory-hint"><span data-i18n="ui.4573c5d0f2fe">默认自动识别重复表头和并排名单。手动映射仅读取所指定的一组列。</span></p><label class="directory-check"><input type="checkbox" data-manual-map><span data-i18n="ui.3e0901c735a9">手动指定表头与字段</span></label><label><span data-i18n="ui.8117ba3bb546">表头在第几行</span><input type="number" data-header-row min="1" max="200" value="${s.header_row}"></label><div class="directory-mapping">${Object.entries(source.fields).map(([key,label])=>`<label>${esc(label)}<select data-map-field="${key}"><option value="" data-i18n="ui.5a2b3a1384e0">不读取</option>${s.columns.map(col=>`<option value="${col.column}" ${Number(s.mapping[key])===col.column?'selected':''}>${col.letter} · ${esc(col.label)}</option>`).join('')}</select></label>`).join('')}</div></details>${s.formula_count?`<p class="directory-hint"><span data-i18n="ui.8a3ef4343672">含 ${s.formula_count} 个公式单元格，公式不会被执行或作为联系人资料导入。</span></p>`:''}</section>`).join('')}</div><label class="directory-policy"><span data-i18n="ui.5f602d570dbd">如何处理已有资料</span><select data-update-policy><option value="sync" data-i18n="ui.4244963a4b53">使用新版名单更新，保留手工修改</option><option value="fill" data-i18n="ui.20e282fce1f7">以现有通讯录为准，仅补全空白资料</option><option value="replace" data-i18n="ui.4064e09a8a7b">以文件中的非空资料覆盖</option></select></label><p class="directory-hint"><span data-i18n="ui.3fdfa43ae2f3">再次导入时，会识别上次导入的资料。文件中没有的联系人不会被删除；未选择的工作表不会参与更新。</span></p><footer><button type="button" data-choose-again><span data-i18n="ui.86fd102861e5">重新选文件</span></button><button type="button" data-preview class="primary-action"><span data-i18n="ui.5c250cfb4127">预览变更</span></button></footer>`);
      modal.querySelector('[data-update-policy]').value=policy;
      for(const [name,config] of Object.entries(mapping)){const index=source.sheets.findIndex(s=>s.name===name),box=modal.querySelector('[data-sheet-config="'+index+'"]');if(!box)continue;box.querySelector('[data-manual-map]').checked=true;box.querySelector('[data-header-row]').value=config.header_row;for(const [key,col] of Object.entries(config.fields))box.querySelector('[data-map-field="'+key+'"]').value=col;}
      modal.querySelector('[data-choose-again]').onclick=selectFile;
      for(const box of modal.querySelectorAll('[data-sheet-config]')) {
        const meta=source.sheets[Number(box.dataset.sheetConfig)];
        const refreshColumns=()=>{const header=meta.sample_rows[String(box.querySelector('[data-header-row]').value)] || {};for(const select of box.querySelectorAll('[data-map-field]')){const value=select.value;select.innerHTML="<option value=\"\" data-i18n=\"ui.5a2b3a1384e0\">不读取</option>"+Array.from({length:meta.column_count},(_,i)=>{let n=i+1,letters='';while(n){let rem=(n-1)%26;letters=String.fromCharCode(65+rem)+letters;n=Math.floor((n-1)/26);}return `<option value="${i+1}">${letters}${header[String(i+1)]?' · '+esc(header[String(i+1)]):''}</option>`;}).join('');select.value=value;}};
        box.querySelector('[data-header-row]').onchange=refreshColumns;refreshColumns();
      }
      modal.querySelector('[data-preview]').onclick=event=>busy(event.currentTarget,rev,async()=>{
        selected=[...modal.querySelectorAll('[data-sheet-index]:checked')].map(n=>source.sheets[Number(n.dataset.sheetIndex)].name);
        if(!selected.length)throw Error(mailaiText('请至少选择一张工作表'));policy=modal.querySelector('[data-update-policy]').value;mapping={};
        for(const box of modal.querySelectorAll('[data-sheet-config]'))if(box.querySelector('[data-manual-map]').checked){const name=source.sheets[Number(box.dataset.sheetConfig)].name;mapping[name]={header_row:Number(box.querySelector('[data-header-row]').value),fields:Object.fromEntries([...box.querySelectorAll('[data-map-field]')].map(n=>[n.dataset.mapField,n.value]))};}
        const result=await api('/api/mail/contacts/directory/preview',{accountId:account,...post({token:source.token,sheets:selected,policy,mapping})});if(live(rev))review(result);
      });
    }
    function review(plan) {
      const rev=open(account,mailaiText('核对通讯录变更'), `<ol class="directory-steps"><li><span data-i18n="ui.822fb37dba29">选择文件</span></li><li><span data-i18n="ui.09c5f2cbb3ae">选择名单</span></li><li class="active"><span data-i18n="ui.2be4c3810371">核对变更</span></li><li><span data-i18n="ui.c0b3fbff51cc">完成</span></li></ol><div class="directory-counts"><span><span data-i18n="ui.0006d696d8e1">新增</span> <b>${plan.counts.new}</b></span><span><span data-i18n="ui.3055a035f0eb">更新</span> <b>${plan.counts.update}</b></span><span><span data-i18n="ui.43d477cc5ddb">未变化</span> <b>${plan.counts.unchanged}</b></span><span><span data-i18n="ui.c77cc1a8a940">文件内冲突</span> <b>${plan.counts.conflict}</b></span><span><span data-i18n="ui.c11ac7c9fe80">忽略无有效邮箱</span> <b>${plan.counts.ignored || 0}</b></span></div><p class="directory-hint"><span data-i18n="ui.1ee4dfa53033">存在冲突的记录默认不勾选，未导入的冲突记录会保留到待补充资料中。可展开人员记录核对来源；勾选后按主表资料导入。</span></p><div class="directory-review-tools"><input type="search" data-review-query aria-label="搜索预览人员" placeholder="姓名、邮箱、部门或工号" data-i18n-placeholder="ui.8323b369dbb6" data-i18n-aria="ui.1359c2999cdc"><select data-review-filter aria-label="筛选预览人员" data-i18n-aria="ui.1e35da8c5a2d"><option value="all" data-i18n="ui.9cc0db794fb9">全部人员</option><option value="new" data-i18n="ui.a4ffcf603ebd">新增人员</option><option value="update" data-i18n="ui.dc1e53c1e420">资料有更新</option><option value="conflict" data-i18n="ui.c77cc1a8a940">文件内冲突</option><option value="protected" data-i18n="ui.c8de00967429">保留手工资料</option></select><button type="button" data-select-page><span data-i18n="ui.137fb1c9ccee">全选筛选结果</span></button><button type="button" data-clear-page><span data-i18n="ui.a3c974892464">清空选择</span></button><span data-selection-count></span></div><div data-review-rows></div><div class="directory-pager"><button type="button" data-prev-page><span data-i18n="ui.c9b9ae7a6144">上一页</span></button><span data-page-info></span><button type="button" data-next-page><span data-i18n="ui.8a8542f69648">下一页</span></button></div>${plan.counts.ignored?`<p class="directory-hint"><span data-i18n="ui.6631c9129667">已忽略 ${plan.counts.ignored} 条无有效邮箱的记录，不会加入通讯录或待核对列表。</span></p>`:''}<footer><button type="button" data-back-sheets><span data-i18n="ui.735b767e90d4">返回选择名单</span></button><button type="button" data-apply-import class="primary-action"><span data-i18n="ui.b9b867f84210">确认导入与更新</span></button></footer>`);
      const checked=new Set(plan.items.filter(r=>!r.conflicts.length&&!r.hidden).map(r=>r.email));let page=0,current=[],filtered=[];
      const selection=()=>{
        mailaiBindUI(modal.querySelector('[data-selection-count]'), "textContent", () => (mailaiText('已选择 ')+checked.size+mailaiText(' 人')));
        const pending=plan.pending.length+plan.items.filter(r=>r.conflicts.length&&!checked.has(r.email)).length;
        const apply=modal.querySelector('[data-apply-import]');
        mailaiBindUI(apply, "textContent", () => (checked.size ? mailaiText('确认导入 ')+checked.size+mailaiText(' 人') : pending ? mailaiText('保存 ')+pending+mailaiText(' 条待核对资料') : plan.counts.ignored ? mailaiText('完成（忽略无有效邮箱记录）') : mailaiText('请选择需要导入的人员')));
        apply.disabled=!checked.size&&!pending&&!plan.counts.ignored;
      };
      const fieldTable = row => {
        const changes=row.changes.map(c=>`<tr><td>${esc(c.label)}</td><td>${esc(c.before || '—')}</td><td>${esc(c.after)}</td></tr>`).join('');
        const protectedRows=row.protected.map(c=>`<tr><td>${esc(c.label)}</td><td>${esc(c.current || mailaiText('空白（已保留）'))}</td><td>${esc(c.incoming)}</td></tr>`).join('');
        return `<p class="directory-hint"><span data-i18n="ui.f99697041ec8">来源：${esc(row.source_sheet)} 第 ${row.source_row} 行${row.hidden?mailaiText(' · 此联系人已移除，本次不会自动恢复'):''}</span></p>${changes?`<table><thead><tr><th><span data-i18n="ui.49ecd0e342d6">字段</span></th><th><span data-i18n="ui.8fa09f19dde5">现有资料</span></th><th><span data-i18n="ui.d8bccbdea763">导入后</span></th></tr></thead><tbody>${changes}</tbody></table>`:"<p><span data-i18n=\"ui.0908d713cf23\">没有需要更新的字段。</span></p>"}${protectedRows?`<p class="directory-preserved"><span data-i18n="ui.d07458b15cc4">以下手工资料会保留</span></p><table><thead><tr><th><span data-i18n="ui.49ecd0e342d6">字段</span></th><th><span data-i18n="ui.b335de48500f">保留现有资料</span></th><th><span data-i18n="ui.f3a5198d8bc9">文件中的资料</span></th></tr></thead><tbody>${protectedRows}</tbody></table>`:''}${row.conflicts.map(c=>`<div class="directory-conflict"><strong><span data-i18n="ui.95e3e78be8dd">${esc(c.label)}在文件中不一致</span></strong><p><span data-i18n="ui.a31de3653d90">主表：${esc(c.primary)}</span></p><p>${esc(c.source_sheet)}${c.source_row ? mailaiText(' 第 ')+c.source_row+mailaiText(' 行') : ''}：${esc(c.other)}</p><p><span data-i18n="ui.eadb19fe965f">勾选此人后使用主表资料；也可先不勾选，导入后在待补充资料中核对。</span></p></div>`).join('')}`;
      };
      const render=()=>{
        const filter=modal.querySelector('[data-review-filter]').value;
        const query=modal.querySelector('[data-review-query]').value.trim().toLowerCase();
        const all=plan.items.filter(r=>(filter==='all'||filter==='conflict'&&r.conflicts.length||filter==='protected'&&r.protected.length||r.status===filter) && (!query || [r.name,r.email,r.department,r.employee_id].some(value=>String(value || '').toLowerCase().includes(query))));
        filtered=all;
        const pages=Math.max(1,Math.ceil(all.length/50));page=Math.min(page,pages-1);current=all.slice(page*50,(page+1)*50);
        modal.querySelector('[data-review-rows]').innerHTML=current.length?current.map(row=>`<details class="directory-review-row"><summary><input type="checkbox" data-import-email="${esc(row.email)}" aria-label="导入 ${esc(row.name)}" ${checked.has(row.email)?'checked':''} data-i18n-aria="ui.95abe29831f4"><span><strong>${esc(row.name || row.email)}</strong><small>${esc(row.email)}${row.department?' · '+esc(row.department):''}</small></span><em class="${row.conflicts.length?'conflict':''}">${row.conflicts.length?mailaiText('文件内冲突'):row.status==='new'?mailaiText('新增'):row.status==='update'?mailaiText('更新'):mailaiText('未变化')}${row.protected.length?mailaiText(' · 保留手工资料'):''}</em></summary><div class="directory-review-detail">${fieldTable(row)}</div></details>`).join(''):"<p class=\"directory-empty\"><span data-i18n=\"ui.ec57fbc98360\">没有匹配的记录。</span></p>";
        for(const n of modal.querySelectorAll('[data-import-email]'))n.onchange=()=>{if(n.checked)checked.add(n.dataset.importEmail);else checked.delete(n.dataset.importEmail);selection();};
        mailaiBindUI(modal.querySelector('[data-page-info]'), "textContent", () => ((page+1)+' / '+pages+mailaiText(' 页 · ')+all.length+mailaiText(' 人')));modal.querySelector('[data-prev-page]').disabled=page===0;modal.querySelector('[data-next-page]').disabled=page===pages-1;selection();
      };
      modal.querySelector('[data-review-query]').oninput=()=>{page=0;render();};modal.querySelector('[data-review-filter]').onchange=()=>{page=0;render();};modal.querySelector('[data-prev-page]').onclick=()=>{--page;render();};modal.querySelector('[data-next-page]').onclick=()=>{++page;render();};
      modal.querySelector('[data-select-page]').onclick=()=>{for(const row of filtered)if(!row.conflicts.length&&!row.hidden)checked.add(row.email);render();};modal.querySelector('[data-clear-page]').onclick=()=>{checked.clear();render();};
      modal.querySelector('[data-back-sheets]').onclick=selectSheets;
      modal.querySelector('[data-apply-import]').onclick=event=>busy(event.currentTarget,rev,async()=>{
        const result=await api('/api/mail/contacts/directory/apply',{accountId:account,...post({token:plan.token,emails:[...checked]})});
        if(!live(rev))return;finished(result);
        if(contactCenterSession && contactAccountId()===account)await loadContactCenter();
      },true);
      render();
    }
    function finished(result) {
      const rev=open(account,mailaiText('通讯录更新完成'), `<div class="directory-complete"><span aria-hidden="true">✓</span><h3><span data-i18n="ui.cafa270c9a9c">联系人资料已保存到当前邮箱</span></h3><p><span data-i18n="ui.51f75375b615">新增 ${result.new} 人 · 更新 ${result.update} 人 · 未变化 ${result.unchanged} 人</span></p><p><span data-i18n="ui.d99709577cee">未选择 ${result.skipped} 人 · 待核对 ${result.pending} 条 · 忽略无有效邮箱 ${result.ignored || 0} 条</span></p><small><span data-i18n="ui.8d98aaa6dcb8">导入没有发送邮件，也没有删除原有联系人。</span></small></div><footer>${result.pending?"<button type=\"button\" data-open-pending><span data-i18n=\"ui.f7a24217854a\">处理待补充资料</span></button>":''}<button type="button" data-import-finish class="primary-action"><span data-i18n="ui.70e9ccaa5a95">返回通讯录</span></button></footer>`);
      modal.querySelector('[data-import-finish]').onclick=()=>modal.close();modal.querySelector('[data-open-pending]')?.addEventListener('click',()=>openPending(account));
    }
    selectFile();
  };
  async function openPending(account) {
    const rev=open(account,mailaiText('待补充与核对资料'),"<p class=\"directory-hint\"><span data-i18n=\"ui.7a216341deaa\">这里只保留带有效邮箱、资料存在冲突的记录。无有效邮箱的记录直接忽略；默认以当前邮箱通讯录中的资料为准。</span></p><div data-pending-list><span data-i18n=\"ui.86b6d0d63062\">正在读取…</span></div>");
    const host=modal.querySelector('[data-pending-list]');
    const finish=window.mailaiMotion.pending(host);
    try {
      const rows=await api('/api/mail/contacts/directory/pending',{accountId:account});if(!live(rev))return;
      const host=modal.querySelector('[data-pending-list]');
      host.innerHTML=rows.length?rows.map((r,index)=>`<button type="button" class="directory-pending-row" data-pending-index="${index}"><span><strong>${esc(r.data.name || mailaiText('未填写姓名'))}</strong><small><span data-i18n="ui.f1866f0c7887">${esc(r.data.department || r.source_sheet)} · 工号 ${esc(r.data.employee_id || '—')}</span></small></span><em>${esc(r.reason)}</em></button>`).join(''):"<div class=\"directory-complete\"><h3><span data-i18n=\"ui.4be689db1456\">没有待补充资料</span></h3><p><span data-i18n=\"ui.8210d9d55c8b\">当前记录已处理。</span></p></div>";
      for(const node of host.querySelectorAll('[data-pending-index]'))node.onclick=()=>editPending(account,rows[Number(node.dataset.pendingIndex)]);
    } catch(error) {if(live(rev)){mailaiBindUI(host, "textContent", () => (mailaiText('读取未完成，请关闭后重试。')));message(error.message,true);}}
    finally {finish();}
  }
  function editPending(account,row) {
    const data=row.data;
    const rev=open(account,mailaiText('补充联系人资料'), `<p class="directory-hint"><span data-i18n="ui.c5f51ccb15ed">${esc(row.source_file)} · ${esc(row.source_sheet)} 第 ${row.row_number} 行</span></p><div class="directory-profile-fields"><label><span data-i18n="ui.50b5b1d2abef">姓名</span><input data-pending-name value="${esc(data.name || '')}" maxlength="80"></label><label><span data-i18n="ui.73075237fd0f">邮箱</span><input type="email" data-pending-email value="${esc(data.email || '')}" placeholder="name@example.com"></label><label><span data-i18n="ui.e06ff957ed48">公司</span><input data-pending-company value="${esc(data.company || '')}" maxlength="120"></label>${inputFields(data,'pending')}${customFields(data,'pending')}</div>${(data.conflicts || []).map(c=>`<p class="directory-conflict"><span data-i18n="ui.6b9fc0845f5d">${esc(c.label)}：主表 ${esc(c.primary)}；${esc(c.source_sheet)} 第 ${c.source_row} 行 ${esc(c.other)}。请核对后编辑上方资料。</span></p>`).join('')}<footer><button type="button" data-back-pending><span data-i18n="ui.db7305fe7ff2">返回待补充列表</span></button><button type="button" data-resolve-pending class="primary-action"><span data-i18n="ui.7c5137cb1c6c">保存并加入通讯录</span></button></footer>`);
    const review=document.createElement('section');review.className='directory-pending-merge';review.hidden=true;
    modal.querySelector('[data-directory-message]').before(review);
    const save=modal.querySelector('[data-resolve-pending]');
    const endpoint='/api/mail/contacts/directory/pending/'+encodeURIComponent(row.record_key);
    let checked=null;
    const reset=()=>{checked=null;review.hidden=true;mailaiBindUI(save, "textContent", () => (mailaiText('保存并加入通讯录')));message(mailaiText('资料已修改，保存前会重新核对。'));};
    modal.querySelector('.directory-profile-fields').addEventListener('input',reset);
    const renderDifferences=()=>{
      const replace=review.querySelector('[data-pending-policy]').value==='replace';
      review.querySelector('[data-pending-differences]').innerHTML=checked.differences.length ? `<table><caption><span data-i18n="ui.ec0d1d2c755f">本次填写与已有资料的差异</span></caption><thead><tr><th><span data-i18n="ui.49ecd0e342d6">字段</span></th><th><span data-i18n="ui.67a4dc0409dd">已有资料</span></th><th><span data-i18n="ui.c2505d0f8056">本次填写</span></th><th><span data-i18n="ui.1f05cd906732">保存后</span></th></tr></thead><tbody>${checked.differences.map(change=>`<tr><th scope="row">${esc(change.label)}</th><td>${esc(change.before || mailaiText('空白'))}</td><td>${esc(change.after)}</td><td>${replace || change.fills_blank ? mailaiText('更新为本次填写') : mailaiText('保留已有资料')}</td></tr>`).join('')}</tbody></table>` : "<p class=\"directory-hint\"><span data-i18n=\"ui.61f24133141c\">填写的非空资料与已有资料一致，确认后将标记此记录已处理。</span></p>";
    };
    modal.querySelector('[data-back-pending]').onclick=()=>openPending(account);
    save.onclick=async()=>{
      await busy(save,rev,async()=>{
        const email=modal.querySelector('[data-pending-email]').value.trim(),name=modal.querySelector('[data-pending-name]').value.trim();
        if(!name || !modal.querySelector('[data-pending-email]').validity.valid || !email)throw Error(mailaiText('请填写姓名和有效邮箱'));
        const payload={email,name,company:modal.querySelector('[data-pending-company]').value.trim(),profile:readFields(modal,'pending')};
        if(!checked){
          const result=await api(endpoint+'/preview',{accountId:account,...post(payload)});
          if(!live(rev))return;
          checked=result;
          if(result.existing){
            review.innerHTML=`<h3><span data-i18n="ui.fd7c14a8a64b">核对已有联系人</span></h3><p class="directory-hint"><span data-i18n="ui.867bdaba2c89">${esc(result.email)} 已在通讯录中。选择保存方式后，点击下方按钮确认。常用标记、分组和个人备注会保留；空白字段不会清除已有资料。${result.hidden?mailaiText(' 该联系人已被移除，本次更新不会恢复显示。'):''}</span></p><label class="directory-policy"><span data-i18n="ui.8b8df20098d7">保存方式</span><select data-pending-policy><option value="fill" data-i18n="ui.a0b5e917d025">仅补充空白字段</option><option value="replace" data-i18n="ui.c8293f2697d2">覆盖本次填写的非空字段</option></select></label><div data-pending-differences></div>`;
            review.hidden=false;renderDifferences();
            review.querySelector('[data-pending-policy]').onchange=renderDifferences;
            review.scrollIntoView({block:'nearest'});review.querySelector('select').focus({preventScroll:true});
            message(mailaiText('请核对差异，再确认保存。'));return;
          }
        }
        try {
          await api(endpoint,{accountId:account,...post({...payload,update_policy:checked.existing?review.querySelector('[data-pending-policy]').value:'create',expected_revision:checked.expected_revision})});
        } catch(error){checked=null;review.hidden=true;throw error;}
        if(!live(rev))return;
        await openPending(account);message(mailaiText('联系人资料已保存，此待补充记录已处理。'));
        if(contactCenterSession && contactAccountId()===account)await loadContactCenter();
      },true);
      if(live(rev))mailaiBindUI(save, "textContent", () => (checked?.existing?mailaiText('确认保存到已有联系人'):mailaiText('保存并加入通讯录')));
    };
  }
})();
