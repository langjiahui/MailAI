// Run against tests/workspace_preview.py (isolated example.test accounts only).
const assert = require('node:assert/strict');
const browserType = require('playwright')[process.env.MAILAI_BROWSER || 'chromium'];

// Measure rendered text against the composited surface, including transparent buttons.
async function contrast(locator, minimum = 4.5) {
  const result = await locator.evaluate(node => {
    const rgb = value => value.match(/[\d.]+/g).map(Number);
    const mix = (top, bottom) => top.slice(0, 3).map((v, i) => v * (top[3] ?? 1) + bottom[i] * (1 - (top[3] ?? 1)));
    const luminance = color => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const chain = [];
    for (let n = node; n; n = n.parentElement) chain.unshift(n);
    const background = chain.reduce((bg, n) => mix(rgb(getComputedStyle(n).backgroundColor), bg), [255, 255, 255]);
    const foreground = mix(rgb(getComputedStyle(node).color), background);
    const light = luminance(foreground), dark = luminance(background);
    return {text:node.textContent.trim(), ratio:(Math.max(light, dark) + .05) / (Math.min(light, dark) + .05), background};
  });
  assert(result.ratio >= minimum, `${result.text}: contrast ${result.ratio.toFixed(2)} < ${minimum}`);
  return result;
}

(async () => {
  const browser = await browserType.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}, reducedMotion:'reduce'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Other browser checks can edit the fixture's contacts. Keep visual states
    // deterministic without depending on their order or mutating server data.
    await page.route('**/api/mail/contacts?*', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify([
      {email:'colleague@example.test',name:'项目同事',company:'示例公司',count:12,favorite:true},
      {email:'customer@example.test',name:'示例客户',count:1,favorite:false},
    ])}));
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(() => setI18nLanguage('zh-CN'));
    await page.evaluate(async () => { document.documentElement.dataset.theme = 'dark'; await openContactCenter(); });
    const entry = page.locator('#contact-center .productivity-panel-entry');
    await contrast(entry);
    await entry.hover();
    const hover = await contrast(entry);
    assert(Math.max(...hover.background) < 80, 'dark hover must not fall back to a light surface');
    await page.keyboard.press('Tab');
    await entry.focus();
    assert.equal(await entry.evaluate(n => getComputedStyle(n).outlineStyle), 'solid');
    assert.equal(await entry.evaluate(n => getComputedStyle(n).transitionDuration), '0s');
    for (const selector of ['.contact-new-button', '[data-contact-filter].active', '[data-contact-compose]', '[data-contact-edit]', '[data-contact-delete]']) {
      await contrast(page.locator(`#contact-center ${selector}`).first());
    }
    const favorite = page.locator('#contact-center .contact-star.active').first();
    assert.equal(await favorite.getAttribute('aria-pressed'), 'true');
    const star = await contrast(favorite, 3);
    assert(Math.max(...star.background) < 100, 'favorite state must use a subdued dark surface');
    assert.equal(await page.locator('#contact-center .contact-star:not(.active)').first().getAttribute('aria-pressed'), 'false');
    // Exchange-count labels have their own colors; test both children while hovered,
    // focused and pressed so a pale fallback cannot hide the number again.
    const frequency = page.locator('#contact-center .contact-correspondence-trigger').first();
    async function frequencyContrast() {
      const result = await contrast(frequency.locator('b'));
      await contrast(frequency.locator('small'));
      assert(Math.max(...result.background) < 80, 'exchange count must keep a dark surface');
    }
    await frequency.hover();
    await frequencyContrast();
    await page.mouse.down();
    await page.waitForTimeout(180);
    await frequencyContrast();
    await page.mouse.move(0,0);
    await page.mouse.up();
    await page.keyboard.press('Tab');
    await frequency.focus();
    await frequencyContrast();
    assert.equal(await frequency.evaluate(n => getComputedStyle(n).outlineStyle), 'solid');
    // Theme switching updates the same controls without reloading or losing state.
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await contrast(entry);
    await entry.hover();
    await contrast(entry);
    await contrast(page.locator('.contact-new-button'));
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await entry.click();
    await page.locator('.directory-dialog[open]').waitFor();
    assert.equal(await page.locator('[data-directory-next]').isEnabled(), false, 'import next stays disabled until a file is ready');
    await page.locator('[data-directory-file]').setInputFiles({name:'contrast.csv',mimeType:'text/csv',buffer:Buffer.from('姓名,邮箱\n示例人员,contrast@example.test\n')});
    await page.waitForFunction(() => !document.querySelector('[data-directory-next]').disabled);
    await contrast(page.locator('[data-directory-next]'));
    await page.locator('[data-directory-close]').click();
    await page.setViewportSize({width:390,height:844});
    await entry.scrollIntoViewIfNeeded();
    assert(await entry.evaluate(n => { const r=n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), 'import entry stays within narrow viewport');
    await contrast(entry);
    await page.setViewportSize({width:1440,height:1000});
    await frequency.hover();
    await page.waitForTimeout(180);
    await page.screenshot({path:'/tmp/mailai-dark-contacts-after.png'});
    await page.evaluate(async () => { closeContactCenter(); await openAttachmentCenter(); });
    const attachmentEntries = page.locator('#attachment-center .productivity-panel-entry');
    assert.equal(await attachmentEntries.count(), 2);
    assert.deepEqual(await attachmentEntries.allTextContents(), ['查找文件内容', '已分享文件']);
    for (const item of await attachmentEntries.all()) {
      await contrast(item);
      await item.hover();
      assert(Math.max(...(await contrast(item)).background) < 80, 'attachment tool hover keeps a dark surface');
      await page.mouse.down();
      assert(await item.evaluate(n => n.matches(':active')));
      assert(Math.max(...(await contrast(item)).background) < 80, 'attachment tool pressed state keeps a dark surface');
      await page.mouse.move(0,0);
      await page.mouse.up();
      await page.keyboard.press('Tab');
      await item.focus();
      assert(await item.evaluate(n => n.matches(':focus-visible') && getComputedStyle(n).outlineStyle === 'solid'));
      await contrast(item);
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const item of await attachmentEntries.all()) { await item.hover(); await contrast(item); }
    }
    await page.setViewportSize({width:390,height:844});
    for (const item of await attachmentEntries.all()) {
      await item.scrollIntoViewIfNeeded();
      assert(await item.evaluate(n => { const r=n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), 'attachment tool stays within narrow viewport');
    }
    await page.setViewportSize({width:1440,height:1000});
    await attachmentEntries.first().hover();
    await page.locator('#attachment-center .attachment-center-card').screenshot({path:'/tmp/mailai-dark-attachments-after.png'});
    await page.evaluate(async () => { closeAttachmentCenter(); await openTodoCenter(); });
    const calendar = page.locator('#todo-center .productivity-panel-entry');
    await contrast(calendar);
    await calendar.hover();
    await contrast(calendar);
    await page.mouse.down();
    assert(Math.max(...(await contrast(calendar)).background) < 80);
    await page.mouse.move(0,0);
    await page.mouse.up();
    await page.keyboard.press('Tab');
    await calendar.focus();
    assert(await calendar.evaluate(n => n.matches(':focus-visible') && getComputedStyle(n).outlineStyle === 'solid'));
    await contrast(calendar);
    await page.locator('#todo-center .todo-center-card').screenshot({path:'/tmp/mailai-dark-todos-after.png'});
    // Paging controls are only rendered after a list reaches its display limit.
    await page.evaluate(() => {
      const seed = {status:'open',title:'Synthetic contrast check',deadline:'',email_id:1,...todoCenterRows[0]};
      todoCenterRows = [{...seed,id:1001,status:'open'}, {...seed,id:1002,status:'open'}];
      window.mailaiTodoMatches = () => true;
      todoRenderLimit = 1; renderTodoCenter();
    });
    const moreTodos = page.locator('.todo-render-more');
    await moreTodos.hover();
    assert(Math.max(...(await contrast(moreTodos)).background) < 80);
    await contrast(moreTodos.locator('small'));
    await page.evaluate(() => { closeTodoCenter(); mailRenderLimit = 1; renderEmailList(allEmails); });
    const moreMail = page.locator('.email-render-more');
    await moreMail.hover();
    assert(Math.max(...(await contrast(moreMail)).background) < 80);
    await contrast(moreMail.locator('small'));
    const filters = page.locator('#btn-filter-panel');
    await filters.hover();
    assert(Math.max(...(await contrast(filters)).background) < 80, 'list filter must not use an undefined light hover fallback');
    await filters.click();
    await page.mouse.move(0,0);
    assert.equal(await filters.getAttribute('aria-expanded'), 'true');
    assert(Math.max(...(await contrast(filters)).background) < 80, 'expanded list filter keeps the theme surface');
    await filters.click();
    // This legacy sidebar control can be hidden in the multi-account layout.
    await page.evaluate(() => document.getElementById('server-folder-group').classList.remove('hidden'));
    const folder = page.locator('#btn-create-folder');
    await contrast(folder, 3);
    await folder.hover();
    assert(Math.max(...(await contrast(folder, 3)).background) < 80);
    await page.evaluate(() => openAssistant());
    const image = page.locator('#assistant-add-image');
    await contrast(image, 3);
    await image.hover();
    assert(Math.max(...(await contrast(image, 3)).background) < 80, 'assistant image button keeps a dark hover');
    await page.keyboard.press('Tab');
    await image.focus();
    assert(await image.evaluate(n => n.matches(':focus-visible') && getComputedStyle(n).outlineStyle === 'solid'));
    await page.evaluate(() => { closeAssistant(); showRulesView(); });
    const advanced = page.locator('#btn-toggle-advanced-rules');
    await contrast(advanced.locator('i'));
    await advanced.hover();
    for (const selector of ['b', 'small', 'i']) await contrast(advanced.locator(selector));
    assert.deepEqual(errors, []);
    console.log('PASS dark UI: tool/count hover and pressed contrast, keyboard focus, subdued favorites, theme switching, import readiness, narrow layout, attachment/calendar entries, paging counts, list filters, assistant images and advanced rules');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
