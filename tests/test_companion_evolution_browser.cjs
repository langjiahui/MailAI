/* Approved bird/phoenix and fish/Kunpeng: anatomy, isolated previews and finite flight. */
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium,webkit}=require('playwright');
const fs=require('node:fs');
const port=Number(process.env.MAILAI_EVOLUTION_FIXTURE_PORT||18857);
(async()=>{
 const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/workspace_preview.py'],{env:{...process.env,MAILAI_GROWTH_FIXTURE:'1',MAILAI_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let logs='',browser;fixture.stdout.on('data',d=>logs+=d);fixture.stderr.on('data',d=>logs+=d);
 try{
  let ready=false;
  for(let i=0;i<150;i++){
   if(fixture.exitCode!==null)throw Error(logs);
   try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch(_){}
   await new Promise(r=>setTimeout(r,100));
  }
  assert(ready,logs);
  browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch();
  const page=await browser.newPage({viewport:{width:1280,height:1000},deviceScaleFactor:2});const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(()=>{mailaiPet.open();document.body.classList.add('companion-still');});
  await page.locator('.pet-hero-portrait').waitFor();await page.waitForTimeout(300);
  const hero=page.locator('.pet-hero-portrait .mail-companion');
  const has=selector=>hero.locator(selector).first().evaluate(n=>n.getBoundingClientRect().width>0&&getComputedStyle(n).visibility!=='hidden');
  for(const style of ['nature','ranger'])for(let stage=1;stage<=7;stage++){
   await page.evaluate(({style,stage})=>Object.assign(document.body.dataset,{petStyle:style,petStage:String(stage),petAccessory:'',petEffect:'',petPalette:'mint'}),{style,stage});
   assert.equal(await has('.companion-foot-left'),style==='nature');
   assert.equal(await has('.evolution-crest-one'),style==='nature'&&stage>=2);
   assert.equal(await has('.evolution-crest-two'),style==='nature'&&stage>=4);
   assert.equal(await has('.evolution-crest-three'),style==='nature'&&stage>=6);
   assert.equal(await has('.evolution-tail-curl'),style==='nature'&&stage===7);
   assert.equal(await has('.evolution-wing-grown'),style==='nature'&&stage>=4);
   assert.equal(await has('.evolution-peng-wing'),style==='ranger'&&stage>=4);
   assert.equal(await has('.evolution-fish-mature'),style==='ranger'&&stage>=5);
   assert.equal(await has('.evolution-star-mark'),style==='ranger'&&stage===7);
   const finPhase=['baby','growing','flowing','flowing','feather','feather','feather'][stage-1];
   for(const phase of ['baby','growing','flowing','feather'])
    assert.equal(await has('.evolution-flipper-'+phase),style==='ranger'&&phase===finPhase,'One connected front fin for each growth phase');
   assert.equal(await has('.evolution-peng-bud'),style==='ranger'&&stage===4);
   assert.equal(await has('.evolution-peng-fan'),style==='ranger'&&stage>=5);
   assert.equal(await has('.evolution-peng-tip'),style==='ranger'&&stage>=6);
   for(const costume of ['cap','scarf','jacket','armor','visor','wings','mech-wings'])assert.equal(await has('.growth-'+costume),false,'No automatic costume stacking');
  }
  // Native flight wings replace neither the face nor the front letter-holding
  // flipper. Equipping another wing set must hide them and unequipping restore them.
  for(const [style,wing] of [['nature','.evolution-wing-grown'],['ranger','.evolution-peng-wing']]){
   await page.evaluate(style=>Object.assign(document.body.dataset,{petStyle:style,petStage:'7',petAccessory:''}),style);
   assert(await has(wing));
   for(const accessory of ['wings','mech_wings']){
    await page.evaluate(accessory=>document.body.dataset.petAccessory=accessory,accessory);
    assert.equal(await has(wing),false,'Only the equipped wing set is visible');
    assert(await has('.companion-wave'),'The letter-holding flipper remains visible');
   }
   await page.evaluate(()=>document.body.dataset.petAccessory='');
   assert(await has(wing),'Native wings return after unequipping');
  }
  // Stage thumbnails show their own anatomy, not the current body's stage or costume.
  await page.evaluate(()=>mailaiPet.refresh());
  await page.locator('[data-pet-tab="journey"]').click();
  assert.equal(await page.locator('.pet-evolution-preview').count(),7);
  for(const stage of [1,7]){
   const thumbnail=page.locator(`.pet-evolution-preview [data-evolution-stage="${stage}"]`);
   assert.equal(await thumbnail.locator('.evolution-crest-three').evaluate(n=>n.getBoundingClientRect().width>0),stage===7);
   assert.equal(await thumbnail.locator('.evolution-flipper-baby').evaluate(n=>getComputedStyle(n).display==='none'),stage===7,'Fin previews use their own growth stage');
   assert.equal(await thumbnail.evaluate(n=>n.getAnimations({subtree:true}).some(a=>a.playState==='running')),false);
  }
  assert.equal(await page.locator('#companion-creature-paints').count(),1,'Shared paint servers must not be cloned with every avatar');
  assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('.mail-companion [fill^="url(#"]')].map(n=>n.getAttribute('fill').slice(5,-1)).filter(id=>!document.getElementById(id))),[],'All shared gradient references resolve');
  // Both final forms unfold their real wings, then release all animation objects.
  await page.locator('[data-pet-tab="today"]').click();
  await page.locator('.pet-journal-body').evaluate(n=>n.scrollTop=0);await page.waitForTimeout(300);
  fs.mkdirSync('output/xiaoyou-evolution',{recursive:true});
  // Check actual world-space joints through gestures and interruptions, rather
  // than merely comparing two independent CSS animation declarations.
  for(const style of ['nature','ranger']) {
   const checks=await page.evaluate(style=>{
    const svg=document.querySelector('.pet-hero-portrait .mail-companion');
    Object.assign(document.body.dataset,{petStyle:style,petStage:'3'});
    document.body.classList.remove('companion-still');
    const body=svg.querySelector('.companion-torso'),carry=svg.querySelector('.companion-carry');
    const hand=svg.querySelector('.companion-wave'),letter=svg.querySelector('.companion-bag');
    const free=svg.querySelector('.companion-arm-left');
    const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
    const errors=[];
    for(const clip of ['greet','dispatch','deliver','step','stretch','happy','glide','star','guard','beacon','think','bow','swim','phoenix','kunpeng']) {
     if(!mailaiCompanionMotion.react(clip,svg.parentElement)) {errors.push(`${clip}: did not play`);continue;}
     for(const phase of [0,.12,.3,.5,.72,.96]) {
      for(const a of svg.getAnimations({subtree:true})) {
       if(a instanceof CSSAnimation || a instanceof CSSTransition)continue;
       a.pause();a.currentTime=Number(a.effect.getTiming().duration)*phase;
      }
      const shoulder=new DOMPoint(84,66),freeShoulder=new DOMPoint(31,63),grip=new DOMPoint(78,79);
      if(distance(shoulder.matrixTransform(carry.getCTM()),shoulder.matrixTransform(body.getCTM()))>.01)errors.push(`${clip}/${phase}: holding shoulder detached`);
      if(distance(freeShoulder.matrixTransform(free.getCTM()),freeShoulder.matrixTransform(body.getCTM()))>.01)errors.push(`${clip}/${phase}: free shoulder detached`);
      if(distance(grip.matrixTransform(hand.getCTM()),grip.matrixTransform(letter.getCTM()))>.01)errors.push(`${clip}/${phase}: grip slipped`);
      if(hand.parentElement!==carry || letter.parentElement!==carry)errors.push('Split holding rig');
     }
    }
    return errors;
   },style);
   assert.deepEqual(checks,[],`${style}: shoulders and grip remain attached during actions and interruptions`);
  }
  // Turning is continuous: the face leads, the tail passes behind the body,
  // and the letter remains in the same hand without an instantaneous mirror.
  for(const [style,clip] of [['nature','march'],['nature','step'],['ranger','swim']]) {
   const checks=await page.evaluate(({style,clip})=>{
    const svg=document.querySelector('.pet-hero-portrait .mail-companion');
    Object.assign(document.body.dataset,{petStyle:style,petStage:'3'});
    if(!mailaiCompanionMotion.react(clip,svg.parentElement)) throw Error('Visible travel rig must start');
    const motions=svg.getAnimations({subtree:true}).filter(a=>!(a instanceof CSSAnimation)&&!(a instanceof CSSTransition));
    motions.forEach(a=>a.pause());
    const matrix=selector=>new DOMMatrixReadOnly(getComputedStyle(svg.querySelector(selector)).transform);
    const sample=phase=>{
     motions.forEach(a=>a.currentTime=Number(a.effect.getTiming().duration)*phase);
     const facing=matrix('.companion-facing'),heading=matrix('.companion-heading'),look=matrix('.companion-look'),figure=matrix('.companion-figure');
     const body=matrix('.companion-torso');
     const chest=new DOMPoint(56,55).matrixTransform(svg.querySelector('.companion-torso').getCTM()).matrixTransform(svg.querySelector('.companion-figure').getCTM().inverse());
     const torso=svg.querySelector('.companion-torso').getCTM().inverse();
     const grip=new DOMPoint(78,79).matrixTransform(svg.querySelector('.companion-carry').getCTM()).matrixTransform(torso);
     return {x:figure.e,face:heading.a,look:look.e,mirror:facing.a,width:Math.hypot(facing.a,facing.b),height:Math.hypot(facing.c,facing.d),grip:grip.x,roll:Math.atan2(body.b,body.a)*180/Math.PI,chest:chest.x,bodyScale:Math.hypot(body.a,body.b)/Math.hypot(body.c,body.d)};
    };
    const errors=[];let previous;
    for(let i=0;i<=100;i++) {
     const p=sample(i/100);
     if(Math.abs(p.width-1)>.001||Math.abs(p.height-1)>.001||Math.abs(p.bodyScale-1)>.001||p.mirror<0)errors.push('Body mirrored or squeezed');
     if(previous&&(Math.abs(p.face-previous.face)>.3||Math.abs(p.look-previous.look)>1||Math.abs(p.grip-previous.grip)>.1||Math.abs(p.x-previous.x)>1.2))errors.push('Travel, turn or holding hand jumped between frames');
     previous=p;
    }
    for(const [a,b,face] of [[.1,.2,1],[.48,.60,-1],[.90,.98,1]]) {
     const first=sample(a),last=sample(b);
     if(Math.sign(last.face)!==face||Math.sign(last.x-first.x)!==-face||Math.sign(last.look)!==-face)errors.push(`${a}-${b}: gaze/tail opposes travel`);
    }
    // The chest/shoulder line must visibly follow both turns; moving only
    // the face and tail leaves a stationary torso and fails this regression.
    const anticipation=sample(.28),rightTurn=sample(.36),leftTurn=sample(.78);
    if(Math.abs(anticipation.roll)>1.3||anticipation.look<=-2.8)errors.push('Body moved before the look');
    if(rightTurn.roll<3.4||leftTurn.roll> -3.4||rightTurn.chest-anticipation.chest<2)errors.push('Torso did not carry the turn through the shoulders');
    if(Math.abs(sample(1).roll)>.01)errors.push('Body did not settle after travel');
    const turn=sample(.35);
    if(turn.look<=0||turn.face<=0)errors.push('Face must lead the tail through the turn');
    if(Math.abs(sample(.37).face)>.01)errors.push('Tail must pass continuously behind the body');
    // Mid-turn interruption preserves the exact partial turn, not just its sign.
    const before=sample(.34);
    mailaiCompanionMotion.react('greet',svg.parentElement);
    if(Math.abs(matrix('.companion-heading').a-before.face)>.001||Math.abs(matrix('.companion-look').e-before.look)>.001)errors.push('Interruption snapped the turn');
    mailaiCompanionMotion.react(clip,svg.parentElement);
    const restarted=svg.getAnimations({subtree:true}).filter(a=>!(a instanceof CSSAnimation)&&!(a instanceof CSSTransition));
    restarted.forEach(a=>{a.pause();a.currentTime=0;});
    const start=matrix('.companion-heading').a;
    restarted.forEach(a=>a.currentTime=Number(a.effect.getTiming().duration)*.01);
    if(Math.abs(matrix('.companion-heading').a-start)>.05)errors.push('Restart skipped the turn anticipation');
    restarted.forEach(a=>a.currentTime=Number(a.effect.getTiming().duration)+1);
    mailaiCompanionMotion.react('greet',svg.parentElement);
    if(Math.abs(matrix('.companion-heading').a-1)>.001)errors.push('Completed journey restored an obsolete heading');
    return errors;
   },{style,clip});
   assert.deepEqual(checks,[],`${style}/${clip}: smooth turn, stable grip and continuous interruption`);
  }
  // The tail must meet actual filled body geometry at every growth scale,
  // including both extremes of swimming and flight, not just share an origin.
  const tailErrors=await page.evaluate(()=>{
   // Growth refresh may replace the hero between locator resolution and evaluation.
   const svg=document.querySelector('.pet-hero-portrait .mail-companion');
   if(!svg?.isConnected)throw Error('Growth hero must be mounted for geometry checks');
   document.body.dataset.petStyle='ranger';
   const errors=[],root=new DOMPoint(84,85);
   for(let stage=1;stage<=7;stage++) {
    document.body.dataset.petStage=String(stage);
    const body=svg.querySelector('.evolution-fish-body path');
    const tail=svg.querySelector(`.evolution-fish-${stage<5?'young':'mature'} path`);
    for(const clip of ['swim','dive','kunpeng']) {
     mailaiCompanionMotion.react(clip,svg.parentElement);
     for(const phase of [0,.22,.35,.45,.68,.9]) {
      for(const a of svg.getAnimations({subtree:true})) {
       if(a instanceof CSSAnimation || a instanceof CSSTransition)continue;
       a.pause();a.currentTime=Number(a.effect.getTiming().duration)*phase;
      }
      const tailToBody=body.getCTM().inverse().multiply(tail.getCTM());
      const joint=root.matrixTransform(tailToBody);
      const torso=svg.querySelector('.companion-torso'),heading=svg.querySelector('.companion-heading');
      const projected=root.matrixTransform(torso.getCTM().inverse().multiply(body.getCTM())).matrixTransform(heading.getCTM()).matrixTransform(body.getCTM().inverse());
      if(Math.hypot(joint.x-projected.x,joint.y-projected.y)>.02)errors.push(`${stage}/${clip}/${phase}: tail root drift`);
      if(!body.isPointInFill(joint)||!tail.isPointInFill(root))errors.push(`${stage}/${clip}/${phase}: root outside body or tail ${JSON.stringify({joint:{x:joint.x,y:joint.y},body:body.isPointInFill(joint),tail:tail.isPointInFill(root),bodyStyle:getComputedStyle(body).fill,tailStyle:getComputedStyle(tail).fill,bodyBox:body.getBBox(),tailBox:tail.getBBox(),heading:getComputedStyle(heading).transform})}`);
      let overlap=0;
      for(const x of [80,82,84,86])for(const y of [82,84,86,88,90]) {
       const p=new DOMPoint(x,y);
       if(tail.isPointInFill(p)&&body.isPointInFill(p.matrixTransform(tailToBody)))overlap++;
      }
      if(overlap<6)errors.push(`${stage}/${clip}/${phase}: insufficient neck overlap (${overlap})`);
     }
    }
   }
   return errors;
  });
  assert.deepEqual(tailErrors,[],'All seven fish stages keep a filled, continuous tail root');
  for(const [style,clip,part] of [['nature','phoenix','.companion-flight-left'],['ranger','kunpeng','.companion-flight-left']]){
   await page.evaluate(style=>{Object.assign(document.body.dataset,{petStyle:style,petStage:'7'});document.body.classList.remove('companion-still');mailaiCompanionMotion.react('signature',document.querySelector('.pet-hero-portrait'));},style);
   assert.equal(await hero.getAttribute('data-motion-clip'),clip);
   const before=await hero.locator(part).evaluate(n=>getComputedStyle(n).transform);
   await page.waitForTimeout(1050);
   assert.notEqual(await hero.locator(part).evaluate(n=>getComputedStyle(n).transform),before);
   const pose=await page.evaluate(()=>{
    const svg=document.querySelector('.pet-hero-portrait .mail-companion');
    const torso=new DOMMatrixReadOnly(getComputedStyle(svg.querySelector('.companion-torso')).transform);
    const figure=new DOMMatrixReadOnly(getComputedStyle(svg.querySelector('.companion-figure')).transform);
    return {ratios:[torso,figure].map(m=>Math.hypot(m.a,m.b)/Math.hypot(m.c,m.d)),
      hand:getComputedStyle(svg.querySelector('.companion-wave')).transform,
      letter:getComputedStyle(svg.querySelector('.companion-bag')).transform};
   });
   assert(pose.ratios.every(r=>Math.abs(r-1)<.001),'Flight must not squeeze the round body');
   assert.equal(pose.hand,pose.letter,'Flight keeps the letter attached to its holding flipper');
   assert(await has('.companion-eyes'),'Final flight keeps the bright open eyes');
   assert.equal(await has('.companion-happy-eyes'),false);
   await page.locator('.pet-hero-portrait').screenshot({path:`output/xiaoyou-evolution/${style}-flight-${process.env.MAILAI_BROWSER||'chromium'}.png`});
   await page.waitForFunction(()=>document.querySelector('.pet-hero-portrait .mail-companion').dataset.motionActive==='false');
   assert.equal(await hero.evaluate(n=>n.getAnimations({subtree:true}).filter(a=>a.playState==='running'||!(a instanceof CSSAnimation)).length),0,'Final flight releases JS animations; dormant CSS rewards stay paused');
  }
  await page.evaluate(()=>{document.body.classList.add('companion-still');applyTheme('dark');});
  await page.setViewportSize({width:390,height:844});
  assert(await hero.isVisible());
  assert.deepEqual(errors,[]);
  console.log('PASS creature evolution: 14 silhouettes, seven isolated previews, optional outfits, shared gradients, phoenix/Kunpeng flight and finite release, dark compact layout');
 }finally{
  if(browser)await browser.close();const stopped=once(fixture,'exit');fixture.kill('SIGTERM');if(fixture.exitCode===null)await stopped;
 }
})().catch(e=>{console.error(e);process.exitCode=1});
