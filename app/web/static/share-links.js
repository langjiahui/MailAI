/* Large-file cloud share links and COS storage dialog for Compose. */
function closeShareLinkDialog() {
  document.getElementById('share-link-dialog').classList.add('hidden');
}

async function openShareLinkDialog() {
  const session = draftSession, accountId = composeAccountId;
  const current = () => session === draftSession && accountId === composeAccountId && !session.canceled;
  document.getElementById('share-link-dialog').classList.remove('hidden');
  document.getElementById('share-cos-file').focus();
  try {
    const state = await api('/api/share-storage/config', {accountId});
    if (!current() || document.getElementById('share-link-dialog').classList.contains('hidden')) return;
    document.getElementById('share-cos-bucket').value = state.bucket || '';
    document.getElementById('share-cos-region').value = state.region || '';
    document.getElementById('share-cos-id').value = state.secret_id || '';
    document.getElementById('share-cos-key').value = '';
    document.querySelector('.share-cos-config').classList.toggle('hidden', Boolean(state.credential_available));
    document.getElementById('share-cos-settings-toggle').classList.toggle('hidden', !state.credential_available);
    mailaiBindUI(document.getElementById('share-cos-status'), "textContent", () => (state.credential_available ? mailaiText('存储已连接。大附件会自动转为下载链接。') : mailaiText('首次连接需要腾讯云存储信息，保存后无需重复填写。也可直接把已有网盘分享链接粘贴到正文。')));
  } catch (error) {
    if (!current()) return;
    mailaiBindUI(document.getElementById('share-cos-status'), "textContent", () => (mailaiText('无法读取 COS 配置：') + mailaiSystemMessage(error.message)));
  }
}

function normalizeShareUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.href.length > 4096) return '';
    return url.href;
  } catch (_) { return ''; }
}

function insertSharedLink(name, value, expiresAt = '', closeDialog = true) {
  const url = normalizeShareUrl(value);
  if (!url) throw new Error(mailaiText('请填写有效的 HTTPS 分享链接'));
  const title = String(name || '').trim().slice(0, 160) || mailaiText('共享文件');
  const block = document.createElement('p');
  block.dataset.mailaiSharedLink = 'true';
  const heading = document.createElement('strong');
  mailaiBindUI(heading, "textContent", () => (mailaiTemplate`共享文件：${title}`));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.textContent = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  block.append(heading, document.createElement('br'), anchor);
  if (expiresAt && Number.isFinite(Date.parse(expiresAt))) {
    const expiry = document.createElement('small');
    mailaiBindUI(expiry, "textContent", () => (mailaiTemplate`下载链接有效至 ${new Date(expiresAt).toLocaleString(currentI18nLanguage())}`));
    block.append(document.createElement('br'), expiry);
  }
  composeMessageElement().append(block);
  clearComposePreflight();
  queueDraftSave();
  refreshComposeAiContext();
  if (closeDialog) closeShareLinkDialog();
  composeMessageElement().focus();
}

function uploadCosFile(file, days, accountId, onProgress, endpoint = "/api/share-storage/upload") {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', endpoint);
    request.timeout = 30 * 60 * 1000;
    request.setRequestHeader('X-MailAI-Account', accountId);
    request.setRequestHeader('X-MailAI-Filename', encodeURIComponent(file.name));
    request.setRequestHeader('X-MailAI-Expiry-Days', String(days));
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    request.onerror = () => reject(new Error(mailaiText('上传连接中断，请检查网络后重试')));
    request.ontimeout = () => reject(new Error(mailaiText('上传等待超时，请检查网络后重试')));
    request.onabort = () => reject(new Error(mailaiText('上传已取消')));
    request.onload = () => {
      let response;
      try { response = JSON.parse(request.responseText); } catch (_) { response = {}; }
      if (request.status >= 200 && request.status < 300) resolve(response);
      else reject(new Error(response.detail || mailaiTemplate`上传失败（${request.status}）`));
    };
    request.send(file);
  });
}

document.getElementById('share-cos-settings-toggle').addEventListener('click', () => {
  document.querySelector('.share-cos-config').classList.toggle('hidden');
});
document.querySelectorAll('[data-close-share-link]').forEach(button => button.addEventListener('click', closeShareLinkDialog));
document.getElementById('share-cos-save').addEventListener('click', async event => {
  const button = event.currentTarget;
  const session = draftSession, accountId = composeAccountId;
  const current = () => session === draftSession && accountId === composeAccountId && !session.canceled;
  button.disabled = true;
  try {
    await api('/api/share-storage/config', {accountId, method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({
        bucket:document.getElementById('share-cos-bucket').value,
        region:document.getElementById('share-cos-region').value,
        secret_id:document.getElementById('share-cos-id').value,
        secret_key:document.getElementById('share-cos-key').value})});
    if (!current()) return;
    document.getElementById('share-cos-key').value = '';
    mailaiBindUI(document.getElementById('share-cos-status'), "textContent", () => (mailaiText('COS 配置已保存')));
    document.querySelector('.share-cos-config').classList.add('hidden');
    document.getElementById('share-cos-settings-toggle').classList.remove('hidden');
  } catch (error) { if (current()) document.getElementById('share-cos-status').textContent = mailaiSystemMessage(error.message); }
  finally { button.disabled = false; }
});
document.getElementById('share-cos-form').addEventListener('submit', async event => {
  event.preventDefault();
  const files = [...document.getElementById('share-cos-file').files];
  if (!files.length) return toast(mailaiText('请先选择文件'), 'warn');
  if (files.some(file => file.size > 2 * 1024 * 1024 * 1024)) return toast(mailaiText('单个共享文件不能超过 2 GB'), 'warn');
  const session = draftSession, accountId = composeAccountId;
  if (session.busy || session.canceled || session.sharing) return;
  session.sharing = true;
  const days = Number(document.getElementById('share-cos-expiry').value);
  session.attachmentReads = (session.attachmentReads || 0) + 1;
  const button = document.getElementById('share-cos-upload');
  button.disabled = true;
  try {
    closeShareLinkDialog();
    const cards = files.map(file => ({file, name:file.name, size:file.size, days, state:'waiting'}));
    (session.sharedFiles ||= []).push(...cards); renderSharedFileCards();
    const failed = [];
    for (const [index, file] of files.entries()) {
      if (session !== draftSession || accountId !== composeAccountId || session.canceled) return;
      if (!await uploadSharedFileWithCard(file, days, session, accountId, () => {}, cards[index])) failed.push(file);
    }
    if (session !== draftSession || accountId !== composeAccountId || session.canceled) return;
    document.getElementById('share-cos-file').value = '';
    toast(failed.length ? mailaiTemplate`${failed.length} 个文件上传失败，请在附件区重试或移除` : mailaiText('大附件已上传，分享链接已插入正文'), failed.length ? 'warn' : 'success');
  } catch (error) { if (session === draftSession && accountId === composeAccountId) toast(mailaiSystemMessage(error.message), 'error'); }
  finally { session.attachmentReads -= 1; session.sharing = false; button.disabled = false; mailaiBindUI(button, "textContent", () => (mailaiT('compose.cosUpload') || '上传并插入邮件')); if (session === draftSession) renderSharedFileCards(); }
});
document.getElementById('compose-shared-files').addEventListener('click', async event => {
  const retry = event.target.closest('[data-retry-share]');
  const dismiss = event.target.closest('[data-dismiss-share]');
  const session = draftSession, accountId = composeAccountId;
  if ((!retry && !dismiss) || session.sharing || session.busy || session.canceled) return;
  const index = Number(retry ? retry.dataset.retryShare : dismiss.dataset.dismissShare);
  const item = session.sharedFiles?.[index];
  if (!item || !['failed','waiting'].includes(item.state)) return;
  if (dismiss) {
    try { if (item.taskId) await api(`/api/share-storage/tasks/${item.taskId}`, {accountId, method:'DELETE'});
      if (session !== draftSession) return;
      session.sharedFiles.splice(index, 1); renderSharedFileCards();
    } catch (error) { toast(mailaiSystemMessage(error.message), 'error'); }
    return;
  }
  session.sharing = true; session.attachmentReads = (session.attachmentReads || 0) + 1;
  try { await uploadSharedFileWithCard(item.file, item.days, session, accountId, () => {}, item); }
  finally { session.sharing = false; session.attachmentReads--; if (session === draftSession) renderSharedFileCards(); }
});

globalThis.MailAIModules?.register('shareLinks', {
  openShareLinkDialog,
  closeShareLinkDialog,
  normalizeShareUrl,
  insertSharedLink,
  uploadCosFile,
});
