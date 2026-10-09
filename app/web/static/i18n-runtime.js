/* Translate declared interface copy only. Message bodies, field values and protocol
 * identifiers never enter the DOM translation walk. All formatting is text-only. */
const mailaiUICopyKeys = new Map(Object.entries(MAILAI_UI_COPY).map(([key, pair]) => [pair[0], key]));
for (const [key, source] of Object.entries(MAILAI_I18N_CHINESE)) {
  if (typeof source === 'string' && I18N_MESSAGES.en[key] && !mailaiUICopyKeys.has(source)) mailaiUICopyKeys.set(source, key);
}
const mailaiCSSCopy = {
  '--mailai-copy-unavailable':'暂无',
  '--mailai-copy-collapse':'收起',
  '--mailai-copy-signature':'签名',
  '--mailai-copy-group-members':'选择分组后可管理成员',
};
function mailaiApplyCSSCopy() {
  for (const [property, source] of Object.entries(mailaiCSSCopy)) document.documentElement.style.setProperty(property, JSON.stringify(mailaiText(source)));
}
const mailaiUIBindings = new Map();
const mailaiSystemPatterns = Object.entries(MAILAI_UI_COPY)
  .filter(([, [pattern]]) => /\{\d+\}/.test(pattern) && !pattern.includes('<') && (pattern.replace(/\{\d+\}/g, '').match(/[\u3400-\u9fff]/g) || []).length >= 2)
  .sort((a, b) => b[1][0].replace(/\{\d+\}/g, '').length - a[1][0].replace(/\{\d+\}/g, '').length);
const mailaiUIParameters = new WeakMap();
const mailaiUIPatterns = new Map();
Object.assign(I18N_MESSAGES.en, Object.fromEntries(Object.entries(MAILAI_UI_COPY).map(([key, pair]) => [key, pair[1]])));
function mailaiText(source) {
  if (currentI18nLanguage() === I18N_DEFAULT_LANG) return source;
  const key = mailaiUICopyKeys.get(source);
  return key ? I18N_MESSAGES[currentI18nLanguage()]?.[key] ?? source : source;
}
function mailaiFormatText(pattern, values) {
  return pattern.replace(/\{(\d+)\}/g, (token, index) => Object.prototype.hasOwnProperty.call(values, index) ? String(values[index]) : token);
}
function mailaiTemplate(strings, ...values) {
  const pattern = strings.reduce((text, part, index) => text + part + (index < values.length ? `{${index}}` : ''), '');
  return mailaiFormatText(mailaiText(pattern), values);
}
function mailaiBindUI(node, property, reader) {
  const value = reader();
  if (!node) return value;
  const attr = property.startsWith('@') ? property.slice(1) : null;
  const hooks = {textContent:'data-i18n',innerText:'data-i18n',title:'data-i18n-title',placeholder:'data-i18n-placeholder',alt:'data-i18n-alt','@aria-label':'data-i18n-aria','@title':'data-i18n-title','@alt':'data-i18n-alt','@placeholder':'data-i18n-placeholder','@data-placeholder':'data-i18n-data-placeholder'};
  if (hooks[property]) node.removeAttribute?.(hooks[property]);
  if (attr) node.setAttribute(attr, value); else node[property] = value;
  let bindings = mailaiUIBindings.get(node);
  if (!bindings) { bindings = new Map(); mailaiUIBindings.set(node, bindings); }
  bindings.set(property, {reader, last:value});
  return value;
}
function mailaiUIPattern(source) {
  if (!mailaiUIPatterns.has(source)) {
    const indices = [];
    let pattern = '', at = 0;
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of source.matchAll(/\{(\d+)\}/g)) {
      pattern += escape(source.slice(at, match.index)) + '([\\s\\S]*?)';
      indices.push(match[1]); at = match.index + match[0].length;
    }
    pattern += escape(source.slice(at));
    mailaiUIPatterns.set(source, {regex:new RegExp('^' + pattern + '$'), indices});
  }
  return mailaiUIPatterns.get(source);
}
function mailaiUIReadParameters(source, value) {
  const {regex, indices} = mailaiUIPattern(source);
  const match = regex.exec(String(value));
  if (!match) return null;
  return Object.fromEntries(indices.map((index, i) => [index, match[i + 1]]));
}
function mailaiUIDecodeSource(source) {
  if (!source.includes('&')) return source;
  const textarea = document.createElement('textarea'); textarea.innerHTML = source;
  return textarea.value;
}
function mailaiI18nValue(node, slot, key, dictionary, original, current) {
  const declared = MAILAI_UI_COPY[key]?.[0] ?? MAILAI_I18N_CHINESE[key];
  if (declared === undefined) return dictionary[key] ?? original;
  const source = key.startsWith('ui.') ? mailaiUIDecodeSource(declared) : declared;
  if (!/\{\d+\}/.test(source)) {
    // Existing modules sometimes render an already translated value on startup.
    return dictionary[key] ?? source;
  }
  let slots = mailaiUIParameters.get(node);
  if (!slots) { slots = new Map(); mailaiUIParameters.set(node, slots); }
  const parameters = mailaiUIReadParameters(source, current) || (I18N_MESSAGES.en[key] ? mailaiUIReadParameters(I18N_MESSAGES.en[key], current) : null);
  if (parameters) slots.set(slot, {key, parameters});
  const saved = slots.get(slot);
  if (!saved || saved.key !== key) return dictionary[key] ?? original;
  return mailaiFormatText(dictionary[key] ?? source, saved.parameters);
}
function mailaiSystemMessage(value) {
  const source = String(value ?? '');
  if (currentI18nLanguage() === I18N_DEFAULT_LANG || !/[\u3400-\u9fff]/.test(source)) return source;
  const exact = mailaiText(source);
  if (exact !== source) return exact;
  for (const [key, [pattern]] of mailaiSystemPatterns) {
    const parameters = mailaiUIReadParameters(pattern, source);
    if (parameters) return mailaiFormatText(I18N_MESSAGES.en[key], parameters);
  }
  return source;
}
if (typeof document !== 'undefined') {
  document.addEventListener('mailai:language-changed', () => {
    mailaiApplyCSSCopy();
    for (const [node, bindings] of mailaiUIBindings) {
      const frame = node.ownerDocument?.defaultView?.frameElement;
      if (!node.isConnected || (node.ownerDocument !== document && !frame?.isConnected)) { mailaiUIBindings.delete(node); continue; }
      for (const [property, binding] of bindings) {
        // Another renderer owns this field now; never replay a stale label.
        if ((property.startsWith('@') ? node.getAttribute(property.slice(1)) : node[property]) !== binding.last) { bindings.delete(property); continue; }
        try { binding.last = binding.reader(); if (property.startsWith('@')) node.setAttribute(property.slice(1), binding.last); else node[property] = binding.last; }
        catch (_) { bindings.delete(property); }
      }
    }
  });
  const hookSelector = '[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria],[data-i18n-alt],[data-i18n-data-placeholder],[data-i18n-tooltip]';
  const observer = new MutationObserver(records => {
    const roots = new Set();
    if (records.some(record => record.removedNodes?.length)) {
      for (const node of mailaiUIBindings.keys()) {
        const frame = node.ownerDocument?.defaultView?.frameElement;
        if (!node.isConnected || (node.ownerDocument !== document && !frame?.isConnected)) mailaiUIBindings.delete(node);
      }
    }
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) roots.add(node);
          else if (node.parentElement?.matches(hookSelector)) roots.add(node.parentElement);
        }
      } else {
        const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (element?.matches(hookSelector)) roots.add(element);
      }
    }
    for (const root of roots) if (root.isConnected) applyI18n(root);
  });
  const start = () => { mailaiApplyCSSCopy(); applyI18n(); observer.observe(document.body, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['placeholder','title','aria-label','alt','data-placeholder','data-tooltip']}); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
// Explicitly called by UI builders, never on message bodies or user-entered labels.
function mailaiCopySource(label) {
  if (mailaiUICopyKeys.has(label)) return label;
  for (const [source, key] of mailaiUICopyKeys) if (I18N_MESSAGES.en[key] === label) return source;
  for (const [key, [source, english]] of mailaiSystemPatterns) {
    if (english.replace(/\{\d+\}/g, '').trim().length < 8) continue;
    const parameters = mailaiUIReadParameters(english, label);
    if (parameters) return mailaiFormatText(source, parameters);
  }
  return label;
}
function mailaiLabelHTML(label) {
  const source = mailaiCopySource(label);
  const key = mailaiUICopyKeys.get(source);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return key ? `<span data-i18n="${key}">${escape(mailaiText(source))}</span>` : escape(label);
}
