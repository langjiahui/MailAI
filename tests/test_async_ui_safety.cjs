const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname,'../app/web/static/app.js'),'utf8');
const tick = () => new Promise(resolve=>setImmediate(resolve));
const node = () => ({value:'',innerHTML:'',dataset:{},querySelector(){return null;},
  classList:{add(){},remove(){},toggle(){},contains(){return true;}}});

async function preflightCase(change) {
  let resolve;
  const waiting = new Promise(done=>{resolve=done;});
  const nodes = new Map();
  const draft = {to_addr:'old@example.test',cc_addr:'',bcc_addr:'',subject:'original',body_html:'<p>original</p>',mode:'compose',attachments:[]};
  const context = vm.createContext({JSON,Error,AbortController,setTimeout,clearTimeout,draftSession:{},composeAccountId:'a',composeAttachments:[],composeContext:{mode:'compose'},
    draftPayload:()=>({...draft}),composeMessageText:()=> 'original',
    document:{body:{classList:{contains:()=>true}},getElementById:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);}},
    api:async (url, options)=>{assert.equal(options.accountId,'a');await waiting;return {issues:[],recipients:{to_addr:'normalized@example.test',cc_addr:'',bcc_addr:''}};},
    esc:String,toggleComposeAiPanel(){}});
  vm.runInContext(source.slice(source.indexOf('async function runMailPreflight('),source.indexOf('function clearComposePreflight(')),context);
  const pending = context.runMailPreflight({...draft});
  change?.(draft,context);
  resolve();
  if (change) {
    await assert.rejects(pending,/发生了变化/);
    assert.equal(nodes.size,0,'Stale result must not write fields or open a risk dialog');
  } else {
    await pending;assert.equal(nodes.get('compose-to').value,'normalized@example.test');
  }
}

async function preflightTimeout() {
  let cleared = false;
  const context = vm.createContext({JSON,Error,AbortController,draftSession:{},composeAccountId:'a',
    composeAttachments:[],composeContext:{mode:'compose'},composePreflightFingerprint:()=> 'same',
    composeMessageText:()=> 'body',
    setTimeout(callback, ms){assert.equal(ms,15000);return setImmediate(callback);},
    clearTimeout(timer){cleared=true;clearImmediate(timer);},
    api:async(path, options)=>{assert.equal(path,'/api/mail/preflight');return new Promise((resolve,reject)=>{
      options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
    });}});
  const start=source.indexOf('async function runMailPreflight(');
  vm.runInContext(source.slice(start,source.indexOf('function clearComposePreflight(',start)),context);
  await assert.rejects(context.runMailPreflight({}),/安全检查超时，邮件尚未发送/);
  assert.ok(cleared,'Timed-out preflight must release its timer');
}

async function contactSuggestionRace() {
  const requests = [];
  const rendered = [];
  const context = vm.createContext({
    contactSuggestionRevision:0, contactInput:null, composeAccountId:'account-a',
    activeMailAccount:()=>({id:'account-a'}),
    currentContactToken:input=>input.value,
    renderContactSuggestions:items=>rendered.push(items),
    hideContactSuggestions(){},
    encodeURIComponent,
    api:(url, options)=>new Promise(resolve=>requests.push({url, options, resolve})),
  });
  const start = source.indexOf('async function loadContactSuggestions(');
  const end = source.indexOf('function chooseContact(', start);
  vm.runInContext(source.slice(start, end), context);
  const input = {value:'旧查询'};
  const oldRequest = context.loadContactSuggestions(input);
  input.value = '新查询';
  const newRequest = context.loadContactSuggestions(input);
  assert.equal(requests[0].options.accountId, 'account-a');
  requests[1].resolve([{email:'new@example.test'}]);
  await newRequest;
  requests[0].resolve([{email:'old@example.test'}]);
  await oldRequest;
  assert.deepEqual(rendered, [[{email:'new@example.test'}]], 'Late contact suggestions must not replace the current query');
}

async function readingRace() {
  let resolve;
  const waiting = new Promise(done=>{resolve=done;});
  let active = 'a';
  const other = {id:1,is_read:0};
  let readPosts = 0;
  const context = vm.createContext({skeletonRows:()=>'',readingLoadRevision:0,readingLoadController:null,readSyncQueue:[],readSyncRunning:false,readSyncSequence:0,readSyncJobs:new Map(),
    selectedEmailId:null,selectedEmailAccountId:'',selectedEmailDetail:null,AbortController,setTimeout,clearTimeout,
    allEmails:[],searchResults:null,currentFilter:{unread:false},unifiedMailbox:false,CSS:{escape:String},activeMailAccount:()=>({id:active}),toast(){},
    document:{getElementById:node,querySelector:node},syncSelectedEmailVisual(){},renderReadingPane(){},startReadingFlight(){},esc:String,
    api:async(url, options)=>{
      assert.equal(options.accountId,'a');
      if(options.method==='POST'){readPosts++;await waiting;return {ok:true};}
      return {id:1,is_read:0};
    }});
  vm.runInContext(source.slice(source.indexOf('function readSyncKey('),source.indexOf('async function selectUnifiedEmail(')),context);
  await context.selectEmail(1);
  await context.selectEmail(1);
  await tick();
  assert.equal(readPosts,1,'Repeated opens must share one in-flight read-state write');
  assert.equal(context.selectedEmailDetail.is_read,1,'A repeated open must retain the optimistic read state');
  active='b';context.allEmails=[other];resolve();await tick();
  assert.equal(other.is_read,0,'Account A read completion must not mark same ID in B as read');
}

async function readingAbort() {
  const nodes = new Map();
  const getNode = id => { if(!nodes.has(id)) nodes.set(id,node()); return nodes.get(id); };
  const context = vm.createContext({skeletonRows:()=>'',readingLoadRevision:0,readingLoadController:null,readSyncQueue:[],readSyncRunning:false,
    readSyncSequence:0,readSyncJobs:new Map(),selectedEmailId:null,selectedEmailAccountId:'',selectedEmailDetail:null,
    AbortController,setTimeout,clearTimeout,allEmails:[],searchResults:null,currentFilter:{unread:false},unifiedMailbox:false,CSS:{escape:String},
    activeMailAccount:()=>({id:'a'}),toast(){},esc:String,syncSelectedEmailVisual(){},renderReadingPane(){},startReadingFlight(){},
    document:{getElementById:getNode,querySelector:()=>node()},
    api:(url, options)=>{
      if(url.endsWith('/1')) return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{
        const error = new Error('Fetch is aborted'); error.name='AbortError'; reject(error);
      },{once:true}));
      return Promise.resolve({id:2,is_read:1});
    }});
  vm.runInContext(source.slice(source.indexOf('function readSyncKey('),source.indexOf('async function selectUnifiedEmail(')),context);
  const stale = context.selectEmail(1);
  await tick();
  await context.selectEmail(2);
  await stale;
  assert.equal(context.selectedEmailId,2,'Latest click must remain selected after aborting the stale detail request');
  assert.doesNotMatch(getNode('reading-content').innerHTML, /Fetch is aborted/,'Expected request cancellation must stay silent');
}

async function rapidReadingMarksEveryClick() {
  let activeRequest;
  const posts = [];
  let sidebarRenders = 0;
  const rows = [1, 2, 3, 4, 5].map(id => ({id, is_read:0}));
  const context = vm.createContext({skeletonRows:()=>'',readingLoadRevision:0,readingLoadController:null,readSyncQueue:[],readSyncRunning:false,
    readSyncSequence:0,readSyncJobs:new Map(),selectedEmailId:null,selectedEmailAccountId:'',selectedEmailDetail:null,
    AbortController,setTimeout,clearTimeout,allEmails:rows,searchResults:null,currentFilter:{unread:false},unifiedMailbox:false,CSS:{escape:String},
    _systemConfig:{accounts:[{id:'a',active:true,unread:5}]},renderSidebarAccounts(){sidebarRenders++;},
    activeMailAccount:()=>({id:'a'}),toast(){},esc:String,syncSelectedEmailVisual(){},renderReadingPane(){},startReadingFlight(){},
    document:{getElementById:node,querySelector:()=>node()},
    api:(url, options)=>{
      if (options.method === 'POST') { posts.push(Number(url.match(/emails\/(\d+)/)[1])); return Promise.resolve({ok:true}); }
      return new Promise((resolve,reject)=>{
        activeRequest = {resolve,reject};
        options.signal.addEventListener('abort',()=>{const error=Error('aborted');error.name='AbortError';reject(error);},{once:true});
      });
    }});
  vm.runInContext(source.slice(source.indexOf('function readSyncKey('),source.indexOf('async function selectUnifiedEmail(')),context);
  const selections = [];
  for (const row of rows) { selections.push(context.selectEmail(row.id)); await tick(); }
  await tick();
  assert.deepEqual([...posts].sort((a,b)=>a-b), [1,2,3,4,5], 'Every rapid click must queue a read before detail cancellation');
  assert.ok(rows.every(row=>row.is_read===1), 'Every clicked row must become read immediately');
  assert.equal(context._systemConfig.accounts[0].unread, 0, 'Account unread badge must update optimistically');
  assert.equal(sidebarRenders, 5, 'Each changed row must refresh the visible account badge');
  activeRequest.resolve({id:5,is_read:1});
  await Promise.all(selections);
}

(async()=>{
  await preflightCase();
  await preflightCase(draft=>{draft.to_addr='updated@example.test';});
  await preflightCase(draft=>{draft.subject='edited';});
  await preflightCase(draft=>{draft.body_html='<p>new message</p>';});
  await preflightCase((draft,context)=>{context.composeAccountId='b';});
  await preflightCase((draft,context)=>{context.draftSession={};});
  await preflightTimeout();
  await contactSuggestionRace();
  await readingRace();
  await readingAbort();
  await rapidReadingMarksEveryClick();
  console.log('Async UI safety: immutable preflight, account/session changes and late read completion passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
