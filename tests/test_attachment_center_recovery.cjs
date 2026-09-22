const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('app/web/static/app.js','utf8');
const nodes=Object.fromEntries(['attachment-search','attachment-count','attachment-grid','attachment-account-label','attachment-center'].map(id=>[id,{value:'',innerHTML:'',classList:{add(){},remove(){}}}]));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let pending=deferred(); const accounts=[];
const c=vm.createContext({attachmentItems:[],attachmentTypeFilter:'all',
 document:{getElementById:id=>nodes[id],body:{classList:{add(){},remove(){}}}},
 activeMailAccount:()=>({id:'a',user:'A'}),closeAssistant(){},updateAttachmentTypeFilters(){},
 api:async(url,options)=>{accounts.push(options.accountId);return pending.promise;},esc:x=>x,
 animateCountText:(node,n,format)=>node.textContent=format(n),mailaiT:()=>''});
vm.runInContext(source.slice(source.indexOf('let attachmentCenterAccountId ='),source.indexOf('function mailboxResourceUrl(')),c);
(async()=>{
 const initial=c.openAttachmentCenter();
 c.renderAttachmentCenter();assert.ok(nodes['attachment-grid'].innerHTML.includes('正在整理附件'));
 pending.reject(new Error('offline'));await initial;
 nodes['attachment-search'].value='合同';c.attachmentTypeFilter='pdf';c.renderAttachmentCenter();
 assert.ok(nodes['attachment-grid'].innerHTML.includes('重新加载'),'Filters must retain the retry action after failure');
 assert.ok(!nodes['attachment-grid'].innerHTML.includes('没有找到'));
 c.activeMailAccount=()=>({id:'b',user:'B'});pending=deferred();const retry=c.loadAttachmentCenter();
 pending.resolve([]);await retry;
 assert.deepEqual(accounts,['a','a'],'Retry belongs to the opened center, even when browsing changes');
 assert.equal(nodes['attachment-search'].value,'合同');assert.equal(c.attachmentTypeFilter,'pdf');
 assert.ok(nodes['attachment-grid'].innerHTML.includes('没有找到'),'Only successful loads may report no matches');
 pending=deferred();const stale=c.loadAttachmentCenter(),old=pending;
 pending=deferred();const reopened=c.openAttachmentCenter();pending.resolve([]);await reopened;
 old.reject(new Error('old error'));await stale;
 assert.ok(!nodes['attachment-grid'].innerHTML.includes('old error'));
 pending=deferred();const closed=c.loadAttachmentCenter();c.closeAttachmentCenter();pending.reject(new Error('closed error'));await closed;
 assert.ok(!nodes['attachment-grid'].innerHTML.includes('closed error'));
 console.log('PASS attachment loading/error/empty distinctions, retry scope, filter retention and stale responses');
})().catch(error=>{console.error(error);process.exitCode=1;});
