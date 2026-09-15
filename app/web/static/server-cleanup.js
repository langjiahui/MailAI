/* Server deletion is intentionally manual, preview-bound and account-scoped. */
let cleanupPreview = null;
let cleanupOffset = 0;
let cleanupBusy = false;
let cleanupRevision = 0;
document.body.insertAdjacentHTML('beforeend', `<dialog id="server-cleanup-dialog" class="library-dialog cleanup-dialog" aria-labelledby="cleanup-title"><h2 id="cleanup-title">清理服务器邮件</h2><p id="cleanup-account"></p><p>仅清理本机已同步且原文完整的邮件。未同步邮件不会被清理；每批最多 50 封、100 MB。邮件日期早于截止日期才会入选，不含截止当天。</p><fieldset id="cleanup-options"><label>服务器文件夹<select id="cleanup-folder"></select></label><label>清理范围<select id="cleanup-age"><option value="30">30 天以前</option><option value="60">60 天以前</option><option value="90">90 天以前</option><option value="180">180 天以前</option><option value="custom">自定义截止日期</option></select></label><label>截止日期<input id="cleanup-date" type="date" required></label><label class="cleanup-check"><input id="cleanup-include-favorites" type="checkbox">也包含收藏和星标邮件（默认不清理）</label><button id="cleanup-preview" type="button">预览待清理邮件</button></fieldset><div id="cleanup-preview-results" aria-live="polite"></div><div id="cleanup-confirmation" class="hidden"><p class="cleanup-warning">执行后会永久删除所列邮件的服务器副本，网页版及其他设备可能无法再查看，无法通过本地备份恢复到服务器。执行前自动创建备份，本地邮件及附件保留在原来的收件箱等文件夹中。</p><label class="cleanup-check"><input id="cleanup-ack" type="checkbox">我已核对列表，理解这是服务器删除，本地邮件保持原位不变。</label><label>输入当前邮箱地址以确认<input id="cleanup-confirm-email" autocomplete="off" placeholder="输入邮箱地址"></label></div><p id="cleanup-error" role="alert"></p><div id="cleanup-result" aria-live="polite"></div><footer><button id="cleanup-close" type="button">关闭</button><button id="cleanup-execute" type="button" disabled>备份并清理服务器</button></footer></dialog>`);
function cleanupDate(days) {
  const value = new Date(); value.setDate(value.getDate() - days);
  return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
}
function invalidateCleanupPreview(resetOffset = true) {
  if (resetOffset) cleanupOffset = 0;
  ++cleanupRevision; cleanupPreview = null;
  document.getElementById('cleanup-preview-results').replaceChildren();
  document.getElementById('cleanup-confirmation').classList.add('hidden');
  document.getElementById('cleanup-ack').checked = false;
  document.getElementById('cleanup-confirm-email').value = '';
  syncCleanupConfirmation();
}
function syncCleanupConfirmation() {
  document.getElementById('cleanup-execute').disabled = cleanupBusy || !cleanupPreview?.count || !document.getElementById('cleanup-ack').checked || document.getElementById('cleanup-confirm-email').value.trim().toLowerCase() !== cleanupPreview.account.toLowerCase();
}
function setCleanupBusy(busy) {
  cleanupBusy = busy;
  document.getElementById('cleanup-options').disabled = busy;
  document.getElementById('cleanup-close').disabled = busy;
  document.getElementById('cleanup-ack').disabled = busy;
  document.getElementById('cleanup-confirm-email').disabled = busy;
  syncCleanupConfirmation();
}
function renderCleanupResult(result) {
  const label = {completed:'清理完成',failed:'清理已停止',attention:'服务器结果需要核对',running:'上次清理尚未确认完成，请先核对服务器；不会自动重试'}[result.status] || result.status;
  return `<p><b>${esc(label)}</b> · 服务器已确认删除 ${Number(result.completed || 0)} 封，本地原位保留 ${Number(result.preserved ?? result.archived ?? 0)} 封</p>${result.backup ? `<p>安全备份：${esc(result.backup)}</p>` : ''}${(result.errors || []).map(error => `<p>${esc(error)}</p>`).join('')}${result.status === 'attention' ? '<p>本地副本已保留。由于连接中断或状态变化，尚未确认的邮件不会自动重新删除，请先在网页版核对。</p>' : ''}`;
}
async function refreshCleanupHistory(accountId) {
  try {
    const rows = await api('/api/system/server-cleanup/history', {accountId});
    if (accountId !== activeMailAccount()?.id) return;
    document.getElementById('server-cleanup-history').innerHTML = rows.length ? `<details><summary>最近清理记录（${rows.length}）</summary>${rows.map(row => `<div><small>${esc(row.created_at)} · ${esc(row.folder)}</small>${renderCleanupResult(row)}</div>`).join('')}</details>` : '';
  } catch (_) {}
}
document.getElementById('btn-server-cleanup').onclick = async () => {
  const dialog = document.getElementById('server-cleanup-dialog');
  dialog.dataset.accountId = activeMailAccount()?.id || '';
  document.getElementById('cleanup-account').textContent = '当前邮箱：' + (activeMailAccount()?.user || '');
  document.getElementById('cleanup-age').value = '30';
  document.getElementById('cleanup-date').value = cleanupDate(30);
  document.getElementById('cleanup-date').max = cleanupDate(1);
  document.getElementById('cleanup-include-favorites').checked = false;
  document.getElementById('cleanup-result').replaceChildren();
  document.getElementById('cleanup-error').textContent = '';
  invalidateCleanupPreview(); dialog.showModal(); setCleanupBusy(true);
  try {
    const folders = await api('/api/mail/folders', {accountId:dialog.dataset.accountId});
    const items = Array.isArray(folders) ? folders : folders.folders || [];
    document.getElementById('cleanup-folder').innerHTML = items.filter(item => item.selectable !== false).map(item => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('');
    const inbox = items.find(item => item.role === 'inbox' || item.name === 'INBOX');
    if (inbox) document.getElementById('cleanup-folder').value = inbox.name;
    refreshCleanupHistory(dialog.dataset.accountId);
  } catch (error) { document.getElementById('cleanup-error').textContent = error.message; }
  finally { setCleanupBusy(false); }
};
document.getElementById('cleanup-age').onchange = event => { if (event.target.value !== 'custom') document.getElementById('cleanup-date').value = cleanupDate(Number(event.target.value)); invalidateCleanupPreview(); };
for (const id of ['cleanup-folder','cleanup-date','cleanup-include-favorites']) document.getElementById(id).onchange = () => { if (id === 'cleanup-date') document.getElementById('cleanup-age').value = 'custom'; invalidateCleanupPreview(); };
for (const id of ['cleanup-ack','cleanup-confirm-email']) document.getElementById(id).oninput = syncCleanupConfirmation;
document.getElementById('cleanup-close').onclick = () => document.getElementById('server-cleanup-dialog').close();
document.getElementById('server-cleanup-dialog').oncancel = event => { if (cleanupBusy) event.preventDefault(); };
document.getElementById('cleanup-preview').onclick = async event => {
  invalidateCleanupPreview(false);
  const revision = cleanupRevision, dialog = document.getElementById('server-cleanup-dialog');
  const button = event.currentTarget; setCleanupBusy(true); setLoading(button,true,'校验本地原文与服务器…');
  document.getElementById('cleanup-error').textContent = '';
  document.getElementById('cleanup-result').replaceChildren();
  try {
    const result = await api('/api/system/server-cleanup/preview', {accountId:dialog.dataset.accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offset:cleanupOffset,folder:document.getElementById('cleanup-folder').value,before_date:document.getElementById('cleanup-date').value,include_favorites:document.getElementById('cleanup-include-favorites').checked})});
    if (revision !== cleanupRevision) return;
    cleanupPreview = result;
    document.getElementById('cleanup-preview-results').innerHTML = `<p><b>待清理 ${result.count} 封 · ${formatFileSize(result.bytes)}</b></p><p>已核对完整原文与服务器一致。预览 10 分钟内有效。实际释放容量由服务器统计为准。</p><div class="cleanup-mail-list">${result.items.map(item => `<div><b>${esc(item.subject)}</b><small>${esc(item.from_addr || '')} · ${esc(item.date || '')} · ${formatFileSize(item.size)}</small></div>`).join('')}</div>${result.skipped.length ? `<details><summary>跳过 ${result.skipped.length} 封</summary>${result.skipped.map(item=>`<p>${esc(item.subject)}：${esc(item.reason)}</p>`).join('')}</details>` : ''}${result.more ? '<p>还有邮件未列入本批，本次只清理上方列表。</p><button type="button" data-cleanup-page="next">查看下一批</button>' : ''}${result.offset ? '<button type="button" data-cleanup-page="previous">查看上一批</button>' : ''}`;
    document.getElementById('cleanup-confirmation').classList.toggle('hidden', !result.count);
  } catch (error) { document.getElementById('cleanup-error').textContent = error.message; }
  finally { setLoading(button,false); setCleanupBusy(false); }
};
document.getElementById('cleanup-execute').onclick = async event => {
  if (event.currentTarget.disabled) return;
  const dialog = document.getElementById('server-cleanup-dialog'), token = cleanupPreview.token;
  setCleanupBusy(true); const button = event.currentTarget; setLoading(button,true,'正在备份并清理，请勿退出…');
  try {
    const result = await api('/api/system/server-cleanup/execute', {accountId:dialog.dataset.accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,confirmation:document.getElementById('cleanup-confirm-email').value,acknowledge:document.getElementById('cleanup-ack').checked})});
    document.getElementById('cleanup-result').innerHTML = renderCleanupResult(result);
    await loadData(); await loadBackups(); await refreshCleanupHistory(dialog.dataset.accountId);
  } catch (error) { document.getElementById('cleanup-error').textContent = error.message + '。若请求已开始，请查看最近清理记录并核对服务器，不要盲目重试。'; }
  finally { invalidateCleanupPreview(); setLoading(button,false); setCleanupBusy(false); }
};

document.getElementById('cleanup-preview-results').addEventListener('click', event => {
  const button = event.target.closest('[data-cleanup-page]');
  if (!button || cleanupBusy) return;
  cleanupOffset = Math.max(0, cleanupOffset + (button.dataset.cleanupPage === 'next' ? 50 : -50));
  document.getElementById('cleanup-preview').click();
});
