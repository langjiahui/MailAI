const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const crypto=require('node:crypto');
const fs=require('node:fs');
const {chromium,webkit}=require('playwright');
(async()=>{
 const server=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/gift_issuer_preview.py'],{stdio:['ignore','pipe','pipe']});
 let output='',errorOutput='';server.stdout.on('data',data=>output+=data);server.stderr.on('data',data=>errorOutput+=data);
 let browser;
 try{
  let info;
  for(let i=0;i<100;i++){const line=output.split('\n').find(n=>n.startsWith('{'));if(line){info=JSON.parse(line);break}if(server.exitCode!==null)throw Error(errorOutput);await new Promise(r=>setTimeout(r,100))}
  assert(info,'Issuer fixture did not start');
  browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});const page=await browser.newPage({viewport:{width:1050,height:1100},locale:'en-US'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(info.url);
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert(!/[\u3400-\u9fff]/.test((await page.locator('main').textContent()).replace('中文','')),'English interface has no untranslated Chinese copy');
  await page.locator('#language').selectOption('zh-CN');
  assert.equal(await page.locator('h1').textContent(),'小邮礼物发放');
  await page.locator('#language').selectOption('en');
  assert.equal((await fetch(new URL('/wrong',info.url))).status,404);
  assert.equal((await fetch(info.url+'/issue',{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json'},body:'{}'})).status,403);
  await page.locator('#recipient').fill(info.recipient);await page.locator('.items input[value="wings"]').check();await page.locator('.items input[value="theme_baowu"]').check();
  const extras=page.locator('.items input:not(:checked)');
  for(let i=0;i<6;i++)await extras.first().check();
  assert.equal(await page.locator('.items input:checked').count(),8);
  assert(await extras.first().isDisabled(),'Eight-item limit disables additional selections');
  const checked=page.locator('.items input:checked:not([value="wings"]):not([value="theme_baowu"])');
  while(await checked.count())await checked.first().uncheck();
  await page.locator('#recipient').fill('bad-code');await page.locator('#issue').click();
  await page.waitForFunction(()=>!!document.getElementById('recipient-error').textContent);
  assert.match(await page.locator('#recipient-error').textContent(),/complete client/);
  await page.locator('#language').selectOption('zh-CN');assert.match(await page.locator('#recipient-error').textContent(),/完整/);
  await page.locator('#recipient').fill(info.recipient);await page.locator('#language').selectOption('en');
  await page.locator('#issue').click();await page.locator('#result').waitFor({state:'visible'});
  const code=await page.locator('#code').inputValue();const [,raw,sig]=code.split('.');
  const payload=JSON.parse(Buffer.from(raw,'base64url').toString());assert.equal(payload.recipient,info.recipient);assert.deepEqual(payload.items,['wings','theme_baowu']);
  const publicKey=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(info.public,'hex')]),format:'der',type:'spki'});
  assert(crypto.verify(null,Buffer.concat([Buffer.from('MailAI/XiaoYou/Gift/v1\0'),Buffer.from(raw,'base64url')]),publicKey,Buffer.from(sig,'base64url')),'Operator UI issues a valid Ed25519 voucher');
  await page.locator('#kind').selectOption('campaign');assert(await page.locator('#recipient-label').isHidden());
  let lostPacket, firstRequest;
  await page.route('**/issue',async route=>{firstRequest=route.request().postDataJSON();lostPacket=await (await route.fetch()).json();await route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture response lost"}'})});
  await page.locator('#issue').click();await page.locator('#retry').waitFor({state:'visible'});
  assert(await page.locator('#title').isDisabled(),'Uncertain generation preserves the original form');
  await page.locator('#language').selectOption('zh-CN');assert.match(await page.locator('#error').textContent(),/连接中断/);
  await page.locator('#language').selectOption('en');assert.match(await page.locator('#error').textContent(),/Connection interrupted/);
  await page.unroute('**/issue');await page.reload();await page.locator('#retry').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('mailai-gift-issuer-pending:'+location.pathname)).request_id),firstRequest.request_id);
  await page.locator('#issue').click();await page.locator('#result').waitFor({state:'visible'});
  const campaign=await page.locator('#code').inputValue();assert.equal(JSON.parse(Buffer.from(campaign.split('.')[1],'base64url').toString()).recipient,'*');
  assert.equal(campaign,lostPacket.code,'Retry after reload recovers the exact already-issued voucher');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('mailai-gift-issuer-pending:'+location.pathname)),null);
  const downloaded=page.waitForEvent('download');await page.locator('#download').click();
  const file=await downloaded;assert(file.suggestedFilename().endsWith('.mailaigift'));
  assert.equal(fs.readFileSync(await file.path(),'utf8').trim(),campaign,'Exported file contains the exact signed voucher');
  assert.notEqual(code,campaign,'Each voucher has a fresh ID');
  await page.reload();await page.locator('#history').evaluate(n=>n.open=true);
  await page.waitForFunction(()=>document.querySelectorAll('.history-item').length===2);
  await page.locator('.history-item button').first().click();
  assert.equal(await page.locator('#code').inputValue(),campaign,'History recovers the same voucher without generating');
  assert.equal(await page.locator('#result-title').textContent(),'Original voucher recovered');
  assert.equal(await page.locator('.history-item').count(),2,'Lost response and retry cannot add duplicate history');
  await page.locator('#language').selectOption('zh-CN');assert.equal(await page.locator('#code').inputValue(),campaign,'Language switching cannot rewrite signed voucher contents');
  await page.locator('#language').selectOption('en');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('fixture blocked')}}}));
  await page.locator('#copy').click();
  assert(await page.locator('.code-details').evaluate(n=>n.open),'Blocked clipboard reveals and selects the voucher');
  assert.equal(await page.locator('#code').evaluate(n=>n.selectionEnd-n.selectionStart),campaign.length);
  assert.match(await page.locator('#copy-status').textContent(),/selected voucher/);
  for(const colorScheme of ['light','dark']){
   await page.emulateMedia({colorScheme});
   for(const width of [360,390,800,1050]){
    await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert(await page.locator('#result-meta').evaluate(n=>n.scrollWidth<=n.clientWidth+1),'Complete recipient code wraps inside result');
   }
  }
  await page.screenshot({path:'/tmp/mailai-gift-issuer-en-dark.png',fullPage:true});assert.deepEqual(errors,[]);
  console.log('Owner issuer UI: personal/campaign vouchers, eight-item limit, real signatures, local-only capability, cross-origin rejection, first-click validation, file export, lost-response/reload retry, history, Chinese/English, light/dark, clipboard fallback and compact layouts passed');
 }finally{if(browser)await browser.close();const stopped=once(server,'exit');server.kill('SIGTERM');if(server.exitCode===null)await stopped}
})().catch(e=>{console.error(e);process.exitCode=1});
