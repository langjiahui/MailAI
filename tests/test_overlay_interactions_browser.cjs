// Temporary workspace fixture only. Preview data is mocked; no message is sent.
const assert=require('node:assert/strict');
const{chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try{
 const p=await browser.newPage({viewport:{width:900,height:640},reducedMotion:'reduce'}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('**/api/ui-preferences.js',r=>r.fulfill({contentType:'text/javascript',body:''}));
 await p.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
 await p.route('**/attachments/0/preview?*',r=>r.fulfill({json:{kind:'text',name:'交付安排.txt',text:'项目交付安排\n'.repeat(120),message:'本地文本预览'}}));
 await p.goto('http://127.0.0.1:18795/?shell=macos');await p.locator('#app-preloader').waitFor({state:'detached'});await p.evaluate(()=>initialLoad);
 await p.evaluate(async()=>{
  const link=document.createElement('a');link.id='overlay-preview-trigger';link.href='/api/emails/1/attachments/0?mailai_account='+activeMailAccount().id;link.download='交付安排.txt';link.textContent='Preview';document.body.append(link);link.focus();await openAttachmentPreview(link);
 });
 await p.locator('.file-preview pre').waitFor();
 await p.locator('.file-preview').evaluate(dialog=>{const b=dialog.getBoundingClientRect();dialog.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:b.left+2,clientY:b.top+2}));});
 assert(await p.locator('.file-preview').evaluate(n=>n.open));
 await p.evaluate(()=>{window.overlayFocus=document.activeElement;void mailaiAsk({title:'Keep the file open',confirmText:'Continue'})});
 await p.keyboard.press('Escape');await p.locator('.mailai-question').waitFor({state:'detached'});
 assert(await p.locator('.file-preview').evaluate(n=>n.open));assert(await p.evaluate(()=>document.activeElement===overlayFocus));
 await p.keyboard.press('Escape');assert(!await p.locator('.file-preview').evaluate(n=>n.open));assert(await p.locator('#overlay-preview-trigger').evaluate(n=>n===document.activeElement));
 await p.evaluate(()=>openAttachmentPreview(document.getElementById('overlay-preview-trigger')));await p.locator('.file-preview pre').waitFor();
 await p.mouse.click(1,1);assert(!await p.locator('.file-preview').evaluate(n=>n.open),'Clicking the actual backdrop dismisses the preview');
 // Drag coordinates are physical pixels even while the interface uses CSS zoom.
 await p.evaluate(()=>{document.body.style.zoom='1.25';document.documentElement.style.setProperty('--fz','1.25');document.body.classList.add('assistant-floating');localStorage.removeItem('mailai-assistant-layout-v1');updateAssistantPlacement();openAssistant();});
 await p.waitForTimeout(400);
 const panel=p.locator('#assistant-panel'),before=await panel.boundingBox();
 assert(before.x>=0&&before.y>=0&&before.x+before.width<=900&&before.y+before.height<=640,JSON.stringify(before));
 const title=await p.locator('#assistant-panel .assistant-title h2').boundingBox();
 const x=title.x+title.width/2,y=title.y+title.height/2;
 await p.mouse.move(x,y);await p.mouse.down();await p.mouse.move(x-50,y+10,{steps:5});await p.mouse.up();
 const after=await panel.boundingBox();assert(Math.abs(after.x-before.x+50)<=3,JSON.stringify({before,after}));assert(Math.abs(after.y-before.y-10)<=3,JSON.stringify({before,after}));
 await p.evaluate(()=>{closeAssistant();document.body.classList.remove('assistant-floating');updateAssistantPlacement()});
 // Real clicks remain available above the mobile reading layer, including its menu.
 await p.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1')});await p.setViewportSize({width:1512,height:1000});
 await p.locator('.email-item').first().click();await p.waitForFunction(()=>!!selectedEmailDetail);
 await p.evaluate(()=>{setI18nLanguage('zh-CN');window.mailBodyBeforeLanguage=document.querySelector('.email-body');document.querySelector('.message-recipients details').open=true;setI18nLanguage('en')});
 assert.equal(await p.locator('.reading-header .meta-sender-row>.meta-label').textContent(),'From: ');
 assert.equal(await p.locator('.body-section .body-format-actions>small').textContent(),'Plain text · reflowed layout');
 assert.equal(await p.locator('.message-recipients .meta-recipient-row>.meta-label').first().textContent(),'To: ');
 await p.evaluate(()=>setI18nLanguage('zh-CN'));
 assert.equal(await p.locator('.body-section .body-format-actions>small').textContent(),'纯文本邮件 · 优化排版');
 assert.equal(await p.locator('.message-recipients .meta-recipient-row>.meta-label').first().textContent(),'收件人：');
 await p.evaluate(()=>setI18nLanguage('en'));
 assert.equal(await p.locator('.unified-inbox-button>span:not(.icon):not(.count)').textContent(),'All inboxes');
 assert(await p.evaluate(()=>document.querySelector('.email-body')===mailBodyBeforeLanguage&&document.querySelector('.message-recipients details').open),'Language switching must preserve the body and expanded recipients');
 for(const[width,scale]of[[390,1],[390,1.25],[720,1.25],[900,1.25]]){
  await p.setViewportSize({width,height:844});await p.evaluate(scale=>{document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale)},scale);
  await p.locator('#btn-security-menu').click();const menu=await p.locator('#security-menu-popover').boundingBox();
  assert(menu.x>=0&&menu.y>=0&&menu.x+menu.width<=width+1&&menu.y+menu.height<=844,JSON.stringify({width,scale,menu}));await p.keyboard.press('Escape');
  await p.locator('#btn-compose').click();await p.locator('#compose-subject').fill('Keep this subject');await p.locator('#btn-save-draft').click();
 }
 assert.deepEqual(errors,[]);console.log('PASS nested preview Escape/focus, inside padding vs backdrop, 125% floating drag, real toolbar clicks and menus above reading layers ('+(process.env.MAILAI_BROWSER||'chromium')+').');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
