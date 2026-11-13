/* Local backups, encrypted portable migration packages, and account logout confirmation. */
function renderBackupItem(item, index) {
  const date = new Date(item.created_at);
  const locale = currentI18nLanguage() === 'en' ? 'en-US' : 'zh-CN';
  const label = Number.isNaN(date.getTime()) ? (mailaiT('backup.localFallback') || '本地备份') : new Intl.DateTimeFormat(locale, {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date);
  const tSave = mailaiT('backup.saveAs') || '另存为';
  const tDelete = mailaiT('backup.delete') || '删除';
  const tRestore = mailaiT('backup.restore') || '恢复';
  const tPortable = mailaiT('backup.portable') || '迁移包';
  const download = `<button type="button" data-download-backup="${esc(item.filename)}" data-portable="${item.portable ? 'true' : 'false'}" aria-label="${item.portable ? (mailaiT('backup.ariaExport') || '导出迁移包到指定位置') : (mailaiT('backup.ariaDownload') || `下载 ${esc(label)} 的备份`)}" data-i18n="backup.saveAs" data-i18n-aria="${item.portable ? 'backup.ariaExport' : 'backup.ariaDownload'}">${tSave}</button>`;
  const remove = `<button type="button" data-delete-backup="${esc(item.filename)}" data-portable="${item.portable ? 'true' : 'false'}" aria-label="${mailaiT('backup.ariaDelete') || '删除'} ${item.portable ? tPortable : (mailaiT('backup.ariaBackup') || '备份')}" data-i18n="backup.delete" data-i18n-aria="${item.portable ? 'backup.deleteMigrationAria' : 'backup.deleteLocalAria'}">${tDelete}</button>`;
  const actions = item.portable ? `${download}${remove}` : `<button type="button" data-restore-backup="${esc(item.filename)}" aria-label="${mailaiT('backup.ariaRestore') || `恢复 ${esc(label)} 的备份`}" data-i18n="backup.restore" data-i18n-aria="backup.ariaRestore">${tRestore}</button>${download}${remove}`;
  return `<div class="backup-item"><div class="backup-record-copy"><b>${Number.isNaN(date.getTime()) ? `<span data-i18n="backup.localFallback">${esc(label)}</span>` : esc(label)}${item.portable ? `<em data-i18n="backup.portable">${tPortable}</em>` : index === 0 ? `<em data-i18n="backup.latest">${mailaiT('backup.latest') || '最新'}</em>` : ''}</b><small title="${esc(item.filename)}">${esc(item.filename)}</small></div><small class="backup-record-size">${formatFileSize(item.size)}</small><div class="backup-record-actions">${actions}</div></div>`;
}

async function loadBackups() {
  const accountId = activeMailAccount()?.id;
  window.refreshCleanupAutomation?.(accountId);
  const host = document.getElementById('backup-list');
  try {
    const [localItems, portableItems] = await Promise.all([api('/api/system/backups', {accountId}), api('/api/system/portable-backups', {accountId})]);
    const items = [...portableItems, ...localItems].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
    if (accountId !== activeMailAccount()?.id) return;
    host.innerHTML = items.length ? items.slice(0, 3).map(renderBackupItem).join('') + (items.length > 3 ? `<details class="older-backups"><summary><span data-i18n="backup.showOlder">${mailaiT('backup.showOlder') || '查看更早备份'}</span> (${items.length - 3})</summary>${items.slice(3).map((item,index)=>renderBackupItem(item,index+3)).join('')}</details>` : '') : `<div class="backup-empty"><b data-i18n="backup.emptyTitle">${mailaiT('backup.emptyTitle') || '还没有备份'}</b><small data-i18n="backup.emptyHint">${mailaiT('backup.emptyHint') || '创建第一份备份，为邮件留一份本地副本。'}</small></div>`;
    window.refreshCleanupHistory?.(accountId);
  } catch (_) {
    if (accountId === activeMailAccount()?.id) host.innerHTML = `<div class="backup-empty"><b data-i18n="backup.loadFailTitle">${mailaiT('backup.loadFailTitle') || '暂时无法读取备份'}</b><small data-i18n="backup.loadFailHint">${mailaiT('backup.loadFailHint') || '请稍后重新打开此页。'}</small></div>`;
  }
}

document.getElementById('btn-create-backup').addEventListener('click', async () => {
  const button = document.getElementById('btn-create-backup'); setLoading(button, true, mailaiText('备份中…'));
  try { const result = await api('/api/system/backups?include_raw=true', {method:'POST'}); toast(mailaiTemplate`备份完成 · ${formatFileSize(result.size)}`, 'success'); await loadBackups(); }
  catch (err) { toast(mailaiSystemMessage(err.message), 'error'); } finally { setLoading(button, false); }
});

function askMigrationPassword(mode) {
  const dialog = document.getElementById('migration-password-dialog');
  const form = dialog.querySelector('form');
  const password = document.getElementById('migration-password');
  const confirmation = document.getElementById('migration-password-confirm');
  const confirmationRow = document.getElementById('migration-password-confirm-row');
  const noPasswordRow = document.getElementById('migration-no-password-row');
  const noPassword = document.getElementById('migration-no-password');
  const error = document.getElementById('migration-password-error');
  const importing = mode === 'import';
  mailaiBindUI(document.getElementById('migration-password-title'), "textContent", () => (importing ? mailaiText('输入迁移密码') : mailaiText('保护迁移包')));
  mailaiBindUI(document.getElementById('migration-password-help'), "textContent", () => (importing ? mailaiText('该迁移包已加密。请输入旧设备导出时设置的密码。密码只用于本次解密。') : mailaiText('迁移包包含邮件正文和附件。设置密码后，即使文件遗失也无法直接读取内容。')));
  password.value = ''; confirmation.value = ''; noPassword.checked = false; error.textContent = '';
  confirmationRow.classList.toggle('hidden', importing); noPasswordRow.classList.toggle('hidden', importing);
  password.disabled = false; confirmation.disabled = importing;
  return new Promise(resolve => {
    let completed = false;
    const finish = value => { if (completed) return; completed = true; cleanup(); resolve(value); };
    const cleanup = () => { form.removeEventListener('submit', submit); noPassword.removeEventListener('change', toggle); dialog.removeEventListener('close', close); };
    const close = () => { if (dialog.returnValue !== 'migration-ok') finish(null); };
    const toggle = () => { password.disabled = noPassword.checked; confirmation.disabled = noPassword.checked; error.textContent = ''; };
    const submit = event => {
      event.preventDefault();
      if (event.submitter?.value === 'cancel') { dialog.close('cancel'); return; }
      if (!importing && noPassword.checked) { dialog.close('migration-ok'); finish(''); return; }
      if (password.value.length < 12 && !importing) { mailaiBindUI(error, "textContent", () => (mailaiText('迁移密码至少需要 12 位'))); password.focus(); return; }
      if (!password.value && importing) { mailaiBindUI(error, "textContent", () => (mailaiText('请输入迁移密码'))); password.focus(); return; }
      if (!importing && password.value !== confirmation.value) { mailaiBindUI(error, "textContent", () => (mailaiText('两次输入的密码不一致'))); confirmation.focus(); return; }
      const value = password.value; dialog.close('migration-ok'); finish(value);
    };
    form.addEventListener('submit', submit); noPassword.addEventListener('change', toggle); dialog.addEventListener('close', close);
    dialog.showModal(); setTimeout(() => password.focus(), 0);
  });
}

document.getElementById('btn-export-portable').addEventListener('click', async () => {
  const button = document.getElementById('btn-export-portable');
  const since = document.getElementById('portable-export-since')?.value || '';
  const until = document.getElementById('portable-export-until')?.value || '';
  if (since && until && since > until) { toast(mailaiText('导出起始日期不能晚于截止日期'), 'warn'); return; }
  const password = await askMigrationPassword('export');
  if (password === null) return;
  setLoading(button, true, mailaiText('导出中…'));
  try {
    const result = await api('/api/system/portable-backups', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({include_raw:true,password,since,until})});
    if (window.pywebview?.api?.save_portable_backup) {
      const saved = await window.pywebview.api.save_portable_backup(result.filename);
      if (saved?.ok) toast(mailaiTemplate`迁移包已保存到 ${saved.path}`, 'success');
      else if (saved?.canceled) toast(mailaiText('已取消选择位置；迁移包仍保存在下方记录中，可随时重新下载'), 'warn');
      else throw new Error(mailaiText('无法保存迁移包'));
    } else {
      const link = document.createElement('a'); link.href = result.download_url; link.download = result.filename; document.body.appendChild(link); link.click(); link.remove();
      toast(mailaiTemplate`迁移包已交给浏览器下载 · ${formatFileSize(result.size)}，请在下载列表中查看位置`, 'success');
    }
    await loadBackups();
  } catch (err) { toast(mailaiSystemMessage(err.message), 'error'); } finally { setLoading(button, false); }
});
document.getElementById('btn-import-portable').addEventListener('click', () => document.getElementById('portable-backup-file').click());

document.getElementById('portable-backup-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const encrypted = [77,65,73,76,65,73,51,0].every((value,index) => signature[index] === value);
  let password = '';
  if (encrypted) {
    password = await askMigrationPassword('import');
    if (password === null) return;
  }
  const button = document.getElementById('btn-import-portable'); setLoading(button, true, mailaiText('检查中…'));
  try {
    const accountId = activeMailAccount()?.id || '';
    const response = await fetch('/api/system/portable-backups/inspect', {method:'POST', headers:{'Content-Type':'application/octet-stream','X-Migration-Password':password,...(accountId ? {'X-MailAI-Account':accountId} : {})}, body:file});
    const preview = await response.json(); if (!response.ok) throw new Error(preview.detail || mailaiText('迁移包检查失败'));
    const content = preview.content || {}, account = preview.account || {};
    if (!preview.current_account_matches) {
      await api(`/api/system/portable-backups/import/${encodeURIComponent(preview.import_token)}`, {method:'DELETE'}).catch(()=>{});
      throw new Error(mailaiTemplate`迁移包属于 ${account.email || mailaiText('未知账号')}，请先切换或登录该邮箱后再导入`);
    }
    const sourceDate = preview.created_at ? new Date(preview.created_at).toLocaleString(currentI18nLanguage()) : mailaiText('未知时间');
    const rawState = content.includes_raw_mail ? mailaiTemplate`${content.raw_messages || 0} 份邮件原文` : mailaiText('不含邮件原文');
    const missing = content.missing_raw_messages ? mailaiTemplate`\n注意：源设备有 ${content.missing_raw_messages} 份原文缺失。` : '';
    const confirmed = window.confirm(mailaiTemplate`迁移包检查通过\n\n账号：${account.email}\n来源：${preview.source_platform || mailaiText('未知系统')}\n导出时间：${sourceDate}\n内容：${content.emails || 0} 封邮件，${rawState}\n文件大小：${formatFileSize(preview.source_size || file.size)}${missing}\n\n导入会替换当前账号的本地数据，并先自动创建安全备份。服务器邮件不会被删除或修改。继续吗？`);
    if (!confirmed) { await api(`/api/system/portable-backups/import/${encodeURIComponent(preview.import_token)}`, {method:'DELETE'}).catch(()=>{}); return; }
    setLoading(button, true, mailaiText('导入中…'));
    const result = await api('/api/system/portable-backups/restore', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({import_token:preview.import_token,password})});
    if (window.confirm(mailaiTemplate`已导入 ${result.emails || 0} 封邮件。\n\n是否现在重新同步邮箱，以建立新设备的服务器关联？邮件较多时可能需要较长时间。`)) {
      await api('/api/fetch_all', {method:'POST'});
    }
    window.location.reload();
  } catch (err) { toast(mailaiSystemMessage(err.message), 'error'); } finally { setLoading(button, false); }
});

document.getElementById('backup-list').addEventListener('click', event => {
  const restoreButton = event.target.closest('[data-restore-backup]');
  if (restoreButton) { window.openBackupRestore(restoreButton.dataset.restoreBackup); return; }
  const downloadButton = event.target.closest('[data-download-backup]');
  const deleteButton = event.target.closest('[data-delete-backup]');
  if (deleteButton) {
    const filename = deleteButton.dataset.deleteBackup;
    const portable = deleteButton.dataset.portable === 'true';
    if (!window.confirm(mailaiTemplate`确定永久删除这个${portable ? mailaiText('迁移包') : mailaiText('本机备份')}吗？\n\n${filename}\n\n删除后无法恢复。`)) return;
    (async () => {
      setLoading(deleteButton, true, mailaiText('删除中…'));
      try {
        const path = portable ? `/api/system/portable-backups/stored/${encodeURIComponent(filename)}` : `/api/system/backups/${encodeURIComponent(filename)}`;
        await api(path, {method:'DELETE'});
        toast(mailaiTemplate`${portable ? mailaiText('迁移包') : mailaiText('备份')}已删除`, 'success');
        await loadBackups();
      } catch (err) { toast(mailaiTemplate`删除失败：${mailaiSystemMessage(err.message)}`, 'error'); }
      finally { setLoading(deleteButton, false); }
    })();
    return;
  }
  if (!downloadButton) return;
  const filename = downloadButton.dataset.downloadBackup;
  const portable = downloadButton.dataset.portable === 'true';
  (async () => {
    setLoading(downloadButton, true, mailaiText('选择位置…'));
    try {
      if (window.pywebview?.api) {
        const method = portable ? window.pywebview.api.save_portable_backup : window.pywebview.api.save_local_backup;
        if (typeof method === 'function') {
          const result = await method(filename);
          if (result?.ok) toast(mailaiTemplate`已保存到 ${result.path}`, 'success');
          else if (result?.canceled) toast(mailaiText('已取消另存为，原备份仍保留在应用中'), 'warn');
          else throw new Error(mailaiText('保存失败'));
          return;
        }
      }
      const href = portable ? `/api/system/portable-backups/download/${encodeURIComponent(filename)}` : `/api/system/backups/${encodeURIComponent(filename)}`;
      const link = document.createElement('a'); link.href = href; link.download = filename; link.hidden = true; document.body.appendChild(link); link.click(); link.remove();
      toast(mailaiText('已交给浏览器下载，请在下载列表中查看保存位置'), 'success');
    } catch (err) { toast(mailaiTemplate`备份另存失败：${mailaiSystemMessage(err.message)}`, 'error'); }
    finally { setLoading(downloadButton, false); }
  })();
});

function openLogoutDialog(accountId = selectedManagedAccountId) {
  const modal = document.getElementById('logout-modal');
  const accounts = _systemConfig?.accounts || [];
  const target = accounts.find(account => account.id === accountId);
  if (!target) return toast(mailaiText('请先选择要删除的邮箱'), 'error');
  modal.dataset.accountId = target.id;
  mailaiBindUI(document.getElementById('logout-account-label'), "textContent", () => (mailaiTemplate`${target.user} · 将移除本机保存的邮箱账号和授权码`));
  const keep = modal.querySelector('input[value="keep"]');
  keep.checked = true;
  modal.querySelectorAll('.logout-choice').forEach(choice => choice.classList.toggle('selected', choice.contains(keep)));
  document.getElementById('logout-warning').classList.add('hidden');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  keep.focus();
}

function closeLogoutDialog() {
  const modal = document.getElementById('logout-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

async function stopFetchBeforeLogout() {
  let state = await api('/api/fetch_status');
  if (!state.running) return;
  await api('/api/cancel_fetch', {method: 'POST'});
  toast(mailaiText('正在安全停止邮件同步…'));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    state = await api('/api/fetch_status');
    if (!state.running) return;
  }
  throw new Error(mailaiText('邮件同步仍在停止中，请稍后再次删除'));
}

document.getElementById('btn-delete-mail').addEventListener('click', () => openLogoutDialog());
document.getElementById('btn-close-logout').addEventListener('click', closeLogoutDialog);
document.getElementById('btn-cancel-logout').addEventListener('click', closeLogoutDialog);
document.querySelector('#logout-modal [data-close-logout]').addEventListener('click', closeLogoutDialog);
document.querySelectorAll('input[name="logout-history"]').forEach(input => input.addEventListener('change', () => {
  document.querySelectorAll('.logout-choice').forEach(choice => choice.classList.toggle('selected', choice.contains(input)));
  document.getElementById('logout-warning').classList.toggle('hidden', input.value !== 'clear');
}));
document.getElementById('btn-confirm-logout').addEventListener('click', async () => {
  const button = document.getElementById('btn-confirm-logout');
  const clearHistory = document.querySelector('input[name="logout-history"]:checked').value === 'clear';
  setLoading(button, true, clearHistory ? mailaiText('正在清空…') : mailaiText('正在删除…'));
  try {
    await stopFetchBeforeLogout();
    const accountId = document.getElementById('logout-modal').dataset.accountId || '';
    const targetWasActive = (_systemConfig?.accounts || []).some(account => account.id === accountId && account.active);
    await api('/api/system/mail/logout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({clear_history: clearHistory, account_id: accountId})});
    closeLogoutDialog();
    selectedManagedAccountId = '';
    await loadSystemConfig();
    if (targetWasActive) {
      ++mailLoadRevision;
      allEmails = []; allTodos = []; sentMessages = []; savedDrafts = []; mailboxLocalCounts = null;
      resetReadingPane(); updateSidebar(); applyFilters();
    }
    selectSystemTab('account');
    document.querySelector('.layout').classList.add('hidden');
    document.getElementById('system-view').classList.remove('hidden');
    toast(clearHistory ? mailaiText('已删除邮箱并清空本地邮件历史') : mailaiText('已删除邮箱，本地邮件历史已保留'), 'success');
  } catch (err) { toast(mailaiText('删除失败：') + mailaiSystemMessage(err.message), 'error'); }
  finally { setLoading(button, false); }
});

globalThis.MailAIModules?.register('backupMigration', {
  renderBackupItem,
  loadBackups,
  askMigrationPassword,
  openLogoutDialog,
  closeLogoutDialog,
  stopFetchBeforeLogout,
});
