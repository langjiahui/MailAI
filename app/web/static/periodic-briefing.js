(() => {
  const modal = document.getElementById('digest-modal');
  const pane = document.getElementById('periodic-briefing-pane');
  const digestBody = document.getElementById('digest-body');
  if (!modal || !pane || !digestBody) return;

  const modalContent = modal.querySelector('.modal-content');
  const dailySelect = document.getElementById('digest-history-select');
  const dailyRefreshBtn = document.getElementById('btn-regenerate-digest');
  const tabButtons = [...modal.querySelectorAll('[data-briefing-tab]')];

  const periodSelect = document.getElementById('periodic-period-select');
  const customRangeBox = document.getElementById('periodic-custom-range');
  const startInput = document.getElementById('periodic-start-date');
  const endInput = document.getElementById('periodic-end-date');
  const styleSelect = document.getElementById('periodic-style-select');
  const focusInput = document.getElementById('periodic-focus-input');
  const prefCheckbox = document.getElementById('periodic-use-preferences');
  const historySelect = document.getElementById('periodic-history-select');
  const deleteHistoryBtn = document.getElementById('periodic-delete-history');
  const metricsStrip = document.getElementById('periodic-metrics-strip');
  const statusEl = document.getElementById('periodic-briefing-status');
  const titleInput = document.getElementById('periodic-title-input');
  const previewEl = document.getElementById('periodic-briefing-preview');
  const editorEl = document.getElementById('periodic-briefing-editor');
  const aiGenBtn = document.getElementById('periodic-btn-ai');
  const localGenBtn = document.getElementById('periodic-btn-local');
  const modeViewBtn = document.getElementById('periodic-btn-view');
  const modeEditBtn = document.getElementById('periodic-btn-edit');
  const saveBtn = document.getElementById('periodic-btn-save');
  const copyBtn = document.getElementById('periodic-btn-copy');
  const composeBtn = document.getElementById('periodic-btn-compose');

  let activeTab = 'daily';
  let editMode = false;
  let viewRevision = 0;
  let currentSummary = null;
  let currentHistory = [];
  let currentBriefingId = null;
  let currentSource = 'local';
  let currentMarkdown = '';
  let activeStreamController = null;
  let dirty = false;

  function accountId() {
    return typeof activeMailAccount === 'function' ? (activeMailAccount()?.id || '') : '';
  }

  function accountHeaders(acc = accountId()) {
    return acc ? { 'X-MailAI-Account': acc } : {};
  }

  function cleanExportMarkdown(markdown) {
    const overduePlain = mailaiText('[过期]');
    return String(markdown || '')
      .replace(/\s*\[email_id:\d+\]/g, '')
      .replace(/\[\s*⚠️?\s*过期\s*\]/g, overduePlain)
      .trim();
  }

  function renderBriefingInline(text, { interactive = true } = {}) {
    let html = esc(String(text || ''));
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/https?:\/\/[^\s<>"'，。；）)]+/g, url =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
    );
    if (interactive) {
      const sourceTitle = esc(mailaiText('查看来源邮件'));
      const sourceText = esc(mailaiText('查看来源'));
      const overdueIcon = '<span class="digest-status-icon warn"><svg viewBox="0 0 20 20"><path d="M10 3 17 16H3L10 3ZM10 8v3M10 14h.01"/></svg></span>';
      html = html
        .replace(
          /\[email_id:(\d+)\]/g,
          `<a class="digest-email-link" data-email-id="$1" href="#" title="${sourceTitle}"><svg viewBox="0 0 20 20"><path d="M3.5 5.5h13v9h-13zM4 6l6 5 6-5"/></svg><span>${sourceText}</span></a>`
        )
        .replace(/\[\s*⚠️?\s*过期\s*\]/g, `${overdueIcon}${esc(mailaiText('过期'))}`)
        .replace(/⚠️?/g, overdueIcon);
    }
    return html;
  }

  function splitTableRow(line) {
    let s = String(line || '').trim();
    if (!s.includes('|')) return null;
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let current = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') {
        current += '|';
        i++;
      } else if (s[i] === '|') {
        cells.push(current.trim());
        current = '';
      } else {
        current += s[i];
      }
    }
    cells.push(current.trim());
    return cells.length >= 2 ? cells : null;
  }

  function parseTableAlignments(line, expectedLen) {
    const cells = splitTableRow(line);
    if (!cells || cells.length !== expectedLen) return null;
    const aligns = [];
    for (const cell of cells) {
      if (!/^:?-{2,}:?$/.test(cell)) return null;
      if (cell.startsWith(':') && cell.endsWith(':')) aligns.push('center');
      else if (cell.endsWith(':')) aligns.push('right');
      else aligns.push('left');
    }
    return aligns;
  }

  function renderBriefingMarkdown(markdown, { interactive = true } = {}) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let listTag = '';
    let para = [];

    const flushPara = () => {
      if (!para.length) return;
      out.push(`<p>${para.map(line => renderBriefingInline(line, { interactive })).join('<br/>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (!listTag) return;
      out.push(`</${listTag}>`);
      listTag = '';
    };

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimEnd().trim();
      if (!trimmed) {
        flushPara();
        flushList();
        continue;
      }

      if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
        flushPara();
        flushList();
        out.push('<hr/>');
        continue;
      }

      const headerCells = splitTableRow(trimmed);
      const alignments = headerCells && i + 1 < lines.length ? parseTableAlignments(lines[i + 1], headerCells.length) : null;
      if (headerCells && alignments) {
        flushPara();
        flushList();
        const ths = headerCells
          .map((cell, idx) => `<th style="text-align:${alignments[idx]}">${renderBriefingInline(cell, { interactive })}</th>`)
          .join('');
        const bodyRows = [];
        let j = i + 2;
        while (j < lines.length) {
          const rowTrimmed = lines[j].trim();
          if (!rowTrimmed || !rowTrimmed.includes('|')) break;
          const rowCells = splitTableRow(rowTrimmed);
          if (!rowCells) break;
          const tds = headerCells
            .map((_, idx) => `<td style="text-align:${alignments[idx]}">${renderBriefingInline(rowCells[idx] ?? '', { interactive })}</td>`)
            .join('');
          bodyRows.push(`<tr>${tds}</tr>`);
          j++;
        }
        const tableHtml = `<table><thead><tr>${ths}</tr></thead>${bodyRows.length ? `<tbody>${bodyRows.join('')}</tbody>` : ''}</table>`;
        out.push(interactive ? `<div class="periodic-table-wrap">${tableHtml}</div>` : tableHtml);
        i = j - 1;
        continue;
      }

      if (trimmed.startsWith('>')) {
        flushPara();
        flushList();
        const quoteLines = [];
        let j = i;
        while (j < lines.length && lines[j].trim().startsWith('>')) {
          quoteLines.push(lines[j].trim().replace(/^>\s?/, ''));
          j++;
        }
        out.push(`<blockquote>${quoteLines.map(line => renderBriefingInline(line, { interactive })).join('<br/>')}</blockquote>`);
        i = j - 1;
        continue;
      }

      const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flushPara();
        flushList();
        const level = heading[1].length;
        out.push(`<h${level}>${renderBriefingInline(heading[2], { interactive })}</h${level}>`);
        continue;
      }
      const ulItem = trimmed.match(/^[-*•]\s+(.*)$/);
      if (ulItem) {
        flushPara();
        if (listTag !== 'ul') {
          flushList();
          listTag = 'ul';
          out.push('<ul>');
        }
        out.push(`<li>${renderBriefingInline(ulItem[1], { interactive })}</li>`);
        continue;
      }
      const olItem = trimmed.match(/^\d+[.、]\s+(.*)$/);
      if (olItem) {
        flushPara();
        if (listTag !== 'ol') {
          flushList();
          listTag = 'ol';
          out.push('<ol>');
        }
        out.push(`<li>${renderBriefingInline(olItem[1], { interactive })}</li>`);
        continue;
      }
      flushList();
      para.push(trimmed);
    }
    flushPara();
    flushList();
    return out.join('');
  }

  function formatCleanEmailHtml(markdown) {
    const cleaned = cleanExportMarkdown(markdown);
    if (!cleaned) return '';
    return renderBriefingMarkdown(cleaned, { interactive: false });
  }

  function updateCustomRangeVisibility() {
    const custom = periodSelect.value === 'custom';
    customRangeBox.classList.toggle('hidden', !custom);
    if (custom && (!startInput.value || !endInput.value)) {
      const now = new Date();
      const endStr = now.toISOString().slice(0, 10);
      const startDt = new Date(now.getTime() - 6 * 86400000);
      if (!endInput.value) endInput.value = endStr;
      if (!startInput.value) startInput.value = startDt.toISOString().slice(0, 10);
    }
  }

  function setStatus(text = '', badge = '') {
    if (!text && !badge) {
      statusEl.classList.add('hidden');
      statusEl.replaceChildren();
      return;
    }
    statusEl.classList.remove('hidden');
    statusEl.innerHTML = `<span>${esc(text)}</span>${badge ? `<strong>${esc(badge)}</strong>` : ''}`;
  }

  function sourceTag(src) {
    return src === 'ai' ? 'AI' : mailaiText('本地');
  }

  function sourceBadge(src) {
    return src === 'ai' ? mailaiText('AI 智能提炼') : mailaiText('本地聚合整理');
  }

  function renderMetrics(summary) {
    if (!summary?.metrics) {
      metricsStrip.innerHTML = '';
      return;
    }
    const m = summary.metrics;
    const receivedCount = m.received_count || 0;
    const importantCount = m.important_count || 0;
    const sentCount = m.sent_count || 0;
    const waitingCount = m.followups_waiting_count || 0;
    const repliedCount = m.followups_replied_count || 0;
    const doneCount = m.todos_done_count || 0;
    const openCount = m.todos_open_count || 0;
    const overdueCount = m.todos_overdue_count || 0;
    const projectSlice = summary.highlights?.projects?.length
      ? mailaiTemplate`项目：${summary.highlights.projects.slice(0, 2).join(' / ')}`
      : `${summary.window?.start_date || ''} ~ ${summary.window?.end_date || ''}`;

    const cards = [
      {
        label: mailaiText('收件梳理'),
        value: mailaiTemplate`${receivedCount} 封`,
        note: mailaiTemplate`重点 ${importantCount} 封`,
        warn: false,
      },
      {
        label: mailaiText('发出与跟进'),
        value: mailaiTemplate`${sentCount} 封`,
        note: mailaiTemplate`待复 ${waitingCount} · 已复 ${repliedCount}`,
        warn: (m.followups_due_count || 0) > 0,
      },
      {
        label: mailaiText('本期已完成待办'),
        value: mailaiTemplate`${doneCount} 项`,
        note: projectSlice,
        warn: false,
      },
      {
        label: mailaiText('下阶段待推进'),
        value: mailaiTemplate`${openCount} 项`,
        note: overdueCount ? mailaiTemplate`含逾期 ${overdueCount} 项` : mailaiText('暂无逾期'),
        warn: overdueCount > 0,
      },
    ];
    metricsStrip.innerHTML = cards
      .map(
        c =>
          `<div class="periodic-metric-card${c.warn ? ' has-warn' : ''}"><span>${esc(c.label)}</span><strong>${esc(c.value)}</strong><small>${esc(c.note)}</small></div>`
      )
      .join('');
  }

  function renderContent() {
    const hasText = Boolean(currentMarkdown.trim());
    saveBtn.disabled = !hasText;
    copyBtn.disabled = !hasText;
    composeBtn.disabled = !hasText;
    modeViewBtn.classList.toggle('is-active', !editMode);
    modeEditBtn.classList.toggle('is-active', editMode);

    if (editMode) {
      previewEl.classList.add('hidden');
      editorEl.classList.remove('hidden');
      if (editorEl.value !== currentMarkdown) editorEl.value = currentMarkdown;
      return;
    }

    editorEl.classList.add('hidden');
    previewEl.classList.remove('hidden');
    if (!hasText) {
      const m = currentSummary?.metrics;
      const hint = m
        ? mailaiTemplate`当前周期统计：收件 ${m.received_count} 封、发件 ${m.sent_count} 封、完成待办 ${m.todos_done_count} 项、待推进 ${m.todos_open_count} 项。点击上方按钮即可聚合生成可编辑草稿。`
        : mailaiText('聚合当前邮箱的往来邮件、待办进度与发信跟进，快速生成周报或月报草稿。');
      previewEl.innerHTML = `<div class="periodic-empty"><p>${esc(hint)}</p></div>`;
      return;
    }
    previewEl.innerHTML = renderBriefingMarkdown(currentMarkdown, { interactive: true });
  }

  function renderHistorySelect() {
    const selected = currentBriefingId ? String(currentBriefingId) : '';
    const options = [`<option value="">${esc(mailaiText('新建当前周期简报'))}</option>`];
    for (const item of currentHistory) {
      const label = `${item.title || `${item.start_date} ~ ${item.end_date}`} · ${sourceTag(item.source)}`;
      options.push(`<option value="${item.id}">${esc(label)}</option>`);
    }
    historySelect.innerHTML = options.join('');
    historySelect.value = selected;
    deleteHistoryBtn.disabled = !currentBriefingId;
  }

  function setEditMode(flag) {
    if (editMode && !flag) {
      currentMarkdown = editorEl.value;
    }
    editMode = Boolean(flag);
    renderContent();
    if (editMode) editorEl.focus();
  }

  function syncHeaderForTab() {
    tabButtons.forEach(btn => {
      const active = btn.dataset.briefingTab === activeTab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const isPeriodic = activeTab === 'periodic';
    modalContent?.classList.toggle('is-periodic-mode', isPeriodic);
    dailySelect?.classList.toggle('hidden', isPeriodic);
    dailyRefreshBtn?.classList.toggle('hidden', isPeriodic);
    digestBody.classList.toggle('hidden', isPeriodic);
    pane.classList.toggle('hidden', !isPeriodic);
    if (typeof setDigestTitle === 'function') {
      if (isPeriodic) {
        setDigestTitle(mailaiText('周期工作简报'));
      } else if (typeof digestTodayLabel === 'function') {
        setDigestTitle(digestTodayLabel());
      }
    }
  }

  async function refreshPreviewAndHistory({ keepDraft = false } = {}) {
    const rev = ++viewRevision;
    const acc = accountId();
    updateCustomRangeVisibility();
    const params = new URLSearchParams({
      period: periodSelect.value,
      start_date: startInput.value || '',
      end_date: endInput.value || '',
      focus: focusInput.value || '',
      include_preferences: prefCheckbox.checked ? 'true' : 'false',
    });
    try {
      const [summary, history] = await Promise.all([
        api(`/api/work/briefings/preview?${params.toString()}`, { accountId: acc }),
        api('/api/work/briefings?limit=30', { accountId: acc }).catch(() => []),
      ]);
      if (rev !== viewRevision || activeTab !== 'periodic') return;
      currentSummary = summary;
      currentHistory = Array.isArray(history) ? history : [];
      if (!keepDraft && !currentBriefingId && !dirty) {
        titleInput.value = summary.default_subject || '';
      }
      renderMetrics(summary);
      renderHistorySelect();
      renderContent();
      if (!currentMarkdown.trim()) {
        setStatus(
          summary.llm_available
            ? mailaiText('已汇总本地工作数据，可点击「AI 智能生成」或「本地快速整理」')
            : mailaiText('当前未配置模型，点击「本地快速整理」可离线零等待生成'),
          `${summary.window.start_date} ~ ${summary.window.end_date}`
        );
      }
    } catch (err) {
      if (rev !== viewRevision || activeTab !== 'periodic') return;
      setStatus(mailaiSystemMessage(err.message));
    }
  }

  function setBusy(busy) {
    aiGenBtn.disabled = busy;
    localGenBtn.disabled = busy;
    periodSelect.disabled = busy;
    styleSelect.disabled = busy;
  }

  async function generatePeriodic(mode = 'auto') {
    if (activeStreamController) activeStreamController.abort();
    const controller = new AbortController();
    activeStreamController = controller;
    const acc = accountId();
    const rev = ++viewRevision;
    const finishWork = globalThis.mailaiCompanionWork?.begin?.(controller.signal);

    updateCustomRangeVisibility();
    setBusy(true);
    editMode = false;
    currentBriefingId = null;
    dirty = false;
    currentMarkdown = '';
    setStatus(
      mode === 'local'
        ? mailaiText('正在整理本地工作数据…')
        : mailaiText('正在聚合数据并生成工作简报…')
    );
    renderContent();

    const payload = {
      period: periodSelect.value,
      start_date: startInput.value || '',
      end_date: endInput.value || '',
      style: styleSelect.value || 'leader',
      focus: focusInput.value || '',
      include_preferences: prefCheckbox.checked,
      mode,
      save: true,
    };

    try {
      const res = await fetch('/api/work/briefings/stream', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...accountHeaders(acc),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || mailaiTemplate`生成失败（${res.status}）`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completedEvent = null;

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (rev !== viewRevision) return;
          if (evt.type === 'meta' && evt.summary) {
            currentSummary = evt.summary;
            titleInput.value = evt.summary.default_subject || titleInput.value;
            renderMetrics(evt.summary);
          } else if (evt.type === 'delta' && typeof evt.content === 'string') {
            currentMarkdown += evt.content;
            renderContent();
          } else if (evt.type === 'done') {
            completedEvent = evt;
          } else if (evt.type === 'error') {
            throw new Error(evt.message || mailaiText('生成失败'));
          }
        }
        if (done) break;
      }

      if (buffer.trim() && rev === viewRevision) {
        const evt = JSON.parse(buffer);
        if (evt.type === 'done') completedEvent = evt;
        else if (evt.type === 'error') throw new Error(evt.message || mailaiText('生成失败'));
      }

      if (rev !== viewRevision) return;
      if (completedEvent) {
        currentMarkdown = completedEvent.content || currentMarkdown;
        currentSource = completedEvent.source || 'local';
        if (completedEvent.summary) {
          currentSummary = completedEvent.summary;
          renderMetrics(currentSummary);
        }
        if (completedEvent.briefing?.id) {
          currentBriefingId = completedEvent.briefing.id;
          titleInput.value = completedEvent.briefing.title || titleInput.value;
          const exists = currentHistory.filter(item => item.id !== completedEvent.briefing.id);
          currentHistory = [completedEvent.briefing, ...exists];
          renderHistorySelect();
        }
      }
      renderContent();
      setStatus(
        mailaiText('简报已生成并自动保存，可切换「编辑草稿」微调后复制或转写信'),
        sourceBadge(currentSource)
      );
      toast(mailaiText('周期工作简报已生成'), 'success');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setStatus(mailaiSystemMessage(err.message));
      toast(mailaiSystemMessage(err.message), 'error');
    } finally {
      if (activeStreamController === controller) activeStreamController = null;
      finishWork?.();
      setBusy(false);
    }
  }

  async function saveCurrentBriefing() {
    const content = (editMode ? editorEl.value : currentMarkdown).trim();
    if (!content) return;
    currentMarkdown = content;
    const acc = accountId();
    try {
      const saved = await api('/api/work/briefings', {
        method: 'POST',
        accountId: acc,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          briefing_id: currentBriefingId || null,
          period: periodSelect.value,
          start_date: currentSummary?.window?.start_date || startInput.value || '',
          end_date: currentSummary?.window?.end_date || endInput.value || '',
          style: styleSelect.value || 'leader',
          title: titleInput.value.trim() || currentSummary?.default_subject || mailaiText('周期工作简报'),
          content,
          metrics: currentSummary?.metrics || {},
          source: currentSource || 'local',
        }),
      });
      currentBriefingId = saved.id;
      dirty = false;
      currentHistory = [saved, ...currentHistory.filter(row => row.id !== saved.id)];
      renderHistorySelect();
      renderContent();
      toast(mailaiText('简报修改已保存'), 'success');
    } catch (err) {
      toast(mailaiText('保存失败：') + mailaiSystemMessage(err.message), 'error');
    }
  }

  async function loadHistoryItem(id) {
    if (!id) {
      currentBriefingId = null;
      currentMarkdown = '';
      dirty = false;
      deleteHistoryBtn.disabled = true;
      await refreshPreviewAndHistory();
      return;
    }
    const rev = ++viewRevision;
    const acc = accountId();
    try {
      const item = await api(`/api/work/briefings/${id}`, { accountId: acc });
      if (rev !== viewRevision) return;
      currentBriefingId = item.id;
      currentMarkdown = item.content || '';
      currentSource = item.source || 'local';
      dirty = false;
      if (item.period && [...periodSelect.options].some(opt => opt.value === item.period)) {
        periodSelect.value = item.period;
      }
      if (item.period === 'custom') {
        startInput.value = item.start_date || '';
        endInput.value = item.end_date || '';
      }
      if (item.style && [...styleSelect.options].some(opt => opt.value === item.style)) {
        styleSelect.value = item.style;
      }
      updateCustomRangeVisibility();
      titleInput.value = item.title || '';
      if (item.metrics) renderMetrics({ metrics: item.metrics, window: item, highlights: {} });
      renderHistorySelect();
      setEditMode(false);
      setStatus(mailaiTemplate`历史简报 · ${item.start_date} ~ ${item.end_date}`, sourceBadge(item.source));
    } catch (err) {
      toast(mailaiText('读取简报失败：') + mailaiSystemMessage(err.message), 'error');
    }
  }

  async function removeHistoryItem() {
    if (!currentBriefingId) return;
    const targetId = currentBriefingId;
    try {
      await api(`/api/work/briefings/${targetId}`, { method: 'DELETE', accountId: accountId() });
      currentHistory = currentHistory.filter(row => row.id !== targetId);
      currentBriefingId = null;
      currentMarkdown = '';
      dirty = false;
      renderHistorySelect();
      renderContent();
      await refreshPreviewAndHistory();
      toast(mailaiText('已删除该条简报记录'), 'success');
    } catch (err) {
      toast(mailaiText('删除失败：') + mailaiSystemMessage(err.message), 'error');
    }
  }

  async function copyBriefing() {
    const raw = editMode ? editorEl.value : currentMarkdown;
    const text = cleanExportMarkdown(raw);
    if (!text) return;
    const subject = titleInput.value.trim();
    const full = subject ? `${subject}\n\n${text}` : text;
    try {
      await navigator.clipboard.writeText(full);
      toast(mailaiText('已复制纯净正文（可直接粘贴至企微 / 钉钉 / OA）'), 'success');
    } catch (_) {
      const box = document.createElement('textarea');
      box.value = full;
      document.body.appendChild(box);
      box.select();
      document.execCommand('copy');
      box.remove();
      toast(mailaiText('已复制到剪贴板'), 'success');
    }
  }

  async function turnIntoComposeDraft() {
    const raw = editMode ? editorEl.value : currentMarkdown;
    if (!raw.trim() || typeof openCompose !== 'function') return;
    const subject = titleInput.value.trim() || currentSummary?.default_subject || mailaiText('【工作周报】');
    const message_html = formatCleanEmailHtml(raw);
    const acc = accountId();
    activeStreamController?.abort();
    modal.classList.add('hidden');
    await openCompose({
      account_id: acc,
      mode: 'compose',
      subject,
      message_html,
    });
    toast(mailaiText('已将周期简报填入发信正文；填入收件人后可自动匹配角色与签名'), 'success');
  }

  function switchTab(tab, options = {}) {
    activeTab = tab === 'periodic' ? 'periodic' : 'daily';
    syncHeaderForTab();
    if (activeTab === 'periodic') {
      if (options.period && [...periodSelect.options].some(opt => opt.value === options.period)) {
        periodSelect.value = options.period;
      }
      refreshPreviewAndHistory({ keepDraft: Boolean(currentMarkdown.trim()) });
    } else {
      activeStreamController?.abort();
    }
  }

  window.openPeriodicBriefing = async function openPeriodicBriefing(options = {}) {
    if (typeof closeTodoCenter === 'function') closeTodoCenter();
    if (typeof closeContactCenter === 'function') closeContactCenter();
    if (typeof closeAttachmentCenter === 'function') closeAttachmentCenter();
    if (typeof closeCalendarTimeline === 'function') closeCalendarTimeline();
    if (typeof closeTriageCenter === 'function') closeTriageCenter();
    if (typeof closeAssistant === 'function') closeAssistant();
    const digestAccountLabelEl = document.getElementById('digest-account-label');
    if (digestAccountLabelEl && typeof digestAccountLabel === 'function') {
      digestAccountLabelEl.textContent = digestAccountLabel();
    }
    modal.classList.remove('hidden');
    switchTab('periodic', options);
  };

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.briefingTab;
      if (tab === 'daily') {
        switchTab('daily');
        if (typeof openDigestModal === 'function') openDigestModal();
      } else {
        switchTab('periodic');
      }
    });
  });

  modal.querySelectorAll('.modal-close, .modal-backdrop').forEach(el => {
    el.addEventListener('click', () => activeStreamController?.abort());
  });

  document.getElementById('btn-digest')?.addEventListener('click', () => {
    activeTab = 'daily';
    syncHeaderForTab();
  }, true);

  document.getElementById('btn-todo-open-briefing')?.addEventListener('click', () => {
    document.getElementById('todo-options')?.removeAttribute('open');
    if (typeof closeTodoCenter === 'function') closeTodoCenter();
    window.openPeriodicBriefing();
  });

  periodSelect.addEventListener('change', () => {
    currentBriefingId = null;
    dirty = false;
    refreshPreviewAndHistory({ keepDraft: false });
  });
  startInput.addEventListener('change', () => refreshPreviewAndHistory({ keepDraft: Boolean(currentMarkdown.trim()) }));
  endInput.addEventListener('change', () => refreshPreviewAndHistory({ keepDraft: Boolean(currentMarkdown.trim()) }));
  historySelect.addEventListener('change', () => loadHistoryItem(historySelect.value));
  deleteHistoryBtn.addEventListener('click', removeHistoryItem);
  aiGenBtn.addEventListener('click', () => generatePeriodic('auto'));
  localGenBtn.addEventListener('click', () => generatePeriodic('local'));
  modeViewBtn.addEventListener('click', () => setEditMode(false));
  modeEditBtn.addEventListener('click', () => setEditMode(true));
  editorEl.addEventListener('input', () => {
    currentMarkdown = editorEl.value;
    dirty = true;
  });
  saveBtn.addEventListener('click', saveCurrentBriefing);
  copyBtn.addEventListener('click', copyBriefing);
  composeBtn.addEventListener('click', turnIntoComposeDraft);

  previewEl.addEventListener('click', event => {
    const link = event.target.closest('.digest-email-link');
    if (!link) return;
    event.preventDefault();
    const id = parseInt(link.dataset.emailId, 10);
    if (id && typeof openDigestEmailDrawer === 'function') openDigestEmailDrawer(id);
  });

  syncHeaderForTab();
  document.addEventListener('mailai:language-changed', () => {
    syncHeaderForTab();
    if (!modal.classList.contains('hidden') && activeTab === 'periodic') {
      if (currentSummary) renderMetrics(currentSummary);
      renderHistorySelect();
      renderContent();
    }
  });
  globalThis.MailAIModules?.register('periodicBriefing', {
    open: window.openPeriodicBriefing,
  });
})();
