// Run against tests/workspace_preview.py (isolated example.test accounts only).
const assert = require('node:assert/strict');
const browserType = require('playwright')[process.env.MAILAI_BROWSER || 'chromium'];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
(async () => {
  const browser = await browserType.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    let getGate = deferred(), postGate = deferred();
    await page.route('**/api/productivity/templates', async route => {
      const post = route.request().method() === 'POST';
      await (post ? postGate : getGate).promise;
      await route.fulfill({status:post ? 503 : 200, contentType:'application/json',body:post ? JSON.stringify({detail:'模拟保存失败，输入已保留'}) : '[]'});
    });
    await page.evaluate(() => { void window.mailaiProductivity.templates(); });
    const status = page.locator('#productivity-dialog [data-message]');
    await page.waitForFunction(() => document.querySelector('#productivity-dialog [data-message]')?.hasAttribute('data-motion-pending'));
    assert.match(await status.textContent(), /正在读取邮件模板/);
    assert.equal(await page.locator('[data-productivity-action="save-template"]').isEnabled(), false);
    assert.equal(await status.evaluate(n => getComputedStyle(n,'::before').animationName), 'motionWorking');
    await page.waitForTimeout(250);
    await page.screenshot({path:'/tmp/mailai-motion-template-loading.png'});
    getGate.resolve();
    await page.waitForFunction(() => !document.querySelector('#productivity-dialog [data-message]')?.hasAttribute('data-motion-pending'));
    await page.locator('#productivity-template-name').fill('测试模板');
    await page.locator('#productivity-template-subject').fill('核对排期');
    await page.locator('#productivity-template-body').fill('请协助确认。');
    const save = page.locator('[data-productivity-action="save-template"]');
    const before = await save.boundingBox();
    await save.click();
    assert.equal(await save.getAttribute('aria-busy'), 'true');
    assert.equal(await save.textContent(), '保存模板');
    assert.equal((await save.boundingBox()).width, before.width, 'busy feedback must not move adjacent controls');
    assert.equal(await save.evaluate(n => getComputedStyle(n,'::after').animationName), 'workPending');
    postGate.resolve();
    await page.waitForFunction(() => !document.querySelector('[data-productivity-action="save-template"]').disabled);
    assert.equal(await save.getAttribute('aria-busy'), null);
    assert.equal(await page.locator('#productivity-template-name').inputValue(), '测试模板');
    assert.match(await status.textContent(), /模拟保存失败/);

    // An old load must not clear the next dialog's state or restore its buttons.
    await page.locator('[data-close-productivity]').click();
    getGate = deferred();
    await page.evaluate(() => { void window.mailaiProductivity.templates(); });
    await page.waitForFunction(() => document.querySelector('[data-message]')?.hasAttribute('data-motion-pending'));
    await page.locator('[data-close-productivity]').click();
    await page.evaluate(() => window.mailaiProductivity.palette());
    await page.locator('[data-message]').evaluate(n => { n.textContent='新页面状态'; });
    getGate.resolve();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-message]').textContent(), '新页面状态');
    await page.locator('[data-close-productivity]').click();

    // Overlapping state owners: only the latest completion clears the spinner.
    assert.deepEqual(await page.evaluate(() => {
      const host = document.createElement('p'); document.body.append(host);
      const first = mailaiMotion.pending(host), second = mailaiMotion.pending(host);
      first(); const busy = host.getAttribute('aria-busy'); second();
      const result = [busy, host.getAttribute('aria-busy'), host.hasAttribute('data-motion-pending')];
      host.remove(); return result;
    }), ['true',null,false]);

    // Rapid disclosure reversal and keyboard activation settle without clipping.
    await page.evaluate(() => {
      const details = document.createElement('details'); details.id='motion-test-fold'; details.className='mail-reading-fold';
      details.style.cssText='position:fixed;top:160px;left:240px;width:300px;background:white;z-index:99999';
      details.innerHTML='<summary>历史引用</summary><p style="height:180px">保留的历史正文</p>';
      document.body.append(details);
    });
    const fold = page.locator('#motion-test-fold');
    await fold.locator('summary').evaluate(n => n.click());
    assert(await fold.evaluate(n => n.getAnimations().length > 0));
    await page.waitForTimeout(60);
    await fold.locator('summary').evaluate(n => n.click());
    await page.waitForFunction(()=>!document.getElementById('motion-test-fold').open && document.getElementById('motion-test-fold').style.overflow==='');
    assert.equal(await fold.evaluate(n => n.open), false);
    assert.equal(await fold.evaluate(n => n.style.overflow), '');
    await fold.locator('summary').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.getElementById('motion-test-fold').open && document.getElementById('motion-test-fold').style.overflow==='');
    assert.equal(await fold.evaluate(n => n.open), true);
    await page.emulateMedia({reducedMotion:'reduce'});
    await fold.locator('summary').click();
    assert.equal(await fold.evaluate(n => n.open), false);
    assert.equal(await fold.evaluate(n => n.getAnimations().length), 0);
    await fold.evaluate(n => n.remove());

    await page.evaluate(() => { void mailaiProductivity.templates(); });
    await page.waitForFunction(() => !document.querySelector('[data-productivity-action="save-template"]').disabled);
    await save.evaluate(n => { n.classList.add('motion-working'); });
    assert.equal(await save.evaluate(n => getComputedStyle(n,'::after').animationName), 'none');
    await page.emulateMedia({reducedMotion:'no-preference',colorScheme:'dark'});
    await page.setViewportSize({width:390,height:844});
    await page.waitForTimeout(250);
    await page.screenshot({path:'/tmp/mailai-motion-template-narrow.png'});
    assert(await page.locator('#productivity-dialog').evaluate(n => {
      const r=n.getBoundingClientRect();return r.left>=-1 && r.right<=innerWidth+1;
    }));
    await page.locator('[data-close-productivity]').click();
    await page.setViewportSize({width:1280,height:900});
    // The directory wizard replaces its body between steps; it must animate
    // the new step without delaying focus or rebuilding editable controls.
    await page.evaluate(() => mailaiDirectoryImport(activeMailAccount().id));
    await page.locator('[data-directory-file]').setInputFiles({name:'directory.csv',mimeType:'text/csv',buffer:Buffer.from('姓名,邮箱,部门\n示例人员,motion@example.test,测试部\n')});
    await page.locator('[data-directory-next]').click();
    await page.getByRole('heading',{name:'选择通讯录名单'}).waitFor();
    assert.equal(await page.locator('.directory-dialog-body').evaluate(n => getComputedStyle(n).animationName), 'stateReveal');
    const sheet = page.locator('.directory-sheet details').first();
    await sheet.locator('summary').evaluate(n => n.click());
    assert(await sheet.evaluate(n => n.getAnimations().length>0));
    await page.waitForFunction(()=>document.querySelector('.directory-sheet details')?.style.overflow==='');
    assert.equal(await sheet.evaluate(n=>n.style.overflow), '');
    await page.locator('[data-directory-close]').click();
    // Rich HTML mail uses a separate document and must receive the same motion.
    await page.evaluate(() => {
      const frame=document.createElement('iframe'); frame.id='motion-test-frame';
      document.getElementById('reading-content').append(frame);
      frame.contentDocument.body.innerHTML='<p>当前正文</p><blockquote type="cite">历史内容</blockquote>';
      mailaiFoldReadingDocument(frame.contentDocument,frame);
      const summary=frame.contentDocument.querySelector('summary'); summary.click();
      window.motionFrameAnimated=summary.parentElement.getAnimations().length>0;
    });
    assert.equal(await page.evaluate(()=>window.motionFrameAnimated),true);
    await page.waitForFunction(()=>document.getElementById('motion-test-frame').contentDocument.querySelector('details')?.style.overflow==='');
    assert.equal(await page.evaluate(()=>document.getElementById('motion-test-frame').contentDocument.querySelector('details').style.overflow),'');
    await page.evaluate(()=>document.getElementById('motion-test-frame').remove());
    assert.deepEqual(errors, []);
    console.log('PASS productivity motion: slow loads, stable busy buttons, failure recovery, stale dialogs, overlapping requests, rapid/keyboard disclosures, reduced motion and narrow layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
