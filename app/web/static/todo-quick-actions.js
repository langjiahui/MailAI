/* Manual quick-add bar, one-click snooze menus, and recurrence actions for Todo Center. */
(() => {
  const center = document.getElementById('todo-center');
  const tools = center?.querySelector('.todo-center-tools');
  const list = document.getElementById('todo-list');
  if (!center || !tools || !list) return;

  const quickBar = document.createElement('section');
  quickBar.className = 'todo-quick-add';
  mailaiBindUI(quickBar, '@aria-label', () => mailaiText('快速新建待办'));
  quickBar.innerHTML = `
    <form id="todo-quick-form" class="todo-quick-form">
      <svg class="todo-quick-plus" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg>
      <input id="todo-quick-title" type="text" maxlength="500" autocomplete="off"
        placeholder="快速记一条待办（无需关联邮件）…" data-i18n-placeholder="todo.quickPh"
        aria-label="快速新建待办标题" data-i18n-aria="todo.quickTitleAria">
      <div class="todo-quick-controls">
        <input id="todo-quick-deadline" type="date" aria-label="截止日期（可选）" data-i18n-aria="ui.0abb39c962d1">
        <select id="todo-quick-recurrence" aria-label="重复周期" data-i18n-aria="todo.recurrenceLabel">
          <option value="" data-i18n="todo.recNone">不重复</option>
          <option value="weekly" data-i18n="todo.recWeekly">每周重复</option>
          <option value="monthly" data-i18n="todo.recMonthly">每月重复</option>
        </select>
        <button id="todo-quick-submit" type="submit" data-i18n="todo.quickSubmit">新建</button>
      </div>
    </form>
  `;
  tools.after(quickBar);

  const form = document.getElementById('todo-quick-form');
  const titleInput = document.getElementById('todo-quick-title');
  const deadlineInput = document.getElementById('todo-quick-deadline');
  const recurrenceSelect = document.getElementById('todo-quick-recurrence');
  const submitButton = document.getElementById('todo-quick-submit');

  window.mailaiFocusQuickTodo = () => {
    if (center.classList.contains('hidden')) return;
    if (center.dataset.todoView === 'reminders' || center.dataset.todoView === 'followups') {
      window.mailaiTodoTab?.('all');
    }
    requestAnimationFrame(() => titleInput?.focus());
  };

  let creating = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (creating) return;
    const title = (titleInput.value || '').trim();
    if (!title) {
      toast(mailaiText('请先输入待办内容'), 'warn');
      titleInput.focus();
      return;
    }
    const accountId = todoCenterAccountId || activeMailAccount()?.id;
    const deadline = deadlineInput.value || null;
    const recurrence = recurrenceSelect.value || '';
    creating = true;
    submitButton.disabled = true;
    try {
      const res = await api('/api/todos', {
        accountId,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, deadline, recurrence }),
      });
      titleInput.value = '';
      deadlineInput.value = '';
      recurrenceSelect.value = '';
      if (accountId === todoCenterAccountId && res?.task) {
        if (!todoCenterRows.some((row) => row.id === res.task.id)) {
          todoCenterRows.unshift(res.task);
        }
        if (window.mailaiTodoMatches && !window.mailaiTodoMatches(res.task)) {
          window.mailaiTodoTab?.('all');
        } else {
          renderTodoCenter();
        }
      }
      window.mailaiTasksChanged?.(accountId);
      toast(
        recurrence
          ? mailaiText('已新建周期待办')
          : mailaiText('已新建待办'),
        'success'
      );
      titleInput.focus();
    } catch (error) {
      toast(mailaiText('创建待办失败：') + mailaiSystemMessage(error.message), 'error');
    } finally {
      creating = false;
      submitButton.disabled = false;
    }
  });

  function closeOpenSnoozeMenus(except = null) {
    list.querySelectorAll('.todo-snooze-menu[open]').forEach((menu) => {
      if (menu !== except) menu.open = false;
    });
  }

  document.addEventListener('pointerdown', (event) => {
    const inside = event.target.closest?.('.todo-snooze-menu');
    closeOpenSnoozeMenus(inside || null);
  });

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      const openMenu = list.querySelector('.todo-snooze-menu[open]');
      if (openMenu) {
        event.preventDefault();
        event.stopPropagation();
        openMenu.open = false;
        openMenu.querySelector('summary')?.focus();
      }
    },
    true
  );

  list.addEventListener(
    'toggle',
    (event) => {
      if (event.target.matches?.('.todo-snooze-menu') && event.target.open) {
        closeOpenSnoozeMenus(event.target);
      }
    },
    true
  );

  async function applySnooze(ids, preset, sourceButton) {
    const accountId = todoCenterAccountId;
    const revision = todoCenterRevision;
    if (!ids.length) return;
    if (typeof flushTodoEdits === 'function') {
      const ok = await flushTodoEdits(ids);
      if (!ok || accountId !== todoCenterAccountId) return;
    }
    const popover = sourceButton.closest('.todo-snooze-menu');
    const buttons = popover ? [...popover.querySelectorAll('button')] : [sourceButton];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const res = ids.length === 1
        ? await api(`/api/todos/${ids[0]}/snooze`, {
            accountId,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preset }),
          })
        : await api('/api/todos/bulk/snooze', {
            accountId,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, preset }),
          });
      const updated = res?.task ? [res.task] : (res?.tasks || []);
      if (accountId === todoCenterAccountId && updated.length) {
        const byId = new Map(updated.map((row) => [row.id, row]));
        todoCenterRows = todoCenterRows.map((row) => (byId.has(row.id) ? { ...row, ...byId.get(row.id) } : row));
        if (revision === todoCenterRevision) {
          if (popover) popover.open = false;
          renderTodoCenter();
        }
      }
      window.mailaiTasksChanged?.(accountId);
      const targetDate = String(updated[0]?.deadline || '').slice(0, 10);
      toast(
        targetDate
          ? mailaiTemplate`已推迟至 ${targetDate}`
          : mailaiText('已推迟待办时间'),
        'success'
      );
    } catch (error) {
      toast(mailaiText('推迟失败：') + mailaiSystemMessage(error.message), 'error');
    } finally {
      buttons.forEach((b) => { if (b.isConnected) b.disabled = false; });
    }
  }

  list.addEventListener('click', (event) => {
    const singleBtn = event.target.closest('[data-todo-snooze]');
    if (singleBtn) {
      event.preventDefault();
      event.stopPropagation();
      const id = Number(singleBtn.dataset.todoSnooze);
      const preset = singleBtn.dataset.snoozePreset;
      if (id && preset) applySnooze([id], preset, singleBtn);
      return;
    }
    const groupBtn = event.target.closest('[data-todo-group-snooze]');
    if (groupBtn) {
      event.preventDefault();
      event.stopPropagation();
      const groupKey = groupBtn.dataset.todoGroupSnooze;
      const preset = groupBtn.dataset.snoozePreset;
      const allGroups = window.mailaiTodoGroups
        ? window.mailaiTodoGroups(todoCenterRows.filter((item) => item.status !== 'done' && (!window.mailaiTodoMatches || window.mailaiTodoMatches(item))))
        : [];
      const group = allGroups.find((g) => g.key === groupKey);
      const ids = group ? group.rows.filter((r) => r.status !== 'done').map((r) => r.id) : [];
      if (ids.length && preset) applySnooze(ids, preset, groupBtn);
    }
  });
})();
