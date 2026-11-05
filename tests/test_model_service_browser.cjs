// Isolated workspace fixture; every model request below is synthetic and intercepted.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const fs=require('node:fs');
(async()=>{
 const engine=process.env.MAILAI_BROWSER==='webkit'?webkit:chromium,browser=await engine.launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[],calls=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
  let configuration,model={provider:'custom',base_url:'https://model.example.test/v1',model:'synthetic-model',multimodal_model:'',multimodal_enabled:false,extra_params:{},verify_ssl:true,available:true,verified:true,api_key_masked:'fixture-mask',saved_providers:['custom','deepseek'],profiles:{deepseek:{base_url:'https://saved.example.test/v1',model:'saved-model',multimodal_enabled:false,extra_params:{},verify_ssl:true}}};
  let probe={ok:true,message:'OK'},saveFailure=false,held=null,started=null;
  await page.route('**/api/system/config',async route=>{
   const response=await route.fetch();configuration=await response.json();
   assert(configuration.accounts.every(account=>account.user.endsWith('@example.test')));
   await route.fulfill({json:{...configuration,model}});
  });
  await page.route('**/api/system/model/test',async route=>{
   calls.push({kind:'test',payload:route.request().postDataJSON()});
   if(started){const signal=started;started=null;await new Promise(resolve=>{held=resolve;signal();});}
   await route.fulfill({json:probe});
  });
  await page.route('**/api/system/model',async route=>{
   calls.push({kind:'save',payload:route.request().postDataJSON()});
   if(saveFailure)return route.fulfill({status:503,json:{detail:'Synthetic save unavailable'}});
   model={...model,...route.request().postDataJSON(),verified:true};delete model.api_key;
   await route.fulfill({json:{ok:true,config:{...configuration,model}}});
  });
  await page.goto(process.env.MAILAI_TEST_URL||'http://127.0.0.1:18795');
  await page.locator('#app-preloader').waitFor({state:'hidden'});
  await page.evaluate(()=>{setI18nLanguage('zh-CN');showSystemView('ai');});
  await page.waitForFunction(()=>document.getElementById('model-base-url').value==='https://model.example.test/v1');
  const primary=page.locator('#btn-save-model'),feedback=page.locator('#model-action-feedback'),more=page.locator('#model-more-actions');
  const done=async state=>{await page.waitForFunction(()=>!document.getElementById('model-config-form').hasAttribute('aria-busy'));assert.equal(await feedback.getAttribute('data-state'),state);};
  const extra=async id=>{await more.locator('summary').click();await page.locator(id).click();};
  await page.locator('#model-provider').selectOption('deepseek');
  assert.equal(calls.length,0,'Choosing a saved profile loads a draft without activating it');
  assert.equal(await page.locator('#model-name').inputValue(),'saved-model');
  assert.match(await page.locator('#model-status').textContent(),/未保存/);
  await page.locator('#model-api-key').fill('synthetic-key-only');
  await page.evaluate(()=>loadSystemConfig());
  assert.equal(await page.locator('#model-provider').inputValue(),'deepseek','Background configuration refresh retains the draft');
  assert.equal(await page.locator('#model-api-key').inputValue(),'synthetic-key-only');
  probe={ok:false,message:'Synthetic authentication error (401)'};
  await page.locator('#model-key-visibility').click();await primary.click();await done('error');
  assert.deepEqual(calls.map(c=>c.kind),['test']);
  assert.match(await feedback.textContent(),/401/);assert.equal(await feedback.getAttribute('role'),'alert');
  assert.equal(await page.locator('#model-api-key').inputValue(),'synthetic-key-only');
  assert.equal(await page.locator('#model-api-key').getAttribute('type'),'password');
  assert(await primary.isEnabled());
  await page.locator('#model-multimodal-enabled').check();
  probe={ok:true,multimodal:{checked:true,supported:false,message:'Synthetic vision unavailable'}};
  await primary.click();await done('error');assert.equal(calls.filter(c=>c.kind==='save').length,0);
  assert.match(await feedback.textContent(),/vision unavailable/);
  await page.locator('#model-multimodal-enabled').uncheck();probe={ok:true,message:'OK'};
  let signal;const pending=new Promise(resolve=>signal=resolve);started=signal;
  const before=calls.length;await primary.click();await pending;
  assert(await primary.isDisabled());assert(await page.locator('#model-provider').isDisabled());
  await page.evaluate(()=>document.getElementById('model-config-form').requestSubmit());
  assert.equal(calls.length,before+1,'Repeated submission cannot duplicate an in-flight request');
  held();await done('success');
  assert.deepEqual(calls.slice(before).map(c=>c.kind),['test','save']);
  assert.deepEqual(calls.at(-1).payload,calls.at(-2).payload,'Save exactly the settings that passed validation');
  assert.equal(await page.locator('#model-api-key').inputValue(),'');assert.match(await feedback.textContent(),/保存并启用/);
  await page.locator('#model-name').fill('retry-model');saveFailure=true;
  await primary.click();await done('error');assert.equal(await page.locator('#model-name').inputValue(),'retry-model');
  assert.match(await feedback.textContent(),/保存失败/);saveFailure=false;
  await primary.click();await done('success');
  await page.locator('#model-name').fill('test-only-model');
  const saved=calls.filter(c=>c.kind==='save').length;
  await extra('#btn-test-model');await done('success');
  assert.equal(calls.filter(c=>c.kind==='save').length,saved);assert.match(await feedback.textContent(),/未保存配置/);
  const tested=calls.filter(c=>c.kind==='test').length;
  await extra('#btn-save-model-only');await done('success');
  assert.equal(calls.filter(c=>c.kind==='test').length,tested,'Explicit save-only retains the offline configuration path');
  await page.locator('.model-service-section details summary').click();
  await page.locator('#model-extra-params').fill('{invalid');const prior=calls.length;
  await primary.click();await done('error');assert.equal(calls.length,prior);
  await page.locator('#model-extra-params').fill('{}');
  const waiting=new Promise(resolve=>started=resolve);await primary.click();await waiting;
  await page.evaluate(()=>{document.getElementById('model-name').value='newer-draft';});held();await done('error');
  assert.equal(calls.filter(c=>c.kind==='save').length,saved+1,'A late test cannot save a newer untested draft');
  assert.equal(await page.locator('#model-name').inputValue(),'newer-draft');
  let cases=0;
  for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark'])for(const language of ['zh-CN','en'])for(const [width,scale] of [[390,1],[780,1.25],[1440,1],[2048,2]]){
   await page.setViewportSize({width,height:1000});
   await page.evaluate(({theme,mode,language,scale})=>{document.documentElement.dataset.rewardTheme=theme;applyTheme(mode);setI18nLanguage(language);document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale);},{theme,mode,language,scale});
   await primary.scrollIntoViewIfNeeded();
   const geometry=await primary.evaluate(n=>{
    const form=n.closest('form'),footer=form.querySelector('.model-service-footer'),r=n.getBoundingClientRect(),f=footer.getBoundingClientRect();
    const fields=form.querySelector('.model-service-fields').getBoundingClientRect(),target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return {position:getComputedStyle(n.parentElement).position,covered:!n.contains(target),escaped:r.left<0||r.right>innerWidth+1,overlap:f.top<fields.bottom-1,overflow:document.documentElement.scrollWidth>innerWidth+1};
   });
   assert.equal(geometry.position,'static');assert(!geometry.covered&&!geometry.escaped&&!geometry.overlap&&!geometry.overflow,JSON.stringify({theme,mode,language,width,scale,geometry}));
   await more.locator('summary').click();
   const bounds=await more.locator('.model-action-menu').boundingBox();
   assert(bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.y>=0,JSON.stringify({width,scale,bounds}));
   await more.locator('summary').press('Escape');assert.equal(await more.getAttribute('open'),null);cases++;
  }
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{document.documentElement.removeAttribute('data-reward-theme');applyTheme('dark');setI18nLanguage('zh-CN');document.body.style.zoom=1;document.documentElement.style.setProperty('--fz',1);});
  await primary.scrollIntoViewIfNeeded();fs.mkdirSync('output/model-service',{recursive:true});await page.screenshot({path:`output/model-service/actions-${engine.name()}.png`});
  assert.deepEqual(errors,[]);console.log(`PASS ${engine.name()}: validate/save order, failures, retained draft, duplicate/late requests, profile switching, optional actions and ${cases} footer/menu layouts`);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
