/* Single-mail output: capture identity before any asynchronous work. */
(() => {
  const t = key => mailaiT('mailOutput.' + key) || MAILAI_UI_COPY['mailOutput.' + key]?.[0] || key;
  const dialog = document.createElement('dialog');
  dialog.id = 'mail-output-dialog';
  dialog.className = 'library-dialog mail-output-dialog';
  dialog.setAttribute('aria-labelledby', 'mail-output-title');
  dialog.innerHTML = `<header class="mail-output-header"><div><h2 id="mail-output-title"></h2><p id="mail-output-subject"></p></div><button type="button" data-output-close></button></header>
    <div class="mail-output-content">
      <div class="mail-output-options">
        <fieldset id="mail-output-format" aria-describedby="mail-output-description">
          <legend data-output-label="format"></legend>
          <label><input type="radio" name="mail-output-kind" value="pdf" checked><span>PDF</span></label>
          <label><input type="radio" name="mail-output-kind" value="text"><span data-output-label="text"></span></label>
          <label><input type="radio" name="mail-output-kind" value="eml"><span data-output-label="eml"></span></label>
        </fieldset>
        <p id="mail-output-description"></p>
      </div>
      <div id="mail-output-preview-host"></div>
      <pre id="mail-output-text-preview" hidden tabindex="0" aria-labelledby="mail-output-title"></pre>
    </div>
    <footer><div class="mail-output-meta"><p id="mail-output-notes"></p><p id="mail-output-status" role="status" aria-live="polite"></p></div><div class="mail-output-actions"><button type="button" data-output-print></button><button type="button" data-output-copy></button><button type="button" data-output-save></button><button type="button" data-output-share></button></div></footer>`;
  document.body.append(dialog);
  const find = selector => dialog.querySelector(selector);
  let preview = null;
  const format = find('#mail-output-format');
  const status = find('[role="status"]');
  let run = null;
  const native = () => window.pywebview?.api;
  const current = scope => run === scope && dialog.open;
  const kind = () => format.querySelector(':checked').value;
  const browserFileShare = () => typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

  function paint() {
    const scope = run;
    if (!scope) return;
    find('h2').textContent = t(scope.mode === 'print' ? 'print' : 'share');
    find('[data-output-close]').textContent = t('close');
    if(preview) preview.title = t('preview');
    for (const el of dialog.querySelectorAll('[data-output-label]')) el.textContent = t(el.dataset.outputLabel);
    find('[data-output-print]').textContent = t('printAction');
    find('[data-output-copy]').textContent = t('copy');
    const printing = scope.mode === 'print';
    const pdf = kind() === 'pdf';
    const text = kind() === 'text';
    find('[data-output-save]').textContent = t(pdf ? 'savePdf' : 'save');
    find('[data-output-share]').textContent = t(pdf ? 'sharePdf' : 'systemShare');
    const subject = find('#mail-output-subject');
    subject.title = subject.textContent = scope.data?.filename || '';
    find('.mail-output-options').hidden = printing;
    find('#mail-output-preview-host').hidden = text;
    const textPreview = find('#mail-output-text-preview');
    textPreview.hidden = !text;
    if (text) textPreview.textContent = scope.data?.text || '';
    const description = find('#mail-output-description');
    description.textContent = t(text ? 'textHint' : pdf ? 'pdfHint' : 'emlHint');
    find('#mail-output-notes').textContent = scope.data?.notes.join(' ') || '';
    const ready = !!scope.data, busy = scope.busy;
    format.disabled = !ready || busy;
    for (const el of dialog.querySelectorAll('footer button')) el.disabled = !ready || busy;
    find('[data-output-print]').disabled = !ready || busy || (!scope.data.token && !scope.previewReady);
    find('[data-output-print]').hidden = !printing;
    format.querySelector('[value="eml"]').disabled = !scope.data?.has_raw;
    find('[data-output-copy]').hidden = printing || !text;
    find('[data-output-save]').hidden = printing || text;
    const file = pdf ? scope.pdfFile : scope.file;
    const canShare = text ? typeof navigator.share === 'function' : scope.data?.native_share || (file && browserFileShare() && navigator.canShare({files:[file]}));
    find('[data-output-share]').disabled = !ready || busy || !canShare;
    find('[data-output-share]').hidden = printing || !canShare;
    let primary = '[data-output-save]';
    if (printing) primary = '[data-output-print]';
    else if (text) primary = '[data-output-copy]';
    else if (canShare) primary = '[data-output-share]';
    for (const button of dialog.querySelectorAll('footer button')) {
      button.classList.toggle('primary-action', button.matches(primary));
    }
  }

  function release(scope) {
    if (scope?.data?.token) native()?.release_mail_output(scope.data.token).catch(() => {});
  }

  function applyPreviewTheme() {
    const doc = preview?.contentDocument;
    if (doc?.URL !== 'about:srcdoc') return;
    const theme = document.documentElement.dataset.theme;
    const {ink, muted, link, line} = richEmailBasePalette(theme);
    let style = doc.getElementById('mail-output-screen-style');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'mail-output-screen-style';
      doc.head.append(style);
    }
    // The browser prints this same frame, so all UI colors are screen-only.
    style.textContent = `@media screen {
      html { background:transparent; }
      body { max-width:80rem; margin-inline:auto; padding:clamp(12px,3vw,28px); }
      .mail-output-header { border-bottom:0; padding-bottom:0; }
      .mail-output-note { display:none; }
      ${theme === 'dark' ? `
        html { color-scheme:dark; color:${ink}; }
        blockquote { border-color:${line}; }
        .mail-output-body [style] { background-color:transparent!important; color:inherit!important; }
        a, .mail-output-body a[style] { color:${link}!important; }
        blockquote { color:${muted}; }
      ` : ''}
    }`;
  }

  function close() { dialog.close(); }
  dialog.addEventListener('close', () => {
    const old = run;
    run = null;
    old?.controller.abort();
    preview?.remove();
    preview = null;
    find('#mail-output-text-preview').textContent = '';
    release(old);
    if (old?.returnFocus?.isConnected) old.returnFocus.focus({preventScroll:true});
  });
  find('[data-output-close]').onclick = close;

  async function work(action) {
    const scope = run;
    if (!scope?.data || scope.busy) return;
    const focused = document.activeElement;
    scope.busy = true; status.textContent = t('working'); paint();
    try { await action(scope); }
    catch(error) { if(current(scope)) status.textContent = mailaiSystemMessage(error?.message || error); }
    finally {
      if (current(scope)) {
        scope.busy = false;
        paint();
        if (document.activeElement === document.body && dialog.contains(focused) && focused.getClientRects().length) {
          focused.focus({preventScroll:true});
        }
      }
    }
  }

  async function fetchFile(scope) {
    if (kind() !== 'eml' || scope.data.token) return;
    const revision=scope.data.original_revision || '';
    const response = await fetch(`/api/emails/${scope.id}/original?source=${scope.source}&revision=${encodeURIComponent(revision)}`, {headers:{'X-MailAI-Account':scope.accountId}, signal:scope.controller.signal});
    if (!response.ok) { const error=await response.json();throw new Error(error.detail); }
    // Large originals remain downloadable without buffering their attachments
    // into the browser's sharing API.
    if (Number(response.headers.get('content-length')) > 64*1024*1024) { await response.body?.cancel();return; }
    const blob = await response.blob();
    if(current(scope) && kind()==='eml') scope.file = new File([blob],scope.data.filename+'.eml',{type:'message/rfc822'});
  }

  function preparePdf(scope) {
    if (scope.pdfFile) return Promise.resolve(scope.pdfFile);
    if (!scope.pdfRequest) {
      scope.pdfRequest = (async () => {
        let content;
        if (scope.data.token) {
          const result = await native().mail_output_pdf(scope.data.token);
          content = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
        } else {
          const response = await fetch(`/api/emails/${scope.id}/pdf?source=${scope.source}&language=${scope.language}`, {
            headers:{'X-MailAI-Account':scope.accountId}, signal:scope.controller.signal,
          });
          if (!response.ok) throw new Error((await response.json()).detail);
          content = await response.blob();
        }
        scope.pdfFile = new File([content], scope.data.filename + '.pdf', {type:'application/pdf'});
        if (current(scope)) paint();
        return scope.pdfFile;
      })().finally(() => { scope.pdfRequest = null; });
    }
    return scope.pdfRequest;
  }

  format.onchange = () => work(async scope => {
    scope.file = null;
    await fetchFile(scope);
    if(current(scope)) status.textContent = '';
  });

  async function open(mode, reference = {}) {
    const email = selectedEmailDetail;
    const id = Number(reference.id || email?.id);
    const accountId = reference.accountId || selectedEmailAccountId || email?._account_id || activeMailAccount()?.id || '';
    const source = reference.source === 'sent' ? 'sent' : 'email';
    if (!id || id<=0 || !accountId) return;
    if (dialog.open) return;
    const scope = {id,accountId,source,mode,busy:true,data:null,file:null,controller:new AbortController(),previewReady:false,returnFocus:reference.returnFocus};
    run=scope;format.querySelector('[value="pdf"]').checked=true;status.textContent=t('working');paint();dialog.showModal();
    try {
      const language = scope.language = document.documentElement.lang === 'en' ? 'en' : 'zh-CN';
      const data = native()?.prepare_mail_output ? await native().prepare_mail_output(id,accountId,language,source) : await api(`/api/emails/${id}/output?language=${language}&source=${source}`,{accountId,signal:scope.controller.signal});
      scope.data = data;
      if (!current(scope)) {release(scope);return;}
      const frame = document.createElement('iframe');
      frame.id = 'mail-output-preview';
      frame.title = t('preview');
      frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
      frame.addEventListener('load', () => {
        if (!current(scope) || frame.contentDocument?.URL !== 'about:srcdoc') return;
        applyPreviewTheme();
        frame.contentDocument.addEventListener('click', event => {
          if (event.target.closest?.('a[href]')) event.preventDefault();
        });
        frame.contentDocument.addEventListener('keydown', event => {
          if (event.key !== 'Escape' || !current(scope)) return;
          event.preventDefault();
          close();
        });
        scope.previewReady = true;
        frame.dataset.ready = '';
        paint();
      });
      frame.srcdoc = data.document;
      preview = frame;
      find('#mail-output-preview-host').replaceChildren(frame);
      status.textContent = '';
      // Prepare file shares before the click so navigator.share keeps the user gesture.
      if (mode === 'share' && !data.native_share && browserFileShare()) preparePdf(scope).catch(() => {});
    } catch(error) { if(current(scope)) status.textContent=mailaiSystemMessage(error?.message || error); }
    finally { if(current(scope)){scope.busy=false;paint();} }
  }

  find('[data-output-print]').onclick = () => work(async scope => {
    if (scope.data.token && native()?.print_mail_output) {
      await native().print_mail_output(scope.data.token);
    } else {
      const frame = preview;
      await Promise.race([frame.contentDocument.fonts.ready, new Promise(resolve => setTimeout(resolve, 2000))]);
      if (!current(scope)) return;
      frame.contentWindow.print();
    }
    if(current(scope)) {
      status.textContent=t('printOpened');
      find('[data-output-close]').focus({preventScroll:true});
    }
  });

  function download(file) {
    const url=URL.createObjectURL(file),anchor=document.createElement('a');
    anchor.href=url;anchor.download=file.name;document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  find('[data-output-save]').onclick = () => work(async scope => {
    if(scope.data.token) {
      const result=await native().save_mail_output(scope.data.token,kind());
      if(current(scope)) status.textContent=t(result.canceled?'canceled':'saved');
    } else if (kind() === 'pdf') {
      const file = await preparePdf(scope);
      if (current(scope)) { download(file); status.textContent=t('downloadStarted'); }
    } else if (scope.file) {download(scope.file);status.textContent=t('downloadStarted');}
    else if(kind()==='eml') {
      const anchor=document.createElement('a');
      anchor.href=`/api/emails/${scope.id}/original?source=${scope.source}&revision=${encodeURIComponent(scope.data.original_revision || '')}&mailai_account=${encodeURIComponent(scope.accountId)}`;
      anchor.download=scope.data.filename+'.eml';document.body.append(anchor);anchor.click();anchor.remove();
      status.textContent=t('downloadStarted');
    }
  });
  find('[data-output-copy]').onclick = () => work(async scope => {
    if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(scope.data.text);
    else {
      const field=document.createElement('textarea');field.value=scope.data.text;dialog.append(field);field.select();
      const ok=document.execCommand('copy');field.remove();if(!ok)throw new Error(t('copyFailed'));
    }
    if(current(scope))status.textContent=t('copied');
  });
  find('[data-output-share]').onclick = () => work(async scope => {
    try {
      if(kind()!=='text' && scope.data.native_share) await native().share_mail_output(scope.data.token,kind());
      else if (kind() === 'text') await navigator.share({title:scope.data.filename, text:scope.data.text});
      else await navigator.share({files:[kind() === 'pdf' ? scope.pdfFile : scope.file]});
      if(current(scope))status.textContent=t('shared');
    } catch(error) {if(error.name==='AbortError'){if(current(scope))status.textContent=t('canceled');}else throw error;}
  });
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-mail-output]');
    if(!trigger)return;
    const menu = trigger.closest('details');
    menu?.removeAttribute('open');
    open(trigger.dataset.mailOutput, {
      id:trigger.dataset.mailOutputId, source:trigger.dataset.mailOutputSource,
      accountId:trigger.dataset.mailOutputAccount, returnFocus:menu?.querySelector('summary') || trigger,
    });
  });
  window.mailaiMailOutput={open};
  document.addEventListener('mailai:language-changed',paint);
  document.addEventListener('mailai:themechange', applyPreviewTheme);
  document.addEventListener('mailai:reward-themechange', applyPreviewTheme);
})();
