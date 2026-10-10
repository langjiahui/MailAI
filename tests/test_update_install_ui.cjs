/* Opening macOS Installer must not claim installation or trap the update dialog. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    textContent: '', style: {}, disabled: false, open: true,
    classList: {add() {}, remove() {}, toggle() {}}, setAttribute() {},
    close() { this.open = false; },
  });
  return elements.get(id);
}
const messages = [];
const ctx = {
  document: {getElementById: element}, appUpdateInstalling: false,
  mailaiText: text => text, mailaiSystemMessage: text => text,
  mailaiTemplate: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
  mailaiBindUI: (node, key, reader) => { node[key] = reader(); },
  setLoading: (node, loading) => { node.disabled = loading; },
  setTimeout: callback => { callback(); },
  toast: (message, kind) => messages.push({message, kind}),
};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function formatUpdateBytes('), source.indexOf('async function loadSystemConfig(')), ctx);
(async () => {
  // A successful handoff keeps directions visible and lets canceled installs retry.
  ctx.api = async () => ({status: 'completed', phase: 'installer_opened', total: 20, downloaded: 20, message: 'Continue in Installer'});
  await ctx.installAppUpdate({preventDefault() {}});
  assert.equal(element('update-dialog').open, true);
  assert.equal(element('btn-install-update').disabled, false);
  assert.equal(element('btn-install-update').textContent, '重新打开安装器');
  assert.match(element('update-progress-detail').textContent, /macOS 安装器/);
  assert.equal(messages.at(-1).kind, 'info');
  assert.equal(ctx.appUpdateInstalling, false);
  await ctx.installAppUpdate({preventDefault() {}});
  assert.equal(messages.length, 2, 'A canceled Installer can be reopened');
  // Failed launch exposes the cause and releases the button for another attempt.
  ctx.api = async () => ({status: 'failed', phase: 'failed', error: 'Installer unavailable'});
  await ctx.installAppUpdate({preventDefault() {}});
  assert.equal(element('update-dialog').open, true);
  assert.equal(element('btn-install-update').disabled, false);
  assert.equal(element('update-progress-detail').textContent, 'Installer unavailable');
  assert.equal(messages.at(-1).kind, 'error');
  assert.equal(ctx.appUpdateInstalling, false);
  // Windows keeps its existing handoff behavior.
  ctx.api = async () => ({status: 'completed', phase: 'launched', message: 'Installer started'});
  await ctx.installAppUpdate({preventDefault() {}});
  assert.equal(element('update-dialog').open, false);
  assert.equal(messages.at(-1).kind, 'success');
  console.log('PASS update dialog Installer handoff, cancellation retry and launch failure');
})().catch(error => { console.error(error); process.exitCode = 1; });
