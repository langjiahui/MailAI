const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '../app/web/static');
const workspace = fs.readFileSync(path.join(root, 'workspace.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function undoHarness() {
  let now = 1000;
  const calls = [], notices = [];
  const context = vm.createContext({URLSearchParams, Date:{now:() => now},
    _systemConfig:{accounts:[{id:'a',user:'work@example.test'}]},
    taskNotice:(...args) => notices.push(args), loadData:async () => {},
    api:async (url, options) => { calls.push({url, account:options.accountId}); return {failed:[]}; },
  });
  vm.runInContext('let undoOperations = [], latestUndoAction = null, undoInProgress = false;\n' +
    workspace.slice(workspace.indexOf('function describeMailUndo('), workspace.indexOf("document.addEventListener('keydown'")), context);
  return {context, calls, notices, advance:ms => now += ms,
    undo:() => vm.runInContext('latestUndoAction?.()', context),
    count:() => vm.runInContext('undoOperations.length', context)};
}

async function undoCases() {
  const h = undoHarness();
  h.context.offerUndo(['a1'], 'a', {label:'标为已读',count:3});
  h.context.offerUndo(['b1'], 'b');
  await h.undo();
  assert.deepEqual(h.calls, [{url:'/api/mail/undo/b1',account:'b'}]);
  assert.equal(h.count(), 1, 'One undo must leave the earlier account untouched');
  await h.undo();
  assert.equal(h.calls[1].account, 'a');
  assert.equal(h.count(), 0);

  const batch = undoHarness();
  batch.context.offerUndo(['older'], 'a');
  batch.context.offerUndo(['part1','part2'], 'a', {label:'标为已读',count:150});
  await batch.undo();
  assert.deepEqual(batch.calls.map(row => row.url), ['/api/mail/undo/part2','/api/mail/undo/part1']);
  assert.equal(batch.count(), 1, 'A multi-request batch remains one user operation');

  const failure = undoHarness();
  failure.context.offerUndo(['old'], 'a');
  failure.context.offerUndo(['partial'], 'b');
  let first = true;
  failure.context.api = async (url, options) => {
    failure.calls.push({url,account:options.accountId});
    if (first) { first = false; return {failed:[{id:2}],retry_token:'retry-only'}; }
    return {failed:[]};
  };
  await failure.undo();
  assert.match(failure.notices.at(-1)[1], /重试本次/);
  await failure.notices.at(-1)[2]();
  assert.deepEqual(failure.calls.map(row => row.url), ['/api/mail/undo/partial','/api/mail/undo/retry-only']);
  assert.equal(failure.count(), 1);

  const expired = undoHarness();
  expired.context.offerUndo(['expired'], 'a');
  const staleButton = expired.notices.at(-1)[2];
  expired.advance(120001);
  expired.context.offerUndo(['new'], 'b');
  await staleButton();
  assert.equal(expired.calls.length, 0, 'An old notice must not undo a different operation');
  await expired.undo();
  assert.equal(expired.calls[0].url, '/api/mail/undo/new');

  const concurrent = undoHarness();
  concurrent.context.offerUndo(['first'], 'a');
  let release;
  concurrent.context.api = async url => {
    concurrent.calls.push(url);
    await new Promise(resolve => { release = resolve; });
    return {failed:[]};
  };
  const pending = concurrent.undo();
  await concurrent.undo();
  concurrent.context.offerUndo(['later'], 'b');
  const latestNotice = concurrent.notices.at(-1);
  release(); await pending;
  assert.equal(concurrent.calls.length, 1, 'Repeated clicks cannot replay an in-flight undo');
  assert.equal(concurrent.notices.at(-1), latestNotice, 'A late undo result cannot hide the new operation');
  assert.equal(concurrent.count(), 1);

  const refresh = undoHarness();
  refresh.context.offerUndo(['once'], 'a');
  refresh.context.loadData = async () => { throw Error('refresh failed'); };
  await refresh.undo(); await refresh.undo();
  assert.equal(refresh.calls.length, 1, 'A refresh failure must never replay a successful mutation');
  const details = h.context.describeMailUndo('/api/emails/bulk', JSON.stringify({action:'read',value:false}), {completed:4}, 'a');
  assert.deepEqual(plain(details), {label:'标为未读',count:4,accountLabel:'work@example.test'});
  assert.equal(h.context.describeMailUndo('/api/emails/bulk', '{"action":"move"}', {completed:4,reconciled:1}, 'a').count, 3);
}

async function bulkCollectionCase() {
  const requests = [], offered = [];
  const context = vm.createContext({JSON, Date, URLSearchParams, AbortController, setTimeout, clearTimeout,
    window:{}, API:'', activeMailAccount:() => ({id:'a'}), document:{body:{classList:{contains:() => false}}},
    offerUndo:(...args) => offered.push(args), describeMailUndo:() => ({label:'标为已读',count:100}),
    fetch:async (url, options) => { requests.push(options); return {ok:true,json:async () => ({undo_token:'part',completed:100})}; },
  });
  const start = app.indexOf('async function api(');
  vm.runInContext(app.slice(start, app.indexOf('\nfunction ', start)), context);
  const collector = [];
  await context.api('/api/emails/bulk', {method:'POST',undoCollector:collector,body:'{}'});
  assert.equal(offered.length, 0, 'Batch chunks must not create separate undo notices');
  assert.equal(collector.length, 1);
  assert.equal('undoCollector' in requests[0], false, 'Local grouping metadata must not reach fetch');
  await context.api('/api/emails/bulk', {method:'POST',body:'{}'});
  assert.equal(offered.length, 1, 'A standalone action should immediately offer undo');

  const bulk = vm.createContext({selectedMailIds:new Set(Array.from({length:205}, (_,i) => i + 1)),
    unifiedMailbox:false, bulkOperationActive:false, currentFilter:{status:'inbox'},
    activeMailAccount:() => ({id:'a'}), setBulkOperationState(){}, setLocalEmailReadState(){},
    api:async (url, options) => {
      const payload = JSON.parse(options.body);
      options.undoCollector.push({token:'chunk-' + payload.ids[0],at:Date.now(),details:{label:'标为已读',count:payload.ids.length}});
      return {completed:payload.ids.length,failed:[]};
    }, offerUndo:(...args) => offered.push(args), toast(){}, loadData:async () => {},
  });
  vm.runInContext(app.slice(app.indexOf('async function runBulkAction('), app.indexOf('async function purgeTrash(')), bulk);
  await bulk.runBulkAction('read');
  assert.equal(offered.length, 2);
  assert.equal(offered.at(-1)[0].length, 3);
  assert.equal(offered.at(-1)[2].count, 205);
}

function assistantCases() {
  const nodes = {'assistant-scope':{value:'account'},'assistant-scope-label':{},
    'assistant-scope-note':{},'assistant-scope-clear':{classList:{toggle(){}}}};
  let resets = 0, opens = 0, chatOpens = 0, account = 'a';
  const context = vm.createContext({JSON, Number, assistantScopeKey:'',assistantPinnedScope:[11],assistantHistoryLoaded:false,
    window:{showSecretaryChat(){chatOpens++;}},
    selectedEmailId:22, selectedEmailDetail:{id:22,subject:'邮件 B'},allEmails:[{id:11,subject:'邮件 A'}],
    activeMailAccount:() => ({id:account,user:account + '@example.test'}),
    resetAssistantConversation(){resets++;context.assistantRevision++;},assistantRevision:0,
    openAssistant(){opens++;assert.equal(context.assistantHistoryLoaded,true);},
    document:{getElementById:id => nodes[id],querySelector:() => ({setAttribute(){}}),querySelectorAll:() => []},
  });
  vm.runInContext(workspace.slice(workspace.indexOf('function openAssistantForEmail('), workspace.indexOf('function addReadingActions(')) +
    workspace.slice(workspace.indexOf('function updateAssistantScopeControl('), workspace.indexOf('function updateAssistantPlacement(')), context);
  context.openAssistantForEmail({id:22});
  assert.deepEqual(plain(context.assistantPinnedScope), [22]);
  assert.equal(nodes['assistant-scope-label'].textContent, '邮件 B');
  assert.match(nodes['assistant-scope-note'].textContent, /已固定 1 封/);
  assert.equal(resets, 1);
  context.openAssistantForEmail({id:22});
  assert.equal(resets, 1, 'Reopening the same mail must retain the conversation');

  // Merely reading another mail does not steal the current conversation.
  context.selectedEmailId = 11; context.selectedEmailDetail = {id:11,subject:'邮件 A'};
  context.updateAssistantScopeControl();
  assert.deepEqual(plain(context.assistantPinnedScope), [22]);
  context.openAssistantForEmail({id:11});
  assert.equal(resets, 2);
  assert.deepEqual(plain(context.assistantPinnedScope), [11]);
  account = 'b'; context.openAssistantForEmail({id:11});
  assert.equal(resets, 3, 'Equal mail IDs in different accounts are different contexts');
  assert.equal(opens, 4);
  assert.equal(chatOpens, 4, 'Mail entry must show chat even if the briefing tab was open');
  context.selectedEmailDetail = {id:22,subject:'邮件 B'};
  context.allEmails = [{id:11,_account_id:'a',subject:'其他账号的同编号邮件'}, {id:11,_account_id:'b',subject:'本账号的邮件'}];
  context.updateAssistantScopeControl();
  assert.equal(nodes['assistant-scope-label'].textContent, '本账号的邮件');

  const start = app.indexOf("  let mode = document.getElementById('assistant-scope').value;", app.indexOf('async function askAssistant('));
  const end = app.indexOf('  let inlineImageCount', start);
  context.explicitIds = null; context.images = []; context.account = {id:'b'};
  context.question = '截止日期是什么'; context.assistantQuestionReferencesOpenEmail = () => false;
  context.assistantPinnedScope = null; context.selectedEmailId = 22;
  const select = '(function(){' + app.slice(start, end) + ';return emailIds;})()';
  assert.deepEqual(plain(vm.runInContext(select, context)), [22]);
  context.selectedEmailId = 11;
  assert.deepEqual(plain(vm.runInContext(select, context)), [22], 'An ordinary follow-up retains the pinned mail');
}

(async () => {
  await undoCases(); await bulkCollectionCase(); assistantCases();
  console.log('PASS per-operation undo, batches, retries, expiry, concurrent actions, refresh failure and explicit/follow-up assistant context');
})().catch(error => {console.error(error);process.exitCode = 1;});
