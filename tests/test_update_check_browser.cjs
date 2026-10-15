// Isolated mailbox fixture, mocked update service; never downloads or installs.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch();
 try{
  const page=await browser.newPage({viewport:{width:1360,height:950},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let failed=false,available=false,hold=null;
  await page.route(/\/api\/system\/update(?:\?.*)?$/,async route=>{
   if(hold){const wait=hold;hold=null;await wait;return route.fulfill({status:502,json:{detail:'stale check failed'}});}
   if(failed)return route.fulfill({status:502,json:{detail:'连接更新服务中断，请重试或点击“查看发布页”手动下载'}});
   return route.fulfill({json:{current_version:'2.8.18',latest_version:available?'2.8.19':'2.8.18',
    device:'macos-arm64',supported:true,available,installable:false,
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
  assert.deepEqual(errors,[]);
  console.log('PASS update failure replaces stale latest status, bilingual recovery, manual retry, stale response protection and available-version dialog');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
