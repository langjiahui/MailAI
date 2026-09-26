/* A durable, cross-platform entry point for reminders, independent of toasts. */
(() => {
  document.querySelector('.todo-batch-actions').insertAdjacentHTML('afterbegin','<button type="button" id="btn-task-notices">提醒记录</button>');
  document.body.insertAdjacentHTML('beforeend', `<dialog id="task-notices" aria-labelledby="task-notices-title"><header><div><small>所有邮箱 · 每项任务最近一次提醒</small><h2 id="task-notices-title">提醒记录</h2></div><button type="button" data-notice-close aria-label="关闭提醒记录">×</button></header><div class="notice-toolbar"><label><input id="notice-show-done" type="checkbox"> 显示已处理</label><button type="button" id="notice-refresh">刷新</button><button type="button" id="notice-test">测试系统通知</button></div><p id="notice-capability" role="status"></p><div id="notice-records"></div><footer>系统通知已提交不代表已显示或已读。关闭窗口后可后台提醒；完全退出后，下次启动补提醒。</footer></dialog>`);
  const dialog=document.getElementById('task-notices'), host=document.getElementById('notice-records');
  let rows=[], revision=0, timer, lastFocus, busy=false;
  const labels={scheduled:'等待提醒',due:'已到期',submitted:'已提交系统',retry:'通知待重试',done:'已完成',canceled:'已取消提醒'};
  function paint() {
    const showDone=document.getElementById('notice-show-done').checked;
    const visible=rows.filter(r=>showDone||!['done','canceled'].includes(r.state)).sort((a,b)=>{
      const rank=r=>['due','submitted','retry'].includes(r.state)?0:r.state==='scheduled'?1:2;
      return rank(a)-rank(b)||String(a.remind_at||a.last_reminder).localeCompare(String(b.remind_at||b.last_reminder));
    });
    const html=visible.length?visible.map(r=>`<article class="notice-record" data-notice-key="${esc(r.account_id)}:${r.id}"><div><b>${esc(r.title)}</b><small>${esc(r.account_user)} · ${esc((r.remind_at||r.last_reminder||'').replace('T',' ').slice(0,16))}</small><span class="notice-state" data-state="${r.state}">${labels[r.state]}</span>${r.state==='retry'?'<small>系统暂未接受通知，稍后会自动重试；可先处理此任务。</small>':''}</div><div class="notice-actions"><button data-notice-action="open">查看任务</button>${!['done','canceled'].includes(r.state)?'<button data-notice-action="later">10 分钟后</button><button data-notice-action="tomorrow">明天 9 点</button><button data-notice-action="done">完成</button>':''}</div></article>`).join(''):'<div class="notice-empty">没有待处理的提醒<br><small>在待办中设置提醒时间后，会显示在这里。</small></div>';
    mailaiPatchRows(host,html,'data-notice-key',()=>busy);
  }
  async function refresh() {
    if (busy) return;
    const ticket=++revision;
    try {
      const data=await api('/api/task-notices');if(ticket!==revision||!dialog.open)return;
      rows=data.items;paint();document.getElementById('notice-capability').textContent=data.capability.hint;
      document.getElementById('notice-test').disabled=!data.capability.supported;
    }catch(e){if(ticket===revision){document.getElementById('notice-capability').textContent='暂时无法更新提醒，已保留当前内容。请点击刷新重试。';if(!rows.length)host.innerHTML='<div class="notice-empty">暂时无法读取提醒<br><small>请点击上方刷新重试。</small></div>';}}
  }
  window.mailaiOpenTaskReminder=async()=>{
    lastFocus=document.activeElement;
    document.getElementById('task-planner')?.close();
    if(!dialog.open)dialog.showModal();if(rows.length)paint();else host.textContent='正在读取提醒…';await refresh();
    clearInterval(timer);timer=setInterval(()=>{if(!document.hidden)refresh()},15000);
  };
  dialog.addEventListener('close',()=>{++revision;clearInterval(timer);lastFocus?.isConnected&&lastFocus.focus();});
  dialog.querySelector('[data-notice-close]').onclick=()=>dialog.close();
  document.getElementById('btn-task-notices').onclick=()=>window.mailaiOpenTaskReminder();
  document.getElementById('notice-refresh').onclick=refresh;
  document.getElementById('notice-show-done').onchange=paint;
  document.getElementById('notice-test').onclick=async event=>{
    const button=event.currentTarget;button.disabled=true;
    try {const result=await api('/api/task-notices/test',{method:'POST'});document.getElementById('notice-capability').textContent=result.message;}
    catch(e){document.getElementById('notice-capability').textContent='测试失败：'+e.message;}
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
    }catch(e){toast('操作失败：'+e.message,'error');}finally{busy=false;button.disabled=false;}
  };
  window.addEventListener('mailai-tasks-changed',()=>{if(dialog.open)refresh()});
})();
