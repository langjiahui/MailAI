// Isolated workspace_preview.py; synthetic mailboxes only, no outgoing actions.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
async function run(engine){
 const browser=await engine.launch();
 try{
  const p=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
  await p.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
  p.on('pageerror',error=>errors.push(error.message));
  const key='mailai.assistant.dockWidth.v1';
  const handle=p.locator('#assistant-dock-divider'),panel=p.locator('#assistant-panel');
  const value=()=>handle.getAttribute('aria-valuenow').then(Number);
  async function settle(){await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function navigate(action){
   // Finish the delayed startup workflow read on every document, then drain
   // periodic reads before teardown so WebKit cannot report an aborted fetch.
   if(p.url()!=='about:blank'){await p.evaluate(()=>mailaiEnergy.pause());await p.waitForLoadState('networkidle');}
   const workflow=p.waitForResponse(response=>new URL(response.url()).pathname==='/api/productivity/workflow');
   await action();await workflow;
  }
  async function reading(){
   await p.locator('#app-preloader').waitFor({state:'hidden'});
   await p.locator('#email-list .email-item').first().waitFor();
   assert(await p.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))));

   await p.locator('#email-list .email-item').first().click();await p.waitForFunction(()=>!!selectedEmailDetail);
   await p.evaluate(()=>openAssistant());await handle.waitFor();await settle();
  }
  async function geometry(){
   const result=await p.evaluate(()=>{
    const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,top:r.top,bottom:r.bottom}};
    const h=document.getElementById('assistant-dock-divider');
    return {panel:rect(document.getElementById('assistant-panel')),reading:rect(document.querySelector('.reading-pane')),divider:rect(h),zoom:parseFloat(getComputedStyle(document.body).zoom)||1,overflow:document.documentElement.scrollWidth>innerWidth+1,value:Number(h.getAttribute('aria-valuenow'))};
   });
   assert(!result.overflow,JSON.stringify(result));
   assert(result.reading.width/result.zoom>=439,JSON.stringify(result));
   assert(Math.abs(result.reading.right-result.panel.left)<2,JSON.stringify(result));
   assert(Math.abs(result.panel.width/result.zoom-result.value)<2,JSON.stringify(result));
   assert(Math.abs((result.divider.left+result.divider.right)/2-result.panel.left)<2,JSON.stringify(result));
   return result;
  }
  await navigate(()=>p.goto((process.env.MAILAI_FIXTURE_URL||'http://127.0.0.1:18795')+'/?shell=macos'));
  await p.locator('#app-preloader').waitFor({state:'hidden'});await p.locator('#email-list .email-item').first().waitFor();
  assert(await p.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))));
  // Native font restoration can leave --fz and the effective body zoom out of
  // step for a frame (or on an older webview). Welcome controls must still fit.
  await p.evaluate(()=>{openAssistant();renderAssistantWelcome();});
  for(const [width,height,zoom,font] of [[2048,1188,1,.85],[1440,900,.85,1],[1440,640,1.25,1.25],[1280,720,.95,.95],[1920,1080,1.1,1.1]]){
    await p.setViewportSize({width,height});
    await p.evaluate(({zoom,font})=>{document.body.style.zoom=zoom;document.documentElement.style.setProperty('--fz',font);updateAssistantPlacement();},{zoom,font});
    await settle();
    const bounds=await p.evaluate(()=>{
      const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
      return {panel:rect(document.getElementById('assistant-panel')),pane:rect(document.querySelector('.reading-pane')),close:rect(document.getElementById('assistant-close')),input:rect(document.getElementById('assistant-input')),home:document.body.classList.contains('assistant-home')};
    });
    for(const name of ['panel','close','input']){
      const r=bounds[name];assert(r.left>=-1&&r.right<=width+1&&r.top>=-1&&r.bottom<=height+1,JSON.stringify({engine:engine.name(),width,height,zoom,font,name,bounds}));
    }
    if(bounds.home){assert(Math.abs(bounds.panel.left-bounds.pane.left)<2);assert(Math.abs(bounds.panel.right-bounds.pane.right)<2);}
    await p.locator('#assistant-input').fill('Synthetic draft survives resize');
  }
  assert.equal(await p.locator('#assistant-input').inputValue(),'Synthetic draft survives resize');
  await p.locator('#assistant-input').fill('');
  await p.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');closeAssistant();});
  await p.setViewportSize({width:1440,height:1000});await settle();

  await p.evaluate(k=>{localStorage.removeItem(k);setI18nLanguage(I18N_DEFAULT_LANG);},key);await navigate(()=>p.reload());await reading();
  assert.equal(await value(),420);await geometry();
  await p.evaluate(()=>{
   const r=document.querySelector('.reading-pane');document.getElementById('reading-content').insertAdjacentHTML('beforeend','<div style="height:4000px">Fixture reading continuation</div>');r.scrollTop=250;
   const m=document.getElementById('assistant-messages');m.insertAdjacentHTML('beforeend','<div class="assistant-message" style="height:3000px">Fixture conversation continuation</div>');mailaiAssistantScroll.restore(200);
  });await settle();
  const tops=()=>p.evaluate(()=>[document.querySelector('.reading-pane').scrollTop,document.getElementById('assistant-messages').scrollTop]);
  const before=await tops(),box=await handle.boundingBox();
  await p.mouse.move(box.x+box.width/2,box.y+box.height/2);await p.mouse.down();await p.mouse.move(box.x+box.width/2-96,box.y+box.height/2,{steps:6});await p.mouse.up();await settle();
  assert.equal(await value(),516);assert.equal(await p.evaluate(k=>localStorage.getItem(k),key),'516');
  const after=await tops();assert(after.every((v,i)=>Math.abs(v-before[i])<2),JSON.stringify({before,after}));await geometry();
  // A canceled drag restores the preference and always releases selection/cursor capture.
  const cancelBox=await handle.boundingBox();await p.mouse.move(cancelBox.x+6,cancelBox.y+90);await p.mouse.down();await p.mouse.move(cancelBox.x-60,cancelBox.y+90);await p.keyboard.press('Escape');await p.mouse.up();
  assert.equal(await value(),516);assert.equal(await p.evaluate(()=>document.body.classList.contains('assistant-width-adjusting')),false);
  await handle.focus();await p.keyboard.press('ArrowRight');assert.equal(await value(),500);
  await p.keyboard.press('Shift+ArrowLeft');assert.equal(await value(),548);
  await p.keyboard.press('Home');assert.equal(await value(),320);
  await p.keyboard.press('End');assert.equal(await value(),Number(await handle.getAttribute('aria-valuemax')));
  await p.keyboard.press('Enter');assert.equal(await value(),420);assert.equal(await p.evaluate(k=>localStorage.getItem(k),key),null);
  await p.keyboard.press('ArrowLeft');assert.equal(await value(),436);
  await navigate(()=>p.reload());await reading();assert.equal(await value(),436,'Width survives a reload');
  const resetBox=await handle.boundingBox();await p.mouse.dblclick(resetBox.x+6,resetBox.y+120);await settle();assert.equal(await value(),420);
  // Clamp to the available space without replacing the wider saved preference.
  await handle.focus();await p.keyboard.press('End');const preferred=await p.evaluate(k=>localStorage.getItem(k),key);
  for(const [viewport,zoom] of [[1280,1],[1600,1],[2048,1],[1440,1.25],[1100,1],[2560,1]]){
   await p.setViewportSize({width:viewport,height:900});await p.evaluate(z=>{document.body.style.zoom=z;document.documentElement.style.setProperty('--fz',z);updateAssistantPlacement();},zoom);await settle();await geometry();
   if(viewport===1280)await handle.click();
   assert.equal(await p.evaluate(k=>localStorage.getItem(k),key),preferred);
  }
  assert.equal(await value(),Number(preferred));
  await p.evaluate(()=>setI18nLanguage('en'));assert.match(await handle.getAttribute('aria-label'),/Resize/);assert.match(await handle.getAttribute('aria-valuetext'),/pixels/);
  await p.setViewportSize({width:390,height:800});await settle();assert.equal(await handle.isVisible(),false);
  await p.setViewportSize({width:1440,height:1000});await settle();await handle.waitFor();
  await p.locator('#assistant-float').click();await settle();assert.equal(await handle.isVisible(),false);
  await p.locator('#assistant-float').click();await handle.waitFor();await geometry();
  await p.evaluate(()=>{setI18nLanguage(I18N_DEFAULT_LANG);applyTheme('dark');});
  await p.screenshot({path:`build/assistant-divider-${engine.name()}.png`});
  await p.evaluate(()=>closeAssistant());await settle();assert.equal(await handle.isVisible(),false);
  assert.deepEqual(errors,[]);console.log(`PASS ${engine.name()}: dock drag/keyboard/reset, reload, canceled capture, reading/chat positions, width clamps, split/docked/floating/mobile modes and zoom`);
 }finally{await browser.close();}
}
(async()=>{for(const engine of [chromium,webkit].filter(e=>!process.env.MAILAI_BROWSER||e.name()===process.env.MAILAI_BROWSER))await run(engine);})().catch(error=>{console.error(error);process.exitCode=1;});
