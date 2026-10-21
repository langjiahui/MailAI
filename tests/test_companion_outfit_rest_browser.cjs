/* Every authored gesture returns to a designed rest pose, across live hosts.
 * A disposable fixture and virtual timers avoid real mail and long sleeps. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const acorn=require('acorn');
const {chromium,webkit}=require('playwright');
const engine=process.env.MAILAI_BROWSER==='webkit'?webkit:chromium;
const port=Number(process.env.MAILAI_REST_FIXTURE_PORT||18844),base=`http://127.0.0.1:${port}`;
const tree=acorn.parse(fs.readFileSync('app/web/static/companion-motion.js','utf8'),{ecmaVersion:'latest'});
const clips=new Set();
function walk(node){
 if(!node||typeof node!=='object')return;
 if(node.type==='VariableDeclarator'&&node.id?.name==='clips')for(const prop of node.init.properties)clips.add(prop.key.name||prop.key.value);
 if(node.type==='AssignmentExpression'&&node.left?.object?.name==='clips')clips.add(node.left.property.name);
 for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
}
walk(tree);assert(clips.size>20,'Discover the complete gesture library');
(async()=>{
 const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/workspace_preview.py'],{
  env:{...process.env,MAILAI_FIXTURE_PORT:String(port),MAILAI_REWARD_MOTION_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
 let browser,logs='';fixture.stdout.on('data',d=>logs+=d);fixture.stderr.on('data',d=>logs+=d);
 try{
  let ready=false;
  for(let i=0;i<100;i++){
   if(fixture.exitCode!==null)throw Error(logs);
   try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,100));
  }
  assert(ready,logs);
  browser=await engine.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:2});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.waitForFunction(()=>document.body.dataset.petStage);
  await page.evaluate(()=>mailaiEnergy.reschedule('companion-growth',3600000));
  await page.clock.install();await page.clock.runFor(5000);
  await page.evaluate(()=>{
   window.ciRestSnapshot=svg=>[...svg.querySelectorAll('.companion-figure,.companion-heading,.companion-look,.companion-torso,.companion-head,.companion-tail,.companion-carry,.companion-arm-left,.companion-foot-left,.companion-foot-right,.companion-eyes,.companion-flight-left,.companion-flight-right,.pet-reward-motion')].map(node=>{
    const css=getComputedStyle(node),matrix=new DOMMatrixReadOnly(css.transform);
    return {part:node.getAttribute('class'),matrix:[matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f].map(n=>Math.abs(n)<.0001?0:Number(n.toFixed(4))),opacity:Number(css.opacity)};
   });
  });
  const snapshot=selector=>page.evaluate(selector=>ciRestSnapshot(document.querySelector(selector)),selector);
  const idle=async(selector,baseline,label)=>{
   // Read the complete idle pose atomically. A sparse ambient nod may begin
   // between separate protocol calls on a loaded runner; it is allowed after
   // the rest interval, but must never masquerade as an unfinished reaction.
   // Theme fill transitions also finish in real browser time, not virtual time.
   const ready=await page.waitForFunction(selector=>{
    const svg=document.querySelector(selector);
    if(svg.dataset.motionActive!=='false'||svg.getAnimations({subtree:true}).some(a=>a.playState==='running'))return false;
    return {active:svg.dataset.motionActive,pose:ciRestSnapshot(svg),effects:[...svg.querySelectorAll(':is(.growth-stars,.growth-orbit,.growth-aura,.growth-lightning) .pet-reward-motion')].map(n=>Number(getComputedStyle(n).opacity)),running:svg.getAnimations({subtree:true}).filter(a=>a.playState==='running').length};
   },selector,{timeout:3000});
   const rest=await ready.jsonValue();
   assert.equal(rest.active,'false',label+' ends');
   assert.deepEqual(rest.pose,baseline,label+' restores every body/outfit part');
   assert(rest.effects.every(value=>value===0),label+' lets transient effects fade away');
   assert.equal(rest.running,0,label+' releases all animation work');
  };
  let checked=0;
  async function gesture(selector,name,label=name){
   // Start from real idle, rather than sampling a sparse ambient nod that may
   // have begun while the preceding host/style was being opened.
   await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
   await page.waitForFunction(selector=>document.querySelector(selector).dataset.motionActive==='false',selector);
   await page.bringToFront();
   await page.locator(selector).scrollIntoViewIfNeeded();
   await page.waitForFunction(selector=>document.querySelector(selector).dataset.rewardVisible==='true',selector);
   await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
   const baseline=await snapshot(selector);
   // Both visibility observers must have committed after a host opens. A
   // deliberate reaction may start only then; no ambient work is forced on.
   const started=await page.waitForFunction(({selector,name})=>{
    const svg=document.querySelector(selector);
    if(!mailaiCompanionMotion.react(name,svg))return false;
    const motions=svg.getAnimations({subtree:true});
    for(const motion of motions){motion.pause();motion.currentTime=Number(motion.effect.getTiming().duration)*.43;}
    return Math.max(0,...motions.filter(a=>!a.animationName).map(a=>Number(a.effect.getTiming().duration)));
   },{selector,name},{timeout:3000});
   const duration=await started.jsonValue();
   assert(duration>0,name+' has actual motion');
   await page.clock.runFor(duration+30);
   assert.equal(await page.locator(selector).getAttribute('data-motion-clip'),'settle',label+' has a landing: '+JSON.stringify(await page.evaluate(selector=>({svg:{...document.querySelector(selector).dataset},style:document.body.dataset.petStyle,body:document.body.className}),selector)));
   assert.equal(await page.locator(selector).getAttribute('data-outfit-rest'),'true',name+' releases outfit clocks with the body');
   const finite=await page.locator(selector).evaluate(svg=>svg.getAnimations({subtree:true}).every(a=>a.effect.getTiming().iterations===1));
   assert(finite,name+' release cannot loop');
   await page.clock.runFor(500);
   await idle(selector,baseline,label);checked++;
  }
  const orb='#assistant-orb .mail-companion';
  for(const style of ['nature','ranger']){
   await page.evaluate(style=>{
    Object.assign(document.body.dataset,{petStyle:style,petAccessory:style==='nature'?'wings':'mech_wings',petEffect:'aurora',petPalette:'sky',petStage:'7'});
   },style);
   await page.clock.runFor(5000);
   for(const name of clips)if(name!=='work')await gesture(orb,name);
  }
  const hosts=[
   ['welcome','#assistant-panel .assistant-welcome-portrait .mail-companion',()=>page.evaluate(()=>openAssistant())],
   ['chat','#assistant-panel .assistant-mini .mail-companion',()=>page.evaluate(()=>appendAssistantMessage('user','Synthetic rest-pose check'))],
   ['perch','#btn-compose-ai .mail-companion',()=>page.evaluate(async()=>{closeAssistant();await openCompose();})],
   ['writing','#compose-ai-panel .assistant-mini .mail-companion',()=>page.locator('#btn-compose-ai').click()],
   ['growth','.pet-hero-portrait .mail-companion',()=>page.evaluate(async()=>{await closeCompose();await mailaiPet.open();})],
  ];
  for(const [name,selector,open]of hosts){
   await open();await page.locator(selector).waitFor({state:'visible'});await page.clock.runFor(5000);
   for(const style of ['nature','ranger']){
    await page.evaluate(style=>Object.assign(document.body.dataset,{petStyle:style,petAccessory:style==='nature'?'wings':'mech_wings'}),style);
    await page.clock.runFor(5000);await gesture(selector,'greet',name+'/'+style);
    const baseline=await snapshot(selector);
    await page.evaluate(()=>document.body.classList.add('companion-working'));
    await page.clock.runFor(370);
    await page.evaluate(()=>document.body.classList.remove('companion-working'));
    await page.clock.runFor(500);await idle(selector,baseline,name+' work/'+style);
    if(name==='perch'){
     const metrics=await page.locator(selector).evaluate(svg=>{
      const wing=svg.querySelector(document.body.dataset.petStyle==='nature'?'.growth-wings':'.growth-mech-wings').getBoundingClientRect();
      const art=svg.parentElement.getBoundingClientRect();
      return {bottom:wing.bottom-art.bottom,width:wing.width,artWidth:art.width};
     });
     assert(metrics.bottom<=3,'Resting wings must not hang below the ledge: '+JSON.stringify(metrics));
     const box=await page.locator('#btn-compose-ai').boundingBox();
     for(const mode of ['light','dark']){
      await page.evaluate(mode=>applyTheme(mode),mode);
      await page.screenshot({clip:{x:box.x-40,y:box.y-25,width:180,height:130},path:`/tmp/mailai-perch-rest-${style}-${mode}-${engine.name()}.png`});
     }
    }
   }
  }
  await page.evaluate(()=>document.getElementById('companion-growth-dialog').close());
  await page.clock.runFor(5000);
  const baseline=await snapshot(orb);
  await page.evaluate(()=>mailaiCompanionMotion.react('swim',document.querySelector('#assistant-orb .mail-companion')));
  await page.clock.runFor(600);await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.querySelector('#assistant-orb .mail-companion').dataset.motionActive==='false');
  await idle(orb,baseline,'Reduced motion mid-gesture');
  assert.deepEqual(errors,[]);
  console.log(`PASS ${engine.name()}: ${clips.size} authored clips, ${checked} gesture landings, both routes, all six live hosts, work release, compact ledge, zero idle animation and reduced-motion rest`);
 }finally{
  if(browser)await browser.close();const stopped=once(fixture,'exit');fixture.kill('SIGTERM');if(fixture.exitCode===null)await stopped;
 }
})().catch(e=>{console.error(e);process.exitCode=1});
