// Device-wide, local model usage. No provider balance or billing requests.
(() => {
  const trigger = document.getElementById('model-usage-open');
  if (!trigger) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'model-usage-dialog';
  dialog.setAttribute('aria-labelledby', 'model-usage-title');
  dialog.innerHTML = `<header><div><h2 id="model-usage-title">MailAI 用量统计</h2><small>仅统计本机 MailAI 的模型调用，不代表订阅额度或账单</small></div><button type="button" data-close aria-label="关闭">×</button></header>
    <div class="usage-filters"><label>时间 <select id="usage-period"><option value="all">全部</option><option value="today">今日</option><option value="month">本月</option></select></label><label>邮箱 <select id="usage-account"><option value="">全部邮箱</option></select></label></div>
    <div id="usage-body" aria-live="polite"></div><footer>调用结束后更新 · 仅保存用量元数据，不保存正文或密钥 · 启用前的历史用量无法补算</footer>`;
  document.body.append(dialog);
  let busy = false, generation = 0;
  const format = value => Number(value || 0).toLocaleString();
  const compact = value => Intl.NumberFormat('en', {notation:'compact',maximumFractionDigits:1}).format(value || 0);
  async function refresh() {
    if (busy || document.hidden) return;
    const visible = dialog.open || trigger.getClientRects().length;
    if (!visible) return;
    busy = true;
    const gen = generation;
    const period = dialog.querySelector('#usage-period').value;
    const account = dialog.querySelector('#usage-account').value;
    try {
      const total = await api('/api/system/model-usage');
      document.getElementById('model-usage-total').textContent = compact(total.total);
      trigger.title = `已记录 ${format(total.total)} Tokens；${format(total.unreported)} 次调用未报告用量`;
      if (!dialog.open) return;
      const data = period === 'all' && !account ? total : await api(`/api/system/model-usage?period=${period}&account=${encodeURIComponent(account)}`);
      if (gen !== generation) return;
      const picker = dialog.querySelector('#usage-account');
      picker.innerHTML = '<option value="">全部邮箱</option>' + total.accounts.filter(Boolean).map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      picker.value = account;
      dialog.querySelector('#usage-body').innerHTML = `<div class="usage-metrics"><div><small>已记录 Token 总量</small><strong>${format(data.total)}</strong></div><div><small>输入</small><b>${format(data.input)}</b></div><div><small>输出</small><b>${format(data.output)}</b></div></div>
        <p class="usage-note">${format(data.calls)} 次调用 · ${format(data.unreported)} 次未报告总用量${total.started_at ? ` · 开始记录于 ${new Date(total.started_at*1000).toLocaleDateString()}` : ''}。未报告不等于零消耗；总量以接口返回为准，缓存等明细不重复累加。</p>
        <div class="usage-table"><table><thead><tr><th>API / 模型</th><th>输入</th><th>输出</th><th>总量</th><th>调用 / 未报告</th></tr></thead><tbody>${data.rows.map(row => `<tr><td><b>${esc(row.provider)} · ${esc(row.model)}</b><small>${esc(row.endpoint)}</small></td><td>${format(row.input)}</td><td>${format(row.output)}</td><td>${format(row.total)}</td><td>${format(row.calls)} / ${format(row.unreported)}</td></tr>`).join('')}</tbody></table></div>${!data.rows.length ? '<p class="usage-empty">当前范围暂无调用记录。使用邮件 AI 功能后会自动累计。</p>' : ''}`;
    } catch (_) {
      if (dialog.open && gen === generation) dialog.querySelector('#usage-body').textContent = '用量暂时无法读取，稍后会自动重试；不影响邮件使用。';
    } finally {
      busy = false;
      if (gen !== generation) refresh();
    }
  }
  trigger.onclick = event => { event.preventDefault(); event.stopPropagation(); dialog.showModal(); generation++; refresh(); };
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => trigger.focus());
  dialog.querySelectorAll('select').forEach(select => select.onchange = () => { generation++; refresh(); });
  document.addEventListener('visibilitychange', refresh);
  document.getElementById('btn-preferences')?.addEventListener('click', () => setTimeout(refresh, 0));
  setInterval(refresh, 3000);
  refresh();
})();
