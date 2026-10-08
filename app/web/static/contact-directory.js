/* Department directory imports and extended profiles stay local to their mailbox. */
(() => {
  const fields = {employee_id:'工号',department:'部门',admin_group:'行政组',gender:'性别',mobile:'手机号',work_phone:'工作电话',title:'职务',address:'办公地点',directory_note1:'部门备注1',directory_note2:'部门备注2',directory_tags:'名单标签'};
  const post = data => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  let modal, revision=0, focusReturn, deptAccount='';
  const inputFields = (profile={}, prefix='directory') => Object.entries(fields).map(([key,label])=>{
    const multiline=key.includes('note') || key==='address';
    const type=['mobile','work_phone'].includes(key) ? 'tel' : 'text';
    return `<label class="${multiline ? 'directory-field-wide' : ''}"><span>${label}</span>${multiline ? `<textarea id="${prefix}-${key}" rows="${key==='address' ? 2 : 3}" maxlength="1000">${esc(profile[key] || '')}</textarea>` : `<input id="${prefix}-${key}" type="${type}" value="${esc(profile[key] || '')}" maxlength="120" autocomplete="off">`}</label>`;
  }).join('');
  const customFields = (profile={}, prefix='directory') => Object.entries(profile.custom_fields || {}).map(([key,value])=>{
    const multiline=/备注|说明|描述/.test(key) || String(value).length>90 || /[\n\r]/.test(value);
    return `<label class="${multiline ? 'directory-field-wide' : ''}"><span>${esc(key)}</span>${multiline ? `<textarea data-${prefix}-custom="${esc(key)}" rows="3" maxlength="1000">${esc(value)}</textarea>` : `<input data-${prefix}-custom="${esc(key)}" value="${esc(value)}" maxlength="1000">`}</label>`;
  }).join('');
  const readFields = (host,prefix='directory') => ({...Object.fromEntries(Object.keys(fields).map(key=>[key,host.querySelector('#'+prefix+'-'+key)?.value || ''])),custom_fields:Object.fromEntries([...host.querySelectorAll('[data-'+prefix+'-custom]')].map(node=>[node.getAttribute('data-'+prefix+'-custom'),node.value]))});
  const extra = document.createElement('details');
  extra.className='directory-editor-details';
  extra.innerHTML='<summary>详细资料 <small>部门、工号、电话等，仅在这里展开显示</small></summary><div class="directory-profile-fields" data-profile-fields></div>';
  document.querySelector('.contact-editor-fields').append(extra);
  window.mailaiDirectoryEdit = item => {
    extra.open=false;
    extra.querySelector('[data-profile-fields]').innerHTML=(item?.directory_source ? `<p class="directory-editor-source">最近导入来源：${esc(item.directory_source)}</p>` : '')+inputFields(item?.profile)+customFields(item?.profile);
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
  tools.innerHTML='<label><span>部门</span><select id="directory-department-filter" aria-label="按部门筛选"><option value="">全部部门</option></select></label><button type="button" id="directory-pending-button" hidden>待补充资料</button>';
  document.querySelector('.contact-group-toolbar').after(tools);
  document.getElementById('directory-department-filter').onchange=()=>loadContactCenter();
  const importEntry=document.querySelector('.contact-center-tools .productivity-panel-entry');if(importEntry)importEntry.textContent='导入 / 更新';
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
      select.innerHTML='<option value="">全部部门</option>'+data.departments.map(d=>`<option value="${esc(d.name)}">${esc(d.name)} (${d.count})</option>`).join('');
      select.value=value;deptAccount=account;
      const pending=document.getElementById('directory-pending-button');pending.hidden=!data.pending;pending.textContent='待补充资料 · '+data.pending;
    } catch (_) { /* The core address book remains usable if a summary is unavailable. */ }
  };
  document.getElementById('contact-center-list').addEventListener('click',event=>{if (event.target.closest('[data-directory-more]')) loadContactCenter(true);});
  function open(account,title,body) {
    if (!modal) {
      modal=document.createElement('dialog');modal.className='directory-dialog';modal.id='contact-directory-dialog';modal.setAttribute('aria-labelledby','directory-dialog-title');document.body.append(modal);
      modal.addEventListener('close',()=>{++revision;modal.removeAttribute('aria-busy');focusReturn?.isConnected && focusReturn.focus({preventScroll:true});});
      modal.addEventListener('cancel',event=>{if(modal.getAttribute('aria-busy')==='true') event.preventDefault();});
    }
    if (!modal.open) focusReturn=document.activeElement;
    const rev=++revision;
    const owner=_systemConfig?.accounts?.find(row=>row.id===account)?.user || '当前邮箱';
    modal.removeAttribute('aria-busy');
    modal.innerHTML=`<header><div><h2 id="directory-dialog-title">${esc(title)}</h2><p>${esc(owner)}</p></div><button type="button" data-directory-close aria-label="关闭${esc(title)}">×</button></header><div class="directory-dialog-body">${body}<p data-directory-message role="status" aria-live="polite"></p></div>`;
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
    const frozen=[...modal.querySelectorAll('input,select,button:not([data-directory-close])')].map(control=>[control,control.disabled]);
    for(const [control] of frozen)control.disabled=true;
    const previousLabel=node.textContent;
    node.disabled=true;node.setAttribute('aria-busy','true');
    node.textContent=node.matches('[data-directory-next]') ? '正在读取…' : node.matches('[data-preview]') ? '生成预览…' : node.matches('[data-apply-import],[data-resolve-pending]') ? '正在保存…' : '处理中…';
    if (mutation) {modal.setAttribute('aria-busy','true');modal.querySelector('[data-directory-close]').disabled=true;}
    try {await action();} catch(error) {if(live(rev)) message(error.message,true);}
    finally {for(const [control,disabled] of frozen)if(control.isConnected)control.disabled=disabled;if(node.isConnected){node.textContent=previousLabel;node.removeAttribute('aria-busy');}if(live(rev)){modal.removeAttribute('aria-busy');modal.querySelector('[data-directory-close]').disabled=false;}}
  }
  window.mailaiDirectoryImport = (account, basic) => {
    let source, selected=[], policy='sync', mapping={};
    function selectFile() {
      const rev=open(account,'导入部门通讯录', `<ol class="directory-steps"><li class="active">选择文件</li><li>选择名单</li><li>核对变更</li><li>完成</li></ol><h3>导入部门发布的通讯录，或更新已有资料</h3><p class="directory-hint">支持 Excel .xlsx 和 CSV。自动识别姓名、邮箱、部门、工号和电话等字段；导入前会显示新增、变化及冲突。</p><label class="directory-file"><input type="file" data-directory-file accept=".xlsx,.csv"><strong>选择通讯录文件</strong><span>可点击选择 · 最大 5 MB</span></label><div class="directory-import-options"><p>导入和更新只影响当前邮箱的通讯录。</p><p>个人分组、常用标记和个人备注会保留；文件里的空白不会清除已有资料。</p></div><footer><span class="directory-secondary-links">${basic?'<button type="button" data-basic-import>基础 vCard 导入 / 导出</button>':''}<button type="button" data-full-export>导出完整资料 CSV</button><button type="button" data-import-history>最近导入记录</button></span><button type="button" data-directory-next disabled>读取文件</button></footer>`);
      let file;
      const next=modal.querySelector('[data-directory-next]');
      modal.querySelector('[data-directory-file]').onchange=event=>{file=event.target.files[0];next.disabled=!file || file.size===0 || file.size>5*1024*1024;modal.querySelector('.directory-file span').textContent=file?.name || '可点击选择 · 最大 5 MB';message(file?.size===0?'这个文件是空的，请重新选择':file?.size>5*1024*1024?'文件超过 5 MB，请拆分后导入':'',file?.size===0 || file?.size>5*1024*1024);};
      next.onclick=()=>busy(next,rev,async()=>{
        if (!file) throw Error('请先选择文件');message('正在识别工作表和人员字段…');
        const data=await api('/api/mail/contacts/directory/file?filename='+encodeURIComponent(file.name),{accountId:account,method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
        if (!live(rev))return;source=data;selected=data.sheets.filter(s=>s.selected).map(s=>s.name);mapping={};selectSheets();
      });
      modal.querySelector('[data-basic-import]')?.addEventListener('click',()=>{modal.close();basic();});
      modal.querySelector('[data-full-export]').onclick=event=>busy(event.currentTarget,rev,async()=>{
        const response=await fetch('/api/mail/contacts/directory/export',{headers:{'X-MailAI-Account':account},signal:AbortSignal.timeout(20000)});
        if(!response.ok)throw Error('导出失败，请稍后重试');
        const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='contacts-full.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);if(live(rev))message('完整资料已导出到电脑');
      });
      modal.querySelector('[data-import-history]').onclick=event=>busy(event.currentTarget,rev,async()=>{
        const data=await api('/api/mail/contacts/directory/summary',{accountId:account});if(!live(rev))return;
        const history=modal.querySelector('.directory-history') || document.createElement('section');history.className='directory-history';history.innerHTML='<h3>最近导入记录</h3>'+(data.recent.map(r=>`<p><strong>${esc(r.filename)}</strong><small>${esc(new Date(r.created_at).toLocaleString())} · 新增 ${r.result.new} · 更新 ${r.result.update} · 待补充 ${r.result.pending}</small></p>`).join('')||'<p>还没有导入记录。</p>');modal.querySelector('.directory-dialog-body').append(history);
      });
    }
    function selectSheets() {
      const rev=open(account,'选择通讯录名单', `<ol class="directory-steps"><li>选择文件</li><li class="active">选择名单</li><li>核对变更</li><li>完成</li></ol><p class="directory-source-name">${esc(source.filename)} · ${esc(source.sheets.length)} 张工作表 · 默认选择带邮箱的名单汇总表</p><div class="directory-sheets">${source.sheets.map((s,index)=>`<section class="directory-sheet"><label><input type="checkbox" data-sheet-index="${index}" ${selected.includes(s.name)?'checked':''}><span><strong>${esc(s.name)}</strong><small>${s.count} 条人员记录 · ${s.email_count} 条有有效邮箱${s.hidden?' · 隐藏工作表':''}</small></span></label><details data-sheet-config="${index}"><summary>字段识别与调整</summary><p class="directory-hint">默认自动识别重复表头和并排名单。手动映射仅读取所指定的一组列。</p><label class="directory-check"><input type="checkbox" data-manual-map>手动指定表头与字段</label><label>表头在第几行<input type="number" data-header-row min="1" max="200" value="${s.header_row}"></label><div class="directory-mapping">${Object.entries(source.fields).map(([key,label])=>`<label>${esc(label)}<select data-map-field="${key}"><option value="">不读取</option>${s.columns.map(col=>`<option value="${col.column}" ${Number(s.mapping[key])===col.column?'selected':''}>${col.letter} · ${esc(col.label)}</option>`).join('')}</select></label>`).join('')}</div></details>${s.formula_count?`<p class="directory-hint">含 ${s.formula_count} 个公式单元格，公式不会被执行或作为联系人资料导入。</p>`:''}</section>`).join('')}</div><label class="directory-policy">如何处理已有资料<select data-update-policy><option value="sync">使用新版名单更新，保留手工修改</option><option value="fill">仅补全空白资料</option><option value="replace">以文件中的非空资料覆盖</option></select></label><p class="directory-hint">再次导入时，会识别上次导入的资料。文件中没有的联系人不会被删除；未选择的工作表不会参与更新。</p><footer><button type="button" data-choose-again>重新选文件</button><button type="button" data-preview class="primary-action">预览变更</button></footer>`);
      modal.querySelector('[data-update-policy]').value=policy;
      for(const [name,config] of Object.entries(mapping)){const index=source.sheets.findIndex(s=>s.name===name),box=modal.querySelector('[data-sheet-config="'+index+'"]');if(!box)continue;box.querySelector('[data-manual-map]').checked=true;box.querySelector('[data-header-row]').value=config.header_row;for(const [key,col] of Object.entries(config.fields))box.querySelector('[data-map-field="'+key+'"]').value=col;}
      modal.querySelector('[data-choose-again]').onclick=selectFile;
      for(const box of modal.querySelectorAll('[data-sheet-config]')) {
        const meta=source.sheets[Number(box.dataset.sheetConfig)];
        const refreshColumns=()=>{const header=meta.sample_rows[String(box.querySelector('[data-header-row]').value)] || {};for(const select of box.querySelectorAll('[data-map-field]')){const value=select.value;select.innerHTML='<option value="">不读取</option>'+Array.from({length:meta.column_count},(_,i)=>{let n=i+1,letters='';while(n){let rem=(n-1)%26;letters=String.fromCharCode(65+rem)+letters;n=Math.floor((n-1)/26);}return `<option value="${i+1}">${letters}${header[String(i+1)]?' · '+esc(header[String(i+1)]):''}</option>`;}).join('');select.value=value;}};
        box.querySelector('[data-header-row]').onchange=refreshColumns;refreshColumns();
      }
      modal.querySelector('[data-preview]').onclick=event=>busy(event.currentTarget,rev,async()=>{
        selected=[...modal.querySelectorAll('[data-sheet-index]:checked')].map(n=>source.sheets[Number(n.dataset.sheetIndex)].name);
        if(!selected.length)throw Error('请至少选择一张工作表');policy=modal.querySelector('[data-update-policy]').value;mapping={};
        for(const box of modal.querySelectorAll('[data-sheet-config]'))if(box.querySelector('[data-manual-map]').checked){const name=source.sheets[Number(box.dataset.sheetConfig)].name;mapping[name]={header_row:Number(box.querySelector('[data-header-row]').value),fields:Object.fromEntries([...box.querySelectorAll('[data-map-field]')].map(n=>[n.dataset.mapField,n.value]))};}
        const result=await api('/api/mail/contacts/directory/preview',{accountId:account,...post({token:source.token,sheets:selected,policy,mapping})});if(live(rev))review(result);
      });
    }
    function review(plan) {
      const rev=open(account,'核对通讯录变更', `<ol class="directory-steps"><li>选择文件</li><li>选择名单</li><li class="active">核对变更</li><li>完成</li></ol><div class="directory-counts"><span>新增 <b>${plan.counts.new}</b></span><span>更新 <b>${plan.counts.update}</b></span><span>未变化 <b>${plan.counts.unchanged}</b></span><span>文件内冲突 <b>${plan.counts.conflict}</b></span><span>待补充邮箱 <b>${plan.counts.pending}</b></span></div><p class="directory-hint">存在冲突的记录默认不勾选，未导入的冲突记录会保留到待补充资料中。可展开人员记录核对来源；勾选后按主表资料导入。</p><div class="directory-review-tools"><input type="search" data-review-query aria-label="搜索预览人员" placeholder="姓名、邮箱、部门或工号"><select data-review-filter aria-label="筛选预览人员"><option value="all">全部人员</option><option value="new">新增人员</option><option value="update">资料有更新</option><option value="conflict">文件内冲突</option><option value="protected">保留手工资料</option></select><button type="button" data-select-page>全选筛选结果</button><button type="button" data-clear-page>清空选择</button><span data-selection-count></span></div><div data-review-rows></div><div class="directory-pager"><button type="button" data-prev-page>上一页</button><span data-page-info></span><button type="button" data-next-page>下一页</button></div>${plan.pending.length?`<details class="directory-pending-preview"><summary>${plan.pending.length} 条记录需要补充或修正邮箱</summary><p class="directory-hint">这些资料会保存到“待补充资料”，补充有效邮箱后才加入可发信的通讯录。</p>${plan.pending.map(r=>`<p>${esc(r.name)} · ${esc(r.source_sheet)} 第 ${r.source_row} 行 · ${esc(r.reason)}</p>`).join('')}</details>`:''}<footer><button type="button" data-back-sheets>返回选择名单</button><button type="button" data-apply-import class="primary-action">确认导入与更新</button></footer>`);
      const checked=new Set(plan.items.filter(r=>!r.conflicts.length&&!r.hidden).map(r=>r.email));let page=0,current=[],filtered=[];
      const selection=()=>{
        modal.querySelector('[data-selection-count]').textContent='已选择 '+checked.size+' 人';
        const pending=plan.pending.length+plan.items.filter(r=>r.conflicts.length&&!checked.has(r.email)).length;
        const apply=modal.querySelector('[data-apply-import]');
        apply.textContent=checked.size ? '确认导入 '+checked.size+' 人' : pending ? '保存 '+pending+' 条待核对资料' : '请选择需要导入的人员';
        apply.disabled=!checked.size&&!pending;
      };
      const fieldTable = row => {
        const changes=row.changes.map(c=>`<tr><td>${esc(c.label)}</td><td>${esc(c.before || '—')}</td><td>${esc(c.after)}</td></tr>`).join('');
        const protectedRows=row.protected.map(c=>`<tr><td>${esc(c.label)}</td><td>${esc(c.current || '空白（已保留）')}</td><td>${esc(c.incoming)}</td></tr>`).join('');
        return `<p class="directory-hint">来源：${esc(row.source_sheet)} 第 ${row.source_row} 行${row.hidden?' · 此联系人已移除，本次不会自动恢复':''}</p>${changes?`<table><thead><tr><th>字段</th><th>现有资料</th><th>导入后</th></tr></thead><tbody>${changes}</tbody></table>`:'<p>没有需要更新的字段。</p>'}${protectedRows?`<p class="directory-preserved">以下手工资料会保留</p><table><thead><tr><th>字段</th><th>保留现有资料</th><th>文件中的资料</th></tr></thead><tbody>${protectedRows}</tbody></table>`:''}${row.conflicts.map(c=>`<div class="directory-conflict"><strong>${esc(c.label)}在文件中不一致</strong><p>主表：${esc(c.primary)}</p><p>${esc(c.source_sheet)}${c.source_row ? ' 第 '+c.source_row+' 行' : ''}：${esc(c.other)}</p><p>勾选此人后使用主表资料；也可先不勾选，导入后在待补充资料中核对。</p></div>`).join('')}`;
      };
      const render=()=>{
        const filter=modal.querySelector('[data-review-filter]').value;
        const query=modal.querySelector('[data-review-query]').value.trim().toLowerCase();
        const all=plan.items.filter(r=>(filter==='all'||filter==='conflict'&&r.conflicts.length||filter==='protected'&&r.protected.length||r.status===filter) && (!query || [r.name,r.email,r.department,r.employee_id].some(value=>String(value || '').toLowerCase().includes(query))));
        filtered=all;
        const pages=Math.max(1,Math.ceil(all.length/50));page=Math.min(page,pages-1);current=all.slice(page*50,(page+1)*50);
        modal.querySelector('[data-review-rows]').innerHTML=current.length?current.map(row=>`<details class="directory-review-row"><summary><input type="checkbox" data-import-email="${esc(row.email)}" aria-label="导入 ${esc(row.name)}" ${checked.has(row.email)?'checked':''}><span><strong>${esc(row.name || row.email)}</strong><small>${esc(row.email)}${row.department?' · '+esc(row.department):''}</small></span><em class="${row.conflicts.length?'conflict':''}">${row.conflicts.length?'文件内冲突':row.status==='new'?'新增':row.status==='update'?'更新':'未变化'}${row.protected.length?' · 保留手工资料':''}</em></summary><div class="directory-review-detail">${fieldTable(row)}</div></details>`).join(''):'<p class="directory-empty">没有匹配的记录。</p>';
        for(const n of modal.querySelectorAll('[data-import-email]'))n.onchange=()=>{if(n.checked)checked.add(n.dataset.importEmail);else checked.delete(n.dataset.importEmail);selection();};
        modal.querySelector('[data-page-info]').textContent=(page+1)+' / '+pages+' 页 · '+all.length+' 人';modal.querySelector('[data-prev-page]').disabled=page===0;modal.querySelector('[data-next-page]').disabled=page===pages-1;selection();
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
      const rev=open(account,'通讯录更新完成', `<div class="directory-complete"><span aria-hidden="true">✓</span><h3>联系人资料已保存到当前邮箱</h3><p>新增 ${result.new} 人 · 更新 ${result.update} 人 · 未变化 ${result.unchanged} 人</p><p>未选择 ${result.skipped} 人 · 待补充或核对 ${result.pending} 条</p><small>导入没有发送邮件，也没有删除原有联系人。</small></div><footer>${result.pending?'<button type="button" data-open-pending>处理待补充资料</button>':''}<button type="button" data-import-finish class="primary-action">返回通讯录</button></footer>`);
      modal.querySelector('[data-import-finish]').onclick=()=>modal.close();modal.querySelector('[data-open-pending]')?.addEventListener('click',()=>openPending(account));
    }
    selectFile();
  };
  async function openPending(account) {
    const rev=open(account,'待补充与核对资料','<p class="directory-hint">缺失或异常邮箱的人员资料会保留在这里。补充有效邮箱后，可以加入通讯录；这里的记录不能直接用作邮件收件人。</p><div data-pending-list>正在读取…</div>');
    const host=modal.querySelector('[data-pending-list]');
    const finish=window.mailaiMotion.pending(host);
    try {
      const rows=await api('/api/mail/contacts/directory/pending',{accountId:account});if(!live(rev))return;
      const host=modal.querySelector('[data-pending-list]');
      host.innerHTML=rows.length?rows.map((r,index)=>`<button type="button" class="directory-pending-row" data-pending-index="${index}"><span><strong>${esc(r.data.name || '未填写姓名')}</strong><small>${esc(r.data.department || r.source_sheet)} · 工号 ${esc(r.data.employee_id || '—')}</small></span><em>${esc(r.reason)}</em></button>`).join(''):'<div class="directory-complete"><h3>没有待补充资料</h3><p>当前记录已处理。</p></div>';
      for(const node of host.querySelectorAll('[data-pending-index]'))node.onclick=()=>editPending(account,rows[Number(node.dataset.pendingIndex)]);
    } catch(error) {if(live(rev)){host.textContent='读取未完成，请关闭后重试。';message(error.message,true);}}
    finally {finish();}
  }
  function editPending(account,row) {
    const data=row.data;
    const rev=open(account,'补充联系人资料', `<p class="directory-hint">${esc(row.source_file)} · ${esc(row.source_sheet)} 第 ${row.row_number} 行</p><div class="directory-profile-fields"><label>姓名<input data-pending-name value="${esc(data.name || '')}" maxlength="80"></label><label>邮箱<input type="email" data-pending-email value="${esc(data.email || '')}" placeholder="name@example.com"></label><label>公司<input data-pending-company value="${esc(data.company || '')}" maxlength="120"></label>${inputFields(data,'pending')}${customFields(data,'pending')}</div>${(data.conflicts || []).map(c=>`<p class="directory-conflict">${esc(c.label)}：主表 ${esc(c.primary)}；${esc(c.source_sheet)} 第 ${c.source_row} 行 ${esc(c.other)}。请核对后编辑上方资料。</p>`).join('')}<footer><button type="button" data-back-pending>返回待补充列表</button><button type="button" data-resolve-pending class="primary-action">保存并加入通讯录</button></footer>`);
    modal.querySelector('[data-back-pending]').onclick=()=>openPending(account);
    modal.querySelector('[data-resolve-pending]').onclick=event=>busy(event.currentTarget,rev,async()=>{
      const email=modal.querySelector('[data-pending-email]').value.trim(),name=modal.querySelector('[data-pending-name]').value.trim();
      if(!email || !name)throw Error('请填写姓名和有效邮箱');
      await api('/api/mail/contacts/directory/pending/'+encodeURIComponent(row.record_key),{accountId:account,...post({email,name,company:modal.querySelector('[data-pending-company]').value.trim(),profile:readFields(modal,'pending')})});
      if(!live(rev))return;await openPending(account);if(contactCenterSession && contactAccountId()===account)await loadContactCenter();
    },true);
  }
})();
