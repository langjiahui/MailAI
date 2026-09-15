// Isolated Chromium checks: never opens the user's mailbox or calls a model.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {chromium} = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
async function polling() {
  let callback, calls = 0, resolve, account = 'a';
  const context = vm.createContext({_fetchPollTimer:null,_fetchPollController:null,AbortController,
    activeMailAccount:()=>({id:account}),showFetchOverlay(){},hideFetchOverlay(){},setLoading(){},
    setInterval(fn){callback=fn;return 1;},clearInterval(){},
    document:{getElementById:()=>null},api:async()=>{calls++;return new Promise(done=>{resolve=done;});},
    updateFetchOverlay(){throw Error('Stale result must not update another account');},loadData(){},toast(){}});
  vm.runInContext(source.slice(source.indexOf('function startFetchMonitor()'),source.indexOf('function showFetchOverlay()')),context);
  context.startFetchMonitor();const first=callback();
  for(let n=0;n<200;n++)await callback();
  assert.equal(calls,1,'Slow response must not accumulate polling requests');
  account='b';resolve({running:true});await first;await callback();
  assert.equal(context._fetchPollTimer,null);
}
(async()=>{
  await polling();
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<main id="host"></main>');
    await page.addScriptTag({content:source.slice(source.indexOf('const richEmailFrames ='),source.indexOf('function mountRichEmailBody('))});
    await page.evaluate(()=>{
      window.mount=(html)=>{
        const frame=document.createElement('iframe');
        frame.style.cssText='width:600px;border:0';frame.sandbox='allow-same-origin';
        frame.srcdoc=`<style>html,body{margin:0;padding:0;overflow:hidden}body{padding:18px}</style>${html}`;
        autoSizeRichEmailFrame(frame);document.getElementById('host').replaceChildren(frame);
        return new Promise(resolve=>frame.addEventListener('load',()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)),{once:true}));
      };
    });
    const metrics=[];
    for (const html of ['short text','<div style="height:100vh;padding:80px">viewport layout</div>',
      '<style>html,body{height:100%}</style><div>percentage layout</div>',
      '<div style="height:50000px">very long email</div>']) {
      await page.evaluate(html=>mount(html),html);
      const before=await page.locator('iframe').evaluate(f=>f.offsetHeight);
      await page.waitForTimeout(1800);
      const after=await page.locator('iframe').evaluate(f=>f.offsetHeight);
      assert.equal(after,before,'Email viewport must settle, not grow continuously');
      assert.ok(after<=30000);metrics.push({height:after});
    }
    await page.evaluate(()=>mount('<div id="late">short</div>'));
    await page.locator('iframe').evaluate(f=>{f.contentDocument.getElementById('late').style.height='1800px';});
    await page.waitForTimeout(200);
    assert.ok(await page.locator('iframe').evaluate(f=>f.offsetHeight)>=1800,'Late content must still resize');
    const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
    async function memory(){await cdp.send('HeapProfiler.collectGarbage');return cdp.send('Runtime.getHeapUsage');}
    for(let n=0;n<10;n++)await page.evaluate(()=>mount('<p>warmup</p>'));
    const baseline=await memory();
    for(let n=0;n<200;n++)await page.evaluate(n=>mount(`<p>${n}: ${'content '.repeat(2000)}</p><img src="data:image/png;base64,broken">`),n);
    await page.evaluate(()=>document.getElementById('host').replaceChildren());
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>richEmailFrames.size),0,'Detached documents must release observers');
    const end=await memory();
    assert.ok(end.usedSize-baseline.usedSize<8*1024*1024,'Repeated reading must not retain email documents');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({polling:'200 ticks, 1 request',frames:metrics,switches:200,heapBefore:baseline.usedSize,heapAfter:end.usedSize,errors},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
