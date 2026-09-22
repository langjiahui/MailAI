/* Shared task editor; all entry points edit the same account-bound todo row. */
(() => {
  document.body.insertAdjacentHTML('beforeend', `<dialog id="task-planner"><form><header><div><small>简报与待办共用一条任务</small><h3>安排任务</h3></div><button type="button" data-plan-close aria-label="关闭">×</button></header><p id="plan-source"></p><label id="plan-existing-label">此邮件已有任务<select id="plan-existing"></select></label><label>任务名称<input id="plan-title" required maxlength="500"></label><div class="plan-grid"><label>任务类型<select id="plan-kind"><option value="execution">执行事项</option><option value="decision">决策事项</option></select></label><label>任务阶段<select id="plan-stage"><option value="active">由我推进</option><option value="waiting">等待反馈</option></select></label></div><label><span id="plan-date-label">截止日期（可选）</span><input id="plan-deadline" type="date"></label><label>提醒时间（可选）<input id="plan-remind" type="datetime-local"></label><small>提醒属于这条任务；完成任务后停止提醒。MailAI 运行时才会提示。</small><p id="plan-error" role="status"></p><footer><button type="button" id="plan-reopen" hidden>恢复待办</button><button type="button" data-plan-close>取消</button><button id="plan-save" type="submit">保存安排</button></footer></form></dialog>`);
  const dialog = document.getElementById('task-planner');
  const get = id => document.getElementById('plan-'+id);
  let context=null, ticket=0;
  function localTime(value) {
    if (!value) return '';
    const date=new Date(value); if (!Number.isFinite(date.getTime())) return '';
    date.setMinutes(date.getMinutes()-date.getTimezoneOffset()); return date.toISOString().slice(0,16);
  }
  function paint(task) {
    context.task=task;
    get('title').value=task?.title || context.title || '';
    get('kind').value=task?.kind || context.kind || 'execution';
    get('stage').value=task?.stage || 'active';
    get('deadline').value=(task?.deadline || '').slice(0,10);
    context.originalReminder=localTime(task?.remind_at);
    get('remind').value=context.remind ? localTime(Date.now()+3600000) : context.originalReminder;
    get('reopen').hidden=task?.status!=='done';
    get('save').disabled=task?.status==='done';
    get('error').textContent=task?.status==='done' ? '这条任务已完成。需要继续跟进时，请先恢复。' : '';
    get('date-label').textContent=get('stage').value==='waiting' ? '跟进日期（可选）' : '截止日期（可选）';
  }
  window.openTaskPlanner = async ({emailId, todoId, title='', kind='execution', remind=false, accountId=activeMailAccount()?.id}={}) => {
    const currentTicket=++ticket;
    try {
      const rows=await api('/api/todos?include_done=true',{accountId});
      if (currentTicket!==ticket) return;
      let selected=rows.find(t=>t.id===Number(todoId));
      emailId=Number(emailId || selected?.email_id);
      const matches=rows.filter(t=>t.email_id===emailId);
      selected=selected || matches.find(t=>t.status!=='done') || matches[0];
      context={accountId,emailId,title,kind,remind,matches};
      get('existing-label').hidden=!matches.length;
      get('existing').innerHTML=matches.map(t=>`<option value="${t.id}">${esc(t.title)}${t.status==='done'?'（已完成）':''}</option>`).join('');
      if (selected) get('existing').value=selected.id;
      get('source').textContent=((_systemConfig?.accounts || []).find(a=>a.id===accountId)?.user || '') + ' · ' + (selected?.email_subject || title || '已关联来源邮件');
      paint(selected);dialog.showModal();get('title').focus();
    } catch(e) {toast('无法打开任务：'+e.message,'warn');}
  };
  window.mailaiTasksChanged = (accountId=activeMailAccount()?.id) => window.dispatchEvent(new CustomEvent('mailai-tasks-changed',{detail:{accountId}}));
  window.addEventListener('mailai-tasks-changed',async event=>{
    const accountId=event.detail.accountId;
    if(accountId===todoCenterAccountId && !document.getElementById('todo-center').classList.contains('hidden')) loadTodoCenter();
    if(accountId!==activeMailAccount()?.id)return;
    window.refreshSecretaryAccount?.();
    try {const rows=await api('/api/todos?include_done=true',{accountId});if(accountId!==activeMailAccount()?.id)return;allTodos=rows;updateSidebar();}catch(_){}
  });
  dialog.querySelectorAll('[data-plan-close]').forEach(b=>b.onclick=()=>dialog.close());
  get('stage').onchange=()=>{get('date-label').textContent=get('stage').value==='waiting'?'跟进日期（可选）':'截止日期（可选）';};
  get('existing').onchange=()=>paint(context.matches.find(t=>t.id===Number(get('existing').value)));
  get('reopen').onclick=async()=>{
    const c=context;get('reopen').disabled=true;
    try {await api(`/api/todos/${c.task.id}/reopen`,{accountId:c.accountId,method:'POST'});c.task.status='open';paint(c.task);window.mailaiTasksChanged(c.accountId);}catch(e){get('error').textContent=e.message;}finally{get('reopen').disabled=false;}
  };
  dialog.querySelector('form').onsubmit=async event=>{
    event.preventDefault();const c=context;if(!c)return;
    const payload={title:get('title').value.trim(),kind:get('kind').value,stage:get('stage').value,deadline:get('deadline').value};
    if(get('remind').value!==c.originalReminder)payload.remind_at=get('remind').value;
    get('save').disabled=true;get('save').textContent='保存中…';get('error').textContent='';
    try {
      await api(c.task?`/api/todos/${c.task.id}`:`/api/emails/${c.emailId}/todo`,{accountId:c.accountId,method:c.task?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(context===c)dialog.close();window.mailaiTasksChanged(c.accountId);toast('任务已保存，简报与待办已同步','success');
    }catch(e){if(context===c)get('error').textContent=e.message;}finally{if(context===c){get('save').disabled=false;get('save').textContent='保存安排';}}
  };
})();
