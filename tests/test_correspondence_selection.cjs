const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const start = source.indexOf('let correspondenceRevision = 0;');
const end = source.indexOf('\nfunction renderThreadContext(', start);
const bodyNode = {innerHTML: ''};
const apiCalls = [];
let refreshes = 0;
let confirmation = '';
let activeAccountId = 'account-one';
const context = vm.createContext({
  Set, Number,
  document: {
    body: {style: {}},
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: id => id === 'correspondence-body' ? bodyNode : null,
  },
  window: {confirm: message => { confirmation = message; return true; }},
  mailboxFolders: [{name: 'Trash', flags: ['\\Trash']}],
  selectedEmailAccountId: 'account-one',
  activeMailAccount: () => ({id: activeAccountId}),
  getRiskLabel: () => ({class: 'safe', text: '正常'}),
  esc: value => String(value || ''),
  fmtDate: value => value,
  api: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    apiCalls.push({url, options, body});
    return {completed: body?.ids.length || 0, failed: []};
  },
  loadData: async () => { refreshes += 1; },
  toast: () => {},
});
vm.runInContext(source.slice(start, end), context);

const data = {counterpart: 'person@example.test', emails: [
  {id: 11, subject: '第一封', status: 'inbox', direction: 'received'},
  {id: 12, subject: '第二封', status: 'sent', direction: 'sent'},
  {id: 13, subject: '已删除', status: 'trash', direction: 'received'},
]};
context.testData = data;
const rendered = vm.runInContext('renderCorrespondence(testData, 11)', context);
assert.match(rendered, /data-correspondence-select="11"/);
assert.match(rendered, /data-correspondence-select="12"/);
assert.doesNotMatch(rendered, /data-correspondence-select="13"/);
assert.match(rendered, /全选（2）/);

vm.runInContext('correspondenceData=testData; correspondenceCurrentId=11; correspondenceAccountId="account-one"; correspondenceSelectedIds=new Set([11,12])', context);
(async () => {
  await vm.runInContext('deleteSelectedCorrespondence()', context);
  assert.match(confirmation, /选中的 2 封/);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].url, '/api/emails/bulk');
  assert.equal(apiCalls[0].options.accountId, 'account-one');
  assert.deepEqual(apiCalls[0].body, {ids: [11, 12], action: 'trash'});
  assert.equal(refreshes, 1);
  assert.match(bodyNode.innerHTML, /往来邮件已清空/);
  assert.match(bodyNode.innerHTML, /已将 2 封邮件移入垃圾箱/);
  assert.doesNotMatch(bodyNode.innerHTML, /data-correspondence-select=/);
  assert.equal(vm.runInContext('correspondenceData.emails.every(item => item.status === "trash")', context), true);
  assert.equal(vm.runInContext('correspondenceSelectedIds.size', context), 0);

  activeAccountId = 'account-one';
  context.testData = {counterpart: 'other@example.test', emails: [{id: 21, status: 'inbox', direction: 'received'}]};
  vm.runInContext('correspondenceData=testData; correspondenceAccountId="account-two"; correspondenceSelectedIds=new Set([21])', context);
  await vm.runInContext('deleteSelectedCorrespondence()', context);
  assert.equal(apiCalls.at(-1).options.accountId, 'account-two');
  assert.deepEqual(apiCalls.at(-1).body, {ids: [21], action: 'trash'});
  assert.equal(refreshes, 1, 'Deleting in a background mailbox must not repaint the active mailbox');
  context.api = async () => ({failed: [{id: 31, error: '服务器繁忙'}]});
  context.testData = {emails: [{id:31,status:'inbox'}, {id:32,status:'inbox'}]};
  vm.runInContext('correspondenceData=testData; correspondenceSelectedIds=new Set([31,32])', context);
  await vm.runInContext('deleteSelectedCorrespondence()', context);
  assert.match(bodyNode.innerHTML, /data-correspondence-select="31"/);
  assert.doesNotMatch(bodyNode.innerHTML, /data-correspondence-select="32"/);
  assert.match(bodyNode.innerHTML, /服务器繁忙/);
  assert.equal(vm.runInContext('correspondenceSelectedIds.has(31) && correspondenceSelectedIds.size === 1', context), true);
  assert.equal(vm.runInContext('correspondenceProcessedCount', context), 2);
  console.log('Correspondence selection, account-scoped trash move and immediate state reconciliation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
