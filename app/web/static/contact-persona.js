/* Communication personas for contacts, role presets, and smart compose matching. */
(() => {
  const ROLE_KEYS = ['leader', 'customer', 'colleague', 'partner'];
  const roleLabel = key => {
    const map = {
      leader: mailaiText('汇报对象 / 领导'),
      customer: mailaiText('客户 / 重要外部'),
      colleague: mailaiText('内部同事 / 协作'),
      partner: mailaiText('合作方 / 供应商'),
    };
    return map[key] || '';
  };
  const roleShortLabel = key => {
    const map = {
      leader: mailaiText('领导'),
      customer: mailaiText('客户'),
      colleague: mailaiText('同事'),
      partner: mailaiText('合作方'),
    };
    return map[key] || '';
  };
  const toneOptions = () => {
    const source = document.getElementById('compose-ai-tone');
    return source ? [...source.options].map(opt => ({ value: opt.value, label: opt.textContent })) : [];
  };

  // 1. Contact list role badge hook (wraps existing mailaiDirectoryContactLabel cleanly)
  const baseLabel = window.mailaiDirectoryContactLabel;
  window.mailaiDirectoryContactLabel = item => {
    const base = baseLabel ? baseLabel(item) : '';
    const persona = item?.persona || {};
    const rk = persona.role_key || '';
    if (!rk) return base;
    const label = roleShortLabel(rk) || persona.short_label || rk;
    const full = roleLabel(rk) || persona.role_label || label;
    const prefix = persona.role_source === 'explicit'
      ? mailaiTemplate`角色：${full}`
      : mailaiTemplate`识别：${full}`;
    const pill = `<em class="contact-role-pill" data-role-key="${esc(rk)}" data-role-source="${esc(persona.role_source || 'inferred')}" title="${esc(prefix)}">${esc(label)}</em>`;
    if (base) return base.replace('</div>', pill + '</div>');
    return `<div class="directory-contact-label contact-labels">${pill}</div>`;
  };

  // 2. Contact editor persona section
  const fieldsHost = document.querySelector('.contact-editor-fields');
  const favoriteCheck = fieldsHost?.querySelector('.contact-favorite-check');
  let personaSection = null;
  let cachedSignatures = [];
  const loadAccountSignatures = async accountId => {
    try {
      const data = await api('/api/mail/signatures', { accountId });
      cachedSignatures = Array.isArray(data?.items) ? data.items : [];
      return cachedSignatures;
    } catch (_) {
      return cachedSignatures;
    }
  };
  const fillSignatureOptions = (select, items, emptyLabel, selectedId) => {
    if (!select) return;
    select.innerHTML = `<option value="">${esc(emptyLabel)}</option>` +
      (items || []).map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    select.value = selectedId && (items || []).some(item => item.id === selectedId) ? selectedId : '';
  };

  if (fieldsHost && favoriteCheck) {
    personaSection = document.createElement('details');
    personaSection.className = 'persona-editor-details';
    const tones = toneOptions();
    personaSection.innerHTML = `
      <summary>
        <span>${esc(mailaiText('沟通画像与写作预设'))}</span>
        <small>${esc(mailaiText('用于写信、催办与小邮草拟时匹配语气与签名'))}</small>
      </summary>
      <div class="persona-editor-grid">
        <p class="persona-editor-detected" data-persona-detected hidden></p>
        <label>
          <span>${esc(mailaiText('沟通角色'))}</span>
          <select id="contact-persona-role">
            <option value="">${esc(mailaiText('自动识别'))}</option>
            ${ROLE_KEYS.map(key => `<option value="${key}">${esc(roleLabel(key))}</option>`).join('')}
          </select>
        </label>
        <label>
          <span>${esc(mailaiText('默认语气'))}</span>
          <select id="contact-persona-tone">
            <option value="">${esc(mailaiText('跟随角色预设'))}</option>
            ${tones.map(t => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('')}
          </select>
        </label>
        <label>
          <span>${esc(mailaiText('常用称呼'))}</span>
          <input id="contact-persona-salutation" maxlength="80" autocomplete="off" placeholder="${esc(mailaiText('例如：张总您好：'))}">
        </label>
        <label>
          <span>${esc(mailaiText('专属签名'))}</span>
          <select id="contact-persona-signature">
            <option value="">${esc(mailaiText('跟随角色或默认签名'))}</option>
          </select>
        </label>
        <label class="wide">
          <span>${esc(mailaiText('沟通与写作要求'))}</span>
          <textarea id="contact-persona-hint" rows="2" maxlength="400" placeholder="${esc(mailaiText('例如：先给结论与风险；对外称呼用贵司'))}"></textarea>
        </label>
      </div>`;
    favoriteCheck.before(personaSection);

    const prevEdit = window.mailaiDirectoryEdit;
    window.mailaiDirectoryEdit = item => {
      prevEdit?.(item);
      const comm = item?.comm_profile || {};
      const persona = item?.persona || {};
      document.getElementById('contact-persona-role').value = comm.role_key || '';
      document.getElementById('contact-persona-tone').value = comm.tone || '';
      document.getElementById('contact-persona-salutation').value = comm.salutation || '';
      document.getElementById('contact-persona-hint').value = comm.writing_hint || '';
      const detected = personaSection.querySelector('[data-persona-detected]');
      if (persona.role_source === 'inferred' && persona.role_key && !comm.role_key) {
        detected.hidden = false;
        detected.textContent = mailaiTemplate`当前识别：${roleLabel(persona.role_key) || persona.role_label || persona.role_key}`;
      } else {
        detected.hidden = true;
        detected.textContent = '';
      }
      personaSection.open = Boolean(comm.role_key || comm.tone || comm.salutation || comm.writing_hint || comm.signature_id);
      const sigSelect = document.getElementById('contact-persona-signature');
      const account = contactCenterSession?.accountId || activeMailAccount()?.id;
      fillSignatureOptions(sigSelect, cachedSignatures, mailaiText('跟随角色或默认签名'), comm.signature_id || '');
      if (account) {
        loadAccountSignatures(account).then(items => {
          fillSignatureOptions(sigSelect, items, mailaiText('跟随角色或默认签名'), comm.signature_id || '');
        });
      }
    };

    window.mailaiContactPersonaFields = () => ({
      role_key: document.getElementById('contact-persona-role')?.value || '',
      tone: document.getElementById('contact-persona-tone')?.value || '',
      salutation: document.getElementById('contact-persona-salutation')?.value.trim() || '',
      writing_hint: document.getElementById('contact-persona-hint')?.value.trim() || '',
      signature_id: document.getElementById('contact-persona-signature')?.value || '',
    });
  }

  // 3. Role Presets button & modal dialog
  const toolsBar = document.querySelector('#contact-center .contact-center-tools');
  const newContactBtn = document.getElementById('btn-new-contact');
  let rolePresetsDialog = null;
  let roleDialogRev = 0;

  async function openRolePresetsDialog(accountId) {
    if (!rolePresetsDialog) {
      rolePresetsDialog = document.createElement('dialog');
      rolePresetsDialog.id = 'role-presets-dialog';
      rolePresetsDialog.className = 'persona-dialog';
      rolePresetsDialog.setAttribute('aria-labelledby', 'role-presets-title');
      document.body.append(rolePresetsDialog);
    }
    const rev = ++roleDialogRev;
    const targetAccount = accountId || (document.body.classList.contains('compose-open') ? composeAccountId : '') || activeMailAccount()?.id || '';
    rolePresetsDialog.innerHTML = `
      <header>
        <div>
          <h2 id="role-presets-title">${esc(mailaiText('分角色写作与签名预设'))}</h2>
          <p>${esc(mailaiText('为不同沟通对象配置默认语气、称呼风格、写作要点与匹配签名；仅保存在当前邮箱。'))}</p>
        </div>
        <button type="button" data-persona-close aria-label="${esc(mailaiText('关闭'))}">✕</button>
      </header>
      <div class="persona-dialog-body"><p class="persona-dialog-status">${esc(mailaiText('正在加载…'))}</p></div>`;
    rolePresetsDialog.querySelector('[data-persona-close]').onclick = () => rolePresetsDialog.close();
    if (!rolePresetsDialog.open) rolePresetsDialog.showModal();
    try {
      const data = await api('/api/mail/contacts/role-presets', { accountId: targetAccount });
      if (!rolePresetsDialog.open || rev !== roleDialogRev) return;
      const sigs = data.signatures || [];
      const presets = data.presets || {};
      const tones = toneOptions();
      rolePresetsDialog.innerHTML = `
        <header>
          <div>
            <h2 id="role-presets-title">${esc(mailaiText('分角色写作与签名预设'))}</h2>
            <p>${esc(mailaiText('为不同沟通对象配置默认语气、称呼风格、写作要点与匹配签名；仅保存在当前邮箱。'))}</p>
          </div>
          <button type="button" data-persona-close aria-label="${esc(mailaiText('关闭'))}">✕</button>
        </header>
        <form>
          <div class="persona-dialog-body">
            ${ROLE_KEYS.map(key => {
              const p = presets[key] || {};
              return `
                <section class="role-preset-card" data-role-card="${key}">
                  <div class="role-preset-card-head">
                    <strong>${esc(roleLabel(key))}</strong>
                  </div>
                  <div class="role-preset-grid">
                    <label>
                      <span>${esc(mailaiText('默认语气'))}</span>
                      <select data-preset-field="tone">
                        ${tones.map(t => `<option value="${esc(t.value)}"${t.value === p.tone ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
                      </select>
                    </label>
                    <label>
                      <span>${esc(mailaiText('专属签名'))}</span>
                      <select data-preset-field="signature_id">
                        <option value="">${esc(mailaiText('使用全局默认签名'))}</option>
                        ${sigs.map(s => `<option value="${esc(s.id)}"${s.id === p.signature_id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
                      </select>
                    </label>
                    <label class="wide">
                      <span>${esc(mailaiText('称呼习惯参考'))}</span>
                      <input data-preset-field="salutation_hint" maxlength="120" value="${esc(p.salutation_hint || '')}">
                    </label>
                    <label class="wide">
                      <span>${esc(mailaiText('写作与措辞要点'))}</span>
                      <textarea data-preset-field="style_hint" rows="2" maxlength="400">${esc(p.style_hint || '')}</textarea>
                    </label>
                  </div>
                </section>`;
            }).join('')}
            <p class="persona-dialog-status" data-presets-status></p>
          </div>
          <footer>
            <button type="button" data-persona-close>${esc(mailaiText('取消'))}</button>
            <button type="submit" class="primary-action">${esc(mailaiText('保存角色预设'))}</button>
          </footer>
        </form>`;
      for (const close of rolePresetsDialog.querySelectorAll('[data-persona-close]')) {
        close.onclick = () => rolePresetsDialog.close();
      }
      rolePresetsDialog.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const submit = rolePresetsDialog.querySelector('[type="submit"]');
        const status = rolePresetsDialog.querySelector('[data-presets-status]');
        submit.disabled = true;
        status.classList.remove('is-error');
        status.textContent = mailaiText('正在保存…');
        const payload = {};
        for (const card of rolePresetsDialog.querySelectorAll('[data-role-card]')) {
          const key = card.dataset.roleCard;
          payload[key] = {
            tone: card.querySelector('[data-preset-field="tone"]').value,
            signature_id: card.querySelector('[data-preset-field="signature_id"]').value,
            salutation_hint: card.querySelector('[data-preset-field="salutation_hint"]').value.trim(),
            style_hint: card.querySelector('[data-preset-field="style_hint"]').value.trim(),
          };
        }
        try {
          await api('/api/mail/contacts/role-presets', {
            accountId: targetAccount,
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          rolePresetsDialog.close();
          toast(mailaiText('分角色写作预设已保存'), 'success');
          if (!document.getElementById('contact-center').classList.contains('hidden')) loadContactCenter?.();
          if (document.body.classList.contains('compose-open')) window.mailaiSyncComposePersona?.({ forceResolve: true });
        } catch (err) {
          status.textContent = mailaiSystemMessage(err.message);
          status.classList.add('is-error');
        } finally {
          submit.disabled = false;
        }
      };
    } catch (err) {
      if (!rolePresetsDialog.open || rev !== roleDialogRev) return;
      rolePresetsDialog.querySelector('.persona-dialog-body').innerHTML = `<p class="persona-dialog-status is-error">${esc(mailaiSystemMessage(err.message))}</p>`;
    }
  }

  if (toolsBar && newContactBtn) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-role-presets';
    btn.className = 'persona-role-presets-btn';
    btn.setAttribute('aria-label', mailaiText('配置分角色写作与签名预设'));
    btn.textContent = mailaiText('角色写作预设');
    btn.onclick = () => openRolePresetsDialog(contactAccountId());
    newContactBtn.before(btn);
  }

  // 4. Compose Persona Strip + AI sidebar persona note + quick persona edit dialog
  const composeFields = document.querySelector('#compose-modal .compose-fields');
  const personaStrip = document.createElement('div');
  personaStrip.id = 'compose-persona-strip';
  personaStrip.className = 'compose-persona-strip hidden';
  composeFields?.after(personaStrip);

  const aiContextBlock = document.querySelector('#compose-ai-panel .compose-ai-context-block');
  const aiPersonaNote = document.createElement('p');
  aiPersonaNote.id = 'compose-ai-persona-note';
  aiPersonaNote.className = 'compose-ai-persona-note hidden';
  aiContextBlock?.append(aiPersonaNote);

  let latestResolution = null;
  let personaRevision = 0;
  let personaTimer = null;
  let quickDialog = null;

  function applyEffectiveMatch(resolution, { allowAuto = false, session = draftSession, seed = null } = {}) {
    const eff = resolution?.effective;
    if (!eff) return;
    if (session !== draftSession || !document.body.classList.contains('compose-open')) return;
    const toneEl = document.getElementById('compose-ai-tone');
    const canTouchSignature = allowAuto && !seed?.id && !session.personaTouchedSignature &&
      (!currentSignatureId || currentSignatureId === signatureState.default_id || (seed?.signature_id && seed.signature_id === eff.signature_id));
    if (canTouchSignature && eff.signature_id && signatureState.items.some(item => item.id === eff.signature_id) && currentSignatureId !== eff.signature_id) {
      renderComposeSignature(eff.signature_id);
    }
    const canTouchTone = allowAuto && !seed?.id && !session.personaTouchedTone;
    if (canTouchTone && eff.tone && toneEl && [...toneEl.options].some(o => o.value === eff.tone)) {
      toneEl.value = eff.tone;
    }
  }

  function renderAiPersonaNote() {
    const recipientCheckbox = document.querySelector('.compose-ai-context-options input[value="recipients"]');
    const eff = latestResolution?.effective;
    if (!document.body.classList.contains('compose-open') || !eff?.primary_email) {
      aiPersonaNote.classList.add('hidden');
      return;
    }
    if (!recipientCheckbox?.checked) {
      aiPersonaNote.classList.remove('hidden');
      aiPersonaNote.textContent = mailaiText('未勾选「收件人」参考项，AI 不会读取收件人画像');
      return;
    }
    if (!eff.has_context) {
      aiPersonaNote.classList.add('hidden');
      return;
    }
    aiPersonaNote.classList.remove('hidden');
    const summaryParts = [];
    if (eff.role_key) summaryParts.push(roleShortLabel(eff.role_key) || eff.short_label || eff.role_label);
    if (eff.tone) summaryParts.push(mailaiTemplate`语气：${eff.tone}`);
    if (eff.salutation) summaryParts.push(mailaiTemplate`称呼：${eff.salutation}`);
    if (eff.matched_memories?.length) summaryParts.push(mailaiTemplate`命中记忆 ${eff.matched_memories.length} 条`);
    aiPersonaNote.textContent = mailaiTemplate`已匹配收件人画像：${summaryParts.join(' · ') || eff.contact_summary}`;
  }

  function renderPersonaStrip() {
    const toValue = document.getElementById('compose-to')?.value || '';
    const eff = latestResolution?.effective;
    if (!document.body.classList.contains('compose-open') || !toValue.trim() || !eff?.primary_email) {
      personaStrip.classList.add('hidden');
      personaStrip.innerHTML = '';
      renderAiPersonaNote();
      return;
    }
    const toneEl = document.getElementById('compose-ai-tone');
    const needsApply = Boolean(
      (eff.signature_id && eff.signature_id !== currentSignatureId && signatureState.items.some(i => i.id === eff.signature_id)) ||
      (eff.tone && toneEl && toneEl.value !== eff.tone)
    );
    const rk = eff.role_key || '';
    const rolePill = rk
      ? `<em class="contact-role-pill" data-role-key="${esc(rk)}" data-role-source="${esc(eff.role_source || 'inferred')}">${esc(eff.role_source === 'explicit' ? mailaiTemplate`角色：${roleShortLabel(rk) || eff.short_label}` : mailaiTemplate`识别：${roleShortLabel(rk) || eff.short_label}`)}</em>`
      : `<span class="compose-persona-chip">${esc(mailaiText('未设角色 · 可补充称呼与签名'))}</span>`;
    const chips = [];
    if (eff.tone) chips.push(`<span class="compose-persona-chip">${esc(mailaiTemplate`语气：${eff.tone}`)}</span>`);
    if (eff.signature_name) chips.push(`<span class="compose-persona-chip">${esc(mailaiTemplate`签名：${eff.signature_name}`)}</span>`);
    if (eff.salutation) chips.push(`<span class="compose-persona-chip">${esc(mailaiTemplate`称呼：${eff.salutation}`)}</span>`);
    if (eff.matched_memories?.length) chips.push(`<span class="compose-persona-chip">${esc(mailaiTemplate`命中记忆 ${eff.matched_memories.length} 条`)}</span>`);

    personaStrip.classList.remove('hidden');
    personaStrip.innerHTML = `
      <div class="compose-persona-meta">
        ${rolePill}
        <span class="compose-persona-summary">${esc(eff.contact_summary || eff.primary_email)}</span>
        ${chips.join('')}
      </div>
      <div class="compose-persona-actions">
        ${eff.salutation ? `<button type="button" data-persona-action="insert-salutation">${esc(mailaiText('插入称呼'))}</button>` : ''}
        ${needsApply ? `<button type="button" class="is-suggested" data-persona-action="apply">${esc(mailaiText('应用匹配设置'))}</button>` : ''}
        <button type="button" data-persona-action="edit">${esc(mailaiText('调整画像'))}</button>
        <button type="button" data-persona-action="presets">${esc(mailaiText('角色写作预设'))}</button>
      </div>`;
    renderAiPersonaNote();
  }

  function openQuickPersonaDialog(primaryRecipient) {
    if (!primaryRecipient?.email) {
      toast(mailaiText('请先填写有效的收件人邮箱'), 'warn');
      return;
    }
    if (!quickDialog) {
      quickDialog = document.createElement('dialog');
      quickDialog.id = 'compose-persona-dialog';
      quickDialog.className = 'persona-dialog';
      quickDialog.setAttribute('aria-labelledby', 'quick-persona-title');
      document.body.append(quickDialog);
    }
    const saved = primaryRecipient.comm_profile || {};
    const sigs = signatureState.items || [];
    const tones = toneOptions();
    quickDialog.innerHTML = `
      <header>
        <div>
          <h2 id="quick-persona-title">${esc(mailaiText('调整收件人沟通画像'))}</h2>
          <p>${esc(primaryRecipient.display_name ? `${primaryRecipient.display_name} <${primaryRecipient.email}>` : primaryRecipient.email)} · ${esc(mailaiText('修改后仅保存在当前邮箱通讯录，并在下次写信、催办或回复时自动匹配。'))}</p>
        </div>
        <button type="button" data-persona-close aria-label="${esc(mailaiText('关闭'))}">✕</button>
      </header>
      <form>
        <div class="persona-dialog-body">
          <div class="role-preset-grid">
            <label>
              <span>${esc(mailaiText('沟通角色'))}</span>
              <select id="quick-persona-role">
                <option value="">${esc(mailaiText('自动识别'))}</option>
                ${ROLE_KEYS.map(key => `<option value="${key}"${key === saved.role_key ? ' selected' : ''}>${esc(roleLabel(key))}</option>`).join('')}
              </select>
            </label>
            <label>
              <span>${esc(mailaiText('默认语气'))}</span>
              <select id="quick-persona-tone">
                <option value="">${esc(mailaiText('跟随角色预设'))}</option>
                ${tones.map(t => `<option value="${esc(t.value)}"${t.value === saved.tone ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
              </select>
            </label>
            <label>
              <span>${esc(mailaiText('常用称呼'))}</span>
              <input id="quick-persona-salutation" maxlength="80" autocomplete="off" value="${esc(saved.salutation || '')}" placeholder="${esc(mailaiText('例如：张总您好：'))}">
            </label>
            <label>
              <span>${esc(mailaiText('专属签名'))}</span>
              <select id="quick-persona-signature">
                <option value="">${esc(mailaiText('跟随角色或默认签名'))}</option>
                ${sigs.map(s => `<option value="${esc(s.id)}"${s.id === saved.signature_id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
              </select>
            </label>
            <label class="wide">
              <span>${esc(mailaiText('沟通与写作要求'))}</span>
              <textarea id="quick-persona-hint" rows="3" maxlength="400" placeholder="${esc(mailaiText('例如：先给结论与风险；对外称呼用贵司'))}">${esc(saved.writing_hint || '')}</textarea>
            </label>
          </div>
          <p class="persona-dialog-status" data-quick-status></p>
        </div>
        <footer>
          <button type="button" data-persona-close>${esc(mailaiText('取消'))}</button>
          <button type="submit" class="primary-action">${esc(mailaiText('保存画像'))}</button>
        </footer>
      </form>`;
    for (const close of quickDialog.querySelectorAll('[data-persona-close]')) {
      close.onclick = () => quickDialog.close();
    }
    quickDialog.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const submit = quickDialog.querySelector('[type="submit"]');
      const status = quickDialog.querySelector('[data-quick-status]');
      submit.disabled = true;
      status.classList.remove('is-error');
      status.textContent = mailaiText('正在保存…');
      const account = composeAccountId;
      try {
        const res = await api('/api/mail/contacts/persona', {
          accountId: account,
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: primaryRecipient.email,
            role_key: document.getElementById('quick-persona-role').value,
            tone: document.getElementById('quick-persona-tone').value,
            salutation: document.getElementById('quick-persona-salutation').value.trim(),
            signature_id: document.getElementById('quick-persona-signature').value,
            writing_hint: document.getElementById('quick-persona-hint').value.trim(),
          }),
        });
        quickDialog.close();
        toast(mailaiText('联系人沟通画像已保存'), 'success');
        if (account === composeAccountId && document.body.classList.contains('compose-open')) {
          latestResolution = res;
          applyEffectiveMatch(res, { allowAuto: true, session: draftSession });
          renderPersonaStrip();
        }
      } catch (err) {
        status.textContent = mailaiSystemMessage(err.message);
        status.classList.add('is-error');
      } finally {
        submit.disabled = false;
      }
    };
    if (!quickDialog.open) quickDialog.showModal();
  }

  personaStrip.addEventListener('click', event => {
    const actionBtn = event.target.closest('[data-persona-action]');
    if (!actionBtn || !latestResolution) return;
    const action = actionBtn.dataset.personaAction;
    const eff = latestResolution.effective || {};
    if (action === 'insert-salutation' && eff.salutation) {
      const editor = composeMessageElement();
      const firstLine = `${eff.salutation}`;
      const existing = editor.innerText.trim();
      if (!existing.startsWith(firstLine)) {
        const p = document.createElement('p');
        p.textContent = firstLine;
        editor.prepend(p);
        queueDraftSave?.();
      }
      editor.focus();
      return;
    }
    if (action === 'apply') {
      if (eff.signature_id && signatureState.items.some(item => item.id === eff.signature_id)) {
        draftSession.personaTouchedSignature = false;
        renderComposeSignature(eff.signature_id);
        queueDraftSave?.();
      }
      const toneEl = document.getElementById('compose-ai-tone');
      if (eff.tone && toneEl && [...toneEl.options].some(o => o.value === eff.tone)) {
        draftSession.personaTouchedTone = false;
        toneEl.value = eff.tone;
      }
      renderPersonaStrip();
      toast(mailaiTemplate`已应用「${eff.role_label || eff.contact_summary || eff.primary_email}」写作语气与签名预设`, 'success');
      return;
    }
    if (action === 'edit') {
      openQuickPersonaDialog(latestResolution.recipients?.[0]);
      return;
    }
    if (action === 'presets') {
      openRolePresetsDialog(composeAccountId);
    }
  });

  window.mailaiSyncComposePersona = async (options = {}) => {
    const session = options.session || draftSession;
    const seed = options.seed || null;
    const account = composeAccountId;
    const recipients = document.getElementById('compose-to')?.value.trim() || '';
    if (!document.body.classList.contains('compose-open') || !recipients || !recipients.includes('@')) {
      latestResolution = null;
      renderPersonaStrip();
      return;
    }
    const rev = ++personaRevision;
    try {
      const res = await api('/api/mail/contacts/resolve-persona', {
        accountId: account,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients,
          include_memories: document.getElementById('work-use-preferences')?.checked !== false,
        }),
      });
      if (rev !== personaRevision || session !== draftSession || session.canceled || account !== composeAccountId || !document.body.classList.contains('compose-open')) {
        return;
      }
      latestResolution = res;
      applyEffectiveMatch(res, { allowAuto: true, session, seed });
      renderPersonaStrip();
    } catch (_) {
      /* Keep compose usable even if persona resolution fails transiently. */
    }
  };

  window.mailaiScheduleComposePersona = (delay = 240) => {
    clearTimeout(personaTimer);
    personaTimer = setTimeout(() => { window.mailaiSyncComposePersona?.(); }, delay);
  };

  document.getElementById('compose-ai-tone')?.addEventListener('change', () => {
    if (draftSession) draftSession.personaTouchedTone = true;
    renderPersonaStrip();
  });
  document.getElementById('compose-signature-select')?.addEventListener('change', () => {
    if (draftSession) draftSession.personaTouchedSignature = true;
    setTimeout(renderPersonaStrip, 0);
  });
  document.getElementById('compose-to')?.addEventListener('input', () => window.mailaiScheduleComposePersona(280));
  document.getElementById('compose-to')?.addEventListener('blur', () => window.mailaiScheduleComposePersona(40));
  document.querySelector('.compose-ai-context-options')?.addEventListener('change', renderAiPersonaNote);
  document.addEventListener('change', event => {
    if (event.target?.id === 'work-use-preferences') window.mailaiScheduleComposePersona(40);
  });
  new MutationObserver(() => {
    if (!document.body.classList.contains('compose-open')) {
      clearTimeout(personaTimer);
      latestResolution = null;
      renderPersonaStrip();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  globalThis.MailAIModules?.register('contactPersona', {
    schedule: () => window.mailaiScheduleComposePersona?.(0),
  });
})();
