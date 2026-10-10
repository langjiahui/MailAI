/* One vector character shared by the launcher, chat and writing assistant. */
(() => {
  // Borrow real pane geometry, never mailbox content. Saved pane widths,
  // font zoom and narrow layouts therefore share exactly the same silhouette.
  const startup = document.getElementById('app-preloader');
  if (startup) {
    const frames = [...startup.querySelectorAll('[data-startup-pane]')];
    frames.forEach(frame => {
      const count = frame.dataset.startupPane === 'reading-pane' ? 3 : 5;
      for (let index = 0; index < count; index++) {
        const row = document.createElement('span');
        row.className = 'preloader-skeleton-row';
        row.innerHTML = '<i></i><b></b><em></em>';
        frame.appendChild(row);
      }
    });
    const alignFrames = () => {
      const zoom = Number(getComputedStyle(document.body).zoom) || 1;
      const origin = startup.getBoundingClientRect();
      if (document.documentElement.matches('.desktop-native-window,.integrated-workspace')) {
        const sidebar = document.querySelector('.layout > .sidebar');
        const sidebarRect = sidebar?.getBoundingClientRect();
        const railRight = sidebarRect?.width && getComputedStyle(sidebar).position !== 'fixed'
          ? Math.max(0, (sidebarRect.right-origin.left)/zoom) : 0;
        startup.style.setProperty('--startup-rail-right', `${railRight}px`);
        const header = document.querySelector('.topbar')?.getBoundingClientRect();
        if (header?.height) startup.style.setProperty('--startup-header-height', `${header.height/zoom}px`);
        const reading = document.querySelector('.layout > .reading-pane')?.getBoundingClientRect();
        const list = document.querySelector('.layout > .list-pane')?.getBoundingClientRect();
        if (reading?.width && reading.left >= 0 && reading.left < innerWidth && reading.right <= innerWidth+1) {
          startup.style.setProperty('--startup-center', `${(reading.left+reading.width/2-origin.left)/zoom}px`);
          startup.style.setProperty('--startup-reading-left', `${(reading.left-origin.left)/zoom}px`);
        } else {
          startup.style.setProperty('--startup-center', '50%');
          startup.style.setProperty('--startup-reading-left', '0px');
        }
        if (list?.width) startup.style.setProperty('--startup-list-right', `${(list.right-origin.left)/zoom}px`);
        const brand = document.querySelector('.topbar .brand strong')?.getBoundingClientRect();
        const signature = startup.querySelector('.preloader-brand');
        const signatureText = signature?.querySelector('strong')?.getBoundingClientRect();
        if (brand?.width && signatureText?.width) {
          const signatureRect = signature.getBoundingClientRect();
          Object.assign(signature.style, {
            left:`${(signatureRect.left-origin.left+brand.left-signatureText.left)/zoom}px`,
            top:`${(signatureRect.top-origin.top+brand.top-signatureText.top)/zoom}px`,
          });
        }
      }
      frames.forEach(frame => {
        const pane = document.querySelector(`.layout > .${frame.dataset.startupPane}`);
        const rect = pane?.getBoundingClientRect();
        frame.hidden = !rect || !rect.width || !rect.height || rect.right <= 0 || rect.left >= innerWidth;
        if (frame.hidden) return;
        Object.assign(frame.style, {
          left:`${(rect.left-origin.left)/zoom}px`, top:`${(rect.top-origin.top)/zoom}px`,
          width:`${rect.width/zoom}px`, height:`${rect.height/zoom}px`,
          borderRadius:getComputedStyle(pane).borderRadius,
        });
      });
    };
    // Responsive panes can slide without changing their measured size. Track
    // the short layout transition too, then stop sampling once it settles.
    let frameRequest = 0, followUntil = 0;
    const followLayout = () => {
      alignFrames();
      frameRequest = performance.now() < followUntil ? requestAnimationFrame(followLayout) : 0;
    };
    const scheduleAlignment = () => {
      followUntil = performance.now() + 500;
      if (!frameRequest) frameRequest = requestAnimationFrame(followLayout);
    };
    const geometry = new ResizeObserver(scheduleAlignment);
    document.querySelectorAll('.layout,.layout > .sidebar,.layout > .list-pane,.layout > .reading-pane,.topbar').forEach(el => geometry.observe(el));
    window.addEventListener('resize', scheduleAlignment);
    const cleanup = new MutationObserver(() => {
      if (startup.isConnected) return;
      geometry.disconnect();
      window.removeEventListener('resize', scheduleAlignment);
      cancelAnimationFrame(frameRequest);
      cleanup.disconnect();
    });
    cleanup.observe(startup.parentNode, {childList:true});
    alignFrames();
  }
  const art = `<svg class="mail-companion" viewBox="0 0 112 112" fill="none" aria-hidden="true">
    <ellipse class="companion-shadow" cx="56" cy="102" rx="27" ry="4" fill="#254B3A" opacity=".12"/>
    <g class="companion-figure">
      <path class="companion-foot-left" d="M37 88 34 98Q35 102 44 100L48 88" fill="#35745A"/>
      <path class="companion-foot-right" d="M64 89 67 99Q72 102 79 98L75 86" fill="#35745A"/>
      <g class="growth-wings" fill="#DAEEF7" stroke="#85B5C6" stroke-width="1.3"><path d="M31 58Q5 32 9 61Q11 78 34 77ZM81 58Q107 32 103 61Q101 78 78 77Z"/></g>
      <g class="growth-mech-wings" fill="#48718F" stroke="#243F55" stroke-width="1.5"><path d="m28 54-20-20 5 38 19 8 2-10ZM84 54l20-20-5 38-19 8-2-10Z"/><path d="m12 42 12 22M100 42 88 64" stroke="#8AE4E8" stroke-width="2"/></g>
      <path class="growth-cape" d="M29 64 20 96Q56 111 92 96L83 64Z" fill="#719EC0" stroke="#477A9E"/>
      <g class="companion-torso">
      <path class="companion-arm-left" d="M26 62Q13 61 16 75Q20 79 29 71" fill="#91C9AC" stroke="#599C7B" stroke-width="1.3"/>
      <g class="companion-wave"><path d="M84 60Q99 54 99 64Q99 71 86 76" fill="#91C9AC" stroke="#599C7B" stroke-width="1.3"/></g>
      <path class="growth-body" d="M25 52C25 27 38 20 56 20S87 29 87 53L85 76Q83 95 57 96Q29 96 26 79Z" fill="#B5DDC5" stroke="#649F80" stroke-width="1.4"/>
      <path d="M30 46Q31 26 53 25" stroke="#E8F5ED" stroke-width="4" stroke-linecap="round"/>
      <g class="companion-leaves">
      <path d="M48 22Q41 12 34 15Q33 25 48 27" fill="#398564"/>
      <path d="M48 23Q52 8 66 12Q64 24 48 27" fill="#5AA584"/>
      </g>
      <g class="growth-leaf" fill="#65AD89"><path d="M60 21Q69 10 78 18Q77 28 62 26Z"/></g>
      <g class="growth-flower"><path d="M55 19v-7" stroke="#599C7B" stroke-width="2"/><g fill="#EDAFBD"><circle cx="55" cy="9" r="4"/><circle cx="51" cy="12" r="4"/><circle cx="59" cy="12" r="4"/></g><circle cx="55" cy="12" r="2.6" fill="#F9D889"/></g>
      <g class="companion-head">
      <rect x="33" y="35" width="47" height="39" rx="17" fill="#F6FBF6"/>
      <g class="growth-ranger-hair" stroke-linejoin="round">
        <path class="ranger-hair-crown" d="M31 36Q28 29 38 25l-1-6 11 3 13-9 1 7 12-2-2 7q12 3 9 13L70 35 42 35Z"/>
        <path class="ranger-hair-fringe" d="M31 34q10-8 23-5 14-6 26 3l-2 13-4-8q-8-4-14-1l-8 5-3-5-7 4-5-4-2 10-4-4Z"/>
        <path class="ranger-hair-shine" d="m40 28 8 1 10-6m1 7q7-3 13 0" fill="none" stroke-width="1.8" stroke-linecap="round"/>
      </g>
      <g class="growth-ranger-crest" fill="#446780" stroke="#264C67" stroke-width="1.2"><path d="M30 36h4v13h-4q-4-6 0-13ZM79 36h4q4 7 0 13h-4Z"/><path d="M30 40v5M83 40v5" stroke="#8AE4E8" stroke-width="2" stroke-linecap="round"/><path d="m69 29 6 2-2 6-5-3Z" fill="#83D5E3"/></g>
      <g class="growth-cap"><path d="M33 30Q33 12 56 13Q76 14 77 30Z" fill="#719EC0" stroke="#477A9E"/><path d="M29 30h53" stroke="#477A9E" stroke-width="4" stroke-linecap="round"/><path d="m50 21 6 4 6-4" stroke="#FFF5D9" stroke-width="2"/></g>
      <g class="companion-gaze">
        <g class="companion-eyes"><rect x="43" y="48" width="5" height="9" rx="2.5" fill="#285640"/><rect x="65" y="48" width="5" height="9" rx="2.5" fill="#285640"/></g>
        <g class="companion-happy-eyes" stroke="#285640" stroke-width="2.7" stroke-linecap="round"><path d="M42 53q3-5 6 0M64 53q3-5 6 0"/></g>
        <path class="growth-ranger-brows" d="m41 43 9 3m12 0 9-3" stroke="#264C67" stroke-width="2.5" stroke-linecap="round"/>
        <path class="companion-smile" d="M53 60q3.5 3 7 0" stroke="#52836A" stroke-width="1.8" stroke-linecap="round"/>
        <ellipse cx="40" cy="60" rx="4" ry="2.2" fill="#E9B9A5" opacity=".55"/><ellipse cx="73" cy="60" rx="4" ry="2.2" fill="#E9B9A5" opacity=".55"/>
      </g>
      </g>
      <g class="growth-visor"><path d="M36 46h41l-3 12H40Z" fill="#64D9E3" fill-opacity=".25" stroke="#285875" stroke-width="2"/><path d="m39 49 34 0" stroke="#A2FFFF" stroke-width="1.5"/></g>
      <path class="growth-ranger-collar" d="m31 72 7-5 7 7 11 5 11-5 7-7 7 5-7 7-7-1-11 6-11-6-7 1Z" fill="#446780" stroke="#264C67" stroke-width="1.2"/>
      <path class="growth-ranger-badge" d="m38 79 5 5-5 5-5-5Z" fill="#83D5E3" stroke="#417C9D"/>
      <g class="growth-jacket" fill="#41607B" stroke="#294459" stroke-width="1.4"><path d="m28 72 10-5 7 9 11 4 11-4 7-9 10 5-4 16-23 7-24-7Z"/><path d="m38 70 7 10 11 4 11-4 7-10" fill="none" stroke="#8FB7D0"/><path d="M56 84v10" stroke="#294459" stroke-width="2"/></g>
      <g class="growth-armor" fill="#587C93" stroke="#2C4E65" stroke-width="1.5"><path d="m26 72 10-5 8 5 12 4 12-4 8-5 10 5-6 12-9-4-3 12-12 6-12-6-3-12-9 4Z"/><path d="m45 80 11 4 11-4-3 11-8 3-8-3Z" fill="#304D67"/><path d="m53 81 7 0-5 6h5l-8 6 3-6h-5Z" fill="#91EAF0" stroke="none"/></g>
      <g class="growth-scarf" fill="#EDAE87" stroke="#C88360"><path d="M32 68q24 10 48 0l-1 8q-23 9-46 0Z"/><path d="m65 76 10 2-2 15-10-5Z"/></g>
      <path class="growth-medal" d="m39 77 2 4 4 .5-3 3 .5 4-3.5-2-3.5 2 .5-4-3-3 4-.5Z" fill="#F3CE72" stroke="#B99E65"/>
      <path d="M32 71 77 89" stroke="#528A6C" stroke-width="3"/>
      <g class="companion-bag"><g transform="rotate(12 65 82)"><rect x="51" y="73" width="30" height="20" rx="5" fill="#FFF5D9" stroke="#B99E65" stroke-width="1.3"/><path d="m54 77 12 8 12-8" stroke="#B99E65" stroke-width="1.5" stroke-linejoin="round"/></g></g>
      </g>
    </g>
    <g class="growth-stars" fill="#E7BE64"><path d="m18 27 2 5 5 2-5 2-2 5-2-5-5-2 5-2ZM96 72l2 4 4 2-4 2-2 4-2-4-4-2 4-2Z"/><circle cx="87" cy="12" r="2"/><circle cx="15" cy="78" r="2"/></g>
    <g class="growth-orbit" stroke="#9BBCDC" opacity=".65"><ellipse cx="56" cy="65" rx="50" ry="20" transform="rotate(-22 56 65)"/><circle cx="9" cy="77" r="3" fill="#E7BE64"/></g>
    <g class="growth-berry"><path d="M88 65q-8-9-10 0q-1 9 10 13q11-4 10-13q-2-9-10 0Z" fill="#E899A8" stroke="#B4687C"/><path d="M88 63q-4-8 3-9q4 6-3 9Z" fill="#5AA584"/><circle cx="84" cy="69" r="1" fill="#FFF5D9"/><circle cx="90" cy="72" r="1" fill="#FFF5D9"/></g>
    <g class="growth-lightning" stroke="#63D6F4" stroke-width="2" stroke-linejoin="round"><path d="m11 51 7-11-2 11 7-1-8 12 2-11ZM92 80l7-11-2 11 7-1-8 12 2-11Z"/><path d="M25 100q31 12 62 0" stroke="#67A3E7"/></g>
    <g class="growth-aura"><ellipse cx="56" cy="99" rx="39" ry="8" stroke="#B5A3DB" stroke-width="2"/><ellipse cx="56" cy="99" rx="31" ry="5" stroke="#83CBBB"/></g>
    <g class="companion-thinking" fill="#5B9477"><circle cx="85" cy="23" r="2"/><circle cx="92" cy="17" r="2.7"/><circle cx="101" cy="14" r="3.3"/></g>
    <g class="companion-alert"><circle cx="92" cy="32" r="8" fill="currentColor"/><path d="M92 28v4M92 35h.01" stroke="white" stroke-width="2" stroke-linecap="round"/></g>
  </svg>`;
  window.mailaiCompanionArt = art;
  document.querySelectorAll('.companion-art, .assistant-mini').forEach(host => {
    host.classList.add('companion-avatar');
    host.innerHTML = art;
    if (host.classList.contains('preloader-companion')) {
      const torso = host.querySelector('.companion-torso');
      const arm = host.querySelector('.companion-wave');
      host.classList.add('introducing');
      torso.appendChild(arm);
      startup.dataset.introUntil = String(performance.now() + 1850);
      // Let the greeting arm stay in front until the character turns to walk.
      setTimeout(() => {
        if (!host.isConnected) return;
        host.classList.remove('introducing');
        torso.insertBefore(arm, torso.firstChild);
      }, 1500);
    }
  });
  const root = document.getElementById('mail-assistant');
  const orb = document.getElementById('assistant-orb');
  const caption = document.getElementById('companion-caption-copy');
  const toggle = document.getElementById('companion-motion');
  const key = 'mailai-companion-motion';
  try { toggle.checked = localStorage.getItem(key) !== 'off'; } catch (_) {}
  const applyMotion = () => document.body.classList.toggle('companion-still', !toggle.checked);
  applyMotion();
  toggle.addEventListener('change', () => {
    applyMotion();
    try { localStorage.setItem(key, toggle.checked ? 'on' : 'off'); } catch (_) {}
  });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const perch = document.getElementById('btn-compose-ai');
  const perchArt = perch?.querySelector('.compose-perch-art');
  if (perchArt) {
    // Crop the shared character at the waist; the paws sit over the window ledge.
    perchArt.innerHTML = art.replace('viewBox="0 0 112 112"', 'viewBox="15 6 82 70"') + '<i class="perch-paw perch-paw-left"></i><i class="perch-paw perch-paw-right"></i>';
    const resetLook = () => { perch.style.removeProperty('--look-x'); perch.style.removeProperty('--look-y'); };
    document.querySelector('.compose-card').addEventListener('pointermove', event => {
      if (!toggle.checked || reducedMotion.matches || event.pointerType === 'touch') return resetLook();
      const bounds = perch.getBoundingClientRect();
      perch.style.setProperty('--look-x', `${Math.max(-3, Math.min(3, (event.clientX - bounds.left - 35) / 55))}px`);
      perch.style.setProperty('--look-y', `${Math.max(-2, Math.min(2, (event.clientY - bounds.top - 20) / 65))}px`);
    });
    document.querySelector('.compose-card').addEventListener('pointerleave', resetLook);
    toggle.addEventListener('change', resetLook);
    reducedMotion.addEventListener('change', resetLook);
  }
  orb.addEventListener('pointermove', event => {
    if (!toggle.checked || reducedMotion.matches || event.pointerType === 'touch') return;
    const bounds = orb.getBoundingClientRect();
    orb.style.setProperty('--look-x', `${Math.max(-2, Math.min(2, (event.clientX - bounds.left - bounds.width / 2) / 12))}px`);
    orb.style.setProperty('--look-y', `${Math.max(-1.5, Math.min(1.5, (event.clientY - bounds.top - bounds.height / 2) / 18))}px`);
  });
  orb.addEventListener('pointerleave', () => { orb.style.removeProperty('--look-x'); orb.style.removeProperty('--look-y'); });
  let previous = '', successTimer;
  const sync = () => {
    const state = ['thinking', 'danger', 'warn'].find(value => root.classList.contains(`state-${value}`)) || 'calm';
    if (state !== previous) {
      clearTimeout(successTimer);
      root.classList.remove('companion-finished');
      if (previous === 'thinking' && state === 'calm' && root.dataset.answerComplete === 'true') {
        root.classList.add('companion-finished');
        successTimer = setTimeout(() => { root.classList.remove('companion-finished'); sync(); }, 3000);
      }
      previous = state;
    }
    const label = root.classList.contains('companion-finished') ? mailaiText('整理好了，来看看') : {
      get calm() { return mailaiText('小邮在这里'); }, get thinking() { return mailaiText('正在帮你整理'); }, get warn() { return mailaiText('有邮件需要留意'); }, get danger() { return mailaiText('有高风险邮件待核实'); },
    }[state];
    mailaiBindUI(caption, 'textContent', () => label);
    mailaiBindUI(orb, "@aria-label", () => (mailaiTemplate`${label}，打开 MailAI 邮件助手`));
    orb.setAttribute('aria-expanded', String(document.body.classList.contains('assistant-visible')));
  };
  new MutationObserver(sync).observe(root, {attributes:true, attributeFilter:['class']});
  new MutationObserver(sync).observe(document.body, {attributes:true, attributeFilter:['class']});
  document.addEventListener('mailai:language-changed', sync);
  document.addEventListener('visibilitychange', () => document.body.classList.toggle('companion-paused', document.hidden));
  sync();
})();
