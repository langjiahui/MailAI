/* Work assistance is lazy, account-bound and never submits a message. */
(() => {
  const w = key => mailaiT(`work.${key}`) || MAILAI_UI_COPY[`work.${key}`]?.[0] || key;
  const button = (action, label) => `<button type="button" data-work="${action}" data-i18n="work.${label}">${esc(w(label))}</button>`;
  let loaded = null, ticket = 0;
  window.mailaiWorkCard = email => ['trash','spam','quarantine','draft','sent'].includes(email.status) ? '' :
    `<section class="work-card" data-work-email="${Number(email.id)}" data-work-account="${esc(activeMailAccount()?.id || '')}"><header><b data-i18n="work.title">${esc(w('title'))}</b><div>${button('load','understand')}${button('reply','reply')}${email.attachments?.some(item => /\.(?:xlsx?|docx|pdf)$/i.test(item.name || '')) ? button('document','document') : ''}</div></header><div data-work-content hidden></div></section>`;
  const live = (host, account, id) => host.isConnected && activeMailAccount()?.id === account && selectedEmailDetail?.id === id;
  const post = body => ({headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  new MutationObserver(() => {
    if (loaded && !loaded.host.isConnected) loaded = null;
  }).observe(document.getElementById('reading-content'),{childList:true});
  function render(host, data) {
    const progress = data.progress;
    const content = host.querySelector('[data-work-content]');
    content.hidden = false;
    host.querySelector('[data-work="load"]').setAttribute('aria-expanded','true');
    const requests = data.requests.map(text => `<li>${esc(text)}</li>`).join('');
    const notes = data.context.filter(row => row.project || row.role || row.note);
    content.innerHTML = `<p><strong>${esc(mailaiSystemMessage(progress.status))}</strong> · ${esc(mailaiSystemMessage(progress.next_step))}</p>
      ${data.waiting_review ? `<p class="work-attention">${esc(w('waitingReview'))}</p>` : ''}
      ${requests ? `<details open><summary>${esc(w('requests'))}</summary><ul>${requests}</ul></details>` : `<p>${esc(w('noRequests'))}</p>`}
      ${progress.changes.items.length ? `<p>${esc(w('changes'))} ${progress.changes.items.length} · ${esc(progress.changes.items[0].quote)}</p>` : ''}
      ${notes.length ? `<details><summary>${esc(w('saved'))}</summary>${notes.map(row => `<article><b>${esc(row.project)}</b><p>${esc(row.role)}</p><p>${esc(row.note)}</p><small>${esc(row.updated_at)}</small></article>`).join('')}</details>` : ''}
      <div class="work-actions">${button('progress','progress')}${button('plan','plan')}${button('memory','memory')}${button('refresh','refresh')}</div><small>${esc(w('scope'))}</small>`;
  }
  async function load(host) {
    const account = host.dataset.workAccount, id = Number(host.dataset.workEmail), rev = ++ticket;
    const content = host.querySelector('[data-work-content]');
    content.hidden = false;
    content.setAttribute('aria-busy','true');
    try {
      const data = await api(`/api/work/emails/${id}`, {accountId:account});
      if (!live(host,account,id) || rev !== ticket) return;
      loaded = {data,host,account,id};
      render(host,data);
    } catch (error) {
      if (live(host,account,id) && rev === ticket) content.innerHTML = `<p role="status">${esc(w('retry'))} ${esc(mailaiSystemMessage(error.message))}</p>${button('refresh','refresh')}`;
    } finally { if (rev === ticket) content.removeAttribute('aria-busy'); }
  }
  async function memory(host) {
    if (loaded?.host !== host) await load(host);
    const state = loaded;
    if (!state || state.host !== host || !live(host,state.account,state.id)) return;
    const row = state.data.context.find(item => item.email_id === state.id) || {};
    const dialog = document.createElement('dialog');
    dialog.className = 'work-dialog';
    dialog.setAttribute('aria-label',w('memory'));
    dialog.innerHTML = `<form><header><h2>${esc(w('memory'))}</h2><button type="button" data-close aria-label="${esc(w('close'))}">✕</button></header>
      <p>${esc(w('memoryHint'))}</p><label>${esc(w('project'))}<input name="project" maxlength="200" value="${esc(row.project || '')}"></label>
      <label>${esc(w('role'))}<input name="role" maxlength="200" value="${esc(row.role || '')}"></label>
      <label>${esc(w('note'))}<textarea name="note" maxlength="2000">${esc(row.note || '')}</textarea></label>
      <label>${esc(w('style'))}<textarea name="style" maxlength="1000">${esc(state.data.preferences.style)}</textarea></label>
      <p role="status" data-status></p><footer>${button('clear','clear')}<button type="submit">${esc(w('save'))}</button></footer></form>`;
    document.body.append(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); if (host.isConnected) host.querySelector('[data-work="memory"]')?.focus(); }, {once:true});
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.querySelector('[data-work="clear"]').onclick = () => {
      for (const name of ['project','role','note','style']) dialog.querySelector(`[name="${name}"]`).value = '';
    };
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      if (!live(host,state.account,state.id)) { dialog.querySelector('[data-status]').textContent = w('changed'); return; }
      const submit = dialog.querySelector('[type="submit"]');
      submit.disabled = true;
      const values = Object.fromEntries(new FormData(event.target));
      dialog.querySelectorAll('input,textarea,[data-work="clear"]').forEach(node => { node.disabled = true; });
      try {
        const result = await api(`/api/work/emails/${state.id}/context`, {accountId:state.account,method:'PUT',...post({...values, style_revision:state.data.preferences.revision, revision:row.revision || 0})});
        row.revision = result.revision;
        dialog.close();
        if (live(host,state.account,state.id)) await load(host);
      } catch (error) { dialog.querySelector('[data-status]').textContent = mailaiSystemMessage(error.message); }
      finally { dialog.querySelectorAll('input,textarea,[data-work="clear"]').forEach(node => { node.disabled = false; }); submit.disabled = false; }
    };
    dialog.showModal();
  }
  document.getElementById('reading-content').addEventListener('click', async event => {
    const control = event.target.closest('[data-work]'), host = control?.closest('.work-card');
    if (!host || control.disabled) return;
    const account = host.dataset.workAccount, id = Number(host.dataset.workEmail);
    if (!live(host,account,id)) return;
    control.disabled = true;
    try {
      switch (control.dataset.work) {
        case 'load':
          if (loaded?.host === host) {
            const content = host.querySelector('[data-work-content]');
            content.hidden = !content.hidden;
            control.setAttribute('aria-expanded', String(!content.hidden));
          }
          else await load(host);
          break;
        case 'refresh': await load(host); break;
        case 'memory': await memory(host); break;
        case 'plan': await window.openTaskPlanner({emailId:id,accountId:account}); break;
        case 'progress': openConversationProgress(); break;
        case 'document': await window.startAssistantDocumentReply(id,account); break;
        case 'reply':
          await composeFromEmail('reply');
          if (composeContext.reply_to_email_id === id && composeAccountId === account && document.body.classList.contains('compose-open')) toggleComposeAiPanel(true);
          break;
      }
    } catch (error) { toast(mailaiSystemMessage(error.message),'warn'); }
    finally { control.disabled = false; }
  });
  window.addEventListener('mailai-tasks-changed', event => {
    if (loaded && loaded.account === event.detail.accountId && live(loaded.host,loaded.account,loaded.id)) load(loaded.host);
  });
  document.addEventListener('mailai:language-changed', () => {
    if (loaded && live(loaded.host,loaded.account,loaded.id)) render(loaded.host,loaded.data);
  });

  // Compose controls remain separate from generation, so users can check their
  // own text and retain explicit control over whether to use linked sources.
  const panel = document.getElementById('compose-ai-panel');
  const controls = document.createElement('section');
  controls.className = 'work-compose';
  controls.innerHTML = `<label><input type="checkbox" id="work-use-preferences" checked><span data-i18n="work.useStyle">${esc(w('useStyle'))}</span></label><p data-i18n="work.linkedHint">${esc(w('linkedHint'))}</p>${button('review','review')}<div data-work-review role="status"></div>`;
  panel.querySelector('.compose-ai-scroll').append(controls);
  let reviewSnapshot = null;
  const reviewFingerprint = () => JSON.stringify([composeMessageElement().innerText,
    composeAttachments.map(item => [item.filename || item.name || '', item.size || 0, item.sha256 || ''])]);
  const sameFiles = files => files.length === composeAttachments.length && files.every((item,index) => item === composeAttachments[index]);
  const invalidateReview = () => {
    if (!reviewSnapshot) return;
    if (reviewSnapshot.session !== draftSession) { reviewSnapshot = null; return; }
    if (reviewSnapshot.fingerprint !== reviewFingerprint() || !sameFiles(reviewSnapshot.files)) {
      controls.querySelector('[data-work-review]').textContent = w('edited');
      reviewSnapshot = null;
    }
  };
  new MutationObserver(invalidateReview).observe(document.getElementById('compose-body'),{subtree:true,childList:true,characterData:true});
  new MutationObserver(invalidateReview).observe(document.getElementById('compose-attachments'),{subtree:true,childList:true});
  controls.querySelector('[data-work="review"]').onclick = async event => {
    const session = draftSession, account = composeAccountId, id = composeContext.reply_to_email_id;
    const output = controls.querySelector('[data-work-review]'), control = event.currentTarget;
    if (!id) { output.textContent = w('replyOnly'); return; }
    const body = composeMessageElement().innerText;
    const names = composeAttachments.map(item => item.filename || item.name || '');
    const current = () => session === draftSession && !session.canceled && account === composeAccountId && document.body.classList.contains('compose-open');
    const original = reviewFingerprint(), files = [...composeAttachments];
    reviewSnapshot = null;
    control.disabled = true;
    output.textContent = w('reviewing');
    const finish = globalThis.mailaiCompanionWork?.begin();
    try {
      const result = await api('/api/work/review',{accountId:account,method:'POST',...post({email_id:id,body,attachment_names:names,semantic:true})});
      if (!current()) return;
      if (reviewFingerprint() !== original || !sameFiles(files)) { output.textContent = w('edited'); return; }
      reviewSnapshot = {session,fingerprint:original,files};
      output.innerHTML = result.items.length ? result.items.map(item => `<p>${item.question ? `<q>${esc(item.question)}</q><br>` : ''}${esc(mailaiSystemMessage(item.note))}</p>`).join('') : `<p>${esc(result.model_used ? w('noOmissions') : mailaiSystemMessage(result.note || ''))}</p>`;
      output.insertAdjacentHTML('beforeend',`<small>${esc(w('reviewHint'))}</small>`);
      if (result.limited) output.insertAdjacentHTML('beforeend',`<p>${esc(w('limited'))}</p>`);
    } catch (error) { if (current()) output.textContent = mailaiSystemMessage(error.message); }
    finally { finish?.(); control.disabled = false; }
  };
  new MutationObserver(() => {
    if (!document.body.classList.contains('compose-open')) {
      controls.querySelector('[data-work-review]').textContent = '';
      reviewSnapshot = null;
      document.getElementById('work-use-preferences').checked = true;
    }
  }).observe(document.body,{attributes:true,attributeFilter:['class']});
  window.mailaiPrepareFollowup = async (sentId, account) => {
    const active = activeMailAccount()?.id;
    const seed = await api(`/api/work/followups/${Number(sentId)}/prepare`,{accountId:account});
    if (active !== activeMailAccount()?.id) return;
    const opened = await openCompose({...seed,account_id:account});
    if (opened) {
      document.getElementById('compose-ai-instruction').value = w('followupInstruction');
      toggleComposeAiPanel(true);
    }
  };
  window.mailaiOpenWork = async (id, account) => {
    if (account !== activeMailAccount()?.id) return;
    await revealEmailFromSource(id);
    const host = document.querySelector('.work-card');
    if (host && live(host,account,id)) await load(host);
  };
})();
