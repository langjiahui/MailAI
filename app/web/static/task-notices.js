/* A durable, cross-platform entry point for reminders, independent of toasts. */
(() => {
  document.querySelector('.todo-batch-actions').insertAdjacentHTML('afterbegin',"<button type=\"button\" id=\"btn-task-notices\"><span data-i18n=\"ui.8a96f3933000\">提醒记录</span></button>");
  document.querySelector('#todo-center .todo-center-card').insertAdjacentHTML('beforeend', `<dialog id="task-notices" aria-labelledby="task-notices-title"><header><div><small><span data-i18n="ui.8163e5cb3929">所有邮箱 · 每项任务最近一次提醒</span></small><h2 id="task-notices-title"><span data-i18n="ui.8a96f3933000">提醒记录</span></h2></div><button type="button" data-notice-close aria-label="返回待办" data-i18n-aria="ui.d3860ff78b74"><span data-i18n="ui.d3860ff78b74">返回待办</span></button></header><div class="notice-toolbar"><label><input id="notice-show-done" type="checkbox"> <span data-i18n="ui.7ce9e722f013">显示已处理</span></label><button type="button" id="notice-refresh"><span data-i18n="ui.aee887434131">刷新</span></button><button type="button" id="notice-test"><span data-i18n="ui.de045d1639a4">测试系统通知</span></button></div><p id="notice-capability" role="status"></p><div id="notice-records"></div><footer><span data-i18n="ui.ff1d171cb158">系统通知已提交不代表已显示或已读。关闭窗口后可后台提醒；完全退出后，下次启动补提醒。</span></footer></dialog>`);
  const dialog=document.getElementById('task-notices'), host=document.getElementById('notice-records');
  let rows=[], revision=0, timer, lastFocus, busy=false;
  const labels={get scheduled() { return mailaiText('等待提醒'); },get due() { return mailaiText('已到期'); },get submitted() { return mailaiText('已提交系统'); },get retry() { return mailaiText('通知待重试'); },get done() { return mailaiText('已完成'); },get canceled() { return mailaiText('已取消提醒'); }};
  function paint() {
    const showDone=document.getElementById('notice-show-done').checked;
    const visible=rows.filter(r=>showDone||!['done','canceled'].includes(r.state)).sort((a,b)=>{
      const rank=r=>['due','submitted','retry'].includes(r.state)?0:r.state==='scheduled'?1:2;
      return rank(a)-rank(b)||String(a.remind_at||a.last_reminder).localeCompare(String(b.remind_at||b.last_reminder));
    });
    const html=visible.length?visible.map(r=>`<article class="notice-record" data-notice-key="${esc(r.account_id)}:${r.id}"><div><b>${esc(r.title)}</b><small>${esc(r.account_user)} · ${esc((r.remind_at||r.last_reminder||'').replace('T',' ').slice(0,16))}</small><span class="notice-state" data-state="${r.state}">${labels[r.state]}</span>${r.state==='retry'?"<small><span data-i18n=\"ui.dd4c2ac94177\">系统暂未接受通知，稍后会自动重试；可先处理此任务。</span></small>":''}</div><div class="notice-actions"><button data-notice-action="open"><span data-i18n="ui.36550b9c5748">查看任务</span></button>${!['done','canceled'].includes(r.state)?"<button data-notice-action=\"later\"><span data-i18n=\"ui.c2a29a783b63\">10 分钟后</span></button><button data-notice-action=\"tomorrow\"><span data-i18n=\"ui.6a1e759cb774\">明天 9 点</span></button><button data-notice-action=\"done\"><span data-i18n=\"ui.c0b3fbff51cc\">完成</span></button>":''}</div></article>`).join(''):"<div class=\"notice-empty\"><span data-i18n=\"ui.7c2b43508cfb\">没有待处理的提醒</span><br><small><span data-i18n=\"ui.dab8da14396d\">在待办中设置提醒时间后，会显示在这里。</span></small></div>";
    mailaiPatchRows(host,html,'data-notice-key',()=>busy);
  }
  async function refresh() {
    if (busy) return;
    const ticket=++revision;
    try {
      const data=await api('/api/task-notices');if(ticket!==revision||!dialog.open)return;
      rows=data.items;paint();mailaiBindUI(document.getElementById('notice-capability'), 'textContent', () => mailaiSystemMessage(data.capability.hint));
      document.getElementById('notice-test').disabled=!data.capability.supported;
    }catch(e){if(ticket===revision){mailaiBindUI(document.getElementById('notice-capability'), "textContent", () => (mailaiText('暂时无法更新提醒，已保留当前内容。请点击刷新重试。')));if(!rows.length)host.innerHTML="<div class=\"notice-empty\"><span data-i18n=\"ui.bf0de717228a\">暂时无法读取提醒</span><br><small><span data-i18n=\"ui.894cdcf5645b\">请点击上方刷新重试。</span></small></div>";}}
  }
  window.mailaiOpenTaskReminder=async()=>{
    lastFocus=document.activeElement;
    document.getElementById('task-planner')?.close();
    if(document.getElementById('todo-center').classList.contains('hidden')) await openTodoCenter();
    window.mailaiTodoTab?.('reminders');
    if(!dialog.open)dialog.show();if(rows.length)paint();else mailaiBindUI(host, "textContent", () => (mailaiText('正在读取提醒…')));await refresh();
    clearInterval(timer);timer=setInterval(()=>{if(!document.hidden)refresh()},15000);
  };
  dialog.addEventListener('close',()=>{++revision;clearInterval(timer);if(document.getElementById('todo-center').dataset.todoView==='reminders'){window.mailaiTodoTab?.('all');lastFocus?.isConnected&&lastFocus.focus();}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape' && dialog.open && !document.querySelector('#task-planner[open],.mailai-question[open]')){e.preventDefault();e.stopImmediatePropagation();dialog.close();}},true);
  dialog.querySelector('[data-notice-close]').onclick=()=>dialog.close();
  document.getElementById('btn-task-notices').onclick=()=>window.mailaiOpenTaskReminder();
  document.getElementById('notice-refresh').onclick=refresh;
  document.getElementById('notice-show-done').onchange=paint;
  document.getElementById('notice-test').onclick=async event=>{
    const button=event.currentTarget;button.disabled=true;
    try {const result=await api('/api/task-notices/test',{method:'POST'});document.getElementById('notice-capability').textContent=mailaiSystemMessage(result.message);}
    catch(e){mailaiBindUI(document.getElementById('notice-capability'), "textContent", () => (mailaiText('测试失败：')+mailaiSystemMessage(e.message)));}
    finally {button.disabled=false;}
  };
  host.onclick=async event=>{
    const button=event.target.closest('[data-notice-action]');if(!button||busy)return;
    const key=button.closest('[data-notice-key]').dataset.noticeKey;
    const row=rows.find(r=>`${r.account_id}:${r.id}`===key);if(!row)return;
    const accountId=row.account_id, action=button.dataset.noticeAction;
    busy=true; ++revision; button.disabled=true;
    try {
      if(action==='open') {dialog.close();if(activeMailAccount()?.id!==accountId)await openAccountMailbox(accountId,'inbox');await openTodoCenter();await openTaskPlanner({accountId,todoId:row.id});return;}
      if(action==='done')await api(`/api/todos/${row.id}/done`,{accountId,method:'POST'});
      else {
        const when=new Date();if(action==='later')when.setMinutes(when.getMinutes()+10);else {when.setDate(when.getDate()+1);when.setHours(9,0,0,0);}
        when.setMinutes(when.getMinutes()-when.getTimezoneOffset());
        await api(`/api/todos/${row.id}`,{accountId,method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({remind_at:when.toISOString().slice(0,19)})});
      }
      window.mailaiTasksChanged?.(accountId);busy=false;await refresh();
      if(!button.isConnected)document.getElementById('notice-refresh').focus({preventScroll:true});
    }catch(e){toast(mailaiText('操作失败：')+mailaiSystemMessage(e.message),'error');}finally{busy=false;button.disabled=false;}
  };
  window.addEventListener('mailai-tasks-changed',()=>{if(dialog.open)refresh()});
})();
