/* Account-local collections, contact groups and selective backup recovery. */
let contactGroups = [];
let contactGroupAccount = '';
async function refreshContactGroups() {
  const accountId = contactAccountId(), session = contactCenterSession;
  const groups = await api('/api/mail/contact-groups', {accountId});
  if (session !== contactCenterSession || accountId !== contactAccountId()) return;
  contactGroupAccount = accountId;
  contactGroups = groups;
  const filter = document.getElementById('contact-group-filter');
  const selected = filter.value;
  filter.innerHTML = '<option value="">全部分组</option><option value="__ungrouped__">未分组</option>' + groups.map(g => `<option value="${esc(g.name)}">${esc(g.name)} (${g.count})</option>`).join('');
  filter.value = [...filter.options].some(o => o.value === selected) ? selected : '';
  document.getElementById('contact-group-options').innerHTML = groups.map(g => `<option value="${esc(g.name)}"></option>`).join('');
  updateContactGroupControls();
}
function updateContactGroupControls() {
  const group = document.getElementById('contact-group-filter').value;
  for (const id of ['group-rename','group-delete','group-add-members']) document.getElementById(id).disabled = !group || group === '__ungrouped__';
  document.getElementById('group-select-all').classList.toggle('hidden', !contactPickerTarget);
}
function initializeContactGroups() {
  document.getElementById('contact-company').parentElement.insertAdjacentHTML('afterend', '<label>分组<input id="contact-group-name" list="contact-group-options" maxlength="80" placeholder="选择或输入分组名称"><datalist id="contact-group-options"></datalist></label>');
  document.querySelector('.contact-center-tools').insertAdjacentHTML('afterend', `<div class="contact-group-toolbar"><select id="contact-group-filter" aria-label="联系人分组"><option value="">全部分组</option></select><button id="group-create" type="button">新增分组</button><button id="group-add-members" type="button" disabled>添加人员</button><button id="group-rename" type="button" disabled>修改分组</button><button id="group-delete" type="button" disabled>删除分组</button><button id="group-select-all" type="button" class="hidden">全选当前列表</button></div>`);
  document.getElementById('contact-group-filter').onchange = () => { loadContactCenter(); updateContactGroupControls(); };
  document.getElementById('group-select-all').onclick = () => {
    const group = document.getElementById('contact-group-filter').value;
    contactCenterItems.filter(item => !group || (group === '__ungrouped__' ? !item.group_name : item.group_name === group)).forEach(item => selectedContactEmails.add(item.email));
    renderContactCenter();
  };
  document.body.insertAdjacentHTML('beforeend', `<dialog id="group-dialog" class="library-dialog"><form id="group-dialog-form"><h2 id="group-dialog-title">新增分组</h2><label>分组名称<input id="group-dialog-name" maxlength="80" required autocomplete="off"></label><p id="group-dialog-error" role="alert"></p><footer><button type="button" data-library-close="group-dialog">取消</button><button type="submit">保存分组</button></footer></form></dialog>`);
  const open = rename => {
    const dialog = document.getElementById('group-dialog');
    dialog.dataset.previous = rename ? document.getElementById('contact-group-filter').value : '';
    dialog.dataset.accountId = contactAccountId();
    document.getElementById('group-dialog-title').textContent = rename ? '修改分组' : '新增分组';
    document.getElementById('group-dialog-name').value = dialog.dataset.previous;
    document.getElementById('group-dialog-error').textContent = '';
    dialog.showModal();
  };
  document.getElementById('group-add-members').onclick = openGroupMemberPicker;
  document.getElementById('group-create').onclick = () => open(false);
  document.getElementById('group-rename').onclick = () => open(true);
  document.getElementById('group-dialog-form').onsubmit = async event => {
    event.preventDefault();
    const dialog = document.getElementById('group-dialog'), button = event.submitter;
    const session = contactCenterSession;
    setLoading(button, true, '保存中…');
    try {
      const result = await api('/api/mail/contact-groups', {accountId:dialog.dataset.accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('group-dialog-name').value,previous:dialog.dataset.previous || null})});
      if (session !== contactCenterSession) return;
      dialog.close();
      await refreshContactGroups();
      if (session !== contactCenterSession) return;
      document.getElementById('contact-group-filter').value = result.name;
      await loadContactCenter(); updateContactGroupControls();
      toast('分组已保存，点击“添加人员”选择已有联系人', 'success');
    } catch (error) { document.getElementById('group-dialog-error').textContent = error.message; }
    finally { setLoading(button, false); }
  };
  document.getElementById('group-delete').onclick = async event => {
    const name = document.getElementById('contact-group-filter').value;
    if (!name || !confirm(`删除分组“${name}”？组内联系人会保留并移至未分组。`)) return;
    const button = event.currentTarget; setLoading(button,true,'删除中…');
    const session = contactCenterSession;
    try { await api(`/api/mail/contact-groups?name=${encodeURIComponent(name)}`, {accountId:contactAccountId(),method:'DELETE'}); if (session !== contactCenterSession) return; document.getElementById('contact-group-filter').value = ''; await loadContactCenter(); }
    catch (error) { toast(error.message,'error'); }
    finally { setLoading(button,false); }
  };
}

function openBackupRestore(filename) {
  const dialog = document.getElementById('backup-restore-dialog');
  dialog.dataset.filename = filename;
  dialog.dataset.accountId = activeMailAccount()?.id || '';
  document.getElementById('restore-filename').textContent = filename;
  document.getElementById('restore-error').textContent = '';
  document.getElementById('restore-mode').value = 'range';
  document.getElementById('restore-dates').disabled = false;
  document.getElementById('restore-start').value = '';
  document.getElementById('restore-end').value = '';
  dialog.showModal();
}
document.body.insertAdjacentHTML('beforeend', `<dialog id="backup-restore-dialog" class="library-dialog"><form id="backup-restore-form"><h2>恢复邮件备份</h2><p id="restore-filename" class="library-filename"></p><label>恢复方式<select id="restore-mode"><option value="range">按时间范围恢复邮件</option><option value="full">完整恢复所有备份数据</option></select></label><fieldset id="restore-dates"><legend>按邮件日期（包含开始和结束当天）</legend><label>开始日期<input type="date" id="restore-start" required></label><label>结束日期<input type="date" id="restore-end" required></label></fieldset><p>按范围恢复会合并所选邮件及原文附件，保留范围外邮件、通讯录和设置。完整恢复会替换当前数据。恢复前均会自动创建安全备份。</p><p id="restore-error" role="alert"></p><footer><button type="button" data-library-close="backup-restore-dialog">取消</button><button id="restore-submit" type="submit">开始恢复</button></footer></form></dialog>`);
document.getElementById('restore-mode').onchange = event => { document.getElementById('restore-dates').disabled = event.target.value === 'full'; };
document.addEventListener('click', event => { const button = event.target.closest('[data-library-close]'); if (button) document.getElementById(button.dataset.libraryClose).close(); });
document.getElementById('backup-restore-form').onsubmit = async event => {
  event.preventDefault();
  const dialog = document.getElementById('backup-restore-dialog');
  const ranged = document.getElementById('restore-mode').value === 'range';
  const start = document.getElementById('restore-start').value, end = document.getElementById('restore-end').value;
  const errorBox = document.getElementById('restore-error'); errorBox.textContent = '';
  if (ranged && (!start || !end || start > end)) { errorBox.textContent = '请选择有效日期，开始日期不能晚于结束日期'; return; }
  if (!ranged && !confirm('完整恢复将替换当前邮件、通讯录及备份内的其他数据，确认继续？')) return;
  const button = document.getElementById('restore-submit'); setLoading(button, true, '恢复中…');
  const cancel = dialog.querySelector('[data-library-close]'); cancel.disabled = true;
  dialog.oncancel = event => event.preventDefault();
  try {
    const query = ranged ? '?' + new URLSearchParams({start_date:start,end_date:end}) : '';
    const result = await api(`/api/system/backups/${encodeURIComponent(dialog.dataset.filename)}/restore${query}`, {accountId:dialog.dataset.accountId,method:'POST'});
    dialog.close();
    toast(`${ranged ? `已恢复 ${result.restored_count} 封邮件` : '完整恢复完成'}，已保留安全备份`, 'success');
    await loadData(); await loadBackups();
  } catch (error) { errorBox.textContent = error.message; }
  finally { setLoading(button, false); cancel.disabled = false; dialog.oncancel = null; }
};

let groupMemberSelection = new Map();
let groupMemberRevision = 0;
let groupMemberTimer;
document.body.insertAdjacentHTML('beforeend', `<dialog id="group-members-dialog" class="library-dialog group-members-dialog" aria-labelledby="group-members-title"><form id="group-members-form"><h2 id="group-members-title">添加已有人员</h2><p id="group-members-description"></p><label>搜索已有联系人<input id="group-members-search" type="search" placeholder="姓名、拼音、邮箱或公司" autocomplete="off"></label><p>支持多选。已有其他分组的人员加入后会移至当前分组；姓名、备注等资料保持不变。</p><div id="group-members-list" class="group-members-list" aria-live="polite"></div><p id="group-members-error" role="alert"></p><footer><span id="group-members-count">已选择 0 人</span><button type="button" data-library-close="group-members-dialog">取消</button><button type="submit" id="group-members-save" disabled>加入分组</button></footer></form></dialog>`);
function syncGroupMemberCount() {
  document.getElementById('group-members-count').textContent = `已选择 ${groupMemberSelection.size} 人`;
  document.getElementById('group-members-save').disabled = !groupMemberSelection.size;
}
async function loadGroupMemberCandidates() {
  const dialog = document.getElementById('group-members-dialog');
  const revision = ++groupMemberRevision;
  const host = document.getElementById('group-members-list');
  host.textContent = '正在加载联系人…';
  try {
    const items = await api(`/api/mail/contacts?limit=300&q=${encodeURIComponent(document.getElementById('group-members-search').value.trim())}`, {accountId:dialog.dataset.accountId});
    if (revision !== groupMemberRevision || !dialog.open) return;
    host.innerHTML = items.length ? items.map(item => {
      const member = item.group_name === dialog.dataset.group;
      return `<label class="group-member-option"><input type="checkbox" value="${esc(item.email)}" ${member ? 'checked disabled' : groupMemberSelection.has(item.email) ? 'checked' : ''}><span><b>${esc(item.name || item.email)}</b><small>${esc(item.email)}</small></span><em>${member ? '已在此组' : esc(item.group_name || '未分组')}</em></label>`;
    }).join('') + (items.length === 300 ? '<p>已显示前 300 位，请搜索以查找更多联系人。</p>' : '') : '<p>没有找到已有联系人，请尝试其他搜索词。</p>';
  } catch (error) {
    if (revision === groupMemberRevision) host.textContent = '加载失败：' + error.message;
  }
}
function openGroupMemberPicker() {
  const group = document.getElementById('contact-group-filter').value;
  if (!group || group === '__ungrouped__') return;
  const dialog = document.getElementById('group-members-dialog');
  dialog.dataset.group = group;
  dialog.dataset.accountId = contactAccountId();
  groupMemberSelection = new Map();
  document.getElementById('group-members-search').value = '';
  document.getElementById('group-members-error').textContent = '';
  document.getElementById('group-members-description').textContent = `加入分组：${group}`;
  syncGroupMemberCount(); dialog.showModal(); loadGroupMemberCandidates();
}
document.getElementById('group-members-search').oninput = () => {
  clearTimeout(groupMemberTimer); ++groupMemberRevision;
  groupMemberTimer = setTimeout(loadGroupMemberCandidates, 180);
};
document.getElementById('group-members-dialog').addEventListener('close', () => { ++groupMemberRevision; clearTimeout(groupMemberTimer); });
document.getElementById('group-members-list').onchange = event => {
  const input = event.target;
  if (!input.matches('input[type="checkbox"]')) return;
  if (input.checked) groupMemberSelection.set(input.value, true); else groupMemberSelection.delete(input.value);
  syncGroupMemberCount();
};
document.getElementById('group-members-form').onsubmit = async event => {
  event.preventDefault();
  const dialog = document.getElementById('group-members-dialog');
  const session = contactCenterSession;
  if (!groupMemberSelection.size) return;
  const button = document.getElementById('group-members-save'); setLoading(button, true, '添加中…');
  try {
    const result = await api('/api/mail/contact-groups/members', {accountId:dialog.dataset.accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:dialog.dataset.group,emails:[...groupMemberSelection.keys()]})});
    if (session !== contactCenterSession) return;
    dialog.close();
    if (session === contactCenterSession && dialog.dataset.accountId === contactAccountId()) {
      document.getElementById('contact-center-search').value = '';
      contactCenterFilter = 'all';
      document.querySelectorAll('[data-contact-filter]').forEach(item => item.classList.toggle('active', item.dataset.contactFilter === 'all'));
      await loadContactCenter();
    }
    toast(`已添加 ${result.count} 位人员`, 'success');
  } catch (error) { document.getElementById('group-members-error').textContent = error.message; }
  finally { setLoading(button, false); syncGroupMemberCount(); }
};
document.addEventListener('click', async event => {
  if (event.target.closest('[data-open-group-members]')) return openGroupMemberPicker();
  const button = event.target.closest('[data-group-remove-member]');
  if (!button) return;
  const name = document.getElementById('contact-group-filter').value;
  const session = contactCenterSession;
  setLoading(button, true, '移出中…');
  try {
    await api('/api/mail/contact-groups/members', {accountId:contactAccountId(),method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,emails:[button.dataset.groupRemoveMember],remove:true})});
    if (session !== contactCenterSession) return;
    await loadContactCenter(); toast('已移出分组，联系人仍保留在通讯录中', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { setLoading(button, false); }
});
