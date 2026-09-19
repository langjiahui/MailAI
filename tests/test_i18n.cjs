/* i18n 框架：字典覆盖、套用逻辑、语言切换持久化与回落。 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const base = path.join(__dirname, '../app/web/static');
const source = fs.readFileSync(path.join(base, 'i18n.js'), 'utf8');
const html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
const manifest = fs.readFileSync(path.join(__dirname, '../frontend/sources.txt'), 'utf8');

// i18n.js 必须最先加载，保证其余模块可用 mailaiT
const firstSource = manifest.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
assert.equal(firstSource, 'i18n.js');
assert.match(html, /id="interface-language"/);
assert.match(html, /<option value="en">English<\/option>/);

// 假 DOM：按属性选择器过滤节点
function fakeNode(attrs) {
  const node = { attrs: { ...attrs }, textContent: '原文', placeholder: '', title: '',
    dataset: {}, children: [] };
  for (const [key, value] of Object.entries(node.attrs)) {
    if (key === 'data-i18n') node.dataset.i18n = value;
  }
  node.getAttribute = name => node.attrs[name];
  node.setAttribute = (name, value) => { node.attrs[name] = value; };
  return node;
}
const nodes = [
  fakeNode({ 'data-i18n': 'nav.compose' }),
  fakeNode({ 'data-i18n': 'missing.key' }),
  fakeNode({ 'data-i18n-placeholder': 'search.placeholder' }),
  fakeNode({ 'data-i18n-aria': 'nav.settings' }),
  fakeNode({ 'data-i18n-data-placeholder': 'compose.bodyPh', 'data-placeholder': '输入邮件正文…' }),
];
const store = new Map();
const events = [];
const documentFake = {
  documentElement: { lang: '' },
  title: '',
  querySelectorAll(selector) {
    const attr = selector.slice(1, -1);
    return nodes.filter(node => attr in node.attrs);
  },
  addEventListener() {},
  dispatchEvent(event) { events.push(event); },
};
const ctx = {
  document: documentFake,
  localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
};
vm.createContext(ctx);
vm.runInContext(source + '\nthis.__api = { I18N_MESSAGES, currentI18nLanguage, mailaiT, applyI18n, setI18nLanguage };', ctx);
const { I18N_MESSAGES, currentI18nLanguage, mailaiT, applyI18n, setI18nLanguage } = ctx.__api;

// 覆盖：index.html 中每个 data-i18n* 键都必须有英文翻译
const keys = new Set();
for (const match of html.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)) keys.add(match[1]);
assert.ok(keys.size >= 40, `expected the first slice to cover >=40 keys, got ${keys.size}`);
for (const key of keys) assert.ok(I18N_MESSAGES.en[key], `missing English translation for ${key}`);

// 默认中文：mailaiT 返回 null（保留源码原文），不改变 DOM
assert.equal(currentI18nLanguage(), 'zh-CN');
assert.equal(mailaiT('nav.compose'), null);
applyI18n();
assert.equal(nodes[0].textContent, '原文');
assert.equal(documentFake.documentElement.lang, 'zh-CN');

// 切到英文：套用文本/placeholder/aria-label，缺失键回落到原文，标题与 lang 更新
setI18nLanguage('en');
assert.equal(store.get('mailai-language'), 'en');
assert.equal(mailaiT('nav.compose'), 'Compose');
assert.equal(nodes[0].textContent, 'Compose');
assert.equal(nodes[1].textContent, '原文', 'missing key must keep the Chinese source text');
assert.equal(nodes[2].placeholder, 'Search subject, sender, body or pinyin...');
assert.equal(nodes[3].attrs['aria-label'], 'Settings');
assert.equal(nodes[4].attrs['data-placeholder'], 'Write your message…');
assert.equal(documentFake.documentElement.lang, 'en');
assert.equal(documentFake.title, I18N_MESSAGES.en['app.title']);
assert.ok(events.some(e => e.type === 'mailai:language-changed' && e.detail.language === 'en'));

// 未知语言被拒绝；切回中文恢复原文，不残留英文
setI18nLanguage('fr');
assert.equal(currentI18nLanguage(), 'en');
setI18nLanguage('zh-CN');
assert.equal(documentFake.documentElement.lang, 'zh-CN');
assert.equal(mailaiT('nav.compose'), null);
assert.equal(nodes[0].textContent, '原文', 'switching back must restore the Chinese source text');
assert.equal(nodes[2].placeholder, '');
assert.equal(nodes[4].attrs['data-placeholder'], '输入邮件正文…');
assert.notEqual(documentFake.title, I18N_MESSAGES.en['app.title']);

console.log(`i18n framework, ${keys.size} translated hooks, fallback and persistence passed`);
