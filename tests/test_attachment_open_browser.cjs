// Run against tests/workspace_preview.py; native calls are recorded, never launched.
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await (process.env.MAILAI_BROWSER === 'webkit' ? webkit : chromium).launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.nativeOpens = []; window.nativeDownloads = [];
      window.pywebview = {api:{
        open_attachment: async (...args) => {
          window.nativeOpens.push(args);
          if (window.failNativeOpen) return {ok:false,message:'未安装关联应用'};
          if (window.holdNativeOpen) await new Promise(resolve => window.releaseNativeOpen = resolve);
          return {ok:true};
        },
        download_attachment: async (...args) => {window.nativeDownloads.push(args); return {ok:false,canceled:true};},
      }};
    });
    await page.goto('http://127.0.0.1:18795');
    await page.locator('.email-item').first().waitFor();
    await page.locator('#app-preloader').waitFor({state:'hidden'});
    await page.evaluate(async () => {await selectEmail(1);});
    const originalAccount = await page.evaluate(() => activeMailAccount().id);
    await page.locator('.attachment').first().click();
    await page.waitForFunction(() => nativeOpens.length === 1);
    assert.deepEqual(await page.evaluate(() => nativeOpens[0]), [1,0,originalAccount,'email']);
    assert.equal(await page.locator('.file-preview').isVisible(), false);
    await page.locator('.attachments .attachment-preview-action').first().click();
    await page.locator('.file-preview pre').waitFor();
    assert.equal(await page.evaluate(() => nativeOpens.length), 1);
    await page.locator('[data-preview-open]').click();
    await page.waitForFunction(() => nativeOpens.length === 2);
    assert.equal(await page.locator('.file-preview').isVisible(), true);
    await page.evaluate(() => window.failNativeOpen = true);
    await page.locator('[data-preview-open]').click();
    await page.getByText('附件打开失败：未安装关联应用', {exact:true}).waitFor();
    assert.equal(await page.locator('.file-preview').isVisible(), true);
    await page.evaluate(() => window.failNativeOpen = false);
    await page.locator('.file-preview [data-preview-download]').click();
    assert.equal(await page.evaluate(() => nativeDownloads.length), 1);
    await page.keyboard.press('Escape');
    await page.locator('.attachments .attachment-save-action').first().click();
    await page.waitForFunction(() => nativeDownloads.length === 2);
    await page.evaluate(() => window.holdNativeOpen = true);
    await page.locator('.attachment').first().click();
    await page.waitForFunction(() => !!window.releaseNativeOpen);
    await page.locator('.attachment').first().click();
    assert.equal(await page.evaluate(() => nativeOpens.length), 4, 'Repeated clicks must not launch duplicate applications');
    await page.evaluate(() => {window.holdNativeOpen = false; window.releaseNativeOpen();});
    await page.locator('#btn-attachments').click();
    await page.locator('.attachment-open').first().waitFor();
    await page.locator('.attachment-open').first().click();
    await page.waitForFunction(() => nativeOpens.length === 5);
    await page.locator('#attachment-grid .attachment-preview-action').first().click();
    await page.locator('.file-preview pre').waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(() => {closeAttachmentCenter(); openCompose({to_addr:'test@example.test',subject:'附件打开测试'});});
    await page.locator('#compose-attachments-input').setInputFiles({name:'本地附件.txt',mimeType:'text/plain',buffer:Buffer.from('原始附件内容')});
    await page.locator('[data-open-compose-attachment="0"]').click();
    await page.waitForFunction(() => nativeOpens.length === 6);
    const draftRef = await page.evaluate(() => nativeOpens.at(-1));
    assert.equal(draftRef[2], originalAccount); assert.equal(draftRef[3], 'draft');
    await page.locator('[data-preview-compose-attachment="0"]').click();
    await page.locator('.file-preview pre').waitFor();
    assert.equal(await page.locator('.file-preview pre').textContent(), '原始附件内容');
    await page.setViewportSize({width:390,height:844});
    assert(await page.locator('.file-preview').evaluate(n => n.scrollWidth <= n.clientWidth + 1));
    await page.screenshot({path:'build/attachment-open-preview-mobile.png'});
    await page.keyboard.press('Escape');
    await page.evaluate(() => {clearTimeout(draftSaveTimer); draftSession.canceled = true; closeCompose();});
    await page.setViewportSize({width:1440,height:1000});
    await page.route('**/api/mail/sent/901*', route => route.fulfill({json:{id:901,status:'sent',subject:'已发送附件',to_addr:'test@example.test',attachments:[{filename:'发送.txt',size:3}]}}));
    await page.evaluate(() => {
      specialMailbox = 'sent';
      sentMessages = [{id:901,status:'sent',subject:'已发送附件',to_addr:'test@example.test',attachments:[{filename:'发送.txt',size:3}]}];
      selectSpecialMessage(901);
    });
    await page.locator('.special-mail-attachment-item').click();
    await page.waitForFunction(() => nativeOpens.length === 7);
    assert.deepEqual(await page.evaluate(() => nativeOpens.at(-1)), [901,0,originalAccount,'sent']);
    // An explicit account on an attachment always wins over the current mailbox.
    await page.evaluate(() => {
      const link = document.createElement('a'); link.href = '/api/drafts/11/attachments/2?mailai_account=original-mailbox';
      link.download = 'account.txt'; document.body.append(link); link.click(); link.remove();
    });
    await page.waitForFunction(() => nativeOpens.length === 8);
    assert.deepEqual(await page.evaluate(() => nativeOpens.at(-1)), [11,2,'original-mailbox','draft']);
    await page.evaluate(async () => {delete window.pywebview; await selectEmail(1);});
    const [download] = await Promise.all([page.waitForEvent('download'),page.locator('.attachment').first().click()]);
    assert.equal(download.suggestedFilename(), '交付安排.csv');
    assert.equal(await page.locator('.file-preview').isVisible(), false);
    await page.locator('.attachments .attachment-preview-action').first().click();
    await page.locator('.file-preview pre').waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS open/eye/download separation, native errors, duplicate click protection, compose/sent sources, account retention, mobile dialog and browser download fallback');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
