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
let loadCount=0, folderLoadCount=0, syncCount=0, sidebarRenders=0;
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id,{value:'',textContent:'',innerHTML:'',checked:false});
  return elements.get(id);
};
Object.assign(ctx, {
  bulkOperationActive:false, resetReadingPane(){}, clearMailSelection(){}, activateMailAccount:async()=>{ assert.ok(sidebarRenders>=1, 'sidebar should highlight the clicked account before the activation round-trip'); },
  activeMailAccount:()=>({id:'a'}), currentFilter:{days:9999,status:'',search:'',verdict:'',category:'',priority:'',domain:'',attachments:false},
  specialMailbox:'',currentServerFolder:'',unifiedMailbox:false,selectedMailboxAccountId:'',searchResults:null,searchRevision:0,globalSearchTimer:null,
  document:{getElementById:element}, clearTimeout(){}, setSegmentedFilter(){},
  loadData:async()=>{loadCount++}, loadMailboxFolders:async()=>{folderLoadCount++},
  api:async()=>{syncCount++}, updateActiveNav(){}, renderSidebarAccounts(){sidebarRenders++}, toast(){},
});
vm.runInContext(open,ctx);
(async()=>{
 await ctx.openAccountMailbox('a','trash');
 assert.equal(ctx.currentFilter.status,'trash');
 assert.equal(folderLoadCount,1,'trash navigation should discover folders once');
 assert.equal(syncCount,1,'server trash should sync once');
 assert.equal(loadCount,1,'trash list should render only once after sync');
 assert.equal(element('list-title').textContent,'已删除');
 assert.match(element('email-list').innerHTML,/正在读取已删除邮件/);
 assert.ok(sidebarRenders>=1,'selected trash state should render immediately');
 console.log('Trash role detection and single-render account navigation passed');
})().catch(e=>{console.error(e);process.exitCode=1});
