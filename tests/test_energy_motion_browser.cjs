/* Disposable mailbox: sparse ambient motion, responsive reactions, strict background pause. */
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium,webkit} = require('playwright');
const port = Number(process.env.MAILAI_ENERGY_FIXTURE_PORT || 18831);
(async()=>{
  const fixture = spawn(process.env.MAILAI_FIXTURE_PYTHON || 'python3',['tests/workspace_preview.py'],{
    env:{...process.env,MAILAI_REWARD_MOTION_FIXTURE:'1',MAILAI_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe'],
  });
  let logs='',browser;
  fixture.stdout.on('data',data=>logs+=data);fixture.stderr.on('data',data=>logs+=data);
  try {
    let ready=false;
    for(let i=0;i<100;i++) {
      if(fixture.exitCode!==null)throw Error(logs);
      try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch(_){}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(ready,logs);
    browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(()=>{
      document.body.dataset.petAccessory='mech_wings';document.body.dataset.petEffect='orbit';
    });
    const idle=()=>page.waitForFunction(()=>[...document.querySelectorAll('.mail-companion[data-motion-active]')].every(svg=>
      svg.dataset.motionActive==='false' && !svg.getAnimations({subtree:true}).some(a=>a.playState==='running')));
    const awake=selector=>page.waitForFunction(selector=>document.querySelector(selector)?.dataset.motionActive==='true',selector);
    await idle();
    // A real email open supplies the reaction, even if the growth feature is off.
    await page.evaluate(()=>selectEmail(1));await awake('#assistant-orb .mail-companion');
    assert.equal(await page.locator('#assistant-orb .pet-mech-left').evaluate(n=>getComputedStyle(n).animationPlayState),'running');
    await idle(); // The finite response must settle without further interaction.
    // A second interaction must work even while the previous wake window remains open.
    await page.evaluate(()=>mailaiCompanionMotion.wake());
    await awake('#assistant-orb .mail-companion');
    await idle();
    await page.waitForTimeout(4500);await idle(); // Ambient motion waits at least eight seconds.
    // Refreshing the same selected mail is not a new read intent.
    await page.evaluate(()=>selectEmail(1));await idle();
    await page.evaluate(()=>openAssistant());await awake('#assistant-panel .assistant-welcome-portrait .mail-companion');
    // Welcome is event-driven; model-work checks use the actual conversation header.
    await page.evaluate(()=>appendAssistantMessage('user','合成能耗测试'));
    assert.equal(await page.locator('#assistant-orb .mail-companion').getAttribute('data-motion-active'),'false','Opacity-hidden launcher must stop its JS animations too');
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await idle();
    assert(await page.evaluate(()=>document.body.classList.contains('companion-paused')));
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await idle();
    await page.evaluate(()=>mailaiCompanionMotion.wake());await awake('#assistant-panel .mail-companion');
    await page.evaluate(()=>mailaiEnergy.nativeVisibility(1,false));await idle();
    await page.evaluate(()=>mailaiEnergy.nativeVisibility(2,true));await idle();
    // Pending model work resumes when foregrounded and stops when completed.
    await page.evaluate(()=>window.finishEnergyWork=mailaiCompanionWork.begin());
    await awake('#assistant-panel .mail-companion');
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await idle();
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await awake('#assistant-panel .mail-companion');
    await page.locator('#assistant-panel .mail-companion').evaluate(svg=>svg.style.transform='translateX(-5000px)');await idle();
    await page.locator('#assistant-panel .mail-companion').evaluate(svg=>svg.style.removeProperty('transform'));await awake('#assistant-panel .mail-companion');
    await page.evaluate(()=>finishEnergyWork());await idle();
    // The ledge portrait has a CSS animation on the SVG itself, as well as parts.
    await page.evaluate(()=>{closeAssistant();openCompose();});await idle();
    await page.locator('#btn-compose-ai').hover();await awake('#btn-compose-ai .mail-companion');
    await page.mouse.move(0,0);await idle();
    await page.evaluate(()=>mailaiEnergy.nativeVisibility(3,false));await idle();
    await page.evaluate(()=>mailaiEnergy.nativeVisibility(4,true));await idle();
    await page.evaluate(()=>mailaiCompanionMotion.wake());
    await page.emulateMedia({reducedMotion:'reduce'});await idle();
    const heartbeats=[];
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/companion/heartbeat')heartbeats.push(request.postDataJSON());});
    await page.evaluate(async()=>{
      await api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})});
      await mailaiPet.refresh();
      const reschedule=mailaiEnergy.reschedule;
      window.energyDelays=[];
      mailaiEnergy.reschedule=(name,delay)=>{if(name==='companion-growth')energyDelays.push(delay);return reschedule(name,delay);};
      const now=performance.now.bind(performance);
      window.energyClockOffset=91000;
      Object.defineProperty(performance,'now',{configurable:true,value:()=>now()+energyClockOffset});
      await mailaiEnergy.run('companion-growth');
    });
    assert.equal(await page.evaluate(()=>energyDelays.at(-1)),60000,'Idle growth checks use a one-minute cadence');
    await page.evaluate(()=>document.dispatchEvent(new Event('pointerdown')));
    assert.equal(await page.evaluate(()=>energyDelays.at(-1)),10000,'Input restores the reading cadence immediately');
    await page.evaluate(async()=>{energyClockOffset+=10000;await mailaiEnergy.run('companion-growth');delete performance.now;});
    assert.equal(heartbeats.at(-1)?.active,10,'Resuming cannot award the 91-second idle interval');
    // A controlled clock covers minutes of ambient behavior without wall-clock sleeps.
    await page.evaluate(async()=>{await closeCompose();closeAssistant();});
    await page.clock.install();
    await page.evaluate(()=>{
      Math.random=()=>.5;
      // The preceding heartbeat test advances performance.now independently.
      // Start this scenario's input timestamp in the newly installed clock.
      document.dispatchEvent(new Event('input'));
      window.dispatchEvent(new Event('blur'));
      window.ambientClips=[];
      new MutationObserver(()=>{
        const running=[...document.querySelectorAll('.mail-companion[data-motion-kind="ambient"]')];
        if(running.length) ambientClips.push({clips:running.map(svg=>svg.dataset.motionClip),at:performance.now()});
      }).observe(document.body,{subtree:true,attributes:true,attributeFilter:['data-motion-active']});
    });
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.clock.runFor(11501);
    assert.equal(await page.locator('#assistant-orb .mail-companion').getAttribute('data-motion-kind'),'ambient');
    assert.equal(await page.locator('#assistant-orb .pet-mech-left').evaluate(n=>getComputedStyle(n).animationPlayState),'paused','Ambient motion must not wake outfit loops');
    await page.clock.runFor(2000);
    assert.equal(await page.locator('#assistant-orb .mail-companion').getAttribute('data-motion-active'),'false','Ambient clips must settle');
    assert.equal(await page.locator('#assistant-orb .companion-eyes').evaluate(n=>getComputedStyle(n).transform),'none','Settled eyes must not freeze half closed');
    await page.clock.runFor(75000);
    const clips=await page.evaluate(()=>ambientClips);
    assert(clips.length>=5,'Idle mascot must periodically react');
    assert(clips.every(event=>event.clips.length===1),'Only one ambient mascot may perform');
    assert(clips.some(event=>['stretch','step','peek','think'].includes(event.clips[0])),`Long idle must include a larger gesture: ${JSON.stringify(clips)}`);
    const micro=clips.map(event=>event.clips[0]).filter(name=>['breathe','tilt'].includes(name));
    assert(micro.every((name,index)=>!index||name!==micro[index-1]),'Micro gestures must not repeat consecutively');
    await page.evaluate(()=>{window.dispatchEvent(new Event('blur'));ambientClips.length=0;});
    await page.clock.runFor(120000);
    assert.equal(await page.evaluate(()=>ambientClips.length),0,'Background must not schedule ambient motion');
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.clock.runFor(7000);
    assert.equal(await page.evaluate(()=>ambientClips.length),0,'Foreground return must not replay stale gestures');
    await page.clock.runFor(4501);
    await page.evaluate(()=>window.finishAmbientWork=mailaiCompanionWork.begin());
    assert.equal(await page.locator('#assistant-orb .mail-companion').getAttribute('data-motion-clip'),'work','Work must interrupt ambient motion');
    await page.clock.runFor(40000);
    assert.equal(await page.locator('#assistant-orb .mail-companion').getAttribute('data-motion-clip'),'work','No ambient clip may interrupt work');
    await page.evaluate(()=>{finishAmbientWork();ambientClips.length=0;});
    for(let i=0;i<8;i++) {
      await page.evaluate(()=>document.dispatchEvent(new Event('input')));
      await page.clock.runFor(14000);
    }
    assert((await page.evaluate(()=>ambientClips)).every(event=>['breathe','tilt'].includes(event.clips[0])),'Ongoing input must defer large gestures');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>{ambientClips.length=0;});
    await page.clock.runFor(120000);
    assert.equal(await page.evaluate(()=>ambientClips.length),0,'Reduced motion must disable ambient scheduling');
    // Both saved skins have distinct idle, greeting, working and completion clips.
    const setStyle=async style=>{ await page.evaluate(async style=>{
      await api('/api/companion/style',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({style})});
      await mailaiPet.refresh();
    },style); await page.waitForFunction(style=>document.body.dataset.petStyle===style,style); };
    const motionClip=()=>page.locator('#assistant-orb .mail-companion').getAttribute('data-motion-clip');
    await setStyle('ranger');
    await page.evaluate(()=>{ambientClips.length=0;});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.clock.runFor(90000);
    const rangerClips=await page.evaluate(()=>ambientClips.map(event=>event.clips[0]));
    assert(rangerClips.includes('nod') && rangerClips.includes('alert'),`Ranger needs its own micro gestures: ${JSON.stringify(rangerClips)}`);
    assert(rangerClips.some(name=>['survey','ready','swim'].includes(name)),'Ranger needs its own idle gestures');
    assert(rangerClips.every(name=>['nod','alert','survey','ready','swim'].includes(name)),'Ranger must not borrow nature gestures');
    await page.evaluate(()=>document.querySelector('#assistant-orb .companion-art').dispatchEvent(new Event('pointerenter')));
    assert.equal(await motionClip(),'finWave');
    await page.evaluate(()=>window.finishSkinWork=mailaiCompanionWork.begin());
    assert.equal(await motionClip(),'rangerWork');
    await setStyle('nature');
    assert.equal(await motionClip(),'work','Changing skin during work updates the active clip');
    await setStyle('ranger');
    assert.equal(await motionClip(),'rangerWork');
    await page.evaluate(()=>finishSkinWork());
    await page.evaluate(()=>{const root=document.getElementById('mail-assistant');root.dataset.answerComplete='true';root.classList.add('state-thinking');});
    await page.evaluate(()=>document.getElementById('mail-assistant').classList.remove('state-thinking'));
    assert.equal(await motionClip(),'bubbleJoy');
    await setStyle('nature');
    assert.equal(await motionClip(),'happy','Completion feedback follows the new skin');
    await page.evaluate(()=>document.getElementById('mail-assistant').classList.remove('companion-finished'));
    await page.clock.runFor(4000);
    await page.evaluate(()=>document.querySelector('#assistant-orb .companion-art').dispatchEvent(new Event('pointerenter')));
    assert.equal(await motionClip(),'greet');
    await page.evaluate(()=>{document.body.dataset.petStyle='unknown-future-skin';mailaiCompanionMotion.wake();});
    await page.clock.runFor(4000);
    await page.evaluate(()=>mailaiCompanionMotion.wake());
    assert.equal(await motionClip(),'peek','Unknown skins fall back safely');
    assert.deepEqual(errors,[]);
    console.log('PASS motion energy: distinct skin personalities and live skin switching, sparse ambient gestures, non-repeating motion, quiet outfits, input deferral, background/reduced-motion suspension; email intent, finite reactions, same-email refresh, chat/hidden launcher, focus/native pause, ongoing work, perch and reduced motion');
  } finally {
    if(browser)await browser.close();
    const stopped=once(fixture,'exit');fixture.kill('SIGTERM');if(fixture.exitCode===null)await stopped;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
