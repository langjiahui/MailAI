const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const src = fs.readFileSync(require('node:path').join(__dirname,'../app/web/static/app.js'),'utf8');
const resolve = src.slice(src.indexOf('function serverFolderForRole('),src.indexOf('function serverMailboxCounts('));
const ctx = vm.createContext({mailboxFolders:[], mailaiT: () => null});
vm.runInContext(resolve,ctx);
for (const name of ['Trash','Deleted Items','已删除邮件','废纸篓']) {
  ctx.mailboxFolders = [{name:'Spam',flags:['\\Junk']},{name,flags:[]}];
  assert.equal(ctx.serverFolderForRole('trash').name,name);
}
ctx.mailboxFolders = [{name:'Spam',flags:['\\Junk']},{name:'自定义回收站',flags:['\\Trash']}];
assert.equal(ctx.serverFolderForRole('trash').name,'自定义回收站');
assert.equal(ctx.serverFolderForRole('spam').name,'Spam');
const open = src.slice(src.indexOf('async function openAccountMailbox('),src.indexOf('async function openUnifiedInbox('));
let loadCount=0, folderLoadCount=0, syncCount=0, sidebarRenders=0, expectedMailbox='sent';
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id,{value:'',textContent:'',innerHTML:'',checked:false});
  return elements.get(id);
};
Object.assign(ctx, {
  bulkOperationActive:false, resetReadingPane(){}, clearMailSelection(){}, activateMailAccount:async()=>{
    assert.ok(sidebarRenders>=1, 'sidebar should render before the activation round-trip');
    assert.equal(ctx.selectedMailboxAccountId,'a','clicked account should be selected before activation');
    assert.equal(ctx.currentFilter.status,expectedMailbox === 'trash' ? 'trash' : '','clicked standard folder should be selected before activation');
    assert.equal(ctx.specialMailbox,expectedMailbox === 'sent' ? 'sent' : '','clicked special mailbox should be selected before activation');
  },
  activeMailAccount:()=>({id:'a'}), currentFilter:{days:9999,status:'',search:'',verdict:'',category:'',priority:'',domain:'',attachments:false},
  specialMailbox:'',currentServerFolder:'',unifiedMailbox:false,selectedMailboxAccountId:'',searchResults:null,searchRevision:0,globalSearchTimer:null,
  mailboxNavigationRevision:0, mailboxActivationQueue:Promise.resolve(),
  document:{getElementById:element}, clearTimeout(){}, setSegmentedFilter(){},
  loadData:async()=>{loadCount++}, loadMailboxFolders:async()=>{folderLoadCount++;return true},
  api:async()=>{syncCount++}, updateActiveNav(){}, renderSidebarAccounts(){sidebarRenders++}, toast(){},
});
vm.runInContext(open,ctx);
(async()=>{
 await ctx.openAccountMailbox('a','sent');
 assert.equal(ctx.specialMailbox,'sent');
 assert.equal(ctx.currentFilter.status,'');
 assert.equal(loadCount,1,'sent navigation should load its list once');
 assert.equal(folderLoadCount,1,'sent navigation should discover folders once');
 assert.ok(sidebarRenders>=2,'selected sent state should render before and after loading');

 expectedMailbox='trash';
 loadCount=folderLoadCount=syncCount=sidebarRenders=0;
 await ctx.openAccountMailbox('a','trash');
 assert.equal(ctx.currentFilter.status,'trash');
 assert.equal(folderLoadCount,1,'trash navigation should discover folders once');
 assert.equal(syncCount,1,'server trash should sync once');
 assert.equal(loadCount,2,'trash renders local records first, then refreshes after remote sync');
 assert.equal(element('list-title').textContent,'已删除');
 assert.match(element('email-list').innerHTML,/正在读取已删除邮件/);
 assert.ok(sidebarRenders>=2,'selected trash state should render immediately and remain selected after folder discovery');

 // A stalled folder request must not delay local trash rendering.
 let finishFolders;
 loadCount=syncCount=0;
 ctx.loadMailboxFolders=()=>new Promise(resolve=>{finishFolders=resolve});
 const stalled=ctx.openAccountMailbox('a','trash');
 while(!finishFolders) await new Promise(resolve=>setImmediate(resolve));
 assert.equal(loadCount,1,'local trash must load before folder discovery finishes');
 assert.equal(syncCount,0);
 finishFolders(false);
 await stalled;
 assert.equal(loadCount,1,'discovery timeout must retain local records');
 assert.equal(syncCount,0,'failed discovery must not start another blocking IMAP operation');

 // A delayed sync cannot reload or warn over a subsequently selected folder.
 ctx.loadMailboxFolders=async()=>true;
 let finishSync;
 ctx.api=()=>new Promise(resolve=>{finishSync=resolve});
 loadCount=0;
 const syncing=ctx.openAccountMailbox('a','trash');
 while(!finishSync) await new Promise(resolve=>setImmediate(resolve));
 ctx.mailboxNavigationRevision++;
 ctx.currentFilter.status='inbox';
 finishSync({ok:true});
 await syncing;
 assert.equal(loadCount,1,'stale sync must not refresh the newly selected mailbox');
 ctx.api=async()=>{syncCount++};

 // A stale, slower click must never replace the latest requested mailbox state.
 let releaseFirst;
 let activeId='a';
 ctx.activeMailAccount=()=>({id:activeId});
 ctx.activateMailAccount=async accountId=>{
   if(accountId==='b') await new Promise(resolve=>{releaseFirst=()=>{activeId='b';resolve()}});
   else activeId=accountId;
 };
 expectedMailbox='sent';
 const first=ctx.openAccountMailbox('b','sent');
 while(!releaseFirst) await new Promise(resolve=>setImmediate(resolve));
 expectedMailbox='drafts';
 const second=ctx.openAccountMailbox('a','drafts');
 releaseFirst();
 await Promise.all([first,second]);
 assert.equal(ctx.selectedMailboxAccountId,'a','last click must keep its account selected');
 assert.equal(ctx.specialMailbox,'drafts','last click must keep its mailbox selected');
 assert.equal(ctx.unifiedMailbox,false);
 console.log('Trash local-first navigation, timeout fallback and stale-sync protection passed');
})().catch(e=>{console.error(e);process.exitCode=1});
