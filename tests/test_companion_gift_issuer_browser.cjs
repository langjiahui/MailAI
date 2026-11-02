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
  assert(!/Growth journal|养成手账/.test(await page.locator('main').textContent()),'Issuing instructions use the current client navigation');
  const picked=()=>page.locator('.items input:checked').evaluateAll(nodes=>nodes.map(n=>n.value));
  const sets={post:['cap','scarf','satchel'],cloud:['visor','jacket','wings'],star:['star_crest','armor','mech_wings','midnight']};
  let issueRequests=0;page.on('request',request=>{if(request.method()==='POST')issueRequests++;});
  for(const [id,items] of Object.entries(sets)){
   await page.locator('[data-collection="'+id+'"]').click();
   assert.deepEqual(await picked(),[],'Browsing a collection never selects a gift');
   assert.equal(await page.locator('#outfit-preview').getAttribute('data-collection-look'),id);
   const visible=await page.locator('#outfit-preview').getAttribute('data-preview-items');
   assert(items.every(item=>visible.split(' ').includes(item)),'Reference preview includes every collection piece');
   await page.locator('#add-collection').click();
   assert.deepEqual(new Set(await picked()),new Set(items));
   assert.equal(await page.locator('#preview-selection').getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator('#outfit-preview').getAttribute('data-collection-look'),id);
   for(const shape of ['nature','ranger']){
    await page.locator('#preview-shape').selectOption(shape);
    assert.deepEqual(new Set(await picked()),new Set(items),'Shape preview cannot change voucher items');
    const parts=await page.locator('#outfit-preview').evaluate(n=>({cap:getComputedStyle(n.querySelector('.growth-cap')).display,crest:getComputedStyle(n.querySelector('.growth-star-crest')).display,armor:getComputedStyle(n.querySelector('.growth-armor')).display,cape:getComputedStyle(n.querySelector('.growth-mech-wings')).display}));
    if(id==='star')assert(parts.crest!=='none'&&parts.armor!=='none'&&parts.cape!=='none'&&parts.cap==='none','Flagship preview renders the shared crest, armor and cape without unrelated equipment');
   }
   await page.locator('#clear-selection').click();
  }
  assert.equal(issueRequests,0,'Selecting, clearing and previewing do not issue vouchers');
  await page.locator('[data-collection="star"]').click();await page.locator('#add-collection').click();
  await page.locator('#individual-items > summary').click();
  await page.locator('.items input[value="armor"]').uncheck();
  assert.equal(await page.locator('#outfit-preview').getAttribute('data-collection-look'),'','A partial gift cannot claim the complete flagship look');
  assert.equal(await page.locator('#outfit-preview .growth-armor').evaluate(n=>getComputedStyle(n).display),'none');
  assert.match(await page.locator('#add-collection').textContent(),/Add 1/);
  await page.locator('#add-collection').click();
  await page.locator('[data-collection="post"]').click();await page.locator('#add-collection').click();
  assert.equal((await picked()).length,7);
  await page.locator('[data-collection="cloud"]').click();
  assert(await page.locator('#add-collection').isDisabled());
  assert.match(await page.locator('#capacity').textContent(),/2 more spaces/);
  assert.equal((await picked()).length,7,'Capacity failure cannot discard the existing selection');
  await page.locator('[data-collection="post"]').click();await page.locator('#add-collection').click();
  assert.deepEqual(new Set(await picked()),new Set(sets.star),'Removing a set preserves the other selected set');
  await page.locator('#clear-selection').click();
  await page.locator('#preview-shape').selectOption('nature');
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
  assert(await page.locator('#add-collection').isDisabled(),'Uncertain generation also locks collection edits');
  assert(await page.locator('#clear-selection').isDisabled(),'Uncertain generation locks clear selection');
  await page.locator('[data-collection=star]').click();assert.deepEqual(await picked(),['wings','theme_baowu'],'Browsing while pending cannot alter the original gift');
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
  await page.screenshot({path:'/tmp/mailai-gift-issuer-en-dark.png',fullPage:true});
  await page.locator('#history').evaluate(n=>n.open=false);
  if((await picked()).length)await page.locator('#clear-selection').click();
  else assert(await page.locator('#clear-selection').isDisabled(),'An empty draft has no selection to clear');
  await page.locator('[data-collection=star]').click();await page.locator('#add-collection').click();
  await page.locator('#individual-items').evaluate(n=>n.open=false);await page.locator('#language').selectOption('zh-CN');
  await page.emulateMedia({colorScheme:'light'});await page.setViewportSize({width:1160,height:980});
  const screenshotDir=process.env.MAILAI_GIFT_SCREENSHOT_DIR||'/tmp';
  await page.screenshot({path:screenshotDir+'/mailai-gift-studio-star.png',fullPage:true});
  await page.locator('#kind').selectOption('campaign');await page.locator('#issue').click();await page.locator('#result').waitFor({state:'visible'});
  const setCode=await page.locator('#code').inputValue();const [,setRaw,setSignature]=setCode.split('.');
  assert.deepEqual(new Set(JSON.parse(Buffer.from(setRaw,'base64url').toString()).items),new Set(sets.star),'The set picker creates a voucher with all four flagship pieces');
  assert(crypto.verify(null,Buffer.concat([Buffer.from('MailAI/XiaoYou/Gift/v1\0'),Buffer.from(setRaw,'base64url')]),publicKey,Buffer.from(setSignature,'base64url')));
  for(const language of ['zh-CN','en'])for(const colorScheme of ['light','dark'])for(const width of [360,520,1160])for(const scale of [1,2])for(const shape of ['nature','ranger']){
   await page.locator('#preview-shape').selectOption(shape);
   await page.locator('#language').selectOption(language);await page.emulateMedia({colorScheme});await page.setViewportSize({width,height:844});
   await page.evaluate(scale=>document.body.style.zoom=String(scale),scale);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Collection UI fits '+JSON.stringify({language,colorScheme,width,scale,shape,overflow:await page.evaluate(()=>[...document.querySelectorAll('main *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>[n.tagName,n.id,n.className,n.getBoundingClientRect().right]).slice(0,12))}));
   assert(!/Growth journal|养成手账/.test(await page.locator('main').textContent()));
  }
  assert.deepEqual(errors,[]);
  console.log('Owner issuer UI: shared three-collection catalogue, complete and partial outfit previews, two shapes, additive/removable sets, capacity preservation, 48 locale/theme/size/scale layouts, personal/campaign vouchers, eight-item limit, real signatures, local-only capability, cross-origin rejection, first-click validation, file export, lost-response/reload retry, history, Chinese/English, light/dark, clipboard fallback and compact layouts passed');
 }finally{if(browser)await browser.close();const stopped=once(server,'exit');server.kill('SIGTERM');if(server.exitCode===null)await stopped}
})().catch(e=>{console.error(e);process.exitCode=1});
