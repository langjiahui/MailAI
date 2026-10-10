/* Evidence-only progress, scoped to the current reading view and mailbox. */
function renderConversationProgress(email) {
  if (['trash','spam','quarantine','draft'].includes(email.status)) return '';
  return `<dialog id="conversation-progress-dialog" aria-label="会话进展" data-i18n-aria="ui.59cfae57ba5f"><header class="progress-dialog-header"><h2><span data-i18n="ui.59cfae57ba5f">会话进展</span></h2><button type="button" onclick="document.getElementById('conversation-progress-dialog').close()" aria-label="关闭会话进展" data-i18n-aria="ui.2a614de54490">✕</button></header><section id="conversation-progress" class="conversation-progress" tabindex="-1" aria-label="会话进展" data-email-id="${Number(email.id)}" data-account-id="${esc(activeMailAccount()?.id || '')}" data-i18n-aria="ui.59cfae57ba5f"><div class="progress-loading" role="status"><span data-i18n="ui.b4ae07e3e070">正在整理会话进展…</span></div></section></dialog>`;

}

let conversationProgressRevision = 0;
function conversationProgressMarkup(data) {
  const source = item => `<button type="button" data-progress-source="${item.source}" data-progress-id="${Number(item.id)}">${item.current ? mailaiText('正在阅读') : item.source === 'sent' ? mailaiText('查看发件记录') : mailaiText('查看原邮件')}</button>`;
  const latest = data.timeline[0];
  const changes = data.changes?.items || [];
  const risky = data.timeline.some(item => item.risky) || changes.some(item => item.risky);
  return `<div class="progress-disclosure"><div class="progress-overview-row"><span class="progress-overview"><span><span data-i18n="ui.7aab76566ee9">${Number(data.linked_count)} 封往来${changes.length ? mailaiTemplate` · ${changes.length}${data.changes.limited ? '+' : ''} 项变化待核对` : ''}${data.truncated ? mailaiText(' · 部分记录') : ''}</span></span></span></div>
    <div class="progress-detail"><header><h3><span data-i18n="ui.db098dcc78c3">往来与任务</span></h3><span>${esc(data.status)}</span></header>
    <p class="progress-next">${esc(data.next_step)}</p>
    ${latest && data.linked_count > 1 ? `<div class="progress-latest"><small><span data-i18n="ui.c0723d87ab23">最新往来 · ${latest.direction === 'outgoing' ? mailaiText('发出') : mailaiText('收到')} · ${esc(fmtDate(latest.date) || mailaiText('时间未知'))}</span></small><p>${esc(latest.excerpt || latest.subject)}</p>${latest.risky ? "<strong class=\"progress-risk\"><span data-i18n=\"ui.e23c06246ef4\">此邮件存在风险，请先核实来源</span></strong>" : ''}${source(latest)}</div>` : ''}
    ${data.changes?.items?.length ? `<section class="progress-changes" aria-label="变化线索" data-i18n-aria="ui.880c180e061e"><h4><span data-i18n="ui.880c180e061e">变化线索</span></h4><p class="progress-scope"><span data-i18n="ui.68d924757699">仅识别原文明确的调整表述；不代表最终安排，不会自动修改待办或对外确认。</span></p>${data.changes.items.map(change => `<article><b>${esc(change.label)}</b><div class="progress-date-pair"><span>${change.kind === 'amount' ? mailaiText('原金额') : mailaiText('原日期')}：${esc(change.before || mailaiText('原文未写明'))}</span><span>${change.kind === 'amount' ? mailaiText('提及的新金额') : mailaiText('提及的新日期')}：${esc(change.after)}</span></div>${change.comparison ? `<p>${esc(change.comparison)}</p>` : ''}<blockquote>${esc(change.quote)}</blockquote><small>${esc(change.sender)} · ${esc(fmtDate(change.date))}</small>${change.risky ? "<strong class=\"progress-risk\"><span data-i18n=\"ui.70b42c330ff3\">来源需核实</span></strong>" : ''}${source(change)}</article>`).join('')}${data.changes.limited ? "<p><span data-i18n=\"ui.33aead79a7af\">先展示 8 条线索，请结合完整往来核对。</span></p>" : ''}</section>` : ''}
    <h4 class="progress-history-title"><span data-i18n="ui.d6c42cae20d1">往来记录</span></h4>
      <ol class="progress-timeline">${data.timeline.map(item => `<li><div><b>${item.direction === 'outgoing' ? mailaiText('发出') : mailaiText('收到')} · ${esc(item.sender)}</b><time>${esc(fmtDate(item.date) || mailaiText('时间未知'))}</time></div><p>${esc(item.subject)}</p><blockquote>${esc(item.excerpt || mailaiText('暂无可展示的正文片段'))}</blockquote>${item.risky ? "<small class=\"progress-risk\"><span data-i18n=\"ui.70b42c330ff3\">来源需核实</span></small>" : ''}${source(item)}</li>`).join('')}</ol>
      <div class="progress-tasks"><h4><span data-i18n="ui.fa442de50c60">已保存的待办</span></h4>${data.tasks.length ? data.tasks.map(task => `<article><span><b>${esc(task.title)}</b><small>${task.user_edited ? mailaiText('已由你保存') : mailaiText('自动提取，待核对')} · ${task.status === 'done' ? mailaiText('已完成') : task.stage === 'waiting' ? mailaiText('等待反馈') : mailaiText('待推进')}${task.deadline ? ' · ' + esc(task.deadline) : ''}</small></span><button type="button" data-progress-task="${Number(task.id)}"><span data-i18n="ui.9e94ed3c2396">核对 / 更新</span></button></article>`).join('') : "<p><span data-i18n=\"ui.746a66738834\">尚未保存待办；不能据此判断是否已处理。</span></p>"}
      <button type="button" data-progress-plan><span data-i18n="ui.a10088fc3bc0">安排当前邮件</span></button></div>
      <p class="progress-scope">${esc(data.basis)}<br>${esc(data.scope)}${data.truncated ? "<br><span data-i18n=\"ui.fb8462742ac0\">关联记录已达到本次展示上限，不能视为完整会话。</span>" : ''}</p>
    <footer><small><span data-i18n="ui.820b1c85eff9">${esc(data.account_user)} · 本地整理</span></small><button type="button" data-progress-refresh><span data-i18n="ui.8cbe6a4d068e">刷新进展</span></button></footer></div></div><div class="progress-notice">${risky ? "<span class=\"progress-risk\"><span data-i18n=\"ui.dfdcf72cacea\">往来中有来源需核实，请核对原文。</span></span>" : esc(data.status)}</div>`;
}

async function loadConversationProgress(host = document.getElementById('conversation-progress')) {
  if (!host) return;
  const dialog = host.closest?.('dialog');
  if (dialog && !dialog.open) return;
  const revision = ++conversationProgressRevision;
  const accountId = host.dataset.accountId, emailId = Number(host.dataset.emailId);
  const current = () => host.isConnected && revision === conversationProgressRevision && accountId === activeMailAccount()?.id && selectedEmailDetail?.id === emailId;
  try {
    host.setAttribute('aria-busy', 'true');
    const data = await api(`/api/emails/${emailId}/progress`, {accountId});
    if (!current()) return;
    host.innerHTML = conversationProgressMarkup(data);
  } catch (error) {
    if (current()) host.innerHTML = `<p role="status"><span data-i18n="ui.9eb6444cf484">会话进展暂时无法读取：${esc(mailaiSystemMessage(error.message))}</span></p><button type="button" data-progress-refresh><span data-i18n="ui.7bdd5ce1e298">重新加载</span></button>`;
  } finally { if (current()) host.removeAttribute('aria-busy'); }
}

async function handleConversationProgressClick(event) {
  const host = event.target.closest('#conversation-progress');
  const button = event.target.closest('button');
  if (!host || !button || button.disabled) return;
  const accountId = host.dataset.accountId, emailId = Number(host.dataset.emailId);
  if (accountId !== activeMailAccount()?.id || selectedEmailDetail?.id !== emailId) return;
  if (button.hasAttribute('data-progress-refresh')) return loadConversationProgress(host);
  if (!button.hasAttribute('data-progress-refresh')) host.closest?.('dialog')?.close();
  button.disabled = true;
  try {
    if (button.hasAttribute('data-progress-plan') || button.dataset.progressTask) {
      const todoId = Number(button.dataset.progressTask);
      await window.openTaskPlanner(todoId ? {todoId, accountId} : {emailId, accountId});
    } else if (button.dataset.progressSource === 'sent') {
      const id = Number(button.dataset.progressId);
      const row = await api(`/api/mail/sent/${id}`, {accountId});
      if (!host.isConnected || accountId !== activeMailAccount()?.id) return;
      await openAccountMailbox(accountId, 'sent');
      if (accountId === activeMailAccount()?.id && specialMailbox === 'sent') await selectSpecialMessage(id, row);
    } else if (button.dataset.progressSource === 'email') {
      const id = Number(button.dataset.progressId);
      if (id === emailId) document.querySelector('#reading-content .reading-header')?.scrollIntoView({block:'start'});
      else await revealEmailFromSource(id);
    }
  } catch (error) { toast(mailaiText('操作未完成：') + mailaiSystemMessage(error.message), 'warn'); }
  finally { button.disabled = false; }
}

document.getElementById('reading-content').addEventListener('click', handleConversationProgressClick);
window.addEventListener('mailai-tasks-changed', event => {
  const host = document.getElementById('conversation-progress');
  if (host?.dataset.accountId === event.detail.accountId) loadConversationProgress(host);
});

function openConversationProgress() {
  const dialog = document.getElementById('conversation-progress-dialog');
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  loadConversationProgress();
}
