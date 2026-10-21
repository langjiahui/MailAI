/* Disposable client: theme colors may tint XiaoYou, never add avatar tiles. */
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium,webkit}=require('playwright');
const port=Number(process.env.MAILAI_TRANSPARENT_FIXTURE_PORT||18797);
(async()=>{
 const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/workspace_preview.py'],{
  env:{...process.env,MAILAI_REWARD_MOTION_FIXTURE:'1',MAILAI_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe']
 });
 let logs='',browser;fixture.stdout.on('data',d=>logs+=d);fixture.stderr.on('data',d=>logs+=d);
 try{
  let ready=false;
  for(let i=0;i<100;i++){
   if(fixture.exitCode!==null)throw Error(logs);
   try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break}}catch(_){}
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert(ready,logs);
  browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.locator('#app-preloader').waitFor({state:'detached'});
  const mutate=async(path,body)=>page.evaluate(async({path,body})=>{await api('/api/companion/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await mailaiPet.refresh()},{path,body});
  for(const item of ['theme_monochrome','theme_baowu','sky','wings','orbit'])await mutate('purchase',{item,token:crypto.randomUUID()});
  const transparent=async selector=>{
   // Theme removal can still be interpolating a previous focus shadow. Measure
   // settled finite transitions, without waiting on the pet's ambient loops.
   await page.locator(selector).evaluate(async n=>{
    n.getBoundingClientRect();
    await Promise.all(n.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));
   });
   const css=await page.locator(selector).evaluate(n=>{const s=getComputedStyle(n);return{background:s.backgroundColor,image:s.backgroundImage,shadow:s.boxShadow,border:s.borderTopWidth,backdrop:s.backdropFilter||s.webkitBackdropFilter}});
   assert.equal(css.background,'rgba(0, 0, 0, 0)',`${selector} ${JSON.stringify(css)}`);
   assert.equal(css.image,'none',`${selector}: no colored gradient`);
   assert(css.shadow==='none'||/^rgba\(0, 0, 0, 0\) 0px 0px 0px 0px$/.test(css.shadow),`${selector}: no visible rectangular shadow (${css.shadow})`);
   assert.equal(css.border,'0px',selector);
   assert.equal(css.backdrop,'none',selector);
  };
  for(const reward of ['theme_monochrome','theme_baowu']){
   await mutate('equip',{slot:'theme',item:reward});
   for(const style of ['nature','ranger']){
    await mutate('style',{style});
    for(const mode of ['light','dark']){
     await page.evaluate(mode=>applyTheme(mode),mode);
     await page.evaluate(()=>{closeCompose();closeAssistant()});
     await transparent('#assistant-orb');await page.locator('#assistant-orb').hover();await transparent('#assistant-orb');
     await page.locator('#assistant-orb').focus();
     assert(await page.locator('#assistant-orb').evaluate(n=>getComputedStyle(n).outlineStyle!=='none'),'Keyboard focus remains visible');
     await page.locator('#assistant-orb').press('Enter');await page.locator('#assistant-panel').waitFor({state:'visible'});
     await transparent('#assistant-panel .assistant-mini');
     await page.screenshot({path:`/tmp/mailai-pet-${reward}-${mode}-chat.png`});
     await page.evaluate(()=>{closeAssistant();openCompose()});
     await transparent('#btn-compose-ai');await page.locator('#btn-compose-ai').hover();await transparent('#btn-compose-ai');
     await page.locator('#btn-compose-ai').click();await page.locator('#compose-ai-panel').waitFor({state:'visible'});
     await transparent('#btn-compose-ai');await transparent('.compose-ai-avatar');
     assert(await page.locator('.compose-ai-avatar .mail-companion').isVisible(),'Writing avatar is retained');
     const fill=await page.locator('.compose-ai-avatar .growth-body').evaluate(n=>getComputedStyle(n).fill);
     assert.equal(fill,mode==='dark'?'rgb(131, 181, 212)':'rgb(141, 196, 229)','Equipped sky hue remains above workspace theme, with softer night lighting');
     await page.screenshot({path:`/tmp/mailai-pet-${reward}-${mode}-compose.png`});
     await page.evaluate(()=>closeCompose());
     await page.locator('#assistant-orb').press('Escape');
     await page.screenshot({path:`/tmp/mailai-pet-${reward}-${mode}-floating.png`});
    }
   }
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{document.body.style.zoom='1.25';document.documentElement.style.setProperty('--fz','1.25')});
  await transparent('#assistant-orb');await page.locator('#assistant-orb').hover();await transparent('#assistant-orb');
  await page.evaluate(()=>openCompose());await transparent('#btn-compose-ai');await page.evaluate(()=>toggleComposeAiPanel(true));await transparent('.compose-ai-avatar');
  await page.evaluate(()=>closeCompose());await mutate('equip',{slot:'theme',item:''});
  // Escape above leaves keyboard focus on the orb. The default dark theme
  // intentionally draws a focus halo; verify that focus separately from idle.
  await page.locator('#assistant-orb').focus();
  assert(await page.locator('#assistant-orb').evaluate(n=>getComputedStyle(n).outlineStyle!=='none'),'Default theme keyboard focus remains visible');
  await page.locator('#assistant-orb').blur();
  await transparent('#assistant-orb');
  assert.deepEqual(errors,[]);
  console.log('Transparent XiaoYou: both reward themes, light/dark, cute/cool, floating/chat/writing avatars, hover, active, focus, palette priority and scaled compact layout passed');
 }finally{
  if(browser)await browser.close();
  const stopped=once(fixture,'exit');fixture.kill('SIGTERM');if(fixture.exitCode===null)await stopped;
 }
})().catch(e=>{console.error(e);process.exitCode=1});
