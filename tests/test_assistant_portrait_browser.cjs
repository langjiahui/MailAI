/* Welcome/header ownership, dynamic rig cleanup and isolation from desktop docking. */
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium,webkit}=require('playwright');
const port=18865;
(async()=>{
 const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/workspace_preview.py'],{env:{...process.env,MAILAI_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let logs='',browser;fixture.stdout.on('data',d=>logs+=d);fixture.stderr.on('data',d=>logs+=d);
 try{
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready,logs);
  for(const engine of [chromium,webkit]){
   browser=await engine.launch();const p=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];p.on('pageerror',e=>errors.push(e.message));
   await p.goto(`http://127.0.0.1:${port}`);await p.locator('#app-preloader').waitFor({state:'hidden'});
   await p.evaluate(()=>{openAssistant();renderAssistantWelcome();});
   const hero=p.locator('.assistant-welcome-portrait'),head=p.locator('#assistant-panel .assistant-head .assistant-mini');
   await hero.locator('svg').waitFor();assert(!await head.isVisible());
   for(const dock of ['left','right','top','bottom']){
    await p.evaluate(d=>document.getElementById('mail-assistant').dataset.petDock=d,dock);
    assert.equal(await hero.locator('.companion-facing').evaluate(n=>getComputedStyle(n).transform),'none');
    assert.equal(await hero.locator('.companion-edge-grip').evaluate(n=>getComputedStyle(n).opacity),'0');
   }
   await p.locator('[data-secretary-view="briefing"]').click();assert(await head.isVisible());assert(!await hero.isVisible());
   await p.locator('[data-secretary-view="chat"]').click();assert(!await head.isVisible());assert(await hero.isVisible());
   for(const [width,height]of [[1440,1000],[900,640],[390,800]])for(const theme of ['light','dark']){
    await p.setViewportSize({width,height});await p.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    assert(await p.locator('#assistant-panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
    await hero.scrollIntoViewIfNeeded();
    assert(await hero.evaluate(n=>{const r=n.getBoundingClientRect(),p=n.closest('#assistant-panel').getBoundingClientRect();return r.left>=p.left&&r.right<=p.right;}));
   }
   await p.setViewportSize({width:1440,height:1000});await p.evaluate(()=>{document.documentElement.dataset.theme='light';renderAssistantWelcome();});
   await p.emulateMedia({reducedMotion:'no-preference'});await hero.hover();
   await p.waitForFunction(()=>document.querySelector('.assistant-welcome-portrait svg').dataset.motionActive==='true');
   await p.evaluate(()=>{window.removedWelcomeSvg=document.querySelector('.assistant-welcome-portrait svg');appendAssistantMessage('user','Synthetic portrait test');});
   assert(!await hero.count());assert(await head.isVisible());
   await p.waitForFunction(()=>removedWelcomeSvg.dataset.motionActive==='false');
   for(let i=0;i<3;i++){await p.evaluate(()=>renderAssistantWelcome());await hero.locator('svg').waitFor();assert.equal(await hero.locator('svg').count(),1);}
   await p.emulateMedia({reducedMotion:'reduce'});await p.waitForFunction(()=>document.querySelector('.assistant-welcome-portrait svg').dataset.motionActive==='false');
   await p.evaluate(()=>closeAssistant());await p.locator('#assistant-panel').waitFor({state:'hidden'});assert(!await hero.isVisible());
   await p.emulateMedia({reducedMotion:'no-preference'});
   // Only explicit opening/entry events animate this portrait. Shared wake,
   // lingering hover, rapid re-entry and foreground resume must not loop it.
   await p.evaluate(()=>{
    const animate=Element.prototype.animate;window.welcomeAnimationCalls=0;
    Element.prototype.animate=function(...args){if(this.closest('.assistant-welcome-portrait'))window.welcomeAnimationCalls++;return animate.apply(this,args);};
   });
   const active=()=>p.waitForFunction(()=>document.querySelector('.assistant-welcome-portrait svg').dataset.motionActive==='true');
   const idle=()=>p.waitForFunction(()=>document.querySelector('.assistant-welcome-portrait svg').dataset.motionActive==='false');
   for(const route of ['nature','ranger']){
    await p.mouse.move(0,0);
    await p.evaluate(async route=>{await api('/api/companion/style',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({style:route})});await mailaiPet.refresh();openAssistant();},route);
    await active();assert.equal(await hero.locator('svg').getAttribute('data-motion-clip'),route==='nature'?'greet':'finWave');
    await idle();await p.waitForTimeout(1450);await hero.hover();await active();
    assert.equal(await hero.locator('svg').getAttribute('data-motion-clip'),route==='nature'?'tilt':'nod');
    const calls=await p.evaluate(()=>welcomeAnimationCalls);
    await p.mouse.move(0,0);await hero.hover();assert.equal(await p.evaluate(()=>welcomeAnimationCalls),calls,'Rapid hover does not restart the response');
    await idle();assert.equal(await hero.locator('svg').evaluate(n=>n.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);
    await p.evaluate(()=>closeAssistant());await p.locator('#assistant-panel').waitFor({state:'hidden'});
   }
   await p.mouse.move(0,0);await p.evaluate(()=>openAssistant());await active();
   await p.evaluate(()=>document.body.classList.add('companion-paused'));await idle();
   await p.evaluate(()=>document.body.classList.remove('companion-paused'));
   const settledCalls=await p.evaluate(()=>welcomeAnimationCalls);
   await p.evaluate(()=>mailaiCompanionMotion.wake());await p.waitForTimeout(16000);
   assert.equal(await p.evaluate(()=>welcomeAnimationCalls),settledCalls,'No ambient/wake/resume animation after settling');
   await hero.hover();await active();await p.evaluate(()=>closeAssistant());await p.locator('#assistant-panel').waitFor({state:'hidden'});await idle();
   await p.emulateMedia({reducedMotion:'reduce'});await p.evaluate(()=>openAssistant());await hero.waitFor();await idle();
   assert.equal(await hero.locator('svg').evaluate(n=>n.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);
   assert.deepEqual(errors,[]);
   console.log(`PASS ${engine.name()}: one visible portrait, four dock modes isolated, responsive/themes, welcome recreation, one-shot greetings, hover cooldown, no idle loops and motion cleanup`);
   await browser.close();browser=null;
  }
 }finally{if(browser)await browser.close();const done=once(fixture,'exit');fixture.kill('SIGTERM');await done;}
})().catch(e=>{console.error(e);process.exitCode=1;});
