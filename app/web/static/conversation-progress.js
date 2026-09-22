/* Evidence-only progress, scoped to the current reading view and mailbox. */
function renderConversationProgress(email) {
  if (['trash','spam','quarantine','draft'].includes(email.status)) return '';
  return `<dialog id="conversation-progress-dialog" aria-label="会话进展"><header class="progress-dialog-header"><h2>会话进展</h2><button type="button" onclick="document.getElementById('conversation-progress-dialog').close()" aria-label="关闭会话进展">✕</button></header><section id="conversation-progress" class="conversation-progress" tabindex="-1" aria-label="会话进展" data-email-id="${Number(email.id)}" data-account-id="${esc(activeMailAccount()?.id || '')}"><div class="progress-loading" role="status">正在整理会话进展…</div></section></dialog>`;

}

let conversationProgressRevision = 0;
function conversationProgressMarkup(data) {
  const source = item => `<button type="button" data-progress-source="${item.source}" data-progress-id="${Number(item.id)}">${item.current ? '正在阅读' : item.source === 'sent' ? '查看发件记录' : '查看原邮件'}</button>`;
  const latest = data.timeline[0];
  const changes = data.changes?.items || [];
  const risky = data.timeline.some(item => item.risky) || changes.some(item => item.risky);
  return `<div class="progress-disclosure"><div class="progress-overview-row"><span class="progress-overview"><span>${Number(data.linked_count)} 封往来${changes.length ? ` · ${changes.length}${data.changes.limited ? '+' : ''} 项变化待核对` : ''}${data.truncated ? ' · 部分记录' : ''}</span></span></div>
    <div class="progress-detail"><header><h3>往来与任务</h3><span>${esc(data.status)}</span></header>
    <p class="progress-next">${esc(data.next_step)}</p>
    ${latest && data.linked_count > 1 ? `<div class="progress-latest"><small>最新往来 · ${latest.direction === 'outgoing' ? '发出' : '收到'} · ${esc(fmtDate(latest.date) || '时间未知')}</small><p>${esc(latest.excerpt || latest.subject)}</p>${latest.risky ? '<strong class="progress-risk">此邮件存在风险，请先核实来源</strong>' : ''}${source(latest)}</div>` : ''}
    ${data.changes?.items?.length ? `<section class="progress-changes" aria-label="变化线索"><h4>变化线索</h4><p class="progress-scope">仅识别原文明确的调整表述；不代表最终安排，不会自动修改待办或对外确认。</p>${data.changes.items.map(change => `<article><b>${esc(change.label)}</b><div class="progress-date-pair"><span>${change.kind === 'amount' ? '原金额' : '原日期'}：${esc(change.before || '原文未写明')}</span><span>${change.kind === 'amount' ? '提及的新金额' : '提及的新日期'}：${esc(change.after)}</span></div>${change.comparison ? `<p>${esc(change.comparison)}</p>` : ''}<blockquote>${esc(change.quote)}</blockquote><small>${esc(change.sender)} · ${esc(fmtDate(change.date))}</small>${change.risky ? '<strong class="progress-risk">来源需核实</strong>' : ''}${source(change)}</article>`).join('')}${data.changes.limited ? '<p>先展示 8 条线索，请结合完整往来核对。</p>' : ''}</section>` : ''}
    <h4 class="progress-history-title">往来记录</h4>
      <ol class="progress-timeline">${data.timeline.map(item => `<li><div><b>${item.direction === 'outgoing' ? '发出' : '收到'} · ${esc(item.sender)}</b><time>${esc(fmtDate(item.date) || '时间未知')}</time></div><p>${esc(item.subject)}</p><blockquote>${esc(item.excerpt || '暂无可展示的正文片段')}</blockquote>${item.risky ? '<small class="progress-risk">来源需核实</small>' : ''}${source(item)}</li>`).join('')}</ol>
      <div class="progress-tasks"><h4>已保存的待办</h4>${data.tasks.length ? data.tasks.map(task => `<article><span><b>${esc(task.title)}</b><small>${task.user_edited ? '已由你保存' : '自动提取，待核对'} · ${task.status === 'done' ? '已完成' : task.stage === 'waiting' ? '等待反馈' : '待推进'}${task.deadline ? ' · ' + esc(task.deadline) : ''}</small></span><button type="button" data-progress-task="${Number(task.id)}">核对 / 更新</button></article>`).join('') : '<p>尚未保存待办；不能据此判断是否已处理。</p>'}
      <button type="button" data-progress-plan>安排当前邮件</button></div>
      <p class="progress-scope">${esc(data.basis)}<br>${esc(data.scope)}${data.truncated ? '<br>关联记录已达到本次展示上限，不能视为完整会话。' : ''}</p>
    <footer><small>${esc(data.account_user)} · 本地整理</small><button type="button" data-progress-refresh>刷新进展</button></footer></div></div><div class="progress-notice">${risky ? '<span class="progress-risk">往来中有来源需核实，请核对原文。</span>' : esc(data.status)}</div>`;
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
    if (current()) host.innerHTML = `<p role="status">会话进展暂时无法读取：${esc(error.message)}</p><button type="button" data-progress-refresh>重新加载</button>`;
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
  } catch (error) { toast('操作未完成：' + error.message, 'warn'); }
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
