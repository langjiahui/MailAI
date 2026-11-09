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
   const accountId=await page.evaluate(()=>selectedEmailAccountId || activeMailAccount()?.id || '');
   let done=false, finalVerdict='suspicious', finalScore=35, hold=false, failRefresh=false;
   await page.route('**/api/mailbox/list?**',async route=>{
    if(done && failRefresh)return route.fulfill({status:503,json:{detail:'Fixture refresh failure'}});
    const response=await route.fetch();const data=await response.json();
    const row=data.items.find(item=>item.id===original.id && (item._account_id || accountId)===accountId);
    if(row){
     const previous=row.verdict || 'clean',next=done?finalVerdict:'unreviewed';
     row.verdict=next;row.score=done?finalScore:0;
     data.facets.risk[previous]=(data.facets.risk[previous] || 0)-1;
     data.facets.risk[next]=(data.facets.risk[next] || 0)+1;
    }
    await route.fulfill({response,json:data});
   });
   await page.evaluate(async()=>{mailaiMailboxStore.invalidate();await loadData({includeAncillary:false,silent:true});selectedEmailDetail={...selectedEmailDetail,verdict:'unreviewed',score:0};renderReadingPane(selectedEmailDetail);});
   await page.waitForFunction(()=>mailAnalysisResuming.size===0);
   assert.equal(await page.locator('.security-result-trigger em').count(),0);
   assert.equal(await page.locator('.reading-heading-row > button').count(),1,'Analysis and security result share one control');
   assert.equal(await page.locator('#count-unreviewed').textContent(),'1');
   const suspiciousBefore=Number(await page.locator('#count-suspicious').textContent());
   let polls=0,posts=0;
   await page.route(`**/api/emails/${original.id}/analysis`,route=>{
    if(route.request().method()==='POST'){posts++;return route.fulfill({json:{state:'running',stage:'rules'}});}
    polls++;if(!hold && polls>=2)done=true;
    return route.fulfill({json:{state:done?'complete':'running',stage:'attachments',work_analysis:false}});
   });
   await page.route(`**/api/emails/${original.id}`,r=>r.fulfill({json:{...original,verdict:done?finalVerdict:'unreviewed',score:done?finalScore:0}}));
   await page.locator('.reading-heading-row [data-mail-analyze]').click();
   assert(await page.locator('.reading-heading-row [data-mail-analyze]').isDisabled());
   await page.locator('[data-mail-analysis-message]').getByText('正在检查链接和附件…',{exact:true}).waitFor();
   await page.waitForFunction(()=>selectedEmailDetail?.verdict==='suspicious' && !mailAnalysisBusy.size);
   await page.waitForFunction(()=>document.querySelector('.email-item.selected .risk-badge')?.textContent.includes('35'));
   assert.equal(posts,1);assert.equal(polls,2);
   assert.equal(await page.locator('#count-unreviewed').textContent(),'0');
   assert.equal(Number(await page.locator('#count-suspicious').textContent()),suspiciousBefore+1);
   assert.match(await page.locator('[data-mail-analysis-message]').textContent(),/分析完成.*可疑.*35/);
   // Returning to a running task must resume its UI without posting again.
   done=false;hold=true;polls=0;finalVerdict='phishing';finalScore=70;
   await page.locator('.security-result-trigger').click();
   await page.locator('.security-flyout:not(.hidden) [data-mail-analyze]').click();
   const other=await page.evaluate(()=>allEmails.find(item=>item.id!==selectedEmailId && (!item._account_id || item._account_id===(selectedEmailAccountId || activeMailAccount()?.id))));
   await page.evaluate(other=>selectEmail(other.id,{accountId:other._account_id}),other);
   await page.waitForFunction(id=>selectedEmailDetail?.id===id,other.id);
   await page.evaluate(({id,accountId})=>selectEmail(id,{accountId}),{id:original.id,accountId});
   await page.waitForFunction(id=>selectedEmailDetail?.id===id,original.id);
   assert(await page.locator('.reading-heading-row [data-mail-analyze]').isDisabled());
   assert.equal(posts,2);
   failRefresh=true;hold=false;
   await page.waitForFunction(()=>selectedEmailDetail?.verdict==='phishing' && !mailAnalysisBusy.size);
   await page.locator('[data-mail-analysis-refresh]').waitFor({state:'visible'});
   assert.equal(await page.locator('[data-mail-analysis-status]').getAttribute('data-state'),'complete');
   failRefresh=false;
   await page.locator('[data-mail-analysis-refresh]').click();
   await page.waitForFunction(()=>document.querySelector('.email-item.selected .risk-badge')?.textContent.includes('70'));
   assert.equal(posts,2,'Refreshing the completed result must not restart analysis');
   assert.match(await page.locator('[data-mail-analysis-message]').textContent(),/分析完成.*70/);
   await page.locator('.security-result-trigger').click();
   await page.unroute(`**/api/emails/${original.id}/analysis`);
   await page.route(`**/api/emails/${original.id}/analysis`,r=>r.fulfill({status:409,json:{detail:'Fixture analysis failed'}}));
   await page.locator('.security-flyout:not(.hidden) [data-mail-analyze]').click();
   await page.getByText('Fixture analysis failed',{exact:false}).waitFor();
   assert(await page.locator('.security-flyout:not(.hidden) [data-mail-analyze]').isEnabled());
   assert.equal(await page.locator('.security-result-trigger em').textContent(),'70');
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
