// Run against tests/workspace_preview.py; this fixture never uses a real mailbox.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext({viewport:{width:1280,height:900}});
    await context.grantPermissions(['clipboard-read','clipboard-write'], {origin:'http://127.0.0.1:18795'});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 24; canvas.height = 16;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#328e65'; ctx.fillRect(0,0,24,16);
      return canvas.toDataURL('image/png');
    });
    await page.evaluate(() => openCompose({to_addr:'customer@example.test',subject:'图片测试',body_html:'<p>测试</p>'}));
    await page.evaluate(() => openSignatureManager());
    await page.locator('#signature-manager').waitFor({state:'visible'});
    await page.locator('#btn-new-signature').click();
    await page.locator('#signature-name').fill('图片签名');
    await page.locator('#signature-editor').evaluate(editor => {
      editor.textContent = '前后';
      const range = document.createRange();
      range.setStart(editor.firstChild, 1); range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      editor.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
    });
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#btn-insert-signature-image').click();
    await (await chooser).setFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from(dataUrl.split(',')[1], 'base64')});
    await page.locator('#signature-editor img').waitFor();
    const html = await page.locator('#signature-editor').innerHTML();
    assert.match(html, /^前<img [^>]*src="data:image\/png;base64,[^"]+"[^>]*>后$/);
    await page.locator('#btn-save-signature').click();
    await page.waitForFunction(() => signatureState.items.some(item => item.name === '图片签名'));
    await page.evaluate(() => openSignatureManager());
    await page.locator('#signature-editor img').waitFor();
    assert.equal(await page.locator('#signature-editor').innerHTML(), html);

    await page.evaluate(src => {
      document.querySelectorAll('[data-close-signatures]')[0].click();
      hideCompose();
      specialMailbox = 'sent';
      const row = {id:901,status:'sent',to_addr:'customer@example.test',subject:'带图片的邮件',
        body_html:`<p>正文图片 <img src="${src}" alt="示例"></p>`};
      sentMessages = [row];
      selectSpecialMessage(901, row);
    }, dataUrl);
    const frame = page.frameLocator('#special-mail-body iframe');
    await frame.locator('img').dispatchEvent('pointerover');
    await frame.getByRole('button', {name:'复制这张邮件图片'}).click();
    await page.getByText('图片已复制，可粘贴到签名或其他位置').waitFor();
    const copied = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const blob = await items[0].getType('image/png');
      return {types:items[0].types, size:blob.size};
    });
    assert(copied.types.includes('image/png') && copied.size > 0);
    await page.evaluate(() => openCompose({to_addr:'customer@example.test',subject:'粘贴图片',body_html:'<p>测试</p>'}));
    await page.evaluate(() => openSignatureManager());
    await page.locator('#btn-new-signature').click();
    await page.locator('#signature-name').fill('粘贴的图片');
    await page.locator('#signature-editor').click();
    await page.keyboard.press('ControlOrMeta+V');
    await page.locator('#signature-editor img').waitFor();
    assert.match(await page.locator('#signature-editor img').getAttribute('src'), /^data:image\/png;base64,/);
    assert.deepEqual(errors, []);
    console.log('PASS signature image at caret, saved round-trip, and body image copy/paste');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
