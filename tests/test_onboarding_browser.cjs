const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}); const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 let logged=false, available=false, verified=false, valid=false, saved=0;
 await page.route('**/api/system/config',async route=>{
   const response=await route.fetch(); const cfg=await response.json();
   assert.ok(cfg.accounts.every(a=>a.user.endsWith('@example.test')));
   cfg.mail.logged_in=logged; cfg.model.available=available; cfg.model.verified=verified; cfg.model.api_key_masked='';
   if(!logged)cfg.accounts=[];
   await route.fulfill({json:cfg});
 });
 await page.route('**/api/system/model/test',route=>route.fulfill({json:{ok:valid,message:valid?'OK':'测试连接失败'}}));
 await page.route('**/api/system/model',route=>{saved++;available=true;verified=true;return route.fulfill({json:{ok:true}})});
 await page.goto('http://127.0.0.1:18795');
 await page.locator('#onboarding-title').waitFor({state:'visible'});
 await page.locator('#app-preloader').waitFor({state:'hidden'});
 assert.equal(await page.locator('#onboarding-title').textContent(),'欢迎使用 MailAI');
 for(const theme of ['light','dark']) {
   await page.evaluate(t=>applyTheme(t),theme);
   await page.screenshot({path:`/tmp/mailai-onboarding-${theme}.png`});
 }
 await page.locator('#onboarding-later').click();
 assert.equal(await page.locator('.start-card h3').textContent(),'尚未连接邮箱');
 logged=true;
 await page.evaluate(async()=>{await loadSystemConfig();mailOnboarding.connected(true)});
 await page.locator('#start-model-title').waitFor({state:'visible'});
 await page.evaluate(()=>{_systemConfig.model.saved_providers=['deepseek'];_systemConfig.model.profiles={deepseek:{base_url:'https://saved.test/v1',model:'saved-model',extra_params:{},verify_ssl:true}}});
 await page.locator('#model-provider').selectOption('deepseek');
 assert.equal(saved,0,'selecting a saved provider in onboarding must not activate it before verification');
 assert.equal(await page.locator('#model-name').inputValue(),'saved-model');
 await page.locator('#model-provider').selectOption('custom');
 await page.locator('#model-base-url').fill('https://model.example.test/v1');
 await page.locator('#model-name').fill('fixture'); await page.locator('#model-api-key').fill('fixture-only');
 await page.locator('#start-enable').click();
 await page.getByText('测试连接失败',{exact:true}).waitFor(); assert.equal(saved,0);
 valid=true;
 for(const theme of ['light','dark']) {
   await page.evaluate(t=>applyTheme(t),theme);
   await page.screenshot({path:`/tmp/mailai-model-${theme}.png`});
 }
 await page.locator('#start-enable').click();
 await page.locator('.start-model').waitFor({state:'hidden'});assert.equal(saved,1);
 assert.equal(await page.locator('.admin-settings #model-config-form').count(),1);
 await page.locator('.start-card .action-primary').click();
 await page.locator('.start-card .action-primary').click();
 assert.match(await page.locator('.start-card h3').textContent(),/2 \/ 3/);
 await page.locator('.start-card .action-primary').click();
 assert.equal(await page.locator('.start-card h3').textContent(),'体验小邮');
 await page.locator('.start-card .btn-ghost').click();
 await page.reload(); await page.waitForFunction(()=>!!window.mailOnboarding && !!_systemConfig);
 assert.equal(await page.locator('.start-card').isVisible(),false);
 available=true;verified=false;await page.evaluate(async()=>{await loadSystemConfig();openAssistant()});
 await page.locator('#start-assistant').waitFor({state:'visible'});
 assert.equal(await page.locator('#assistant-form').isVisible(),false);
 assert.deepEqual(errors,[]);
 console.log('PASS welcome, light/dark, skip, model failure without save, verified enable, form restoration, tutorial persistence, assistant gating');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
