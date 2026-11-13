/* Non-blocking inline compose audit highlights + pulse spotlight + floating hover tooltip */
(() => {
  const button = document.getElementById('btn-compose-guard');
  const bodyEl = document.getElementById('compose-body');
  const msgEl = document.getElementById('compose-message');
  const layerEl = document.getElementById('compose-guard-layer');
  const subjectEl = document.getElementById('compose-subject');
  const toEl = document.getElementById('compose-to');
  const ccEl = document.getElementById('compose-cc');
  const attachmentsEl = document.getElementById('compose-attachments');
  if (!button || !bodyEl || !msgEl || !layerEl) return;

  const tooltip = document.createElement('div');
  tooltip.id = 'compose-guard-tooltip';
  tooltip.className = 'compose-guard-tooltip hidden';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tooltip);

  let activeBodyMarks = []; // [{ range, issue, tone, spans: [] }]
  let activeFieldIssues = new Map(); // element -> [issue]
  let allActiveIssues = [];
  let hoveredKey = '';
  let syncRaf = 0;
  let hideGraceTimer = 0;

  function clearHideTimer() {
    if (hideGraceTimer) {
      clearTimeout(hideGraceTimer);
      hideGraceTimer = 0;
    }
  }

  function setActiveIssues(issuesList) {
    const activeSet = new Set(issuesList || []);
    layerEl.classList.toggle('has-active', activeSet.size > 0);

    for (const mark of activeBodyMarks) {
      const hit = activeSet.has(mark.issue);
      for (const span of mark.spans || []) {
        span.classList.toggle('is-active', hit);
      }
    }

    for (const [el, list] of activeFieldIssues.entries()) {
      const hit = list.some(item => activeSet.has(item));
      el.classList.toggle('compose-guard-field-active', hit);
    }
  }

  function hideTooltip() {
    clearHideTimer();
    hoveredKey = '';
    setActiveIssues([]);
    tooltip.innerHTML = '';
    tooltip.className = 'compose-guard-tooltip hidden';
    tooltip.setAttribute('aria-hidden', 'true');
  }

  function scheduleHideInteractive() {
    clearHideTimer();
    hideGraceTimer = setTimeout(() => {
      if (hoveredKey === 'button:all') hideTooltip();
    }, 140);
  }

  function scrollIssueIntoView(issue) {
    const mark = activeBodyMarks.find(m => m.issue === issue);
    if (mark) {
      try {
        const rects = mark.range.getClientRects();
        const r = rects[0];
        if (r) {
          const bodyRect = bodyEl.getBoundingClientRect();
          if (r.top < bodyRect.top || r.bottom > bodyRect.bottom) {
            bodyEl.scrollTop += (r.top - bodyRect.top) - bodyRect.height * 0.3;
          }
        }
      } catch (_) {}
      return;
    }
    for (const [el, list] of activeFieldIssues.entries()) {
      if (list.includes(issue)) {
        el.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
  }

  function focusIssueTarget(issue) {
    const mark = activeBodyMarks.find(m => m.issue === issue);
    if (mark) {
      scrollIssueIntoView(issue);
      msgEl.focus({ preventScroll: true });
      try {
        const sel = window.getSelection();
        if (sel) {
          const caret = document.createRange();
          caret.setStart(mark.range.startContainer, mark.range.startOffset);
          caret.setEnd(mark.range.endContainer, mark.range.endOffset);
          sel.removeAllRanges();
          sel.addRange(caret);
        }
      } catch (_) {}
      return;
    }
    for (const [el, list] of activeFieldIssues.entries()) {
      if (list.includes(issue) && typeof el.focus === 'function') {
        el.focus();
        return;
      }
    }
  }

  function showTooltip(issues, anchorRect, key, { interactive = false } = {}) {
    clearHideTimer();
    if (!issues || !issues.length) {
      hideTooltip();
      return;
    }
    if (hoveredKey !== key || tooltip.classList.contains('hidden')) {
      hoveredKey = key;
      tooltip.classList.toggle('is-interactive', interactive);
      tooltip.innerHTML = issues.map((issue, idx) => {
        const tone = (issue.tone === 'high' || issue.level === 'danger') ? 'high' : 'warn';
        const badge = tone === 'high' ? mailaiText('高风险') : mailaiText('提醒');
        return `<div class="compose-guard-tip-row tone-${tone}" data-issue-idx="${idx}">
          <span class="compose-guard-tip-badge">${esc(badge)}</span>
          <div class="compose-guard-tip-body">
            <strong>${esc(mailaiSystemMessage(issue.message || ''))}</strong>
            ${issue.reason ? `<small>${esc(itemReason(issue))}</small>` : ''}
            <span class="compose-guard-tip-meta">${esc(issue.source || mailaiText('发信检查'))}</span>
          </div>
        </div>`;
      }).join('');
      tooltip._issues = issues;
      tooltip.classList.remove('hidden');
      tooltip.setAttribute('aria-hidden', 'false');
    }

    setActiveIssues(interactive ? issues : issues);

    const pad = 10;
    const tipRect = tooltip.getBoundingClientRect();
    let left = Math.max(pad, Math.min(anchorRect.left, window.innerWidth - tipRect.width - pad));
    let top = anchorRect.top - tipRect.height - 8;
    if (top < pad) {
      top = Math.min(window.innerHeight - tipRect.height - pad, anchorRect.bottom + 8);
    }
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function itemReason(issue) {
    return issue.reason || '';
  }

  function updateButtonBadge(issues, isAuditClean) {
    button.querySelector('.compose-guard-count')?.remove();
    button.classList.remove('has-high', 'is-clean');
    if (issues.length) {
      const hasHigh = issues.some(i => i.tone === 'high' || i.level === 'danger');
      if (hasHigh) button.classList.add('has-high');
      const badge = document.createElement('span');
      badge.className = 'compose-guard-count';
      badge.textContent = String(issues.length);
      button.appendChild(badge);
    } else if (isAuditClean) {
      button.classList.add('is-clean');
    }
  }

  function clearFieldClasses() {
    [subjectEl, toEl, ccEl, attachmentsEl].forEach(el => {
      if (!el) return;
      el.classList.remove('compose-guard-field-high', 'compose-guard-field-warn', 'compose-guard-field-active');
    });
  }

  function clearComposeGuardMarks() {
    activeBodyMarks = [];
    activeFieldIssues = new Map();
    allActiveIssues = [];
    layerEl.replaceChildren();
    layerEl.classList.remove('has-active');
    clearFieldClasses();
    updateButtonBadge([], false);
    hideTooltip();
  }

  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const segments = [];
    let fullText = '';
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || '';
      if (!text) continue;
      segments.push({ node, start: fullText.length, end: fullText.length + text.length });
      fullText += text;
    }
    return { segments, fullText };
  }

  function createRangeForOffsets(segments, startIdx, endIdx) {
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    for (const seg of segments) {
      if (!startNode && startIdx >= seg.start && startIdx <= seg.end) {
        startNode = seg.node;
        startOff = startIdx - seg.start;
      }
      if (endIdx >= seg.start && endIdx <= seg.end) {
        endNode = seg.node;
        endOff = endIdx - seg.start;
        break;
      }
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    try {
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      return range;
    } catch (_) {
      return null;
    }
  }

  function layoutBodyMarks() {
    layerEl.replaceChildren();
    if (!activeBodyMarks.length) return;
    const bodyRect = bodyEl.getBoundingClientRect();
    const scrollLeft = bodyEl.scrollLeft;
    const scrollTop = bodyEl.scrollTop;
    const frag = document.createDocumentFragment();
    for (let idx = 0; idx < activeBodyMarks.length; idx++) {
      const mark = activeBodyMarks[idx];
      mark.spans = [];
      let rects;
      try {
        rects = mark.range.getClientRects();
      } catch (_) {
        continue;
      }
      for (const r of rects) {
        if (r.width < 1 || r.height < 1) continue;
        const span = document.createElement('span');
        span.className = `compose-guard-mark tone-${mark.tone}`;
        span.dataset.guardMark = String(idx);
        span.style.left = `${r.left - bodyRect.left + scrollLeft}px`;
        span.style.top = `${r.top - bodyRect.top + scrollTop}px`;
        span.style.width = `${r.width}px`;
        span.style.height = `${r.height}px`;
        mark.spans.push(span);
        frag.appendChild(span);
      }
    }
    layerEl.appendChild(frag);
  }

  function scheduleLayout() {
    if (syncRaf) return;
    syncRaf = requestAnimationFrame(() => {
      syncRaf = 0;
      layoutBodyMarks();
    });
  }

  function attachFieldIssue(el, issue) {
    if (!el) return;
    const list = activeFieldIssues.get(el) || [];
    if (!list.includes(issue)) list.push(issue);
    activeFieldIssues.set(el, list);
    const hasHigh = list.some(i => i.tone === 'high' || i.level === 'danger');
    el.classList.remove('compose-guard-field-high', 'compose-guard-field-warn');
    el.classList.add(hasHigh ? 'compose-guard-field-high' : 'compose-guard-field-warn');
  }

  function applyInlineHighlights(result) {
    clearComposeGuardMarks();
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    allActiveIssues = issues;

    if (!issues.length) {
      updateButtonBadge([], true);
      toast(mailaiText('已通过发信前多维自检：未发现漏附、日期冲突、凭据泄露、占位符或外发风险'), 'success');
      return;
    }

    const { segments, fullText } = collectTextNodes(msgEl);
    const usedBodySpans = [];

    for (const issue of issues) {
      const tone = (issue.tone === 'high' || issue.level === 'danger') ? 'high' : 'warn';
      const highlights = Array.isArray(issue.highlights) && issue.highlights.length
        ? issue.highlights
        : [{ scope: 'button', text: '' }];

      let anchoredSomewhere = false;
      for (const h of highlights) {
        if (h.scope === 'body' && h.text && fullText) {
          let from = 0;
          let matchedThis = false;
          while (from < fullText.length) {
            const idx = fullText.indexOf(h.text, from);
            if (idx < 0) break;
            const end = idx + h.text.length;
            const overlaps = usedBodySpans.some(([s, e]) => idx < e && end > s);
            if (!overlaps) {
              const range = createRangeForOffsets(segments, idx, end);
              if (range) {
                activeBodyMarks.push({ range, issue, tone, spans: [] });
                usedBodySpans.push([idx, end]);
                matchedThis = true;
                anchoredSomewhere = true;
                break;
              }
            }
            from = idx + Math.max(1, h.text.length);
          }
          if (matchedThis) continue;
        }
        if (h.scope === 'subject') {
          attachFieldIssue(subjectEl, issue);
          anchoredSomewhere = true;
        } else if (h.scope === 'recipients') {
          attachFieldIssue(toEl, issue);
          if (ccEl && ccEl.value.trim()) attachFieldIssue(ccEl, issue);
          anchoredSomewhere = true;
        } else if (h.scope === 'attachments') {
          attachFieldIssue(attachmentsEl, issue);
          anchoredSomewhere = true;
        }
      }
      if (!anchoredSomewhere) {
        attachFieldIssue(button, issue);
      }
    }

    updateButtonBadge(issues, false);
    layoutBodyMarks();
  }

  msgEl.addEventListener('mousemove', ev => {
    if (!activeBodyMarks.length) return;
    const x = ev.clientX;
    const y = ev.clientY;
    const matchedIssues = [];
    let anchor = null;
    for (let i = 0; i < activeBodyMarks.length; i++) {
      const mark = activeBodyMarks[i];
      let rects;
      try {
        rects = mark.range.getClientRects();
      } catch (_) {
        continue;
      }
      for (const r of rects) {
        if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 4) {
          if (!matchedIssues.includes(mark.issue)) matchedIssues.push(mark.issue);
          if (!anchor) anchor = r;
          break;
        }
      }
    }
    if (matchedIssues.length && anchor) {
      showTooltip(matchedIssues, anchor, 'body:' + matchedIssues.map(i => i.code).join(','));
    } else if (hoveredKey.startsWith('body:')) {
      hideTooltip();
    }
  });

  msgEl.addEventListener('mouseleave', () => {
    if (hoveredKey.startsWith('body:')) hideTooltip();
  });

  [subjectEl, toEl, ccEl, attachmentsEl].forEach((el, idx) => {
    if (!el) return;
    const showForField = () => {
      const list = activeFieldIssues.get(el);
      if (list && list.length) showTooltip(list, el.getBoundingClientRect(), `field:${idx}`);
    };
    el.addEventListener('mouseenter', showForField);
    el.addEventListener('focus', showForField);
    el.addEventListener('mouseleave', () => {
      if (hoveredKey === `field:${idx}`) hideTooltip();
    });
    el.addEventListener('blur', () => {
      if (hoveredKey === `field:${idx}`) hideTooltip();
    });
  });

  button.addEventListener('mouseenter', () => {
    clearHideTimer();
    if (allActiveIssues.length) {
      showTooltip(allActiveIssues, button.getBoundingClientRect(), 'button:all', { interactive: true });
    }
  });
  button.addEventListener('mouseleave', () => {
    if (hoveredKey === 'button:all') scheduleHideInteractive();
  });

  tooltip.addEventListener('mouseenter', () => {
    clearHideTimer();
  });
  tooltip.addEventListener('mouseleave', () => {
    if (hoveredKey === 'button:all') scheduleHideInteractive();
  });
  tooltip.addEventListener('mousemove', ev => {
    if (hoveredKey !== 'button:all') return;
    const row = ev.target.closest('.compose-guard-tip-row[data-issue-idx]');
    const issues = tooltip._issues || [];
    if (row) {
      const issue = issues[Number(row.dataset.issueIdx)];
      if (issue) {
        setActiveIssues([issue]);
        scrollIssueIntoView(issue);
      }
    } else {
      setActiveIssues(issues);
    }
  });
  tooltip.addEventListener('click', ev => {
    const row = ev.target.closest('.compose-guard-tip-row[data-issue-idx]');
    if (!row) return;
    const issue = (tooltip._issues || [])[Number(row.dataset.issueIdx)];
    if (issue) {
      focusIssueTarget(issue);
      setActiveIssues([issue]);
    }
  });

  bodyEl.addEventListener('scroll', () => {
    if (hoveredKey.startsWith('body:')) hideTooltip();
    scheduleLayout();
  });
  window.addEventListener('resize', () => {
    hideTooltip();
    scheduleLayout();
  });

  async function runComposeGuardAudit() {
    if (draftSession?.busy || draftSession?.closing || draftSession?.switching || draftSession?.canceled) return;
    const payload = draftPayload();
    const session = draftSession;
    const accountId = composeAccountId;
    const fingerprint = composePreflightFingerprint(payload);
    button.disabled = true;
    try {
      const result = await api('/api/mail/preflight', {
        accountId,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to_addr: payload.to_addr,
          cc_addr: payload.cc_addr,
          bcc_addr: payload.bcc_addr,
          subject: payload.subject,
          body_text: composeMessageText(),
          attachment_count: composeAttachments.length,
          attachment_names: composeAttachments.map(item => item.filename || item.name || ''),
          mode: composeContext.mode,
          reply_to_email_id: composeContext.reply_to_email_id,
          original_text: composeContext.original_text || '',
          allow_empty_recipients: true,
        }),
      });
      if (
        session !== draftSession ||
        session?.canceled ||
        accountId !== composeAccountId ||
        !document.body.classList.contains('compose-open') ||
        composePreflightFingerprint() !== fingerprint
      ) {
        return;
      }
      applyInlineHighlights(result);
    } catch (error) {
      toast(mailaiText('发送前检查失败：') + mailaiSystemMessage(error.message), 'error');
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener('click', () => {
    runComposeGuardAudit();
  });

  document.addEventListener('mailai:language-changed', () => {
    if (!tooltip.classList.contains('hidden')) hideTooltip();
  });

  window.clearComposeGuardBanner = clearComposeGuardMarks;
  window.clearComposeGuardMarks = clearComposeGuardMarks;
  window.runComposeGuardAudit = runComposeGuardAudit;
  globalThis.MailAIModules?.register('composeGuard', {
    runAudit: runComposeGuardAudit,
    clearMarks: clearComposeGuardMarks,
  });
})();
