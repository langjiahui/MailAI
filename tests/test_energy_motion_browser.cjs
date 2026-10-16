/* Disposable mailbox: motion is available on intent, and silent while idle. */
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
    await page.waitForTimeout(4500);await idle(); // No ambient timer restarts it.
    // Refreshing the same selected mail is not a new read intent.
    await page.evaluate(()=>selectEmail(1));await idle();
    await page.evaluate(()=>openAssistant());await awake('#assistant-panel .mail-companion');
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
    assert.deepEqual(errors,[]);
    console.log('PASS motion energy: idle has zero running rig animations; email intent, finite reactions, same-email refresh, chat/hidden launcher, focus/native pause, ongoing work, perch and reduced motion');
  } finally {
    if(browser)await browser.close();
    const stopped=once(fixture,'exit');fixture.kill('SIGTERM');if(fixture.exitCode===null)await stopped;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
