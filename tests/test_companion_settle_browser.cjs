// Real animation frames in a disposable mailbox: finish gestures, release work, then sleep.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium,webkit}=require('playwright');
(async()=>{
 const port=18839,base=`http://127.0.0.1:${port}`;
 const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/workspace_preview.py'],{env:{...process.env,MAILAI_FIXTURE_PORT:String(port),MAILAI_REWARD_MOTION_FIXTURE:'1'},stdio:'ignore'});
 let browser;
 try {
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));} assert(ready);
  browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(()=>{openAssistant();appendAssistantMessage('user','Motion continuity fixture');});
  await page.waitForTimeout(4000);
  const selector='#assistant-panel .assistant-mini .mail-companion';
  await page.waitForFunction(s=>document.querySelector(s)?.dataset.motionActive==='false',selector);
  // Inspect real browser transforms around an authored pose: motion should
  // carry velocity through it, rather than brake and restart at every waypoint.
  const flow=await page.evaluate(s=>{
   const svg=document.querySelector(s);mailaiCompanionMotion.react('greet',svg.parentElement);
   const figure=svg.querySelector('.companion-figure');
   const animation=figure.getAnimations().find(a=>!a.animationName);animation.pause();
   const duration=animation.effect.getTiming().duration;
   const angle=()=>{const m=new DOMMatrixReadOnly(getComputedStyle(figure).transform);return Math.atan2(m.b,m.a)*180/Math.PI;};
   const angles=[.505,.51,.515].map(t=>{animation.currentTime=t*duration;return angle();});
   const before=getComputedStyle(figure).transform;
   const beforeAngle=angle();mailaiCompanionMotion.react('happy',svg.parentElement);
   const next=figure.getAnimations().find(a=>!a.animationName).effect.getKeyframes();
   const m=new DOMMatrixReadOnly(next[1].transform);
   return {angles,before,first:next[0].transform,step:Math.abs(Math.atan2(m.b,m.a)*180/Math.PI-beforeAngle)};
  },selector);
  const entering=flow.angles[1]-flow.angles[0],leaving=flow.angles[2]-flow.angles[1];
  assert(entering>0.01&&leaving>0.01,'Body must keep moving through a continuing turn');
  assert(Math.abs(entering-leaving)/Math.max(entering,leaving)<.3,'Velocity stays continuous across the pose');
  assert.equal(flow.first,flow.before,'New interaction begins at the visible pose');
  assert(flow.step<1,'First sampled frame blends into the next gesture without a jump');
  await page.waitForFunction(s=>document.querySelector(s).dataset.motionActive==='false',selector);
  await page.evaluate(s=>mailaiCompanionMotion.react('kunpeng',document.querySelector(s).parentElement),selector);
  await page.waitForTimeout(2300);
  await page.evaluate(s=>document.querySelector(s).closest('.assistant-mini').dispatchEvent(new Event('pointerenter')),selector);
  assert.equal(await page.locator(selector).getAttribute('data-motion-clip'),'kunpeng','Repeated hover must let the current interaction finish');
  await page.waitForFunction(s=>document.querySelector(s).dataset.motionActive==='false',selector);
  // Work entered from a tilted gesture has one finite handoff over a clean loop.
  const handoff=await page.evaluate(s=>{
   const svg=document.querySelector(s);mailaiCompanionMotion.react('greet',svg.parentElement);
   svg.querySelectorAll('[class^="companion-"]').forEach(node=>node.getAnimations().filter(a=>!a.animationName).forEach(a=>{a.pause();a.currentTime=a.effect.getTiming().duration*.51;}));
   const torso=svg.querySelector('.companion-figure');const before=getComputedStyle(torso).transform;
   document.body.classList.add('companion-working');
   return new Promise(resolve=>queueMicrotask(()=>{
    const animations=torso.getAnimations().filter(a=>!a.animationName);
    const loop=animations.find(a=>a.effect.getTiming().iterations===Infinity);
    const entry=animations.find(a=>a.effect.getTiming().iterations===1);
    const keys=loop.effect.getKeyframes();
    resolve({before,first:entry.effect.getKeyframes()[0].transform,loopFirst:keys[0].transform,loopLast:keys.at(-1).transform});
   }));
  },selector);
  assert.equal(handoff.first,handoff.before,'Work entry preserves the current pose');
  assert.equal(handoff.loopFirst,handoff.loopLast,'Repeating work cannot revisit an interrupted gesture');
  await page.waitForTimeout(200);
  await page.evaluate(()=>document.body.classList.remove('companion-working'));
  await page.waitForFunction(s=>document.querySelector(s).dataset.motionActive==='false',selector);
  await page.evaluate(()=>document.getElementById('mail-assistant').classList.add('companion-finished'));
  await page.waitForFunction(s=>document.querySelector(s)?.dataset.motionClip==='happy',selector);
  await page.waitForTimeout(250);
  await page.evaluate(s=>{window.finishingAnimations=document.querySelector(s).getAnimations({subtree:true}).filter(a=>!a.animationName);document.getElementById('mail-assistant').classList.remove('companion-finished');},selector);
  await page.waitForTimeout(120);
  assert(await page.evaluate(()=>finishingAnimations.some(a=>a.playState==='running')),'Finite gesture must survive early state expiry');
  await page.waitForFunction(s=>document.querySelector(s).dataset.motionActive==='false',selector);
  await page.evaluate(()=>document.body.classList.add('companion-working'));
  await page.waitForFunction(s=>document.querySelector(s).dataset.motionClip==='work',selector);
  await page.waitForTimeout(370);
  const before=await page.evaluate(s=>{const svg=document.querySelector(s);const values=['torso','head','arm-left','carry'].map(p=>getComputedStyle(svg.querySelector('.companion-'+p)).transform);document.body.classList.remove('companion-working');return values;},selector);
  await page.waitForFunction(s=>document.querySelector(s).dataset.motionClip==='settle',selector);
  const start=await page.evaluate(s=>{const svg=document.querySelector(s);return ['torso','head','arm-left','carry'].map(p=>svg.querySelector('.companion-'+p).getAnimations().find(a=>!a.animationName)?.effect.getKeyframes()[0].transform||getComputedStyle(svg.querySelector('.companion-'+p)).transform);},selector);
  for(let i=0;i<before.length;i++)assert.equal(start[i],before[i],'Release begins at the current pose');
  await page.waitForFunction(s=>document.querySelector(s).dataset.motionActive==='false',selector);
  assert.equal(await page.evaluate(s=>document.querySelector(s).getAnimations({subtree:true}).filter(a=>!a.animationName&&a.playState==='running').length,selector),0,'Release leaves no running rig');
  await page.evaluate(()=>document.body.classList.add('companion-working'));
  await page.waitForFunction(s=>document.querySelector(s).dataset.motionClip==='work',selector);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(s=>document.querySelector(s).dataset.motionActive==='false',selector);
  assert.equal(await page.locator(selector).getAttribute('data-motion-clip'),null,'Background cancels without a release animation');
  assert.deepEqual(errors,[]);console.log('PASS: continuous pose velocity, blended gesture interruption, complete header gestures, coordinated work release, idle and background suspension');
 }finally{if(browser)await browser.close();const exit=once(fixture,'exit');fixture.kill();if(fixture.exitCode===null)await exit;}
})().catch(e=>{console.error(e);process.exitCode=1;});
