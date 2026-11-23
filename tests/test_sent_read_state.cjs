const i18nContext = require('./helpers/i18n.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname,'../app/web/static/app.js'),'utf8');
const start = source.indexOf('function specialMailboxRows()');
const end = source.indexOf('// ===== 阅读区 =====', start);
const ctx = {
  document:{body:{dataset:{}}}, activeMailAccount:()=>({user:'owner@example.test'}),
  currentFilter:{status:''}, specialMailbox:'sent', currentServerFolder:'', unifiedMailbox:false,
  serverFolderForRole:()=>null, selectedEmailId:null, selectedMailIds:new Set(),
  getRiskLabel:()=>({class:'normal',text:'正常'}), getDomain:value=>String(value).split('@')[1] || '',
  esc:value=>String(value ?? ''), fmtDate:()=>'', needsRiskAttention:()=>false,
};
vm.createContext(i18nContext(ctx)); vm.runInContext(source.slice(start,end),ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/web/static/mail-list-view.js'),'utf8').split('(() => {')[0],ctx);
ctx.sentMessages=[{id:1,to_addr:'receiver@example.test',subject:'已发送',status:'sent',is_read:0}];
ctx.savedDrafts=[];
const sent=ctx.specialMailboxRows()[0];
assert.equal(sent.is_read,1,'Sent rows are normalized as read for presentation');
let html=ctx.renderEmailItem(sent);
assert.match(html,/outgoing-mail/);
assert.match(html,/data-read-state="not-applicable"/);
assert.doesNotMatch(html,/\bunread\b|未读邮件/);
ctx.specialMailbox='';
html=ctx.renderEmailItem({id:2,direction:'outgoing',to_addr:'receiver@example.test',counterpart_addr:'receiver@example.test',subject:'服务器已发送',status:'sent',is_read:0});
assert.match(html,/outgoing-mail/);
assert.doesNotMatch(html,/\bunread\b|未读邮件/,'Outgoing server mail must ignore an IMAP unseen flag');
html=ctx.renderEmailItem({id:3,direction:'incoming',from_addr:'sender@example.test',subject:'新邮件',status:'inbox',is_read:0});
assert.match(html,/class="email-item[^\"]*\bunread\b/);
assert.match(html,/未读邮件/,'Incoming unseen mail must keep its unread marker');
console.log('Sent and outgoing mail never inherit inbox unread presentation');

ctx.selectedEmailId=3; ctx.selectedEmailAccountId='work';
const base={id:3,subject:'相同本地编号',from_addr:'colleague@example.test',status:'inbox',is_read:1};
assert.match(ctx.renderEmailItem({...base,_account_id:'work'}),/class="email-item selected/);
assert.doesNotMatch(ctx.renderEmailItem({...base,_account_id:'personal'}),/class="email-item selected/,
  'Rerendering a unified inbox must not highlight another account’s matching local ID');
console.log('Unified inbox selection stays scoped to the opened account');

// The table keeps real sender/recipient columns even for local sent adapters.
ctx.document.body.dataset.mailListView='table';
html=ctx.renderEmailItem(sent);
assert.match(html,/mail-table-sender[^>]*>owner@example.test/);
assert.match(html,/mail-table-recipient[^>]*>receiver@example.test/);
assert.match(html,/data-read-state="not-applicable"/);
assert.doesNotMatch(html,/class="email-item[^"]*\bunread\b/);
console.log('Classic table preserves sent-mail identity and read state');

// Queued/sending outbox items appear in Sent with accurate state labels and inline undo while queued.
ctx.document.body.dataset.mailListView='cards';
ctx.specialMailbox='sent';
ctx.sentMessages=[
  {id:'outbox:tok-1',outbox_token:'tok-1',_outbox:true,to_addr:'peer@example.test',subject:'待发送',status:'queued',scheduled:false,created_at:'2026-11-23T17:00:00'},
  {id:'outbox:tok-2',outbox_token:'tok-2',_outbox:true,to_addr:'peer@example.test',subject:'发送中',status:'sending',scheduled:false,created_at:'2026-11-23T16:59:00'},
];
const [queuedRow, sendingRow] = ctx.specialMailboxRows();
assert.equal(queuedRow.from_name, '等待发送');
assert.equal(sendingRow.from_name, '发送中');
const queuedHtml = ctx.renderEmailItem(queuedRow);
assert.match(queuedHtml, /data-id="outbox:tok-1"/);
assert.match(queuedHtml, /data-cancel-outbox="tok-1"/);
assert.match(queuedHtml, /撤销发送/);
assert.match(queuedHtml, /risk-badge warn/);
const sendingHtml = ctx.renderEmailItem(sendingRow);
assert.doesNotMatch(sendingHtml, /data-cancel-outbox=/, 'In-flight SMTP rows must not offer cancel');
assert.match(sendingHtml, /发送中/);
assert.doesNotMatch(sendingHtml, /发送失败/);
console.log('Queued and sending outbox items render accurately in Sent with inline undo');
