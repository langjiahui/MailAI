// Load the decorative WebGL scene only while the author panel is visible.
const mark = document.querySelector('[data-author-logo]');

if (mark) {
  const canvas = mark.querySelector('canvas');
  const image = mark.querySelector('img');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const panel = mark.closest('.system-panel');
  const workspace = document.getElementById('system-view');
  const isPanelOpen = () => !panel.classList.contains('hidden') && !workspace.classList.contains('hidden');
  let panelOpen = isPanelOpen();
  let scene, loading, disposed = false, visible = false, contextLost = false;
  let playing = !reduced.matches, raf = 0, last = 0, time = .8;
  let yaw = 0, pitch = 0, targetYaw = 0, targetPitch = 0;
  let pointerDown = null, suppressClick = false;
  const entrance = {pending:true, active:false, elapsed:0, yaw:0, pitch:0};
  const language = () => {
    const key = !scene || contextLost ? 'about.logoStill' : playing ? 'about.logoPause' : 'about.logoPlay';
    const fallback = !scene || contextLost ? 'langjiahui 的 LJH 标识' : playing ? 'LJH 标识，移动或拖动鼠标旋转，点击暂停流光' : 'LJH 标识，移动或拖动鼠标旋转，点击播放流光';
    const label = window.mailaiT?.(key) || fallback;
    mark.setAttribute('aria-label', label);
    mark.title = label;
    mark.setAttribute('aria-pressed', String(playing && !!scene && !contextLost));
    mark.disabled = !scene || contextLost;
  };
  const active = () => scene && visible && panelOpen && !document.hidden && !disposed && !contextLost;
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  }
  function draw(now) {
    raf = 0;
    if (!active()) return;
    const dt = last ? Math.min((now - last) / 1000, .05) : 0;
    last = now;
    if (playing) {
      time += dt;
      if (entrance.active) {
        entrance.elapsed = Math.min(1.7, entrance.elapsed + dt);
        const turn = Math.sin(Math.PI * entrance.elapsed / 1.7) ** 2;
        entrance.yaw = -.22 * turn;
        entrance.pitch = -.065 * turn;
        if (entrance.elapsed === 1.7) {
          entrance.active = false;
          entrance.yaw = entrance.pitch = 0;
        }
      }
    }
    const ease = 1 - Math.exp(-dt * 12);
    yaw += (targetYaw - yaw) * ease;
    pitch += (targetPitch - pitch) * ease;
    const moving = Math.abs(yaw-targetYaw) + Math.abs(pitch-targetPitch) > .0001;
    if (!moving) { yaw = targetYaw; pitch = targetPitch; }
    scene.render(time, yaw + entrance.yaw, pitch + entrance.pitch);
    if (playing || moving) {
      raf = requestAnimationFrame(draw);
    } else last = 0;
  }
  function schedule() {
    if (active() && !raf) raf = requestAnimationFrame(draw);
  }
  function resize() {
    if (!scene || !mark.clientWidth || !mark.clientHeight) return;
    scene.resize(mark.clientWidth, mark.clientHeight);
    schedule();
  }
  async function ensureScene() {
    if (loading || scene || disposed) return;
    loading = true;
    try {
      const { createAuthorLogo } = await import('./author-logo-scene.js?v=3');
      if (disposed) return;
      scene = await createAuthorLogo(canvas, image);
      if (disposed) { scene.dispose(); return; }
      resize();
      scene.render(time);
      mark.dataset.logoState = 'ready';
      language();
      sync();
    } catch (_) {
      // Keep the approved static mark when WebGL or a local resource is unavailable.
      mark.dataset.logoState = 'fallback';
      language();
    }
  }
  function sync() {
    if (visible && panelOpen && !document.hidden && !disposed) {
      ensureScene();
      if (scene && entrance.pending) {
        entrance.pending = false;
        entrance.active = playing && !reduced.matches;
        entrance.elapsed = 0;
      }
      schedule();
    } else stop();
  }
  function toggle() {
    if (suppressClick) { suppressClick = false; return; }
    playing = !playing;
    language();
    schedule();
  }
  function takeControl() {
    // Preserve the current pose when a pointer interrupts the entrance.
    yaw += entrance.yaw;
    pitch += entrance.pitch;
    entrance.yaw = entrance.pitch = 0;
    entrance.active = entrance.pending = false;
  }
  const clamp = (value, max) => Math.max(-max, Math.min(max, value));
  function point(event) {
    if (event.pointerType === 'touch' || mark.disabled) return;
    takeControl();
    if (pointerDown) {
      const dx = event.clientX - pointerDown.x, dy = event.clientY - pointerDown.y;
      if (!pointerDown.dragging && Math.hypot(dx,dy) < 3) return;
      pointerDown.dragging = true;
      mark.classList.add('is-rotating');
      if (!mark.hasPointerCapture(event.pointerId)) mark.setPointerCapture(event.pointerId);
      targetYaw = clamp(pointerDown.yaw + dx * .004, .24);
      targetPitch = clamp(pointerDown.pitch + dy * .003, .14);
      schedule();
      return;
    }
    const bounds = mark.getBoundingClientRect();
    targetYaw = clamp(((event.clientX - bounds.left) / bounds.width - .5) * .44, .24);
    targetPitch = clamp(((event.clientY - bounds.top) / bounds.height - .5) * .24, .14);
    schedule();
  }
  function press(event) {
    if (event.pointerType === 'touch' || event.button !== 0 || mark.disabled) return;
    takeControl();
    suppressClick = false;
    pointerDown = {x:event.clientX, y:event.clientY, yaw, pitch, dragging:false};
  }
  function resetTilt() {
    if (pointerDown?.dragging) return;
    targetYaw = targetPitch = 0;
    schedule();
  }
  function release(event) {
    if (!pointerDown) return;
    suppressClick = pointerDown.dragging && event.type === 'pointerup';
    pointerDown = null;
    mark.classList.remove('is-rotating');
    if (mark.hasPointerCapture(event.pointerId)) mark.releasePointerCapture(event.pointerId);
    const bounds = mark.getBoundingClientRect();
    if (event.type !== 'pointerup' || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) resetTilt();
  }
  function reduce() {
    if (reduced.matches) {
      playing = false;
      entrance.active = entrance.pending = false;
      entrance.yaw = entrance.pitch = 0;
      yaw = pitch = targetYaw = targetPitch = 0;
    }
    language();
    schedule();
  }
  function lost(event) {
    event.preventDefault();
    contextLost = true;
    stop();
    mark.dataset.logoState = 'fallback';
    language();
  }
  function restored() {
    contextLost = false;
    mark.dataset.logoState = 'ready';
    language();
    resize();
  }
  const intersection = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    sync();
  });
  const sizes = new ResizeObserver(resize);
  const panels = new MutationObserver(() => {
    const open = isPanelOpen();
    if (open !== panelOpen) {
      panelOpen = open;
      entrance.pending = open;
      entrance.active = false;
      entrance.yaw = entrance.pitch = 0;
      yaw = pitch = targetYaw = targetPitch = 0;
      pointerDown = null;
      mark.classList.remove('is-rotating');
      sync();
    }
  });
  panels.observe(panel, {attributes:true,attributeFilter:['class']});
  panels.observe(workspace, {attributes:true,attributeFilter:['class']});
  intersection.observe(mark);
  sizes.observe(mark);
  mark.addEventListener('click', toggle);
  mark.addEventListener('pointerdown', press);
  mark.addEventListener('pointermove', point);
  mark.addEventListener('pointerleave', resetTilt);
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  reduced.addEventListener('change', reduce);
  document.addEventListener('visibilitychange', sync);
  document.addEventListener('mailai:language-changed', language);
  function pagehide(event) {
    stop();
    if (event.persisted) return;
    disposed = true;
    intersection.disconnect();
    sizes.disconnect();
    panels.disconnect();
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
    reduced.removeEventListener('change', reduce);
    document.removeEventListener('visibilitychange', sync);
    document.removeEventListener('mailai:language-changed', language);
    window.removeEventListener('pageshow', sync);
    scene?.dispose();
  }
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', sync);
  language();
}
