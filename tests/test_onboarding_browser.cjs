const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}); const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const preferences={};
 await page.route('**/api/ui-preferences.js',route=>route.fulfill({contentType:'application/javascript',body:'window.mailaiPreferenceSeed='+JSON.stringify(preferences)+';'}));
 await page.route('**/api/ui-preferences',route=>{
   const {key,value}=route.request().postDataJSON();preferences[key]=value;
   return route.fulfill({json:{ok:true}});
 });
 let logged=false, available=false, verified=false, valid=false, saved=0;
 await page.route('**/api/system/config',async route=>{
   const response=await route.fetch(); const cfg=await response.json();
   assert.ok(cfg.accounts.every(a=>a.user.endsWith('@example.test')));
   cfg.mail.logged_in=logged; cfg.model.available=available; cfg.model.verified=verified; cfg.model.api_key_masked='';
   if(!logged)cfg.accounts=[];
   await route.fulfill({json:cfg});
 });
 await page.route('**/api/system/model/test',route=>route.fulfill({json:{ok:valid,message:valid?'OK':'API Key 无效（HTTP 401）'}}));
 await page.route('**/api/system/model',route=>{saved++;available=true;verified=true;return route.fulfill({json:{ok:true}})});
 await page.goto(process.env.MAILAI_PREVIEW_URL || 'http://127.0.0.1:18795');
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
 await page.locator('#start-model-result[data-state="error"]').waitFor(); assert.equal(saved,0);
 assert.equal(await page.locator('#start-model-result').getAttribute('role'),'alert');
 assert.equal(await page.locator('#start-model-result-title').innerText(),'连接验证失败');
 assert.match(await page.locator('#start-model-result-detail').innerText(),/401/);
 assert.match(await page.locator('#start-model-result-help').innerText(),/API Key/);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'start-model-result');
 assert.equal(await page.locator('#model-api-key').inputValue(),'fixture-only');
 assert(await page.locator('#start-enable').isEnabled());
 const lum=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
 for(const reward of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark']) {
   await page.evaluate(({reward,mode})=>{if(reward)document.documentElement.dataset.rewardTheme=reward;else delete document.documentElement.dataset.rewardTheme;applyTheme(mode);},{reward,mode});
   const styles=await page.locator('#start-model-result').evaluate(n=>{
     const s=getComputedStyle(n),context=document.createElement('canvas').getContext('2d');
     const rgb=value=>{context.fillStyle=value;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data];};
     return {color:rgb(s.color),bg:rgb(s.backgroundColor),heading:rgb(getComputedStyle(n.querySelector('strong')).color),border:s.borderInlineStartWidth};
   });
   const a=lum(styles.color),b=lum(styles.bg),h=lum(styles.heading);
   assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${reward}/${mode} error text contrast: ${JSON.stringify(styles)}`);
   assert((Math.max(h,b)+.05)/(Math.min(h,b)+.05)>=4.5,`${reward}/${mode} error heading contrast`);
   assert.equal(styles.border,'1px','Error border follows the existing fine card outlines');
   await page.locator('#start-model-result').screenshot({path:`build/model-validation-${process.env.MAILAI_BROWSER||'chromium'}-${reward||'green'}-${mode}.png`});
 }
 await page.evaluate(()=>setI18nLanguage('en'));
 assert.equal(await page.locator('#start-model-result-title').innerText(),'Connection verification failed');
 assert.match(await page.locator('#start-model-result-detail').innerText(),/401/);
 await page.evaluate(()=>{setI18nLanguage('zh-CN');delete document.documentElement.dataset.rewardTheme;});
 valid=true;
 await page.locator('#start-enable').click();
 await page.locator('.start-model').waitFor({state:'hidden'});assert.equal(saved,1);
 assert.equal(await page.locator('[data-system-panel="ai"] #model-config-form').count(),1);
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
