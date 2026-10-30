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
    <path d="M34 62C23 52 10 44 9 49c-2 12 11 24 27 26Z" fill="url(#pet-messenger-feather)"/>
    <g class="pet-reward-motion pet-feather-fan">
      <path d="M34 70C22 63 2 63-1 68c-3 9 18 15 37 8Z" fill="url(#pet-messenger-feather)"/>
      <path d="M33 66C20 55-9 45-10 52c-2 13 24 24 46 23Z" fill="url(#pet-messenger-feather)"/>
      <path d="M34 62C25 47-10 26-14 34c-5 13 24 35 48 37Z" fill="url(#pet-messenger-feather)"/>
      <path d="M30 64Q10 53 1 43" stroke="#FFFDF1" stroke-width="1.1" opacity=".7"/>
    </g>
    <path d="M32 62q-10-6-11-1 1 7 13 10Z" fill="var(--pet-body)"/><path d="M32 62q-10-6-11-1 1 7 13 10Z" fill="url(#pet-feather-light)"/>
  </g></g>`;
  const mechWing = side => `<g transform="${side === 'right' ? 'translate(112 0) scale(-1 1)' : ''}"><g transform="translate(0 -6)"><g class="pet-reward-motion pet-mech-${side}">
    <path d="M35 65Q26 60 20 65q-2 8 15 11Z" fill="var(--pet-star-navy,#40537D)" stroke="#D1B178" stroke-width=".6"/>
    <g class="pet-reward-motion pet-mech-panel">
      <g class="pet-reward-motion pet-mech-feather pet-mech-feather-lower">
        <path d="M30 69C17 65-1 58-5 63c-5 8 12 19 35 15Z" fill="var(--pet-star-navy,#40537D)" stroke="#D1B178" stroke-width=".6"/>
        <path d="M8 70q8 5 18 5" fill="none" stroke="#EDF7FD" stroke-width="1" stroke-linecap="round"/>
      </g>
      <g class="pet-reward-motion pet-mech-feather pet-mech-feather-middle">
        <path d="M30 65C16 54-8 38-13 44c-7 10 17 30 43 32Z" fill="url(#pet-pearl)" stroke="#D1B178" stroke-width=".6"/>
        <path d="M2 60q10 4 24 11-16-1-24-11Z" fill="url(#pet-glass)" opacity=".65"/>
      </g>
      <g class="pet-reward-motion pet-mech-feather pet-mech-feather-upper">
        <path class="pet-star-feather" d="M31 65C19 49-5 20-13 24c-12 6 1 29 15 39 9 7 19 10 29 10Z" fill="var(--pet-star-navy,#40537D)" stroke="#D1B178" stroke-width=".7"/>
        <path d="M-13 24q-4 2-4 8l7 4 4-2Z" fill="#D1B178"/>
        <path d="M-5 45C4 47 17 56 27 67 13 64 1 56-5 45Z" fill="url(#pet-glass)" opacity=".75"/>
        <path d="M-5 44Q9 47 25 63" fill="none" stroke="#FFFCF0" stroke-width="1.1" stroke-linecap="round"/>
        <path class="pet-reward-motion pet-mech-charge" d="M1 50q12 6 23 16" pathLength="100" fill="none" stroke="#F0FBFF" stroke-width="1" stroke-linecap="round"/>
        <path d="M-7 43q-2 3 1 7" fill="none" stroke="#E5BD81" stroke-width="1.6" stroke-linecap="round"/>
      </g>
    </g>
    <g class="pet-star-fin companion-ranger-only"><path d="M32 69C14 68-13 50-16 31c-2-14 12 0 25 0 14 0 20 18 23 38Z" fill="#40537D" stroke="#D1B178" stroke-width=".8"/><path d="M28 66C13 59-1 48-10 35 4 42 18 39 28 66Z" fill="#94BDD9" opacity=".65"/><path d="m-9 37 10 9 9-1 8 12 11 9" fill="none" stroke="#E5D2A0" stroke-width=".7"/><path d="m1 43 .8 2.2L4 46l-2.2.8L1 49l-.8-2.2L-2 46l2.2-.8Z" fill="#FFE9B5"/></g>
    <path d="M32 64q-10-5-14 0 2 9 15 11Z" fill="url(#pet-pearl)" stroke="#B7CEDD" stroke-width=".45"/>
    <circle cx="27" cy="68" r="2.5" fill="#40537D" stroke="#D1B178" stroke-width=".85"/>
    <circle class="pet-reward-motion pet-mech-led" cx="27" cy="68" r="1.1" fill="#F2FCFF"/>
  </g></g></g>`;
  // Both halves share the same dash timeline. The rear half sits behind the body.
  const orbit = rear => `<g class="growth-orbit pet-orbit-${rear ? 'rear' : 'front'}"><g transform="rotate(-22 56 65)">
    <ellipse class="pet-orbit-track" cx="56" cy="65" rx="50" ry="20" stroke="#8BB6D2" stroke-width=".65" opacity=".4"/>
    <ellipse class="pet-reward-motion pet-orbit-stream pet-orbit-halo" cx="56" cy="65" rx="50" ry="20" pathLength="100" stroke="#93DDF3" stroke-width="5" stroke-opacity=".12"/>
    <ellipse class="pet-reward-motion pet-orbit-stream" cx="56" cy="65" rx="50" ry="20" pathLength="100" stroke="#A7D6ED" stroke-width="1.65"/>
    <ellipse class="pet-reward-motion pet-orbit-stream pet-orbit-satellite" cx="56" cy="65" rx="50" ry="20" pathLength="100" stroke="#F4D594" stroke-width="3.8"/>
  </g></g>`;
  // Shared, static paint servers: no textures, blur filters or render loop.
  const paints = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  paints.setAttribute('aria-hidden', 'true');
  paints.setAttribute('width', '0'); paints.setAttribute('height', '0');
  paints.id = 'companion-creature-paints';
  paints.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden';
  paints.innerHTML = `<defs>
    <radialGradient id="pet-ivory" cx="36%" cy="32%" r="74%"><stop stop-color="#FFFEFB"/><stop offset=".48" stop-color="#FFFCF5"/><stop offset=".76" stop-color="#EDF1EF"/><stop offset="1" stop-color="#BBD1E1"/></radialGradient>
    <linearGradient id="pet-coat" x1="0" y1="0" x2=".12" y2="1"><stop stop-color="#FFFEFB"/><stop offset=".45" stop-color="#FFFCF5"/><stop offset=".65" stop-color="#FFFCF5" stop-opacity=".98"/><stop offset=".83" stop-color="#F1F6F8" stop-opacity=".55"/><stop offset="1" stop-color="#EDF6FC" stop-opacity=".18"/></linearGradient>
    <radialGradient id="pet-volume" cx="37%" cy="30%" r="72%"><stop stop-color="#FFFFFF" stop-opacity=".3"/><stop offset=".45" stop-color="#FFFFFF" stop-opacity="0"/><stop offset=".72" stop-color="#96AABE" stop-opacity=".06"/><stop offset=".88" stop-color="#728DA7" stop-opacity=".14"/><stop offset="1" stop-color="#557D9C" stop-opacity=".26"/></radialGradient>
    <radialGradient id="pet-blue" cx="32%" cy="20%" r="85%"><stop stop-color="#D8EEFF"/><stop offset=".46" stop-color="#AED6FA"/><stop offset=".8" stop-color="#8AB8E4"/><stop offset="1" stop-color="#739BCB"/></radialGradient>
    <radialGradient id="pet-feather-light" cx="30%" cy="15%" r="88%"><stop stop-color="#FFFFFF" stop-opacity=".62"/><stop offset=".4" stop-color="#FFFFFF" stop-opacity=".08"/><stop offset=".7" stop-color="#5D91C0" stop-opacity=".12"/><stop offset="1" stop-color="#467BAB" stop-opacity=".34"/></radialGradient>
    <linearGradient id="pet-gold" x1="0" y1="1" x2=".7" y2="0"><stop stop-color="#9FCBF0"/><stop offset=".42" stop-color="#BDDFF4"/><stop offset=".78" stop-color="#FFF1CE"/><stop offset="1" stop-color="#F5D18D"/></linearGradient>
    <linearGradient id="pet-starlight" x1=".7" y1="1" x2=".1" y2="0"><stop stop-color="#E3F3FF"/><stop offset=".44" stop-color="#BBDDF9"/><stop offset=".8" stop-color="#ABC3F4"/><stop offset="1" stop-color="#AAA5E3"/></linearGradient>
    <radialGradient id="pet-peng-feather" cx="70%" cy="80%" r="87%"><stop stop-color="#FFFEF7"/><stop offset=".42" stop-color="#F6F6F5"/><stop offset=".68" stop-color="#C4DCF7"/><stop offset="1" stop-color="#B4ADEB"/></radialGradient>
    <radialGradient id="pet-glint"><stop stop-color="#FFFFFF" stop-opacity=".24"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
    <linearGradient id="pet-messenger-feather" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="#F8DCA3"/><stop offset=".22" stop-color="#FFF7DC"/><stop offset=".55" stop-color="#D6EBF8"/><stop offset="1" stop-color="#97BCDF"/></linearGradient><linearGradient id="pet-aurora-silk" x1="0" y1="0" x2="1" y2=".3"><stop stop-color="#8EDBC6"/><stop offset=".5" stop-color="#BDD6F5"/><stop offset="1" stop-color="#C8ADEB"/></linearGradient><radialGradient id="pet-berry-jam" cx="30%" cy="20%" r="90%"><stop stop-color="#FFD2D7"/><stop offset=".5" stop-color="#E7A1B0"/><stop offset="1" stop-color="#C97991"/></radialGradient><radialGradient id="pet-pearl" cx="30%" cy="20%" r="90%"><stop stop-color="#FFFEF6"/><stop offset=".48" stop-color="#E3EEF8"/><stop offset="1" stop-color="#9BBEDC"/></radialGradient>
    <linearGradient id="pet-metal" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="#EDF7FE"/><stop offset=".5" stop-color="#C4DCEE"/><stop offset="1" stop-color="#9EB6D4"/></linearGradient>
    <radialGradient id="pet-joint" cx="30%" cy="20%" r="80%"><stop stop-color="#A4C6DB"/><stop offset="1" stop-color="#6B8FAC"/></radialGradient>
    <linearGradient id="pet-glass" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#C2E7FA"/><stop offset=".55" stop-color="#99C3E5"/><stop offset="1" stop-color="#879FCB"/></linearGradient>
    <linearGradient id="pet-visor-lens" x1="0" y1="0" x2=".25" y2="1"><stop stop-color="#AFDDEE" stop-opacity=".26"/><stop offset=".5" stop-color="#D5F0F7" stop-opacity=".06"/><stop offset="1" stop-color="#99C6DC" stop-opacity=".2"/></linearGradient>
    <linearGradient id="pet-satchel" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="#FBE8BE"/><stop offset=".6" stop-color="#E7C994"/><stop offset="1" stop-color="#CEAE79"/></linearGradient>
    <linearGradient id="pet-peach" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFD3AC"/><stop offset="1" stop-color="#EC9D79"/></linearGradient>
    <linearGradient id="pet-eye" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#183F54"/><stop offset="1" stop-color="#346C80"/></linearGradient>
    <radialGradient id="pet-blush"><stop stop-color="#FFC7B6" stop-opacity=".8"/><stop offset=".65" stop-color="#FFD0BF" stop-opacity=".65"/><stop offset="1" stop-color="#FFD0BF" stop-opacity="0"/></radialGradient>
    <radialGradient id="pet-ground"><stop stop-color="#63869E"/><stop offset=".55" stop-color="#63869E" stop-opacity=".45"/><stop offset="1" stop-color="#63869E" stop-opacity="0"/></radialGradient>
    <linearGradient id="pet-letter" x1="0" y1="0" x2=".3" y2="1"><stop stop-color="#FFFCF0"/><stop offset="1" stop-color="#F3E7C9"/></linearGradient>
  </defs>`;
  document.body.appendChild(paints);
  const babyWing = `<path d="M25 59C17 60 10 72 12 79q2 4 6-1-1 7 5 3 8-5 9-15 0-8-7-7Z" fill="var(--pet-body)"/><path d="M25 59C17 60 10 72 12 79q2 4 6-1-1 7 5 3 8-5 9-15 0-8-7-7Z" fill="url(#pet-feather-light)"/>`;
  // Rounded, overlapping feathers stay readable at toolbar scale. The wing rig
  // sits behind the body, so the small front flipper can keep holding the letter.
  const naturalFlightWing = route => {
    const fill = route === 'nature' ? 'pet-blue' : 'pet-peng-feather';
    const feathers = ['M35 70C23 65 3 63 3 70c1 10 17 12 33 7Z', 'M35 65C20 58-5 49-4 58c2 13 20 20 40 17Z', 'M35 60C20 49-9 36-8 45c2 14 21 26 44 27Z', 'M36 58C26 44-3 24-7 30c-6 10 15 29 40 38Z'];
    return feathers.map(d=>`<path d="${d}" fill="url(#${fill})"/>${route === 'nature' ? `<path class="evolution-gold" d="${d}" fill="url(#pet-gold)"/>` : ''}<path d="${d}" fill="url(#pet-feather-light)" opacity=".35"/>`).join('');
  };
  // Fins grow from a soft paddle into a lateral feather fan, with a broad root
  // buried in the body. Each silhouette keeps the same shoulder/contact point.
  const fishFinSurface = (d,fill='var(--pet-body)') => `<path d="${d}" fill="${fill}"/><path d="${d}" fill="url(#pet-feather-light)"/>`;
  const fishFlipper = [
    ['baby','M31 63C25 60 17 66 16 73c-1 4 3 8 7 8 7 0 12-10 8-18Z'],
    ['growing','M31 63C25 60 20 63 17 67c-4 5-5 12 0 15 5 3 12-1 15-7 2-4 2-9-1-12Z'],
    ['flowing','M31 63C25 60 20 63 17 68c-4 6-6 13-2 17 5 5 13-1 17-8 3-5 3-10-1-14Z'],
    ['feather','M31 63C24 60 19 65 17 70c-3 5-6 13-3 16 2 2 4 0 6-2 0 4 3 4 6 1 6-5 11-16 5-22Z'],
  ].map(([phase,d])=>`<g class="evolution-flipper-${phase}">${fishFinSurface(d)}</g>`).join('');
  const fishFlightWing = `<g class="evolution-peng-bud">${fishFinSurface('M36 65C23 61 1 45-4 51c-5 9 11 23 28 25l13 0Z','url(#pet-peng-feather)')}${fishFinSurface('M36 72C23 68 5 61 4 68c-1 9 14 15 33 11Z','url(#pet-peng-feather)')}</g><g class="evolution-peng-fan">${[
    ['base','M36 70C24 68 10 64 9 70c-1 8 14 13 28 8Z'],
    ['middle','M36 65C22 60 3 50 0 56c-3 11 16 22 37 19Z'],
    ['outer','M36 61C24 53 2 33-5 39c-7 10 14 29 41 33Z'],
    ['tip','M36 59C24 47-2 25-10 31c-8 12 17 30 46 37Z'],
  ].map(([layer,d])=>`<g class="evolution-peng-${layer}">${fishFinSurface(d,'url(#pet-peng-feather)')}</g>`).join('')}</g>`;
  const creatureFlightWing = side => `<g class="companion-flight-${side}"><g transform="${side === 'right' ? 'translate(112 0) scale(-1 1)' : ''}"><g class="companion-nature-only"><g class="evolution-wing-grown">${naturalFlightWing('nature')}</g></g><g class="companion-ranger-only"><g class="evolution-peng-wing">${fishFlightWing}</g></g></g></g>`;
  const art = `<svg class="mail-companion" viewBox="0 0 112 112" fill="none" aria-hidden="true">
    <ellipse class="companion-shadow" cx="56" cy="102" rx="30" ry="4.5" fill="url(#pet-ground)" opacity=".16"/>
    ${orbit(true)}
    <g class="companion-figure">
      <g class="companion-facing">
      <g class="companion-foot-left companion-nature-only" fill="url(#pet-peach)"><ellipse cx="40" cy="98" rx="2.2" ry="3"/><ellipse cx="43.5" cy="98.5" rx="2.3" ry="3"/><ellipse cx="46.5" cy="98" rx="2" ry="2.6"/></g>
      <g class="companion-foot-right companion-nature-only" fill="url(#pet-peach)"><ellipse cx="66" cy="98" rx="2.1" ry="2.7"/><ellipse cx="69.5" cy="98.5" rx="2.3" ry="3"/><ellipse cx="73" cy="98" rx="2.1" ry="3"/></g>
      <g class="companion-torso">
        <g class="companion-dock-tail"><g class="companion-heading"><g class="companion-tail">
          <g class="companion-nature-only">
            <g class="evolution-tail-bud"><path d="M78 86q13-10 17-4 1 7-17 12Z" fill="var(--pet-body)"/><path d="M78 86q13-10 17-4 1 7-17 12Z" fill="url(#pet-feather-light)"/></g>
            <g class="evolution-tail-long"><path d="M75 91C90 96 101 94 109 88c10-8 11 0 4 6-11 7-26 6-38 1Z" fill="url(#pet-gold)"/><path d="M74 90C89 91 97 86 104 77c7-11 13-6 7 4-8 14-23 17-37 13Z" fill="url(#pet-gold)"/><path d="M75 90C86 86 90 77 94 69c5-10 11-7 8 3-5 16-17 23-27 22Z" fill="url(#pet-gold)"/></g>
            <path class="evolution-tail-curl" d="M78 93c20 2 29-7 30-17 1-9-5-12-7-8-2 4 4 6 4 2 3 6-5 8-7 2-3-9 7-14 13-7 10 14-5 35-33 30Z" fill="url(#pet-gold)"/>
          </g>
          <g class="companion-ranger-only"><g class="evolution-fish-tail">
            <g class="evolution-fish-young"><path d="M76 79C86 78 91 87 99 81c-5-4-5-13-1-14 4-1 6 6 5 10 5-7 11-8 11-4 0 7-6 12-12 11-5 10-15 13-26 8Z" fill="var(--pet-body)"/><path d="M76 79C86 78 91 87 99 81c-5-4-5-13-1-14 4-1 6 6 5 10 5-7 11-8 11-4 0 7-6 12-12 11-5 10-15 13-26 8Z" fill="url(#pet-feather-light)"/></g>
            <g class="evolution-fish-mature"><path d="M76 79C86 78 91 87 99 80c-6-6-5-16-1-17 6-1 8 9 6 14 7-9 16-12 16-6 0 10-8 16-16 14-6 11-17 13-28 7Z" fill="var(--pet-body)"/><path d="M76 79C86 78 91 87 99 80c-6-6-5-16-1-17 6-1 8 9 6 14 7-9 16-12 16-6 0 10-8 16-16 14-6 11-17 13-28 7Z" fill="url(#pet-feather-light)"/></g>
          </g></g>
<g class="growth-star-tail"><g class="companion-nature-only"><path d="M77 88C98 85 108 105 122 96l-6 9c-17 1-24-15-39-13Z M77 88c16 1 27-14 38-9l-1 6c-11-4-19 13-36 8Z" fill="#40537D" stroke="#D1B178" stroke-width=".6"/></g><g class="companion-ranger-only"><path d="M77 85c19 1 24-17 40-13l-5 16 10 12c-21 1-27-9-45-8Z" fill="#40537D" stroke="#D1B178" stroke-width=".7"/><path d="m87 88 25-12-8 12 12 8-29-5" fill="#A6C4E1" opacity=".65"/></g></g>
        </g>
        </g></g>
        ${creatureFlightWing('left')}${creatureFlightWing('right')}
        <g class="growth-wings">${featherWing('left')}${featherWing('right')}</g>
        <g class="growth-mech-wings">${mechWing('left')}${mechWing('right')}</g>
          <g class="growth-body">
            <g class="companion-nature-only">
              <path d="M16 65C16 42 33 25 55 25c25 0 41 17 41 40 0 22-17 33-41 33-25 0-39-12-39-33Z"/>
              <path class="companion-face" d="M16 65C16 42 33 25 55 25c25 0 41 17 41 40 0 22-17 33-41 33-25 0-39-12-39-33Z" fill="url(#pet-coat)"/>
              <path d="M16 65C16 42 33 25 55 25c25 0 41 17 41 40 0 22-17 33-41 33-25 0-39-12-39-33Z" fill="url(#pet-volume)"/>
            </g>
            <g class="companion-ranger-only evolution-fish-body">
              <path d="M18 65C18 42 34 27 54 27c23-1 37 17 37 39 0 19-10 31-35 31-25 0-39-10-38-32Z"/>
              <path d="M18 65C18 42 34 27 54 27c23-1 37 17 37 39 0 19-10 31-35 31-25 0-39-10-38-32Z" fill="url(#pet-feather-light)"/>
              <path class="ranger-face" d="M18 65C19 47 29 35 46 35c20-1 32 14 35 32 2 13-1 21-6 25-6 4-12 5-19 5-25 0-39-10-38-32Z" fill="url(#pet-ivory)"/>
            </g>
          </g>
          <ellipse class="pet-reward-motion pet-palette-shine" cx="46" cy="41" rx="19" ry="12" fill="url(#pet-glint)"/>
          <g class="companion-leaves companion-nature-only evolution-crest">
            <g class="evolution-crest-one"><path d="M58 25C60 18 66 12 72 13c5 2-5 11-14 12Z" fill="var(--pet-body)"/><path d="M58 25C60 18 66 12 72 13c5 2-5 11-14 12Z" fill="url(#pet-feather-light)"/></g>
            <path class="evolution-crest-two" d="M60 25C64 16 76 11 79 15c1 6-11 12-19 10Z" fill="url(#pet-gold)"/>
            <g class="evolution-crest-three"><path d="M61 26C70 21 80 15 84 20c3 6-10 12-23 6Z" fill="var(--pet-body)"/><path d="M61 26C70 21 80 15 84 20c3 6-10 12-23 6Z" fill="url(#pet-feather-light)"/></g>
          </g>
          <g class="companion-ranger-only evolution-fish-fin">${fishFinSurface('M62 31C64 27 69 23 72 25c2 2 0 5-1 8Z')}</g>
          <path class="companion-ranger-only evolution-star-mark" d="m55 32 1.2 3.5L60 37l-3.8 1.2L55 42l-1.2-3.8L50 37l3.8-1.5Z" fill="url(#pet-gold)"/>
          <g class="growth-cap"><path d="M31 32C29 24 39 18 52 19c14 0 24 6 23 13-10 5-33 7-44 0Z" fill="var(--pet-cloth)"/><path d="M31 32C29 24 39 18 52 19c14 0 24 6 23 13-10 5-33 7-44 0Z" fill="url(#pet-feather-light)"/><path d="M29 32q23 4 47-2 8 3 5 6-12 6-27 3-14-1-25-4Z" fill="var(--pet-cloth-edge)"/><path class="pet-reward-motion pet-cap-shine" d="M47 24h12v8H47Zm0 0 6 4 6-4" fill="#FFF2D5" stroke="#FFF9E9" stroke-width=".4" stroke-linejoin="round"/></g>
<g class="growth-star-crest"><path d="M28 35q27-13 56 0l-2 3q-27-11-52 0Z" fill="#40537D" stroke="#D1B178" stroke-width=".6"/><path d="m55 23 3 7 8 3-8 3-3 7-3-7-8-3 8-3Z" fill="#F1D7A3"/><path d="m55 27 1.8 4.2 4.2 1.8-4.2 1.8-1.8 4.2-1.8-4.2-4.2-1.8 4.2-1.8Z" fill="#7095C6"/><path class="pet-reward-motion pet-cap-shine" d="m55 28 0 10" stroke="#D9EAF7" stroke-width=".7"/></g>
        <g class="companion-look"><g class="companion-head">
          <g class="companion-gaze">
            <g class="companion-eyes" fill="url(#pet-eye)"><ellipse cx="43" cy="54" rx="3.4" ry="4.8"/><ellipse cx="67" cy="54" rx="3.4" ry="4.8"/><g fill="white"><circle cx="42" cy="52.3" r="1.1"/><circle cx="66" cy="52.3" r="1.1"/><circle cx="44.2" cy="56" r=".55" opacity=".35"/><circle cx="68.2" cy="56" r=".55" opacity=".35"/></g></g>
            <g class="companion-happy-eyes" stroke="#2B5365" stroke-width="1.8" stroke-linecap="round"><path d="M39 55q4-5 8 0m16 0q4-5 8 0"/></g>
            <g class="companion-smile"><g class="companion-nature-only"><path d="M50.5 59q4.5-4 9 0-1 6-4.5 6t-4.5-6Z" fill="url(#pet-peach)"/><path d="M51.5 59.5q3.5 2 7 0" stroke="#E19B75" stroke-width=".6"/></g><path class="companion-ranger-only" d="M50 60q5 4 10 0-1 5-5 5t-5-5Z" fill="#C46F58" stroke="none"/></g>
            <g class="companion-grin"><path d="M50 60q5 2 10 0-1 7-5 7t-5-7Z" fill="#B87766"/><path d="M52 64.5q3-2 6 0-3 4-6 0" fill="#F3B698"/><path class="companion-nature-only" d="M50 59q5-3 10 0-5 3-10 0Z" fill="url(#pet-peach)"/></g>
            <ellipse class="companion-cheek" cx="35" cy="63" rx="5" ry="3.5" fill="url(#pet-blush)"/><ellipse class="companion-cheek" cx="76" cy="63" rx="5" ry="3.5" fill="url(#pet-blush)"/>
          </g>
          <g class="growth-visor" stroke-linecap="round" stroke-linejoin="round">
            <path d="M24 50q4-2 9-1v6q-5 0-8 2Z M75 49q5-1 9 1l-1 7q-4-2-8-2Z" fill="var(--pet-cloth-edge)"/>
            <path d="M25 51q4-1 7-1M77 50l6 1" fill="none" stroke="#F9F6E9" stroke-width=".65" opacity=".8"/>
            <path d="M50 49q4-5 8 0" fill="none" stroke="#AABCC6" stroke-width="3"/>
            <path d="M50 48.7q4-4 8 0" fill="none" stroke="#F1DFB9" stroke-width="1.8"/>
            ${[0,24].map(x => `<g transform="translate(${x} 0)">
              <path d="M35 44q7-2 13 1 5 2 3 9-2 7-9 7t-10-7q-2-7 3-10Z" fill="url(#pet-visor-lens)" stroke="#8EAEBE" stroke-width="2.8"/>
              <path d="M35 44q7-2 13 1 5 2 3 9-2 7-9 7t-10-7q-2-7 3-10Z" fill="none" stroke="url(#pet-pearl)" stroke-width="1.9"/>
              <path d="M34 45q6-3 14 1" fill="none" stroke="#FFF7DF" stroke-width="1"/>
              <path d="M34 55q1 4 5 5" fill="none" stroke="#DFEFF5" stroke-width=".65"/>
              <path d="m35 48 1.6 3" fill="none" stroke="#FFFFFF" stroke-width="1.3" opacity=".6"/>
            </g>`).join('')}
            <path d="M30 49v5M78 49v5" fill="none" stroke="#D8B783" stroke-width="2"/>
            <circle cx="30" cy="50.5" r=".65" fill="#FFF7DF"/><circle cx="78" cy="50.5" r=".65" fill="#FFF7DF"/>
            <path class="pet-reward-motion pet-visor-scan" d="m36 46 2 4m22-4 2 4" fill="none" stroke="#FFFFFF" stroke-width="1.2"/>
          </g>
        </g>
        </g>
        <g class="growth-jacket"><path d="M28 69q7 3 13 1l8 8-3 17q-14 2-23-8 4-9 5-18Z M69 70q7 2 14-1 1 10 6 18-9 9-25 8l-2-17Z" fill="var(--pet-cloth)"/><path d="M28 69q7 3 13 1l8 8-3 17q-14 2-23-8 4-9 5-18Z M69 70q7 2 14-1 1 10 6 18-9 9-25 8l-2-17Z" fill="url(#pet-feather-light)"/><path class="pet-reward-motion pet-jacket-trace" d="m40 71 8 7-3 15m25-22-7 7 3 15" fill="none" stroke="#FFF2D5" stroke-width="1"/><path d="M47 77q8 3 16 0" stroke="#D5B984" stroke-width=".8"/><rect x="50" y="75" width="9" height="6" rx="1.8" fill="#FFF0CC" stroke="#D9BC88" stroke-width=".5"/><path d="m51 76 3.5 2.5L58 76" fill="none" stroke="#B79E73" stroke-width=".65"/></g>
        <g class="growth-armor">
          <path d="M38 72q17 6 34 0l-2 16q-4 8-15 9-12-2-16-10Z" fill="url(#pet-metal)" stroke="#B5CDDC" stroke-width=".5"/>
          <path d="M41 73q14 6 28 0l-3 14q-4 7-11 8-8-2-12-8Z" fill="url(#pet-pearl)"/>
          <path d="M31 67q8-3 15 5-5 7-16 7-4-5 1-12Z M68 72q7-8 15-5 5 7 1 12-11 0-16-7Z" fill="url(#pet-pearl)" stroke="#B3CBDD" stroke-width=".5"/>
          <path d="M31 73q6 3 12 0-3 7-11 8-3-3-1-8Z M71 73q6 3 12 0 2 5-1 8-8-1-11-8Z" fill="url(#pet-metal)"/>
          <path d="M32 68q5-1 10 3M72 71q5-4 10-3" fill="none" stroke="#FFFEF4" stroke-width="1.1" stroke-linecap="round"/>
          <path d="M43 74q6 5 12 7 7-2 13-7M46 89q4 5 9 6" fill="none" stroke="#DAC79F" stroke-width=".65" stroke-linecap="round"/>
          <path d="M44 80q4 3 9 4l-2 7q-6-3-7-11Z" fill="url(#pet-glass)" opacity=".65"/>
          <g class="pet-reward-motion pet-armor-core"><circle cx="39" cy="78" r="4" fill="url(#pet-glass)" stroke="#F6E8C7" stroke-width=".75"/><path d="m39 75 1 2 2 .9-2 .9-1 2-1-2-2-.9 2-.9Z" fill="#FFFDF3"/><circle class="pet-reward-motion pet-core-ring" cx="39" cy="78" r="4.8" fill="none" stroke="#D3E7EE" stroke-width=".5" pathLength="100"/></g>
        </g>
<g class="growth-postbag"><path d="M29 68q15 17 45 25" fill="none" stroke="#92714B" stroke-width="2.5"/><rect x="17" y="83" width="22" height="14" rx="3" fill="#A88258" stroke="#7D6247" stroke-width=".65"/><path d="M18 84h20v6q-11 6-20 0Z" fill="#C49C6B" stroke="#E2C794" stroke-width=".5"/><rect x="26" y="89" width="4" height="5" rx="1" fill="#EAD4A6"/><path d="m22 86 4 3 5-3" fill="none" stroke="#F3E5C8" stroke-width=".7"/></g>
        <g class="growth-scarf"><g class="pet-reward-motion pet-scarf-tail"><path d="M34 76q2 6-3 13 3 5 9 5 8-8 4-17Z" fill="#E9B895"/><g class="pet-reward-motion pet-scarf-tip"><path d="m32 88 10 3-2 5q-8-1-10-5Z" fill="#DCA686"/><path d="m33 91 5 2" stroke="#FCE3C4" stroke-width=".8"/></g></g><path d="M28 69q26 9 55 0l-1 7q-25 10-52 0Z" fill="url(#pet-peach)"/><path d="M30 70q25 8 51 0" stroke="#FFE4CC" stroke-width="1"/><path d="M32 74q19 6 39 1" fill="none" stroke="#FFF6E5" stroke-width=".6" stroke-dasharray="1.2 2"/><path d="M34 73q-4 4 1 7l7-1q3-5-1-7Z" fill="#EDBE9C"/></g>
        <g class="companion-dock-free"><g class="companion-arm-left"><g class="companion-rest-wing"><g class="companion-nature-only">${babyWing}</g><g class="companion-ranger-only">${fishFlipper}</g></g><g class="companion-edge-grip"><path d="M31 63C21 64 8 56 7 48C5 43 8 40 12 41C11 37 16 35 20 39C22 35 27 38 26 43C30 40 34 44 31 49C28 54 37 57 35 61Q34 64 31 63Z" fill="var(--pet-body)"/><path d="M31 63C21 64 8 56 7 48C5 43 8 40 12 41C11 37 16 35 20 39C22 35 27 38 26 43C30 40 34 44 31 49C28 54 37 57 35 61Q34 64 31 63Z" fill="url(#pet-feather-light)"/><path d="M13 43q3 5 7 7M23 43q1 4 4 6" stroke="#EAF6FF" stroke-width=".8" stroke-linecap="round" opacity=".7"/></g></g>
        </g>
        <g class="companion-dock-carry"><g class="companion-carry">
          <g class="companion-bag"><g transform="rotate(8 67 79)"><rect x="56" y="69" width="24" height="22" rx="3.3" fill="url(#pet-letter)" stroke="#E4D7B7" stroke-width=".35"/><path d="m57 71 11 9 11-9" stroke="#DDCBA2" stroke-width=".8" stroke-linejoin="round"/><path class="growth-satchel-details" d="M57 70h22v9q-10 6-22 0Z" fill="url(#pet-satchel)" stroke="#CDAE78" stroke-width=".45"/><path class="growth-satchel-details" d="M66 78h4v5h-4Z" fill="#FFF0C7" stroke="#BA9C68" stroke-width=".45"/><path class="growth-satchel-details" d="M60 83h5v5h-5Z" fill="#F8E4BA" stroke="#CCAB77" stroke-width=".6" stroke-dasharray=".8 .8"/><path class="pet-reward-motion pet-satchel-glint" d="m58 70 9 18m-4-18 9 18" stroke="#FFFDF2" stroke-width="1" stroke-linecap="round"/></g></g>
<g class="growth-collection-seal"><circle cx="69" cy="81" r="3" fill="var(--pet-seal-color,#40537D)" stroke="#D1B178" stroke-width=".6"/><path d="m69 78.8 .7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7Z" fill="#FFF0CB"/></g>
          <g class="companion-wave"><g class="companion-nature-only"><path d="M82 65C89 62 95 69 92 77c-2 7-9 10-16 9-5-1-6-4-2-6-3-1-1-4 3-5 6-1 8-5 5-10Z" fill="var(--pet-body)"/><path d="M82 65C89 62 95 69 92 77c-2 7-9 10-16 9-5-1-6-4-2-6-3-1-1-4 3-5 6-1 8-5 5-10Z" fill="url(#pet-feather-light)"/></g><g class="companion-ranger-only"><path d="M82 65C89 62 95 69 92 77c-2 7-9 10-16 9-6-1-6-6-1-9 7-2 10-6 7-12Z" fill="var(--pet-body)"/><path d="M82 65C89 62 95 69 92 77c-2 7-9 10-16 9-6-1-6-6-1-9 7-2 10-6 7-12Z" fill="url(#pet-feather-light)"/></g></g>
        </g></g>
      </g>
      </g>
    </g>
    <g class="growth-stars" fill="#DDA956">
      <g class="pet-reward-motion pet-star"><circle cx="17" cy="33" r="6" fill="currentColor" opacity=".1"/><path d="m17 27 1.4 4.6L23 33l-4.6 1.4L17 39l-1.4-4.6L11 33l4.6-1.4Z"/><path class="pet-reward-motion pet-star-ray" d="M17 24v18M8 33h18" stroke="currentColor" stroke-width=".5"/><circle cx="17" cy="33" r=".9" fill="#FFFAE8"/></g>
      <g class="pet-reward-motion pet-star"><circle cx="96" cy="78" r="5" fill="currentColor" opacity=".1"/><path d="m96 73 1.2 3.8L101 78l-3.8 1.2L96 83l-1.2-3.8L91 78l3.8-1.2Z"/><circle cx="96" cy="78" r=".7" fill="#FFFAE8"/></g>
      <circle class="pet-reward-motion pet-star pet-stardust" cx="87" cy="12" r="1.3"/><circle class="pet-reward-motion pet-star pet-stardust" cx="15" cy="78" r="1"/>
      <path class="pet-reward-motion pet-star-trail" d="M70 20q12-7 25-9" pathLength="100" stroke="#F4D98C" stroke-width="1.1" stroke-linecap="round"/>
      <circle class="pet-reward-motion pet-star pet-stardust" cx="101" cy="49" r=".8"/><circle class="pet-reward-motion pet-star pet-stardust" cx="34" cy="9" r=".9"/>
    </g>
    ${orbit(false)}
    <g class="growth-berry pet-reward-motion pet-berry-float"><path d="M88 65q-8-9-10 0q-1 9 10 13q11-4 10-13q-2-9-10 0Z" fill="url(#pet-berry-jam)" stroke="#CF8C9D" stroke-width=".6"/><path d="M88 63q-9-3-6-7 6-1 6 7Zm0 0q-4-8 3-9 4 6-3 9Z" fill="#5AA584"/><circle cx="84" cy="69" r="1" fill="#FFF5D9"/><circle cx="90" cy="72" r="1" fill="#FFF5D9"/></g>
    <g class="growth-lightning" fill="none" stroke="#76DDF2" stroke-linecap="round" stroke-linejoin="round">
      <g class="pet-reward-motion pet-bolt"><path d="M13 39q-7 8 1 12t2 12" stroke-width="3" stroke-opacity=".16"/><path d="M13 39q-7 8 1 12t2 12" pathLength="100" stroke="#8FC2E1" stroke-width="1.4"/><path class="pet-reward-motion pet-bolt-branch" d="m16 51 5 3-1 5" pathLength="100" stroke-width=".7"/></g>
      <g class="pet-reward-motion pet-bolt"><path d="M99 66q-8 8-1 13t1 12" stroke-width="3" stroke-opacity=".16"/><path d="M99 66q-8 8-1 13t1 12" pathLength="100" stroke="#8FC2E1" stroke-width="1.4"/><path class="pet-reward-motion pet-bolt-branch" d="m95 86-5 1-2 4" pathLength="100" stroke-width=".7"/></g>
      <path class="pet-reward-motion pet-energy-stream" d="M22 99q34 16 68 0" stroke="#83BCE5" stroke-width=".8" pathLength="100"/>
    </g>
    <g class="growth-aura" fill="none">
      <path class="pet-reward-motion pet-aurora-veil" d="M18 95Q27 58 35 87Q49 71 59 90Q74 60 83 90Q91 75 96 96Q57 104 18 95Z" fill="url(#pet-aurora-silk)" opacity=".24"/>
      <path class="pet-reward-motion pet-aurora-ribbon" d="M24 95Q29 69 39 92Q55 79 66 94Q80 73 89 97" stroke="url(#pet-aurora-silk)" stroke-width="3.6" stroke-opacity=".35"/>
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
      host.classList.add('introducing');
      startup.dataset.introUntil = String(performance.now() + 1850);
      // Greet with the free wing; the letter and holding wing stay in one rig.
      setTimeout(() => {
        if (!host.isConnected) return;
        host.classList.remove('introducing');
      }, 1500);
    }
  });
  // New conversations clone the welcome template after initial artwork setup.
  // Observe only transcript children, never the streamed message subtree.
  new MutationObserver(() => {
    const host = document.querySelector('.assistant-welcome-portrait');
    if (host && !host.querySelector('.mail-companion')) {
      host.classList.add('companion-avatar');
      host.innerHTML = art;
    }
    document.dispatchEvent(new Event('mailai:assistant-portrait'));
  }).observe(document.getElementById('assistant-messages'), {childList:true});
  const root = document.getElementById('mail-assistant');
  const orb = document.getElementById('assistant-orb');
  // Each actual model request owns its finish callback. Overlapping requests
  // cannot stop each other's animation, and abort releases its activity at once.
  const work = new Set();
  window.mailaiCompanionWork = {
    begin(signal) {
      const token = {};
      const finish = () => {
        signal?.removeEventListener('abort',finish);
        if (!work.delete(token)) return;
        document.body.classList.toggle('companion-working',work.size>0);
      };
      if (signal?.aborted) return finish;
      work.add(token);
      document.body.classList.add('companion-working');
      signal?.addEventListener('abort',finish,{once:true});
      return finish;
    },
  };
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
    // Keep the body behind the ledge, while wings and effects can extend beyond
    // the cropped portrait viewport. Both wings still follow the shared torso rig.
    perchArt.innerHTML = art.replace('viewBox="0 0 112 112"', 'viewBox="15 6 82 70"') + '<i class="perch-paw perch-paw-left"></i><i class="perch-paw perch-paw-right"></i>';
    const perchSvg = perchArt.querySelector('.mail-companion');
    perchSvg.insertAdjacentHTML('afterbegin', '<defs><clipPath id="mailai-perch-body-clip" clipPathUnits="userSpaceOnUse"><rect x="-112" y="-112" width="336" height="188"/></clipPath></defs>');
    const perchTorso = perchSvg.querySelector('.companion-torso');
    const perchBody = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    perchBody.setAttribute('class', 'companion-perch-body');
    perchBody.setAttribute('clip-path', 'url(#mailai-perch-body-clip)');
    for (const part of Array.from(perchTorso.children)) {
      if (!part.matches('.growth-wings,.growth-mech-wings')) perchBody.appendChild(part);
    }
    perchTorso.appendChild(perchBody);
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
  let previous = '', successTimer, wasWorking = false;
  const sync = () => {
    const working = document.body.classList.contains('companion-working');
    const state = working ? 'thinking' : ['thinking', 'danger', 'warn'].find(value => root.classList.contains(`state-${value}`)) || 'calm';
    if (state !== previous) {
      clearTimeout(successTimer);
      root.classList.remove('companion-finished');
      if (previous === 'thinking' && state === 'calm' && root.dataset.answerComplete === 'true' && !wasWorking) {
        root.classList.add('companion-finished');
        successTimer = setTimeout(() => { root.classList.remove('companion-finished'); sync(); }, 3000);
      }
      previous = state;
    }
    wasWorking = working;
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
  let nativeHidden = false, focused = document.hasFocus();
  const syncPaused = () => document.body.classList.toggle('companion-paused',
    document.hidden || nativeHidden || !focused);
  window.addEventListener('blur', () => { focused = false; syncPaused(); });
  window.addEventListener('focus', () => { focused = true; syncPaused(); });
  document.addEventListener('visibilitychange', syncPaused);
  document.addEventListener('mailai:foreground-changed', event => {
    nativeHidden = event.detail?.visible === false; syncPaused();
  });
  syncPaused();
  sync();
})();
