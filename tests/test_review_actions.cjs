const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const start = js.indexOf('// 操作按钮');
const end = js.indexOf("document.getElementById('reading-content').innerHTML", start);
const actions = js.slice(start, end);

assert.ok(start >= 0 && end > start, 'Mail decision actions should be present');
assert.doesNotMatch(actions, /confirmEmail\([^\n]+['\"]正常['\"]/,
  'A suspicious message must never use confirmation-of-current-verdict as a normal correction');
assert.doesNotMatch(actions, /举报误报（应为正常）|标记误报（应为正常）/,
  'Duplicate technical false-positive wording should not be shown to end users');
assert.match(actions, /e\.verdict === 'phishing' \|\| e\.verdict === 'suspicious'[\s\S]*feedbackEmail\(\$\{e\.id\}, 'fp'\)[^\n]*标记为正常/,
  'Suspicious and phishing mail should use the false-positive correction flow');
assert.match(actions, /确认无风险[\s\S]*报告风险/,
  'Clean mail should offer mutually exclusive confirmation and missed-risk feedback');
assert.match(actions, /保留隔离[\s\S]*标记为正常/,
  'Quarantined mail should distinguish retaining quarantine from correcting the verdict');
assert.match(js, /只处理当前邮件[^\n]*storedAway \? mailaiText\('邮件将标记为正常，并恢复到收件箱。'\) : mailaiText\('邮件将标记为正常，并保留在当前文件夹。'\)/,
  'The correction dialog should describe the current folder outcome and single-message scope');
assert.match(js, /trusted_sender=' \+ trustedSender/,
  'Selecting a trusted sender reason should explicitly request an address allowlist entry');
assert.match(js, /该邮箱地址会加入本机白名单，今后不再触发常规误报，但高危证据仍会报警/,
  'The correction dialog should explain address scope and the high-risk safety fallback');

console.log('Review actions match their visible labels and avoid contradictory choices');

// A translated UI must still identify the raw service error and refresh the
// mailbox after another client has removed the message.
(async () => {
  const vm = require('node:vm');
  const i18n = require('./helpers/i18n.cjs');
  const confirmSource = js.slice(js.indexOf('async function confirmEmail('), js.indexOf('\nconst feedbackReasonOptions'));
  const missingMessage = '服务器中已找不到这封邮件，可能已被其他客户端移动或删除；本地列表已刷新';
  for (const language of ['zh-CN', 'en']) {
    const calls = [];
    const context = i18n({
      localStorage: {getItem: key => key === 'mailai-language' ? language : null},
      api: async () => { throw new Error(missingMessage); },
      toast: (message, type) => calls.push({message, type}),
      resetReadingPane: () => calls.push('reset'),
      loadData: async () => calls.push('mailbox'),
      loadMailboxFolders: async () => calls.push('folders'),
      setLoading: (_button, loading) => calls.push(loading),
    });
    vm.createContext(context);
    vm.runInContext(confirmSource, context);
    await context.confirmEmail(42, context.mailaiText('结果'), {isConnected: true});
    assert.equal(calls[1].type, 'warn');
    assert.equal(calls[1].message, context.mailaiSystemMessage(missingMessage));
    assert(language !== 'en' || !/[\u3400-\u9fff]/.test(calls[1].message));
    assert.deepEqual(calls.filter(value => typeof value === 'string'), ['reset', 'mailbox', 'folders']);
    assert.equal(calls.at(-1), false, 'Restore the action button after recovery');
  }
  console.log('Remote message recovery works in Chinese and English');
})().catch(error => { console.error(error); process.exitCode = 1; });
