const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname,'../app/web/static/app.js'),'utf8');
const start = source.indexOf('function specialMailboxRows()');
const end = source.indexOf('// ===== 阅读区 =====', start);
const ctx = {
  currentFilter:{status:''}, specialMailbox:'sent', currentServerFolder:'', unifiedMailbox:false,
  serverFolderForRole:()=>null, selectedEmailId:null, selectedMailIds:new Set(),
  getRiskLabel:()=>({class:'normal',text:'正常'}), getDomain:value=>String(value).split('@')[1] || '',
  esc:value=>String(value ?? ''), fmtDate:()=>'', needsRiskAttention:()=>false,
};
vm.createContext(ctx); vm.runInContext(source.slice(start,end),ctx);
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
