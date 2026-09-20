const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('path').join(__dirname,'../app/web/static/app.js'),'utf8');
const nodes=new Map();
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',classList:{hidden:false,contains(){return this.hidden},add(){this.hidden=true}},appendChild(){}});return nodes.get(id)};
const requests=[];
const streamCalls=[],streamQueues=[];
const encodeLine=obj=>new TextEncoder().encode(JSON.stringify(obj)+'\n');
const c=vm.createContext({mailaiT: () => null,console,Map,AbortController,TextDecoder,TextEncoder,setTimeout,clearTimeout,localStorage:{getItem:()=>''},document:{getElementById:node,createElement:()=>({value:'',textContent:''})},
  activeMailAccount:()=>({id:'a'}),renderDigest:x=>x,esc:String,toast(){},setDigestTitle(){},setLoading(){},localDateKey:()=> '2026-09-10',
  api:(url,opts)=>new Promise((resolve,reject)=>requests.push({url,opts,resolve,reject})),
  fetch:(url,opts)=>{streamCalls.push({url,opts});
    // 每个流一个投喂队列：push({value}) 发分块，push({done:true}) 结束
    const queue=[],waiters=[];
    streamQueues.push(item=>{ if(waiters.length) waiters.shift()(item); else queue.push(item); });
    return Promise.resolve({ok:true,body:{getReader:()=>({read:()=> queue.length ? Promise.resolve(queue.shift()) : new Promise(r=>waiters.push(r))})}});}});
vm.runInContext(source.slice(source.indexOf('let _digestHistory ='),source.indexOf('// ===== 事件绑定 =====',source.indexOf('let _digestHistory ='))),c);
vm.runInContext('_digestAccountId="a"',c);
(async()=>{
  let first=c.loadDigestById(1,'a'),second=c.loadDigestById(2,'a');
  assert.ok(requests[0].opts.signal.aborted);
  requests[1].resolve({content:'new'});await second;
  requests[0].resolve({content:'old'});await first;
  assert.equal(node('digest-body').innerHTML,'new');
  first=c.loadDigestById(3,'a');second=c.loadDigestById(4,'a');
  requests[3].resolve({content:'latest'});await second;
  requests[2].reject(Error('old failure'));await first;
  assert.equal(node('digest-body').innerHTML,'latest');
  first=c.loadDigestById(5,'a');c.closeDigestModal();requests[4].resolve({content:'closed'});await first;
  assert.notEqual(node('digest-body').innerHTML,'closed');
  node('digest-modal').classList.hidden=false;
  first=c.generateDigest();second=c.generateDigest();
  assert.equal(streamCalls.filter(s=>s.url==='/api/digest/stream').length,1,'Double generation must share one stream');
  const history=c.loadDigestById(6,'a');requests[5].resolve({content:'historical'});await history;
  streamQueues[0]({value:encodeLine({type:'done',digest:'generated'})});streamQueues[0]({done:true});
  await Promise.all([first,second]);
  assert.equal(node('digest-body').innerHTML,'historical','Generation must not take over history selection');
  // 流式增量渲染：delta 事件应即时上屏
  first=c.generateDigest();
  await new Promise(r=>setTimeout(r,0));
  streamQueues[1]({value:encodeLine({type:'delta',content:'第一段'})});
  await new Promise(r=>setTimeout(r,0));
  assert.equal(node('digest-body').innerHTML,'第一段','First delta must paint immediately');
  streamQueues[1]({value:encodeLine({type:'done',digest:'第一段完整日报'})});streamQueues[1]({done:true});
  await new Promise(r=>setTimeout(r,0));
  requests[6].resolve([{id:9,digest_date:'2026-09-10'}]);
  await first;
  assert.equal(node('digest-body').innerHTML,'第一段完整日报');
  first=c.loadDigestById(7,'a');vm.runInContext('_digestAccountId="b"',c);requests[7].reject(Error('A failure'));await first;
  assert.ok(!node('digest-body').innerHTML.includes('A failure'));
  console.log('PASS digest latest selection, old success/failure, close/account guards, deduplicated streaming generation and incremental paint');
})().catch(e=>{console.error(e);process.exitCode=1});
