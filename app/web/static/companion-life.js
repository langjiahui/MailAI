/* Local personality: bounded reactions and opt-in, disposable audio. No polling. */
(() => {
  const t = key => mailaiT(`pet.life.${key}`) || MAILAI_UI_COPY[`pet.life.${key}`]?.[0] || '';
  const ranger = () => document.body.dataset.petStyle === 'ranger';
  const stored = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; } };
  const soundKey = 'mailai-companion-sound', chatterKey = 'mailai-companion-chatter';
  let sound = stored(soundKey,'off') === 'on', chatter = stored(chatterKey,'on') !== 'off';
  let bubbleTimer = 0, lastSpoken = -Infinity, lastSound = -Infinity, audio = null, audioTimer = 0;
  let line = '', idleLine = 0, lastInteraction = -Infinity;
  let reactionEpoch = 0;
  const orb = document.getElementById('assistant-orb');
  const root = document.getElementById('mail-assistant');
  const bubble = document.createElement('span');
  bubble.className = 'companion-life-bubble'; bubble.hidden = true;
  // The launcher's accessible name already describes its function. Ambient
  // copy is decorative; deliberate interactions use the journal's live status.
  bubble.setAttribute('aria-hidden','true'); orb.append(bubble);
  const foreground = () => !document.hidden && !document.body.classList.contains('companion-paused');
  const dismiss = () => { clearTimeout(bubbleTimer); bubbleTimer=0; bubble.hidden=true; };
  const silence = () => {
    clearTimeout(audioTimer); audioTimer=0;
    const previous=audio; audio=null;
    if(previous && previous.state!=='closed') void previous.close().catch(()=>{});
  };
  function say(key, deliberate=false) {
    if(!foreground()) return;
    const status=document.querySelector('#companion-growth-dialog[open] [data-pet-life-status]');
    if(deliberate && status) { status.textContent=t(key); return; }
    if(!chatter || document.querySelector('dialog[open],.assistant-nudge:not(.hidden),#companion-update:not([hidden])') || document.body.classList.contains('assistant-visible') ||
       root.matches('.state-thinking,.state-warn,.state-danger') || document.body.classList.contains('companion-working') ||
       getComputedStyle(orb).visibility==='hidden' || !orb.getClientRects().length || performance.now()-lastSpoken<90000) return;
    line=key;lastSpoken=performance.now();bubble.textContent=t(key);bubble.hidden=false;
    clearTimeout(bubbleTimer);bubbleTimer=setTimeout(dismiss,4800);
  }
  async function chime(kind='hello', deliberate=false) {
    if(!sound || !foreground() || audio || (!deliberate && performance.now()-lastSound<15000)) return false;
    const Audio=window.AudioContext || window.webkitAudioContext;
    if(!Audio) return false;
    let context;
    try {
      context=new Audio();audio=context;lastSound=performance.now();
      // Closing even a suspended context bounds the device lifetime.
      audioTimer=setTimeout(silence,1300);
      await context.resume();
      if(audio!==context || !foreground() || !sound || context.state!=='running') return false;
      const notes=kind==='evolved' ? [523.25,659.25,783.99] : kind==='done' ? [659.25,783.99] : [523.25,659.25];
      notes.forEach((frequency,index)=>{
        const start=context.currentTime+index*.12, gain=context.createGain(), oscillator=context.createOscillator();
        oscillator.type=ranger() ? 'triangle' : 'sine';oscillator.frequency.value=frequency*(ranger() ? .75 : 1);
        gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(ranger() ? .025 : .035,start+.018);
        gain.gain.exponentialRampToValueAtTime(.0001,start+.19);
        oscillator.connect(gain);gain.connect(context.destination);oscillator.start(start);oscillator.stop(start+.21);
        oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
      });
      return true;
    } catch (_) { if(audio===context) silence(); return false; }
  }
  const motionAllowed = () => !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.body.classList.contains('companion-still');
  const afterLayout = callback => {
    const epoch=++reactionEpoch;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(epoch===reactionEpoch && foreground()) callback();
    }));
  };
  function controls() {
    return `<section class="pet-life" aria-label="${esc(t('title'))}"><div class="pet-life-heading"><b>${esc(t('title'))}</b><span>${esc(t('rhythm'))}</span></div><p class="pet-life-status" data-pet-life-status role="status" aria-live="polite">${esc(t('intro'))}</p><div class="pet-life-actions"><button type="button" data-pet-life-action="hello">${esc(t('hello'))}</button><button type="button" data-pet-life-action="signature">${esc(t('signature'))}</button><button type="button" data-pet-life-action="sound" aria-pressed="${sound}">${esc(t(sound?'soundOn':'soundOff'))}</button></div><label class="pet-life-preference"><input type="checkbox" data-pet-life-chatter ${chatter?'checked':''}>${esc(t('chatter'))}</label><small>${esc(t('energy'))}</small></section>`;
  }
  function syncControls() {
    const button=document.querySelector('[data-pet-life-action="sound"]');
    if(button) {button.textContent=t(sound?'soundOn':'soundOff');button.setAttribute('aria-pressed',String(sound));}
    const checkbox=document.querySelector('[data-pet-life-chatter]');if(checkbox)checkbox.checked=chatter;
  }
  function save(key,value) {
    try {localStorage.setItem(key,value?'on':'off');return true;}
    catch (_) {say('saveFailed',true);return false;}
  }
  document.addEventListener('click', event=>{
    const button=event.target.closest('[data-pet-life-action]');
    if(!button || !foreground()) return;
    const action=button.dataset.petLifeAction;
    if(action==='sound') {
      if(!save(soundKey,!sound)) return;
      sound=!sound;syncControls();
      say(sound?'soundEnabled':'soundDisabled',true);
      if(sound) void chime('hello',true).then(played=>{if(!played && sound && foreground()) say('soundUnavailable',true);});
      else silence();
      return;
    }
    if(performance.now()-lastInteraction<1800) return;
    lastInteraction=performance.now();
    const stage=Math.max(1,Math.min(7,Number(document.body.dataset.petStage)||1));
    if(!motionAllowed()) {say('still',true);return;}
    if(document.body.classList.contains('companion-working')) {say('busy',true);return;}
    const portrait=document.querySelector('.pet-hero-portrait');
    portrait?.scrollIntoView({block:'nearest',behavior:'instant'});
    // Let visibility observers see the newly revealed portrait before playing.
    // Audio is unlocked directly by the click, within the browser's gesture.
    void chime('hello',true);
    afterLayout(()=>{
      if(!portrait?.isConnected || !portrait.closest('dialog[open]')) return;
      window.mailaiCompanionMotion?.react(action==='signature'?'signature':'greet',portrait);
      say(action==='signature'?`${ranger()?'rangerStage':'stage'}${stage}`:ranger()?'rangerHelloReply':'helloReply',true);
    });
  });
  document.addEventListener('change',event=>{
    if(!event.target.matches('[data-pet-life-chatter]')) return;
    if(save(chatterKey,event.target.checked)) chatter=event.target.checked;
    syncControls();if(!chatter)dismiss();
  });
  // All automatic feedback comes from existing app state, never a new timer.
  document.addEventListener('mailai:companion-idle',event=>{
    if(event.detail?.svg.closest('#assistant-orb')) say(`${ranger()?'rangerIdle':'idle'}${idleLine++%3}`);
  });
  document.addEventListener('mailai:companion-milestone',event=>{
    dismiss();
    afterLayout(()=>window.mailaiCompanionMotion?.react(event.detail?.evolved?'signature':'happy'));
    say(event.detail?.evolved?'evolved':'goal',true);
    void chime(event.detail?.evolved?'evolved':'done');
  });
  let finished=false;
  new MutationObserver(()=>{
    const now=root.classList.contains('companion-finished');
    if(now && !finished) {say('done');void chime('done');}
    finished=now;
    if(document.body.classList.contains('companion-working') || root.matches('.state-thinking,.state-warn,.state-danger')) dismiss();
  }).observe(root,{attributes:true,attributeFilter:['class']});
  const pause=()=>{if(!foreground()) {++reactionEpoch;dismiss();silence();}};
  new MutationObserver(()=>{
    pause();
    if(document.body.classList.contains('assistant-visible') || document.body.classList.contains('companion-working')) dismiss();
  }).observe(document.body,{attributes:true,attributeFilter:['class']});
  document.addEventListener('visibilitychange',pause);
  document.addEventListener('mailai:foreground-changed',pause);
  window.addEventListener('pagehide',()=>{dismiss();silence();});
  document.addEventListener('mailai:companion-journal',()=>{++reactionEpoch;dismiss();silence();});
  document.addEventListener('mailai:language-changed',()=>{syncControls();if(!bubble.hidden)bubble.textContent=t(line);});
  window.addEventListener('storage',event=>{
    if(event.key!==soundKey && event.key!==chatterKey && event.key!==null) return;
    sound=stored(soundKey,'off')==='on';chatter=stored(chatterKey,'on')!=='off';
    if(!sound)silence();if(!chatter)dismiss();syncControls();
  });
  window.mailaiCompanionLife={controls};
})();
