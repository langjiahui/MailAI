// Run only with tests/workspace_preview.py (isolated fixture).
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 page.setDefaultTimeout(10000);
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto('http://127.0.0.1:18795');
  await page.waitForSelector('#email-list .email-item');
  const cfg=await page.evaluate(()=>api('/api/system/config'));
  assert.ok(cfg.accounts.every(a=>a.user.endsWith('@example.test')));
  await page.locator('.sidebar-account-folders').first().locator('[data-account-action="inbox"]').click();
  await page.waitForFunction(()=>!unifiedMailbox && allEmails.length===12);
  await page.locator('#email-list .email-item').first().click();
  if (!await page.locator('[data-reading-action="favorite"]').isVisible()) {
   await page.locator('.reading-more-actions > summary').click();
  }
  await page.locator('[data-reading-action="favorite"]').click();
  await page.waitForSelector('[data-reading-action="favorite"][aria-pressed="true"]',{state:'attached'});
  await page.locator('.sidebar-account-folders').first().locator('[data-account-action="favorites"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#email-list .email-item').length===1);
  assert.equal(await page.locator('#list-title').innerText(),'我的收藏');
  await page.reload(); await page.waitForSelector('#email-list .email-item');
  await page.locator('.sidebar-account-folders').first().locator('[data-account-action="favorites"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#email-list .email-item').length===1);
  console.log('PASS favorite add, dedicated collection and reload persistence');
  for(const theme of ['light','dark']) {
   await page.evaluate(t=>applyTheme(t),theme);
   await page.locator('#btn-contacts').click();
   await page.locator('#group-create').click();
   await page.locator('#group-dialog-name').fill('测试组-'+theme);
   await page.locator('#group-dialog-form button[type="submit"]').click();
   await page.waitForFunction(()=>!document.getElementById('group-dialog').open);
   await page.locator('[data-open-group-members]').click();
   await page.locator('#group-members-search').focus();
   await page.keyboard.press('Tab');
   assert.ok(await page.evaluate(()=>document.getElementById('group-members-dialog').contains(document.activeElement)));
   await page.locator('#group-members-list input[value="colleague@example.test"]').check();
   await page.locator('#group-members-search').fill('customer');
   await page.waitForFunction(()=>!document.querySelector('#group-members-list input[value="colleague@example.test"]') && !!document.querySelector('#group-members-list input[value="customer@example.test"]'));
   await page.locator('#group-members-list input[value="customer@example.test"]').check();
   assert.equal(await page.locator('#group-members-count').innerText(),'已选择 2 人');
   await page.screenshot({path:`build/group-members-picker-${theme}.png`});
   await page.locator('#group-members-save').click();
   await page.waitForFunction(()=>!document.getElementById('group-members-dialog').open);
   await page.waitForSelector('[data-contact-email="colleague@example.test"]');
   await page.waitForSelector('[data-contact-email="customer@example.test"]');
   await page.locator('#group-add-members').click();
   assert.equal(await page.locator('#group-members-list input[value="colleague@example.test"]').isDisabled(),true);
   await page.locator('[data-library-close="group-members-dialog"]').click();
   await page.locator('[data-group-remove-member="customer@example.test"]').click();
   await page.waitForFunction(()=>!document.querySelector('[data-contact-email="customer@example.test"]'));
   assert.ok((await page.evaluate(()=>api('/api/mail/contacts?q=customer'))).some(c=>c.email==='customer@example.test'));
   await page.locator('#btn-new-contact').click();
   await page.locator('#contact-name').fill('组内人员-'+theme);
   await page.locator('#contact-email').fill(theme+'@example.test');
   await page.locator('#contact-company').fill('测试部门');
   await page.locator('#contact-form button[type="submit"]').click();
   await page.waitForSelector(`[data-contact-email="${theme}@example.test"]`);
   await page.locator('#group-rename').click();
   await page.locator('#group-dialog-name').fill('项目组-'+theme);
   await page.locator('#group-dialog-form button[type="submit"]').click();
   await page.waitForFunction(()=>!document.getElementById('group-dialog').open);
   await page.waitForFunction(t=>document.getElementById('contact-group-filter').value==='项目组-'+t,theme);
   await page.screenshot({path:`build/mail-library-groups-${theme}.png`});
   assert.ok(await page.evaluate(()=>document.getElementById('contact-center').scrollWidth<=innerWidth));
   await page.locator('#btn-close-contacts').click();
   await page.locator('#btn-compose').click();
   for(const field of ['to','cc','bcc']) {
    // Some recipient rows are collapsed until their toggle is opened.
    await page.evaluate(f=>openContactCenter('compose-'+f),field);
    await page.locator('#contact-group-filter').selectOption('项目组-'+theme);
    await page.locator('#group-select-all').click();
    await page.locator('#btn-apply-contacts').click();
    assert.ok((await page.locator('#compose-'+field).inputValue()).includes(theme+'@example.test'));
   }
   await page.evaluate(()=>closeCompose());
   await page.locator('#btn-preferences').click();
   await page.locator('[data-system-tab="maintenance"]').click();
   await page.locator('#btn-create-backup').click();
   await page.waitForSelector('#backup-list [data-restore-backup]');
   await page.locator('#backup-list [data-restore-backup]').first().click();
   const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
   await page.locator('#restore-start').fill('2026-01-01');
   await page.locator('#restore-end').fill('2026-12-31');
   await page.screenshot({path:`build/mail-library-restore-${theme}.png`});
   await page.locator('#restore-submit').click();
   await page.waitForFunction(()=>!document.getElementById('backup-restore-dialog').open);
   await page.locator('#btn-close-system').click();
   console.log('PASS '+theme+' group create/edit/member, To/Cc/Bcc group picking and backup/range restore');
  }
  await page.locator('#btn-contacts').click();
  await page.locator('#contact-group-filter').selectOption('项目组-light');
  page.once('dialog',d=>d.accept()); await page.locator('#group-delete').click();
  await page.waitForFunction(()=>!contactGroups.some(g=>g.name==='项目组-light'));
  await page.locator('#contact-group-filter').selectOption('__ungrouped__');
  await page.waitForSelector('[data-contact-email="light@example.test"]');
  assert.deepEqual(errors,[]);
  console.log('PASS group deletion preserves contacts; zero browser runtime errors');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
