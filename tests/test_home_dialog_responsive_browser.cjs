// Use MAILAI_REWARD_MOTION_FIXTURE=1 tests/workspace_preview.py. All accounts are temporary.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium,webkit}=require('playwright');
const cases=require('./helpers/home-dialog-cases.cjs');
(async()=>{
 const engine=process.env.MAILAI_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true});const errors=[];let checked=0;
 const out='build/home-dialog-preview';fs.mkdirSync(out,{recursive:true});
 try {
 const p=await browser.newPage({viewport:{width:1512,height:1000},reducedMotion:'reduce'});
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('**/api/ui-preferences.js',r=>r.fulfill({contentType:'text/javascript',body:'/* isolated UI state */'}));
 await p.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
 await p.goto('http://127.0.0.1:18795/?shell=macos');await p.locator('#app-preloader').waitFor({state:'detached'});await p.evaluate(()=>initialLoad);
 assert(await p.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))));
 await p.evaluate(async()=>{for(const item of ['theme_monochrome','theme_baowu'])await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item,token:crypto.randomUUID()})});await mailaiPet.refresh()});
 const widths=[[390,844,1],[720,844,1.25],[900,640,1.25],[1512,1000,1],[2560,1080,1]];
 for(const[name,selector,open,close]of cases) for(const language of ['zh-CN','en']) {
  await p.setViewportSize({width:1512,height:1000});
  await p.evaluate(language=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');setI18nLanguage(language)},language);
  await p.evaluate('('+open.toString()+')()');await p.locator(selector).waitFor({state:'visible'});
  for(const theme of ['', 'theme_monochrome','theme_baowu']) {
   await p.evaluate(async theme=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});await mailaiPet.refresh()},theme);
   for(const mode of ['light','dark']) {
    await p.evaluate(mode=>applyTheme(mode),mode);
    for(const[width,height,scale]of widths) {
     await p.setViewportSize({width,height});await p.evaluate(scale=>{document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale)},scale);
     // WebKit delivers resize events on the next frame; measure the settled layout.
     await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
     const context={theme,mode,language,name,width,height,scale};
     const metrics=await p.locator(selector).evaluate(n=>{
      const r=n.getBoundingClientRect();
      const scrollRail=b=>{for(let a=b.parentElement;a&&a!==n;a=a.parentElement)if(['auto','scroll'].includes(getComputedStyle(a).overflowX)&&a.scrollWidth>a.clientWidth)return true;return false};
      const clipped=[...n.querySelectorAll('button')].filter(b=>b.getClientRects().length&&!scrollRail(b)).filter(b=>{const q=b.getBoundingClientRect();return q.left< -1||q.right>innerWidth+1}).map(b=>b.id||b.textContent.trim().slice(0,40));
      return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,overflow:n.scrollWidth>n.clientWidth+2,clipped};
     });
     assert(metrics.x>=-1&&metrics.y>=-1&&metrics.right<=width+1&&metrics.bottom<=height+1&&!metrics.overflow&&!metrics.clipped.length,JSON.stringify({context,metrics}));
     if(name==='compose'&&width===390)assert((await p.locator('.compose-editor').boundingBox()).height>=120,'Narrow composer needs usable writing space');
     if(theme==='theme_baowu'&&mode==='dark'&&language==='en'&&((width===390&&['compose','search','login','todos'].includes(name))||(width===2560&&['compose','contacts','attachments'].includes(name)))) await p.screenshot({path:`${out}/${name}-blue-dark-en-${width}-${process.env.MAILAI_BROWSER||'chromium'}.png`});
     checked++;
    }
   }
  }
  await p.evaluate('('+close.toString()+')()');
  console.log('PASS layout: '+name+' / '+language);
 }
 // All original toolbar commands remain physically reachable on the homepage.
 await p.setViewportSize({width:1512,height:1000});await p.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1')});
 await p.locator('.email-item').first().click();await p.waitForFunction(()=>!!selectedEmailDetail);
 for(const language of ['zh-CN','en']) {
  await p.evaluate(language=>setI18nLanguage(language),language);
  for(const[width,height,scale]of widths) {
   await p.setViewportSize({width,height});await p.evaluate(scale=>{document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale)},scale);
   const geometry=await p.evaluate(()=>{
    const header=document.querySelector('.topbar').getBoundingClientRect();
    const commands=['btn-compose','btn-contacts','btn-attachments','btn-todos','btn-security-menu','btn-task-center','btn-poll','btn-digest','btn-preferences','btn-mobile-nav'];
    return{overflow:document.documentElement.scrollWidth>innerWidth+1,bad:commands.map(id=>document.getElementById(id)).filter(n=>n&&n.getClientRects().length).filter(n=>{const r=n.getBoundingClientRect();return r.left< -1||r.right>innerWidth+1||r.bottom>header.bottom+1||!n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}).map(n=>n.id)};
   });
   assert(!geometry.overflow&&!geometry.bad.length,JSON.stringify({language,width,scale,geometry}));checked++;
  }
 }
 // Nested Escape closes the confirmation, preserving the attachment preview.
 await p.setViewportSize({width:900,height:640});await p.evaluate(()=>{document.body.style.zoom='1.25';document.documentElement.style.setProperty('--fz','1.25');setI18nLanguage('en');});
 await p.evaluate(()=>document.querySelector('.file-preview').showModal());
 await p.locator('.file-preview').evaluate(dialog=>{
  const b=dialog.getBoundingClientRect();dialog.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:b.left+2,clientY:b.top+2}));
 });
 assert(await p.locator('.file-preview').evaluate(n=>n.open),'Inside border click must retain the preview');
 await p.evaluate(()=>{void mailaiAsk({title:'Keep the preview',confirmText:'Continue'});});
 await p.keyboard.press('Escape');await p.locator('.mailai-question').waitFor({state:'detached'});
 assert(await p.locator('.file-preview').evaluate(n=>n.open),'Escape must leave the underlying preview open');
 await p.keyboard.press('Escape');assert(!await p.locator('.file-preview').evaluate(n=>n.open));
 await p.evaluate(()=>document.getElementById('assistant-document-reply').showModal());
 await p.locator('#assistant-document-reply').evaluate(dialog=>{const b=dialog.getBoundingClientRect();dialog.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:b.left+2,clientY:b.top+2}));});
 assert(await p.locator('#assistant-document-reply').evaluate(n=>n.open));await p.keyboard.press('Escape');
 // Changing languages updates generated choices without altering compose contents or sender.
 await p.evaluate(async()=>{await openCompose();document.getElementById('compose-subject').value='Keep this subject';window.composeAuditSender=document.getElementById('compose-from').value;setI18nLanguage('zh-CN');setI18nLanguage('en');});
 assert.equal(await p.locator('#compose-subject').inputValue(),'Keep this subject');assert.equal(await p.locator('#compose-from').inputValue(),await p.evaluate(()=>composeAuditSender));
 assert(!(await p.locator('#compose-from option:checked').textContent()).includes('当前'));
 assert.equal(await p.locator('#compose-signature-select option').first().textContent(),'No signature');
 await p.setViewportSize({width:390,height:844});await p.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1')});
 await p.locator('.compose-format-tools button').last().focus();assert(await p.locator('.compose-format-tools button').last().evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}),'Keyboard can reach the end of the format rail');
 await p.evaluate(()=>closeCompose());
 await p.evaluate(async()=>{setI18nLanguage('zh-CN');applyTheme('light');await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});});
 assert.deepEqual(errors,[]);console.log(`PASS ${checked} homepage/dialog layouts: ${cases.length} dialog surfaces, six palettes, two languages, 390–2560px, 125% scaling; nested Escape, inside clicks, language retention and format rail (${process.env.MAILAI_BROWSER||'chromium'}).`);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
