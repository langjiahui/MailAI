/* Shared folded-M geometry; theme-aware glass reflections for every web mark. */
(() => {
  const paths = [
    ['back', 'right', 'm47 29 11-7v23q0 3-3 5l-2 1.4q-2.3 1.6-4.6 0L47 50q-1-1-1-3V31Z'],
    ['back', 'fold', 'm10 17 7.5-4.7q2-1.3 4 0L40 24.6 30 31.3q-2 1.3-4 0L12 23q-4-2.7-2-6Z'],
    ['front', 'left', 'M6 22q0-3.7 2.7-4.7 2-.7 4 1l5.3 3.5V45q0 3-2.5 4.7L13 51.4q-2 1.4-4 0l-1.2-.8Q6 49.3 6 47Z'],
    ['front', 'cross', 'm26.5 31.7 27-18q3-2 4.5 1.2 1 1.9 1 4.8v3.2q0 3.2-2.7 5L40 38.3q-2.1 1.4-4.2 0Z'],
  ];
  let brandSequence = 0;
  function pathsMarkup(front, back) {
    return paths.map(([tone,part,d]) => `<path class="brand-${tone} brand-${part}" fill="${tone === 'front' ? front : back}" d="${d}"/>`).join('');
  }
  function markup(front = 'var(--brand-front)', back = 'var(--brand-back)', palette = {}, id = `mailai-brand-${++brandSequence}`) {
    const shade = palette.shade || 'var(--brand-shade)';
    const reflection = palette.reflection || 'var(--brand-reflection)';
    const backShade = palette.backShade || 'var(--brand-back-shade)';
    return `<svg xmlns="http://www.w3.org/2000/svg" class="brand-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><defs>
      <linearGradient id="${id}-front" x1="0" y1="0" x2=".9" y2="1"><stop class="brand-front-stop" stop-color="${front}"/><stop class="brand-shade-stop" offset=".3" stop-color="${shade}"/><stop offset=".65" stop-color="${front}"/><stop class="brand-reflection-stop" offset="1" stop-color="${reflection}"/></linearGradient>
      <linearGradient id="${id}-back" x1="0" y1="0" x2=".8" y2="1"><stop class="brand-back-stop" stop-color="${back}"/><stop offset=".45" stop-color="${back}"/><stop class="brand-back-shade-stop" offset="1" stop-color="${backShade}"/></linearGradient>
    </defs>${pathsMarkup(`url(#${id}-front)`, `url(#${id}-back)`)}</svg>`;
  }
  document.querySelectorAll('[data-brand-mark]').forEach(host => {
    host.innerHTML = markup();
    if (host.classList.contains('logo')) host.firstElementChild.classList.add('reward-brand-mark');
  });
  function syncIcon() {
    const icon = document.querySelector('link[rel="icon"]');
    if (!icon) return;
    const style = getComputedStyle(document.documentElement);
    const front = style.getPropertyValue('--brand-front').trim() || '#0e5a54';
    const back = style.getPropertyValue('--brand-back').trim() || '#94c7b6';
    const palette = {
      shade: style.getPropertyValue('--brand-shade').trim() || '#292929',
      reflection: style.getPropertyValue('--brand-reflection').trim() || '#005eaa',
      backShade: style.getPropertyValue('--brand-back-shade').trim() || '#6b9fc8',
    };
    icon.type = 'image/svg+xml';
    icon.href = `data:image/svg+xml,${encodeURIComponent(markup(front, back, palette, 'mailai-favicon'))}`;
  }
  document.addEventListener('mailai:themechange', syncIcon);
  document.addEventListener('mailai:reward-themechange', syncIcon);
  syncIcon();
})();
