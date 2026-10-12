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
  // Mirrored local rigs keep the shoulder fixed while distal feathers and panels lag.
  const featherWing = side => `<g transform="${side === 'right' ? 'translate(112 0) scale(-1 1)' : ''}"><g class="pet-reward-motion pet-wing-${side}">
    <path d="M33 61C24 47 15 39 9 43C4 48 8 67 18 74L34 77Z" fill="#C5DAE7" stroke="#7CA5BD" stroke-width="1"/>
    <g class="pet-reward-motion pet-feather-fan">
      <path d="M28 62C18 56 12 43 9 42C3 48 7 61 19 70Z" fill="#F7FBFD" stroke="#9BBECE" stroke-width=".65"/>
      <path d="M29 65C18 63 8 51 6 53C5 63 13 71 24 74Z" fill="#EAF3F8" stroke="#9BBECE" stroke-width=".65"/>
      <path d="M31 69C20 70 12 62 10 65C13 75 24 80 34 76Z" fill="#D9EAF3" stroke="#9BBECE" stroke-width=".65"/>
      <path d="M25 63 10 47M27 68 10 57M29 73 15 69" stroke="#B4CEDD" stroke-width=".7" stroke-linecap="round"/>
    </g>
    <path d="M32 59Q20 51 18 56Q21 67 33 71Z" fill="#F1F7FB" stroke="#8BAFC5" stroke-width=".7"/>
    <path d="M29 59 24 57" stroke="white" stroke-width="1.5" stroke-linecap="round" opacity=".8"/>
  </g></g>`;
  const mechWing = side => `<g transform="${side === 'right' ? 'translate(112 0) scale(-1 1)' : ''}"><g class="pet-reward-motion pet-mech-${side}">
    <path d="m32 62-12-15-5 5 8 21 10 4Z" fill="#28465C" stroke="#20394D" stroke-width="1"/>
    <g class="pet-reward-motion pet-mech-panel">
      <path d="m21 51-13-16-1 27 11 10 7-8Z" fill="#507A96" stroke="#28495F" stroke-width="1"/>
      <path d="m10 40 10 13-3 11-7-6Z" fill="#7097AD"/>
      <path d="m8 35 2 5 10 13 1-2Z" fill="#A5C6D6"/>
      <path d="m10 60 7 5 1 7-11-10Z" fill="#304F65"/>
      <path d="m11 45 7 10-2 7" stroke="#89E2E9" stroke-opacity=".25" stroke-width="2.5"/>
      <path class="pet-reward-motion pet-mech-charge" d="m11 45 7 10-2 7" pathLength="100" stroke="#B6F7FA" stroke-width="1.2" stroke-linecap="round"/>
      <circle class="pet-reward-motion pet-mech-led" cx="12" cy="58" r="1.2" fill="#BAF9F6"/>
    </g>
    <circle cx="24" cy="61" r="3.2" fill="#243F54" stroke="#89B7CC" stroke-width=".8"/><circle cx="24" cy="61" r="1.2" fill="#A7D8E3"/>
  </g></g>`;
  // Both halves share the same dash timeline. The rear half sits behind the body.
  const orbit = rear => `<g class="growth-orbit pet-orbit-${rear ? 'rear' : 'front'}"><g transform="rotate(-22 56 65)">
    <ellipse class="pet-orbit-track" cx="56" cy="65" rx="50" ry="20" stroke="#8BB6D2" stroke-width=".65" opacity=".4"/>
    <ellipse class="pet-reward-motion pet-orbit-stream pet-orbit-halo" cx="56" cy="65" rx="50" ry="20" pathLength="100" stroke="#93DDF3" stroke-width="5" stroke-opacity=".12"/>
    <ellipse class="pet-reward-motion pet-orbit-stream" cx="56" cy="65" rx="50" ry="20" pathLength="100" stroke="#B8E6F7" stroke-width="1.3"/>
    <ellipse class="pet-reward-motion pet-orbit-stream pet-orbit-satellite" cx="56" cy="65" rx="50" ry="20" pathLength="100" stroke="#FFF3CA" stroke-width="3"/>
  </g></g>`;
  const art = `<svg class="mail-companion" viewBox="0 0 112 112" fill="none" aria-hidden="true">
    <ellipse class="companion-shadow" cx="56" cy="102" rx="27" ry="4" fill="#254B3A" opacity=".12"/>
    ${orbit(true)}
    <g class="companion-figure">
      <path class="companion-foot-left" d="M37 88 34 98Q35 102 44 100L48 88" fill="#35745A"/>
      <path class="companion-foot-right" d="M64 89 67 99Q72 102 79 98L75 86" fill="#35745A"/>
      <path class="growth-cape" d="M29 64 20 96Q56 111 92 96L83 64Z" fill="#719EC0" stroke="#477A9E"/>
      <g class="companion-torso">
      <g class="growth-wings">${featherWing('left')}${featherWing('right')}</g>
      <g class="growth-mech-wings">${mechWing('left')}${mechWing('right')}</g>
      <path class="companion-arm-left" d="M26 62Q13 61 16 75Q20 79 29 71" fill="#91C9AC" stroke="#599C7B" stroke-width="1.3"/>
      <g class="companion-wave"><path d="M84 60Q99 54 99 64Q99 71 86 76" fill="#91C9AC" stroke="#599C7B" stroke-width="1.3"/></g>
      <path class="growth-body" d="M25 52C25 27 38 20 56 20S87 29 87 53L85 76Q83 95 57 96Q29 96 26 79Z" fill="#B5DDC5" stroke="#649F80" stroke-width="1.4"/>
      <path class="pet-reward-motion pet-palette-shine" d="M30 46Q31 26 53 25" stroke="#E8F5ED" stroke-width="4" stroke-linecap="round"/>
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
      <g class="growth-cap"><path d="M33 30Q33 12 56 13Q76 14 77 30Z" fill="#719EC0" stroke="#477A9E"/><path d="M29 30h53" stroke="#477A9E" stroke-width="4" stroke-linecap="round"/><path class="pet-reward-motion pet-cap-shine" d="m50 21 6 4 6-4" stroke="#FFF5D9" stroke-width="2"/></g>
      <g class="companion-gaze">
        <g class="companion-eyes"><rect x="43" y="48" width="5" height="9" rx="2.5" fill="#285640"/><rect x="65" y="48" width="5" height="9" rx="2.5" fill="#285640"/></g>
        <g class="companion-happy-eyes" stroke="#285640" stroke-width="2.7" stroke-linecap="round"><path d="M42 53q3-5 6 0M64 53q3-5 6 0"/></g>
        <path class="growth-ranger-brows" d="m41 43 9 3m12 0 9-3" stroke="#264C67" stroke-width="2.5" stroke-linecap="round"/>
        <path class="companion-smile" d="M53 60q3.5 3 7 0" stroke="#52836A" stroke-width="1.8" stroke-linecap="round"/>
        <ellipse cx="40" cy="60" rx="4" ry="2.2" fill="#E9B9A5" opacity=".55"/><ellipse cx="73" cy="60" rx="4" ry="2.2" fill="#E9B9A5" opacity=".55"/>
      </g>
      <g class="growth-visor"><path d="M36 46h41l-3 12H40Z" fill="#64D9E3" fill-opacity=".25" stroke="#285875" stroke-width="2"/><path class="pet-reward-motion pet-visor-scan" d="m40 48 4 8m0-8 4 8" stroke="#D0FAFF" stroke-width="1.3"/><path d="m42 47 8 0" stroke="#C1FAFF" stroke-opacity=".35" stroke-width=".7"/></g>
      </g>
      <path class="growth-ranger-collar" d="m31 72 7-5 7 7 11 5 11-5 7-7 7 5-7 7-7-1-11 6-11-6-7 1Z" fill="#446780" stroke="#264C67" stroke-width="1.2"/>
      <path class="growth-ranger-badge" d="m38 79 5 5-5 5-5-5Z" fill="#83D5E3" stroke="#417C9D"/>
      <g class="growth-jacket" fill="#41607B" stroke="#294459" stroke-width="1.4"><path d="m28 72 10-5 7 9 11 4 11-4 7-9 10 5-4 16-23 7-24-7Z"/><path class="pet-reward-motion pet-jacket-trace" d="m38 70 7 10 11 4 11-4 7-10" fill="none" stroke="#8FB7D0"/><path d="M56 84v10" stroke="#294459" stroke-width="2"/></g>
      <g class="growth-armor" fill="#587C93" stroke="#2C4E65" stroke-width="1.5"><path d="m26 72 10-5 8 5 12 4 12-4 8-5 10 5-6 12-9-4-3 12-12 6-12-6-3-12-9 4Z"/><path d="m45 80 11 4 11-4-3 11-8 3-8-3Z" fill="#304D67"/><g class="pet-reward-motion pet-armor-core"><circle cx="38" cy="83" r="5" fill="#9DE9EE" fill-opacity=".15" stroke="#80BACA" stroke-width=".6"/><path d="m36 79 6 0-4 4h3l-6 5 2-5h-3Z" fill="#B4F2F1" stroke="none"/><circle class="pet-reward-motion pet-core-ring" cx="38" cy="83" r="6" fill="none" stroke="#A8E5EC" stroke-width=".65" pathLength="100"/></g></g>
      <g class="growth-scarf" fill="#EDAE87" stroke="#C88360"><path d="M32 68q24 10 48 0l-1 8q-23 9-46 0Z"/><g class="pet-reward-motion pet-scarf-tail"><path d="m34 76 10 2-2 18-12-4Z"/><path d="m34 78 4 1-3 12-4-1Z" fill="#F6C3A0" stroke="none"/><g class="pet-reward-motion pet-scarf-tip"><path d="m31 88 12 4-1 5-12-4Z" fill="#D79571"/><path d="m32 91 7 2" stroke="#F7CFAD" stroke-width=".8"/></g></g></g>
      <path class="growth-medal" d="m39 77 2 4 4 .5-3 3 .5 4-3.5-2-3.5 2 .5-4-3-3 4-.5Z" fill="#F3CE72" stroke="#B99E65"/>
      <path d="M32 71 77 89" stroke="#528A6C" stroke-width="3"/>
      <g class="companion-bag"><g transform="rotate(12 65 82)"><rect x="51" y="73" width="30" height="20" rx="5" fill="#FFF5D9" stroke="#B99E65" stroke-width="1.3"/><path d="m54 77 12 8 12-8" stroke="#B99E65" stroke-width="1.5" stroke-linejoin="round"/><path class="pet-reward-motion pet-satchel-glint" d="m55 75 9 15m-5-15 9 15" stroke="#FFF9DE" stroke-width="1.2" stroke-linecap="round"/></g></g>
      </g>
    </g>
    <g class="growth-stars" fill="#E7BE64">
      <g class="pet-reward-motion pet-star"><circle cx="17" cy="33" r="6" fill="currentColor" opacity=".1"/><path d="m17 27 1.4 4.6L23 33l-4.6 1.4L17 39l-1.4-4.6L11 33l4.6-1.4Z"/><path class="pet-reward-motion pet-star-ray" d="M17 24v18M8 33h18" stroke="currentColor" stroke-width=".5"/><circle cx="17" cy="33" r=".9" fill="#FFFAE8"/></g>
      <g class="pet-reward-motion pet-star"><circle cx="96" cy="78" r="5" fill="currentColor" opacity=".1"/><path d="m96 73 1.2 3.8L101 78l-3.8 1.2L96 83l-1.2-3.8L91 78l3.8-1.2Z"/><circle cx="96" cy="78" r=".7" fill="#FFFAE8"/></g>
      <circle class="pet-reward-motion pet-star pet-stardust" cx="87" cy="12" r="1.3"/><circle class="pet-reward-motion pet-star pet-stardust" cx="15" cy="78" r="1"/>
      <path class="pet-reward-motion pet-star-trail" d="M70 20q12-7 25-9" pathLength="100" stroke="#F4D98C" stroke-width="1.1" stroke-linecap="round"/>
      <circle class="pet-reward-motion pet-star pet-stardust" cx="101" cy="49" r=".8"/><circle class="pet-reward-motion pet-star pet-stardust" cx="34" cy="9" r=".9"/>
    </g>
    ${orbit(false)}
    <g class="growth-berry pet-reward-motion pet-berry-float"><path d="M88 65q-8-9-10 0q-1 9 10 13q11-4 10-13q-2-9-10 0Z" fill="#E899A8" stroke="#B4687C"/><path d="M88 63q-4-8 3-9q4 6-3 9Z" fill="#5AA584"/><circle cx="84" cy="69" r="1" fill="#FFF5D9"/><circle cx="90" cy="72" r="1" fill="#FFF5D9"/></g>
    <g class="growth-lightning" fill="none" stroke="#76DDF2" stroke-linecap="round" stroke-linejoin="round">
      <g class="pet-reward-motion pet-bolt"><path d="m13 39-3 9 6 3-5 7 5 5" stroke-width="3" stroke-opacity=".16"/><path d="m13 39-3 9 6 3-5 7 5 5" pathLength="100" stroke="#C8F7FF" stroke-width="1.1"/><path class="pet-reward-motion pet-bolt-branch" d="m16 51 5 3-1 5" pathLength="100" stroke-width=".7"/></g>
      <g class="pet-reward-motion pet-bolt"><path d="m99 66-4 8 5 4-5 8 4 5" stroke-width="3" stroke-opacity=".16"/><path d="m99 66-4 8 5 4-5 8 4 5" pathLength="100" stroke="#C8F7FF" stroke-width="1.1"/><path class="pet-reward-motion pet-bolt-branch" d="m95 86-5 1-2 4" pathLength="100" stroke-width=".7"/></g>
      <path class="pet-reward-motion pet-energy-stream" d="M22 99q34 16 68 0" stroke="#83BCE5" stroke-width=".8" pathLength="100"/>
    </g>
    <g class="growth-aura" fill="none">
      <path class="pet-reward-motion pet-aurora-veil" d="M18 95Q27 58 35 87Q49 71 59 90Q74 60 83 90Q91 75 96 96Q57 104 18 95Z" fill="#83CBBB" opacity=".14"/>
      <path class="pet-reward-motion pet-aurora-ribbon" d="M24 95Q29 69 39 92Q55 79 66 94Q80 73 89 97" stroke="#C3B4E9" stroke-width="2.8" stroke-opacity=".18"/>
      <ellipse class="pet-reward-motion pet-aurora-ripple" cx="56" cy="99" rx="39" ry="7" stroke="#BAA9DF" stroke-width="1.1"/>
      <ellipse class="pet-reward-motion pet-aurora-ripple" cx="56" cy="99" rx="39" ry="7" stroke="#8FDAC5" stroke-width=".7"/>
      <ellipse class="pet-reward-motion pet-aurora-ripple" cx="56" cy="99" rx="39" ry="7" stroke="#C9E2F4" stroke-width=".5"/>
      <circle class="pet-reward-motion pet-aurora-mote" cx="28" cy="94" r=".8" fill="#B9E8D9"/><circle class="pet-reward-motion pet-aurora-mote" cx="85" cy="92" r=".6" fill="#D5C9EC"/>
    </g>
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
  let nativeHidden = false;
  const syncPaused = () => document.body.classList.toggle('companion-paused', document.hidden || nativeHidden);
  document.addEventListener('visibilitychange', syncPaused);
  document.addEventListener('mailai:foreground-changed', event => {
    nativeHidden = event.detail?.visible === false; syncPaused();
  });
  syncPaused();
  sync();
})();
