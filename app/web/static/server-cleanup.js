/* Account-scoped manual cleanup and opt-in scheduled cleanup settings. */
/* 文案走 mailaiT（i18n.js 在 bundle 中最先加载），对话框静态文案用 data-i18n 钩子。 */
function cleanupT(key, zh) {
  const value = typeof mailaiT === 'function' ? mailaiT(key) : null;
  return value || zh;
}
let cleanupPreview = null;
let cleanupOffset = 0;
let cleanupBusy = false;
let cleanupRevision = 0;
document.body.insertAdjacentHTML('beforeend', `<dialog id="server-cleanup-dialog" class="library-dialog cleanup-dialog" aria-labelledby="cleanup-title"><h2 id="cleanup-title" data-i18n="cleanup.title">清理服务器邮件</h2><p id="cleanup-account"></p><p data-i18n="cleanup.intro">仅清理本机已同步且原文完整的邮件。未同步邮件不会被清理；每批最多 50 封、100 MB。邮件日期早于截止日期才会入选，不含截止当天。</p><fieldset id="cleanup-options"><label><span data-i18n="cleanup.folderLabel">服务器文件夹</span><select id="cleanup-folder"></select></label><label><span data-i18n="cleanup.ageLabel">清理范围</span><select id="cleanup-age"><option value="30" data-i18n="cleanup.age30">30 天以前</option><option value="60" data-i18n="cleanup.age60">60 天以前</option><option value="90" data-i18n="cleanup.age90">90 天以前</option><option value="180" data-i18n="cleanup.age180">180 天以前</option><option value="custom" data-i18n="cleanup.ageCustom">自定义截止日期</option></select></label><label><span data-i18n="cleanup.dateLabel">截止日期</span><input id="cleanup-date" type="date" required></label><label class="cleanup-check"><input id="cleanup-include-favorites" type="checkbox"><span data-i18n="cleanup.includeFavorites">也包含收藏和星标邮件（默认不清理）</span></label><button id="cleanup-preview" type="button" data-i18n="cleanup.previewBtn">预览待清理邮件</button></fieldset><div id="cleanup-preview-results" aria-live="polite"></div><div id="cleanup-confirmation" class="hidden"><p class="cleanup-warning" data-i18n="cleanup.warning">执行后会永久删除所列邮件的服务器副本，网页版及其他设备可能无法再查看，无法通过本地备份恢复到服务器。执行前自动创建备份，本地邮件及附件保留在原来的收件箱等文件夹中。</p><label class="cleanup-check"><input id="cleanup-ack" type="checkbox"><span data-i18n="cleanup.ack">我已核对列表，理解这是服务器删除，本地邮件保持原位不变。</span></label><label><span data-i18n="cleanup.confirmLabel">输入当前邮箱地址以确认</span><input id="cleanup-confirm-email" autocomplete="off" placeholder="输入邮箱地址" data-i18n-placeholder="cleanup.confirmPh"></label></div><p id="cleanup-error" role="alert"></p><div id="cleanup-result" aria-live="polite"></div><footer><button id="cleanup-close" type="button" data-i18n="dlg.close">关闭</button><button id="cleanup-execute" type="button" disabled data-i18n="cleanup.execute">备份并清理服务器</button></footer></dialog>`);
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
  const label = {completed: cleanupT('cleanup.st.completed', '清理完成'),
    failed: cleanupT('cleanup.st.failed', '清理已停止'),
    attention: cleanupT('cleanup.st.attention', '服务器结果需要核对'),
    running: cleanupT('cleanup.st.running', '上次清理尚未确认完成，请先核对服务器；不会自动重试')}[result.status] || result.status;
  const summary = cleanupT('cleanup.resultSummary', '服务器已确认删除 {done} 封，本地原位保留 {kept} 封')
    .replace('{done}', Number(result.completed || 0)).replace('{kept}', Number(result.preserved ?? result.archived ?? 0));
  return `<p><b>${esc(label)}</b>${result.source === 'automatic' ? ` · ${esc(cleanupT('cleanupAuto.source', '自动执行'))}` : ''} · ${esc(summary)}</p>${result.backup ? `<p>${esc(cleanupT('cleanup.backupNote', '安全备份：'))}${esc(result.backup)}</p>` : ''}${(result.errors || []).map(error => `<p>${esc(error)}</p>`).join('')}${result.status === 'attention' ? `<p>${esc(cleanupT('cleanup.attentionNote', '本地副本已保留。由于连接中断或状态变化，尚未确认的邮件不会自动重新删除，请先在网页版核对。'))}</p>` : ''}`;
}
async function refreshCleanupHistory(accountId) {
  try {
    const rows = await api('/api/system/server-cleanup/history', {accountId});
    if (accountId !== activeMailAccount()?.id) return;
    document.getElementById('server-cleanup-history').innerHTML = rows.length ? `<details><summary>${esc(cleanupT('cleanup.historyTitle', '最近清理记录（{n}）').replace('{n}', rows.length))}</summary>${rows.map(row => `<div><small>${esc(row.created_at)} · ${esc(row.folder)}</small>${renderCleanupResult(row)}</div>`).join('')}</details>` : '';
  } catch (_) {}
}
document.getElementById('btn-server-cleanup').onclick = async () => {
  const dialog = document.getElementById('server-cleanup-dialog');
  dialog.dataset.accountId = activeMailAccount()?.id || '';
  document.getElementById('cleanup-account').textContent = cleanupT('cleanup.currentAccount', '当前邮箱：') + (activeMailAccount()?.user || '');
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
  } catch (error) { document.getElementById('cleanup-error').textContent = mailaiSystemMessage(error.message); }
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
  const button = event.currentTarget; setCleanupBusy(true); setLoading(button,true,cleanupT('cleanup.checking', '校验本地原文与服务器…'));
  document.getElementById('cleanup-error').textContent = '';
  document.getElementById('cleanup-result').replaceChildren();
  try {
    const result = await api('/api/system/server-cleanup/preview', {accountId:dialog.dataset.accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offset:cleanupOffset,folder:document.getElementById('cleanup-folder').value,before_date:document.getElementById('cleanup-date').value,include_favorites:document.getElementById('cleanup-include-favorites').checked})});
    if (revision !== cleanupRevision) return;
    cleanupPreview = result;
    document.getElementById('cleanup-preview-results').innerHTML = `<p><b>${esc(cleanupT('cleanup.previewSummary', '待清理 {count} 封').replace('{count}', result.count))} · ${formatFileSize(result.bytes)}</b></p><p>${esc(cleanupT('cleanup.previewNote', '已核对完整原文与服务器一致。预览 10 分钟内有效。实际释放容量由服务器统计为准。'))}</p><div class="cleanup-mail-list">${result.items.map(item => `<div><b>${esc(item.subject)}</b><small>${esc(item.from_addr || '')} · ${esc(item.date || '')} · ${formatFileSize(item.size)}</small></div>`).join('')}</div>${result.skipped.length ? `<details><summary>${esc(cleanupT('cleanup.skipped', '跳过 {n} 封').replace('{n}', result.skipped.length))}</summary>${result.skipped.map(item=>`<p>${esc(item.subject)}：${esc(item.reason)}</p>`).join('')}</details>` : ''}${result.more ? `<p>${esc(cleanupT('cleanup.moreNote', '还有邮件未列入本批，本次只清理上方列表。'))}</p><button type="button" data-cleanup-page="next">${esc(cleanupT('cleanup.nextPage', '查看下一批'))}</button>` : ''}${result.offset ? `<button type="button" data-cleanup-page="previous">${esc(cleanupT('cleanup.prevPage', '查看上一批'))}</button>` : ''}`;
    document.getElementById('cleanup-confirmation').classList.toggle('hidden', !result.count);
  } catch (error) { document.getElementById('cleanup-error').textContent = mailaiSystemMessage(error.message); }
  finally { setLoading(button,false); setCleanupBusy(false); }
};
document.getElementById('cleanup-execute').onclick = async event => {
  if (event.currentTarget.disabled) return;
  const dialog = document.getElementById('server-cleanup-dialog'), token = cleanupPreview.token;
  setCleanupBusy(true); const button = event.currentTarget; setLoading(button,true,cleanupT('cleanup.executing', '正在备份并清理，请勿退出…'));
  try {
    const result = await api('/api/system/server-cleanup/execute', {accountId:dialog.dataset.accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,confirmation:document.getElementById('cleanup-confirm-email').value,acknowledge:document.getElementById('cleanup-ack').checked})});
    document.getElementById('cleanup-result').innerHTML = renderCleanupResult(result);
    await loadData(); await loadBackups(); await refreshCleanupHistory(dialog.dataset.accountId);
  } catch (error) { document.getElementById('cleanup-error').textContent = mailaiSystemMessage(error.message) + cleanupT('cleanup.errorSuffix', '。若请求已开始，请查看最近清理记录并核对服务器，不要盲目重试。'); }
  finally { invalidateCleanupPreview(); setLoading(button,false); setCleanupBusy(false); }
};

document.getElementById('cleanup-preview-results').addEventListener('click', event => {
  const button = event.target.closest('[data-cleanup-page]');
  if (!button || cleanupBusy) return;
  cleanupOffset = Math.max(0, cleanupOffset + (button.dataset.cleanupPage === 'next' ? 50 : -50));
  document.getElementById('cleanup-preview').click();
});

document.body.insertAdjacentHTML('beforeend', `<dialog id="cleanup-auto-dialog" class="library-dialog cleanup-dialog" aria-labelledby="cleanup-auto-title">
  <h2 id="cleanup-auto-title" data-i18n="cleanupAuto.settings">自动清理设置</h2>
  <p id="cleanup-auto-account"></p>
  <p data-i18n="cleanupAuto.intro">按规则清理服务器副本，邮件和附件完整保留在本机。每次先校验原文并备份，最多清理 50 封、100 MB，始终保留收藏和星标邮件。</p>
  <label class="cleanup-check"><input id="cleanup-auto-enabled" type="checkbox"><span data-i18n="cleanupAuto.enable">启用此邮箱的自动清理</span></label>
  <fieldset id="cleanup-auto-options">
    <label><span data-i18n="cleanup.folderLabel">服务器文件夹</span><select id="cleanup-auto-folder"></select></label>
    <label><span data-i18n="cleanupAuto.retention">服务器保留时间</span><select id="cleanup-auto-days">
      <option value="30" data-i18n="cleanupAuto.days30">保留最近 30 天</option><option value="60" data-i18n="cleanupAuto.days60">保留最近 60 天</option><option value="90" data-i18n="cleanupAuto.days90">保留最近 90 天</option><option value="180" data-i18n="cleanupAuto.days180">保留最近 180 天</option><option value="365" data-i18n="cleanupAuto.days365">保留最近 365 天</option>
    </select></label>
    <label><span data-i18n="cleanupAuto.frequency">执行频率</span><select id="cleanup-auto-interval"><option value="1" data-i18n="cleanupAuto.daily">每天</option><option value="7" data-i18n="cleanupAuto.weekly">每周</option></select></label>
  </fieldset>
  <p data-i18n="cleanupAuto.scheduleHint">保存后，首次在所选周期结束时执行。应用运行且邮箱空闲时检查；关闭应用期间的任务会在下次启动后执行。失败或中断后自动暂停。</p>
  <div id="cleanup-auto-authorization" class="hidden">
    <p class="cleanup-warning" data-i18n="cleanupAuto.warning">启用后将按此规则自动永久删除服务器副本，不再逐次确认。网页版及其他设备可能无法再查看，本地备份不会将邮件恢复到服务器。</p>
    <label class="cleanup-check"><input id="cleanup-auto-ack" type="checkbox"><span data-i18n="cleanupAuto.ack">我理解以上影响，授权按所选规则自动备份并清理服务器。</span></label>
    <label><span data-i18n="cleanup.confirmLabel">输入当前邮箱地址以确认</span><input id="cleanup-auto-email" autocomplete="off" placeholder="输入邮箱地址" data-i18n-placeholder="cleanup.confirmPh"></label>
  </div>
  <p id="cleanup-auto-error" role="alert"></p>
  <footer><button id="cleanup-auto-close" type="button" data-i18n="dlg.close">关闭</button><button id="cleanup-auto-save" type="button" disabled data-i18n="cleanupAuto.save">保存设置</button></footer>
</dialog>`);
let cleanupAutoBusy = false;
let cleanupAutoLoaded = false;
let cleanupAutoUser = '';
let cleanupAutoLoadRevision = 0;

function renderCleanupAutomation(policy) {
  const key = !policy.enabled ? 'cleanupAuto.off' : policy.status === 'paused' || policy.status === 'running' ? 'cleanupAuto.paused' : 'cleanupAuto.on';
  const badge = document.getElementById('cleanup-mode-badge');
  badge.dataset.i18n = key;
  badge.textContent = cleanupT(key, '自动清理已关闭');
  badge.classList.toggle('caution', policy.enabled && ['paused', 'running'].includes(policy.status));
  const summary = document.getElementById('cleanup-auto-summary');
  if (!policy.enabled) { summary.textContent = ''; return; }
  if (['paused', 'running'].includes(policy.status)) {
    summary.textContent = cleanupT('cleanupAuto.pauseHint', '请核对最近清理记录和服务器，再到自动清理设置中重新启用。') + (policy.last_error ? ` ${mailaiSystemMessage(policy.last_error)}` : '');
    return;
  }
  const when = new Date(policy.next_run).toLocaleString(currentI18nLanguage() === 'en' ? 'en-US' : 'zh-CN', {hour12:false});
  summary.textContent = cleanupT('cleanupAuto.summary', '{0} · 保留最近 {1} 天 · 下次：{2}（应用运行时）').replace('{0}', policy.folder).replace('{1}', policy.days).replace('{2}', when);
}

async function refreshCleanupAutomation(accountId) {
  const revision = ++cleanupAutoLoadRevision;
  const badge = document.getElementById('cleanup-mode-badge');
  badge.dataset.i18n = 'cleanupAuto.loading'; badge.textContent = cleanupT('cleanupAuto.loading', '正在读取清理设置…');
  document.getElementById('cleanup-auto-summary').textContent = '';
  try {
    const policy = await api('/api/system/server-cleanup/automation', {accountId});
    if (revision === cleanupAutoLoadRevision && accountId === activeMailAccount()?.id) renderCleanupAutomation(policy);
  } catch (_) {
    if (revision !== cleanupAutoLoadRevision || accountId !== activeMailAccount()?.id) return;
    badge.dataset.i18n = 'cleanupAuto.loadFailed'; badge.textContent = cleanupT('cleanupAuto.loadFailed', '清理设置读取失败');
  }
}

function syncCleanupAutomation() {
  const enabled = document.getElementById('cleanup-auto-enabled').checked;
  document.getElementById('cleanup-auto-enabled').disabled = cleanupAutoBusy || !cleanupAutoLoaded;
  document.getElementById('cleanup-auto-options').disabled = cleanupAutoBusy || !enabled || !cleanupAutoLoaded;
  document.getElementById('cleanup-auto-authorization').classList.toggle('hidden', !enabled);
  document.getElementById('cleanup-auto-ack').disabled = cleanupAutoBusy;
  document.getElementById('cleanup-auto-email').disabled = cleanupAutoBusy;
  document.getElementById('cleanup-auto-close').disabled = cleanupAutoBusy;
  document.getElementById('cleanup-auto-save').disabled = cleanupAutoBusy || !cleanupAutoLoaded || (enabled && (!document.getElementById('cleanup-auto-folder').value || !document.getElementById('cleanup-auto-ack').checked || document.getElementById('cleanup-auto-email').value.trim().toLowerCase() !== cleanupAutoUser.toLowerCase()));
}

document.getElementById('btn-cleanup-automation').onclick = async () => {
  const dialog = document.getElementById('cleanup-auto-dialog');
  const accountId = activeMailAccount()?.id || '';
  dialog.dataset.accountId = accountId;
  cleanupAutoUser = activeMailAccount()?.user || '';
  document.getElementById('cleanup-auto-account').textContent = cleanupT('cleanup.currentAccount', '当前邮箱：') + cleanupAutoUser;
  document.getElementById('cleanup-auto-enabled').checked = false;
  document.getElementById('cleanup-auto-ack').checked = false;
  document.getElementById('cleanup-auto-email').value = '';
  document.getElementById('cleanup-auto-error').textContent = '';
  cleanupAutoBusy = true; cleanupAutoLoaded = false; syncCleanupAutomation(); dialog.showModal();
  try {
    const [policyResult, folderResult] = await Promise.allSettled([api('/api/system/server-cleanup/automation', {accountId}), api('/api/mail/folders', {accountId})]);
    if (policyResult.status !== 'fulfilled') throw policyResult.reason;
    const policy = policyResult.value, folders = folderResult.status === 'fulfilled' ? folderResult.value : [];
    if (folderResult.status !== 'fulfilled') document.getElementById('cleanup-auto-error').textContent = mailaiSystemMessage(folderResult.reason.message);
    const items = (Array.isArray(folders) ? folders : folders.folders || []).filter(item => item.selectable !== false);
    // Keep a removed folder selectable so users can still turn automation off.
    if (!items.some(item => item.name === policy.folder)) items.push({name:policy.folder});
    document.getElementById('cleanup-auto-folder').innerHTML = items.map(item => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('');
    document.getElementById('cleanup-auto-folder').value = policy.folder;
    document.getElementById('cleanup-auto-days').value = String(policy.days);
    document.getElementById('cleanup-auto-interval').value = String(policy.interval_days);
    document.getElementById('cleanup-auto-enabled').checked = policy.enabled;
    cleanupAutoLoaded = true;
  } catch (error) { document.getElementById('cleanup-auto-error').textContent = mailaiSystemMessage(error.message); }
  finally { cleanupAutoBusy = false; syncCleanupAutomation(); }
};
for (const id of ['cleanup-auto-enabled','cleanup-auto-folder','cleanup-auto-days','cleanup-auto-interval']) document.getElementById(id).onchange = () => {
  document.getElementById('cleanup-auto-ack').checked = false;
  document.getElementById('cleanup-auto-email').value = '';
  syncCleanupAutomation();
};
for (const id of ['cleanup-auto-ack','cleanup-auto-email']) document.getElementById(id).oninput = syncCleanupAutomation;
document.getElementById('cleanup-auto-close').onclick = () => document.getElementById('cleanup-auto-dialog').close();
document.getElementById('cleanup-auto-dialog').oncancel = event => { if (cleanupAutoBusy) event.preventDefault(); };
document.getElementById('cleanup-auto-save').onclick = async event => {
  if (event.currentTarget.disabled) return;
  const dialog = document.getElementById('cleanup-auto-dialog'), accountId = dialog.dataset.accountId;
  const body = {enabled:document.getElementById('cleanup-auto-enabled').checked, folder:document.getElementById('cleanup-auto-folder').value,
    days:Number(document.getElementById('cleanup-auto-days').value), interval_days:Number(document.getElementById('cleanup-auto-interval').value),
    acknowledge:document.getElementById('cleanup-auto-ack').checked, confirmation:document.getElementById('cleanup-auto-email').value};
  cleanupAutoBusy = true; syncCleanupAutomation();
  document.getElementById('cleanup-auto-error').textContent = '';
  try {
    const policy = await api('/api/system/server-cleanup/automation', {accountId, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if (accountId === activeMailAccount()?.id) { ++cleanupAutoLoadRevision; renderCleanupAutomation(policy); }
    dialog.close(); toast(cleanupT('cleanupAuto.saved', '自动清理设置已保存'), 'success');
  } catch (error) { document.getElementById('cleanup-auto-error').textContent = mailaiSystemMessage(error.message); }
  finally { cleanupAutoBusy = false; syncCleanupAutomation(); }
};
