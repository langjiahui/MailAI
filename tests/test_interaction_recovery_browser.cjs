// Run only with tests/workspace_preview.py (isolated example.test accounts).
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({headless:true, channel:'chrome'});
 try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18795');
  await page.locator('.email-item').first().waitFor();
  let searchFailure = true;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') === 'network-failure' && searchFailure)
      return route.fulfill({status:503,contentType:'application/json',body:'{"detail":"测试搜索中断"}'});
    if (url.searchParams.get('q') === 'no-such-mail-unique') await new Promise(resolve=>setTimeout(resolve,450));
    return route.continue();
  });
  await page.locator('#global-search').fill('no-such-mail-unique');
  assert.equal(await page.locator('#global-search').getAttribute('aria-busy'),'true');
  assert.match(await page.locator('#search-progress').innerText(),/正在搜索/);
  await page.locator('[data-search-recover="clear"]').waitFor();
  await page.locator('[data-search-recover="clear"]').click();
  await page.locator('.email-item').first().waitFor();
  assert.equal(await page.locator('#global-search').inputValue(),'');
  await page.locator('#global-search').fill('network-failure');
  await page.locator('#search-error').waitFor();
  assert.equal(await page.locator('#global-search').getAttribute('aria-busy'),'false');
  searchFailure = false;
  await page.locator('#search-retry').click();
  await page.locator('[data-search-recover="clear"]').waitFor();
  await page.locator('[data-search-recover="clear"]').click();
  await page.locator('.email-item').first().waitFor();
  await page.evaluate(()=>openCompose());
  await page.evaluate(()=>toggleComposeAiPanel(true));
  await page.evaluate(()=>{
   document.getElementById('compose-subject').value='原主题';
   composeMessageElement().innerHTML='<p>原正文</p>';
   composeAiSuggestion={subject:'新主题',body:'新正文',signoff:'谢谢'};
   applyComposeAiSuggestion('subject');undoComposeAiEdit();
  });
  assert.equal(await page.locator('#compose-subject').inputValue(),'原主题');
  await page.evaluate(()=>applyComposeAiSuggestion('replace'));
  assert.equal(await page.locator('#compose-signature-content').innerText(),'谢谢');
  await page.evaluate(()=>undoComposeAiEdit());
  assert.equal(await page.locator('#compose-message').innerText(),'原正文');
  assert.equal(await page.locator('#compose-signature-content').innerText(),'');
  await page.evaluate(()=>{applyComposeAiSuggestion('replace');composeMessageElement().innerHTML='<p>手动修改</p>';undoComposeAiEdit();});
  assert.equal(await page.locator('#compose-message').innerText(),'手动修改');
  await page.locator('#compose-ai-instruction').fill('写一封邮件');
  let fail=false;
  await page.route('**/api/mail/compose/assist-stream',route=>route.fulfill(fail ? {status:500,contentType:'application/json',body:'{"detail":"测试连接中断"}'} : {contentType:'application/x-ndjson',body:JSON.stringify({type:'done',content:'主题：材料\n\n请查收材料。',subject:'材料',body:'请查收材料。',basis:['要求']})+'\n'}));
  await page.evaluate(()=>aiCompose('draft',document.getElementById('btn-ai-generate')));
  const preview=await page.locator('#compose-ai-output').innerText();
  fail=true;
  await page.evaluate(()=>aiCompose('draft',document.getElementById('btn-ai-generate')));
  assert.equal(await page.locator('#compose-ai-output').innerText(),preview);
  assert.equal(await page.locator('#compose-ai-retry').isVisible(),true);
  assert.equal(await page.locator('#btn-ai-replace').isEnabled(),true);
  let uploadFails = true;
  await page.route('**/api/share-storage/tasks/*/upload', route => route.fulfill(uploadFails
    ? {status:502,contentType:'application/json',body:JSON.stringify({detail:'测试断网'})}
    : {contentType:'application/json',body:JSON.stringify({url:'https://example.test/download',name:'测试.zip',expires_at:'2026-10-03T12:00:00Z'})}));
  await page.evaluate(async()=>{
   await uploadSharedFileWithCard(new File(['test'],'测试.zip'),7,draftSession,composeAccountId);
  });
  assert.equal(await page.locator('[data-retry-share]').count(),1);
  const seed = await page.evaluate(async()=>{await saveCurrentDraft({force:true});return api(`/api/drafts/${draftSession.id}`,{accountId:composeAccountId});});
  assert.equal(await page.evaluate(()=>closeCompose()),true, 'persisted failed uploads should allow closing');
  await page.evaluate(seed=>openCompose(seed),seed);
  await page.locator('[data-retry-share]').waitFor();
  assert.match(await page.locator('#compose-shared-files').innerText(), /已保存本机/);
  uploadFails = false;
  await page.locator('[data-retry-share]').click();
  await page.locator('.shared-file-card[data-state="done"]').waitFor();
  assert.equal(await page.locator('#compose-message a[href="https://example.test/download"]').count(),1);
  assert.equal(await page.locator('[data-retry-share]').count(),0);
  await page.screenshot({path:'build/interaction-recovery-light.png'});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:'build/interaction-recovery-dark.png'});
  assert.deepEqual(errors,[]);
  console.log('Search recovery, scoped AI undo, regeneration failure preservation and upload retry passed');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
