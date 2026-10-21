/* Client-wide pet journal. Foreground activity only; no email content is sent. */
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
  const dateLabel = (value, dayOnly = false) => {
    const date = new Date(dayOnly ? value+'T12:00:00' : value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(currentI18nLanguage(), dayOnly ? {dateStyle:'medium'} : {dateStyle:'medium',timeStyle:'short'}).format(date);
  };
  const post = body => ({method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  let state = null, account = '', revision = 0, tab = 'today', dialog, returnFocus;
  let busy = false, tickBusy = false, pending = null, clicks = 0, lastClick = 0;
  let outfitPending = null;
  let lastInput = performance.now(), lastSample = performance.now(), reading = null;
  let lastRefresh = 0, refreshAccount = '', purchaseIntent = null, feedback = null, renderKey = '';
  let previewItem = 'sparkles', previewPlaying = true, previewOpen = false, previewStage = null, shopFilter = 'all';
  let giftDraft = '', giftPreview = null, giftError = '', giftErrorKey = '', giftBusy = false;
  let giftPending = '', giftFileName = '', giftReadRevision = 0, giftOperation = '';
  const cleanGiftCode = code => String(code).replace(/\s+/g,'').replace(/^\uFEFF+/,'');
  try { giftPending = localStorage.getItem('mailai-companion-gift-pending') || ''; giftDraft = giftPending; } catch (_) {}
  const saveGiftPending = code => {
    giftPending = code;
    try { code ? localStorage.setItem('mailai-companion-gift-pending',code) : localStorage.removeItem('mailai-companion-gift-pending'); } catch (_) {}
  };
  function editGift(code = '', file = '') {
    ++giftReadRevision; giftDraft = code; giftFileName = file; giftPreview = null;
    giftError = ''; giftErrorKey = ''; previewOpen = false; message('');
  }
  function focusGift(selector, scroll = false) {
    if (!dialog?.open || tab !== 'gifts') return;
    const node = dialog.querySelector(selector);
    if (scroll) node?.scrollIntoView({block:'nearest'});
    node?.focus({preventScroll:true});
  }
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const motionAllowed = () => !motionPreference.matches && !document.body.classList.contains('companion-still');
  const previewNote = () => motionAllowed() ? tab === 'gifts' ? 'giftPreviewSafe' : 'previewSafe' : 'previewStatic';
  const motionHosts = new Set();
  const motionVisibility = new IntersectionObserver(entries => {
    for (const entry of entries) { entry.target.dataset.rewardVisible = String(entry.isIntersecting); if(!entry.isIntersecting)window.mailaiCompanionMotion?.stopPreview(entry.target); }
  });
  function watchRewardMotion() {
    for (const svg of motionHosts) if (!svg.isConnected) { motionVisibility.unobserve(svg); motionHosts.delete(svg); }
    for (const svg of document.querySelectorAll('.mail-companion')) {
      svg.classList.toggle('pet-preview-svg', !!svg.closest('.pet-item-art'));
      if (!motionHosts.has(svg)) {
        svg.dataset.rewardVisible = 'false'; motionHosts.add(svg); motionVisibility.observe(svg);
      }
    }
  }
  function updatePreviewMotion() {
    if(!previewPlaying || !motionAllowed())window.mailaiCompanionMotion?.stopPreview();
    dialog?.querySelectorAll('[data-pet-try-action]').forEach(n=>n.disabled=!motionAllowed());
    const art = dialog?.querySelector('.pet-live-art');
    const button = dialog?.querySelector('[data-pet-preview-play]');
    if (art) art.dataset.previewPlaying = String(previewPlaying && motionAllowed());
    if (button) {
      button.disabled = !motionAllowed();
      button.textContent = t(previewPlaying && motionAllowed() ? 'previewPause' : 'previewPlay');
      button.setAttribute('aria-pressed', String(previewPlaying && motionAllowed()));
    }
    const note = dialog?.querySelector('[data-pet-motion-note]');
    if (note) note.textContent = t(previewNote());
  }
  const intents = new Map();
  const intentKey = () => 'mailai-companion-purchase:client';
  function saveIntent(id, intent) {
    intent ? intents.set('client',intent) : intents.delete('client');
    purchaseIntent = intent;
    try {
      intent ? localStorage.setItem(intentKey(),JSON.stringify(intent)) : localStorage.removeItem(intentKey());
      localStorage.removeItem(`mailai-companion-purchase:${id}`);
    } catch (_) {}
  }
  function loadIntent(id) {
    if (intents.has('client')) return intents.get('client');
    try {
      const value = JSON.parse(localStorage.getItem(intentKey()) || localStorage.getItem(`mailai-companion-purchase:${id}`) || 'null');
      if (value && /^[a-z_]+$/.test(value.item) && /^[a-zA-Z0-9-]{8,80}$/.test(value.token)) {
        saveIntent(id,value); return value;
      }
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
    let notice = '', milestone = null;
    if (previous && result.stage > previous.stage) {
      milestone = {evolved:true};
      const unlocked = result.items.filter(item=>item.stage > previous.stage && item.stage <= result.stage).length;
      notice = t('evolved',stageName(result.stage),unlocked);
      feedback = {copy:notice,until:Date.now()+20000};
      if (!dialog?.open) toast(notice,'success');
    } else if (previous) {
      const goals = result.quests.filter(q=>q.complete && (result.day !== previous.day || !previous.quests.some(old=>old.id === q.id && old.complete)));
      if (goals.length) notice = t('goalsCompleted',goals.map(q=>t(`quest.${q.id}`)).join(' · '));
      else if (result.xp > previous.xp || result.earned > previous.earned) notice = t('earnedNow',Math.max(0,result.xp-previous.xp),Math.max(0,result.earned-previous.earned));
      if (goals.length) milestone = {evolved:false};
      if (goals.length) feedback = {copy:notice,until:Date.now()+20000};
    }
    paint();
    if (milestone) document.dispatchEvent(new CustomEvent('mailai:companion-milestone',{detail:milestone}));
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
    account = id; ++revision; pending = null; clicks = 0; reading = null;
    learning.clear(); feedback = null; renderKey = ''; lastSample = 0; lastRefresh = 0;
    purchaseIntent = loadIntent(id);
    if (id) { paint(); void refresh(); }
    else { state = null; resetAppearance(); if (dialog?.open) dialog.close(); }
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
    dialog.innerHTML = `<header class="pet-journal-head"><div><small>MAILAI · COMPANION</small><h2 id="pet-journal-title"></h2></div><button type="button" class="modern-close" data-pet-close><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="m6 6 8 8M14 6l-8 8"/></svg></button></header><div class="pet-journal-body"></div><footer class="pet-journal-footer"><span data-pet-message role="status" aria-live="polite"></span><button type="button" data-pet-enabled></button></footer>`;
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
        dialog.querySelector('.pet-tab-content')?.scrollIntoView({block:'start'});
        dialog.querySelector(`[data-pet-tab="${tab}"]`)?.focus({preventScroll:true});
        return;
      }
      if (button.hasAttribute('data-pet-retry')) return refresh();
      if (button.dataset.petShopFilter) { shopFilter=button.dataset.petShopFilter; renderKey='';render();dialog.querySelector(`[data-pet-shop-filter="${shopFilter}"]`)?.focus({preventScroll:true});return; }
      if (button.dataset.petTryStage) { tab='shop';previewStage=Number(button.dataset.petTryStage);previewOpen=true;renderKey='';render();selectPreview(previewItem,true);return; }
      if (button.dataset.petTryAction) {
        previewPlaying=true;updatePreviewMotion();
        window.mailaiCompanionMotion?.preview(dialog.querySelector('.pet-live-art svg'),previewStage || state.stage,button.dataset.petTryAction);return;
      }
      if (button.dataset.petCollection) return selectPreview(button.dataset.petCollection,true);
      if (button.dataset.petPreview) return selectPreview(button.dataset.petPreview, true);
      if (button.hasAttribute('data-pet-preview-close')) {
        previewOpen = false;window.mailaiCompanionMotion?.stopPreview();
        dialog.querySelector('.pet-live-preview').hidden = true; message('');
        dialog.querySelector(`[data-pet-preview="${previewItem}"]`)?.focus();
        return;
      }
      if (button.hasAttribute('data-pet-preview-play')) {
        previewPlaying = !previewPlaying; updatePreviewMotion(); return;
      }
      if (button.hasAttribute('data-pet-gift-copy')) {
        try { await navigator.clipboard.writeText(state.claim_code); message(t('giftCopied')); }
        catch (_) { dialog.querySelector('[data-pet-claim-code]')?.focus(); dialog.querySelector('[data-pet-claim-code]')?.select(); message(t('giftCopyFallback')); }
        return;
      }
      if (button.hasAttribute('data-pet-gift-import')) return dialog.querySelector('[data-pet-gift-file]')?.click();
      if (button.hasAttribute('data-pet-gift-preview')) return runGift('preview');
      if (button.hasAttribute('data-pet-gift-claim')) return runGift('claim');
      if (button.hasAttribute('data-pet-gift-reconcile')) {
        if (busy || !giftPending) return;
        editGift(giftPending); return runGift('preview');
      }
      if (button.hasAttribute('data-pet-gift-clear')) {
        if (busy) return; editGift(); renderKey = ''; render(); focusGift('[data-pet-gift-code]'); return;
      }
      if (button.hasAttribute('data-pet-gift-wear')) {
        return visitOutfits(giftPreview?.items.map(item=>item.id) || []);
      }
      if (button.dataset.petGiftOutfits) return visitOutfits(state.gifts.find(gift=>gift.id===button.dataset.petGiftOutfits)?.items || []);
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
      if (path === 'equip' && payload.slot !== 'theme') {
        outfitPending = {id:button.dataset.petItemAction || '', item:payload.item};
        renderKey = ''; render();
      }
      const id = account, rev = ++revision, actionItem = button.dataset.petItemAction;
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
        outfitPending = null;
        renderKey = '';
        if (dialog.open && id === account && id === owner()) {
          render();
          if (actionItem && [document.body,dialog].includes(document.activeElement))
            dialog.querySelector(`[data-pet-item-action="${CSS.escape(actionItem)}"]`)?.focus({preventScroll:true});
        }
        if (button.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); }
        if (id !== account) void refresh();
      }
    });
    dialog.addEventListener('input', event => {
      if (!event.target.matches('[data-pet-gift-code]') || busy) return;
      editGift(event.target.value);
      dialog.querySelector('.pet-gift-result')?.remove();
      const error = dialog.querySelector('[data-pet-gift-error]'); if (error) error.textContent = '';
      const verify = dialog.querySelector('[data-pet-gift-preview]'); if (verify) verify.disabled = !giftDraft.trim();
      const clear = dialog.querySelector('[data-pet-gift-clear]'); if (clear) clear.disabled = !giftDraft;
      event.target.setAttribute('aria-invalid','false');
      const hint = dialog.querySelector('.pet-gift-source summary small'); if (hint) hint.textContent = t('giftInputHint');
    });
    dialog.addEventListener('keydown', event => {
      if (event.target.matches('[data-pet-gift-code]') && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); void runGift('preview');
      }
    });
    dialog.addEventListener('change', async event => {
      if (event.target.matches('[data-pet-gift-file]')) {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file || busy) return;
        editGift(); const read = giftReadRevision, id = account;
        if (file.size > 8192) { giftErrorKey = 'giftFileLarge'; renderKey = ''; render(); focusGift('[data-pet-gift-code]'); return; }
        try {
          const text = await file.text();
          if (read !== giftReadRevision || id !== account || busy) return;
          editGift(text,file.name); renderKey = ''; render();
          await runGift('preview');
        } catch (_) {
          if (read !== giftReadRevision || id !== account) return;
          giftErrorKey = 'giftFileError'; renderKey = ''; render(); focusGift('[data-pet-gift-code]');
        }
        return;
      }
      if (event.target.matches('[data-pet-preview-stage]')) { previewStage=Number(event.target.value);selectPreview(previewItem);dialog.querySelector('[data-pet-preview-stage]')?.focus();return; }
      if (event.target.matches('[data-pet-preview-select]')) selectPreview(event.target.value);
    });
    dialog.addEventListener('close', () => { window.mailaiCompanionMotion?.stopPreview(); document.dispatchEvent(new Event('mailai:companion-journal')); if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true}); });
  }
  function visitOutfits(items) {
    shopFilter = 'all'; renderKey = ''; tab = 'shop'; render();
    const cards = items.map(item=>dialog.querySelector(`[data-pet-item="${CSS.escape(item)}"]`)).filter(Boolean);
    for (const card of cards) { card.setAttribute('data-gift-focus','true'); card.tabIndex = -1; }
    const card = cards[0];
    card?.scrollIntoView({block:'center'});
    const button = card?.querySelector('button[data-pet-slot]');
    (button && !button.disabled ? button : card)?.focus({preventScroll:true});
  }
  async function runGift(mode) {
    if (busy || !state) return;
    if (!giftDraft.trim()) { giftErrorKey = 'giftEmpty'; renderKey = ''; render(); focusGift('[data-pet-gift-code]'); return; }
    if (mode === 'claim' && (!giftPreview || giftPreview.claimed)) return;
    if (mode === 'claim' && giftPending && cleanGiftCode(giftPending) !== cleanGiftCode(giftDraft)) {
      giftErrorKey = 'giftResolveFirst'; renderKey = ''; render(); focusGift('[data-pet-gift-reconcile]'); return;
    }
    busy = true; giftBusy = true; giftOperation = mode; giftError = ''; giftErrorKey = '';
    const id = account, rev = ++revision, code = giftDraft;
    const isPending = () => giftPending && cleanGiftCode(giftPending) === cleanGiftCode(code);
    if (mode === 'claim') saveGiftPending(code);
    renderKey = ''; render();
    try {
      const result = await request(`gifts/${mode}`, {...post({code}),accountId:id});
      if (id !== account || id !== owner() || rev !== revision) return;
      if (mode === 'preview') {
        if (result.claimed) accept(await request('growth',{accountId:id}),id,rev);
        if (id !== account || id !== owner() || rev !== revision) return;
        giftPreview = result;
      } else {
        accept(result,id,rev); giftPreview = {...giftPreview,claimed:true}; message(t('giftClaimed'));
      }
      if (isPending()) saveGiftPending('');
      if (giftPreview?.claimed) giftPreview.items = giftPreview.items.map(item=>({...item,owned:state.items.some(entry=>entry.id===item.id && entry.owned)}));
    } catch (error) {
      // A definite business rejection must not leave the client unable to use another voucher.
      // Server receipts still prevent duplicates if the original voucher is entered again.
      if ([400,422].includes(error.status) && isPending()) saveGiftPending('');
      if (id === account && id === owner()) giftError = error.message;
    } finally {
      busy = false; giftBusy = false; giftOperation = ''; renderKey = '';
      if (dialog.open) render();
      if (id !== account) void refresh();
      else focusGift(giftError || giftErrorKey ? '[data-pet-gift-code]' : giftPreview?.claimed ? '[data-pet-gift-wear]' : '[data-pet-gift-claim]', true);
    }
  }
  function giftsView() {
    const card = item => {
      const owned = state.items.some(entry=>entry.id === item.id && entry.owned), wearing = state.equipped[item.slot] === item.id;
      return `<article tabindex="0">${item.slot === 'theme' ? `<div class="pet-theme-preview" data-theme-preview="${item.id}" aria-hidden="true"><div class="pet-theme-mini-bar"><i></i><i></i><i></i></div><div class="pet-theme-mini-nav"><i></i><i></i><i></i></div><div class="pet-theme-mini-mail"><i></i><i></i><i></i></div>${avatar('pet-theme-mini-pet')}</div>` : `<button type="button" class="pet-preview-icon" data-pet-preview="${item.id}" title="${label('previewIcon',t(`item.${item.id}`))}" aria-label="${label('previewIcon',t(`item.${item.id}`))}"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.5"/></svg></button><div class="pet-item-art" data-item-preview="${item.id}" aria-hidden="true">${avatar()}</div>`}<b>${label(`item.${item.id}`)}</b><small>${label(giftPreview.claimed ? 'giftOwned' : owned ? 'giftAlreadyOwned' : 'giftPermanent')}</small>${giftPreview.claimed ? `<button type="button" data-pet-slot="${item.slot}" data-pet-equip="${item.id}" ${busy || !owned || wearing ? 'disabled' : ''}>${label(wearing ? item.slot === 'theme' ? 'themeActive' : 'wearing' : item.slot === 'theme' ? 'themeUse' : 'wear')}</button>` : ''}</article>`;
    };
    const error = giftErrorKey ? t(giftErrorKey) : mailaiSystemMessage(giftError);
    const step = giftPreview?.claimed ? 3 : giftPreview ? 2 : 1;
    const preview = giftPreview ? `<section class="pet-gift-result" aria-labelledby="pet-gift-result-title"><div class="pet-gift-success" ${giftPreview.claimed ? '' : 'hidden'} role="status"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg><div><b>${label('giftSuccessTitle')}</b><small>${label('giftSuccessHint')}</small></div></div><div class="pet-section-title"><h3 id="pet-gift-result-title">${esc(giftPreview.title)}</h3><span class="pet-gift-kind">${label(giftPreview.exclusive ? 'giftExclusive' : 'giftCampaign')}</span></div><p class="pet-note">${giftPreview.expires ? label('giftDeadline',new Date(giftPreview.expires*1000).toLocaleString(currentI18nLanguage())) : label('giftNoDeadline')}</p><div class="pet-gift-items">${giftPreview.items.map(card).join('')}</div><section class="pet-live-preview" aria-labelledby="pet-preview-title" ${previewOpen ? '' : 'hidden'}>${previewView()}</section><div class="pet-gift-confirm"><p>${label(giftPreview.claimed ? 'giftSlotHint' : 'giftSafe')}</p><button type="button" class="pet-gift-primary" ${giftPreview.claimed ? 'data-pet-gift-wear' : 'data-pet-gift-claim'} ${busy || (giftPending && cleanGiftCode(giftPending)!==cleanGiftCode(giftDraft)) ? 'disabled' : ''}>${label(giftBusy && giftOperation === 'claim' ? 'giftClaiming' : giftPreview.claimed ? 'giftWearNow' : 'giftClaim')}</button></div></section>` : '';
    return `<section class="pet-gift-panel"><div class="pet-section-title"><h3>${label('giftTitle')}</h3><span class="pet-gift-free">${label('giftFree')}</span></div><p class="pet-note">${label('giftIntro')}</p><ol class="pet-gift-steps" aria-label="${label('giftSteps')}">${['giftStepCode','giftStepPreview','giftStepWear'].map((name,index)=>`<li ${step===index+1 ? 'aria-current="step"' : ''} class="${index+1<step ? 'is-done' : ''}"><span>${index+1<step ? '✓' : index+1}</span>${label(name)}</li>`).join('')}</ol><details class="pet-gift-identity"><summary>${label('giftIdentitySummary')}<small>${label('giftIdentityRequest')}</small></summary><label for="pet-claim-code">${label('giftIdentity')}</label><div><input id="pet-claim-code" data-pet-claim-code readonly value="${esc(state.claim_code)}" aria-label="${label('giftIdentity')}"><button type="button" data-pet-gift-copy>${label('giftCopy')}</button></div><small>${label('giftIdentityHint')}</small></details>${giftPending ? `<div class="pet-gift-pending" role="status"><p>${label(cleanGiftCode(giftPending) !== cleanGiftCode(giftDraft) ? 'giftResolveFirst' : 'giftPending')}</p><button type="button" data-pet-gift-reconcile ${busy ? 'disabled' : ''}>${label('giftReconcile')}</button></div>` : ''}<details class="pet-gift-source" ${!giftPreview || error ? 'open' : ''}><summary>${label(giftPreview ? 'giftChange' : 'giftCode')}<small>${giftFileName ? esc(giftFileName) : label('giftInputHint')}</small></summary><label class="pet-visually-hidden" for="pet-gift-code">${label('giftCode')}</label><textarea id="pet-gift-code" data-pet-gift-code maxlength="8192" spellcheck="false" autocomplete="off" aria-describedby="pet-gift-error" aria-invalid="${!!error}" placeholder="${label('giftCodePlaceholder')}" ${busy ? 'disabled' : ''}>${esc(giftDraft)}</textarea><div class="pet-gift-actions"><input type="file" data-pet-gift-file accept=".mailaigift,.txt" hidden><button type="button" data-pet-gift-import ${busy ? 'disabled' : ''}>${label('giftImport')}</button><button type="button" data-pet-gift-clear ${busy || !giftDraft ? 'disabled' : ''}>${label('giftClear')}</button><button type="button" class="pet-gift-primary" data-pet-gift-preview ${busy || !giftDraft.trim() ? 'disabled' : ''}>${label(giftBusy && giftOperation === 'preview' ? 'giftChecking' : 'giftVerify')}</button></div></details><p id="pet-gift-error" class="pet-gift-error" data-pet-gift-error role="alert">${esc(error)}</p>${preview}</section><div class="pet-section-title pet-purchase-title"><h3>${label('giftHistory')}</h3><span>${label('giftHistoryLimit')}</span></div>${state.gifts.length ? `<div class="pet-history">${state.gifts.map(gift=>`<article><div><b>${esc(gift.title)}</b><small>${gift.items.map(item=>label(`item.${item}`)).join(' · ')}</small><time>${esc(dateLabel(gift.claimed_at))}</time></div><button type="button" data-pet-gift-outfits="${esc(gift.id)}" aria-label="${label('giftViewOutfitsNamed',gift.title)}">${label('giftViewOutfits')}</button></article>`).join('')}</div>` : `<p class="pet-empty">${label('giftHistoryEmpty')}</p>`}`;
  }
  async function open() {
    checkAccount(); ensureDialog(); returnFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    render();
    document.dispatchEvent(new Event('mailai:companion-journal'));
    await refresh();
  }
  function avatar(extra = '', stage = null) {
    let art = window.mailaiCompanionArt || '';
    if (stage !== null) art = art.replace('<svg ', `<svg data-evolution-stage="${stage}" `);
    return `<div class="pet-portrait ${extra}">${art}</div>`;
  }
  function previewView() {
    const items = state.items.filter(item => item.slot !== 'theme' && (tab !== 'gifts' || giftPreview?.items.some(gift=>gift.id===item.id)));
    if (!items.length) return '';
    const item = items.find(item => item.id === previewItem) || items[0];
    previewItem = item.id;
    return `<div class="pet-live-art pet-item-art" data-item-preview="${item.id}" data-preview-playing="${previewPlaying && motionAllowed()}">${avatar('',previewStage || state.stage)}<span class="pet-fitting-stage">${esc(stageName(previewStage || state.stage))}</span></div><div class="pet-preview-copy"><div class="pet-preview-heading"><h4 id="pet-preview-title">${label(`item.${item.id}`)}</h4><div class="pet-preview-tools"><small>${label('previewTitle')}</small><button type="button" data-pet-preview-close title="${label('previewClose')}" aria-label="${label('previewClose')}">×</button></div></div><p>${label(`itemHint.${item.id}`)}</p><div class="pet-preview-controls"><select data-pet-preview-select aria-label="${label('previewChoose')}">${items.map(entry => `<option value="${entry.id}" ${entry.id === item.id ? 'selected' : ''}>${label(`item.${entry.id}`)}</option>`).join('')}</select><button type="button" data-pet-preview-play aria-pressed="${previewPlaying && motionAllowed()}" ${!motionAllowed() ? 'disabled' : ''}>${label(previewPlaying && motionAllowed() ? 'previewPause' : 'previewPlay')}</button></div><div class="pet-fitting-controls"><label>${label('fittingStage')}<select data-pet-preview-stage>${state.stages.map((_,i)=>`<option value="${i+1}" ${(previewStage || state.stage)===i+1?'selected':''}>${numerals[i]} · ${esc(stageName(i+1))}</option>`).join('')}</select></label><div class="pet-fitting-actions">${['greet','travel','signature'].map(action=>`<button type="button" data-pet-try-action="${action}" ${!motionAllowed()?'disabled':''}>${label('try.'+action)}</button>`).join('')}</div></div><p class="pet-preview-footnote" data-pet-motion-note>${label(previewNote())}</p></div>`;
  }
  function selectPreview(item, scroll = false) {
    if (!state?.items.some(entry => entry.id === item && entry.slot !== 'theme')) return;
    const host = dialog?.querySelector('.pet-live-preview');
    if (!host) return;
    const focused = document.activeElement?.matches('[data-pet-preview-select]');
    window.mailaiCompanionMotion?.stopPreview();
    previewItem = item; previewPlaying = true; previewOpen = true; host.hidden = false; host.innerHTML = previewView();
    watchRewardMotion();
    if (focused) host.querySelector('[data-pet-preview-select]').focus({preventScroll:true});
    if (scroll) { host.scrollIntoView({block:'start'}); host.querySelector('[data-pet-preview-select]').focus({preventScroll:true}); }
    message(t('previewing',t(`item.${item}`)));
  }
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
      return `<article class="${unlocked ? 'is-unlocked' : ''} ${state.stage === stage ? 'is-current' : ''}"><span class="pet-stage-number">${numerals[index]}</span>${avatar('pet-evolution-preview',stage)}<div><b>${esc(stageName(stage))}</b><p>${stageHint(stage)}</p><p class="pet-stage-ability">${label('life.'+(state.style === 'ranger' ? 'rangerStage' : 'stage')+stage)}</p><div class="pet-unlock-list">${state.items.filter(item=>item.stage===stage&&item.slot!=='consumable').map(item=>`<span>${label('item.'+item.id)}</span>`).join('')}</div><button type="button" data-pet-try-stage="${stage}">${label('tryStage')}</button><small>${label('threshold',floor)}${state.stage === stage ? ' · '+label('current') : unlocked ? ' · '+label('unlocked') : ''}</small></div></article>`;
    }).join('')}</div><p class="pet-note">${label('streakNote')}</p>`;
  }
  function collectionView() {
    const collections=[['post','cap','scarf','satchel'],['cloud','wings','jacket','visor'],['star','mech_wings','armor','orbit']];
    const next=Math.min(7,state.stage+1),remaining=Math.max(0,state.stages[next-1]-state.xp);
    return `<section class="pet-boutique-intro"><div><small>${label('boutiqueEyebrow')}</small><h3>${label('boutiqueTitle')}</h3><p>${label('boutiqueHint')}</p></div><div class="pet-collection-progress"><b>${state.items.filter(i=>i.owned&&i.slot!=='consumable').length} / ${state.items.filter(i=>i.slot!=='consumable').length}</b><span>${label('collectionCount')}</span></div></section><div class="pet-collections">${collections.map(([name,hero,...pieces])=>`<article><div class="pet-item-art" data-item-preview="${hero}">${avatar('',Math.max(state.stage,state.items.find(i=>i.id===hero).stage))}</div><small>${label('collection.'+name+'.tag')}</small><h4>${label('collection.'+name)}</h4><p>${[hero,...pieces].map(id=>label('item.'+id)).join(' · ')}</p><button type="button" data-pet-collection="${hero}">${label('collectionExplore')}</button></article>`).join('')}</div><div class="pet-next-reward"><div><b>${state.stage<7?label('nextLook',stageName(next)):label('allGrown')}</b><p>${state.stage<7?label('nextLookHint',remaining):label('allGrownHint')}</p></div><button type="button" data-pet-try-stage="${next}">${label('tryStage')}</button></div>`;
  }
  function shopView() {
    const s = state;
    return `${collectionView()}<section class="pet-live-preview" aria-labelledby="pet-preview-title" ${previewOpen ? '' : 'hidden'}>${previewView()}</section><div class="pet-section-title"><h3>${label('shopTitle')}</h3><span>${label('balance',s.stamps)}</span></div><div class="pet-reset-outfit">${['palette','accessory','effect'].map(slot=>`<button type="button" data-pet-slot="${slot}" ${!s.equipped[slot] || busy ? 'disabled' : ''}>${label(`reset.${slot}`)}</button>`).join('')}</div><div class="pet-shop-filters" role="group" aria-label="${label('shopFilter')}">${['all','accessory','palette','effect','owned'].map(filter=>`<button type="button" data-pet-shop-filter="${filter}" aria-pressed="${shopFilter===filter}">${label('filter.'+filter)}</button>`).join('')}</div><div class="pet-shop">${s.items.filter(item=>item.slot !== 'theme' && (shopFilter==='all'||shopFilter==='owned'&&item.owned||item.slot===shopFilter)).map(item => {
      const locked = !item.owned && s.stage < item.stage, equipped = s.equipped[item.slot] === item.id;
      const depleted = item.id === 'berry' && s.berry_today >= 3;
      const unavailable = locked || (!item.owned && s.stamps < item.cost) || depleted || busy || (!!purchaseIntent && !item.owned);
      const actionBusy = outfitPending?.id === item.id;
      const action = item.owned ? `data-pet-item-action="${item.id}" data-pet-slot="${item.slot}" data-pet-equip="${equipped ? '' : item.id}"` : `data-pet-buy="${item.id}"`;
      const caption = actionBusy ? t(outfitPending.item ? 'equipping' : 'removing') : equipped ? t('remove') : item.owned ? t('wear') : depleted ? t('berryLimit') : locked ? t('stageRequired',stageName(item.stage)) : t(item.id === 'berry' ? 'feedPrice' : 'buyPrice',item.cost);
      return `<article data-pet-item="${item.id}" class="pet-shop-item ${locked ? 'is-locked' : ''} ${equipped?'is-equipped':''}"><button type="button" class="pet-preview-icon" data-pet-preview="${item.id}" title="${label('previewIcon',t(`item.${item.id}`))}" aria-label="${label('previewIcon',t(`item.${item.id}`))}"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.5"/></svg></button><div class="pet-item-art" data-item-preview="${item.id}" aria-hidden="true">${avatar('',Math.max(s.stage,item.stage))}<span class="pet-item-stage">${numerals[item.stage-1]}</span></div><div class="pet-item-copy"><b>${label(`item.${item.id}`)}</b><p>${label(`itemHint.${item.id}`)}</p><small>${equipped ? '<span class="pet-equipped-status">✓ '+label('wearing')+'</span>' : item.owned ? label('owned') : label('itemRequirement',item.cost,stageName(item.stage))}</small></div><button type="button" ${action} ${actionBusy ? 'aria-busy="true"' : ''} ${unavailable ? 'disabled' : ''}>${esc(caption)}</button></article>`;
    }).join('')}</div>${shopFilter==='owned'&&!s.items.some(item=>item.owned&&item.slot!=='theme')?`<p class="pet-empty">${label('wardrobeEmpty')}</p>`:''}<p class="pet-note">${label('shopNote')}</p>${themeShopView()}`;
  }
  function themeShopView() {
    const s = state;
    return `<section class="pet-theme-shop"><div class="pet-section-title pet-themes-title"><h3>${label('themeShop')}</h3><button type="button" data-pet-slot="theme" ${!s.equipped.theme || busy ? 'disabled' : ''}>${label('themeReset')}</button></div><p class="pet-note pet-theme-note">${label('themeNote')}</p><div class="pet-theme-grid">${s.items.filter(item=>item.slot === 'theme').map(item=>{
      const active = s.equipped.theme === item.id;
      const disabled = busy || active || (!item.owned && (s.stamps < item.cost || !!purchaseIntent || s.stage < item.stage));
      return `<article data-pet-item="${item.id}" class="pet-theme-card ${active ? 'is-current' : ''}"><div class="pet-theme-preview" data-theme-preview="${item.id}" aria-hidden="true"><div class="pet-theme-mini-bar"><i></i><i></i><i></i></div><div class="pet-theme-mini-nav"><i></i><i></i><i></i></div><div class="pet-theme-mini-mail"><i></i><i></i><i></i></div>${avatar('pet-theme-mini-pet')}</div><div class="pet-theme-copy"><b>${label(`item.${item.id}`)}</b><p>${label(`itemHint.${item.id}`)}</p><small>${label('themePermanent')}</small></div><button type="button" ${item.owned ? `data-pet-slot="theme" data-pet-equip="${item.id}"` : `data-pet-buy="${item.id}"`} ${disabled ? 'disabled' : ''}>${active ? label('themeActive') : item.owned ? label('themeUse') : label('buyPrice',item.cost)}</button></article>`;
    }).join('')}</div></section>`;
  }
  function historyView() {
    return `<div class="pet-section-title"><h3>${label('historyTitle')}</h3><span>${label('last14')}</span></div>${state.history.length ? `<div class="pet-history">${state.history.map(day=>`<article><time>${esc(dateLabel(day.day,true))}</time>${reward(day.xp,day.stamps)}</article>`).join('')}</div>` : `<p class="pet-empty">${label('historyEmpty')}</p>`}<p class="pet-note">${label('privacyNote')}</p><div class="pet-section-title pet-purchase-title"><h3>${label('purchaseHistory')}</h3><span>${label('last20')}</span></div>${(state.purchases || []).length ? `<div class="pet-history">${state.purchases.map(item=>`<article><div><b>${label(`item.${item.item}`)}</b><time>${esc(dateLabel(item.created_at))}</time></div><span>${label('purchaseCost',item.cost)}${item.xp ? ' · '+label('purchaseGrowth',item.xp) : ''}</span></article>`).join('')}</div>` : `<p class="pet-empty">${label('purchaseEmpty')}</p>`}`;
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
      window.mailaiCompanionMotion?.stopPreview();
      host.innerHTML = `<p class="pet-empty">${label(account ? 'loading' : 'login')}</p><button type="button" data-pet-retry>${label('retry')}</button>`;
      return;
    }
    const key = JSON.stringify([state.items.map(item=>[item.id,item.owned]),state.gifts,tab === 'gifts' ? [giftDraft,giftPreview,giftError,giftErrorKey,giftBusy,giftPending,giftFileName] : null,tab,state.style,state.xp,state.stamps,state.earned,state.streak,state.enabled,state.equipped,state.berry_today,state.day,purchaseIntent,busy,outfitPending,feedback && Date.now()<feedback.until ? feedback.copy : '',tab === 'today' ? state.today : tab === 'history' ? [state.history,state.purchases] : null]);
    if (key === renderKey) return;
    renderKey = key;
    const focus = document.activeElement;
    const giftSelection = focus?.matches('[data-pet-gift-code],[data-pet-claim-code]') ? [focus.selectionStart,focus.selectionEnd] : null;
    const identityOpen = host.querySelector('.pet-gift-identity')?.open;
    const focusKey = focus?.closest('.pet-journal') ? Object.entries(focus.dataset).find(([key])=>['petLifeAction','petLifeChatter','petTab','petBuy','petItemAction','petEquip','petSlot','petStyle','petGiftCode','petGiftPreview','petGiftClaim','petGiftWear','petGiftCopy','petGiftReconcile','petGiftOutfits','petClaimCode','petPreviewSelect','petPreviewPlay','petPreviewClose','petPreviewStage','petTryAction','petShopFilter','petTryStage','petCollection'].includes(key)) : null;
    const scroll = host.scrollTop;
    // Progress, receipts and tab updates must not replace the live animation rig.
    const portrait = host.querySelector('.pet-hero-portrait');
    const next = state.next_stage_xp;
    const progress = next ? (state.xp-state.stage_floor)/(next-state.stage_floor)*100 : 100;
    window.mailaiCompanionMotion?.stopPreview();
    host.innerHTML = `${purchaseIntent ? `<div class="pet-pending" role="status"><span>${label('purchasePending',t(`item.${purchaseIntent.item}`))}</span><button type="button" data-pet-reconcile ${busy ? 'disabled' : ''}>${label('reconcile')}</button></div>` : ''}${feedback && Date.now()<feedback.until ? `<p class="pet-milestone" role="status">${esc(feedback.copy)}</p>` : ''}<section class="pet-hero">${avatar('pet-hero-portrait')}<div class="pet-hero-copy"><span class="pet-eyebrow">${label('heroEyebrow')}</span><h3>${esc(stageName(state.stage))} <small>${label('level',state.stage)}</small></h3><p>${stageHint(state.stage)}</p><div class="pet-growth-label"><b>${label('growth')} ${state.xp.toLocaleString()}</b><span>${next ? label('next',next-state.xp) : label('maxStage')}</span></div><progress max="100" value="${progress}" aria-label="${label('growth')}"></progress></div></section>
    ${window.mailaiCompanionLife?.controls() || ''}
    <div class="pet-style-choice"><span>${label('styleChoice')}</span>${['nature','ranger'].map(style=>`<button type="button" data-pet-style="${style}" aria-pressed="${state.style === style}" ${state.style === style || busy ? 'disabled' : ''}><b>${label(`style.${style}`)}</b><em>${label(`life.${style}Intro`)}</em></button>`).join('')}<small>${label('styleFree')}</small></div>
    <div class="pet-stats"><article><strong>${state.stamps.toLocaleString()}</strong><span>${label('stamps')}</span></article><article><strong>${state.streak}<small>${label('days')}</small></strong><span>${label('streak')}</span></article><article><strong>${state.earned.toLocaleString()}</strong><span>${label('earned')}</span></article></div>
    ${!state.enabled ? `<p class="pet-paused">${label('paused')}</p>` : ''}<nav class="pet-tabs" aria-label="${label('tabs')}">${['today','journey','shop','gifts','history'].map(name=>`<button type="button" data-pet-tab="${name}" aria-pressed="${tab === name}" aria-label="${label(name)}"><span class="pet-tab-label">${label(name)}</span><span class="pet-tab-short" aria-hidden="true">${label(`tab.${name}`)}</span></button>`).join('')}</nav><section class="pet-tab-content">${({today:todayView,journey:journeyView,shop:shopView,gifts:giftsView,history:historyView})[tab]()}</section>`;
    if (portrait?.querySelector('.mail-companion')) host.querySelector('.pet-hero-portrait')?.replaceWith(portrait);
    const accountNote = document.createElement('div');
    accountNote.className = 'pet-client-note';
    accountNote.innerHTML = `<span>${label('clientOwner')}</span><small>${label('clientStorage')}</small>`;
    host.prepend(accountNote);
    watchRewardMotion();
    window.mailaiCompanionMotion?.scan();
    if (identityOpen) { const identity = host.querySelector('.pet-gift-identity'); if (identity) identity.open = true; }
    host.scrollTop = scroll;
    if (focusKey && focus?.isConnected === false) {
      const [key,value] = focusKey;
      const attr = key.replace(/[A-Z]/g,char=>'-'+char.toLowerCase());
      const replacement = host.querySelector(`[data-${attr}="${CSS.escape(value)}"]`);
      if (giftSelection && replacement && !replacement.disabled) {
        replacement.closest('details').open = true;
        replacement.setSelectionRange(...giftSelection);
      }
      replacement?.focus({preventScroll:true});
    }
  }

  const activity = () => {
    const now = performance.now(), wasIdle = now-lastInput >= 90000;
    lastInput = now;
    if (wasIdle) {
      lastSample = now; // Never count the quiet interval as reading time.
      window.mailaiEnergy.reschedule('companion-growth', 10000);
    }
  };
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
    // Keep accurate reading/activity batches while in use. Once idle, only
    // check for server-side rewards once a minute; input restores the cadence.
    window.mailaiEnergy.reschedule('companion-growth',
      !state || (state.enabled && now-lastInput < 90000) || pending ? 10000 : 60000);
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
  motionPreference.addEventListener('change', updatePreviewMotion);
  document.addEventListener('mailai:assistant-portrait',watchRewardMotion);
  new MutationObserver(updatePreviewMotion).observe(document.body,{attributes:true,attributeFilter:['class']});
  watchRewardMotion();
  checkAccount();
})();
