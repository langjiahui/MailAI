// Isolated preview fixture only.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto('http://127.0.0.1:18795');await page.locator('.email-item').first().waitFor();
  await page.locator('#btn-compose').click();
  await page.evaluate(()=>toggleComposeAiPanel(true));
  await page.evaluate(()=>openComposePreview());
  assert.equal(await page.evaluate(()=>document.activeElement.matches('#compose-preview-modal [data-close-compose-preview]')),true);
  await page.keyboard.press('Escape');
  await page.locator('#compose-preview-modal').waitFor({state:'hidden'});
  assert.equal(await page.locator('#compose-ai-panel').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'btn-compose-preview');
  await page.keyboard.press('Escape');
  await page.locator('#compose-ai-panel').waitFor({state:'hidden'});
  assert.equal(await page.locator('#compose-modal').isVisible(),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#compose-modal').isVisible(),true);
  await page.locator('#compose-subject').fill('键盘验证草稿');
  await page.evaluate(()=>queueDraftSave());
  assert.match(await page.locator('#draft-state').innerText(),/等待保存/);
  await page.evaluate(()=>saveCurrentDraft({force:true}));
  assert.match(await page.locator('#draft-state').innerText(),/已存/);
  await page.locator('#btn-save-draft').click();
  await page.waitForFunction(()=>!document.body.classList.contains('compose-open'));
  assert.equal(await page.evaluate(()=>document.activeElement.id),'btn-compose');
  console.log('Compose Escape layering, preview focus, saved status and return focus passed');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
