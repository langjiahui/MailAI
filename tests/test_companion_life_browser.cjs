const {selectTab}=require('./helpers/companion-ui.cjs');
/* Independent disposable mailbox: expressive growth, local sound and energy boundaries. */
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium,webkit}=require('playwright');
const {reducedMotion}=require('./helpers/media.cjs');
const port=Number(process.env.MAILAI_LIFE_FIXTURE_PORT||18843);
require('node:fs').mkdirSync('output/xiaoyou-upgrade',{recursive:true});
(async()=>{
  const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/workspace_preview.py'],{
    env:{...process.env,MAILAI_GROWTH_FIXTURE:'1',MAILAI_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe'],
  });
  let logs='',browser;
  fixture.stdout.on('data',data=>logs+=data);fixture.stderr.on('data',data=>logs+=data);
  try {
    let ready=false;
    for(let i=0;i<150;i++) {
      if(fixture.exitCode!==null) throw Error(logs);
      try {if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch(_){}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(ready,logs);
    browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
    const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    // Measure the gesture's cost independently of legitimate timed activity
    // rewards. Hold heartbeats until both unchanged-balance assertions finish,
    // then let every held request reach the fixture and resume normal updates.
    const heldHeartbeats=[];
    await page.route('**/api/companion/heartbeat',route=>heldHeartbeats.push(route));
    await page.addInitScript(()=>{
      localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true}));
      window.audioContexts=[];window.audioNotes=[];
      const Audio=window.AudioContext||window.webkitAudioContext;
      window.AudioContext=class extends Audio {
        constructor(...args){super(...args);audioContexts.push(this);}
        createOscillator(){const note=super.createOscillator();audioNotes.push(note);return note;}
      };
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.body.dataset.petStage==='3');
    await page.evaluate(()=>mailaiPet.open());
    const hero=page.locator('.pet-hero-portrait .mail-companion');
    await hero.waitFor();
    await page.waitForTimeout(300);
    assert.match(await page.locator('.pet-life').getAttribute('aria-label'),/小邮的陪伴时刻/);
    await selectTab(page.locator('#companion-growth-dialog'),'settings');
    assert.equal(await page.locator('[data-pet-life-action="sound"]').getAttribute('aria-pressed'),'false');
    await selectTab(page.locator('#companion-growth-dialog'),'home');
    const before=await page.evaluate(()=>api('/api/companion/growth'));
    await page.locator('[data-pet-life-action="signature"]').click();
    await page.waitForFunction(()=>document.querySelector('.pet-hero-portrait .mail-companion').dataset.motionClip==='deliver');
    assert.equal(await hero.getAttribute('data-expression'),'joy');
    const pose=()=>hero.locator('.companion-figure').evaluate(el=>getComputedStyle(el).transform);
    const first=await pose();await page.waitForTimeout(450);assert.notEqual(await pose(),first,'Signature really moves');
    assert.equal(await hero.locator('.companion-grin').evaluate(el=>getComputedStyle(el).display),'block');
    // Deliver lasts 2200ms, followed by a bounded 445ms landing. Wait for the
    // observable idle state rather than asserting during that new landing.
    await page.waitForFunction(()=>document.querySelector('.pet-hero-portrait .mail-companion').dataset.motionActive==='false',null,{timeout:3000});
    assert.equal(await hero.getAttribute('data-motion-active'),'false','Signature finishes and releases the rig');
    assert.equal(await page.evaluate(()=>audioContexts.length),0,'No audio device is opened by default');
    const after=await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(after.xp,before.xp,'Playing is free and does not farm growth');assert.equal(after.stamps,before.stamps);
    await page.unroute('**/api/companion/heartbeat');
    await Promise.all(heldHeartbeats.map(route=>route.continue()));
    // All seven learned gestures, for both routes, use the shared visible rig.
    for(const style of ['nature','ranger']) for(let stage=1;stage<=7;stage++) {
      // These are temporary visual fixtures, not saved preferences. Sample the
      // gesture and its appearance in the same browser task: a normal heartbeat
      // may otherwise restore the saved route between separate protocol calls.
      const appearance=await page.evaluate(({style,stage})=>{
        document.body.dataset.petStyle=style;document.body.dataset.petStage=String(stage);
        const portrait=document.querySelector('.pet-hero-portrait');
        const svg=portrait.querySelector('.mail-companion');
        const reacted=mailaiCompanionMotion.react('signature',portrait);
        return {reacted,clip:svg.dataset.motionClip,
          nature:getComputedStyle(svg.querySelector('.companion-nature-only')).display,
          ranger:getComputedStyle(svg.querySelector('.companion-ranger-only')).display,
          face:svg.querySelector('.companion-face').getBoundingClientRect().width>0};
      },{style,stage});
      const expected=(style==='nature'?['greet','step','deliver','happy','glide','bow','phoenix']:['finWave','swim','dispatch','bubbleJoy','dive','soar','kunpeng'])[stage-1];
      assert.equal(appearance.reacted,true,'Each route and stage starts its learned gesture');
      assert.equal(appearance.clip,expected);
      assert.equal(appearance.nature,style==='nature'?'inline':'none');
      assert.equal(appearance.ranger,style==='ranger'?'block':'none');
      assert.equal(appearance.face,style==='nature','Each route has its own body and face');
    }
    // Costumes remain optional, and never become permanent parts of either creature.
    for (const [item,equipped] of [['cap','.growth-cap'],['scarf','.growth-scarf']]) {
      const appearance=await page.evaluate(({item,equipped})=>{
        const part=document.querySelector('.pet-hero-portrait .mail-companion').querySelector(equipped);
        document.body.dataset.petAccessory=item;document.body.dataset.petOutfits=item;
        const worn=getComputedStyle(part).display;
        document.body.dataset.petAccessory='';document.body.dataset.petOutfits='';
        return {worn,removed:getComputedStyle(part).display};
      },{item,equipped});
      assert.equal(appearance.worn,'block');
      assert.equal(appearance.removed,'none');
    }
    await page.evaluate(()=>mailaiPet.refresh());
    // Only explicit opt-in opens audio; every graph is short lived.
    await selectTab(page.locator('#companion-growth-dialog'),'settings');
    await page.locator('[data-pet-life-action="sound"]').click();
    await page.waitForFunction(()=>audioNotes.length===2);
    assert.equal(await page.evaluate(()=>localStorage.getItem('mailai-companion-sound')),'on');
    await page.waitForFunction(()=>audioContexts.every(context=>context.state==='closed'));
    await page.locator('[data-pet-life-chatter]').uncheck();
    await page.reload();await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(()=>mailaiPet.open());await hero.waitFor();
    await selectTab(page.locator('#companion-growth-dialog'),'settings');
    assert.equal(await page.locator('[data-pet-life-action="sound"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-pet-life-chatter]').isChecked(),false);
    assert.equal(await page.evaluate(()=>audioContexts.length),0,'Reload cannot autoplay sound');
    await selectTab(page.locator('#companion-growth-dialog'),'home');
    await page.locator('[data-pet-life-action="hello"]').click();
    await page.waitForFunction(()=>audioContexts.length===1);
    // The context is recorded in its constructor, before async resume creates
    // the sound graph. Exercise blur cleanup after playback has actually begun.
    await page.waitForFunction(()=>audioNotes.length===2);
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await page.waitForFunction(()=>audioContexts.every(context=>context.state==='closed'));
    assert.equal(await hero.getAttribute('data-motion-active'),'false');
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1900);
    // Reduced motion keeps feedback readable and prevents animation/sound demos.
    await reducedMotion(page,'reduce');
    const audioCount=await page.evaluate(()=>audioContexts.length);
    await page.locator('[data-pet-life-action="signature"]').click();
    assert.equal(await hero.getAttribute('data-motion-active'),'false');
    assert.match(await page.locator('[data-pet-life-status]').textContent(),/减少动态效果/);
    assert.equal(await page.evaluate(()=>audioContexts.length),audioCount);
    await reducedMotion(page,'no-preference');
    await page.waitForTimeout(1900);
    await page.evaluate(()=>window.lifeWork=mailaiCompanionWork.begin());
    await selectTab(page.locator('#companion-growth-dialog'),'home');
    await page.locator('[data-pet-life-action="hello"]').click();
    await hero.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('.pet-hero-portrait .mail-companion').dataset.motionClip==='work');
    assert.equal(await hero.getAttribute('data-motion-clip'),'work');
    assert.match(await page.locator('[data-pet-life-status]').textContent(),/正专心/);
    await page.evaluate(()=>lifeWork());
    // Native hiding, manual motion preference, offscreen and closed journal.
    await page.evaluate(()=>mailaiCompanionMotion.react('signature'));
    await page.evaluate(()=>mailaiEnergy.nativeVisibility(1,false));
    assert.equal(await hero.getAttribute('data-motion-active'),'false');
    await page.evaluate(()=>mailaiEnergy.nativeVisibility(2,true));
    await page.evaluate(()=>{document.body.classList.add('companion-still');mailaiCompanionMotion.react('signature');});
    assert.equal(await hero.getAttribute('data-motion-active'),'false');
    await page.evaluate(()=>{document.body.classList.remove('companion-still');mailaiCompanionMotion.react('signature');});
    await page.locator('.pet-hero-portrait').evaluate(el=>el.style.transform='translateX(-200vw)');
    await page.waitForFunction(()=>document.querySelector('.pet-hero-portrait .mail-companion').dataset.motionActive==='false');
    await page.locator('.pet-hero-portrait').evaluate(el=>el.style.transform='');
    await page.keyboard.press('Escape');
    assert.equal(await hero.getAttribute('data-motion-active'),'false');
    // A milestone is emitted only for a real transition, not initial loading.
    await page.evaluate(()=>{window.milestones=[];document.addEventListener('mailai:companion-milestone',e=>milestones.push(e.detail));});
    await page.evaluate(async()=>{
      await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item:'berry',token:crypto.randomUUID()})});
      await mailaiPet.refresh();
    });
    assert.equal(await page.evaluate(()=>milestones.filter(e=>e.evolved).length),1);
    await page.evaluate(()=>mailaiPet.refresh());
    assert.equal(await page.evaluate(()=>milestones.filter(e=>e.evolved).length),1);
    // Genuine pointer entry reaches the button even though its artwork ignores pointers.
    await page.mouse.move(0,0);await page.waitForTimeout(2400);
    await page.locator('#assistant-orb').hover();
    await page.waitForFunction(()=>document.querySelector('#assistant-orb .mail-companion').dataset.motionClip==='greet');
    await page.evaluate(()=>mailaiPet.open());
    await selectTab(page.locator('#companion-growth-dialog'),'settings');
    await page.locator('[data-pet-life-chatter]').check();
    // The journal's close handler discards old bubbles. Await that handler
    // before requesting a fresh idle message, not just the visual dismissal.
    await page.evaluate(()=>{window.lifeJournalClosed=new Promise(resolve=>document.getElementById('companion-growth-dialog').addEventListener('close',resolve,{once:true}));});
    await page.keyboard.press('Escape');
    await page.evaluate(()=>lifeJournalClosed);
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('mailai:companion-idle',{detail:{svg:document.querySelector('#assistant-orb .mail-companion')}})));
    const bubbleState=await page.evaluate(()=>({body:document.body.className,root:document.getElementById('mail-assistant').className,
      dialogs:[...document.querySelectorAll('dialog[open]')].map(n=>n.id),nudge:!!document.querySelector('.assistant-nudge:not(.hidden)'),
      bubble:document.querySelector('.companion-life-bubble').hidden}));
    assert.equal(await page.locator('.companion-life-bubble').isVisible(),true,JSON.stringify(bubbleState));
    const bubbleCopy=await page.locator('.companion-life-bubble').textContent();
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('mailai:companion-idle',{detail:{svg:document.querySelector('#assistant-orb .mail-companion')}})));
    assert.equal(await page.locator('.companion-life-bubble').textContent(),bubbleCopy,'Automatic chatter is rate limited');
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    assert.equal(await page.locator('.companion-life-bubble').isVisible(),false);
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    assert.equal(await page.locator('.companion-life-bubble').isVisible(),false,'Background speech is discarded');
    await page.evaluate(()=>mailaiPet.open());
    await page.locator('.pet-journal-body').evaluate(el=>el.scrollTop=0);
    await page.waitForTimeout(350);
    await page.screenshot({path:`output/xiaoyou-upgrade/desktop-${process.env.MAILAI_BROWSER||'chromium'}.png`});
    // Narrow, dark and English views keep controls within the dialog.
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';setI18nLanguage('en');mailaiPet.open();});
    await page.locator('.pet-life').scrollIntoViewIfNeeded();
    assert.match(await page.locator('.pet-life').getAttribute('aria-label'),/A moment with XiaoYou/);
    assert(await page.locator('.pet-life').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await page.screenshot({path:`output/xiaoyou-upgrade/mobile-${process.env.MAILAI_BROWSER||'chromium'}.png`});
    assert.deepEqual(errors,[]);
    console.log('PASS XiaoYou life: 14 stage/route moves, visible face and motion, free interaction, sound opt-in/persistence/cleanup, work priority, reduced/manual motion, native/focus/offscreen pause, milestone deduplication, dark mobile English layout');
  } finally {
    if(browser) await browser.close();
    const stopped=once(fixture,'exit');fixture.kill('SIGTERM');if(fixture.exitCode===null) await stopped;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
