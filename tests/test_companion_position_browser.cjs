/* Isolated drag placement, click arbitration, disk preferences and viewport bounds. */
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const faultFile=path.join(os.tmpdir(),`mailai-position-failure-${process.pid}`);
const {chromium,webkit}=require('playwright');
const port=Number(process.env.MAILAI_POSITION_FIXTURE_PORT||18861);
const key='mailai-companion-position-v1';
(async()=>{
 const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'.venv-build/bin/python',['tests/workspace_preview.py'],{env:{...process.env,MAILAI_FIXTURE_PORT:String(port),MAILAI_PREVIEW_FAILURES:faultFile},stdio:['ignore','pipe','pipe']});
 let logs='',browser;fixture.stdout.on('data',d=>logs+=d);fixture.stderr.on('data',d=>logs+=d);
 try {
  let ready=false;
  for(let i=0;i<150;i++) {try {if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch(_){}await new Promise(r=>setTimeout(r,100));}
  assert(ready,logs);
  for(const engine of [chromium,webkit]) {
   browser=await engine.launch();
   const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
   await page.addInitScript(()=>{
    window.nativeWindowDrags=0;
    window.pywebview={api:{
     set_window_theme:async()=>({ok:true}),
     set_window_drag_region:async(...args)=>{window.nativeDragRegion=args;return {ok:true};}
    }};
    window.nativeDragHit=(x,y)=>{
     if(!window.nativeDragRegion||y<0||y>52||document.documentElement.classList.contains('macos-native-fullscreen'))return false;
     const [, , ,gaps,excluded=[]]=nativeDragRegion;
     if(excluded.some(([left,right])=>x>=left&&x<right))return false;
     return gaps.some(([left,right])=>x>=left&&x<right)||(x>104&&y<=5);
    };
    // Model Cocoa's overlay: if it accepts the initial press, WebKit never
    // receives pointerdown and cannot capture a subsequent pet drag.
    document.addEventListener('pointerdown',event=>{
     if(nativeDragHit(event.clientX,event.clientY)){
      nativeWindowDrags++;event.preventDefault();event.stopImmediatePropagation();
     }
    },true);
   });
   await page.goto(`http://127.0.0.1:${port}/?shell=macos`);
   await page.locator('#app-preloader').waitFor({state:'hidden'});
   await page.evaluate(k=>localStorage.removeItem(k),key);await page.reload();await page.locator('#app-preloader').waitFor({state:'hidden'});
   const orb=page.locator('#assistant-orb'),root=page.locator('#mail-assistant');
   const box=()=>orb.boundingBox();
   const saved=()=>page.evaluate(k=>localStorage.getItem(k),key);
   const isOpen=()=>page.evaluate(()=>document.body.classList.contains('assistant-visible'));
   const settled=async()=>{await page.waitForFunction(()=>!document.querySelector('.companion-snapping'));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));};
   const begin=async(dx,dy)=>{const b=await box();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:8});return b;};
   let writes=0;page.on('request',r=>{if(r.url().endsWith('/api/ui-preferences')&&r.method()==='POST'&&r.postDataJSON()?.key===key)writes++;});
   const initial=await begin(-380,-230);
   assert.equal(writes,0,'No per-move persistence');
   assert(await page.evaluate(()=>document.body.classList.contains('companion-dragging')));
   await page.mouse.up();await settled();
   const moved=await box();assert(Math.abs(moved.x-initial.x+380)<2&&Math.abs(moved.y-initial.y+230)<2,JSON.stringify({initial,moved}));
   assert.equal(writes,1);assert.equal(await isOpen(),false,'Dragging must not open chat');
   const preference=await saved();assert.equal(JSON.parse(preference).version,1);
   await page.reload();await page.locator('#app-preloader').waitFor({state:'hidden'});await settled();
   const restored=await box();assert(Math.abs(restored.x-moved.x)<2&&Math.abs(restored.y-moved.y)<2,'Restores exact position at the same viewport');
   // Small mouse jitter is a click, not a drag.
   await begin(2,1);await page.mouse.up();assert(await isOpen());
   await page.evaluate(()=>closeAssistant());await page.waitForTimeout(350);
   assert.equal(await saved(),preference);
   await begin(140,60);await page.keyboard.press('Escape');await page.mouse.up();await settled();
   assert.equal(await saved(),preference);assert.equal(await isOpen(),false);
   assert(Math.abs((await box()).x-moved.x)<2,'Escape restores the last placement');
   await begin(100,-60);await orb.evaluate(n=>n.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));await page.mouse.up();await settled();
   assert.equal(await saved(),preference);assert(!await page.evaluate(()=>document.body.classList.contains('companion-dragging')));
   // Off-window pointer coordinates remain captured and clamp to safe bounds.
   await begin(-2000,-2000);await page.mouse.up();await settled();
   let b=await box();assert(b.x<16&&b.x+b.width>20&&b.y>=0,JSON.stringify(b));
   assert.equal(await root.getAttribute('data-pet-edge-x'),'left');assert.equal(await root.getAttribute('data-pet-edge-y'),'top');
   const edgePreference=await saved();
   for(const [width,height,zoom] of [[390,650,1],[1280,900,1.25],[900,600,.85]]) {
    await page.setViewportSize({width,height});await page.evaluate(z=>{document.body.style.zoom=z;document.documentElement.style.setProperty('--fz',z);},zoom);await settled();
    b=await box();assert(b.x+b.width>20&&b.y+b.height>20&&b.x<width-20&&b.y<height-20,JSON.stringify({b,width,height,zoom}));
    assert.equal(await saved(),edgePreference,'Layout changes do not overwrite preferred position');
   }
   const zoomStart=await begin(160,100);await page.mouse.up();await settled();b=await box();
   assert(Math.abs(b.x-zoomStart.x-160)<2&&Math.abs(b.y-zoomStart.y-100)<2,'Drag follows screen coordinates under CSS zoom');
   // Release near each edge (not exactly on it), then verify the snap, saved
   // dock pose and shoulder attachment on both creatures.
   await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');});await settled();
   const poses=new Set();
   for(const edge of ['left','right','top','bottom']) {
    const before=await box();
    const x=edge==='left'?38:edge==='right'?1280-before.width-38:550;
    const y=edge==='top'?38:edge==='bottom'?900-before.height-38:360;
    await begin(x-before.x,y-before.y);assert.equal(await root.getAttribute('data-pet-dock'),null,'Undocking restores free pose');
    await page.mouse.up();await settled();
    b=await box();assert.equal(await root.getAttribute('data-pet-dock'),edge);
    assert.equal(JSON.parse(await saved()).dock,edge);
    assert(b.x+b.width>20&&b.y+b.height>20&&b.x<1260&&b.y<880,'Dock keeps a visible drag target');
    if(edge==='top') {
     await page.waitForFunction(()=>nativeDragRegion?.[4]?.length===1);
     const native=await page.evaluate(()=>{
      const r=document.getElementById('assistant-orb').getBoundingClientRect(),[, , ,gaps,excluded]=nativeDragRegion;
      const x=(r.left+r.right)/2;
      return {covered:excluded.some(([left,right])=>left<=Math.max(0,r.left)&&right>=Math.min(innerWidth,r.right)),
       overlaps:gaps.some(([left,right])=>left<r.right&&right>r.left),
       topHit:nativeDragHit(x,2),bodyHit:nativeDragHit(x,Math.max(0,r.top+r.height/2)),
       neighboringTopHit:nativeDragHit(excluded[0][1]+8,2)};
     });
     assert(native.covered&&!native.overlaps&&!native.topHit&&!native.bodyHit,'Native titlebar must yield the complete pet hit area: '+JSON.stringify(native));
     assert(native.neighboringTopHit,'Empty titlebar beside the pet still drags the window');
    }
    poses.add(await orb.locator('.companion-facing').evaluate(n=>getComputedStyle(n).transform));
    for(const style of ['nature','ranger']) {
     await page.evaluate(style=>document.body.dataset.petStyle=style,style);await settled();
     const geometry=await orb.evaluate((orb,style)=>{
      const svg=orb.querySelector('svg'),body=svg.querySelector('.companion-torso'),carry=svg.querySelector('.companion-carry'),free=svg.querySelector('.companion-arm-left');
      const distance=(p,a,b)=>{const x=p.matrixTransform(a.getCTM()),y=p.matrixTransform(b.getCTM());return Math.hypot(x.x-y.x,x.y-y.y);};
      return [distance(new DOMPoint(84,66),carry,body),distance(new DOMPoint(31,63),free,body),distance(new DOMPoint(78,79),svg.querySelector('.companion-wave'),svg.querySelector('.companion-bag'))];
     },style);
     assert(geometry.every(n=>n<.02),`${edge}/${style}: joint or letter disconnected`);
     const contact=await orb.evaluate((orb,{edge,style})=>{
      const fish=style==='ranger';let selector='.companion-facing',x=56,y=101.5;
      if(edge==='left'){selector='.companion-arm-left';x=fish?17:12;y=fish?77:79;}
      if(edge==='right'){selector=fish?'.evolution-fish-body':'.companion-torso';x=fish?91:96;y=fish?66:65;}
      if(edge==='bottom'&&fish){selector='.evolution-fish-body';y=97;}
      if(edge==='top'){selector='.companion-arm-left';x=9;y=41;}
      const p=new DOMPoint(x,y).matrixTransform(orb.querySelector(selector).getScreenCTM());
      const distance=edge==='left'?p.x:edge==='right'?innerWidth-p.x:edge==='top'?p.y:innerHeight-p.y;
      const face=orb.querySelector('.companion-gaze').getBoundingClientRect();
      return {distance,faceInside:face.left>=-1&&face.top>=-1&&face.right<=innerWidth+1&&face.bottom<=innerHeight+1};
     },{edge,style});
     assert(Math.abs(contact.distance-.75)<.2&&contact.faceInside,`${edge}/${style}: no visible air gap and face stays inside ${JSON.stringify(contact)}`);
    }
   }
   // Check the complete head and crest at all ages, not just the eyes.
   const beforeTop=await box();await begin(550-beforeTop.x,38-beforeTop.y);await page.mouse.up();await settled();
   for(const style of ['nature','ranger'])for(let stage=1;stage<=7;stage++) {
    await page.evaluate(({style,stage})=>{document.body.dataset.petStyle=style;document.body.dataset.petStage=String(stage);},{style,stage});await settled();
    const outline=await orb.evaluate(orb=>{
     const visible=n=>{for(let p=n;p&&p!==orb;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden')return false;}return true;};
     const paths=[...orb.querySelectorAll('.growth-body path,.evolution-crest path,.evolution-fish-fin path')].filter(visible);
     let top=Infinity,left=Infinity,right=-Infinity;
     for(const p of paths)for(let i=0;i<=100;i++){const q=p.getPointAtLength(p.getTotalLength()*i/100).matrixTransform(p.getScreenCTM());top=Math.min(top,q.y);left=Math.min(left,q.x);right=Math.max(right,q.x);}
     const wing=orb.querySelector('.companion-edge-grip').getBBox();
     return {top,left,right,wingRatio:wing.height/wing.width,wingHeight:wing.height};
    });
    assert(outline.top>=2,`${style}/${stage}: full head and crest below edge ${JSON.stringify(outline)}`);
    assert(outline.wingRatio<1.2&&outline.wingHeight<30,'Grip is a compact feather fan, not an extended arm');
   }
   // Head remains complete even when the chosen top anchor is near a corner.
   for(const x of [20,1160]) {
    const old=await box();await begin(x-old.x,16-old.y);await page.mouse.up();await settled();
    assert.equal(await root.getAttribute('data-pet-dock'),'top');
    const head=await orb.locator('.growth-body').boundingBox();assert(head.x>=5&&head.x+head.width<=1275,'Leaning head stays inside the side edges');
   }
   const returnBottom=await box();await begin(550-returnBottom.x,900-returnBottom.height-38-returnBottom.y);await page.mouse.up();await settled();
   assert.equal(poses.size,4,'Four distinct, rigid dock silhouettes');
   await page.reload();await page.locator('#app-preloader').waitFor({state:'hidden'});await settled();
   assert.equal(await root.getAttribute('data-pet-dock'),'bottom','Dock survives reload');
   await page.waitForFunction(()=>nativeDragRegion?.[4]?.length===0);
   // Full-motion docking approaches, makes contact, then settles and releases
   // all temporary animations. Reduced motion used above must stay immediate.
   await page.emulateMedia({reducedMotion:'no-preference'});
   const departure=await box();await begin(-180,-200);await page.mouse.up();await settled();
   let current=await box();await begin(38-current.x,330-current.y);await page.mouse.up();
   assert(await root.evaluate(n=>n.classList.contains('companion-snapping')));
   const midway=await root.evaluate(n=>n.getAnimations().some(a=>a.playState==='running'));assert(midway,'A real finite approach runs');
   await settled();assert.equal(await root.evaluate(n=>n.getAnimations().length),0,'Snap animations are released');
   current=await box();await begin(500-current.x,38-current.y);await page.mouse.up();
   await page.evaluate(()=>document.dispatchEvent(new CustomEvent('mailai:foreground-changed',{detail:{visible:false}})));
   assert.equal(await root.evaluate(n=>n.getAnimations().length),0,'Native hide releases a pending snap');
   await page.evaluate(()=>document.dispatchEvent(new CustomEvent('mailai:foreground-changed',{detail:{visible:true}})));
   await settled();
   // Top docking stays upright, with a visible hooked wing. Pulling away
   // opens the grip first and lets the torso follow; a quick release must
   // preserve the remaining recovery rather than jump to its final pose.
   const facing=orb.locator('.companion-facing');
   assert(await facing.evaluate(n=>new DOMMatrix(getComputedStyle(n).transform).a>.75),'Top peek leans gently without inversion');
   assert.equal(await orb.locator('.companion-edge-grip').evaluate(n=>getComputedStyle(n).opacity),'1');
   const topBox=await box();
   await orb.evaluate(n=>n.addEventListener('pointerdown',event=>{window.positionPointerId=event.pointerId;},{once:true}));
   await page.mouse.move(topBox.x+topBox.width/2,Math.max(4,topBox.y+topBox.height/2));await page.mouse.down();
   await page.mouse.move(topBox.x+topBox.width/2+60,topBox.y+topBox.height/2+180);
   assert(await root.evaluate(n=>n.classList.contains('companion-releasing')),'Pull starts finite release');
   // Release and inspect in one browser task. CI transport must not consume the
   // 400ms recovery between sampling its frames and checking the pointer-up.
   const active=await facing.evaluate(n=>{const a=n.getAnimations().find(a=>a.effect.getTiming().duration===380);a.pause();a.currentTime=0;const first=getComputedStyle(n).transform;a.currentTime=160;const middle=getComputedStyle(n).transform;a.currentTime=380;const last=getComputedStyle(n).transform;a.currentTime=80;a.play();document.getElementById('assistant-orb').dispatchEvent(new PointerEvent('pointerup',{pointerId:positionPointerId,bubbles:true}));return {first,middle,last,releasing:document.getElementById('mail-assistant').classList.contains('companion-releasing')};});
   assert.notEqual(active.first,active.middle);assert.notEqual(active.middle,active.last);
   await page.mouse.up();
   assert(active.releasing,'Quick release preserves the recovery');
   await page.waitForFunction(()=>!document.querySelector('.companion-releasing'));
   assert.equal(await facing.evaluate(n=>n.getAnimations().filter(a=>a.effect.getTiming().duration===380).length),0,'Recovery objects are cleaned up');
   assert.equal(await orb.locator('.companion-edge-grip').evaluate(n=>getComputedStyle(n).opacity),'0');
   assert.equal(await page.evaluate(()=>nativeWindowDrags),0,'Pet drags must never start native window dragging');
   await page.emulateMedia({reducedMotion:'reduce'});await settled();
   const beforeFailure=await saved(),beforeBox=await box();
   fs.writeFileSync(faultFile,'/api/ui-preferences');
   await begin(60,40);await page.mouse.up();await settled();assert.equal(await saved(),beforeFailure);
   assert(Math.abs((await box()).x-beforeBox.x)<2,'Failed save restores the saved placement');
   fs.writeFileSync(faultFile,'');
   await orb.focus();await page.keyboard.press('Enter');assert(await isOpen(),'Keyboard activation still opens chat');
   await page.waitForFunction(()=>nativeDragRegion?.[4]?.length===0);
   await page.evaluate(()=>closeAssistant());await page.waitForTimeout(350);
   await page.evaluate(k=>localStorage.setItem(k,'{"version":1,"x":null,"y":-400}'),key);await page.reload();await page.locator('#app-preloader').waitFor({state:'hidden'});await settled();
   b=await box();assert(b.x>=0&&b.y>=0&&b.x+b.width<=1280&&b.y+b.height<=900,'Invalid stored position uses the default');
   assert.deepEqual(errors,[]);
   console.log(`PASS ${engine.name()}: free placement, native titlebar exclusion, top-strip arbitration, one release save, reload, click/keyboard, cancel, boundary, zoom, four attached dock poses, resize and save failure`);
   await browser.close();browser=null;
  }
 } finally {fs.rmSync(faultFile,{force:true});if(browser)await browser.close();const done=once(fixture,'exit');fixture.kill('SIGTERM');await done;}
})().catch(e=>{console.error(e);process.exitCode=1;});
