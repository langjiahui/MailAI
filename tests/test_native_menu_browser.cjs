// Isolated workspace only: menus navigate existing pages and never install updates.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({mailboxDone:true,aiDone:true,deferred:true})));
  await page.goto(process.env.MAILAI_TEST_URL||'http://127.0.0.1:18812/?shell=macos');
  await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(async()=>{await initialLoad;setI18nLanguage('zh-CN');});
  for(const [action,panel] of [['settings','preferences'],['about','about'],['help','guide']]){
   assert.equal(await page.evaluate(action=>mailaiNativeMenu(action),action),true);
   assert(await page.locator(`[data-system-panel="${panel}"]`).isVisible());
  }
  await page.locator('#guide-search').fill('不存在的帮助内容');
  assert(!await page.locator('.help-shortcuts').isVisible());
  assert(await page.evaluate(()=>mailaiNativeMenu('shortcuts')));
  assert.equal(await page.locator('#guide-search').inputValue(),'');
  assert(await page.locator('.help-shortcuts').isVisible());
  await page.evaluate(()=>mailaiNativeMenu('font-reset'));
  assert.equal(await page.locator('#font-size').inputValue(),'1');
  await page.evaluate(()=>mailaiNativeMenu('font-larger'));
  assert.equal(await page.locator('#font-size').inputValue(),'1.12');
  assert.equal(await page.evaluate(()=>localStorage.getItem('mailai-font-scale')),'1.12');
  await page.evaluate(()=>mailaiNativeMenu('font-smaller'));
  assert.equal(await page.locator('#font-size').inputValue(),'1');
  for(let i=0;i<8;i++)await page.evaluate(()=>mailaiNativeMenu('font-larger'));
  assert.equal(await page.locator('#font-size').inputValue(),'1.25');
  await page.evaluate(()=>mailaiNativeMenu('font-reset'));
  // Test the existing update UI without a real network check, download or install.
  let checks=0,release;
  await page.route('**/api/system/update*',async route=>{
   if(route.request().url().includes('force=true')){checks++;await new Promise(resolve=>release=resolve);}
   await route.fulfill({json:{current_version:'2.8.22',latest_version:'2.8.22',available:false,supported:true,message:'当前已是最新版本'}});
  });
  const checking=page.evaluate(()=>mailaiNativeMenu('updates'));
  await page.waitForFunction(()=>document.getElementById('btn-check-update').disabled);
  assert(await page.evaluate(()=>mailaiNativeMenu('updates')));
  assert.equal(checks,1,'Repeated native clicks must not duplicate update checks');
  release();await checking;
  assert(await page.locator('[data-system-panel="about"]').isVisible());
  await page.unroute('**/api/system/update*');
  // Do not navigate behind an unfinished modal or discard editor content.
  await page.evaluate(()=>{hideSystemView(true);openCompose();});
  await page.locator('#compose-subject').fill('菜单测试草稿');
  assert.equal(await page.evaluate(()=>mailaiNativeMenu('settings')),false);
  assert.equal(await page.locator('#compose-subject').inputValue(),'菜单测试草稿');
  assert(await page.locator('#compose-modal').isVisible());
  assert.equal(await page.evaluate(()=>mailaiNativeMenu('unknown-action')),false);
  await page.evaluate(()=>setI18nLanguage('en'));
  assert.equal(await page.evaluate(()=>mailaiText('请先完成或关闭当前弹窗，再使用此菜单')),'Finish or close the current dialog before using this menu.');
  assert.deepEqual(errors,[]);
  console.log('PASS native menu pages, shortcuts, saved font sizing, update single-flight and unsaved editor protection');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
