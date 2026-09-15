const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const protectSource = source.slice(source.indexOf('function protectRichEmailLinks('), source.indexOf('\nasync function openExternalLink'));
const context = vm.createContext({});
context.window = context;
vm.runInContext(protectSource, context);
const protectedMail = context.protectRichEmailLinks('<!doctype html><html><head><title>工资单</title></head><body style="background:#fff"><table><tr><td><img src="data:image/png;base64,AAAA"><a target="_blank" href="https://example.test/payroll?a=1&amp;b=2">查看工资条</a></td></tr></table></body></html>');
assert.match(protectedMail, /<table>[\s\S]*data:image\/png;base64,AAAA[\s\S]*查看工资条[\s\S]*<\/table>/,
  'protecting links must preserve complete HTML body content and inline images');
assert.match(protectedMail, /data-mailai-href="https:\/\/example\.test\/payroll\?a=1&amp;b=2" href="https:\/\/example\.test\/payroll\?a=1&amp;b=2"/,
  'WKWebView must receive the real destination for its native navigation policy');
assert.doesNotMatch(protectedMail, /#mailai-external-link/, 'placeholder navigation blanks WKWebView mail frames');
assert.doesNotMatch(protectedMail, /target="_blank"/,
  'an unhandled click must not open a sandbox navigation target');
const protectedMailto = context.protectRichEmailLinks('<a href="mailto:person@example.test?subject=Hello">写邮件</a>');
assert.match(protectedMailto, /data-mailai-href="mailto:person@example\.test\?subject=Hello" href="mailto:person@example\.test\?subject=Hello"/,
  'WKWebView must preserve mailto data for its native MailAI compose fallback');

assert.match(source, /function richEmailDocument\(html, allowRemote = true\)/,
  'HTML mail renderer should allow remote images by default');
assert.match(source, /data-mailai-theme="\$\{theme\}"/,
  'sandboxed HTML mail should inherit the active application theme');
assert.match(source, /function applyRichEmailFrameTheme\(frame, theme/,
  'sandboxed HTML mail should repair low-contrast newsletter styles after loading');
assert.match(source, /contrast < 4\.5/,
  'dark-mode mail should correct text that is unreadable against its actual background');
assert.match(source, /Luminance\(background\.rgb\) > \.5/,
  'light message canvases should follow the dark theme without recolouring images');
assert.match(source, /slice\(0, 3000\)/,
  'contrast correction must stay bounded for very large HTML messages');
assert.match(source, /mailai:themechange/,
  'already-mounted rich email frames should react to live theme changes');
assert.match(source, /img-src 'self' data:\$\{allowRemote \? ' http: https:' : ''\}/,
  'remote image CSP should remain limited to image sources');
assert.match(source, /frame\.srcdoc = richEmailDocument\(e\.body_html, true\)/,
  'main and digest rich mail paths should render remote images');
assert.match(source, /frame\.srcdoc = richEmailDocument\(row\.body_html, true\)/,
  'sent and draft rich mail paths should render remote images');
assert.doesNotMatch(source, /id="btn-load-remote-images"/,
  'remote image rendering should not require a second click');
assert.match(source, /doc\.addEventListener\('click', openMailLink, true\)/,
  'sandboxed HTML email links must be forwarded to the parent handler');
assert.match(source, /replace\(\/<base\\b\[\^>\]\*>\/ig, ''\)/,
  'mail content must not contain alternate navigation primitives');
assert.match(source, /a\[data-mailai-href\],area\[data-mailai-href\]/,
  'button-style and image-map links should share the safe opener');
assert.match(source, /doc\.addEventListener\('submit', blockMailForm, true\)/,
  'mail forms must not be able to navigate inside the reading frame');
assert.equal((source.match(/autoSizeRichEmailFrame\(frame\);\s*frame\.srcdoc = richEmailDocument/g) || []).length, 3,
  'all rich-mail views must register the load/click handler before assigning srcdoc');
assert.match(source, /window\.pywebview\.api\.open_external_url\(url\)/,
  'packaged desktop links must open through the native browser bridge');
assert.match(source, /\['http:', 'https:', 'mailto:'\]\.includes\(url\.protocol\)/,
  'only recognized safe link schemes may leave the mail sandbox');
assert.match(source, /function openMailtoCompose\(value\)[\s\S]*openCompose\(seed\)/,
  'mailto links must open the built-in composer');
assert.match(source, /openSafeMailLink\(url\)/,
  'all mail-body link handlers must route mailto separately from web links');

console.log('Remote images render directly inside the sandboxed mail iframe');

// Exercise paired background/text overrides and restoration, including sender
// styles with !important: these caused both pale text and the white-sheet bug.
vm.runInContext(source.slice(source.indexOf('function richEmailColor('), source.indexOf('\nfunction syncRichEmailFrameTheme(')), context);
function mailNode(tag, background, color, parent = null) {
  const properties = new Map([['background-color', [background, 'important']], ['color', [color, 'important']]]);
  return {parentElement:parent, isConnected:true,
    matches(selector) { return selector.split(',').includes(tag); },
    style:{
      getPropertyValue(key) { return properties.get(key)?.[0] || ''; },
      getPropertyPriority(key) { return properties.get(key)?.[1] || ''; },
      setProperty(key, value, priority) { properties.set(key, [value, priority]); },
      removeProperty(key) { properties.delete(key); },
    },
  };
}
const mailBody = mailNode('body', 'rgb(255, 255, 255)', 'rgb(0, 0, 0)');
const whitePanel = mailNode('div', 'rgb(255, 255, 255)', 'rgb(0, 0, 0)', mailBody);
const paleText = mailNode('p', 'rgba(0, 0, 0, 0)', 'rgb(223, 236, 228)', whitePanel);
const logo = mailNode('img', 'rgb(255, 255, 255)', 'rgb(0, 0, 0)', whitePanel);
mailBody.querySelectorAll = () => [whitePanel, paleText, logo];
const cssColor = value => value.startsWith('#') ? `rgb(${value.slice(1).match(/../g).map(v => parseInt(v, 16)).join(', ')})` : value;
const frame = {contentDocument:{body:mailBody, documentElement:{setAttribute(){}}, defaultView:{
  getComputedStyle(node) { return {backgroundColor:cssColor(node.style.getPropertyValue('background-color')), color:cssColor(node.style.getPropertyValue('color'))}; },
}}};
context.applyRichEmailFrameTheme(frame, 'dark');
assert.equal(whitePanel.style.getPropertyValue('background-color'), '#16271f');
assert.equal(whitePanel.style.getPropertyValue('color'), '#e4eee8');
assert.equal(paleText.style.getPropertyValue('color'), 'rgb(223, 236, 228)');
assert.equal(logo.style.getPropertyValue('background-color'), 'rgb(255, 255, 255)');
context.applyRichEmailFrameTheme(frame, 'dark');
assert.equal(whitePanel.style.getPropertyValue('background-color'), '#16271f', 'Repeated theme application remains stable');
context.applyRichEmailFrameTheme(frame, 'light');
assert.equal(whitePanel.style.getPropertyValue('background-color'), 'rgb(255, 255, 255)');
assert.equal(whitePanel.style.getPropertyValue('color'), 'rgb(0, 0, 0)');
assert.equal(whitePanel.style.getPropertyPriority('color'), 'important');
console.log('Dark HTML surfaces, legible text, unchanged images and light-theme restoration passed');
