const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('path').join(__dirname,'../app/web/static/app.js'),'utf8');
const nodes=new Map();
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',classList:{hidden:false,contains(){return this.hidden},add(){this.hidden=true}},appendChild(){}});return nodes.get(id)};
const requests=[];
const c=vm.createContext({mailaiT: () => null,console,Map,AbortController,localStorage:{getItem:()=>''},document:{getElementById:node},
  activeMailAccount:()=>({id:'a'}),renderDigest:x=>x,esc:String,toast(){},setDigestTitle(){},setLoading(){},localDateKey:()=> '2026-09-10',
  api:(url,opts)=>new Promise((resolve,reject)=>requests.push({url,opts,resolve,reject}))});
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
  assert.equal(requests.filter(r=>r.url==='/api/digest').length,1,'Double generation must share one request');
  const history=c.loadDigestById(6,'a');requests[6].resolve({content:'historical'});await history;
  requests[5].resolve({digest:'generated'});await Promise.all([first,second]);
  assert.equal(node('digest-body').innerHTML,'historical','Generation must not take over history selection');
  first=c.loadDigestById(7,'a');vm.runInContext('_digestAccountId="b"',c);requests[7].reject(Error('A failure'));await first;
  assert.ok(!node('digest-body').innerHTML.includes('A failure'));
  console.log('PASS digest latest selection, old success/failure, close/account guards and deduplicated generation');
})().catch(e=>{console.error(e);process.exitCode=1});
