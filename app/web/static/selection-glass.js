/* Move one glass plate between selected rows without stretching their content. */
(() => {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const surfaces = [
    {
      host: document.querySelector('.layout > .sidebar'),
      kind: 'folders',
      selected(host) {
        return [...host.querySelectorAll(
          '#account-mailbox-nav .nav-item.active, ' +
          '#account-mailbox-nav .sidebar-account-folders button.active, ' +
          '#primary-folder-group #folder-nav .nav-item.active'
        )].find(node => node.getClientRects().length);
      },
      key(node) {
        return [node.dataset.accountAction, node.dataset.accountId,
          node.dataset.filter, node.dataset.value].join(':');
      },
    },
    {
      host: document.getElementById('email-list'),
      kind: 'mail',
      selected(host) {
        if (host.closest('.list-pane')?.classList.contains('selection-active')) return null;
        return host.querySelector('.email-item.selected:not(.bulk-selected)');
      },
      key(node) { return `${node.dataset.accountId || ''}:${node.dataset.id}`; },
    },
  ];

  function setBounds(plate, host, rect) {
    const frame = host.getBoundingClientRect();
    const scale = frame.width / host.offsetWidth || 1;
    plate.style.left = `${(rect.left - frame.left) / scale + host.scrollLeft - host.clientLeft}px`;
    plate.style.top = `${(rect.top - frame.top) / scale + host.scrollTop - host.clientTop}px`;
    plate.style.width = `${rect.width / scale}px`;
    plate.style.height = `${rect.height / scale}px`;
    return scale;
  }

  function animateMove(plate, from, to, kind, scale) {
    if (reducedMotion.matches || !plate.animate) return;
    const dx = (from.left - to.left) / scale;
    const dy = (from.top - to.top) / scale;
    const vertical = Math.abs(dy) >= Math.abs(dx);
    const direction = Math.sign(vertical ? dy : dx);
    plate.animate([
      {transform:`translate(${dx}px,${dy}px) scale(${from.width / to.width},${from.height / to.height})`, offset:0},
      {transform:`translate(${dx * .36}px,${dy * .36}px) scale(${vertical ? 1.015 : 1.1},${vertical ? 1.1 : 1.015})`, offset:.56},
      {transform:`translate(${vertical ? 0 : -direction * 2}px,${vertical ? -direction * 2 : 0}px) scale(${vertical ? .99 : 1.025},${vertical ? 1.025 : .99})`, offset:.82},
      {transform:'translate(0,0) scale(1,1)', offset:1},
    ], {
      duration:kind === 'folders' ? 290 : 210,
      easing:'cubic-bezier(.2,.75,.25,1)',
      fill:'none',
    });
  }

  for (const surface of surfaces) {
    const {host, kind} = surface;
    if (!host) continue;
    let plate = null;
    let lastKey = '';
    let observedTarget = null;
    let queued = false;
    const resize = new ResizeObserver(() => schedule());
    resize.observe(host);

    function hide() {
      plate?.getAnimations().forEach(animation => animation.cancel());
      if (plate) plate.hidden = true;
      host.classList.remove('glass-selection-ready');
      lastKey = '';
      if (observedTarget) resize.unobserve(observedTarget);
      observedTarget = null;
    }

    function sync() {
      queued = false;
      const target = surface.selected(host);
      if (!target || !target.isConnected) return hide();
      const rect = target.getBoundingClientRect();
      const frame = host.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= frame.top || rect.top >= frame.bottom) return hide();
      if (observedTarget !== target) {
        if (observedTarget) resize.unobserve(observedTarget);
        resize.observe(target);
        observedTarget = target;
      }
      if (!plate?.isConnected) {
        plate = document.createElement('div');
        plate.className = 'selection-glass-plate';
        plate.setAttribute('aria-hidden', 'true');
        host.appendChild(plate);
        lastKey = '';
      }
      const key = surface.key(target);
      const from = plate.hidden || !lastKey ? null : plate.getBoundingClientRect();
      plate.getAnimations().forEach(animation => animation.cancel());
      plate.hidden = false;
      const scale = setBounds(plate, host, rect);
      host.classList.add('glass-selection-ready');
      const maxDistance = host.clientHeight * scale * .8;
      if (from && key !== lastKey && Math.abs(from.top - rect.top) < maxDistance) {
        animateMove(plate, from, rect, kind, scale);
      }
      lastKey = key;
    }

    function schedule() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(sync);
    }

    new MutationObserver(records => {
      if (records.some(record => {
        if (record.type === 'attributes') return record.target !== host && record.target !== plate;
        return record.target !== host ||
          ![...record.addedNodes, ...record.removedNodes].every(node => node === plate);
      })) schedule();
    }).observe(host, {subtree:true, childList:true, attributes:true, attributeFilter:['class']});
    if (kind === 'mail') {
      new MutationObserver(schedule).observe(host.closest('.list-pane'),
        {attributes:true, attributeFilter:['class']});
    }
    host.addEventListener('scroll', schedule, {passive:true});
    window.addEventListener('resize', schedule, {passive:true});
    schedule();
  }
})();
