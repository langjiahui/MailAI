/* Measured disclosures work without interpolate-size / ::details-content.
   Keep native details semantics and do not wrap/rebuild editable content. */
(() => {
  const running = new WeakMap();
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.addEventListener('click', event => {
    const summary = event.target.closest('summary');
    const details = summary?.parentElement;
    if (!details?.matches('.compose-extra-recipients,.message-recipients details,.assistant-sources') || reduce()) return;
    event.preventDefault();
    const previous = running.get(details);
    const opening = previous ? !previous.opening : !details.open;
    const start = details.offsetHeight;
    if (previous) { previous.animation.onfinish = null; previous.animation.cancel(); }
    const originalOverflow = previous?.overflow ?? details.style.overflow;
    const originalHeight = previous?.height ?? details.style.height;
    details.style.height = originalHeight;
    details.open = opening;
    const end = details.offsetHeight;
    details.open = true;
    details.style.overflow = 'hidden';
    const animation = details.animate([{height:`${start}px`},{height:`${end}px`}], {
      duration:opening ? 240 : 180, easing:'cubic-bezier(.2,.8,.2,1)'
    });
    running.set(details, {animation, opening, overflow:originalOverflow, height:originalHeight});
    animation.onfinish = () => {
      details.open = opening;
      details.style.overflow = originalOverflow;
      details.style.height = originalHeight;
      running.delete(details);
    };
  });
})();
