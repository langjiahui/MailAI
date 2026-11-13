const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const staticDir = path.join(root, 'app/web/static');

const sources = fs
  .readFileSync(path.join(root, 'frontend/sources.txt'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

assert.equal(new Set(sources).size, sources.length, 'frontend/sources.txt must not list duplicate files');
for (const file of sources) {
  assert.ok(fs.existsSync(path.join(staticDir, file)), `Missing source file: ${file}`);
}

const stateIdx = sources.indexOf('mailai-state.js');
const appIdx = sources.indexOf('app.js');
assert.ok(stateIdx >= 0 && stateIdx < appIdx, 'mailai-state.js must load before app.js');

for (const extracted of ['share-links.js', 'signature-manager.js', 'backup-migration.js', 'pane-resizers.js']) {
  const idx = sources.indexOf(extracted);
  assert.ok(idx > appIdx, `${extracted} must load after app.js`);
}

// Verify MailAIState, MailAIModules, and MailAICore runtime contracts in isolation
const events = [];
const stateSource = fs.readFileSync(path.join(staticDir, 'mailai-state.js'), 'utf8');
const context = vm.createContext({
  CustomEvent: class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  },
  localStorage: {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  },
  document: { querySelector: () => null },
  window: null,
});
context.window = {
  dispatchEvent(ev) {
    events.push(ev);
  },
};
vm.runInContext(stateSource, context);

const { MailAIModules, MailAIState, MailAICore } = context.window;
assert.ok(MailAIModules.has('state'), 'state module must self-register');
const notifications = [];
const unsub = MailAIState.subscribe('todos', (next, prev) => notifications.push({ next, prev }));
MailAIState.set('todos', { open: true, accountId: 'acc-1', count: 3 });
MailAIState.set('todos', { open: true, accountId: 'acc-1', count: 3 }); // identical patch -> no duplicate notify
assert.equal(notifications.length, 1, 'identical state patch must not emit redundant subscribers');
assert.equal(JSON.stringify(notifications[0].next), JSON.stringify({ open: true, accountId: 'acc-1', count: 3, loading: false }));
unsub();
MailAIState.set('todos', { count: 4 });
assert.equal(notifications.length, 1, 'unsubscribed listener must not fire');

const snap = MailAIState.snapshot();
snap.todos.count = 999;
assert.equal(MailAIState.get('todos').count, 4, 'snapshot mutation must not corrupt internal state');

assert.equal(MailAICore.readStorage('any', 'fallback'), 'fallback');
assert.equal(MailAICore.writeStorage('any', 'val'), false);

// Ensure extracted modules own their functions and app.js dropped duplicates
const appJs = fs.readFileSync(path.join(staticDir, 'app.js'), 'utf8');
assert.ok(appJs.split('\n').length < 10600, `Expected app.js < 10600 lines after extraction, got ${appJs.split('\n').length}`);

const ownershipChecks = [
  ['share-links.js', ['function openShareLinkDialog(', 'function insertSharedLink(', 'function uploadCosFile(']],
  ['signature-manager.js', ['function openSignatureManager(', 'function saveSignature(', 'function generateSignatures(']],
  ['backup-migration.js', ['function renderBackupItem(', 'function askMigrationPassword(', 'function openLogoutDialog(']],
  ['pane-resizers.js', ['function applyPaneSizes(', 'function initPaneResizers(']],
];
for (const [file, signatures] of ownershipChecks) {
  const code = fs.readFileSync(path.join(staticDir, file), 'utf8');
  assert.ok(code.includes('MailAIModules?.register('), `${file} must register with MailAIModules`);
  for (const sig of signatures) {
    assert.ok(code.includes(sig), `${file} missing ${sig}`);
    assert.ok(!appJs.includes(sig), `app.js must not duplicate extracted ${sig}`);
  }
}

const quickCss = fs.readFileSync(path.join(staticDir, 'todo-quick-actions.css'), 'utf8');
const importantCount = (quickCss.match(/!important/g) || []).length;
assert.ok(importantCount <= 35, `Expected reduced !important count in todo-quick-actions.css (<=35), got ${importantCount}`);

console.log(`PASS frontend modularization & state convergence: app.js=${appJs.split('\n').length} lines, todo-quick-actions !important=${importantCount}, ${sources.length} bundle sources`);
