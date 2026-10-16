// Isolated workspace: menu geometry, inherited toolbar styles and keyboard use.
const assert = require('node:assert/strict');
const {chromium, webkit} = require('playwright');
(async () => {
  const browser = await (process.env.MAILAI_BROWSER === 'webkit' ? webkit : chromium).launch();
  try {
    const page = await browser.newPage({viewport:{width:1920,height:900},reducedMotion:'reduce'}), errors=[];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('mailai.onboarding.v2',JSON.stringify({mailboxDone:true,aiDone:true,deferred:true})));
    await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795/?shell=macos');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(async () => { await initialLoad; setI18nLanguage('zh-CN'); });
    await page.locator('.email-item').first().click();
    const trigger = page.locator('.reading-more-actions>summary'), panel = page.locator('.reading-more-panel');
    await trigger.waitFor();
    for (const language of ['zh-CN','en']) {
      await page.evaluate(language => setI18nLanguage(language), language);
      for (const mode of ['light','dark']) for (const theme of ['', 'theme_monochrome','theme_baowu']) for (const width of [390,900,1920]) {
        await page.setViewportSize({width,height:width===1920?900:600});
        await page.evaluate(({mode,theme}) => { document.documentElement.dataset.theme=mode; if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme; }, {mode,theme});
        await trigger.focus(); await page.keyboard.press('ArrowDown');
        await panel.waitFor({state:'visible'});
        const result = await panel.evaluate(n => {
          const rect=n.getBoundingClientRect(), buttons=[...n.querySelectorAll('button')];
          const groups=[...n.querySelectorAll('.reading-risk-group,.reading-overflow-actions')];
          return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight,
            rows:buttons.map(b=>({text:b.textContent.trim(),width:b.offsetWidth,height:b.offsetHeight,border:getComputedStyle(b).borderWidth})),
            lines:groups.map(g=>({top:getComputedStyle(g).borderTopWidth,bottom:getComputedStyle(g).borderBottomWidth})),
            focus:document.activeElement===buttons[0]};
        });
        const context=JSON.stringify({language,mode,theme,width,result});
        assert(result.left>=11&&result.right<=result.width-11&&result.top>=11&&result.bottom<=result.height-11,context);
        assert(result.focus,context);
        assert(result.rows.every(r=>r.height>=40&&r.width===result.rows[0].width&&r.border==='0px'),context);
        assert(result.lines.every(r=>r.top==='0px'&&r.bottom==='0px'),context);
        await page.keyboard.press('End');
        assert(await page.locator('[data-reading-action="delete-current"]').evaluate(n=>document.activeElement===n),'End reaches the scrollable last row');
        assert(await page.locator('[data-reading-action="delete-current"]').evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'Last row can be reached and clicked');
        await page.keyboard.press('Home'); await page.keyboard.press('ArrowUp');
        assert(await page.locator('[data-reading-action="delete-current"]').evaluate(n=>document.activeElement===n),'Arrow keys wrap without escaping the disclosure');
        await page.keyboard.press('Escape'); assert(!(await panel.isVisible())); assert(await trigger.evaluate(n=>document.activeElement===n));
      }
    }
    // Keep an open disclosure usable as overflow actions move during resize/zoom.
    await page.setViewportSize({width:1920,height:900}); await trigger.click();
    await page.setViewportSize({width:390,height:600});
    await page.evaluate(()=>{document.body.style.zoom='1.3';positionReadingMorePanel(document.querySelector('.reading-more-actions'));});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    // A trigger that moved outside the viewport closes its disclosure. Scroll
    // it into view and reopen, as a user would after resizing a short window.
    await trigger.scrollIntoViewIfNeeded();
    if (!(await panel.isVisible())) { await trigger.focus(); await page.keyboard.press('ArrowDown'); }
    await page.waitForFunction(()=>{const r=document.querySelector('.reading-more-panel').getBoundingClientRect();return r.left>=11&&r.right<=innerWidth-11&&r.top>=11&&r.bottom<=innerHeight-11;});
    const rect=await panel.boundingBox();assert(rect.x>=11&&rect.x+rect.width<=379&&rect.y>=11&&rect.y+rect.height<=589,JSON.stringify(rect));
    await page.keyboard.press('Escape');
    await page.evaluate(()=>{document.body.style.zoom='';setI18nLanguage('zh-CN');document.documentElement.dataset.theme='light';delete document.documentElement.dataset.rewardTheme;});
    await page.setViewportSize({width:1920,height:900});await trigger.click();
    await page.locator('#global-search').focus();assert(!(await panel.isVisible()),'Tab/focus leaving the disclosure dismisses it');
    await trigger.click();await page.locator('.reading-subject').click();assert(!(await panel.isVisible()),'Outside click dismisses it');
    await trigger.click();await panel.locator('[data-reading-action="remind"]').click();assert(!(await panel.isVisible()));
    await page.locator('#task-planner').waitFor({state:'visible'});
    await page.locator('#task-planner [data-plan-close]').first().click();
    await trigger.click();
    await page.locator('.email-item').nth(1).click();
    assert(!(await panel.isVisible()),'Switching messages discards the old disclosure');
    await trigger.click();
    const first=panel.locator('button').first();
    assert(await first.evaluate(n=>{const p=n.closest('.reading-more-panel');return n.getBoundingClientRect().top-p.getBoundingClientRect().top<10;}),'No phantom group spacing precedes the first item');
    await first.evaluate(n=>n.disabled=true);await trigger.focus();await page.keyboard.press('Home');
    assert(!(await first.evaluate(n=>document.activeElement===n)),'Keyboard navigation skips disabled actions');
    await first.evaluate(n=>n.disabled=false);
    assert.deepEqual(errors,[]);
    console.log('PASS reading More: 36 theme/language/width combinations, no separators, consistent rows, zoom/resize containment, keyboard navigation, dismissal and reminder action');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
