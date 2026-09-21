const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const src = fs.readFileSync('app/web/static/app.js', 'utf8');
function extract(start, end) { return src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start))); }
const elements = new Map();
function fakeElement() {
  const classes = new Set();
  return {children:[], get firstChild(){return this.children[0];},
    appendChild(child){if(child.parent)child.parent.children.splice(child.parent.children.indexOf(child),1);this.children.push(child);child.parent=this;},
    querySelector(){return null;},
    classList:{add(value){classes.add(value);},remove(value){classes.delete(value);},toggle(value, hide){hide?classes.add(value):classes.delete(value);},contains(value){return classes.has(value);}},
    textContent:'',innerHTML:''};
}
function element(id) {
  if (!elements.has(id)) elements.set(id, fakeElement());
  return elements.get(id);
}
const context = vm.createContext({Number, JSON, console, setTimeout:()=>0, clearTimeout(){},
  document:{getElementById:element,createElement:fakeElement}, activeMailAccount:()=>({id:'a'}), toast(){},
  localStorage:{getItem(){return null;}}, esc:value=>String(value).replaceAll('<','&lt;'), _systemConfig:{accounts:[]},
  assistantAlerts:null, assistantController:null, assistantNoticeKey:'', assistantAlertTimer:0,
  assistantAlertContextIds:[], assistantPinnedScope:null, assistantScopeKey:'',
  resetAssistantConversation(options){
    assert.equal(options.focus,false,'Automatic cleanup must not steal keyboard focus');
    context.assistantController?.abort(); context.assistantController=null;
    context.assistantAlertContextIds=[]; element('assistant-messages').children=[];
  },
  setAssistantState:s=>context.petState=s});
vm.runInContext(extract('let assistantAlertRevision = 0;', '\nfunction analyzeNewAssistantAlerts'), context);
vm.runInContext(extract('async function markAssistantAlertsSeen()', '\nfunction closeAssistant'), context);
vm.runInContext(extract('let mailboxSyncTrackerTimer = 0;', '\nfunction renderSidebarAccounts'), context);
assert.equal(context.assistantNotificationState({level:'danger', alert_level:'calm', new_risk_count:0}), 'calm');
assert.equal(context.assistantNotificationState({alert_level:'warn', new_risk_count:1}), 'warn');
assert.equal(context.accountSyncLabel({credential_available:true, sync_status:'interrupted'}), '上次同步中断');
assert.equal(context.accountSyncLabel({credential_available:true, sync_status:'running', sync_operation:'poll'}), '正在检查新邮件');
assert.equal(context.accountSyncLabel({credential_available:true, sync_status:'running', sync_operation:'fetch_all', sync_total:12, sync_processed:3}), '初始化 3/12');
assert.equal(context.accountSyncLabel({credential_available:true, sync_status:'running', sync_quiet_seconds:100}), '等待服务器响应…');
assert.equal(context.accountSyncLabel({credential_available:true, sync_status:'completed', user:'a@example.test'}), '');
context.renderMailboxSyncTracker([{id:'a',user:'a@example.test',credential_available:true,
  sync_status:'running',sync_operation:'sync_folders',sync_total:5,sync_processed:3,
  sync_folder_progress:[{name:'Sent',total:3,processed:3,status:'completed'},
    {name:'Drafts',total:2,processed:0,status:'running'}]}]);
assert.match(element('mailbox-sync-tracker').innerHTML, /后台同步 1 个邮箱[\s\S]*各邮箱独立更新/,
  'A single account must have a global synchronization tracker');
assert.match(element('mailbox-sync-tracker').innerHTML, /Sent[\s\S]*3\/3 封[\s\S]*Drafts[\s\S]*0\/2 封/,
  'The tracker must identify folders without requiring the user to open them');
assert.match(src, /setTimeout\(\(\) => dismissMailboxSyncTracker\(tracker, signature\), 6500\)/,
  'Completed folder synchronization should leave the sidebar after a short review period');
assert.match(src, /slice\(0, 100\)/, 'UI folder detail must be bounded');
assert.match(src, /mergeAccountSyncState\(accountId, st\)/, 'Active-account polling should reuse its response for tracker updates');
assert.match(src, /sidebar-account-identity[\s\S]{0,400}account\.user\.split\('@'\)\[1\][\s\S]{0,500}account-sync-state/,
  'Account domain must remain stable while per-account progress uses a separate badge');
(async () => {
  let resolveOld;
  context.api = () => new Promise(r=>resolveOld=r);
  const old = context.loadAssistantAlerts();
  context.api = async () => ({level:'danger',alert_level:'calm',new_risk_count:0});
  await context.loadAssistantAlerts();
  resolveOld({level:'danger',alert_level:'danger',new_risk_count:1});
  await old;
  assert.equal(context.petState,'calm','Older poll must not restore a dismissed alert');
  context.assistantAlerts = {alert_level:'danger',new_risk_count:1,new_items:[{id:8}]};
  context.petState = 'danger';
  context.api = async () => {throw Error('offline');};
  await context.markAssistantAlertsSeen();
  assert.equal(context.petState,'danger','Failed acknowledgment must retain notification');
  context.api = async (url, options) => {
    assert.equal(options.accountId,'a');
    if (url.endsWith('/seen')) {assert.deepEqual(JSON.parse(options.body).ids,[8]);return {};}
    return {level:'danger',alert_level:'calm',new_risk_count:0};
  };
  await context.markAssistantAlertsSeen();
  assert.equal(context.petState,'calm');
  context.api = async () => ({alert_level:'calm',new_risk_count:0,latest_mail_id:11,recent_mail_items:[{id:11}],pending_risk_ids:[]});
  await context.loadAssistantAlerts();
  assert.equal(element('assistant-nudge').textContent,'收到 1 封新邮件');
  assert.equal(element('assistant-nudge').classList.contains('hidden'),false);
  await context.loadAssistantAlerts();
  assert.equal(element('assistant-nudge').classList.contains('hidden'),false,'A second refresh must not immediately hide the arrival hint');
  let aborted=false;
  context.assistantController={abort(){aborted=true;}};
  context.assistantAlertContextIds=[8];
  const analysis=fakeElement();analysis.textContent='previous risk analysis';
  element('assistant-messages').appendChild(analysis);
  context.reconcileAssistantRiskAnalysis([8]);
  assert.equal(aborted,false,'Seen is not the same as handled');
  context.reconcileAssistantRiskAnalysis([]);
  assert.equal(aborted,true,'A late stream must not restore handled-risk advice');
  const history=element('assistant-messages').firstChild;
  assert.equal(history.children[0].textContent,'相关邮件已处理 · 查看历史分析');
  assert.equal(history.children[1],analysis,'Keep the analysis available without leaving it expanded');
  assert.equal(context.assistantPinnedScope,null);

  const refresh = vm.createContext({document:{getElementById:()=>({})},Date,
    mailboxRefreshInFlight:false,mailboxRevisionToken:'old',mailboxConfigCheckedAt:Date.now(),
    api:async()=>({revision:'new'}),loadData:async()=>false});
  vm.runInContext(extract('async function refreshMailboxIfChanged(', '\nfunction startMailboxAutoRefresh'),refresh);
  await refresh.refreshMailboxIfChanged();
  assert.equal(refresh.mailboxRevisionToken,'old','Failed list loading must be retried on the next heartbeat');
  refresh.loadData=async()=>true;
  let sidebarRenders=0;
  refresh._systemConfig={accounts:[{id:'work',unread:0}]};
  refresh.activeMailAccount=()=>({id:'work'});
  refresh.renderSidebarAccounts=()=>sidebarRenders++;
  refresh.api=async path=>path==='/api/system/config' ? {accounts:[{id:'work',unread:3}]} : {revision:'new'};
  await refresh.refreshMailboxIfChanged();
  assert.equal(refresh.mailboxRevisionToken,'new');
  assert.equal(refresh._systemConfig.accounts[0].unread,3,'New mail refreshes badges without waiting one minute');
  assert.equal(sidebarRenders,1);
  console.log('Sidebar labels, notification rendering, stale polls and acknowledgment passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
