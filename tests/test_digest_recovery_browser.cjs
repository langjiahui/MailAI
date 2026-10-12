/* Real streamed reports, refresh/reopen, interruptions and retry in an isolated client. */
const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{once}=require('node:events');
const {chromium,webkit}=require('playwright');const port=18798;
(async()=>{
 const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/workspace_preview.py'],{env:{...process.env,MAILAI_DIGEST_FIXTURE:'1',MAILAI_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let output='',browser;fixture.stdout.on('data',d=>output+=d);fixture.stderr.on('data',d=>output+=d);
 try{
  let ready=false;for(let i=0;i<100;i++){if(fixture.exitCode!==null)throw Error(output);try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break}}catch(_){}await new Promise(r=>setTimeout(r,100))}assert(ready,output);
  browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch();
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let requests=0;page.on('request',r=>{if(r.url().endsWith('/api/digest/stream'))requests++});
  await page.goto(`http://127.0.0.1:${port}`);await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(()=>setI18nLanguage('zh-CN'));await page.evaluate(()=>openDigestModal());
  assert.equal(await page.locator('#digest-body').getAttribute('data-i18n'),null,'Dynamic report container must not be replaced by localization');
  await page.locator('#btn-generate-today').click();
  await page.waitForFunction(()=>document.getElementById('digest-body').textContent.includes('第一段'));
  await page.locator('#btn-regenerate-digest').click();
  assert.match(await page.locator('#digest-body').textContent(),/第一段/,'Refresh immediately reuses generated text');
  await page.waitForFunction(()=>document.getElementById('digest-body').textContent.includes('完整日报'));
  console.log('Initial generation and refresh passed');assert.equal(requests,1,'Refresh shares one streamed request');
  await page.locator('#btn-regenerate-digest').click();
  await page.waitForFunction(()=>document.getElementById('digest-body').textContent.includes('第一段'));
  await page.evaluate(()=>{closeDigestModal();void openDigestModal()});
  await page.waitForFunction(()=>document.getElementById('digest-body').textContent.includes('完整日报'));
  assert.equal(requests,2,'Reopen rejoins generation instead of launching a duplicate');
  console.log('Reopen passed');const saved=await page.evaluate(()=>api('/api/digests'));assert.equal(saved.length,1);
  await page.route('**/api/digest/stream',route=>route.fulfill({status:200,contentType:'application/x-ndjson',body:JSON.stringify({type:'delta',content:'保留的未完成片段'})+'\n'}));
  await page.locator('#btn-regenerate-digest').click();
  await page.waitForFunction(()=>document.getElementById('digest-body').textContent.includes('中断'));
  assert.match(await page.locator('#digest-body').textContent(),/保留的未完成片段/);
  assert.deepEqual(await page.evaluate(()=>api('/api/digests')),saved,'Partial response cannot change stored report');
  await page.unroute('**/api/digest/stream');
  console.log('Interrupted response passed');await page.clock.install();await page.route('**/api/digest/stream',()=>{});
  await page.locator('#btn-regenerate-digest').click();await page.clock.fastForward(90001);
  await page.waitForFunction(()=>document.getElementById('digest-body').textContent.includes('超时'));
  console.log('Timeout passed');await page.unroute('**/api/digest/stream');
  await page.evaluate(()=>setI18nLanguage('en'));
  await page.locator('#btn-regenerate-digest').click();
  await page.waitForFunction(()=>document.getElementById('digest-body').textContent.includes('完整日报'));
  const complete=await page.locator('#digest-body').textContent();
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
  assert.equal(await page.locator('#digest-body').textContent(),complete,'Changing language preserves report content');
  await page.screenshot({path:'/tmp/mailai-digest-recovery.png'});
  assert.deepEqual(errors,[]);console.log('Digest UI: real incremental stream, refresh and reopen share progress, incomplete output preservation, timeout exit and successful retry passed');
 }finally{if(browser)await browser.close();const stopped=once(fixture,'exit');fixture.kill('SIGTERM');if(fixture.exitCode===null)await stopped}
})().catch(e=>{console.error(e);process.exitCode=1});
