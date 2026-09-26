/* Shared task editor; all entry points edit the same account-bound todo row. */
(() => {
  document.body.insertAdjacentHTML('beforeend', `<dialog id="task-planner"><form><header><div><small>简报与待办共用一条任务</small><h3>安排任务</h3></div><button type="button" data-plan-close aria-label="关闭">×</button></header><p id="plan-source"></p><label id="plan-existing-label">此邮件已有任务<select id="plan-existing"></select></label><label>任务名称<input id="plan-title" required maxlength="500"></label><div class="plan-grid"><label>任务类型<select id="plan-kind"><option value="execution">执行事项</option><option value="decision">决策事项</option></select></label><label>任务阶段<select id="plan-stage"><option value="active">由我推进</option><option value="waiting">等待反馈</option></select></label></div><label><span id="plan-date-label">截止日期（可选）</span><input id="plan-deadline" type="date"></label><label>提醒时间（可选）<input id="plan-remind" type="datetime-local"></label><div class="plan-reminder-shortcuts"><button type="button" data-plan-time="later">10 分钟后</button><button type="button" data-plan-time="tomorrow">明天 9 点</button><button type="button" data-plan-time="deadline">截止日 9 点</button><button type="button" data-plan-time="clear">不提醒</button></div><small>截止日期用于标记逾期；只有设置提醒时间，才会发送提醒。</small><small>提醒属于这条任务；完成任务后停止提醒。桌面版在后台运行时也会发系统通知（需允许通知）；完全退出后，下次启动补提醒。浏览器版的提示方式取决于运行平台。</small><p id="plan-error" role="status"></p><footer><button type="button" id="plan-reopen" hidden>恢复待办</button><button type="button" data-plan-close>取消</button><button id="plan-save" type="submit">保存安排</button></footer></form></dialog>`);
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
  dialog.querySelectorAll('[data-plan-time]').forEach(button=>button.onclick=()=>{
    const action=button.dataset.planTime;get('error').textContent='';
    if(action==='clear'){get('remind').value='';return;}
    const date=new Date();
    if(action==='later')date.setMinutes(date.getMinutes()+10);
    else if(action==='tomorrow'){date.setDate(date.getDate()+1);date.setHours(9,0,0,0);}
    else {
      if(!get('deadline').value){get('error').textContent='请先选择截止或跟进日期';return;}
      const chosen=new Date(get('deadline').value+'T09:00:00');date.setTime(chosen.getTime());
    }
    if(date.getTime()<=Date.now()){get('error').textContent='该时间已经过去，请选择将来的提醒时间';return;}
    get('remind').value=localTime(date);
  });
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
    const reminderChanged=Object.hasOwn(payload,'remind_at');
    const reminderValue=get('remind').value;
    get('save').disabled=true;get('save').textContent='保存中…';get('error').textContent='';
    try {
      await api(c.task?`/api/todos/${c.task.id}`:`/api/emails/${c.emailId}/todo`,{accountId:c.accountId,method:c.task?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(context===c)dialog.close();window.mailaiTasksChanged(c.accountId);toast(reminderChanged ? (reminderValue ? `已设置提醒：${reminderValue.replace('T',' ')}；请保持 MailAI 运行` : '已取消提醒，任务仍保留') : '任务已保存，提醒时间未改变','success');
    }catch(e){if(context===c)get('error').textContent=e.message;}finally{if(context===c){get('save').disabled=false;get('save').textContent='保存安排';}}
  };
})();
