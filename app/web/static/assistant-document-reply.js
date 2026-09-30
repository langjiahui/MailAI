/* Prepare a filled document reply. The send action remains in the compose window. */
(() => {
  const dialog = document.createElement('dialog');
  dialog.id = 'assistant-document-reply';
  dialog.innerHTML = `<div class="document-reply-head"><div><small>小邮 · 填写附件并回复</small><h2>准备回复</h2></div><button type="button" data-document-close aria-label="关闭">×</button></div>
    <p class="document-reply-source"></p><div class="document-reply-content"></div><p class="document-reply-status" role="status"></p>
    <div class="document-reply-foot"><button type="button" data-document-back class="hidden">返回选附件</button><button type="button" data-document-next>识别待填字段</button></div>`;
  document.body.append(dialog);
  const content = dialog.querySelector('.document-reply-content');
  const status = dialog.querySelector('.document-reply-status');
  const next = dialog.querySelector('[data-document-next]');
  const back = dialog.querySelector('[data-document-back]');
  let context = null;

  function close() { dialog.close(); }
  dialog.querySelector('[data-document-close]').onclick = close;
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('close', () => { context = null; status.textContent = ''; });

  function renderFiles() {
    const c = context;
    if (!c) return;
    const items = c.items.filter(item => item.supported && /\.(?:xlsx?|docx|pdf)$/i.test(item.name));
    content.innerHTML = items.length
      ? `<p>选择要填写的附件。原附件不会被修改。</p><div class="document-reply-files">${items.map(item =>
          `<label><input type="radio" name="document-reply-file" value="${item.index}" ${item.index === c.index ? 'checked' : ''}><span>${esc(item.name)}</span><small>${formatFileSize(item.size)}</small></label>`).join('')}</div>`
      : '<p>这封邮件没有可填写的 XLS、XLSX、DOCX 或 PDF 附件。</p>';
    next.disabled = !items.length;
    next.textContent = '识别待填字段';
    back.classList.add('hidden');
    status.textContent = '';
  }

  function renderRows() {
    const c = context;
    if (!c?.rowOptions) return;
    content.innerHTML = `<p>${esc(c.rowOptions.choice_label || '请选择要填写的行')}。小邮只会填写所选行中的空白单元格。</p>
      <div class="document-reply-files">${c.rowOptions.choices.map(choice =>
        `<label><input type="radio" name="document-reply-row" value="${choice.row}" ${choice.row === c.rowChoice ? 'checked' : ''}><span>${esc(choice.label)}</span><small>第 ${choice.row} 行</small></label>`).join('')}</div>
      <details class="document-reply-preview"><summary>查看原表格单元格</summary><pre>${esc(c.rowOptions.preview || '')}</pre></details>`;
    next.disabled = false;
    next.textContent = '确认部门并继续';
    back.classList.remove('hidden');
    status.textContent = '';
  }

  function renderFields() {
    const c = context;
    if (!c?.plan) return;
    content.innerHTML = `<p>${esc(c.plan.name)} · 请检查字段位置，再填写内容。资料不足时可填“无”或返回修改。</p>
      <div class="document-reply-natural"><label for="document-reply-description">也可以一次描述填写信息</label><textarea id="document-reply-description" rows="2" maxlength="3000" placeholder="例如：驾驶员张三，电话138…，9月30日离沪，车牌沪A…"></textarea><button type="button" data-document-extract>提取并填入下方字段</button></div>
      <div class="document-reply-fields">${c.plan.fields.map((field, index) =>
        `<label><span>${esc(field.label)} <small>${esc(field.location_label || `${field.sheet} · ${field.cell}`)}</small></span><input type="text" data-document-value="${index}" maxlength="500" value="${esc(field.value || '')}" autocomplete="off" placeholder="请输入实际信息" required></label>`).join('')}</div>
      <details class="document-reply-preview"><summary>查看原文档字段</summary><pre>${esc(c.plan.preview || '')}</pre></details>
      ${c.rowOptions ? '' : '<details class="document-reply-correction"><summary>字段或位置识别有误？</summary><textarea rows="2" maxlength="800" placeholder="例如：车牌号应填写在 B8，还漏了同行人数"></textarea><button type="button" data-document-replan>按说明重新识别</button></details>'}
      <small class="document-reply-note">${esc(c.plan.note || '')}</small>`;
    next.disabled = false;
    next.textContent = '生成附件和回复草稿';
    back.classList.remove('hidden');
    status.textContent = '';
    content.querySelector('[data-document-extract]').onclick = async event => {
      const button = event.currentTarget;
      const text = content.querySelector('#document-reply-description').value.trim();
      if (!text) { status.textContent = '请先描述要填写的信息'; return; }
      if (c.busy) return;
      c.busy = true; button.disabled = true; next.disabled = true; back.disabled = true;
      status.textContent = '正在从描述中提取字段…';
      try {
        const result = await api('/api/assistant/document-reply/values', {accountId:c.accountId, method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({email_id:c.emailId,index:c.index,
            digest:c.plan.digest,plan_token:c.plan.plan_token,fields:c.plan.fields,text})});
      if (context !== c || c.accountId !== activeMailAccount()?.id) return;
        let count = 0;
        (result.values || []).forEach((value, index) => {
          const input = content.querySelector(`[data-document-value="${index}"]`);
          if (input && !input.value.trim() && value) { input.value = value; count++; }
        });
        status.textContent = count ? `已填入 ${count} 项，请核对并补齐其余字段。` : '没有找到可确认的字段值，请逐项填写。';
      } catch (error) {
        if (context === c) status.textContent = error.message || '提取失败，请逐项填写';
      } finally {
        if (context === c) { c.busy = false; button.disabled = false; next.disabled = false; back.disabled = false; }
      }
    };
    if (!c.rowOptions) content.querySelector('[data-document-replan]').onclick = async event => {
      const correction = content.querySelector('.document-reply-correction textarea').value.trim();
      if (!correction) { status.textContent = '请说明需要修改的字段或位置'; return; }
      if (c.busy) return;
      const button = event.currentTarget;
      c.busy = true; button.disabled = true; next.disabled = true; back.disabled = true;
      status.textContent = '正在重新识别字段…';
      const fieldKey = field => JSON.stringify([field.sheet, field.cell, field.label]);
      const previous = new Map(c.plan.fields.map((field, index) =>
        [fieldKey(field), content.querySelector(`[data-document-value="${index}"]`)?.value.trim() || '']));
      try {
        const revised = await api('/api/assistant/document-reply/plan', {accountId:c.accountId, method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({email_id:c.emailId,index:c.index,
            instruction:(c.instruction.slice(0,150) + '\n字段修正：' + correction).slice(0,1000)})});
        if (context !== c || c.accountId !== activeMailAccount()?.id) return;
        revised.fields.forEach(field => { if (previous.get(fieldKey(field))) field.value = previous.get(fieldKey(field)); });
        c.plan = revised;
        renderFields();
        status.textContent = '已重新识别，请核对字段和位置。';
      } catch (error) {
        if (context === c) status.textContent = error.message || '重新识别失败';
      } finally {
        if (context === c) { c.busy = false; button.disabled = false; next.disabled = false; back.disabled = false; }
      }
    };
    content.querySelector('input[data-document-value]')?.focus();
  }

  back.onclick = () => {
    if (!context) return;
    if (context.plan) { context.plan = null; context.rowOptions ? renderRows() : renderFiles(); }
    else { context.rowOptions = null; renderFiles(); }
  };
  next.onclick = async () => {
    const c = context;
    if (!c || c.busy) return;
    if (c.accountId !== activeMailAccount()?.id) { status.textContent = '邮箱账号已切换，请重新开始。'; return; }
    c.busy = true; next.disabled = true; back.disabled = true;
    try {
      if (!c.plan && c.rowOptions) {
        const chosen = content.querySelector('input[name="document-reply-row"]:checked');
        if (!chosen) throw new Error('请先选择要填写的部门行');
        c.rowChoice = Number(chosen.value);
        status.textContent = '正在定位所选行的待填单元格…';
        c.plan = await api('/api/assistant/document-reply/plan', {accountId:c.accountId, method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({email_id:c.emailId,index:c.index,
            row_choice:c.rowChoice,instruction:c.instruction})});
        if (context !== c) return;
        if (c.accountId !== activeMailAccount()?.id) { status.textContent = '邮箱账号已切换，请关闭窗口后重新开始。'; return; }
        renderFields();
      } else if (!c.plan) {
        const chosen = content.querySelector('input[name="document-reply-file"]:checked');
        if (!chosen) throw new Error('请先选择附件');
        c.index = Number(chosen.value);
        status.textContent = '正在识别文档字段…';
        const identified = await api('/api/assistant/document-reply/plan', {accountId:c.accountId, method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({email_id:c.emailId,index:c.index,instruction:c.instruction})});
        if (context !== c) return;
        if (c.accountId !== activeMailAccount()?.id) { status.textContent = '邮箱账号已切换，请关闭窗口后重新开始。'; return; }
        if (identified.needs_row_choice) { c.rowOptions = identified; renderRows(); }
        else { c.plan = identified; renderFields(); }
      } else {
        if (!c.preparedDraftId) {
          const values = [...content.querySelectorAll('[data-document-value]')].map(input => input.value.trim());
          const missing = values.findIndex(value => !value);
          if (missing >= 0) { content.querySelector(`[data-document-value="${missing}"]`)?.focus(); throw new Error('请填写全部字段；不适用的项目可填“无”'); }
          status.textContent = '正在填写文件、回读核对并准备回复…';
          const fields = c.plan.fields.map((field, index) => ({...field, value:values[index]}));
          const prepared = await api('/api/assistant/document-reply/prepare', {accountId:c.accountId, method:'POST',
            headers:{'Content-Type':'application/json'}, body:JSON.stringify({email_id:c.emailId,index:c.index,
              digest:c.plan.digest,plan_token:c.plan.plan_token,fields,instruction:c.instruction})});
          c.preparedDraftId = prepared.draft_id;
        }
        if (context !== c || c.accountId !== activeMailAccount()?.id) {
          toast('回复已保存在原邮箱的草稿箱，请打开草稿并核对附件后发送。', 'warn');
          return;
        }
        status.textContent = '正在打开已保存的回复草稿…';
        const draft = await api(`/api/drafts/${c.preparedDraftId}`, {accountId:c.accountId});
        if (context !== c || c.accountId !== activeMailAccount()?.id) {
          toast('回复已保存在原邮箱的草稿箱，请打开草稿并核对附件后发送。', 'warn');
          return;
        }
        try {
          const opened = await openCompose({...draft, account_id:c.accountId, assistant_review:true});
          close();
          toast(opened === false ? '回复已保存在草稿箱，请打开草稿并核对附件后发送。' :
            '已生成填写后的附件和回复草稿。请预览附件并核对邮件，确认后再发送。',
            opened === false ? 'warn' : 'success');
        } catch (_) {
          close();
          toast('回复已保存在草稿箱，但写信窗口未能打开。请到草稿箱核对附件后发送。', 'warn');
        }
      }
    } catch (error) {
      if (context === c) {
        status.textContent = c.preparedDraftId
          ? '回复草稿已保存，但暂时无法打开。可重试打开，或到草稿箱核对后发送。'
          : error.message || '处理失败，请重试';
        if (c.preparedDraftId) {
          next.textContent = '打开已保存草稿';
          content.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = true; });
        }
      }
    } finally {
      if (context === c) { c.busy = false; next.disabled = false; back.disabled = Boolean(c.preparedDraftId); }
    }
  };

  window.startAssistantDocumentReply = async (emailId, accountId, instruction = '') => {
    if (!Number.isSafeInteger(Number(emailId)) || !accountId) throw new Error('请先在当前邮箱打开要回复的邮件');
    const c = {emailId:Number(emailId), accountId, index:0, items:[], plan:null, rowOptions:null, rowChoice:null, preparedDraftId:null,
      busy:false, instruction:String(instruction).slice(0,1000)};
    context = c;
    dialog.querySelector('.document-reply-source').textContent = '正在读取当前邮件附件…';
    content.textContent = '';
    status.textContent = '';
    next.disabled = true;
    dialog.showModal();
    try {
      const catalog = await api(`/api/emails/${c.emailId}/assistant-attachments`, {accountId});
      if (context !== c) return;
      if (accountId !== activeMailAccount()?.id) { status.textContent = '邮箱账号已切换，请关闭窗口后重新开始。'; return; }
      c.items = catalog.items || [];
      c.index = c.items.find(item => item.supported && /\.(?:xlsx?|docx|pdf)$/i.test(item.name))?.index ?? 0;
      dialog.querySelector('.document-reply-source').textContent = catalog.subject || '当前邮件';
      renderFiles();
    } catch (error) {
      if (context === c) status.textContent = error.message || '附件读取失败';
    }
  };
})();
