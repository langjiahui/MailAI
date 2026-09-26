// Synthetic fixture only: exercise narrow panes with active filters and task status.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch();try{
 const page=await browser.newPage({viewport:{width:1512,height:900}});
 await page.goto('http://127.0.0.1:18795/?shell=macos');
 await page.locator('#app-preloader').waitFor({state:'hidden'});
 await page.evaluate(()=>{currentFilter.status='inbox';currentFilter.verdict='clean';unifiedMailbox=false;updateListTitle(200);updateFilterChips();document.getElementById('btn-task-center').textContent='任务与发件箱 · 1 项进行中';});
 for(const theme of ['light','dark'])for(const width of [280,310,380,480]){
  await page.evaluate(({theme,width})=>{applyTheme(theme);const pane=document.querySelector('.list-pane');pane.style.width=width+'px';pane.style.flex='0 0 '+width+'px';pane.style.minWidth='0';},{theme,width});
  const metrics=await page.locator('.list-pane').evaluate(pane=>{const title=pane.querySelector('#list-title'),count=pane.querySelector('#list-count'),label=pane.querySelector('.filter-chip-label');return {overflow:pane.scrollWidth>pane.clientWidth+1,title:title.scrollWidth<=title.clientWidth+1,count:count.scrollWidth<=count.clientWidth+1,label:label.getBoundingClientRect().width};});
  assert(!metrics.overflow&&metrics.title&&metrics.count&&metrics.label>=22,JSON.stringify({width,theme,metrics}));
 }
 await page.locator('[data-remove-filter=verdict]').click();
 assert.equal(await page.locator('[data-remove-filter=verdict]').count(),0);
 assert.equal(await page.locator('#btn-sidebar-add-account').count(),0);
 await page.evaluate(()=>showSystemView('account'));
 assert(await page.locator('#system-view').isVisible());
 console.log('PASS narrow list labels, filter removal and account settings');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
