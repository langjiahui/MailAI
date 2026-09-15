const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const mailRender = source.slice(source.indexOf('function renderEmailList('), source.indexOf('function shouldShowMailDirection('));
const ruleRender = source.slice(source.indexOf('function renderRuleScenarios('), source.indexOf('async function saveRuleScenario('));

assert.match(mailRender, /const visibleEmails = emails\.slice\(0, mailRenderLimit\)/,
  'mail list must cap rendered DOM nodes');
assert.match(mailRender, /data-render-more-mail/,
  'mail list must expose incremental rendering');
assert.doesNotMatch(ruleRender, /visibleEmails|data-render-more-mail/,
  'mail rendering controls must not leak into unrelated screens');
assert.match(source, /loadMailPages\(mailPath, isCurrent\)/,
  'mailbox loading must use paginated metadata');
assert.match(source, /mailRenderLimit \+= 240/,
  'mail list must allow incremental local rendering');
assert.match(source, /Math\.min\(cursor \+ 80, items\.length\)/,
  'selection styling must be painted in bounded frames');
assert.match(source, /const visibleRows = rows\.slice\(0, todoRenderLimit\)/,
  'todo center must cap rendered DOM nodes');
assert.match(source, /ids\.slice\(start, start \+ 200\)/,
  'large todo mutations must use bounded requests');
assert.doesNotMatch(source.slice(source.indexOf('async function setTodoBatchStatus('),
  source.indexOf('async function openTodoCenter(')), /await loadData\(\)/,
  'todo bulk action must not reload the complete mailbox');
assert.match(source, /querySelectorAll\('#todo-list \[data-todo-select\]'\)/,
  'todo select-all must update visible checkboxes without rebuilding the list');
assert.match(source, /loadData\(\{includeAncillary:false, silent:true\}\)/,
  'mailbox heartbeat must not reload todos, drafts and sent mail');
assert.doesNotMatch(source.slice(source.indexOf('async function refreshMailboxIfChanged'),
  source.indexOf('function startMailboxAutoRefresh')), /loadMailboxFolders\(/,
  'mailbox heartbeat must not open an IMAP folder-list connection');
assert.match(source, /mailboxConfigCheckedAt >= 60000/,
  'full account configuration checks must be throttled');
assert.match(source, /documentElement\.classList\.add\('windows-performance'\)/,
  'Windows desktop must enable the reduced-compositing profile');

console.log('Low-end UI guards: bounded rendering, lightweight refresh and Windows performance profile passed');
