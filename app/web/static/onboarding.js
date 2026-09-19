/* Local learning progress contains no account data or credentials. */
(() => {
  const key = 'mailai.onboarding.v2';
  let state = {};
  try { state = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) {}
  const save = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) {} };
  const el = id => document.getElementById(id);
  const ready = () => !!(_systemConfig?.model?.available && _systemConfig?.model?.verified);
  let mailboxRunning = false, aiRunning = false, busy = false, modelHome, priorFocus;

  const card = document.createElement('aside');
  card.className = 'start-card hidden'; card.setAttribute('aria-label', '快速上手');
  // Keep the coach mark in the app stacking context so application dialogs
  // (compose, settings, previews) always remain above it and receive clicks.
  (document.getElementById('app') || document.body).append(card);
  const modal = document.createElement('div');
  modal.id = 'start-model'; modal.className = 'start-model hidden';
  modal.innerHTML = `<section class="start-model-panel" role="dialog" aria-modal="true" aria-labelledby="start-model-title"><span class="onboarding-step">设置小邮 · 可稍后完成</span><h2 id="start-model-title">为小邮连接 AI 模型</h2><p>邮箱和模型分别配置。启用后，小邮可以总结邮件、整理待办、辅助写信。</p><details><summary>没有 API Key？</summary><p>API Key 是模型服务的访问密钥，与邮箱授权码不同。请向企业管理员获取服务地址、模型名称和 API Key，或从所选模型服务商获取。</p></details><div id="start-model-form"></div><p>使用 AI 时，相关邮件内容会发送至配置的模型服务。验证连接会发送简短请求，可能产生服务费用。</p><p id="start-model-result" role="status" aria-live="polite"></p><div class="start-actions"><button id="start-enable" class="action-btn action-primary">验证并启用</button><button id="start-model-later" class="btn-ghost">稍后设置，进入邮箱</button></div></section>`;
  document.body.append(modal);

  function clearHighlight() { document.querySelectorAll('.start-highlight').forEach(n => n.classList.remove('start-highlight')); }
  function hideCard() { clearHighlight(); card.classList.add('hidden'); }
  function show(title, text, primary, action, secondary = '稍后') {
    card.replaceChildren();
    const brand = document.createElement('small'); brand.textContent = 'MailAI · 和小邮一起上手';
    const h = document.createElement('h3'); h.textContent = title;
    const p = document.createElement('p'); p.textContent = text;
    const actions = document.createElement('div'); actions.className = 'start-actions';
    const button = document.createElement('button'); button.className = 'action-btn action-primary'; button.textContent = primary; button.onclick = () => action(button);
    const later = document.createElement('button'); later.className = 'btn-ghost'; later.textContent = secondary;
    later.onclick = () => { mailboxRunning = aiRunning = false; state.deferred = true; save(); hideCard(); };
    actions.append(button, later); card.append(brand, h, p, actions); card.classList.remove('hidden');
  }

  function inviteMailbox() {
    if (state.mailboxDone || state.deferred) return inviteAi();
    const account = activeMailAccount?.();
    const interrupted = ['failed', 'interrupted', 'canceled'].includes(account?.sync_status);
    const text = account?.sync_status === 'running'
      ? '邮箱已连接，邮件正在陆续同步，分析结果随后补充。你可以先开始阅读。'
      : interrupted
        ? `邮箱已连接，上次同步未完成。${account?.sync_error || account?.sync_message || '可点击顶部“同步”重试。'}`
        : '邮箱已连接。你可以开始阅读，也可以跟小邮了解工作台。';
    show('邮箱已连接', text, state.mailboxStep ? '继续引导' : '开始引导', () => {
      hideSystemView(); mailboxRunning = true; state.deferred = false; mailboxStep();
    });
  }
  function finishMailbox() {
    state.mailboxDone = true; state.mailboxStep = 0; mailboxRunning = false; save(); hideCard();
    if (ready()) inviteAi();
    else show('邮箱引导已完成', '现在可以正常阅读和管理邮件。配置并验证模型后，还可以体验小邮总结与待办整理。', '配置模型', openModel, '完成');
  }
  function mailboxStep() {
    clearHighlight();
    const n = state.mailboxStep || 0;
    if (n === 0) {
      el('folder-nav')?.classList.add('start-highlight');
      show('1 / 3 · 认识工作台', '左侧选择文件夹，中间浏览邮件，右侧阅读内容。后台同步的真实进度会单独显示。', '下一步', () => { state.mailboxStep = 1; save(); mailboxStep(); });
    } else if (n === 1) {
      el('email-list')?.classList.add('start-highlight');
      const hasMail = !!el('email-list')?.querySelector('.email-item');
      const account = activeMailAccount?.();
      const noMailText = account?.sync_status === 'running'
        ? '邮件正在后台同步，出现后即可打开。你也可以先完成邮箱引导。'
        : ['failed', 'interrupted', 'canceled'].includes(account?.sync_status)
          ? '同步尚未完成，请点击顶部“同步”重试。你也可以先完成邮箱引导。'
          : '邮箱当前没有可供演示的邮件。收到邮件后仍可正常阅读。';
      show('2 / 3 · 打开一封邮件', hasMail ? '点击列表中任意邮件，再继续查看阅读区。' : noMailText, hasMail ? '已打开，继续' : '完成邮箱引导', () => {
        if (!hasMail) return finishMailbox();
        if (!selectedEmailDetail) return toast('请先打开一封邮件', 'warn');
        state.mailboxStep = 2; save(); mailboxStep();
      });
    } else {
      el('reading-pane')?.classList.add('start-highlight');
      show('3 / 3 · 看懂邮件内容', ready() ? '阅读区展示正文与已生成的摘要；风险提示可展开查看依据。摘要尚未生成时，你仍可阅读正文。' : '正文可以正常阅读。AI 摘要需要配置并验证模型；规则检测与 AI 分析是两项不同能力。', '完成邮箱引导', finishMailbox);
    }
  }
  function inviteAi() {
    if (!state.mailboxDone || state.aiDone || state.deferred || !ready()) return;
    el('assistant-orb')?.classList.add('start-highlight');
    show('体验小邮', '打开一封邮件后，让小邮总结重点和待办。成功收到回答后即完成体验。', '总结当前邮件', button => {
      if (!selectedEmailDetail) return toast('请先打开一封邮件', 'warn');
      if (aiRunning || el('assistant-send')?.disabled) return toast('小邮正在处理当前请求，请稍候', 'warn');
      aiRunning = true; button.disabled = true; button.textContent = '正在总结…';
      openAssistant();
      Promise.resolve(askAssistant('请总结当前邮件的重点和待办。', [selectedEmailId])).finally(() => {
        if (state.aiDone) return;
        aiRunning = false;
        if (button.isConnected && !card.classList.contains('hidden')) {
          button.disabled = false; button.textContent = '重新总结';
        }
      });
    });
  }

  async function hasAssistantHistory() {
    try {
      const conversations = await api('/api/assistant/conversations?limit=10');
      return Array.isArray(conversations) && conversations.some(item => Number(item.message_count) >= 2);
    } catch (_) { return false; }
  }

  function closeModel() {
    if (busy) return;
    if (modelHome) { modelHome.replaceWith(el('model-config-form')); modelHome = null; }
    modal.classList.add('hidden'); priorFocus?.focus();
    if (mailboxRunning) mailboxStep(); else if (_systemConfig?.mail?.logged_in) inviteMailbox();
  }
  function openModel() {
    if (!modal.classList.contains('hidden')) return;
    hideCard(); priorFocus = document.activeElement;
    const form = el('model-config-form'); modelHome = document.createComment('model form home');
    form.before(modelHome); el('start-model-form').append(form);
    el('start-model-result').textContent = ready() ? '当前模型已经过验证。' : _systemConfig?.model?.available ? '已保存模型配置，请验证当前连接。' : '填写模型服务信息后，验证并启用。';
    modal.classList.remove('hidden'); el('model-provider').focus();
  }
  el('start-model-later').onclick = closeModel;
  el('start-enable').onclick = async () => {
    const form = el('model-config-form'); if (!form.reportValidity() || busy) return;
    busy = true; el('start-enable').disabled = true; el('start-model-later').disabled = true;
    const controls = [...form.elements]; controls.forEach(n => n.disabled = true);
    el('start-model-result').textContent = '正在验证模型连接…';
    try {
      const payload = modelFormPayload();
      const options = {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)};
      const result = await api('/api/system/model/test', options);
      if (!result.ok) throw new Error(result.message || '连接失败，请检查服务地址、模型名称和 API Key');
      await api('/api/system/model', options); await loadSystemConfig();
      el('start-model-result').textContent = '连接成功，小邮已就绪。'; toast('连接成功，小邮已就绪', 'success');
      busy = false; closeModel(); refreshAssistant();
    } catch (error) { el('start-model-result').textContent = error.message; }
    finally { busy = false; controls.forEach(n => n.disabled = false); el('start-enable').disabled = false; el('start-model-later').disabled = false; }
  };
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeModel(); }
    if (event.key !== 'Tab') return;
    const items = [...modal.querySelectorAll('button,input,select,textarea,summary')].filter(n => !n.disabled && n.getClientRects().length);
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });

  function refreshAssistant() {
    const enabled = ready(); let note = el('start-assistant');
    if (!note) {
      note = document.createElement('section'); note.id = 'start-assistant'; note.className = 'start-assistant';
      note.innerHTML = '<h3>再完成一步，启用小邮</h3><p>配置并验证模型服务，启用邮件总结、待办整理和写信辅助。不影响你继续使用邮箱。</p><button class="action-btn action-primary">配置模型</button>';
      note.querySelector('button').onclick = openModel; el('assistant-messages').before(note);
    }
    note.classList.toggle('hidden', enabled); el('assistant-form').classList.toggle('hidden', !enabled);
    el('assistant-messages').classList.toggle('hidden', !enabled);
    el('assistant-orb').title = enabled ? '打开小邮' : '小邮 · 待验证模型';
  }
  function disconnected(cfg) {
    const returning = state.connected || cfg.accounts?.length;
    el('onboarding-title').textContent = returning ? '重新连接邮箱' : '欢迎使用 MailAI';
    if (state.browsed) el('onboarding-later').click();
  }
  async function connected(fresh) {
    const first = !state.connected && fresh; state.connected = true;
    if (!fresh && !state.mailboxDone) state.mailboxDone = true;
    save(); refreshAssistant();
    // Reinstalling can reset WebView storage while retaining the mailbox DB.
    // Conversation history is stronger evidence than a local tutorial flag.
    if (!state.aiDone && ready() && await hasAssistantHistory()) {
      state.aiDone = true; aiRunning = false; save(); hideCard();
    }
    if (first && !ready()) openModel(); else inviteMailbox();
  }
  el('onboarding-later').onclick = () => {
    state.browsed = true; save(); el('onboarding-overlay').classList.add('hidden');
    show('尚未连接邮箱', '连接邮箱后开始同步邮件。小邮需要另外配置模型服务，你可以先在设置中了解功能。', '连接邮箱', () => { el('onboarding-overlay').classList.remove('hidden'); hideCard(); });
  };
  const replay = document.createElement('button'); replay.className = 'guide-replay-action'; replay.type = 'button';
  replay.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 7.5A6 6 0 1 0 16 12M15.5 3.5v4h-4"/></svg><span>${mailaiT('guide.replay') || '重新体验引导'}</span>`;
  replay.onclick = () => { state.mailboxDone = state.aiDone = state.deferred = false; state.mailboxStep = 0; save(); if (!_systemConfig?.mail?.logged_in) return el('onboarding-overlay').classList.remove('hidden'); hideSystemView(); mailboxRunning = true; mailboxStep(); };
  document.querySelector('[data-system-panel="guide"] .guide-intro-actions').append(replay);
  window.mailOnboarding = {openModel, refreshAssistant, disconnected, connected, configChanged: () => setTimeout(refreshAssistant, 0), answered: () => {
    const guided = aiRunning; state.aiDone = true; aiRunning = false; save();
    if (state.mailboxDone) hideCard();
    if (guided) toast('准备好了，开始处理邮件吧', 'success');
  }};
})();
