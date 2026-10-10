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
  filter.innerHTML = `<option value="">${mailaiT('contact.allGroups') || '全部分组'}</option><option value="__ungrouped__">${mailaiT('contact.ungrouped') || '未分组'}</option>` + groups.map(g => `<option value="${esc(g.name)}">${esc(g.name)} (${g.count})</option>`).join('');
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
  document.getElementById('contact-company').parentElement.insertAdjacentHTML('afterend', `<label><span data-i18n="contact.groupLabel">分组</span><input id="contact-group-name" list="contact-group-options" maxlength="80" data-i18n-placeholder="contact.groupPlaceholder" placeholder="选择或输入分组名称"><datalist id="contact-group-options"></datalist></label>`);
  document.querySelector('.contact-center-tools').insertAdjacentHTML('afterend', `<div class="contact-group-toolbar"><select id="contact-group-filter" aria-label="联系人分组" data-i18n-aria="contact.groupAria"><option value="">${mailaiT('contact.allGroups') || '全部分组'}</option></select><button id="group-create" type="button" data-i18n="contact.groupCreate">新增分组</button><button id="group-add-members" type="button" disabled data-i18n="contact.addMembers">添加人员</button><button id="group-rename" type="button" disabled data-i18n="contact.groupRename">修改分组</button><button id="group-delete" type="button" disabled data-i18n="contact.groupDelete">删除分组</button><button id="group-select-all" type="button" class="hidden" data-i18n="contact.selectAll">全选当前列表</button></div>`);
  document.getElementById('contact-group-filter').onchange = () => { loadContactCenter(); updateContactGroupControls(); };
  document.getElementById('group-select-all').onclick = () => {
    const group = document.getElementById('contact-group-filter').value;
    contactCenterItems.filter(item => !group || (group === '__ungrouped__' ? !item.group_name : item.group_name === group)).forEach(item => selectedContactEmails.add(item.email));
    renderContactCenter();
  };
  document.body.insertAdjacentHTML('beforeend', `<dialog id="group-dialog" class="library-dialog"><form id="group-dialog-form"><h2 id="group-dialog-title" data-i18n="contact.groupCreate">新增分组</h2><label><span data-i18n="contact.groupName">分组名称</span><input id="group-dialog-name" maxlength="80" required autocomplete="off"></label><p id="group-dialog-error" role="alert"></p><footer><button type="button" data-library-close="group-dialog" data-i18n="common.cancel">取消</button><button type="submit" data-i18n="contact.groupSave">保存分组</button></footer></form></dialog>`);
  const open = rename => {
    const dialog = document.getElementById('group-dialog');
    dialog.dataset.previous = rename ? document.getElementById('contact-group-filter').value : '';
    dialog.dataset.accountId = contactAccountId();
    mailaiBindUI(document.getElementById('group-dialog-title'), "textContent", () => (rename ? (mailaiT('contact.groupRename') || '修改分组') : (mailaiT('contact.groupCreate') || '新增分组')));
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
    setLoading(button, true, mailaiText('保存中…'));
    try {
      const result = await api('/api/mail/contact-groups', {accountId:dialog.dataset.accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('group-dialog-name').value,previous:dialog.dataset.previous || null})});
      if (session !== contactCenterSession) return;
      dialog.close();
      await refreshContactGroups();
      if (session !== contactCenterSession) return;
      document.getElementById('contact-group-filter').value = result.name;
      await loadContactCenter(); updateContactGroupControls();
      toast(mailaiText('分组已保存，点击“添加人员”选择已有联系人'), 'success');
    } catch (error) { document.getElementById('group-dialog-error').textContent = mailaiSystemMessage(error.message); }
    finally { setLoading(button, false); }
  };
  document.getElementById('group-delete').onclick = async event => {
    const name = document.getElementById('contact-group-filter').value;
    if (!name || !confirm(mailaiTemplate`删除分组“${name}”？组内联系人会保留并移至未分组。`)) return;
    const button = event.currentTarget; setLoading(button,true,mailaiText('删除中…'));
    const session = contactCenterSession;
    try { await api(`/api/mail/contact-groups?name=${encodeURIComponent(name)}`, {accountId:contactAccountId(),method:'DELETE'}); if (session !== contactCenterSession) return; document.getElementById('contact-group-filter').value = ''; await loadContactCenter(); }
    catch (error) { toast(mailaiSystemMessage(error.message),'error'); }
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
document.body.insertAdjacentHTML('beforeend', `<dialog id="backup-restore-dialog" class="library-dialog"><form id="backup-restore-form"><h2><span data-i18n="ui.9efbae489bd2">恢复邮件备份</span></h2><p id="restore-filename" class="library-filename"></p><label><span data-i18n="ui.08a4fbe4d6ae">恢复方式</span><select id="restore-mode"><option value="range" data-i18n="ui.0a1c05c630d5">按时间范围恢复邮件</option><option value="full" data-i18n="ui.1339bc94e01f">完整恢复所有备份数据</option></select></label><fieldset id="restore-dates"><legend><span data-i18n="ui.3bdda5f3718c">按邮件日期（包含开始和结束当天）</span></legend><label><span data-i18n="ui.760506491eef">开始日期</span><input type="date" id="restore-start" required></label><label><span data-i18n="ui.895cd52fbbb6">结束日期</span><input type="date" id="restore-end" required></label></fieldset><p><span data-i18n="ui.592c17cedc4e">按范围恢复会合并所选邮件及原文附件，保留范围外邮件、通讯录和设置。完整恢复会替换当前数据。恢复前均会自动创建安全备份。</span></p><p id="restore-error" role="alert"></p><footer><button type="button" data-library-close="backup-restore-dialog"><span data-i18n="ui.2cd0f3be8738">取消</span></button><button id="restore-submit" type="submit"><span data-i18n="ui.d558c25cd315">开始恢复</span></button></footer></form></dialog>`);
document.getElementById('restore-mode').onchange = event => { document.getElementById('restore-dates').disabled = event.target.value === 'full'; };
document.addEventListener('click', event => { const button = event.target.closest('[data-library-close]'); if (button) document.getElementById(button.dataset.libraryClose).close(); });
document.getElementById('backup-restore-form').onsubmit = async event => {
  event.preventDefault();
  const dialog = document.getElementById('backup-restore-dialog');
  const ranged = document.getElementById('restore-mode').value === 'range';
  const start = document.getElementById('restore-start').value, end = document.getElementById('restore-end').value;
  const errorBox = document.getElementById('restore-error'); errorBox.textContent = '';
  if (ranged && (!start || !end || start > end)) { mailaiBindUI(errorBox, "textContent", () => (mailaiText('请选择有效日期，开始日期不能晚于结束日期'))); return; }
  if (!ranged && !confirm(mailaiText('完整恢复将替换当前邮件、通讯录及备份内的其他数据，确认继续？'))) return;
  const button = document.getElementById('restore-submit'); setLoading(button, true, mailaiText('恢复中…'));
  const cancel = dialog.querySelector('[data-library-close]'); cancel.disabled = true;
  dialog.oncancel = event => event.preventDefault();
  try {
    const query = ranged ? '?' + new URLSearchParams({start_date:start,end_date:end}) : '';
    const result = await api(`/api/system/backups/${encodeURIComponent(dialog.dataset.filename)}/restore${query}`, {accountId:dialog.dataset.accountId,method:'POST'});
    dialog.close();
    toast(mailaiTemplate`${ranged ? mailaiTemplate`已恢复 ${result.restored_count} 封邮件` : mailaiText('完整恢复完成')}，已保留安全备份`, 'success');
    await loadData(); await loadBackups();
  } catch (error) { errorBox.textContent = mailaiSystemMessage(error.message); }
  finally { setLoading(button, false); cancel.disabled = false; dialog.oncancel = null; }
};

let groupMemberSelection = new Map();
let groupMemberRevision = 0;
let groupMemberTimer;
document.body.insertAdjacentHTML('beforeend', `<dialog id="group-members-dialog" class="library-dialog group-members-dialog" aria-labelledby="group-members-title"><form id="group-members-form"><h2 id="group-members-title"><span data-i18n="ui.9e72765c53ed">添加已有人员</span></h2><p id="group-members-description"></p><label><span data-i18n="ui.a0d79b9840f7">搜索已有联系人</span><input id="group-members-search" type="search" placeholder="姓名、拼音、邮箱或公司" autocomplete="off" data-i18n-placeholder="ui.a23f4b54dd2b"></label><p><span data-i18n="ui.a4d3a4fe552b">支持多选。已有其他分组的人员加入后会移至当前分组；姓名、备注等资料保持不变。</span></p><div id="group-members-list" class="group-members-list" aria-live="polite"></div><p id="group-members-error" role="alert"></p><footer><span id="group-members-count"><span data-i18n="ui.e8a5ee93c78a">已选择 0 人</span></span><button type="button" data-library-close="group-members-dialog"><span data-i18n="ui.2cd0f3be8738">取消</span></button><button type="submit" id="group-members-save" disabled><span data-i18n="ui.410513b14aed">加入分组</span></button></footer></form></dialog>`);
function syncGroupMemberCount() {
  mailaiBindUI(document.getElementById('group-members-count'), "textContent", () => (mailaiTemplate`已选择 ${groupMemberSelection.size} 人`));
  document.getElementById('group-members-save').disabled = !groupMemberSelection.size;
}
async function loadGroupMemberCandidates() {
  const dialog = document.getElementById('group-members-dialog');
  const revision = ++groupMemberRevision;
  const host = document.getElementById('group-members-list');
  mailaiBindUI(host, "textContent", () => (mailaiText('正在加载联系人…')));
  try {
    const items = await api(`/api/mail/contacts?limit=300&q=${encodeURIComponent(document.getElementById('group-members-search').value.trim())}`, {accountId:dialog.dataset.accountId});
    if (revision !== groupMemberRevision || !dialog.open) return;
    host.innerHTML = items.length ? items.map(item => {
      const member = item.group_name === dialog.dataset.group;
      return `<label class="group-member-option"><input type="checkbox" value="${esc(item.email)}" ${member ? 'checked disabled' : groupMemberSelection.has(item.email) ? 'checked' : ''}><span><b>${esc(item.name || item.email)}</b><small>${esc(item.email)}</small></span><em>${member ? mailaiText('已在此组') : esc(item.group_name || mailaiText('未分组'))}</em></label>`;
    }).join('') + (items.length === 300 ? "<p><span data-i18n=\"ui.539ba4463aeb\">已显示前 300 位，请搜索以查找更多联系人。</span></p>" : '') : "<p><span data-i18n=\"ui.41e3af3db4ca\">没有找到已有联系人，请尝试其他搜索词。</span></p>";
  } catch (error) {
    if (revision === groupMemberRevision) mailaiBindUI(host, "textContent", () => (mailaiText('加载失败：') + mailaiSystemMessage(error.message)));
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
  mailaiBindUI(document.getElementById('group-members-description'), "textContent", () => (mailaiTemplate`加入分组：${group}`));
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
  const button = document.getElementById('group-members-save'); setLoading(button, true, mailaiText('添加中…'));
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
    toast(mailaiTemplate`已添加 ${result.count} 位人员`, 'success');
  } catch (error) { document.getElementById('group-members-error').textContent = mailaiSystemMessage(error.message); }
  finally { setLoading(button, false); syncGroupMemberCount(); }
};
document.addEventListener('click', async event => {
  if (event.target.closest('[data-open-group-members]')) return openGroupMemberPicker();
  const button = event.target.closest('[data-group-remove-member]');
  if (!button) return;
  const name = document.getElementById('contact-group-filter').value;
  const session = contactCenterSession;
  setLoading(button, true, mailaiText('移出中…'));
  try {
    await api('/api/mail/contact-groups/members', {accountId:contactAccountId(),method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,emails:[button.dataset.groupRemoveMember],remove:true})});
    if (session !== contactCenterSession) return;
    await loadContactCenter(); toast(mailaiText('已移出分组，联系人仍保留在通讯录中'), 'success');
  } catch (error) { toast(mailaiSystemMessage(error.message), 'error'); }
  finally { setLoading(button, false); }
});
