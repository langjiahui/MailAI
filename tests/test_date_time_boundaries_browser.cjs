const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const dir=path.resolve(__dirname,'../app/web/static');
const links=fs.readFileSync(path.join(dir,'index.html'),'utf8').match(/<link[^>]+rel="stylesheet"[^>]*>/g).join('\n');
const html=`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8">${links}</head><body>
<dialog class="productivity-dialog" id="fixture"><div class="productivity-body"><form id="form">
<label><span data-i18n="ui.760506491eef">开始日期</span><input id="start" type="date" required></label>
<label><span data-i18n="ui.895cd52fbbb6">结束日期</span><input id="end" type="date" required></label>
<label><span data-i18n="datetime.chooseDate">选择日期</span><input id="future" type="date" min="2040-04-20" max="2040-06-01"></label>
<button type="submit">Submit</button></form></div></dialog>
<script src="/static/i18n.js"></script><script src="/static/i18n-catalog.js"></script><script src="/static/i18n-runtime.js"></script><script src="/static/reward-theme-bridge.js"></script><script src="/static/date-time-picker.js"></script>
<script>document.getElementById('fixture').showModal();document.getElementById('form').onsubmit=e=>e.preventDefault();</script></body></html>`;
(async()=>{
 const report=[];
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch({headless:true});
  try{
   const page=await browser.newPage({viewport:{width:1000,height:750},locale:'en-US'});
   await page.route('http://date-audit.test/**',route=>{
    const name=path.basename(new URL(route.request().url()).pathname);
    if(!name)return route.fulfill({contentType:'text/html',body:html});
    if(/\.(css|js)$/.test(name))return route.fulfill({contentType:name.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(path.join(dir,name),'utf8')});
    return route.fulfill({status:404,body:''});
   });
   await page.goto('http://date-audit.test/');
   await page.evaluate(()=>{setI18nLanguage('zh-CN');document.getElementById('form').reportValidity();});
   const validation=await page.evaluate(()=>({language:document.documentElement.lang,activeInput:[...document.querySelectorAll('input[type=date]')].find(n=>n.parentElement.querySelector('.datetime-trigger')?.getAttribute('aria-expanded')==='true')?.id,error:document.querySelector('.datetime-panel:popover-open .datetime-status')?.textContent}));
   assert.equal(validation.activeInput,'start');
   assert.equal(validation.error,'请选择日期');
   await page.keyboard.press('Escape');
   await page.locator('#future + .datetime-trigger').click();
   const future=await page.locator('.datetime-panel:visible').evaluate(n=>({selectedYear:n.querySelector('.datetime-navigation select:last-of-type').value,enabledDays:n.querySelectorAll('.datetime-day:not(:disabled)').length}));
   assert.equal(future.selectedYear,'2040');assert(future.enabledDays>0);
   await page.keyboard.press('Escape');
   // Clearing a previously populated native field must allow the first submit,
   // including WebKit's cached date validation and all three enhanced types.
   await page.evaluate(()=>{
    document.getElementById('start').value='2026-10-13';document.getElementById('end').value='2026-10-14';
    const form=document.getElementById('form');
    form.insertAdjacentHTML('beforeend','<div id="clear-boundary-tests"><input id="clear-date" type="date" value="2026-10-14" min="2026-10-01"><input id="clear-datetime" type="datetime-local" value="2026-10-14T09:30" step="60"><input id="clear-time" type="time" value="09:30" max="18:00"></div>');
    window.clearedSubmissions=0;form.addEventListener('submit',()=>++window.clearedSubmissions);
   });
   await page.locator('#clear-time + .datetime-trigger').waitFor();
   for(const [index,id] of ['clear-date','clear-datetime','clear-time'].entries()){
    const before=await page.locator('#'+id).evaluate(n=>({type:n.type,defaultValue:n.defaultValue,min:n.min,max:n.max,step:n.step}));
    await page.locator('#'+id).evaluate(n=>{n.value='';});
    await page.locator('#form > button[type=submit]').click();
    assert.equal(await page.evaluate(()=>clearedSubmissions),index+1,`${engine.name()}/${id}: first submit after clearing must succeed`);
    assert.deepEqual(await page.locator('#'+id).evaluate(n=>({type:n.type,defaultValue:n.defaultValue,min:n.min,max:n.max,step:n.step})),before);
   }
   await page.evaluate(()=>{
    document.getElementById('form').reset();
    window.clearedReset=['clear-date','clear-datetime','clear-time'].map(id=>document.getElementById(id).value);
    document.getElementById('clear-boundary-tests').remove();
   });
   assert.deepEqual(await page.evaluate(()=>clearedReset),['2026-10-14','2026-10-14T09:30','09:30']);
   await page.evaluate(()=>{document.getElementById('start').value='2026-10-13';});
   for(const [width,zoom] of [[1000,1],[1000,1.25],[390,1],[390,1.25],[390,1.4]]){
    await page.setViewportSize({width,height:750});
    await page.evaluate(zoom=>{document.body.style.zoom=String(zoom);document.documentElement.style.setProperty('--fz',String(zoom));},zoom);
    await page.locator('#start + .datetime-trigger').click();
    const bounds=await page.locator('.datetime-panel:visible').evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,withinViewport:r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1};});
    assert(bounds.withinViewport,JSON.stringify({engine:engine.name(),width,zoom,bounds}));
    await page.locator('.datetime-panel:visible .datetime-apply').scrollIntoViewIfNeeded();
    assert(await page.locator('.datetime-panel:visible .datetime-apply').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}),'Apply remains reachable');
    report.push({engine:engine.name(),viewport:width,zoom,bounds});
    if(!bounds.withinViewport)await page.screenshot({path:`build/audit-date-overflow-${engine.name()}-${width}-${zoom}.png`});
    await page.keyboard.press('Escape');
   }
   report.push({engine:engine.name(),validation,future});
  }finally{await browser.close();}
 }
 fs.writeFileSync('build/audit-20261013-date-controls.json',JSON.stringify(report,null,2));
 console.log('PASS date boundaries: two engines, first submit after clearing all date/time types, preserved constraints/reset, scaled/narrow layouts, first invalid focus, language mismatch and future minimum');
})().catch(e=>{console.error(e);process.exitCode=1;});
