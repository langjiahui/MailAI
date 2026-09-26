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
      if (document.documentElement.classList.contains('macos-native-window')) {
        const reading = document.querySelector('.layout > .reading-pane')?.getBoundingClientRect();
        const list = document.querySelector('.layout > .list-pane')?.getBoundingClientRect();
        if (reading?.width) {
          startup.style.setProperty('--startup-center', `${(reading.left+reading.width/2-origin.left)/zoom}px`);
          startup.style.setProperty('--startup-reading-left', `${(reading.left-origin.left)/zoom}px`);
        }
        if (list?.width) startup.style.setProperty('--startup-list-right', `${(list.right-origin.left)/zoom}px`);
        const brand = document.querySelector('.topbar .brand strong')?.getBoundingClientRect();
        const signature = startup.querySelector('.preloader-brand');
        if (brand?.width && signature) Object.assign(signature.style, {
          left:`${(brand.left-origin.left)/zoom}px`, top:`${(brand.top-origin.top)/zoom}px`,
        });
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
      <g class="companion-torso">
      <path class="companion-arm-left" d="M26 62Q13 61 16 75Q20 79 29 71" fill="#91C9AC" stroke="#599C7B" stroke-width="1.3"/>
      <g class="companion-wave"><path d="M84 60Q99 54 99 64Q99 71 86 76" fill="#91C9AC" stroke="#599C7B" stroke-width="1.3"/></g>
      <path d="M25 52C25 27 38 20 56 20S87 29 87 53L85 76Q83 95 57 96Q29 96 26 79Z" fill="#B5DDC5" stroke="#649F80" stroke-width="1.4"/>
      <path d="M30 46Q31 26 53 25" stroke="#E8F5ED" stroke-width="4" stroke-linecap="round"/>
      <g class="companion-leaves">
      <path d="M48 22Q41 12 34 15Q33 25 48 27" fill="#398564"/>
      <path d="M48 23Q52 8 66 12Q64 24 48 27" fill="#5AA584"/>
      </g>
      <g class="companion-head">
      <rect x="33" y="35" width="47" height="39" rx="17" fill="#F6FBF6"/>
      <g class="companion-gaze">
        <g class="companion-eyes"><rect x="43" y="48" width="5" height="9" rx="2.5" fill="#285640"/><rect x="65" y="48" width="5" height="9" rx="2.5" fill="#285640"/></g>
        <g class="companion-happy-eyes" stroke="#285640" stroke-width="2.7" stroke-linecap="round"><path d="M42 53q3-5 6 0M64 53q3-5 6 0"/></g>
        <path class="companion-smile" d="M53 60q3.5 3 7 0" stroke="#52836A" stroke-width="1.8" stroke-linecap="round"/>
        <ellipse cx="40" cy="60" rx="4" ry="2.2" fill="#E9B9A5" opacity=".55"/><ellipse cx="73" cy="60" rx="4" ry="2.2" fill="#E9B9A5" opacity=".55"/>
      </g>
      </g>
      <path d="M32 71 77 89" stroke="#528A6C" stroke-width="3"/>
      <g class="companion-bag"><g transform="rotate(12 65 82)"><rect x="51" y="73" width="30" height="20" rx="5" fill="#FFF5D9" stroke="#B99E65" stroke-width="1.3"/><path d="m54 77 12 8 12-8" stroke="#B99E65" stroke-width="1.5" stroke-linejoin="round"/></g></g>
      </g>
    </g>
    <g class="companion-thinking" fill="#5B9477"><circle cx="85" cy="23" r="2"/><circle cx="92" cy="17" r="2.7"/><circle cx="101" cy="14" r="3.3"/></g>
    <g class="companion-alert"><circle cx="92" cy="32" r="8" fill="currentColor"/><path d="M92 28v4M92 35h.01" stroke="white" stroke-width="2" stroke-linecap="round"/></g>
  </svg>`;
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
  const caption = document.getElementById('companion-caption');
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
    const label = root.classList.contains('companion-finished') ? '整理好了，来看看' : {
      calm:'小邮在这里', thinking:'正在帮你整理', warn:'有邮件需要留意', danger:'有高风险邮件待核实',
    }[state];
    caption.textContent = label;
    orb.setAttribute('aria-label', `${label}，打开 MailAI 邮件助手`);
    orb.setAttribute('aria-expanded', String(document.body.classList.contains('assistant-visible')));
  };
  new MutationObserver(sync).observe(root, {attributes:true, attributeFilter:['class']});
  new MutationObserver(sync).observe(document.body, {attributes:true, attributeFilter:['class']});
  document.addEventListener('visibilitychange', () => document.body.classList.toggle('companion-paused', document.hidden));
  sync();
})();
