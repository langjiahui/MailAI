/* Visibility is local to the form and resets whenever its context changes. */
(() => {
  const field = document.getElementById('model-api-key');
  const toggle = document.getElementById('model-key-visibility');
  if (!field || !toggle) return;
  function render() {
    const visible = field.type === 'text';
    toggle.setAttribute('aria-pressed', String(visible));
    mailaiBindUI(toggle, "@aria-label", () => (mailaiT(visible ? 'model.keyHideLabel' : 'model.keyShowLabel') || (visible ? '隐藏 API Key' : '显示 API Key')));
    mailaiBindUI(toggle.querySelector('span'), "textContent", () => (mailaiT(visible ? 'model.keyHide' : 'model.keyShow') || (visible ? '隐藏' : '显示')));
  }
  const conceal = () => { field.type = 'password'; render(); };
  toggle.addEventListener('click', () => { field.type = field.type === 'password' ? 'text' : 'password'; render(); });
  document.getElementById('model-provider').addEventListener('change', conceal, true);
  document.getElementById('model-config-form').addEventListener('submit', conceal, true);
  document.getElementById('btn-test-model').addEventListener('click', conceal, true);
  document.addEventListener('click', event => {
    if (event.target.closest('[data-system-tab], #btn-close-system, #start-model-later, #start-enable, [data-help-settings]')) conceal();
  }, true);
  const panel = document.querySelector('[data-system-panel="ai"]');
  if (panel) new MutationObserver(() => { if (panel.classList.contains('hidden')) conceal(); }).observe(panel, {attributes:true, attributeFilter:['class']});
  document.addEventListener('mailai:language-changed', render);
  render();
})();
