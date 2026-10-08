const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const context={window:{},TextDecoder,Set,Map};vm.createContext(context);
vm.runInContext(fs.readFileSync('app/web/static/diagnostics-progress.js','utf8'),context);
(async()=>{
 const encoder=new TextEncoder(),events=[];
 const first=encoder.encode(JSON.stringify({type:'check',check:{id:'imap',status:'running',detail:'检查中'}})+'\n');
 const next=encoder.encode(JSON.stringify({type:'check',check:{id:'imap',status:'pass',detail:'成功 ✓'}})+'\n');
 const parts=[first,next.slice(0,next.length-5),next.slice(next.length-5)];let index=0,canceled=false,released=false;
 const reader={async read(){if(index===1)assert.equal(events.length,1,'A completed line must be displayed before waiting for another chunk');return index<parts.length?{value:parts[index++],done:false}:{done:true};},async cancel(){canceled=true;},releaseLock(){released=true;}};
 await context.window.mailaiReadDiagnosticStream({body:{getReader:()=>reader}},item=>events.push(item));
 assert.equal(events.length,2);assert.equal(events[1].check.detail,'成功 ✓');assert(canceled&&released);
 let observed=[];
 await context.window.mailaiReadDiagnosticStream({text:async()=>'{"type":"done","data":{"ok":true}}'},item=>observed.push(item));
 assert.equal(observed[0].type,'done');
 let closed=false;
 const bad={body:{getReader:()=>({read:async()=>({value:encoder.encode('not-json\n'),done:false}),cancel:async()=>{closed=true;},releaseLock(){}})}};
 await assert.rejects(()=>context.window.mailaiReadDiagnosticStream(bad,()=>{}));assert(closed);
 console.log('PASS streaming diagnostics: immediate updates, split Unicode chunks, final line and cleanup after errors');
})().catch(error=>{console.error(error);process.exitCode=1;});
