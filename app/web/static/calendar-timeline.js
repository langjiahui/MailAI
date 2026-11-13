(() => {
  const modal = document.getElementById('calendar-timeline-modal');
  if (!modal) return;

  const summaryStrip = document.getElementById('timeline-summary-strip');
  const filterBtns = [...modal.querySelectorAll('[data-timeline-kind]')];
  const daysSelect = document.getElementById('timeline-days-select');
  const includeDoneCheck = document.getElementById('timeline-include-done');
  const toggleCreateBtn = document.getElementById('timeline-toggle-create');
  const createForm = document.getElementById('timeline-create-form');
  const createTitleInput = document.getElementById('timeline-create-title');
  const createStartInput = document.getElementById('timeline-create-start');
  const createEndInput = document.getElementById('timeline-create-end');
  const createLocationInput = document.getElementById('timeline-create-location');
  const createDescInput = document.getElementById('timeline-create-desc');
  const createAllDayCheck = document.getElementById('timeline-create-allday');
  const createSubmitBtn = document.getElementById('timeline-create-submit');
  const createCancelBtn = document.getElementById('timeline-create-cancel');
  const listEl = document.getElementById('timeline-list');
  const selectAllBtn = document.getElementById('timeline-select-all');
  const selectedCountEl = document.getElementById('timeline-selected-count');
  const sysCalendarSelect = document.getElementById('timeline-system-calendar');
  const sysAddBtn = document.getElementById('timeline-btn-system-add');
  const sysNoteEl = document.getElementById('timeline-system-note');
  const exportBatchBtn = document.getElementById('timeline-btn-export-batch');

  let activeKind = 'all';
  let currentData = null;
  const selectedIds = new Set();
  let systemCalendarsLoaded = false;

  function accountId() {
    return typeof activeMailAccount === 'function' ? (activeMailAccount()?.id || '') : '';
  }

  function accountHeaders(acc = accountId()) {
    return acc ? { 'X-MailAI-Account': acc } : {};
  }

  function kindLabel(item) {
    if (item.kind === 'todo') return mailaiText('待办');
    if (item.kind === 'followup') return mailaiText('发信跟进');
    if (item.kind === 'ics') return mailaiText('会议邀请');
    if (item.kind === 'custom') return mailaiText('自建日程');
    return item.kind_label || '';
  }

  function filteredItems() {
    const items = currentData?.items || [];
    if (activeKind === 'all') return items;
    return items.filter(it => it.kind === activeKind);
  }

  function selectedItems() {
    const items = currentData?.items || [];
    return items.filter(it => selectedIds.has(it.item_id));
  }

  function updateSelectionUi() {
    const visible = filteredItems();
    const checkedCount = selectedItems().length;
    selectedCountEl.textContent = mailaiTemplate`已选 ${checkedCount} 项`;
    exportBatchBtn.disabled = checkedCount === 0;
    const hasCal = Boolean(sysCalendarSelect.value) && currentData?.macos_calendar_supported !== false;
    sysAddBtn.disabled = checkedCount === 0 || !hasCal;
    const allVisibleSelected = visible.length > 0 && visible.every(it => selectedIds.has(it.item_id));
    selectAllBtn.textContent = allVisibleSelected ? mailaiText('取消全选') : mailaiText('全选当前');
  }

  function renderSummary() {
    const s = currentData?.summary;
    if (!s) {
      summaryStrip.innerHTML = '';
      return;
    }
    const cards = [
      { label: mailaiText('近期日程'), value: mailaiTemplate`${s.total || 0} 项`, cls: '' },
      { label: mailaiText('已逾期'), value: mailaiTemplate`${s.overdue || 0} 项`, cls: (s.overdue || 0) > 0 ? 'is-danger' : '' },
      { label: mailaiText('今日安排'), value: mailaiTemplate`${s.today || 0} 项`, cls: '' },
      { label: mailaiText('时段冲突'), value: mailaiTemplate`${s.conflicts || 0} 处`, cls: (s.conflicts || 0) > 0 ? 'is-warn' : '' },
    ];
    summaryStrip.innerHTML = cards
      .map(
        c => `
        <div class="timeline-metric ${c.cls}">
          <span class="timeline-metric-label">${esc(c.label)}</span>
          <strong class="timeline-metric-value">${esc(c.value)}</strong>
        </div>`
      )
      .join('');
  }

  function renderGroups() {
    const groups = currentData?.groups || [];
    const rendered = [];
    for (const group of groups) {
      const groupItems = (group.items || []).filter(it => activeKind === 'all' || it.kind === activeKind);
      if (!groupItems.length) continue;
      const headerCls = group.bucket === 'overdue' ? 'is-overdue' : group.bucket === 'today' ? 'is-today' : '';
      const rowsHtml = groupItems
        .map(it => {
          const isDone = it.status === 'done';
          const checked = selectedIds.has(it.item_id) ? 'checked' : '';
          const timeText = it.all_day
            ? mailaiText('全天')
            : `${esc(it.start_time || '--:--')}${it.end_time ? ` - ${esc(it.end_time)}` : ''}`;
          const conflictText = it.conflict && (it.conflict_with || []).length
            ? mailaiTemplate`时段冲突：${it.conflict_with.slice(0, 2).join('、')}`
            : '';
          const metaParts = [];
          if (it.location) metaParts.push(mailaiTemplate`地点：${it.location}`);
          if (it.source_label) metaParts.push(it.source_label);
          if (it.description && it.kind !== 'todo') {
            metaParts.push(it.description);
          }

          const actions = [];
          if (it.kind === 'todo' && !isDone && it.todo_id) {
            actions.push(
              `<button type="button" class="timeline-mini-btn" data-action="complete-todo" data-todo-id="${it.todo_id}">${esc(mailaiText('完成'))}</button>`
            );
          }
          if (it.email_id) {
            actions.push(
              `<button type="button" class="timeline-mini-btn" data-action="open-email" data-email-id="${it.email_id}">${esc(mailaiText('查看邮件'))}</button>`
            );
          }
          if (it.kind === 'custom' && it.custom_id) {
            actions.push(
              `<button type="button" class="timeline-mini-btn danger" data-action="delete-custom" data-custom-id="${it.custom_id}">${esc(mailaiText('删除'))}</button>`
            );
          }

          return `
            <div class="timeline-item ${it.conflict ? 'is-conflict' : ''} ${isDone ? 'is-done' : ''}" data-item-id="${esc(it.item_id)}">
              <input type="checkbox" class="timeline-item-check" data-select-id="${esc(it.item_id)}" ${checked} aria-label="${esc(it.title)}">
              <div class="timeline-item-time">
                <span>${timeText}</span>
                <small>${esc(it.date)}</small>
              </div>
              <div class="timeline-item-main">
                <div class="timeline-item-title-row">
                  <span class="timeline-item-title">${esc(it.title)}</span>
                  <span class="timeline-badge kind-${esc(it.kind)}">${esc(kindLabel(it))}</span>
                  ${it.overdue ? `<span class="timeline-badge is-overdue">${esc(mailaiText('已逾期'))}</span>` : ''}
                  ${conflictText ? `<span class="timeline-badge is-conflict">${esc(conflictText)}</span>` : ''}
                </div>
                ${metaParts.length ? `<div class="timeline-item-meta">${metaParts.map(p => `<span>${esc(p)}</span>`).join(' · ')}</div>` : ''}
              </div>
              <div class="timeline-item-actions">${actions.join('')}</div>
            </div>`;
        })
        .join('');

      rendered.push(`
        <section class="timeline-group">
          <div class="timeline-group-header ${headerCls}">
            <span>${esc(group.label)}</span>
            <span>${esc(mailaiTemplate`${groupItems.length} 项`)}</span>
          </div>
          ${rowsHtml}
        </section>`);
    }

    listEl.innerHTML = rendered.length
      ? rendered.join('')
      : `<div class="timeline-empty">${esc(mailaiText('当前范围暂无日程安排，可点击「+ 新建日程」添加，或先同步包含待办与会议邀请的邮件。'))}</div>`;

    updateSelectionUi();
  }

  async function loadSystemCalendars() {
    if (systemCalendarsLoaded) return;
    try {
      const data = await api('/api/productivity/calendar/system-calendars', {
        headers: accountHeaders(),
      });
      systemCalendarsLoaded = true;
      const cals = data.calendars || [];
      if (!data.supported) {
        sysCalendarSelect.innerHTML = `<option value="">${esc(mailaiText('系统日历（请用 .ics 导入）'))}</option>`;
        sysCalendarSelect.disabled = true;
        sysNoteEl.textContent = data.note || '';
      } else if (!cals.length) {
        sysCalendarSelect.innerHTML = `<option value="">${esc(mailaiText('未读取到系统日历'))}</option>`;
        sysCalendarSelect.disabled = true;
        sysNoteEl.textContent = data.note || mailaiText('可使用「导出 .ics」导入苹果日历');
      } else {
        sysCalendarSelect.disabled = false;
        sysCalendarSelect.innerHTML = cals
          .map(name => `<option value="${esc(name)}">${esc(mailaiTemplate`日历：${name}`)}</option>`)
          .join('');
        sysNoteEl.textContent = mailaiText('支持写入 macOS「日历」或导出 .ics');
      }
    } catch {
      sysCalendarSelect.innerHTML = `<option value="">${esc(mailaiText('未读取到系统日历'))}</option>`;
      sysCalendarSelect.disabled = true;
    }
    updateSelectionUi();
  }

  async function loadTimeline() {
    listEl.innerHTML = `<div class="timeline-empty">${esc(mailaiText('正在聚合待办、跟进与会议日程…'))}</div>`;
    try {
      const days = Number(daysSelect.value) || 14;
      const includeDone = includeDoneCheck.checked ? 'true' : 'false';
      const data = await api(
        `/api/productivity/calendar/timeline?days=${days}&include_past_days=7&include_done=${includeDone}`,
        { headers: accountHeaders() }
      );
      currentData = data;
      const validSet = new Set((data.items || []).map(x => x.item_id));
      for (const id of [...selectedIds]) {
        if (!validSet.has(id)) selectedIds.delete(id);
      }
      renderSummary();
      renderGroups();
    } catch (e) {
      const msg = e.message || mailaiText('读取日程时间线失败');
      listEl.innerHTML = `<div class="timeline-empty">${esc(msg)}</div>`;
    }
  }

  function resetCreateDefaults() {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    const pad = n => String(n).padStart(2, '0');
    const localStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
    const endDt = new Date(now.getTime() + 3600000);
    const localEnd = `${endDt.getFullYear()}-${pad(endDt.getMonth() + 1)}-${pad(endDt.getDate())}T${pad(endDt.getHours())}:00`;
    createTitleInput.value = '';
    createStartInput.value = localStart;
    createEndInput.value = localEnd;
    createLocationInput.value = '';
    createDescInput.value = '';
    createAllDayCheck.checked = false;
  }

  async function openModal() {
    if (typeof closeTodoCenter === 'function') closeTodoCenter();
    if (typeof closeContactCenter === 'function') closeContactCenter();
    if (typeof closeAttachmentCenter === 'function') closeAttachmentCenter();
    if (typeof closeTriageCenter === 'function') closeTriageCenter();
    if (typeof closeAssistant === 'function') closeAssistant();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    createForm.classList.add('hidden');
    resetCreateDefaults();
    await Promise.all([loadTimeline(), loadSystemCalendars()]);
  }

  function closeModal() {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      activeKind = btn.dataset.timelineKind || 'all';
      filterBtns.forEach(b => b.classList.toggle('is-active', b === btn));
      renderGroups();
    });
  });

  daysSelect.addEventListener('change', loadTimeline);
  includeDoneCheck.addEventListener('change', loadTimeline);
  sysCalendarSelect.addEventListener('change', updateSelectionUi);

  toggleCreateBtn.addEventListener('click', () => {
    const opening = createForm.classList.contains('hidden');
    createForm.classList.toggle('hidden');
    if (opening) {
      resetCreateDefaults();
      createTitleInput.focus();
    }
  });

  createCancelBtn.addEventListener('click', () => {
    createForm.classList.add('hidden');
  });

  createForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    const title = createTitleInput.value.trim();
    const start = createStartInput.value.trim();
    if (!title || !start) {
      toast(mailaiText('请填写日程标题与开始时间'), 'warn');
      return;
    }
    createSubmitBtn.disabled = true;
    try {
      await api('/api/productivity/calendar/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...accountHeaders() },
        body: JSON.stringify({
          title,
          start,
          end: createEndInput.value.trim(),
          location: createLocationInput.value.trim(),
          description: createDescInput.value.trim(),
          all_day: createAllDayCheck.checked,
        }),
      });
      createForm.classList.add('hidden');
      toast(mailaiText('已添加自建日程'), 'success');
      await loadTimeline();
    } catch (e) {
      toast(e.message || mailaiText('创建日程失败'), 'error');
    } finally {
      createSubmitBtn.disabled = false;
    }
  });

  listEl.addEventListener('change', ev => {
    const chk = ev.target.closest('.timeline-item-check');
    if (!chk) return;
    const id = chk.dataset.selectId;
    if (!id) return;
    if (chk.checked) selectedIds.add(id);
    else selectedIds.delete(id);
    updateSelectionUi();
  });

  listEl.addEventListener('click', async ev => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'complete-todo') {
      const todoId = Number(btn.dataset.todoId);
      if (!todoId) return;
      btn.disabled = true;
      try {
        await api(`/api/todos/${todoId}/done`, {
          method: 'POST',
          headers: accountHeaders(),
        });
        toast(mailaiText('待办已标记完成'), 'success');
        if (typeof loadTodos === 'function') await loadTodos();
        await loadTimeline();
      } catch (e) {
        btn.disabled = false;
        toast(e.message || mailaiText('更新待办失败'), 'error');
      }
      return;
    }
    if (action === 'open-email') {
      const emailId = Number(btn.dataset.emailId);
      if (!emailId) return;
      if (typeof openDigestEmailDrawer === 'function') {
        await openDigestEmailDrawer(emailId);
      } else if (typeof selectEmail === 'function') {
        closeModal();
        await selectEmail(emailId);
      }
      return;
    }
    if (action === 'delete-custom') {
      const customId = Number(btn.dataset.customId);
      if (!customId) return;
      btn.disabled = true;
      try {
        await api(`/api/productivity/calendar/events/${customId}`, {
          method: 'DELETE',
          headers: accountHeaders(),
        });
        selectedIds.delete(`custom:${customId}`);
        toast(mailaiText('已删除自建日程'), 'success');
        await loadTimeline();
      } catch (e) {
        btn.disabled = false;
        toast(e.message || mailaiText('删除日程失败'), 'error');
      }
    }
  });

  selectAllBtn.addEventListener('click', () => {
    const visible = filteredItems();
    const allSelected = visible.length > 0 && visible.every(it => selectedIds.has(it.item_id));
    for (const it of visible) {
      if (allSelected) selectedIds.delete(it.item_id);
      else selectedIds.add(it.item_id);
    }
    renderGroups();
  });

  exportBatchBtn.addEventListener('click', async () => {
    const chosen = selectedItems();
    if (!chosen.length) {
      toast(mailaiText('请先勾选至少一条日程'), 'warn');
      return;
    }
    exportBatchBtn.disabled = true;
    try {
      const res = await fetch('/api/productivity/calendar/export-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...accountHeaders() },
        body: JSON.stringify({ items: chosen }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'schedule.ics';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast(mailaiTemplate`已导出 ${chosen.length} 条日程至 schedule.ics`, 'success');
    } catch (e) {
      toast(e.message || mailaiText('导出 .ics 失败'), 'error');
    } finally {
      updateSelectionUi();
    }
  });

  sysAddBtn.addEventListener('click', async () => {
    const chosen = selectedItems();
    const calendarName = sysCalendarSelect.value;
    if (!chosen.length || !calendarName) {
      toast(mailaiText('请先勾选日程并选择目标系统日历'), 'warn');
      return;
    }
    sysAddBtn.disabled = true;
    sysAddBtn.textContent = mailaiText('正在写入…');
    try {
      const res = await api('/api/productivity/calendar/system-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...accountHeaders() },
        body: JSON.stringify({ calendar_name: calendarName, items: chosen }),
      });
      toast(
        mailaiTemplate`已写入「${res.calendar}」：新增 ${res.created} 条，跳过重复 ${res.skipped} 条`,
        'success'
      );
    } catch (e) {
      toast(e.message || mailaiText('写入系统日历失败'), 'error');
    } finally {
      sysAddBtn.textContent = mailaiText('写入系统日历');
      updateSelectionUi();
    }
  });

  const todoTrigger = document.getElementById('btn-todo-open-timeline');
  if (todoTrigger) todoTrigger.addEventListener('click', openModal);

  const closeBtn = document.getElementById('btn-close-timeline');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  modal.querySelectorAll('[data-close-timeline]').forEach(el => el.addEventListener('click', closeModal));

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });

  document.addEventListener('mailai:language-changed', () => {
    if (!modal.classList.contains('hidden') && currentData) {
      renderSummary();
      renderGroups();
      updateSelectionUi();
    }
  });

  window.openCalendarTimeline = openModal;
  window.closeCalendarTimeline = closeModal;
  globalThis.MailAIModules?.register('calendarTimeline', {
    open: openModal,
    close: closeModal,
  });
})();
