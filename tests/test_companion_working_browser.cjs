/* Hold model streams open to verify the pet follows real output lifetimes. */
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium,webkit} = require('playwright');
const {reducedMotion}=require('./helpers/media.cjs');
const port=Number(process.env.MAILAI_WORKING_FIXTURE_PORT||18807);
(async()=>{
  const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/workspace_preview.py'],{
    env:{...process.env,MAILAI_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe'],
  });
  let logs='',browser;fixture.stdout.on('data',data=>logs+=data);fixture.stderr.on('data',data=>logs+=data);
  try {
    let ready=false;
    for(let i=0;i<100;i++){
      if(fixture.exitCode!==null)throw Error(logs);
      try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch(_){}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(ready,'Isolated fixture failed to start');
    browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
    const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      const original=window.fetch;
      const streams=new Map();let rejectNext=false;
      window.modelFixture={
        nextFails(){rejectNext=true;},
        push(path,event,close=false){
          const stream=streams.get(path);if(!stream)throw Error('No open stream: '+path);
          if(event)stream.controller.enqueue(new TextEncoder().encode(JSON.stringify(event)+'\n'));
          if(close){stream.dispose();streams.delete(path);stream.controller.close();}
        },
      };
      window.fetch=(url,options={})=>{
        const path=new URL(String(url),location.href).pathname;
        if(!['/api/digest/stream','/api/assistant/ask-stream','/api/mail/compose/assist-stream'].includes(path))return original(url,options);
        if(rejectNext){rejectNext=false;return Promise.resolve(new Response('{"detail":"fixture rejected"}',{status:503,headers:{'Content-Type':'application/json'}}));}
        const signal=options.signal;
        const body=new ReadableStream({start(controller){
          const abort=()=>{streams.delete(path);controller.error(new DOMException('Aborted','AbortError'));};
          signal?.addEventListener('abort',abort,{once:true});
          streams.set(path,{controller,dispose:()=>signal?.removeEventListener('abort',abort)});
        },cancel(){streams.get(path)?.dispose();streams.delete(path);}});
        return Promise.resolve(new Response(body,{headers:{'Content-Type':'application/x-ndjson'}}));
      };
    });
    await page.goto(`http://127.0.0.1:${port}/`);await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(()=>{setI18nLanguage('zh-CN');document.body.classList.remove('companion-still');});
    const busy=()=>page.waitForFunction(()=>document.body.classList.contains('companion-working'));
    const idle=()=>page.waitForFunction(()=>!document.body.classList.contains('companion-working'));
    const loops=selector=>page.locator(selector).evaluate(node=>node.getAnimations().filter(animation=>animation.effect.getTiming().iterations===Infinity).map(animation=>animation.currentTime));
    const progressing=async selector=>{
      // WebKit can expose a pending animation before its timeline starts. Wait
      // for a running clock, then prove it advances instead of sampling at a
      // fixed wall-clock interval that is unreliable on a busy CI runner.
      try {
        await page.waitForFunction(selector=>document.querySelector(selector).getAnimations().some(animation=>animation.effect.getTiming().iterations===Infinity&&animation.playState==='running'&&animation.currentTime!==null),selector);
        const before=await loops(selector);
        await page.waitForFunction(({selector,before})=>document.querySelector(selector).getAnimations().filter(animation=>animation.effect.getTiming().iterations===Infinity).some((animation,index)=>animation.currentTime!==null&&animation.currentTime>before[index]+30),{selector,before},{timeout:5000,polling:100});
      } catch(error) {
        const state=await page.evaluate(selector=>{
          const node=document.querySelector(selector);
          return {selector,body:document.body.className,hidden:document.hidden,focused:document.hasFocus(),
            reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,rig:node?.closest('.mail-companion')?.dataset,
            animations:node?.getAnimations().map(a=>({state:a.playState,time:a.currentTime,loop:a.effect.getTiming().iterations===Infinity}))};
        },selector);
        throw new Error('Work animation did not progress: '+JSON.stringify(state),{cause:error});
      }
    };
    const digest='/api/digest/stream',chat='/api/assistant/ask-stream',compose='/api/mail/compose/assist-stream';
    const emit=(path,event,close)=>page.evaluate(({path,event,close})=>modelFixture.push(path,event,close),{path,event,close});
    // Waiting for the first token is already work; a partial token cannot stop it.
    await page.evaluate(async()=>{await openDigestModal();void generateDigest();});await busy();
    await progressing('#assistant-orb .companion-head');
    await emit(digest,{type:'delta',content:'今日工作小结'});
    assert(await page.locator('#digest-body').textContent().then(text=>text.includes('今日工作')));
    assert(await page.evaluate(()=>document.body.classList.contains('companion-working')));
    await page.screenshot({path:'/tmp/mailai-companion-working-digest.png'});
    await emit(digest,{type:'done',digest:'今日工作小结'},true);await idle();
    assert.equal((await loops('#assistant-orb .companion-head')).length,0,'Final output stops the work loop');
    await page.evaluate(()=>closeDigestModal());
    // Two real streams overlap. Canceling chat leaves the digest work active.
    await page.evaluate(async()=>{await openDigestModal();void generateDigest();closeDigestModal();openAssistant();});
    await page.locator('#assistant-input').fill('帮我总结邮件');await page.locator('#assistant-send').click();await busy();
    await progressing('#assistant-panel .companion-head');
    await page.locator('#assistant-stop').click();
    await page.waitForFunction(()=>!document.getElementById('mail-assistant').classList.contains('state-thinking'));
    assert(await page.evaluate(()=>document.body.classList.contains('companion-working')),'Canceling one request must preserve another');
    await emit(digest,{type:'error',message:'fixture interrupted'},true);await idle();
    await page.evaluate(()=>closeAssistant());
    // A complete chat reply releases the work state and preserves its output.
    await page.evaluate(()=>openAssistant());
    await page.locator('#assistant-input').fill('给我一个简短总结');await page.locator('#assistant-send').click();await busy();
    await emit(chat,{type:'delta',content:'本周进展顺利。'});
    await emit(chat,{type:'done'},true);await idle();
    assert((await page.locator('#assistant-messages').textContent()).includes('本周进展顺利。'));
    await page.evaluate(()=>closeAssistant());
    // HTTP failure before any output also releases the pending work.
    await page.evaluate(async()=>{await openDigestModal();modelFixture.nextFails();void generateDigest();});
    await page.waitForFunction(()=>document.getElementById('digest-body').textContent.includes('fixture rejected'));
    await idle();await page.evaluate(()=>closeDigestModal());
    // Active requests remain tracked while motion is disabled or the native window is hidden.
    await page.evaluate(async()=>{await openDigestModal();void generateDigest();});await busy();
    await reducedMotion(page,'reduce');
    await page.waitForFunction(()=>document.querySelector('#assistant-orb .companion-head').getAnimations().length===0);
    assert(await page.evaluate(()=>document.body.classList.contains('companion-working')));
    await reducedMotion(page,'no-preference');await progressing('#assistant-orb .companion-head');
    await page.evaluate(()=>document.body.classList.add('companion-still'));
    await page.waitForFunction(()=>document.querySelector('#assistant-orb .companion-head').getAnimations().length===0);
    await page.evaluate(()=>document.body.classList.remove('companion-still'));await progressing('#assistant-orb .companion-head');
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('mailai:foreground-changed',{detail:{visible:false}})));
    await page.waitForFunction(()=>document.querySelector('#assistant-orb .companion-head').getAnimations().length===0);
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('mailai:foreground-changed',{detail:{visible:true}})));await progressing('#assistant-orb .companion-head');
    await emit(digest,{type:'done',digest:'已完成'},true);await idle();await page.evaluate(()=>closeDigestModal());
    // Both the writing avatar and the cropped ledge pet work until the stream ends.
    await page.evaluate(()=>{openCompose();toggleComposeAiPanel(true);});
    await page.locator('#compose-ai-instruction').fill('邀请同事参加周五评审');await page.locator('#btn-ai-generate').click();await busy();
    await progressing('.compose-ai-avatar .companion-head');await progressing('#btn-compose-ai .companion-head');
    await emit(compose,{type:'delta',content:'您好，邀请您参加评审。'});
    await emit(compose,{type:'done',content:'您好，邀请您参加评审。',subject:'评审邀请',body:'您好，邀请您参加评审。'},true);await idle();
    assert.equal((await loops('.compose-ai-avatar .companion-head')).length,0);
    assert.equal((await loops('#btn-compose-ai .companion-head')).length,0);
    assert.deepEqual(errors,[]);
    console.log('Companion work: pending and partial output, completion, overlapping requests, chat cancellation, HTTP/stream errors, writing/perch avatars, reduced motion and native visibility passed');
  }finally{
    if(browser)await browser.close();const stopped=once(fixture,'exit');fixture.kill('SIGTERM');if(fixture.exitCode===null)await stopped;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
