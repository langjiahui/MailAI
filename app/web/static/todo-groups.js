/* Group the reading stream without merging or deleting the original tasks. */
(() => {
  const expanded = new Set();
  let grouped = true;
  const groupKey = item => JSON.stringify([
    String(item.group_key || '').split('|')[0] || (item.email_id ? 'mail:'+item.email_id : 'task:'+item.id),
    String(item.deadline || '').slice(0,10), item.stage || 'active', item.kind || 'execution',
  ]);
  window.mailaiTodoGroups = rows => {
    if (!grouped) return rows.map(item=>({key:'task:'+item.id,rows:[item]}));
    const groups = new Map();
    for (const item of rows) {
      const key = groupKey(item);
      if (!groups.has(key)) groups.set(key, {key, rows:[]});
      groups.get(key).rows.push(item);
    }
    return [...groups.values()];
  };
  const selectedGroup = key => window.mailaiTodoGroups(todoCenterRows.filter(item =>
    (document.getElementById('todo-show-done').checked || item.status !== 'done') &&
    (!window.mailaiTodoMatches || window.mailaiTodoMatches(item)))).find(group => group.key === key);
  window.mailaiTodoGroupHTML = (groups, renderRow) => groups.map(group => {
    const key = esc(group.key);
    if (group.rows.length === 1) return `<section data-todo-group-key="${key}">${renderRow(group.rows[0])}</section>`;
    const open = group.rows.filter(item => item.status !== 'done');
    const sources = [...new Map(group.rows.filter(item => item.email_id).map(item => [item.email_id,item])).values()].sort((a,b) => String(b.email_date || '').localeCompare(String(a.email_date || '')));
    const visibleSourceIds = new Set((group.visibleRows || group.rows).map(item=>item.email_id));
    const visibleSources = sources.filter((item,index)=>index===0 || visibleSourceIds.has(item.email_id));
    const latest = [...sources].sort((a,b) => String(b.email_date || '').localeCompare(String(a.email_date || '')))[0] || group.rows[0];
    const reminderTimes = [...new Set(open.map(item => item.remind_at || ''))];
    const reminder = reminderTimes.length === 1 && reminderTimes[0]
      ? mailaiText('提醒 ') + fmtDate(reminderTimes[0])
      : reminderTimes.some(Boolean) ? mailaiText('子事项已分别安排提醒') : mailaiText('未开启提醒');
    const date = String(latest.deadline || '').slice(0,10);
    const preview = open.length ? open : group.rows;
    const isOpen = expanded.has(todoCenterAccountId+':'+group.key) || document.getElementById('todo-center').dataset.batch === 'true';
    return `<section class="todo-group ${sources.length < 2 ? 'todo-group-single-source' : ''}" data-todo-group-key="${key}">
      <header class="todo-group-header"><div class="todo-group-main"><h3 data-user-content>${esc(latest.group_title || latest.email_subject || latest.title)}</h3>
        <div class="todo-group-meta"><span>${esc(mailaiTemplate`${open.length} 项未完成 / 共 ${group.rows.length} 项`)}</span>${date ? `<span>${esc(mailaiText('截止 · ')+date)}</span>` : ''}<span>${esc(reminder)}</span></div>
        <div class="todo-group-sources">${visibleSources.map((item,index) => `<button type="button" class="todo-source" data-todo-email="${item.email_id}" title="${esc(item.email_subject || '')}">${esc(sources.length > 1 && index === 0 ? mailaiText('最新来源邮件') : mailaiText('查看来源邮件'))} · ${esc(fmtDate(item.email_date || item.created_at))}</button>`).join('')}</div>
        ${sources.length > 1 ? `<p class="todo-group-review">${esc(mailaiText('相关通知已归集，时间和地点请核对最新邮件；原事项均已保留。'))}</p>` : ''}
      </div><div class="todo-group-actions">${open.length ? `<button type="button" data-todo-group-remind="${key}">${esc(mailaiText('统一提醒'))}</button><button type="button" data-todo-group-done="${key}">${esc(mailaiText('完成本组'))}</button>` : ''}</div></header>
      <details class="todo-group-details" ${isOpen ? 'open' : ''}><summary><span class="todo-group-preview" data-user-content>${esc(preview.slice(0,2).map(item=>item.title).join(' · '))}</span><span class="todo-group-expand">${esc(mailaiTemplate`查看 ${group.rows.length} 项`)}</span><span class="todo-group-collapse">${esc(mailaiText('收起子事项'))}</span></summary>${(group.visibleRows || group.rows).map(renderRow).join('')}</details>
    </section>`;
  }).join('');
  const list = document.getElementById('todo-list');
  const groupingToggle = document.createElement('button');
  groupingToggle.type = 'button';groupingToggle.id = 'todo-group-toggle';
  const paintToggle = () => {
    groupingToggle.setAttribute('aria-pressed',String(grouped));
    mailaiBindUI(groupingToggle,'textContent',()=>grouped ? mailaiText('逐项查看') : mailaiText('按邮件归集'));
  };
  groupingToggle.onclick = () => { grouped = !grouped;paintToggle();renderTodoCenter(); };
  document.querySelector('#todo-center .todo-center-tools').append(groupingToggle);paintToggle();
  list.addEventListener('toggle', event => {
    if (!event.target.matches('.todo-group-details')) return;
    const key = todoCenterAccountId+':'+event.target.closest('[data-todo-group-key]').dataset.todoGroupKey;
    if (event.target.open) expanded.add(key); else expanded.delete(key);
  }, true);
  const overview = document.createElement('p');
  overview.id = 'todo-group-overview';overview.setAttribute('role','status');list.before(overview);
  window.mailaiTodoGroupOverview = (groups, rows) => {
    overview.hidden = !rows.length || !groups.some(group=>group.rows.length > 1);
    overview.textContent = mailaiTemplate`按邮件归集为 ${groups.length} 组，${rows.filter(item=>item.status !== 'done').length} 项未完成；展开可单独处理。`;
  };

  document.body.insertAdjacentHTML('beforeend', `<dialog id="todo-group-planner"><form><header><h3 data-i18n="todo.group.reminderTitle">统一安排提醒</h3><button type="button" data-group-cancel aria-label="关闭" data-i18n-aria="ui.3fd47edce45b">×</button></header><p data-group-description></p><label><span data-i18n="ui.55e4169d5992">提醒时间（可选）</span><input type="datetime-local" data-group-time></label><p data-i18n="todo.group.reminderHint">本组未完成事项使用同一提醒时间，到期合并通知。子事项的截止日期和完成状态不变。</p><p data-group-error role="status"></p><footer><button type="button" data-group-cancel data-i18n="ui.2cd0f3be8738">取消</button><button type="submit" data-i18n="ui.231530ddc697">保存安排</button></footer></form></dialog>`);
  const dialog = document.getElementById('todo-group-planner');
  const time = dialog.querySelector('[data-group-time]'), error = dialog.querySelector('[data-group-error]');
  let context;
  dialog.querySelectorAll('[data-group-cancel]').forEach(button=>button.onclick=()=>dialog.close());
  const localTime = value => {
    const date = new Date(value);date.setMinutes(date.getMinutes()-date.getTimezoneOffset());
    return date.toISOString().slice(0,16);
  };
  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-todo-group-remind],[data-todo-group-done]');
    if (!button || button.disabled) return;
    const group = selectedGroup(button.dataset.todoGroupRemind || button.dataset.todoGroupDone);
    const rows = group?.rows.filter(item=>item.status !== 'done') || [];
    const accountId = todoCenterAccountId;
    if (!rows.length || !(await flushTodoEdits(rows.map(item=>item.id))) || accountId !== todoCenterAccountId) return;
    if (button.hasAttribute('data-todo-group-done')) {
      if (!(await mailaiAsk({title:mailaiText('完成本组'),message:mailaiTemplate`将本组 ${rows.length} 项未完成事项标记为完成，并取消它们的提醒。`,confirmText:mailaiText('完成本组')})) || accountId !== todoCenterAccountId) return;
      button.disabled = true;
      try { await setTodoBatchStatus(rows.map(item=>item.id)); }
      catch (failure) { toast(mailaiSystemMessage(failure.message),'warn'); }
      finally { button.disabled = false; }
      return;
    }
    context = {accountId, ids:rows.map(item=>item.id), saving:false};
    dialog.querySelector('[type=submit]').disabled = false;time.disabled = false;
    const times = [...new Set(rows.map(item=>item.remind_at || ''))];
    time.value = times.length === 1 && times[0] ? localTime(times[0]) : '';
    error.textContent = '';
    mailaiBindUI(dialog.querySelector('[data-group-description]'),'textContent',()=>mailaiTemplate`为 ${rows.length} 项未完成事项设置相同提醒；留空可取消本组提醒。`);
    dialog.showModal();time.focus();
  });
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault();const request = context;if (!request || request.saving) return;
    const value = time.value;
    if (value && new Date(value).getTime() <= Date.now()) { error.textContent = mailaiText('请选择将来的提醒时间');return; }
    request.saving = true;
    const submit = dialog.querySelector('[type=submit]');submit.disabled = true;error.textContent = '';
    try {
      await api('/api/todos/group/reminder',{accountId:request.accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:request.ids,remind_at:value})});
      window.mailaiTasksChanged?.(request.accountId);
      if (context === request && dialog.open) {
        if (time.value === value) { dialog.close();toast(mailaiText('本组提醒已更新'),'success'); }
        else error.textContent = mailaiText('刚才的提醒已保存，当前修改仍保留。');
      }
    } catch (failure) { if (context === request) error.textContent = mailaiSystemMessage(failure.message); }
    finally { request.saving = false;if (context === request) { submit.disabled = false;time.disabled = false; } }
  };
  document.addEventListener('mailai:language-changed',()=>{
    if (!document.getElementById('todo-center').classList.contains('hidden')) renderTodoCenter();
  });
})();
