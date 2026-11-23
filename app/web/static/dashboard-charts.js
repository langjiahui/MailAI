/* Security dashboard KPI tweening, campaign signal mapping, and SVG trend/sender charts. */

function animateValue(el, target, decimals = 0, duration = 800) {
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    const val = from + (target - from) * eased;
    el.textContent = decimals ? val.toFixed(decimals) : Math.round(val);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// 关联研判信号是后端固定中文短语（app/security/campaigns.py），英文界面映射译文
function campaignSignalLabel(signal) {
  const keys = {'相同链接目标':'dash.signalLink', '主题高度相似':'dash.signalSubject', '正文话术相似':'dash.signalBody', '相同发件域':'dash.signalDomain'};
  return (keys[signal] && mailaiT(keys[signal])) || signal;
}

function renderDashboardCampaigns(items) {
  const host = document.getElementById('dashboard-campaign-list');
  if (!host) return;
  mailaiBindUI(document.getElementById('dashboard-campaign-count'), "textContent", () => (items.length ? (mailaiT('dash.campaignCount') || '{n} 组关联活动').replace('{n}', items.length) : ''));
  if (!items.length) {
    host.innerHTML = `<div class="dashboard-empty-state compact"><span><svg viewBox="0 0 20 20"><path d="M5 6h5l2 2h3v6H5z"/><path d="M7 4h4l2 2"/></svg></span><div><b>${mailaiT('dash.noCampaign') || '暂未发现成组攻击'}</b><small>${mailaiT('dash.noCampaignHint') || '相同链接、附件或话术会自动归并。'}</small></div></div>`;
    return;
  }
  host.innerHTML = items.map(item => {
    const first = (item.samples || [])[0] || {};
    return `<button type="button" class="dashboard-campaign-item" data-dashboard-email="${first.id || ''}">
      <span class="campaign-node"><b>${item.size}</b><small>${mailaiT('dash.campaignLinked') || '封关联'}</small></span>
      <span class="campaign-main"><b>${esc(first.subject || (mailaiT('dash.campaignMail') || '关联风险邮件'))}</b><small>${esc((item.signals || []).map(campaignSignalLabel).join(' · ') || (mailaiT('dash.campaignSimilar') || '内容特征相似'))} · ${(mailaiT('dash.campaignMaxScore') || '最高风险分 {n}').replace('{n}', item.max_score || 0)}</small></span>
      <span class="campaign-action">${mailaiT('dash.campaignView') || '查看影响面'} →</span>
    </button>`;
  }).join('');
}

function renderDashboardOutcome(data, ops) {
  const rows = [
    [mailaiT('dash.outcomeRisk') || '识别为风险', Number(ops.risk_count || 0), 'risk'],
    [mailaiT('dash.outcomeAuto') || '系统自动处置', Number(ops.auto_handled || 0), 'auto'],
    [mailaiT('dash.outcomeResolved') || '人工已确认', Number(ops.resolved_risk || 0), 'resolved'],
    [mailaiT('dash.outcomePending') || '本期仍待判断', Number(ops.pending_period || 0), 'pending'],
  ];
  const max = Math.max(1, ...rows.map(row => row[1]));
  document.getElementById('dashboard-outcome').innerHTML = rows.map(([label, value, kind]) => `<div class="dashboard-outcome-row ${kind}"><span>${label}</span><div><i style="width:${Math.max(value ? 6 : 0, value / max * 100)}%"></i></div><b>${value}</b></div>`).join('');
  mailaiBindUI(document.getElementById('dashboard-efficiency'), "textContent", () => (data.saved_hours ? (mailaiT('dash.savedHours') || '约节省 {n} 小时').replace('{n}', Number(data.saved_hours).toFixed(1)) : (mailaiT('dash.savedWaiting') || '等待形成处置数据')));
}

function renderDashboardQuality(evaluation) {
  const host = document.getElementById('dashboard-quality');
  if (!evaluation) {
    host.innerHTML = `<span class="dashboard-quality-empty">${mailaiT('dash.noEvaluation') || '尚无独立评测报告；日常风险识别与处置数据仍正常统计。'}</span>`;
    return;
  }
  const metrics = [
    [mailaiT('dash.metricAccuracy') || '准确率', `${((evaluation.accuracy || 0) * 100).toFixed(1)}%`],
    [mailaiT('dash.metricRecall') || '钓鱼召回率', `${((evaluation.recall || 0) * 100).toFixed(1)}%`],
    ['F1', `${((evaluation.f1 || 0) * 100).toFixed(1)}%`],
    [mailaiT('dash.metricAvgTime') || '平均处理', `${Number(evaluation.avg_process_time_ms || 0).toFixed(1)} ms`],
  ];
  host.innerHTML = metrics.map(([label, value]) => `<span><small>${label}</small><b>${value}</b></span>`).join('') + `<em>${(mailaiT('dash.metricSamples') || '样本 {n} 条').replace('{n}', evaluation.total || 0)}</em>`;
}

function renderTrendChart(trend) {
  const container = document.getElementById('trend-chart');
  const dates = Object.keys(trend).sort();
  if (dates.length === 0) {
    container.innerHTML = `<div class="chart-empty">${mailaiT('dash.noData') || '暂无数据'}</div>`;
    return;
  }
  const series = [
    { key: 'phishing', label: mailaiT('risk.phishing') || '钓鱼', color: '#ef4444' },
    { key: 'suspicious', label: mailaiT('risk.suspicious') || '可疑', color: '#f59e0b' },
    { key: 'spam', label: mailaiT('risk.spam') || '垃圾', color: '#94a3b8' },
    { key: 'clean', label: mailaiT('risk.clean') || '正常', color: 'var(--reward-accent,#10b981)' },
  ];
  const W = Math.max(460, dates.length * 64), H = 200, padL = 30, padB = 28, padT = 14, padR = 14;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(2, ...dates.flatMap(d => series.map(s => trend[d][s.key] || 0)));
  const x = i => padL + (dates.length === 1 ? plotW / 2 : (i / (dates.length - 1)) * plotW);
  const y = v => padT + plotH - (v / maxVal) * plotH;

  let html = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="grad-phishing" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ef4444" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="#ef4444" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="grad-clean" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--reward-accent,#10b981)" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="var(--reward-accent,#10b981)" stop-opacity="0"/>
      </linearGradient>
    </defs>`;

  for (let g = 0; g <= 3; g++) {
    const gy = padT + (plotH / 3) * g;
    const gv = Math.round(maxVal * (1 - g / 3));
    html += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#eef0f4" stroke-width="1"/>
             <text x="${padL - 6}" y="${gy + 3}" font-size="9" text-anchor="end" fill="#9aa1ad">${gv}</text>`;
  }

  series.forEach(s => {
    const pts = dates.map((d, i) => [x(i), y(trend[d][s.key] || 0)]);
    let path = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const cx = (x0 + x1) / 2;
      path += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`;
    }
    if (s.key === 'phishing' || s.key === 'clean') {
      html += `<path d="${path} L ${pts[pts.length - 1][0]} ${padT + plotH} L ${pts[0][0]} ${padT + plotH} Z"
                fill="url(#grad-${s.key})" class="trend-area"/>`;
    }
    html += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.2"
              stroke-linecap="round" class="trend-line"/>`;
    pts.forEach(([px, py], i) => {
      const val = trend[dates[i]][s.key] || 0;
      html += `<circle cx="${px}" cy="${py}" r="${val > 0 ? 3.4 : 0}" fill="#fff"
                stroke="${s.color}" stroke-width="2" class="trend-dot"><title>${dates[i]} ${s.label}: ${val}</title></circle>`;
    });
  });

  dates.forEach((d, i) => {
    html += `<text x="${x(i)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#9aa1ad">${d.slice(5)}</text>`;
  });
  html += '</svg>';

  html += '<div class="chart-legend">' +
    series.map(s => `<span class="legend-item"><i style="background:${s.color}"></i>${s.label}</span>`).join('') +
    '</div>';
  container.innerHTML = html;
}

function renderSenderChart(senders) {
  const container = document.getElementById('sender-chart');
  if (!senders.length) {
    container.innerHTML = `<div class="chart-empty">${mailaiT('dash.noData') || '暂无数据'}</div>`;
    return;
  }
  const maxCount = Math.max(1, ...senders.map(s => s.risk_count || 0));
  const level = s => s >= 50 ? 'danger' : s >= 30 ? 'warn' : 'info';
  container.innerHTML = `<div class="sender-rank">${senders.map((s, i) => {
    const pct = Math.round(((s.risk_count || 0) / maxCount) * 100);
    const lv = level(s.max_score || 0);
    return `
    <button type="button" class="sender-row" data-dashboard-email="${s.email_id || ''}" style="animation-delay:${i * 0.08}s">
      <span class="sender-rank-no ${lv}">${i + 1}</span>
      <span class="sender-addr" title="${esc(s.sender)}"><b>${esc(s.sender)}</b><small>${(mailaiT('dash.senderLine') || '{n} 封钓鱼 · 最高 {score} 分').replace('{n}', s.phishing_count || 0).replace('{score}', s.max_score || 0)}</small></span>
      <div class="sender-bar-track">
        <div class="sender-bar ${lv}" style="width:${pct}%"></div>
      </div>
      <span class="sender-score ${lv}">${s.risk_count}</span>
    </button>`;
  }).join('')}</div>`;
}

globalThis.MailAIModules?.register('dashboardCharts', {
  animateValue,
  campaignSignalLabel,
  renderDashboardCampaigns,
  renderDashboardOutcome,
  renderDashboardQuality,
  renderTrendChart,
  renderSenderChart,
});
