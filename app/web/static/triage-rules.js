(() => {
  const modal = document.getElementById('triage-rules-modal');
  if (!modal) return;

  const tabBtns = [...modal.querySelectorAll('[data-triage-tab]')];
  const subsPane = document.getElementById('triage-pane-subs');
  const rulesPane = document.getElementById('triage-pane-rules');
  const subSummaryEl = document.getElementById('triage-subs-summary');
  const subListEl = document.getElementById('triage-subs-list');
  const subRefreshBtn = document.getElementById('triage-subs-refresh');

  const newRuleBtn = document.getElementById('triage-btn-new-rule');
  const applyAllBtn = document.getElementById('triage-btn-apply-all');
  const ruleEditor = document.getElementById('triage-rule-editor');
  const ruleNameInput = document.getElementById('triage-rule-name');
  const ruleMatchSelect = document.getElementById('triage-rule-match');
  const condListEl = document.getElementById('triage-cond-list');
  const addCondBtn = document.getElementById('triage-btn-add-cond');
  const actionStateSelect = document.getElementById('triage-action-state');
  const actionHoursWrap = document.getElementById('triage-later-hours-wrap');
  const actionHoursInput = document.getElementById('triage-action-later-hours');
  const actionReadCheck = document.getElementById('triage-action-read');
  const actionStarCheck = document.getElementById('triage-action-star');
  const tagPicksEl = document.getElementById('triage-tag-picks');
  const previewBox = document.getElementById('triage-rule-preview');
  const previewBtn = document.getElementById('triage-btn-preview-rule');
  const cancelRuleBtn = document.getElementById('triage-btn-cancel-rule');
  const rulesListEl = document.getElementById('triage-rules-list');

  let activeTab = 'subs';
  let subData = null;
  let rulesData = [];
  let tagsCatalog = [];
  let editingRuleId = null;

  function accountId() {
    return typeof activeMailAccount === 'function' ? (activeMailAccount()?.id || '') : '';
  }

  function accountHeaders(acc = accountId()) {
    return acc ? { 'X-MailAI-Account': acc } : {};
  }

  function switchTab(tab) {
    activeTab = tab;
    tabBtns.forEach(btn => {
      const on = btn.dataset.triageTab === tab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    subsPane.classList.toggle('hidden', tab !== 'subs');
    rulesPane.classList.toggle('hidden', tab !== 'rules');
  }

  function renderSubs() {
    const s = subData?.summary;
    if (!s) {
      subSummaryEl.innerHTML = '';
    } else {
      const cards = [
        { label: mailaiText('高频推送源'), value: mailaiTemplate`${s.total_groups || 0} 个` },
        { label: mailaiText('可整理邮件'), value: mailaiTemplate`${s.total_emails || 0} 封` },
        { label: mailaiText('未读推送'), value: mailaiTemplate`${s.unread_emails || 0} 封` },
        { label: mailaiText('含退订协议'), value: mailaiTemplate`${s.with_unsubscribe || 0} 个` },
      ];
      subSummaryEl.innerHTML = cards
        .map(
          c => `
          <div class="triage-metric">
            <span class="triage-metric-label">${esc(c.label)}</span>
            <strong class="triage-metric-value">${esc(c.value)}</strong>
          </div>`
        )
        .join('');
    }

    const groups = subData?.groups || [];
    if (!groups.length) {
      subListEl.innerHTML = `<div class="triage-empty">${esc(mailaiText('暂未识别到重复通知或订阅推送，收件箱较为干净。'))}</div>`;
      return;
    }

    subListEl.innerHTML = groups
      .map(g => {
        const unsubHtml = (g.unsubscribe_links || [])
          .slice(0, 1)
          .map(
            lk => `<a class="triage-unsub-link" href="${esc(lk.target)}" target="_blank" rel="noopener noreferrer" title="${esc(mailaiText('点击后在外部打开退订链接，请先确认发件人可信'))}">${esc(lk.kind === 'mailto' ? mailaiText('查看退订邮箱') : mailaiText('打开退订页'))}</a>`
          )
          .join('');
        return `
          <article class="triage-card" data-sender-addr="${esc(g.sender_addr)}">
            <div class="triage-card-top">
              <div class="triage-card-title">
                <span class="triage-sender-name">${esc(g.sender_name || g.sender_addr)}</span>
                <span class="triage-sender-addr">${esc(g.sender_addr)}</span>
                <span class="triage-pill accent">${esc(mailaiTemplate`共 ${g.total_count} 封`)}</span>
                ${g.unread_count ? `<span class="triage-pill warn">${esc(mailaiTemplate`未读 ${g.unread_count} 封`)}</span>` : ''}
                ${g.has_active_rule ? `<span class="triage-pill done">${esc(mailaiText('已设自动规则'))}</span>` : ''}
              </div>
              <div class="triage-card-actions">
                <button type="button" class="triage-mini-btn" data-sub-action="keep_latest_done" data-sender="${esc(g.sender_addr)}" ${g.total_count < 2 ? 'disabled' : ''}>${esc(mailaiText('留最新 · 其余已读已处理'))}</button>
                <button type="button" class="triage-mini-btn" data-sub-action="all_done" data-sender="${esc(g.sender_addr)}" ${!g.unread_count && !g.unhandled_count ? 'disabled' : ''}>${esc(mailaiText('全部已读已处理'))}</button>
                <button type="button" class="triage-mini-btn" data-sub-rule="${esc(g.sender_addr)}">${esc(mailaiText('设为自动规则'))}</button>
              </div>
            </div>
            <div class="triage-card-meta">
              <span>${esc(mailaiTemplate`最近主题：${g.latest_subject || '—'}`)}</span>
              ${(g.reasons || []).map(r => `<span class="triage-pill">${esc(r)}</span>`).join('')}
              ${unsubHtml}
            </div>
          </article>`;
      })
      .join('');
  }

  function formatRuleSummary(rule) {
    const conds = (rule.conditions || []).map(c => {
      if (c.field === 'is_subscription') return mailaiText('识别为订阅推送');
      const fMap = {
        sender: mailaiText('发件人'),
        domain: mailaiText('发件域名'),
        subject: mailaiText('主题'),
        body: mailaiText('正文'),
      };
      const oMap = {
        contains: mailaiText('包含'),
        equals: mailaiText('等于'),
        not_contains: mailaiText('不包含'),
      };
      return `${fMap[c.field] || c.field} ${oMap[c.operator] || c.operator} "${c.value}"`;
    });
    const a = rule.actions || {};
    const acts = [];
    if (a.handle_state === 'done') acts.push(mailaiText('标为已处理'));
    if (a.handle_state === 'later') acts.push(mailaiTemplate`延后 ${a.later_hours || 24} 小时`);
    if (a.handle_state === 'reply') acts.push(mailaiText('标为待回复'));
    if (a.mark_read) acts.push(mailaiText('设为已读'));
    if (a.mark_starred) acts.push(mailaiText('加星标'));
    if ((a.tag_ids || []).length) {
      const names = a.tag_ids
        .map(id => tagsCatalog.find(t => t.id === id)?.name)
        .filter(Boolean);
      if (names.length) acts.push(mailaiTemplate`打标签：${names.join('、')}`);
    }
    return {
      when: conds.join(rule.match_mode === 'any' ? ` ${mailaiText('或')} ` : ` ${mailaiText('且')} `),
      then: acts.join(' · '),
    };
  }

  function renderRules() {
    if (!rulesData.length) {
      rulesListEl.innerHTML = `<div class="triage-empty">${esc(mailaiText('尚未配置自动分流规则，点击「+ 新建分流规则」即可按发件人、域名或主题自动归档与已读。'))}</div>`;
      return;
    }
    rulesListEl.innerHTML = rulesData
      .map(rule => {
        const desc = formatRuleSummary(rule);
        return `
          <article class="triage-card" data-rule-id="${rule.id}">
            <div class="triage-card-top">
              <div class="triage-card-title">
                <span class="triage-sender-name">${esc(rule.name)}</span>
                <span class="triage-pill ${rule.enabled ? 'done' : ''}">${esc(rule.enabled ? mailaiText('已启用') : mailaiText('已停用'))}</span>
                <span class="triage-pill">${esc(mailaiTemplate`已命中 ${rule.hit_count || 0} 次`)}</span>
              </div>
              <div class="triage-card-actions">
                <button type="button" class="triage-mini-btn" data-rule-action="toggle" data-rule-id="${rule.id}" data-enabled="${rule.enabled ? '1' : '0'}">${esc(rule.enabled ? mailaiText('停用') : mailaiText('启用'))}</button>
                <button type="button" class="triage-mini-btn" data-rule-action="apply" data-rule-id="${rule.id}">${esc(mailaiText('立即运行'))}</button>
                <button type="button" class="triage-mini-btn" data-rule-action="edit" data-rule-id="${rule.id}">${esc(mailaiText('编辑'))}</button>
                <button type="button" class="triage-mini-btn danger" data-rule-action="delete" data-rule-id="${rule.id}">${esc(mailaiText('删除'))}</button>
              </div>
            </div>
            <div class="triage-card-meta">
              <span>${esc(mailaiTemplate`条件：${desc.when}`)}</span>
              <span>${esc(mailaiTemplate`动作：${desc.then}`)}</span>
            </div>
          </article>`;
      })
      .join('');
  }

  function renderCondRow(cond = { field: 'sender', operator: 'contains', value: '' }) {
    const row = document.createElement('div');
    row.className = 'triage-cond-row';
    const isSub = cond.field === 'is_subscription';
    row.innerHTML = `
      <select class="triage-cond-field">
        <option value="sender" ${cond.field === 'sender' ? 'selected' : ''}>${esc(mailaiText('发件人'))}</option>
        <option value="domain" ${cond.field === 'domain' ? 'selected' : ''}>${esc(mailaiText('发件域名'))}</option>
        <option value="subject" ${cond.field === 'subject' ? 'selected' : ''}>${esc(mailaiText('主题'))}</option>
        <option value="body" ${cond.field === 'body' ? 'selected' : ''}>${esc(mailaiText('正文'))}</option>
        <option value="is_subscription" ${isSub ? 'selected' : ''}>${esc(mailaiText('识别为订阅推送'))}</option>
      </select>
      <select class="triage-cond-op" ${isSub ? 'hidden' : ''}>
        <option value="contains" ${cond.operator === 'contains' ? 'selected' : ''}>${esc(mailaiText('包含'))}</option>
        <option value="equals" ${cond.operator === 'equals' ? 'selected' : ''}>${esc(mailaiText('等于'))}</option>
        <option value="not_contains" ${cond.operator === 'not_contains' ? 'selected' : ''}>${esc(mailaiText('不包含'))}</option>
      </select>
      <input type="text" class="triage-cond-val" maxlength="300" placeholder="${esc(mailaiText('填写关键词或发件人地址'))}" value="${esc(isSub ? '1' : cond.value || '')}" ${isSub ? 'hidden' : ''}>
      <button type="button" class="triage-mini-btn danger triage-cond-del">${esc(mailaiText('移除'))}</button>`;
    const fieldSel = row.querySelector('.triage-cond-field');
    const opSel = row.querySelector('.triage-cond-op');
    const valInput = row.querySelector('.triage-cond-val');
    fieldSel.addEventListener('change', () => {
      const sub = fieldSel.value === 'is_subscription';
      opSel.hidden = sub;
      valInput.hidden = sub;
      if (sub) valInput.value = '1';
      else if (valInput.value === '1') valInput.value = '';
    });
    row.querySelector('.triage-cond-del').addEventListener('click', () => {
      if (condListEl.children.length > 1) row.remove();
    });
    condListEl.appendChild(row);
  }

  function renderTagPicker(selectedIds = []) {
    const selectedSet = new Set(selectedIds);
    if (!tagsCatalog.length) {
      tagPicksEl.innerHTML = `<span class="triage-note">${esc(mailaiText('暂无个人标签'))}</span>`;
      return;
    }
    tagPicksEl.innerHTML = tagsCatalog
      .map(
        t => `
        <label class="triage-tag-pick">
          <input type="checkbox" class="triage-tag-check" value="${t.id}" ${selectedSet.has(t.id) ? 'checked' : ''}>
          <span>${esc(t.name)}</span>
        </label>`
      )
      .join('');
  }

  function openRuleEditor(preset = null) {
    editingRuleId = preset?.id || null;
    ruleNameInput.value = preset?.name || '';
    ruleMatchSelect.value = preset?.match_mode || 'all';
    condListEl.innerHTML = '';
    const conds = preset?.conditions?.length
      ? preset.conditions
      : [{ field: 'sender', operator: 'contains', value: '' }];
    conds.forEach(renderCondRow);
    const acts = preset?.actions || {};
    actionStateSelect.value = acts.handle_state || '';
    actionHoursInput.value = String(acts.later_hours || 24);
    actionHoursWrap.classList.toggle('hidden', actionStateSelect.value !== 'later');
    actionReadCheck.checked = Boolean(acts.mark_read);
    actionStarCheck.checked = Boolean(acts.mark_starred);
    renderTagPicker(acts.tag_ids || []);
    previewBox.classList.add('hidden');
    previewBox.innerHTML = '';
    ruleEditor.classList.remove('hidden');
    ruleNameInput.focus();
  }

  function collectRulePayload() {
    const conditions = [...condListEl.querySelectorAll('.triage-cond-row')].map(row => ({
      field: row.querySelector('.triage-cond-field').value,
      operator: row.querySelector('.triage-cond-op').value,
      value: row.querySelector('.triage-cond-val').value.trim(),
    }));
    const tag_ids = [...tagPicksEl.querySelectorAll('.triage-tag-check:checked')].map(el => Number(el.value));
    const payload = {
      name: ruleNameInput.value.trim(),
      match_mode: ruleMatchSelect.value,
      conditions,
      actions: {
        handle_state: actionStateSelect.value,
        later_hours: Number(actionHoursInput.value) || 24,
        mark_read: actionReadCheck.checked,
        mark_starred: actionStarCheck.checked,
        tag_ids,
      },
    };
    if (editingRuleId !== null) payload.id = editingRuleId;
    return payload;
  }

  async function loadAll() {
    subListEl.innerHTML = `<div class="triage-empty">${esc(mailaiText('正在扫描高频通知与订阅邮件…'))}</div>`;
    try {
      const [subs, rulesRes, tagsRes] = await Promise.all([
        api('/api/productivity/triage/subscriptions', { headers: accountHeaders() }),
        api('/api/productivity/triage/rules', { headers: accountHeaders() }),
        api('/api/mail/tags', { headers: accountHeaders() }).catch(() => ({ tags: [] })),
      ]);
      subData = subs;
      rulesData = rulesRes.rules || [];
      tagsCatalog = tagsRes.tags || [];
      renderSubs();
      renderRules();
    } catch (e) {
      const msg = e.message || mailaiText('加载订阅与分流数据失败');
      subListEl.innerHTML = `<div class="triage-empty">${esc(msg)}</div>`;
    }
  }

  async function openModal(initialTab = 'subs') {
    if (typeof closeTodoCenter === 'function') closeTodoCenter();
    if (typeof closeAssistant === 'function') closeAssistant();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    ruleEditor.classList.add('hidden');
    switchTab(initialTab);
    await loadAll();
  }

  function closeModal() {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  tabBtns.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.triageTab || 'subs')));
  subRefreshBtn.addEventListener('click', loadAll);
  newRuleBtn.addEventListener('click', () => openRuleEditor());
  addCondBtn.addEventListener('click', () => renderCondRow());
  cancelRuleBtn.addEventListener('click', () => ruleEditor.classList.add('hidden'));
  actionStateSelect.addEventListener('change', () => {
    actionHoursWrap.classList.toggle('hidden', actionStateSelect.value !== 'later');
  });

  subListEl.addEventListener('click', async ev => {
    const batchBtn = ev.target.closest('[data-sub-action]');
    if (batchBtn) {
      const mode = batchBtn.dataset.subAction;
      const sender = batchBtn.dataset.sender;
      batchBtn.disabled = true;
      try {
        const res = await api('/api/productivity/triage/sender-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...accountHeaders() },
          body: JSON.stringify({ sender_addr: sender, mode }),
        });
        toast(mailaiTemplate`已批量处理 ${res.updated_count || 0} 封订阅推送`, 'success');
        if (typeof loadEmails === 'function') loadEmails();
        await loadAll();
      } catch (e) {
        batchBtn.disabled = false;
        toast(e.message || mailaiText('批量降噪失败'), 'error');
      }
      return;
    }

    const ruleBtn = ev.target.closest('[data-sub-rule]');
    if (ruleBtn) {
      const addr = ruleBtn.dataset.subRule;
      switchTab('rules');
      openRuleEditor({
        name: mailaiTemplate`自动归档：${addr}`,
        match_mode: 'all',
        conditions: [{ field: 'sender', operator: 'equals', value: addr }],
        actions: { handle_state: 'done', mark_read: true, mark_starred: false, tag_ids: [] },
      });
    }
  });

  previewBtn.addEventListener('click', async () => {
    try {
      const payload = collectRulePayload();
      const res = await api('/api/productivity/triage/rules/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...accountHeaders() },
        body: JSON.stringify(payload),
      });
      previewBox.classList.remove('hidden');
      if (!res.matched_count) {
        previewBox.innerHTML = `<span>${esc(mailaiText('当前收件箱暂无匹配邮件，规则保存后将对新到达邮件生效。'))}</span>`;
      } else {
        const lines = (res.items || []).slice(0, 6).map(
          it => `<div>• ${esc(it.subject)} <span class="triage-note">(${esc(it.from_addr)})</span></div>`
        );
        previewBox.innerHTML = `<strong>${esc(mailaiTemplate`共命中 ${res.matched_count} 封收件箱邮件：`)}</strong>${lines.join('')}`;
      }
    } catch (e) {
      toast(e.message || mailaiText('预览规则失败'), 'error');
    }
  });

  ruleEditor.addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      const payload = collectRulePayload();
      await api('/api/productivity/triage/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...accountHeaders() },
        body: JSON.stringify(payload),
      });
      ruleEditor.classList.add('hidden');
      toast(mailaiText('自动分流规则已保存'), 'success');
      await loadAll();
    } catch (e) {
      toast(e.message || mailaiText('保存规则失败'), 'error');
    }
  });

  applyAllBtn.addEventListener('click', async () => {
    applyAllBtn.disabled = true;
    try {
      const res = await api('/api/productivity/triage/rules/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...accountHeaders() },
        body: JSON.stringify({}),
      });
      toast(mailaiTemplate`已执行分流规则：命中 ${res.matched || 0} 封，更新 ${res.updated || 0} 封`, 'success');
      if (typeof loadEmails === 'function') loadEmails();
      await loadAll();
    } catch (e) {
      toast(e.message || mailaiText('执行规则失败'), 'error');
    } finally {
      applyAllBtn.disabled = false;
    }
  });

  rulesListEl.addEventListener('click', async ev => {
    const btn = ev.target.closest('[data-rule-action]');
    if (!btn) return;
    const action = btn.dataset.ruleAction;
    const ruleId = Number(btn.dataset.ruleId);
    const targetRule = rulesData.find(r => r.id === ruleId);
    if (!ruleId || !targetRule) return;

    if (action === 'edit') {
      openRuleEditor(targetRule);
      return;
    }
    if (action === 'toggle') {
      await api(`/api/productivity/triage/rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...accountHeaders() },
        body: JSON.stringify({ enabled: btn.dataset.enabled !== '1' }),
      });
      await loadAll();
      return;
    }
    if (action === 'apply') {
      const res = await api('/api/productivity/triage/rules/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...accountHeaders() },
        body: JSON.stringify({ rule_id: ruleId }),
      });
      toast(mailaiTemplate`规则已运行：命中 ${res.matched || 0} 封，更新 ${res.updated || 0} 封`, 'success');
      if (typeof loadEmails === 'function') loadEmails();
      await loadAll();
      return;
    }
    if (action === 'delete') {
      await api(`/api/productivity/triage/rules/${ruleId}`, {
        method: 'DELETE',
        headers: accountHeaders(),
      });
      toast(mailaiText('已删除自动分流规则'), 'success');
      await loadAll();
    }
  });

  const todoMenuTrigger = document.getElementById('btn-todo-open-triage');
  if (todoMenuTrigger) {
    todoMenuTrigger.addEventListener('click', () => {
      document.getElementById('todo-options')?.removeAttribute('open');
      if (typeof closeTodoCenter === 'function') closeTodoCenter();
      openModal('subs');
    });
  }

  const closeBtn = document.getElementById('btn-close-triage');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  modal.querySelectorAll('[data-close-triage]').forEach(el => el.addEventListener('click', closeModal));

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });

  window.openTriageCenter = openModal;
  window.closeTriageCenter = closeModal;
})();
