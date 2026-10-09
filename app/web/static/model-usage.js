// Device-wide, local model usage. No provider balance or billing requests.
(() => {
  const trigger = document.getElementById('model-usage-open');
  if (!trigger) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'model-usage-dialog';
  dialog.setAttribute('aria-labelledby', 'model-usage-title');
  dialog.innerHTML = `<header><div><h2 id="model-usage-title"><span data-i18n="ui.ab149d081faa">MailAI 用量统计</span></h2><small><span data-i18n="ui.dd3ee0b1ba86">仅统计本机 MailAI 的模型调用，不代表订阅额度或账单</span></small></div><button type="button" data-close aria-label="关闭" data-i18n-aria="ui.3fd47edce45b">×</button></header>
    <div class="usage-filters"><label><span data-i18n="ui.8b6ff498515b">时间</span> <select id="usage-period"><option value="all" data-i18n="ui.5c55a67935af">全部</option><option value="today" data-i18n="ui.5c9cf5e0dd47">今日</option><option value="month" data-i18n="ui.0eeecd26f2ba">本月</option></select></label><label><span data-i18n="ui.73075237fd0f">邮箱</span> <select id="usage-account"><option value="" data-i18n="ui.9179a1b086c0">全部邮箱</option></select></label></div>
    <div id="usage-body" aria-live="polite"></div><footer><span data-i18n="ui.9a6703ae6ba8">调用结束后更新 · 仅保存用量元数据，不保存正文或密钥 · 启用前的历史用量无法补算</span></footer>`;
  document.body.append(dialog);
  let busy = false, generation = 0;
  const format = value => Number(value || 0).toLocaleString(currentI18nLanguage());
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
      mailaiBindUI(trigger, "title", () => (mailaiTemplate`已记录 ${format(total.total)} Tokens；${format(total.unreported)} 次调用未报告用量`));
      if (!dialog.open) return;
      const data = period === 'all' && !account ? total : await api(`/api/system/model-usage?period=${period}&account=${encodeURIComponent(account)}`);
      if (gen !== generation) return;
      const picker = dialog.querySelector('#usage-account');
      picker.innerHTML = "<option value=\"\" data-i18n=\"ui.9179a1b086c0\">全部邮箱</option>" + total.accounts.filter(Boolean).map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      picker.value = account;
      dialog.querySelector('#usage-body').innerHTML = `<div class="usage-metrics"><div><small><span data-i18n="ui.e1704a32311b">已记录 Token 总量</span></small><strong>${format(data.total)}</strong></div><div><small><span data-i18n="ui.2087c777c06f">输入</span></small><b>${format(data.input)}</b></div><div><small><span data-i18n="ui.fb04addb4c26">输出</span></small><b>${format(data.output)}</b></div></div>
        <p class="usage-note"><span data-i18n="ui.8c2aef22cc87">${format(data.calls)} 次调用 · ${format(data.unreported)} 次未报告总用量${total.started_at ? mailaiTemplate` · 开始记录于 ${new Date(total.started_at*1000).toLocaleDateString(currentI18nLanguage())}` : ''}。未报告不等于零消耗；总量以接口返回为准，缓存等明细不重复累加。</span></p>
        <div class="usage-table"><table><thead><tr><th><span data-i18n="ui.261852bad910">API / 模型</span></th><th><span data-i18n="ui.2087c777c06f">输入</span></th><th><span data-i18n="ui.fb04addb4c26">输出</span></th><th><span data-i18n="ui.f5ff358ff802">总量</span></th><th><span data-i18n="ui.b796358a78db">调用 / 未报告</span></th></tr></thead><tbody>${data.rows.map(row => `<tr><td><b>${esc(row.provider)} · ${esc(row.model)}</b><small>${esc(row.endpoint)}</small></td><td>${format(row.input)}</td><td>${format(row.output)}</td><td>${format(row.total)}</td><td>${format(row.calls)} / ${format(row.unreported)}</td></tr>`).join('')}</tbody></table></div>${!data.rows.length ? "<p class=\"usage-empty\"><span data-i18n=\"ui.7e918f1e3f4d\">当前范围暂无调用记录。使用邮件 AI 功能后会自动累计。</span></p>" : ''}`;
    } catch (_) {
      if (dialog.open && gen === generation) mailaiBindUI(dialog.querySelector('#usage-body'), "textContent", () => (mailaiText('用量暂时无法读取，稍后会自动重试；不影响邮件使用。')));
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
  document.getElementById('system-tabs')?.addEventListener('click', event => {
    if (event.target.closest('[data-system-tab="ai"]')) setTimeout(refresh, 0);
  });
  setInterval(refresh, 3000);
  refresh();
})();
