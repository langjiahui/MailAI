const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('app/web/static/conversation-progress.js','utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let request=deferred();const calls=[];const disclosure={open:false};
const host={dataset:{accountId:'a',emailId:'1'},isConnected:true,innerHTML:'',setAttribute(){},removeAttribute(){},querySelector:()=>disclosure};
const c=vm.createContext({document:{getElementById:id=>id==='conversation-progress'?host:{addEventListener(){}}},window:{addEventListener(){}},
 activeMailAccount:()=>({id:'a'}),selectedEmailDetail:{id:1},esc:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),fmtDate:x=>x,
 api:async(url,opts)=>{calls.push([url,opts.accountId]);return request.promise;}});
vm.runInContext(source,c);
const data={account_user:'a@example.test',status:'处理状态待确认',next_step:'请核对',timeline:[{source:'email',id:1,date:'2026-09-22',direction:'incoming',sender:'<b>sender</b>',subject:'<img src=x>',excerpt:'<script>bad()</script>',current:true}],tasks:[],linked_count:1,basis:'待办依据',scope:'仅本邮箱'};
(async()=>{
 data.changes={items:[{before:'周五',after:'下周二',quote:'<script>change</script>',label:'提出调整，待确认',sender:'客户',date:'2026-09-22',source:'email',id:2}],limited:false};
 data.changes.items.push({kind:'amount',before:'100元',after:'120元',comparison:'增加 20 CNY（按原文金额计算）',quote:'总价从100元改为120元。',label:'待核实',sender:'客户',date:'2026-09-22',source:'email',id:3});
 const first=c.loadConversationProgress(host),old=request;request=deferred();const second=c.loadConversationProgress(host);
 request.resolve(data);await second;old.reject(new Error('old failure'));await first;
 assert.ok(!host.innerHTML.includes('old failure'));
 assert.ok(!host.innerHTML.includes('<script>') && !host.innerHTML.includes('<img src=x>'));
 assert.ok(host.innerHTML.includes('&lt;script>'));
 assert.ok(host.innerHTML.includes('原金额：100元') && host.innerHTML.includes('增加 20 CNY'));
 assert.ok(!host.innerHTML.includes('<details'), 'The progress dialog shows its evidence directly');
 assert.ok(host.innerHTML.includes('2 项变化待核对'));
 data.timeline[0].risky=true;
 const riskMarkup=c.conversationProgressMarkup(data);
 assert.ok(riskMarkup.includes('往来中有来源需核实'), 'The dialog retains source risk warnings');
 disclosure.open=true;request=deferred();const refresh=c.loadConversationProgress(host);request.resolve(data);await refresh;
 assert.equal(disclosure.open,true,'Refreshing evidence should retain expansion');
 assert.deepEqual(calls[0],['/api/emails/1/progress','a']);
 request=deferred();const switched=c.loadConversationProgress(host);host.innerHTML='B reading';c.activeMailAccount=()=>({id:'b'});request.resolve(data);await switched;assert.equal(host.innerHTML,'B reading');
 c.activeMailAccount=()=>({id:'a'});request=deferred();const removed=c.loadConversationProgress(host);host.isConnected=false;request.reject(new Error('closed failure'));await removed;assert.equal(host.innerHTML,'B reading');
 host.isConnected=true;let plan;
 c.window.openTaskPlanner=async args=>{plan=args;};
 const button={dataset:{progressTask:'7'},disabled:false,hasAttribute:()=>false};
 await c.handleConversationProgressClick({target:{closest:selector=>selector==='#conversation-progress'?host:button}});
 assert.equal(plan.todoId,7);assert.equal(plan.accountId,'a');assert.ok(!('emailId' in plan),'A task from another message must retain its own source');
 const dialog={open:false};host.closest=()=>dialog;const count=calls.length;
 await c.loadConversationProgress(host);assert.equal(calls.length,count,'Closed progress dialog must not fetch');
 dialog.open=true;request=deferred();const opened=c.loadConversationProgress(host);request.resolve(data);await opened;assert.equal(calls.length,count+1,'Opened dialog loads evidence');
 console.log('PASS progress UI escaping, explicit account requests and stale success/error suppression');
})().catch(error=>{console.error(error);process.exitCode=1;});
