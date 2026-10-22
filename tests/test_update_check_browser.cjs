// Isolated mailbox fixture, mocked update service; never downloads or installs.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch();
 try{
  const page=await browser.newPage({viewport:{width:1360,height:950},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let failed=false,available=false,hold=null,installable=false;
  let task={status:'idle',phase:'idle',running:false},downloads=0,installs=0,statusCalls=0;
  const ready=()=>({status:'completed',phase:'ready',running:false,action:'download',version:'2.8.19',total:100,downloaded:100,percent:100,release:{current_version:'2.8.18',latest_version:'2.8.19',device:'macos-arm64',supported:true,available:true,installable:true}});
  await page.route('**/api/system/update/install/status',route=>{statusCalls++;return route.fulfill({json:task});});
  await page.route('**/api/system/update/download',route=>{
   downloads++;task={...ready(),status:'running',phase:'downloading',running:true,downloaded:23,percent:23};
   return route.fulfill({json:task});
  });
  await page.route(/\/api\/system\/update\/install\/ready(?:\?.*)?$/,route=>{
   installs++;assert.equal(new URL(route.request().url()).searchParams.get('version'),'2.8.19');
   task={...ready(),action:'install',phase:'installer_opened',message:'安装器已打开'};
   return route.fulfill({json:task});
  });
  await page.route(/\/api\/system\/update(?:\?.*)?$/,async route=>{
   if(hold){const wait=hold;hold=null;await wait;return route.fulfill({status:502,json:{detail:'stale check failed'}});}
   if(failed)return route.fulfill({status:502,json:{detail:failed==='sources'?'检查更新失败：无法连接更新服务。国内源：安全证书验证失败，请检查系统日期及公司受信任证书；GitHub：HTTP 403':'连接更新服务中断，请重试或点击“查看发布页”手动下载'}});
   return route.fulfill({json:{current_version:'2.8.18',latest_version:available?'2.8.19':'2.8.18',
    device:'macos-arm64',supported:true,available,installable,notes:'Isolated update fixture. No actual installation.',
    release_url:'https://github.com/langjiahui/MailAI/releases/tag/v2.8.19'}});
  });
  await page.route('**/api/ui-preferences.js',route=>route.fulfill({contentType:'text/javascript',body:''}));
  await page.route('**/api/ui-preferences',route=>route.fulfill({json:{ok:true}}));
  await page.goto(process.env.MAILAI_FIXTURE_URL||'http://127.0.0.1:18795');
  await page.locator('#app-preloader').waitFor({state:'detached'});await page.evaluate(()=>initialLoad);
  await page.evaluate(()=>showSystemView('about'));
  const status=page.locator('#app-update-status'),button=page.locator('#btn-check-update');
  await page.waitForFunction(()=>document.getElementById('app-update-status').dataset.updateState==='latest');
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
  failed=true;await button.click();
  await page.waitForFunction(()=>document.getElementById('app-update-status').dataset.updateState==='error');
  assert.match(await status.innerText(),/检查未完成/);assert(!await button.isDisabled());
  assert(!/最新/.test(await status.innerText()),'Failure must clear a stale latest-version claim');
  assert.equal(await page.locator('#app-release-link').getAttribute('href'),'https://github.com/langjiahui/MailAI/releases/tag/v2.8.19');
  await page.evaluate(()=>setI18nLanguage('en'));assert.match(await status.innerText(),/Check incomplete/);
  failed='sources';await button.click();
  await page.waitForFunction(()=>document.querySelector('#toast .toast-message')?.textContent.includes('China mirror'));
  const diagnostic=await page.locator('#toast').innerText();assert.match(diagnostic,/Certificate verification failed/);assert.match(diagnostic,/HTTP 403/);assert(!/[\u3400-\u9fff]/.test(diagnostic),diagnostic);
  failed=false;await button.click();await page.waitForFunction(()=>document.getElementById('app-update-status').dataset.updateState==='latest');
  assert.match(await status.innerText(),/latest/);
  // A delayed older failure cannot replace a successful newer check.
  let release;hold=new Promise(resolve=>release=resolve);
  const oldRequest=page.waitForRequest(r=>r.url().includes('/api/system/update'));
  await page.evaluate(()=>{window.oldUpdateCheck=checkForAppUpdate(false)});
  await oldRequest;
  await page.evaluate(()=>checkForAppUpdate(true));release();await page.evaluate(()=>window.oldUpdateCheck);
  assert.equal(await status.getAttribute('data-update-state'),'latest');
  available=true;await button.click();await page.locator('#update-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#update-dialog-title').innerText(),/2.8.18.*2.8.19/);
  assert.equal(await status.getAttribute('data-update-state'),'available');
  await page.keyboard.press('Escape');assert(!await button.isDisabled());
  // Defer before download: a quiet interval suppresses automatic prompts, not the manual entry.
  await page.evaluate(()=>checkForAppUpdate(false));
  assert(!await page.locator('#update-dialog').isVisible());
  assert.equal(await page.locator('#btn-continue-update').innerText(),'Continue update');
  installable=true;await button.click();
  const install=page.locator('#btn-install-update'),later=page.locator('#btn-defer-update'),chip=page.locator('#companion-update');
  assert.equal(await install.innerText(),'Download update');
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
  await install.click();
  await page.waitForFunction(()=>document.getElementById('btn-install-update').textContent==='下载中 23%');
  assert(await install.isDisabled());assert.equal(await later.innerText(),'后台下载');
  await later.click();await page.locator('#update-dialog').waitFor({state:'hidden'});
  await chip.waitFor({state:'visible'});assert.match(await chip.innerText(),/23%/);
  assert.equal(downloads,1);assert.equal(installs,0);
  // Regular mail navigation continues, and the independent badge reopens the exact progress.
  await page.locator('#btn-close-system').click();
  await page.locator('.email-item').first().click();
  await page.locator('#reading-content').waitFor({state:'visible'});
  await chip.click();await page.locator('#update-dialog').waitFor({state:'visible'});
  assert.equal(await install.innerText(),'下载中 23%');assert.equal(downloads,1);
  assert.match(await page.locator('#update-progress-detail').innerText(),/23 B \/ 100 B/);
  await page.keyboard.press('Escape');task=ready();
  await page.waitForFunction(()=>document.getElementById('companion-update-copy').textContent.includes('更新已就绪'));
  assert.equal(installs,0,'A background completion must never open Installer');
  assert.equal(await chip.locator('.companion-update-arrow').evaluate(n=>getComputedStyle(n).animationName),'none');
  // Prepared updates remain discoverable after reload even if release discovery is offline.
  failed=true;await page.reload();await page.locator('#app-preloader').waitFor({state:'detached'});await page.evaluate(()=>initialLoad);
  await chip.waitFor({state:'visible'});assert.match(await chip.innerText(),/更新已就绪/);
  assert(!await page.locator('#update-dialog').isVisible());assert.equal(downloads,1);assert.equal(installs,0);
  failed=false;
  // The badge adapts to edge placement and large text on narrow light/dark screens.
  for(const width of [390,1360]) {
   await page.setViewportSize({width,height:950});
   for(const theme of ['light','dark']) {
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.body.style.zoom='1.2';document.documentElement.style.setProperty('--fz','1.2');},theme);
    for(const edge of ['top','left','right','bottom']) {
     await page.evaluate(edge=>{const pet=document.getElementById('mail-assistant');pet.dataset.petEdgeX=edge==='left'?'left':'right';pet.dataset.petEdgeY=edge==='top'?'top':'bottom';Object.assign(pet.style,{left:edge==='left'?'0':'auto',right:edge==='left'?'auto':'0',top:edge==='top'?'0':'auto',bottom:edge==='top'?'auto':'12px'});},edge);
     const box=await chip.boundingBox();assert(box && box.x>=-1 && box.x+box.width<=width+1 && box.y>=-1 && box.y+box.height<=951,JSON.stringify({width,theme,edge,box}));
    }
   }
  }
  await page.evaluate(()=>{document.body.style.zoom='';document.documentElement.style.setProperty('--fz','1');const pet=document.getElementById('mail-assistant');pet.removeAttribute('style');pet.dataset.petEdgeX='right';pet.dataset.petEdgeY='bottom';});
  await page.setViewportSize({width:1360,height:950});
  // Disabling pet motion preserves the usable, static update action.
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>{document.body.classList.add('companion-still');applyAppUpdateTask({status:'running',running:true,phase:'downloading',action:'download',percent:23,total:100,downloaded:23});});
  assert.equal(await chip.locator('.companion-update-arrow').evaluate(n=>getComputedStyle(n).animationName),'none');
  await page.evaluate(async()=>{document.body.classList.remove('companion-still');await refreshAppUpdateTask();});
  await page.waitForFunction(()=>document.getElementById('companion-update').dataset.phase==='ready');
  await chip.click();await page.locator('#update-dialog').waitFor({state:'visible'});
  assert.equal(await install.innerText(),'立即安装');assert.equal(await later.innerText(),'稍后安装');
  await page.evaluate(()=>setI18nLanguage('en'));
  assert.equal(await install.innerText(),'Install now');assert.equal(await later.innerText(),'Install later');
  await page.setViewportSize({width:390,height:720});
  await page.evaluate(()=>{document.body.style.zoom='1.2';document.documentElement.style.setProperty('--fz','1.2');});
  await install.scrollIntoViewIfNeeded();
  const dialogBox=await page.locator('#update-dialog').boundingBox(),installBox=await install.boundingBox();
  assert(dialogBox.x>=0 && dialogBox.x+dialogBox.width<=391);assert(installBox.x>=0 && installBox.x+installBox.width<=391 && installBox.y+installBox.height<=721);
  await install.click();await page.waitForFunction(()=>document.getElementById('btn-install-update').textContent==='Reopen Installer');
  assert.equal(installs,1);assert.equal(downloads,1);assert(await page.locator('#update-dialog').isVisible());
  await install.click();await page.waitForFunction(()=>document.getElementById('btn-install-update').textContent==='Reopen Installer');
  assert.equal(installs,2,'A canceled system installer can be reopened without downloading again');
  assert(statusCalls>0);assert.deepEqual(errors,[]);
  console.log('PASS bilingual checks, defer/continue via pet, uninterrupted mail, preserved progress, explicit install, canceled Installer retry and responsive static/motion states');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
