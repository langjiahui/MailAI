/* Email signature editor, inline image sizing, and AI signature generation. */
function signatureProfileFromForm() {
  const fields = ['name','title','department','company','phone','email','website'];
  return Object.fromEntries(fields.map(key => [key, document.getElementById(`signature-profile-${key}`).value.trim()]));
}

function fillSignatureProfile(profile = {}) {
  for (const key of ['name','title','department','company','phone','email','website']) document.getElementById(`signature-profile-${key}`).value = profile[key] || '';
}

let savedSignatureRange = null;
let selectedSignatureImage = null;
function rememberSignatureSelection() {
  const editor = document.getElementById('signature-editor');
  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return;
  savedSignatureRange = selection.getRangeAt(0).cloneRange();
}

function clearSignatureImageSelection() {
  selectedSignatureImage?.classList.remove('signature-image-selected');
  selectedSignatureImage = null;
  document.getElementById('signature-image-controls').classList.add('hidden');
}

function signatureImageNaturalWidth(image) {
  return image.naturalWidth || Number(image.getAttribute('width')) || Math.round(image.getBoundingClientRect().width) || 1;
}

function signatureImageWidth(image) {
  return Number(image.getAttribute('width')) || Math.round(image.getBoundingClientRect().width) || signatureImageNaturalWidth(image);
}

function refreshSignatureImageControls() {
  const image = selectedSignatureImage;
  const editor = document.getElementById('signature-editor');
  if (!image || !editor.contains(image)) return clearSignatureImageSelection();
  const width = signatureImageWidth(image);
  const percent = Math.max(1, Math.round(width / signatureImageNaturalWidth(image) * 100));
  document.getElementById('signature-image-width').value = String(width);
  document.getElementById('signature-image-scale').value = String(Math.min(200, percent));
  document.getElementById('signature-image-scale-value').textContent = `${percent}%`;
  document.querySelectorAll('[data-signature-image-scale]').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.signatureImageScale) === percent);
  });
}

function selectSignatureImage(image) {
  if (!image || !document.getElementById('signature-editor').contains(image)) return;
  clearSignatureImageSelection();
  selectedSignatureImage = image;
  image.classList.add('signature-image-selected');
  document.getElementById('signature-image-controls').classList.remove('hidden');
  refreshSignatureImageControls();
  if (!image.complete) image.addEventListener('load', () => {
    if (selectedSignatureImage === image) refreshSignatureImageControls();
  }, {once:true});
}

function setSignatureImageWidth(value) {
  if (!selectedSignatureImage || !document.getElementById('signature-editor').contains(selectedSignatureImage)) return clearSignatureImageSelection();
  const width = Math.min(1200, Math.max(16, Math.round(Number(value) || 0)));
  selectedSignatureImage.setAttribute('width', String(width));
  selectedSignatureImage.removeAttribute('height');
  selectedSignatureImage.style.width = `${width}px`;
  selectedSignatureImage.style.maxWidth = '100%';
  selectedSignatureImage.style.height = 'auto';
  refreshSignatureImageControls();
}

async function insertSignatureImage(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/i.test(file.type)) return toast(mailaiText('支持 PNG、JPEG、GIF 或 WebP 图片'), 'warn');
  if (file.size > 5 * 1024 * 1024) return toast(mailaiText('单张签名图片不能超过 5MB'), 'warn');
  const signatureId = editingSignatureId;
  const src = `data:${file.type};base64,${await readFileAsBase64(file)}`;
  if (document.getElementById('signature-manager').classList.contains('hidden') || signatureId !== editingSignatureId) return;
  const editor = document.getElementById('signature-editor');
  const image = document.createElement('img');
  image.addEventListener('load', () => {
    if (!image.hasAttribute('width')) setSignatureImageWidthForNewImage(image);
  }, {once:true});
  image.src = src;
  image.alt = file.name;
  image.style.cssText = 'max-width:100%;height:auto;vertical-align:middle';
  const range = savedSignatureRange && editor.contains(savedSignatureRange.commonAncestorContainer)
    ? savedSignatureRange.cloneRange() : document.createRange();
  if (!editor.contains(range.commonAncestorContainer)) range.selectNodeContents(editor);
  if (!savedSignatureRange || !editor.contains(savedSignatureRange.commonAncestorContainer)) range.collapse(false);
  range.deleteContents();
  range.insertNode(image);
  range.setStartAfter(image);
  range.collapse(true);
  editor.focus();
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  savedSignatureRange = range.cloneRange();
  selectSignatureImage(image);
}

function setSignatureImageWidthForNewImage(image) {
  const width = Math.min(360, image.naturalWidth || 360);
  if (selectedSignatureImage === image) setSignatureImageWidth(width);
  else {
    image.setAttribute('width', String(width));
    image.style.width = `${width}px`;
  }
}

function editSignature(signatureId = '') {
  editingSignatureId = signatureId;
  savedSignatureRange = null;
  clearSignatureImageSelection();
  const item = signatureState.items.find(row => row.id === signatureId);
  document.getElementById('signature-name').value = item?.name || '';
  document.getElementById('signature-editor').innerHTML = item?.html || '';
  document.getElementById('signature-make-default').checked = Boolean(signatureId && signatureId === signatureState.default_id);
  document.getElementById('btn-delete-signature').disabled = !item;
  document.querySelectorAll('[data-signature-id]').forEach(button => button.classList.toggle('active', button.dataset.signatureId === signatureId));
}

function renderSignatureManager() {
  fillSignatureProfile(signatureState.profile || {});
  document.getElementById('signature-list').innerHTML = signatureState.items.length ? signatureState.items.map(item => `<button type="button" data-signature-id="${esc(item.id)}"><span>${esc(item.name)}</span>${item.id === signatureState.default_id ? "<small><span data-i18n=\"ui.844b8cc8dff7\">默认</span></small>" : ''}</button>`).join('') : "<p><span data-i18n=\"ui.559aa7c8eb41\">还没有签名</span><br><small><span data-i18n=\"ui.f1322541d545\">新建一套或让 AI 帮你生成</span></small></p>";
  document.getElementById('btn-ai-generate-signature').disabled = !signatureState.ai_available;
  mailaiBindUI(document.getElementById('btn-ai-generate-signature'), "title", () => (signatureState.ai_available ? mailaiText('根据发件人资料生成签名') : mailaiText('请先在系统中心配置 AI 模型')));
  editSignature(editingSignatureId && signatureState.items.some(item => item.id === editingSignatureId) ? editingSignatureId : (signatureState.items[0]?.id || ''));
}

async function openSignatureManager() {
  try { await loadSignatures(); } catch (err) { return toast(mailaiText('加载签名失败：') + mailaiSystemMessage(err.message), 'error'); }
  renderSignatureManager();
  document.getElementById('signature-ai-options').classList.add('hidden');
  document.getElementById('signature-manager').classList.remove('hidden');
}

function closeSignatureManager() {
  clearSignatureImageSelection();
  document.getElementById('signature-manager').classList.add('hidden');
}

async function saveSignature() {
  const name = document.getElementById('signature-name').value.trim();
  const editorCopy = document.getElementById('signature-editor').cloneNode(true);
  editorCopy.querySelectorAll('.signature-image-selected').forEach(image => image.classList.remove('signature-image-selected'));
  const html = editorCopy.innerHTML.trim();
  if (!name || !(document.getElementById('signature-editor').innerText.trim() || document.querySelector('#signature-editor img'))) return toast(mailaiText('请填写签名名称和内容'), 'warn');
  signatureState = await api('/api/mail/signatures', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:editingSignatureId,name,html,profile:signatureProfileFromForm(),make_default:document.getElementById('signature-make-default').checked})});
  const saved = signatureState.items.find(item => item.name === name && item.html === html) || signatureState.items.at(-1);
  editingSignatureId = saved?.id || editingSignatureId;
  renderSignatureManager(); renderSignatureSelect();
  if (currentSignatureId === editingSignatureId || (!currentSignatureId && document.getElementById('signature-make-default').checked)) renderComposeSignature(editingSignatureId);
  queueDraftSave(); toast(mailaiText('签名已保存'), 'success');
}

async function generateSignatures(button) {
  const profile = signatureProfileFromForm();
  if (!profile.name && !profile.email) return toast(mailaiText('请至少填写姓名或邮箱'), 'warn');
  setLoading(button, true, mailaiText('AI 生成中…'));
  const finishCompanionWork = globalThis.mailaiCompanionWork?.begin();
  try {
    const result = await api('/api/mail/signatures/generate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile,style:document.getElementById('signature-ai-style').value})});
    const host = document.getElementById('signature-ai-options');
    host.innerHTML = result.options.map((item, index) => `<button type="button" data-ai-signature="${index}"><b>${esc(item.name)}</b><span>${item.html}</span><small><span data-i18n="ui.ab41d65b7982">使用这套</span></small></button>`).join('');
    host._options = result.options;
    host.classList.remove('hidden');
  } catch (err) { toast(mailaiText('AI 签名生成失败：') + mailaiSystemMessage(err.message), 'error'); }
  finally { finishCompanionWork?.(); setLoading(button, false); }
}

document.getElementById('btn-manage-signatures').addEventListener('click', openSignatureManager);
document.querySelectorAll('[data-close-signatures]').forEach(button => button.addEventListener('click', closeSignatureManager));
document.getElementById('btn-new-signature').addEventListener('click', () => editSignature(''));
document.getElementById('signature-list').addEventListener('click', event => { const button = event.target.closest('[data-signature-id]'); if (button) editSignature(button.dataset.signatureId); });
document.getElementById('btn-save-signature').addEventListener('click', () => saveSignature().catch(err => toast(mailaiText('保存签名失败：') + mailaiSystemMessage(err.message), 'error')));
document.getElementById('btn-delete-signature').addEventListener('click', async () => {
  if (!editingSignatureId || !window.confirm(mailaiText('确定删除这套签名？'))) return;
  const removed = editingSignatureId;
  signatureState = await api(`/api/mail/signatures/${encodeURIComponent(removed)}`, {method:'DELETE'});
  editingSignatureId = '';
  if (currentSignatureId === removed) renderComposeSignature('');
  renderSignatureManager(); renderSignatureSelect(); queueDraftSave();
  toast(mailaiText('签名已删除'), 'success');
});
document.getElementById('btn-ai-generate-signature').addEventListener('click', event => generateSignatures(event.currentTarget));
document.getElementById('signature-editor').addEventListener('keyup', rememberSignatureSelection);
document.getElementById('signature-editor').addEventListener('mouseup', rememberSignatureSelection);
document.getElementById('signature-editor').addEventListener('click', event => {
  const image = event.target.closest?.('img');
  if (image) selectSignatureImage(image);
  else clearSignatureImageSelection();
});
document.getElementById('signature-editor').addEventListener('input', () => {
  if (selectedSignatureImage && !document.getElementById('signature-editor').contains(selectedSignatureImage)) clearSignatureImageSelection();
});
document.querySelectorAll('[data-signature-image-scale]').forEach(button => button.addEventListener('click', () => {
  if (selectedSignatureImage) setSignatureImageWidth(signatureImageNaturalWidth(selectedSignatureImage) * Number(button.dataset.signatureImageScale) / 100);
}));
document.getElementById('signature-image-scale').addEventListener('input', event => {
  if (selectedSignatureImage) setSignatureImageWidth(signatureImageNaturalWidth(selectedSignatureImage) * Number(event.target.value) / 100);
});
document.getElementById('signature-image-width').addEventListener('change', event => setSignatureImageWidth(event.target.value));
document.getElementById('signature-image-done').addEventListener('click', clearSignatureImageSelection);
document.getElementById('btn-insert-signature-image').addEventListener('pointerdown', rememberSignatureSelection);
document.getElementById('btn-insert-signature-image').addEventListener('click', () => document.getElementById('signature-image-input').click());
document.getElementById('signature-image-input').addEventListener('change', async event => {
  const file = event.target.files[0], button = document.getElementById('btn-insert-signature-image');
  event.target.value = '';
  if (!file || button.disabled) return;
  setLoading(button, true, mailaiText('读取图片…'));
  try { await insertSignatureImage(file); }
  catch(error) { toast(mailaiText('插入签名图片失败：') + mailaiSystemMessage(error.message), 'error'); }
  finally { setLoading(button, false); }
});
document.getElementById('signature-ai-options').addEventListener('click', event => {
  const button = event.target.closest('[data-ai-signature]');
  if (!button) return;
  const item = event.currentTarget._options?.[Number(button.dataset.aiSignature)];
  if (!item) return;
  editingSignatureId = '';
  clearSignatureImageSelection();
  document.getElementById('signature-name').value = item.name;
  document.getElementById('signature-editor').innerHTML = item.html;
  document.getElementById('signature-make-default').checked = !signatureState.default_id;
  toast(mailaiText('已放入编辑区，确认后点击保存'), 'success');
});

globalThis.MailAIModules?.register('signatureManager', {
  openSignatureManager,
  closeSignatureManager,
  renderSignatureManager,
  editSignature,
  saveSignature,
  generateSignatures,
});
