const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync('app/web/static/app.js', 'utf8');
const host = {innerHTML: ''};
const context = vm.createContext({
  document: {getElementById: id => id === 'allowlist-list' ? host : null},
});

vm.runInContext(source.slice(source.indexOf('function esc('), source.indexOf('\nfunction mailDateGroup(')), context);
assert.equal(context.esc(1), '1', 'Numeric database ids must be safe to render');
assert.equal(context.esc(false), 'false', 'Boolean values must not crash escaping');
assert.equal(context.esc('<trusted@example.test>'), '&lt;trusted@example.test&gt;');

const allowlistRenderer = source.slice(
  source.indexOf('let _rulesData = []'),
  source.indexOf('\nasync function saveAllowlistEntry('),
);
vm.runInContext(allowlistRenderer, context);
vm.runInContext(`_allowlistData = [{
  id: 1,
  email: 'trusted@example.test',
  value: 'trusted@example.test',
  enabled: 1,
  note: '由误报反馈添加：发件人可信',
  kind: 'address',
  readonly: false,
  source: '用户添加'
}]; renderAllowlist();`, context);

assert.match(host.innerHTML, /data-id="1"/);
assert.match(host.innerHTML, /trusted@example\.test/);
assert.match(host.innerHTML, /由误报反馈添加：发件人可信/);
console.log('Rule center renders numeric allowlist ids and escaped values safely');
