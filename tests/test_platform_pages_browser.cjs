// Isolated example.test fixture only: cross-platform page containment and visual snapshots.
const {chromium}=require('playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 fs.mkdirSync('build/ui-audit',{recursive:true});
 const browser=await chromium.launch({...(process.env.CI?{}:{channel:'chrome'}),headless:true});
 const issues=[];let checked=0;
 try {
  for(const shell of ['browser','macos','windows']) {
   const page=await browser.newPage({viewport:{width:1512,height:950},reducedMotion:'reduce'});
   page.on('pageerror',e=>issues.push({shell,error:e.message}));
   await page.goto('http://127.0.0.1:18795/?shell='+shell);
   await page.locator('#app-preloader').waitFor({state:'detached'});
   assert(await page.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))));
   await page.evaluate(()=>setI18nLanguage('zh-CN'));
   const pages=[
    ['reading','.reading-pane',async()=>page.locator('.email-item').first().click(),async()=>{}],
    ...['preferences','account','remote','maintenance','guide','about'].map(tab=>[tab,`[data-system-panel="${tab}"]`,async()=>page.evaluate(tab=>showSystemView(tab),tab),async()=>page.evaluate(()=>hideSystemView(true))]),
    ['rules','#rules-view',async()=>page.evaluate(()=>showRulesView()),async()=>page.evaluate(()=>hideRulesView())],
    ['dashboard','#dashboard-view',async()=>page.evaluate(()=>showDashboard()),async()=>page.evaluate(()=>hideDashboard())],
    ['contacts','#contact-center [role=dialog]',async()=>page.locator('#btn-contacts').click(),async()=>page.locator('#btn-close-contacts').click()],
    ['attachments','#attachment-center [role=dialog]',async()=>page.locator('#btn-attachments').click(),async()=>page.locator('#btn-close-attachments').click()],
    ['todos','#todo-center [role=dialog]',async()=>page.locator('#btn-todos').click(),async()=>page.locator('#btn-close-todos').click()],
    ['assistant','#assistant-panel',async()=>page.evaluate(()=>openAssistant()),async()=>page.evaluate(()=>closeAssistant())],
    ['compose','#compose-modal [role=dialog]',async()=>page.locator('#btn-compose').click(),async()=>page.locator('#btn-close-compose').click()],
    ['compose-preview','#compose-preview-modal [role=dialog]',async()=>{await page.locator('#btn-compose').click();await page.evaluate(()=>{document.getElementById('compose-message').innerHTML='<p>您好：</p><p>已收到交期安排，请在周五前反馈评审意见。</p><p>谢谢！</p>';openComposePreview()})},async()=>{await page.evaluate(()=>closeComposePreview());await page.locator('#btn-close-compose').click()}],
   ];
   for(const theme of ['light','dark']) {
    await page.evaluate(theme=>applyTheme(theme),theme);
    for(const [name,selector,open,close] of pages) {
     await page.setViewportSize({width:1512,height:950});
     await open();await page.locator(selector).first().waitFor({state:'visible'});await page.waitForTimeout(400);
     await page.screenshot({path:`build/ui-audit/${shell}-${theme}-${name}.png`});
     for(const [width,height,scale] of [[900,640,1],[1280,800,1.3],[1920,1080,1]]) {
      await page.setViewportSize({width,height});
      await page.evaluate(scale=>{document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale)},scale);
      await page.waitForTimeout(160);
      const metrics=await page.locator(selector).first().evaluate(el=>{
       const r=el.getBoundingClientRect();
       return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height,overflow:el.scrollWidth>el.clientWidth+2,bodyOverflow:document.documentElement.scrollWidth>innerWidth+2};
      });
      checked++;
      if(metrics.x< -1||metrics.right>width+1||metrics.y< -1||metrics.bottom>height+1||metrics.overflow||metrics.bodyOverflow) {
       issues.push({shell,theme,name,width,height,scale,metrics});
       await page.screenshot({path:`build/ui-audit/issue-${shell}-${theme}-${name}-${width}.png`});
      }
     }
     await page.evaluate(()=>{document.body.style.zoom='';document.documentElement.style.removeProperty('--fz')});
     await page.setViewportSize({width:1512,height:950});await close();
    }
   }
   await page.close();
  }
  fs.writeFileSync('build/ui-audit/report.json',JSON.stringify({checked,issues},null,2));
  console.log(JSON.stringify({checked,issues},null,2));
  assert.deepEqual(issues,[], 'platform pages must stay inside the viewport without horizontal overflow or JavaScript errors');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
