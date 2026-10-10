/* Account-local pet journal. Foreground activity only; no email content is sent. */
(() => {
  const t = (name, ...args) => {
    const key = `pet.${name}`;
    const copy = mailaiT(key) || MAILAI_UI_COPY[key]?.[0] || name;
    return copy.replace(/\{(\d+)\}/g, (_, index) => String(args[index] ?? ''));
  };
  const owner = () => activeMailAccount()?.id || '';
  const label = (name, ...args) => esc(t(name, ...args));
  const stageName = stage => t(`${state?.style === 'ranger' ? 'rangerStage' : 'stage'}${stage}`);
  const stageHint = stage => label(`${state?.style === 'ranger' ? 'rangerHint' : 'stageHint'}${stage}`);
  const numerals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  const duration = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const post = body => ({method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  let state = null, account = '', revision = 0, tab = 'today', dialog, returnFocus;
  let busy = false, tickBusy = false, pending = null, clicks = 0, lastClick = 0;
  let lastInput = performance.now(), lastSample = performance.now(), reading = null;
  let lastRefresh = 0, refreshAccount = '', purchaseIntent = null, feedback = null, renderKey = '';
  const intents = new Map();
  const intentKey = id => `mailai-companion-purchase:${id}`;
  function saveIntent(id, intent) {
    intent ? intents.set(id,intent) : intents.delete(id);
    if (id === account) purchaseIntent = intent;
    try { intent ? localStorage.setItem(intentKey(id),JSON.stringify(intent)) : localStorage.removeItem(intentKey(id)); } catch (_) {}
  }
  function loadIntent(id) {
    if (intents.has(id)) return intents.get(id);
    try {
      const value = JSON.parse(localStorage.getItem(intentKey(id)) || 'null');
      if (value && /^[a-z_]+$/.test(value.item) && /^[a-zA-Z0-9-]{8,80}$/.test(value.token)) return value;
    } catch (_) {}
    return null;
  }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(),12000);
    try { return await api(`/api/companion/${path}`,{...options,signal:controller.signal}); }
    catch (error) {
      if (controller.signal.aborted) throw new Error(t('requestTimeout'));
      throw error;
    } finally { clearTimeout(timeout); }
  }
  const learning = new Map();
  const launched = document.getElementById('companion-growth-launch');
  const summary = document.getElementById('companion-growth-summary');
  const level = document.getElementById('companion-level');

  function applyRewardTheme(theme) {
    const root=document.documentElement,previous=root.dataset.rewardTheme;
    if (theme) root.dataset.rewardTheme=theme;
    else delete root.dataset.rewardTheme;
    if (previous!==theme) document.dispatchEvent(new CustomEvent('mailai:reward-themechange'));
  }
  function resetAppearance() {
    for (const key of ['petStage','petPalette','petAccessory','petEffect','petStyle']) delete document.body.dataset[key];
    applyRewardTheme();
    const themeSummary = document.getElementById('companion-theme-summary');
    if (themeSummary) themeSummary.textContent = t('themeDefault');
    summary.textContent = ''; level.textContent = t('level',1);
  }
  function paint() {
    if (!state || account !== owner()) return;
    const body = document.body.dataset;
    body.petStage = String(state.stage);
    body.petStyle = state.style || 'nature';
    body.petPalette = state.equipped.palette || 'mint';
    body.petAccessory = state.equipped.accessory || 'none';
    body.petEffect = state.equipped.effect || 'none';
    const theme = state.equipped.theme;
    applyRewardTheme(theme && state.items.some(item=>item.id === theme && item.slot === 'theme' && item.owned) ? theme : undefined);
    const themeSummary = document.getElementById('companion-theme-summary');
    if (themeSummary) {
      themeSummary.removeAttribute('data-i18n');
      themeSummary.textContent = theme ? t('themeCurrent',t(`item.${theme}`)) : t('themeDefault');
    }
    level.textContent = t('level',state.stage);
    summary.textContent = t('summary', stageName(state.stage), state.stamps);
    if (dialog?.open) render();
  }
  function accept(result, id, rev) {
    if (id !== owner() || id !== account || rev !== revision) return false;
    const previous = state;
    state = result;
    if (!result.enabled || (previous && previous.enabled !== result.enabled)) {
      // A preference change in another window must also discard buffered activity.
      clicks = 0; pending = null; learning.clear(); lastSample = 0;
    }
    let notice = '';
    if (previous && result.stage > previous.stage) {
      const unlocked = result.items.filter(item=>item.stage > previous.stage && item.stage <= result.stage).length;
      notice = t('evolved',stageName(result.stage),unlocked);
      feedback = {copy:notice,until:Date.now()+20000};
      if (!dialog?.open) toast(notice,'success');
    } else if (previous) {
      const goals = result.quests.filter(q=>q.complete && (result.day !== previous.day || !previous.quests.some(old=>old.id === q.id && old.complete)));
      if (goals.length) notice = t('goalsCompleted',goals.map(q=>t(`quest.${q.id}`)).join(' · '));
      else if (result.xp > previous.xp || result.earned > previous.earned) notice = t('earnedNow',Math.max(0,result.xp-previous.xp),Math.max(0,result.earned-previous.earned));
      if (goals.length) feedback = {copy:notice,until:Date.now()+20000};
    }
    paint();
    if (notice && dialog?.open) message(notice);
    return true;
  }
  async function refresh() {
    const id = owner();
    if (!id || busy || refreshAccount === id) return;
    refreshAccount = id; lastRefresh = performance.now();
    const rev = ++revision;
    try { accept(await request('growth', {accountId:id}), id, rev); }
    catch (error) { if (id === owner() && rev === revision && dialog?.open) message(mailaiSystemMessage(error.message), true); }
    finally { if (refreshAccount === id) refreshAccount = ''; }
  }
  function checkAccount() {
    const id = owner();
    if (id === account) return;
    account = id; state = null; ++revision; pending = null; clicks = 0; reading = null;
    learning.clear(); feedback = null; renderKey = ''; lastSample = 0; lastRefresh = 0;
    purchaseIntent = loadIntent(id); resetAppearance();
    if (dialog?.open) { dialog.close(); }
    if (id) void refresh();
  }
  function message(copy, error = false) {
    const node = dialog?.querySelector('[data-pet-message]');
    if (node) { node.textContent = copy; node.classList.toggle('is-error', error); }
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.id = 'companion-growth-dialog';
    dialog.className = 'pet-journal';
    dialog.setAttribute('aria-labelledby', 'pet-journal-title');
    dialog.innerHTML = `<header class="pet-journal-head"><div><small>MAILAI · COMPANION</small><h2 id="pet-journal-title"></h2></div><button type="button" data-pet-close>×</button></header><div class="pet-journal-body"></div><footer class="pet-journal-footer"><span data-pet-message role="status" aria-live="polite"></span><button type="button" data-pet-enabled></button></footer>`;
    document.body.append(dialog);
    dialog.addEventListener('click', async event => {
      if (event.target === dialog) {
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
        return;
      }
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-pet-close')) return dialog.close();
      if (button.dataset.petTab) {
        tab = button.dataset.petTab; render();
        dialog.querySelector(`[data-pet-tab="${tab}"]`)?.focus({preventScroll:true});
        return;
      }
      if (button.hasAttribute('data-pet-retry')) return refresh();
      if (busy || !state) return;
      let path, payload, notice;
      if (button.hasAttribute('data-pet-enabled')) {
        path = 'preferences'; payload = {enabled:!state.enabled}; notice = payload.enabled ? t('resumed') : t('paused');
        // Discard activity gathered under the previous preference.
        clicks = 0; pending = null; learning.clear(); lastSample = performance.now();
      } else if (button.dataset.petStyle) {
        path = 'style'; payload = {style:button.dataset.petStyle}; notice = t('styleUpdated');
      } else if (button.dataset.petBuy || button.hasAttribute('data-pet-reconcile')) {
        if (purchaseIntent && !button.hasAttribute('data-pet-reconcile')) return;
        path = 'purchase';
        payload = purchaseIntent || {item:button.dataset.petBuy,token:crypto.randomUUID()};
        saveIntent(account,payload);
        notice = t(payload.item === 'berry' ? 'fed' : state.items.find(item=>item.id === payload.item)?.slot === 'theme' ? 'themeBought' : 'bought');
      } else if (button.dataset.petSlot) {
        path = 'equip'; payload = {slot:button.dataset.petSlot, item:button.dataset.petEquip || ''}; notice = t(payload.slot === 'theme' ? payload.item ? 'themeApplied' : 'themeRestored' : 'equipped');
      } else return;
      busy = true; button.disabled = true; button.setAttribute('aria-busy', 'true');
      const id = account, rev = ++revision;
      try {
        const result = await request(path, {...post(payload), accountId:id});
        if (path === 'purchase') saveIntent(id,null);
        accept(result, id, rev);
        if (id === account && id === owner() && dialog.open) message(notice);
      } catch (error) {
        // Only business/validation rejection resolves this intent. A permission
        // or rate-limit error on a retry says nothing about the original commit.
        if (path === 'purchase' && [400,422].includes(error.status)) saveIntent(id,null);
        if (id === account && id === owner() && dialog.open) message(path === 'purchase' && purchaseIntent ? t('purchaseUncertain') : mailaiSystemMessage(error.message), true);
      } finally {
        busy = false;
        renderKey = '';
        if (dialog.open && id === account && id === owner()) render();
        if (button.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); }
      }
    });
    dialog.addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true}); });
  }
  async function open() {
    checkAccount(); ensureDialog(); returnFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    render();
    await refresh();
  }
  function avatar(extra = '') { return `<div class="pet-portrait ${extra}">${window.mailaiCompanionArt || ''}</div>`; }
  function reward(xp, stamps) { return `<span class="pet-reward">+${xp} ${label('growth')} · +${stamps} ${label('stamps')}</span>`; }
  function todayView() {
    const s = state;
    return `<div class="pet-section-title"><h3>${label('daily')}</h3><span>${label('autoReward')}</span></div><div class="pet-quests">${s.quests.map(q => `<article class="pet-quest ${q.complete ? 'is-complete' : ''}"><span class="pet-quest-check" aria-hidden="true">${q.complete ? '✓' : '○'}</span><div><b>${label(`quest.${q.id}`)}</b>${reward(q.xp,q.stamps)}<progress value="${q.progress}" max="${q.target}" aria-label="${label(`quest.${q.id}`)}"></progress></div><small>${q.complete ? label('complete') : q.metric === 'active' ? duration(q.progress)+' / '+duration(q.target) : `${q.progress} / ${q.target}`}</small></article>`).join('')}</div>
    <div class="pet-section-title"><h3>${label('activities')}</h3><span>${label('todayGain',s.today.xp,s.today.stamps)}</span></div>
    <div class="pet-activities">${Object.entries(s.rules).map(([kind,r]) => {
      const value = s.today.counts[kind] || 0, timed = ['active','reading'].includes(kind);
      return `<article><div><b>${label(`activity.${kind}`)}</b><strong>${timed ? duration(value) : value}</strong></div><progress value="${Math.min(value,r.cap)}" max="${r.cap}" aria-label="${label(`activity.${kind}`)}"></progress><small>${label(timed ? 'timeRule' : 'countRule',r.unit,r.xp,r.stamps,r.cap)}</small></article>`;
    }).join('')}</div><p class="pet-note">${label('timingNote')}</p>`;
  }
  function journeyView() {
    return `<p class="pet-note">${label('journeyNote')}</p><div class="pet-journey">${state.stages.map((floor,index) => {
      const stage = index+1, unlocked = state.stage >= stage;
      return `<article class="${unlocked ? 'is-unlocked' : ''} ${state.stage === stage ? 'is-current' : ''}"><span class="pet-stage-number">${numerals[index]}</span><div><b>${esc(stageName(stage))}</b><p>${stageHint(stage)}</p><small>${label('threshold',floor)}${state.stage === stage ? ' · '+label('current') : unlocked ? ' · '+label('unlocked') : ''}</small></div></article>`;
    }).join('')}</div><p class="pet-note">${label('streakNote')}</p>`;
  }
  function shopView() {
    const s = state;
    return `${themeShopView()}<div class="pet-section-title"><h3>${label('shopTitle')}</h3><span>${label('balance',s.stamps)}</span></div><div class="pet-reset-outfit">${['palette','accessory','effect'].map(slot=>`<button type="button" data-pet-slot="${slot}" ${!s.equipped[slot] || busy ? 'disabled' : ''}>${label(`reset.${slot}`)}</button>`).join('')}</div><div class="pet-shop">${s.items.filter(item=>item.slot !== 'theme').map(item => {
      const locked = s.stage < item.stage, equipped = s.equipped[item.slot] === item.id;
      const depleted = item.id === 'berry' && s.berry_today >= 3;
      const unavailable = locked || (!item.owned && s.stamps < item.cost) || depleted || busy || (!!purchaseIntent && !item.owned);
      const action = item.owned ? `data-pet-slot="${item.slot}" data-pet-equip="${item.id}"` : `data-pet-buy="${item.id}"`;
      const caption = equipped ? t('wearing') : item.owned ? t('wear') : depleted ? t('berryLimit') : locked ? t('stageRequired',stageName(item.stage)) : t(item.id === 'berry' ? 'feedPrice' : 'buyPrice',item.cost);
      return `<article class="pet-shop-item ${locked ? 'is-locked' : ''}"><div class="pet-item-art" data-item-preview="${item.id}" aria-hidden="true">${avatar()}</div><div class="pet-item-copy"><b>${label(`item.${item.id}`)}</b><p>${label(`itemHint.${item.id}`)}</p><small>${item.owned ? label('owned') : label('itemRequirement',item.cost,stageName(item.stage))}</small></div><button type="button" ${action} ${unavailable || equipped ? 'disabled' : ''}>${esc(caption)}</button></article>`;
    }).join('')}</div><p class="pet-note">${label('shopNote')}</p>`;
  }
  function themeShopView() {
    const s = state;
    return `<section class="pet-theme-shop"><div class="pet-section-title pet-themes-title"><h3>${label('themeShop')}</h3><button type="button" data-pet-slot="theme" ${!s.equipped.theme || busy ? 'disabled' : ''}>${label('themeReset')}</button></div><p class="pet-note pet-theme-note">${label('themeNote')}</p><div class="pet-theme-grid">${s.items.filter(item=>item.slot === 'theme').map(item=>{
      const active = s.equipped.theme === item.id;
      const disabled = busy || active || (!item.owned && (s.stamps < item.cost || !!purchaseIntent || s.stage < item.stage));
      return `<article class="pet-theme-card ${active ? 'is-current' : ''}"><div class="pet-theme-preview" data-theme-preview="${item.id}" aria-hidden="true"><div class="pet-theme-mini-bar"><i></i><i></i><i></i></div><div class="pet-theme-mini-nav"><i></i><i></i><i></i></div><div class="pet-theme-mini-mail"><i></i><i></i><i></i></div>${avatar('pet-theme-mini-pet')}</div><div class="pet-theme-copy"><b>${label(`item.${item.id}`)}</b><p>${label(`itemHint.${item.id}`)}</p><small>${label('themePermanent')}</small></div><button type="button" ${item.owned ? `data-pet-slot="theme" data-pet-equip="${item.id}"` : `data-pet-buy="${item.id}"`} ${disabled ? 'disabled' : ''}>${active ? label('themeActive') : item.owned ? label('themeUse') : label('buyPrice',item.cost)}</button></article>`;
    }).join('')}</div></section>`;
  }
  function historyView() {
    return `<div class="pet-section-title"><h3>${label('historyTitle')}</h3><span>${label('last14')}</span></div>${state.history.length ? `<div class="pet-history">${state.history.map(day=>`<article><time>${esc(day.day)}</time>${reward(day.xp,day.stamps)}</article>`).join('')}</div>` : `<p class="pet-empty">${label('historyEmpty')}</p>`}<p class="pet-note">${label('privacyNote')}</p><div class="pet-section-title pet-purchase-title"><h3>${label('purchaseHistory')}</h3><span>${label('last20')}</span></div>${(state.purchases || []).length ? `<div class="pet-history">${state.purchases.map(item=>`<article><div><b>${label(`item.${item.item}`)}</b><time>${esc(item.created_at.slice(0,16).replace('T',' '))}</time></div><span>${label('purchaseCost',item.cost)}${item.xp ? ' · '+label('purchaseGrowth',item.xp) : ''}</span></article>`).join('')}</div>` : `<p class="pet-empty">${label('purchaseEmpty')}</p>`}`;
  }
  function render() {
    if (!dialog) return;
    dialog.querySelector('#pet-journal-title').textContent = t('open');
    const close = dialog.querySelector('[data-pet-close]');
    close.setAttribute('aria-label',t('close'));
    const pref = dialog.querySelector('[data-pet-enabled]');
    pref.textContent = t(state?.enabled ? 'pause' : 'resume'); pref.disabled = !state || busy;
    const host = dialog.querySelector('.pet-journal-body');
    if (!state) {
      host.innerHTML = `<p class="pet-empty">${label(account ? 'loading' : 'login')}</p><button type="button" data-pet-retry>${label('retry')}</button>`;
      return;
    }
    const key = JSON.stringify([tab,state.style,state.xp,state.stamps,state.earned,state.streak,state.enabled,state.equipped,state.berry_today,state.day,purchaseIntent,busy,feedback && Date.now()<feedback.until ? feedback.copy : '',tab === 'today' ? state.today : tab === 'history' ? [state.history,state.purchases] : null]);
    if (key === renderKey) return;
    renderKey = key;
    const focus = document.activeElement;
    const focusKey = focus?.closest('.pet-journal') ? Object.entries(focus.dataset).find(([key])=>['petTab','petBuy','petEquip','petSlot','petStyle'].includes(key)) : null;
    const scroll = host.scrollTop;
    const next = state.next_stage_xp;
    const progress = next ? (state.xp-state.stage_floor)/(next-state.stage_floor)*100 : 100;
    host.innerHTML = `${purchaseIntent ? `<div class="pet-pending" role="status"><span>${label('purchasePending',t(`item.${purchaseIntent.item}`))}</span><button type="button" data-pet-reconcile ${busy ? 'disabled' : ''}>${label('reconcile')}</button></div>` : ''}${feedback && Date.now()<feedback.until ? `<p class="pet-milestone" role="status">${esc(feedback.copy)}</p>` : ''}<section class="pet-hero">${avatar('pet-hero-portrait')}<div class="pet-hero-copy"><span class="pet-eyebrow">${label('heroEyebrow')}</span><h3>${esc(stageName(state.stage))} <small>${label('level',state.stage)}</small></h3><p>${stageHint(state.stage)}</p><div class="pet-growth-label"><b>${label('growth')} ${state.xp.toLocaleString()}</b><span>${next ? label('next',next-state.xp) : label('maxStage')}</span></div><progress max="100" value="${progress}" aria-label="${label('growth')}"></progress></div></section>
    <div class="pet-style-choice"><span>${label('styleChoice')}</span>${['nature','ranger'].map(style=>`<button type="button" data-pet-style="${style}" aria-pressed="${state.style === style}" ${state.style === style || busy ? 'disabled' : ''}>${label(`style.${style}`)}</button>`).join('')}<small>${label('styleFree')}</small></div>
    <div class="pet-stats"><article><strong>${state.stamps.toLocaleString()}</strong><span>${label('stamps')}</span></article><article><strong>${state.streak}<small>${label('days')}</small></strong><span>${label('streak')}</span></article><article><strong>${state.earned.toLocaleString()}</strong><span>${label('earned')}</span></article></div>
    ${!state.enabled ? `<p class="pet-paused">${label('paused')}</p>` : ''}<nav class="pet-tabs" aria-label="${label('tabs')}">${['today','journey','shop','history'].map(name=>`<button type="button" data-pet-tab="${name}" aria-pressed="${tab === name}">${label(name)}</button>`).join('')}</nav><section class="pet-tab-content">${({today:todayView,journey:journeyView,shop:shopView,history:historyView})[tab]()}</section>`;
    host.scrollTop = scroll;
    if (focusKey && focus?.isConnected === false) {
      const [key,value] = focusKey;
      const attr = key.replace(/[A-Z]/g,char=>'-'+char.toLowerCase());
      host.querySelector(`[data-${attr}="${CSS.escape(value)}"]`)?.focus({preventScroll:true});
    }
  }

  const activity = () => { lastInput = performance.now(); };
  for (const event of ['pointerdown','keydown','wheel','touchstart']) document.addEventListener(event,activity,{passive:true});
  document.addEventListener('click',event => {
    const now = performance.now();
    // Exclude pet controls from mailbox-click rewards, debounce rapid clicking.
    if (event.isTrusted && state?.enabled && account === owner() && isForeground() && now-lastClick >= 600 && !event.target.closest('.pet-journal, #companion-growth-launch, #companion-growth-settings')) {
      lastClick = now; clicks = Math.min(10, clicks+1);
    }
  });
  document.addEventListener('toggle',event => {
    const details = event.target;
    if (!details.matches?.('.help-topic details, details.help-faq')) return;
    if (!state?.enabled || account !== owner() || !isForeground()) return;
    const name = details.querySelector('summary [data-i18n]')?.dataset.i18n;
    if (name) details.open ? learning.set(name,{node:details,since:performance.now()}) : learning.delete(name);
  },true);
  const isForeground = () => window.mailaiEnergy?.active() ?? (!document.hidden && document.hasFocus());
  const resetClock = () => { lastSample = 0; learning.clear(); clicks = 0; };
  window.addEventListener('blur',resetClock);
  window.addEventListener('focus',() => { resetClock(); activity(); });
  document.addEventListener('visibilitychange',resetClock);
  document.addEventListener('mailai:foreground-changed',resetClock);

  async function tick() {
    checkAccount();
    const now = performance.now(), elapsed = lastSample ? Math.min(10,Math.max(0,Math.floor((now-lastSample)/1000))) : 0;
    lastSample = now;
    if (!account || tickBusy || busy) return;
    if (!state || !state.enabled) {
      if (now-lastRefresh >= (state ? 30000 : 10000)) void refresh();
      return;
    }
    const foreground = isForeground(), active = foreground && now-lastInput < 90000 ? elapsed : 0;
    const id = account;
    const pane = document.querySelector('.reading-pane');
    const rect = pane?.getBoundingClientRect();
    const readerVisible = reading?.account === id && selectedEmailDetail?.id === reading.id &&
      !document.querySelector('dialog[open], .modal:not(.hidden)') && rect?.width && rect.right > 0 && rect.left < innerWidth && getComputedStyle(pane).visibility !== 'hidden' && !document.querySelector('.layout')?.classList.contains('hidden');
    const readingSeconds = active && readerVisible ? Math.min(active,Math.floor((now-reading.since)/1000)) : 0;
    const lesson = foreground && !dialog?.open ? [...learning.entries()].find(([,entry]) => {
      const bounds = entry.node.getBoundingClientRect();
      return entry.node.open && now-entry.since >= 8000 && bounds.height && bounds.top < innerHeight && bounds.bottom > 0 && getComputedStyle(entry.node).visibility !== 'hidden';
    }) : null;
    if (lesson) learning.delete(lesson[0]);
    if (pending && (pending.account !== id || Date.now()-pending.at > 30000)) pending = null;
    if (!pending && (active || clicks || lesson)) {
      pending = {account:id,at:Date.now(),payload:{token:crypto.randomUUID(),active,reading:readingSeconds,clicks:foreground ? clicks : 0,email_id:readingSeconds ? reading.id : null,learn:lesson?.[0] || ''}};
      clicks = 0;
    }
    if (!pending) {
      // Pick up server-side incoming/sent/tool rewards without active timers.
      if (foreground && now-lastRefresh >= 30000) void refresh();
      return;
    }
    const batch = pending, rev = ++revision;
    tickBusy = true;
    try {
      const result = await request('heartbeat',{...post(batch.payload),accountId:id});
      if (pending === batch) pending = null;
      accept(result,id,rev);
    } catch (_) { /* Retry the same token within 30 seconds; never accrue offline time. */ }
    finally { tickBusy = false; }
  }
  async function openThemes() {
    tab = 'shop'; await open();
    dialog?.querySelector('.pet-themes-title')?.scrollIntoView({block:'start'});
  }
  window.mailaiPet = {open, openThemes, refresh, openedEmail(id,accountId) { checkAccount(); reading = {id,account:accountId,since:performance.now()}; }};
  launched.addEventListener('click',open);
  document.getElementById('companion-growth-settings').addEventListener('click',open);
  document.getElementById('companion-theme-settings')?.addEventListener('click',openThemes);
  document.addEventListener('mailai:language-changed',() => { feedback = null; renderKey = ''; message(''); paint(); if (!state) level.textContent = t('level',1); });
  new MutationObserver(checkAccount).observe(document.getElementById('account-mailbox-nav'),{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  window.mailaiEnergy.register('companion-growth',tick,10000);
  checkAccount();
})();
