/* Manage opt-in sent-mail learning inside XiaoYou's existing memory dialog. */
(() => {
  const key = name => `writingMemory.${name}`;
  const copy = name => mailaiT(key(name)) || MAILAI_UI_COPY[key(name)]?.[0] || name;
  const button = (action, label) => `<button type="button" data-writing-action="${action}" data-i18n="${key(label)}">${esc(copy(label))}</button>`;
  const options = {
    language:['zh','en'], length:['short','medium','long'], opening:['conclusion'],
    subject:['action'], tone:['formal','friendly'], structure:['list'],
  };

  function markChange(before, after) {
    let start = 0, end = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) end++;
    const mark = (text, tag) => esc(text.slice(0, start)) + `<${tag}>${esc(text.slice(start, text.length - end))}</${tag}>` + esc(end ? text.slice(-end) : '');
    return [mark(before, 'del'), mark(after, 'ins')];
  }

  function evidenceMarkup(item) {
    if (!item.evidence.length) return '';
    const heading = copy('evidence').replace('{count}', item.count);
    return `<div class="writing-memory-sources"><small>${esc(heading)}</small>${item.evidence.map(entry => {
      const comparison = entry.before && entry.after ? markChange(entry.before, entry.after) : null;
      return `<div class="writing-memory-evidence">
        <div class="writing-memory-evidence-heading"><button type="button" data-writing-source="${esc(entry.source)}" data-writing-id="${Number(entry.id)}">${esc(entry.subject || copy('noSubject'))}</button>
        <time>${esc(fmtDate(entry.date))}</time></div>
        ${comparison ? `<details class="writing-memory-comparison"><summary data-i18n="writingMemory.compare">${esc(copy('compare'))}</summary><div class="writing-memory-diff">
          <blockquote><b data-i18n="writingMemory.aiBefore">${esc(copy('aiBefore'))}</b><div>${comparison[0]}</div></blockquote>
          <blockquote><b data-i18n="writingMemory.sentAfter">${esc(copy('sentAfter'))}</b><div>${comparison[1]}</div></blockquote>
        </div></details>` : ''}</div>`;
    }).join('')}</div>`;
  }

  function ruleMarkup(rule) {
    const target = rule.scope === 'contact' ? rule.target : rule.scope === 'role' ? copy('role.' + rule.target) : copy('scope.account');
    const value = rule.field === 'salutation' ? rule.value : copy('value.' + rule.value);
    const control = rule.field === 'salutation'
      ? `<input name="rule_value" maxlength="40" value="${esc(value)}">`
      : `<select name="rule_value">${(options[rule.field] || []).map(option =>
        `<option value="${option}" data-i18n="writingMemory.value.${option}" ${option === rule.value ? 'selected' : ''}>${esc(copy('value.' + option))}</option>`).join('')}</select>`;
    const metadata = [target, copy('scene.' + rule.scene), rule.status === 'paused' ? copy('paused') : '',
      rule.edited ? (mailaiT('work.manuallyEdited') || MAILAI_UI_COPY['work.manuallyEdited'][0]) : ''].filter(Boolean);
    return `<details class="writing-memory-row" data-writing-rule="${rule.id}">
      <summary><span><strong>${esc(value)}</strong><small>${esc(metadata.join(' · '))}</small></span>
        <small class="writing-memory-field">${esc(copy('field.' + rule.field))}</small></summary>
      <div class="writing-memory-row-body">
      ${evidenceMarkup(rule)}
      <div class="work-memory-item-actions">
        ${rule.status === 'paused' ? button('resume','resume') : button('pause','pause')}
        <button type="button" data-writing-action="edit" data-i18n="work.edit">${esc(mailaiT('work.edit') || MAILAI_UI_COPY['work.edit'][0])}</button>
        <button type="button" data-writing-action="delete" data-i18n="work.deleteMemory">${esc(mailaiT('work.deleteMemory') || MAILAI_UI_COPY['work.deleteMemory'][0])}</button>
      </div>
      <div class="writing-memory-editor" hidden>
        <label><span data-i18n="writingMemory.field.${esc(rule.field)}">${esc(copy('field.' + rule.field))}</span>${control}</label>
        ${rule.scope !== 'account' && rule.field !== 'salutation' ? `<label><span data-i18n="writingMemory.scope">${esc(copy('scope'))}</span>
          <select name="rule_scope"><option value="${rule.scope}">${esc(target)}</option><option value="account" data-i18n="writingMemory.scope.account">${esc(copy('scope.account'))}</option></select></label>` : ''}
        <div class="work-memory-edit-actions">
          <button type="button" data-writing-action="save" data-i18n="work.saveEdit">${esc(mailaiT('work.saveEdit') || MAILAI_UI_COPY['work.saveEdit'][0])}</button>
          <button type="button" data-writing-action="cancel" data-i18n="work.cancel">${esc(mailaiT('work.cancel') || MAILAI_UI_COPY['work.cancel'][0])}</button>
        </div>
      </div>
      </div>
    </details>`;
  }

  window.mountWritingMemory = (dialog, account) => {
    const panel = document.createElement('details');
    panel.className = 'work-memory-learning writing-memory-panel';
    panel.innerHTML = `<summary data-i18n="writingMemory.title">${esc(copy('title'))}</summary>
      <p class="writing-memory-hint" data-i18n="writingMemory.hint">${esc(copy('hint'))}</p>
      <div class="writing-memory-toolbar">
        <small role="status" data-writing-status></small>
        <div class="work-memory-edit-actions writing-memory-controls">
          <label><span data-i18n="writingMemory.history">${esc(copy('history'))}</span><select data-writing-days>
            ${[30,90,180].map(days => `<option value="${days}" ${days === 90 ? 'selected' : ''}>${esc(copy('days').replace('{count}', days))}</option>`).join('')}
          </select></label>
          ${button('collect','pauseCollection')}${button('clear','clear')}
        </div>
      </div>
      <div data-writing-rules></div>
      <footer class="work-memory-pagination" hidden>
        <button type="button" data-writing-action="prev" data-i18n="work.previous">${esc(mailaiT('work.previous') || MAILAI_UI_COPY['work.previous'][0])}</button>
        <span data-writing-page></span>
        <button type="button" data-writing-action="next" data-i18n="work.next">${esc(mailaiT('work.next') || MAILAI_UI_COPY['work.next'][0])}</button>
      </footer>`;
    dialog.append(panel);
    const session = new AbortController();
    const endpoint = '/api/work/writing-memory';
    const list = panel.querySelector('[data-writing-rules]');
    const status = panel.querySelector('[data-writing-status]');
    const days = panel.querySelector('[data-writing-days]');
    const collect = panel.querySelector('[data-writing-action="collect"]');
    const clear = panel.querySelector('[data-writing-action="clear"]');
    const footer = panel.querySelector('footer');
    const current = () => dialog.open && dialog.isConnected && activeMailAccount()?.id === account.id;
    const request = (path = '', method = 'GET', json) => api(endpoint + path, {
      accountId:account.id, signal:session.signal, method,
      ...(json ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(json)} : {}),
    });
    const showStatus = (key, values = {}) => {
      mailaiBindUI(status, 'textContent', () => key ? Object.entries(values).reduce((s,[name,value]) => s.replace(`{${name}}`, value), copy(key)) : '');
    };
    let busy = false, data = null, offset = 0, shown = '', renderedItems = [];
    const pageSize = 12;

    function render({preserveOpen = true} = {}) {
      if (!data) return;
      const settings = data.settings;
      mailaiBindUI(collect, 'textContent', () => copy(settings.collect ? 'pauseCollection' : 'resumeCollection'));
      if (settings.days) days.value = String(settings.days);
      days.closest('label').hidden = !settings.initialized || Boolean(settings.cleared);
      days.disabled = busy || !settings.enabled || !settings.collect;
      collect.hidden = !settings.initialized;
      clear.hidden = !settings.initialized;
      collect.disabled = busy || !settings.enabled;
      clear.disabled = busy;
      showStatus(!settings.enabled ? 'masterOff' : settings.initialized ? 'observed' : 'waitingModel', {count:data.observed});
      footer.hidden = data.total <= pageSize;
      footer.querySelector('[data-writing-page]').textContent = data.total ? `${offset + 1}–${offset + data.items.length} / ${data.total}` : '';
      footer.querySelector('[data-writing-action="prev"]').disabled = busy || !offset;
      footer.querySelector('[data-writing-action="next"]').disabled = busy || offset + data.items.length >= data.total;
      const signature = JSON.stringify([currentI18nLanguage(), settings.initialized, data.items]);
      if (shown === signature || preserveOpen && list.querySelector('.writing-memory-editor:not([hidden]), details[open], :focus-visible')) return;
      const openIds = new Set([...list.querySelectorAll('[data-writing-rule][open]')].map(row => row.dataset.writingRule));
      list.innerHTML = data.items.length ? data.items.map(ruleMarkup).join('') :
        settings.initialized ? `<p class="writing-memory-empty">${esc(copy('empty'))}</p>` : '';
      for (const row of list.querySelectorAll('[data-writing-rule]')) row.open = openIds.has(row.dataset.writingRule);
      renderedItems = data.items;
      shown = signature;
    }

    async function run(action, {quiet = false} = {}) {
      if (busy || !current()) return;
      busy = true;
      panel.setAttribute('aria-busy','true');
      try {
        if (action) await action();
        if (!current()) return;
        data = await request(`?offset=${offset}&limit=${pageSize}`);
        if (offset && !data.items.length) {
          offset = 0;
          data = await request(`?offset=0&limit=${pageSize}`);
        }
        if (current()) {
          busy = false;
          render({preserveOpen:quiet});
        }
      } catch (_) {
        if (!quiet && current()) showStatus('refreshError');
      } finally {
        busy = false;
        panel.removeAttribute('aria-busy');
      }
    }

    collect.disabled = clear.disabled = true;
    days.addEventListener('change', () => {
      if (!data || busy || !current()) return;
      void run(() => request('/settings','PUT',{collect:data.settings.collect,days:Number(days.value),revision:data.settings.revision}));
    });
    panel.addEventListener('toggle', () => { if (panel.open) void run(); });
    const timer = setInterval(() => {
      if (panel.open && !document.hidden && !list.querySelector('.writing-memory-editor:not([hidden])')) void run(null, {quiet:true});
    }, 6000);
    document.addEventListener('mailai:language-changed', () => {
      for (const option of days.options) option.textContent = copy('days').replace('{count}', option.value);
      if (panel.open && current()) render({preserveOpen:Boolean(list.querySelector('.writing-memory-editor:not([hidden])'))});
    }, {signal:session.signal});
    dialog.addEventListener('close', () => { clearInterval(timer); session.abort(); }, {once:true});

    panel.addEventListener('click', async event => {
      const trigger = event.target.closest('button');
      if (!trigger || trigger.disabled || busy || !data || !current()) return;
      if (trigger.dataset.writingSource) {
        const id = Number(trigger.dataset.writingId);
        const source = trigger.dataset.writingSource;
        try {
          const mail = await api(source === 'local' ? `/api/mail/sent/${id}` : `/api/emails/${id}`, {accountId:account.id});
          if (!current()) return;
          if (source === 'server' && (mail.status !== 'sent' || mail.remote_missing)) throw new Error('unavailable');
          dialog.close(); hideSystemView();
          await openAccountMailbox(account.id, 'sent');
          if (activeMailAccount()?.id !== account.id || specialMailbox !== 'sent') return;
          if (source === 'local' && !sentMessages.some(item => Number(item.id) === id)) throw new Error('unavailable');
          const row = source === 'local' ? mail : {...mail,id:-id,_remote:true,remote_email_id:id,sent_at:mail.date};
          await selectSpecialMessage(row.id, row);
        } catch (_) { if (current()) showStatus('refreshError'); }
        return;
      }
      const action = trigger.dataset.writingAction;
      if (action === 'collect') {
        await run(() => request('/settings','PUT',{collect:!data.settings.collect,days:Number(days.value),revision:data.settings.revision}));
        return;
      }
      if (action === 'clear') {
        const confirmed = await mailaiAsk({title:copy('clear'),message:copy('clearHint'),confirmText:copy('confirmClear'),danger:true});
        if (confirmed && current()) await run(() => request('/clear','POST',{revision:data.settings.revision}));
        return;
      }
      if (action === 'next' || action === 'prev') {
        offset = Math.max(0, offset + (action === 'next' ? pageSize : -pageSize));
        await run();
        return;
      }
      const row = trigger.closest('[data-writing-rule]');
      const rule = renderedItems.find(item => item.id === Number(row?.dataset.writingRule));
      if (!rule) return;
      const editor = row.querySelector('.writing-memory-editor');
      if (action === 'edit') { editor.hidden = false; editor.querySelector('[name="rule_value"]').focus(); return; }
      if (action === 'cancel') { editor.hidden = true; row.querySelector('[data-writing-action="edit"]').focus(); return; }
      const payload = {action, revision:rule.revision};
      if (action === 'save') {
        payload.value = editor.querySelector('[name="rule_value"]').value;
        payload.scope = editor.querySelector('[name="rule_scope"]')?.value || rule.scope;
      }
      if (action === 'delete') {
        const label = mailaiT('work.deleteMemory') || MAILAI_UI_COPY['work.deleteMemory'][0];
        if (!await mailaiAsk({title:label,message:copy('deleteHint'),confirmText:label,danger:true}) || !current()) return;
      }
      await run(() => request(`/${rule.id}`,'PUT',payload));
      panel.querySelector(`[data-writing-rule="${rule.id}"] > summary`)?.focus({preventScroll:true});
    });
  };
})();
