// Run against tests/workspace_preview.py; the fixture uses example.test accounts.
const assert = require('node:assert/strict');
const {chromium,webkit} = require('playwright');

(async () => {
  const browser = await (process.env.MAILAI_BROWSER === 'webkit' ? webkit : chromium).launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:600}});
    await page.addInitScript(() => localStorage.setItem('mailai-language', 'zh-CN'));
    await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(() => document.body.dataset.petStage);
    await page.evaluate(() => { setI18nLanguage('zh-CN'); applyTheme('light'); });
    const button = page.locator('#btn-filter-panel');
    const panel = page.locator('#workspace-filters');
    const clear = page.locator('#btn-reset-filter');
    const listTop = (await page.locator('#email-list').boundingBox()).y;
    await button.click();
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert(await panel.evaluate(node => node.getAnimations().length) > 0, 'drawer opening should animate');
    await page.waitForTimeout(100);
    const midTop = (await page.locator('#email-list').boundingBox()).y;
    await page.waitForTimeout(300);
    const endTop = (await page.locator('#email-list').boundingBox()).y;
    assert(listTop < midTop && midTop < endTop, 'mail list should follow the opening drawer');
    const geometry = await page.evaluate(() => {
      const panel = document.getElementById('workspace-filters').getBoundingClientRect();
      const clear = document.getElementById('btn-reset-filter').getBoundingClientRect();
      const footer = document.querySelector('.list-footer').getBoundingClientRect();
      const content = document.querySelector('.filter-panel-content');
      return {panelTop:panel.top,panelRight:panel.right,panelBottom:panel.bottom,
        clearTop:clear.top,clearRight:clear.right,clearBottom:clear.bottom,footerTop:footer.top,
        contentScrollHeight:content.scrollHeight,contentHeight:content.clientHeight};
    });
    assert(geometry.clearTop >= geometry.panelTop && geometry.clearTop < geometry.panelTop + 50
      && geometry.panelRight - geometry.clearRight < 60,
    'Reset should sit beside Collapse in the top-right filter header');
    assert(geometry.clearBottom < geometry.panelBottom && geometry.clearBottom < geometry.footerTop);
    assert(geometry.contentScrollHeight <= geometry.contentHeight + 1,
      'the full filter form should fit without an inner scrollbar at a normal desktop height');
    await page.locator('#filter-priority [data-value="高"]').click();
    assert.equal(await clear.isEnabled(), true);
    await clear.click();
    assert.equal(await page.locator('#filter-priority [data-value=""]').evaluate(node => node.classList.contains('active')), true);
    await button.click();
    assert(await panel.evaluate(node => node.getAnimations().length) > 0, 'drawer closing should animate');
    await page.waitForFunction(() => document.getElementById('workspace-filters').classList.contains('hidden'));
    assert.equal((await page.locator('#email-list').boundingBox()).y, listTop);
    await button.click();
    await page.waitForTimeout(70);
    await button.click();
    await page.waitForFunction(() => document.getElementById('workspace-filters').classList.contains('hidden'));
    assert.equal(await button.getAttribute('aria-expanded'), 'false', 'a rapid reversal should end closed');
    await page.emulateMedia({reducedMotion:'reduce'});
    await button.click();
    assert.equal(await panel.evaluate(node => node.getAnimations().length), 0);
    assert.equal(await clear.isVisible(), true);
    await button.click();
    assert.equal(await panel.isVisible(), false);
    await page.setViewportSize({width:400,height:700});
    await button.dispatchEvent('click');
    await page.waitForTimeout(380);
    const narrow = await page.evaluate(() => {
      const list = document.getElementById('email-list').getBoundingClientRect();
      const panel = document.getElementById('workspace-filters').getBoundingClientRect();
      const clear = document.getElementById('btn-reset-filter');
      const clearTop = clear.getBoundingClientRect().top;
      const content = document.querySelector('.filter-panel-content');
      content.scrollTop = content.scrollHeight;
      return {listHeight:list.height,panelBottom:panel.bottom,clearBottom:clear.getBoundingClientRect().bottom,
        clearTop,clearTopAfterScroll:clear.getBoundingClientRect().top};
    });
    assert(narrow.listHeight >= 100, 'narrow screens should retain room for the mail list');
    assert(narrow.clearBottom < narrow.panelBottom, 'Clear all should remain visible on narrow screens');
    assert.equal(narrow.clearTopAfterScroll, narrow.clearTop, 'Clear all should stay in place while options scroll');
    await page.setViewportSize({width:1280,height:800});
    await page.locator('#filter-days [data-value="7"]').click();
    await page.locator('#filter-priority [data-value="高"]').click();
    assert.equal(await page.locator('#btn-filter-panel .filter-trigger-count').textContent(), '2');
    assert.equal(await page.locator('#workspace-filters #filter-chips button').count(), 2);
    await page.locator('label[for="filter-unread"]').click();
    assert.equal(await page.locator('#filter-unread').isChecked(), true);
    await page.locator('label[for="filter-attachments"]').click();
    assert.equal(await page.locator('#filter-attachments').isChecked(), true);
    assert.equal(await page.locator('#btn-filter-panel .filter-trigger-count').textContent(), '4');
    await page.locator('#filter-chips [data-remove-filter="unread"]').click();
    assert.equal(await page.locator('#filter-unread').isChecked(), false);
    assert.equal(await page.locator('#filter-attachments').isChecked(), true);
    await page.locator('#filter-chips [data-remove-filter="attachments"]').click();
    assert.equal(await page.locator('#filter-attachments').isChecked(), false);
    assert.equal(await page.locator('#btn-filter-panel .filter-trigger-count').textContent(), '2');
    assert.equal(await page.locator('#filter-result-count').textContent(), await page.locator('#list-count').textContent());
    assert(await panel.evaluate(node => node.getBoundingClientRect().height < 400), 'compact Chinese filters should leave visible mail below');
    await page.locator('#btn-collapse-filters').click();
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-filter-panel');
    assert.equal(await page.locator('.list-workspace-tools #filter-chips button').count(), 2);
    await page.locator('#filter-chips [data-remove-filter="priority"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.removeFilter), 'days', 'keyboard focus should stay with the remaining chips');
    assert.equal(await page.evaluate(() => currentFilter.priority), '');
    assert.equal(await page.evaluate(() => currentFilter.days), 7, 'removing one chip must preserve the other filters');
    assert.equal(await page.locator('#btn-filter-panel .filter-trigger-count').textContent(), '1');
    await page.locator('#filter-chips-clear').click();
    assert.equal(await page.evaluate(() => currentFilter.days), 9999);
    await page.waitForFunction(() => !document.getElementById('filter-chips').childElementCount);
    assert.equal(await page.locator('#filter-chips').isVisible(), false);
    assert.equal(await page.locator('#btn-filter-panel .filter-trigger-count').isVisible(), false);
    await button.click();
    await page.locator('#filter-priority [data-value="中"]').focus();
    await page.keyboard.press('Escape');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-filter-panel');
    await button.click();
    for (const width of [400,1280]) for (const language of ['zh-CN','en']) for (const theme of ['','theme_monochrome','theme_baowu']) for (const mode of ['light','dark']) {
      await page.setViewportSize({width,height:800});
      await page.evaluate(({language,theme,mode}) => {
        applyTheme(mode);
        setI18nLanguage(language);
        if (theme) document.documentElement.dataset.rewardTheme = theme;
        else delete document.documentElement.dataset.rewardTheme;
      }, {language,theme,mode});
      assert.equal(await page.evaluate(() => document.documentElement.dataset.rewardTheme || ''), theme);
      const layout = await panel.evaluate(root => {
        const body=root.querySelector('.filter-panel-content');
        return {aligned:[...root.querySelectorAll('.filter-block')].every(row=>{const label=row.querySelector('legend').getBoundingClientRect(),options=row.querySelector('.filter-segments').getBoundingClientRect();return label.right<=options.left+1 || label.bottom<=options.top+1;}),overflow:body.scrollWidth > body.clientWidth+1,rows:[...root.querySelectorAll('.filter-form>*')].map(node=>getComputedStyle(node).borderBottomWidth)};
      });
      assert.equal(layout.overflow,false, `filter overflow: ${width}/${language}/${theme}/${mode}`);
      assert(layout.aligned, `filter labels must not overlap options: ${width}/${language}/${theme}/${mode}`);
      assert(layout.rows.every(value=>value === '0px'), 'filter rows must not regain separating rules in any theme');
      const contrast = await panel.evaluate(root => {
        const input=root.querySelector('#filter-unread'),track=input.nextElementSibling,previous=input.checked;
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
        const context=canvas.getContext('2d');
        const luminance=color=>{context.fillStyle=color;context.fillRect(0,0,1,1);const rgb=[...context.getImageData(0,0,1,1).data].slice(0,3).map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
        const measure=checked=>{input.checked=checked;const a=luminance(getComputedStyle(track).backgroundColor),b=luminance(getComputedStyle(track,'::after').backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
        const values={off:measure(false),on:measure(true)};input.checked=previous;return values;
      });
      assert(contrast.on>=3 && contrast.off>=1.2, `switch thumb must remain visible: ${width}/${language}/${theme}/${mode} ${JSON.stringify(contrast)}`);
      if (language === 'en') {
        const untranslated=await panel.evaluate(root=>[...root.querySelectorAll('*')].flatMap(node=>[...[...node.childNodes].filter(child=>child.nodeType===3).map(child=>child.textContent),node.title,node.getAttribute('aria-label')].filter(text=>/[\u3400-\u9fff]/.test(text || ''))));
        assert.deepEqual(untranslated,[], 'the filter panel must switch fully to English');
      }
    }
    await page.evaluate(() => {setI18nLanguage('zh-CN');applyTheme('light');delete document.documentElement.dataset.rewardTheme;});
    await page.locator('#btn-collapse-filters').click();
    await page.locator('[data-account-action="sent"]').first().click();
    await button.click();
    assert.equal(await page.locator('#filter-priority').isVisible(), false, 'sent mail must not expose received-mail priority controls');
    assert.equal(await page.locator('#filter-unread').isVisible(), false, 'sent mail must not expose unread filtering');
    console.log('PASS compact filters, chip removal, result counts, keyboard, themes and localization');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
