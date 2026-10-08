/* Scoped feedback: no polling/DOM-wide observation and no delays before controls work. */
(() => {
  const running = new WeakMap(), pending = new WeakMap(), bound = new WeakSet();
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const reduce = () => media.matches;
  function reveal(node) {
    if (!node?.isConnected || reduce() || !node.animate || document.hidden) return;
    return node.animate([{opacity:.55},{opacity:1}], {duration:180, easing:'ease-out'});
  }
  window.mailaiMotion = {
    reveal,
    pending(node) {
      if (!node) return () => {};
      const previous = pending.get(node);
      const state = {busy:previous ? previous.busy : node.getAttribute('aria-busy')};
      pending.set(node, state);
      node.setAttribute('aria-busy', 'true');
      node.setAttribute('data-motion-pending', '');
      return () => {
        if (pending.get(node) !== state) return;
        pending.delete(node);
        node.removeAttribute('data-motion-pending');
        if (state.busy === null) node.removeAttribute('aria-busy');
        else node.setAttribute('aria-busy', state.busy);
        reveal(node);
      };
    },
    bindDisclosures,
  };
  // Measured disclosures also work in desktop WebKit. Keep the actual content
  // and native keyboard semantics; a second click reverses the current motion.
  function bindDisclosures(doc) {
    if (bound.has(doc)) return;
    bound.add(doc);
    doc.addEventListener('click', event => {
      const summary = event.target.closest?.('summary');
      const details = summary?.parentElement;
      if (!details?.matches('.compose-extra-recipients,.message-recipients details,.assistant-sources,.mail-reading-fold,details[data-mailai-fold],.directory-editor-details,.directory-sheet details,.directory-review-row,.directory-pending-preview,.productivity-help,.diagnostic-help')) return;
      if (event.target.closest('a,button,input,select,textarea') || !details.animate) return;
      const previous = running.get(details);
      const opening = previous ? !previous.opening : !details.open;
      if (reduce()) {
        if (previous) { event.preventDefault(); previous.finish(opening); }
        return;
      }
      event.preventDefault();
      const start = details.offsetHeight;
      if (previous) { previous.animation.onfinish = null; previous.animation.cancel(); }
      const overflow = previous?.overflow ?? details.style.overflow;
      const height = previous?.height ?? details.style.height;
      details.style.height = height;
      details.open = opening;
      const end = details.offsetHeight;
      details.open = true;
      details.style.overflow = 'hidden';
      const animation = details.animate([{height:`${start}px`},{height:`${end}px`}], {
        duration:opening ? 240 : 180, easing:'cubic-bezier(.2,.8,.2,1)'
      });
      const finish = (value = opening) => {
        animation.onfinish = null;
        animation.cancel();
        details.open = value;
        details.style.overflow = overflow;
        details.style.height = height;
        running.delete(details);
      };
      running.set(details, {animation, opening, overflow, height, finish});
      animation.onfinish = () => finish();
    });
  }
  bindDisclosures(document);
})();
