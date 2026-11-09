// Isolated fixture. Verify UI transitions without model calls or mailbox writes.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch();
  try{
   const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({mailboxDone:true,aiDone:true,deferred:true})));
   await page.goto(process.env.MAILAI_TEST_URL||'http://127.0.0.1:18797/');
   await page.locator('#app-preloader').waitFor({state:'detached'});
   await page.evaluate(()=>setI18nLanguage('zh-CN'));
   await page.locator('.email-item').first().click();
   await page.waitForFunction(()=>!!selectedEmailDetail);
   const original=await page.evaluate(()=>selectedEmailDetail);
   await page.evaluate(()=>{selectedEmailDetail={...selectedEmailDetail,verdict:'unreviewed',score:0};renderReadingPane(selectedEmailDetail);});
   assert.equal(await page.locator('.security-result-trigger em').count(),0);
   let polls=0,posts=0;
   await page.route(`**/api/emails/${original.id}/analysis`,route=>{
    if(route.request().method()==='POST'){posts++;return route.fulfill({json:{state:'running'}});}
    polls++;return route.fulfill({json:{state:polls===1?'running':'complete',work_analysis:false}});
   });
   await page.route(`**/api/emails/${original.id}`,r=>r.fulfill({json:{...original,verdict:'clean',score:0}}));
   await page.locator('.reading-heading-row [data-mail-analyze]').click();
   await page.locator('.reading-heading-row [data-mail-analyze]').waitFor({state:'visible'});
   assert(await page.locator('.reading-heading-row [data-mail-analyze]').isDisabled());
   await page.waitForFunction(()=>selectedEmailDetail?.verdict==='clean');
   assert.equal(posts,1);assert.equal(polls,2);
   await page.locator('.security-flyout:not(.hidden) [data-mail-analyze]').waitFor();
   await page.unroute(`**/api/emails/${original.id}/analysis`);
   await page.route(`**/api/emails/${original.id}/analysis`,r=>r.fulfill({status:409,json:{detail:'Fixture analysis failed'}}));
   await page.locator('.security-flyout:not(.hidden) [data-mail-analyze]').click();
   await page.getByText('Fixture analysis failed',{exact:false}).waitFor();
   assert(await page.locator('.security-flyout:not(.hidden) [data-mail-analyze]').isEnabled());
   await page.evaluate(()=>toggleSecurityAnalysis(false));
   const requested=[];
   await page.route('**/api/mail/contacts/correspondence?**',route=>{
    const offset=Number(new URL(route.request().url()).searchParams.get('offset'));requested.push(offset);
    const emails=Array.from({length:Math.min(50,108-offset)},(_,i)=>({id:offset+i+1,status:'inbox',subject:`Mail ${offset+i+1}`,from_addr:'contact@example.test',direction:'received',date:'2026-10-01'}));
    return route.fulfill({json:{counterpart:'contact@example.test',total:108,has_more:offset+emails.length<108,emails}});
   });
   await page.evaluate(()=>openContactCorrespondence({email:'contact@example.test',name:'Contact'}));
   assert.match(await page.locator('#correspondence-subtitle').textContent(),/50 \/ 108/);
   await page.locator('[data-correspondence-more]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.correspondence-item').length===100);
   await page.locator('[data-correspondence-more]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.correspondence-item').length===108);
   assert.equal(await page.locator('[data-correspondence-more]').count(),0);
   assert.deepEqual(requested,[0,50,100]);
   await page.evaluate(()=>setI18nLanguage('en'));
   assert.match(await page.locator('#correspondence-subtitle').textContent(),/108 of 108/);
   await page.evaluate(()=>closeCorrespondence());
   assert.deepEqual(errors,[]);
   console.log(`PASS ${engine.name()}: manual analysis start/progress/results/retry and correspondence 108-message pagination/i18n`);
  }finally{await browser.close();}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
