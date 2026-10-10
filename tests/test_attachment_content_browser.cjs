// Isolated fixture only; never connects to a real mailbox or model.
const assert=require('node:assert/strict');
const browserType=require('playwright')[process.env.MAILAI_BROWSER || 'chromium'];
const base=process.env.MAILAI_PREVIEW_URL || 'http://127.0.0.1:18795';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await browserType.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.locator('#btn-attachments').click();await page.locator('[data-attachment-tools]').first().waitFor();
  const realFiles=await page.evaluate(()=>attachmentItems);
  const realFile=realFiles[0], account=await page.evaluate(()=>attachmentCenterAccountId);
  const files=Array.from({length:301},(_,i)=>({email_id:i+100,index:0,name:[0,299,300].includes(i)?`合同-${i}.txt`:`图片-${i}.png`,size:40,date:'2026-10-08T09:00:00',subject:'合同交期确认',from_addr:'colleague@example.test'}));
  const longName='2026年宝钢股份股价信息、人事变动、最新新闻、宝信软件股份信息、钢铁行业财经-'.repeat(8)+'合同.txt';
  files[0].name=longName;
  const firstGate=deferred();let started=false;const searched=[],offsets=[];
  await page.route('**/api/attachments?*',route=>{
   const url=new URL(route.request().url()),offset=Number(url.searchParams.get('offset') || 0);offsets.push(offset);
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(offset ? [files[0],...files.slice(offset,offset+301)] : files.slice(0,301))});
  });
  await page.route('**/api/productivity/attachments/*/0/search',async route=>{
   assert.equal(route.request().headers()['x-mailai-account'],account);
   const id=Number(route.request().url().match(/attachments\/(\d+)/)[1]);searched.push(id);
   if(id===100){started=true;await firstGate.promise;}
   await route.fulfill({status:id===399?400:200,contentType:'application/json',body:JSON.stringify(id===399?{detail:'加密附件暂不能读取'}:{excerpts:Array.from({length:id===400?4:1},()=> '合同编号 .* <script>不可执行</script> 交付日：周五'),more:false,note:'仅提取前 16000 字符',limited:true})});
  });
  await page.locator('.attachment-center-tools .productivity-panel-entry').filter({hasText:'查找文件内容'}).click();
  assert.equal(await page.locator('#productivity-title').textContent(),'搜索附件内容');
  assert.equal(await page.locator('[data-file-scope]').inputValue(),'all');
  assert.equal(await page.locator('#attachment-compare-tab').count(),0);
  await page.locator('.attachment-search-empty').waitFor();
  await page.locator('#productivity-dialog').screenshot({path:'/tmp/mailai-attachment-search-empty.png'});
  // WebKit's selected-option text must not create an invisible horizontal overflow.
  await page.locator('[data-file-scope]').selectOption('one');
  assert((await page.locator('[data-file-choice] option:checked').textContent()).includes(longName),'Keep the complete filename in the native menu');
  for(const [width,theme] of [[1440,'light'],[1440,'dark'],[600,'light'],[390,'dark']]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   for(const selector of ['#productivity-dialog','.productivity-body','.attachment-search-controls'])
    assert(await page.locator(selector).evaluate(n=>n.scrollWidth<=n.clientWidth+1),`Long selected filename must fit ${selector} at ${width}px in ${theme}`);
  }
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.locator('[data-file-scope]').selectOption('all');
  await page.locator('[data-file-example="合同编号"]').click();
  assert.equal(await page.locator('[data-file-query]').inputValue(),'合同编号');
  await page.locator('[data-file-query]').fill('.*');
  await page.locator('[data-file-search] [type=submit]').click();
  while(!started) await new Promise(r=>setTimeout(r,20));
  assert(await page.locator('[data-file-query]').isDisabled());
  await page.locator('[data-file-stop]').click();firstGate.resolve();
  await page.waitForFunction(()=>document.querySelector('[data-file-search] [type=submit]').textContent==='继续搜索');
  assert.deepEqual(searched,[100],'stop must retain current result and prevent the next read');
  assert.equal(await page.locator('.attachment-content-hit mark').textContent(),'.*');
  assert.equal(await page.locator('.attachment-content-hit script').count(),0);
  await page.locator('[data-file-search] [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('[data-file-search] [type=submit]').textContent==='重新搜索');
  assert.deepEqual(searched,[100,399,400],'resume must not repeat the first file; read failure must not stop pagination');
  assert.deepEqual(offsets,[0,300]);
  assert.equal(await page.locator('[data-file-results] .attachment-content-hit').count(),2);
  assert.match(await page.locator('[data-file-status]').textContent(),/301\/301.*命中 2 份/);
  assert.match(await page.locator('[data-file-current]').textContent(),/跳过 298.*未读取 1/);
  await page.locator('[data-file-unread] summary').click();
  assert.match(await page.locator('[data-file-unread]').textContent(),/加密附件暂不能读取/);
  for(const [width,theme] of [[1440,'light'],[1440,'dark'],[390,'dark']]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   assert(await page.locator('#productivity-dialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1),'search results must fit a narrow window');
   await page.locator('#productivity-dialog').evaluate(n=>n.scrollTop=0);
   if(width===1440) await page.locator('#productivity-dialog').screenshot({path:`/tmp/mailai-attachment-search-${theme}.png`});
  }
  const additional=page.locator('.attachment-more-excerpts');
  assert.equal(await additional.count(),1);
  assert(!await additional.locator('blockquote').first().isVisible(),'additional excerpts stay collapsed');
  await page.locator('#productivity-dialog').evaluate(n=>n.scrollTop=0);
  await page.locator('#productivity-dialog').screenshot({path:'/tmp/mailai-attachment-search-narrow.png'});
  await additional.locator('summary').click();assert(await additional.locator('blockquote').first().isVisible());
  await page.locator('[data-close-productivity]').click();
  await page.unroute('**/api/attachments?*');await page.unroute('**/api/productivity/attachments/*/0/search');
  await page.setViewportSize({width:1440,height:1000});
  // The row exposes an actions menu; comparison no longer occupies the search UI.
  await page.locator('[data-attachment-tools]').first().click();
  assert.equal(await page.locator('#productivity-title').textContent(),'附件操作');
  await page.locator('#productivity-dialog').screenshot({path:'/tmp/mailai-attachment-actions-dark.png'});
  await page.locator('[data-file-find]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-file-search] [type=submit]').disabled);
  assert.equal(await page.locator('[data-file-scope]').inputValue(),'one');
  await page.locator('[data-file-query]').fill('周五');await page.locator('[data-file-search] [type=submit]').click();
  await page.locator('[data-file-results] .attachment-content-hit').waitFor();
  await page.locator('[data-file-results] a').click();await page.locator('.file-preview[open]').waitFor();
  assert.match(await page.locator('#file-preview-title').textContent(),/交付安排/);
  await page.locator('.file-preview [aria-label="关闭预览"]').click();
  assert(await page.locator('#productivity-dialog[open]').isVisible(),'preview close must return to retained search results');
  await page.locator('[data-close-productivity]').click();
  // Candidate provenance and explicit acknowledgement precede comparison.
  const candidates=[0,1,2].map((_,i)=>({...realFile,email_id:i+100,index:0,attachment_index:0,subject:`${i+7}月报销明细`}));
  await page.route('**/api/productivity/attachments/versions?*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:candidates})}));
  const compareGate=deferred();let compared=false;
  await page.route('**/api/productivity/attachments/compare',async route=>{compared=true;await compareGate.promise;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({identical:false,text_equal:true,diff:'',limited:true,notes:['仅提取前 16000 字符','提取前 6/16 个工作表'],scope:'仅比较提取到的文字'})});});
  await page.locator('[data-attachment-tools]').first().click();await page.locator('[data-file-check]').click();
  await page.locator('[data-compare-confirm]').waitFor();assert(await page.locator('[data-compare-run]').isDisabled());
  await page.locator('[data-compare-confirm]').check();await page.locator('[data-compare-run]').click();
  while(!compared) await new Promise(r=>setTimeout(r,20));
  await page.locator('[data-compare-after]').selectOption('2');compareGate.resolve();
  await page.waitForFunction(()=>!document.querySelector('[data-compare-run]').hasAttribute('aria-busy'));
  assert.equal(await page.locator('[data-compare-summary]').textContent(),'','a stale comparison must never label a new pair');
  assert(await page.locator('[data-compare-run]').isDisabled());
  await page.locator('[data-compare-confirm]').check();await page.locator('[data-compare-run]').click();
  await page.locator('.attachment-comparison-summary').waitFor();
  assert.match(await page.locator('[data-compare-summary]').textContent(),/已读取的部分文字相同，未读取内容尚未核对/);
  await page.locator('[data-compare-notes] summary').click();assert.match(await page.locator('[data-compare-notes]').textContent(),/文件 A.*文件 B/s);
  await page.locator('#productivity-dialog').screenshot({path:'/tmp/mailai-attachment-comparison-dark.png'});
  await page.locator('[data-compare-after]').selectOption(await page.locator('[data-compare-before]').inputValue());
  await page.locator('[data-compare-confirm]').check();assert(await page.locator('[data-compare-run]').isDisabled(),'same reference is not a comparison');
  await page.locator('[data-close-productivity]').click();
  // Closing an in-flight search cannot overwrite a newly opened utility.
  const lateGate=deferred();let lateStarted=false;
  await page.route('**/api/productivity/attachments/*/0/search',async route=>{lateStarted=true;await lateGate.promise;try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({excerpts:['late result'],note:'',limited:false})});}catch(_){}});
  await page.locator('[data-attachment-tools]').first().click();await page.locator('[data-file-find]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-file-search] [type=submit]').disabled);
  await page.locator('[data-file-query]').fill('late');await page.locator('[data-file-search] [type=submit]').click();
  while(!lateStarted) await new Promise(r=>setTimeout(r,20));
  await page.locator('[data-close-productivity]').click();await page.locator('[data-attachment-tools]').first().click();lateGate.resolve();
  await page.waitForTimeout(100);assert.equal(await page.locator('#productivity-title').textContent(),'附件操作');
  assert(!await page.locator('#productivity-dialog').textContent().then(t=>t.includes('late result')));
  await page.unroute('**/api/productivity/attachments/*/0/search');
  await page.locator('[data-file-find]').click();await page.waitForFunction(()=>!document.querySelector('[data-file-search] [type=submit]').disabled);
  await page.locator('[data-file-query]').fill('周五');await page.locator('[data-file-search] [type=submit]').click();
  await page.locator('[data-file-results] [data-file-source-email]').waitFor();
  await page.locator('[data-file-results] [data-file-source-email]').click();
  await page.waitForFunction(id=>selectedEmailId===id,realFile.email_id);
  assert.equal(await page.locator('#productivity-dialog[open]').count(),0);
  assert(await page.locator('#attachment-center').evaluate(n=>n.classList.contains('hidden')));
  assert.deepEqual(errors,[]);
  console.log('PASS attachment search: literal highlights, account scope, stop/resume, >300 pagination, failures, real extraction/preview, dark/narrow layout, comparison acknowledgement and stale-response guards');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
