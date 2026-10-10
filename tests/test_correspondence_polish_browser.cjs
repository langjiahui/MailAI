// Use the isolated workspace fixture; all history responses are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const browserType = require('playwright')[process.env.MAILAI_BROWSER || 'chromium'];

async function contrast(locator) {
  const ratio = await locator.evaluate(node => {
    const rgb = value => {
      const a=value.match(/[\d.]+/g).map(Number);
      return value.startsWith('color(srgb ') ? [...a.slice(0,3).map(v=>v*255),a[3] ?? 1] : a;
    };
    const mix = (a, b) => a.slice(0,3).map((v,i) => v * (a[3] ?? 1) + b[i] * (1 - (a[3] ?? 1)));
    const luminance = a => a.map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((s,v,i) => s+v*[.2126,.7152,.0722][i],0);
    const parents = [];
    for (let n=node;n;n=n.parentElement) parents.unshift(n);
    const bg = parents.reduce((a,n) => mix(rgb(getComputedStyle(n).backgroundColor),a),[255,255,255]);
    const fg = mix(rgb(getComputedStyle(node).color),bg);
    const a=luminance(fg),b=luminance(bg);
    return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  assert(ratio >= 4.5, `${await locator.textContent()}: contrast ${ratio.toFixed(2)}`);
}

(async () => {
  const browser = await browserType.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
    const errors=[];
    page.on('pageerror', error => errors.push(error.message));
    const subjects = ['【待反馈】2026年中秋及国庆假期加班申报确认，请在本周六下班前反馈部门人员安排', '项目周报与下周安排', '转发：关于开展集团职工健康检测的通知'];
    const emails = Array.from({length:18}, (_,i) => ({id:9000+i,subject:subjects[i%3],
      status:i%3===1?'sent':'inbox',direction:i%3===1?'sent':'received',
      from_name:i%3===1?'我':'项目同事',from_addr:'colleague@example.test',
      date:'2026-10-08T08:43:00',snippet:'请各项目经理确认部门安排，并在下班前回复。感谢配合。',
      score:i===2?85:0,verdict:i===2?'phishing':'clean'}));
    await page.route('**/api/mail/contacts/correspondence?*', route => route.fulfill({contentType:'application/json',
      body:JSON.stringify({counterpart:'colleague@example.test',emails})}));
    await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(() => openContactCorrespondence({email:'colleague@example.test',name:'项目同事'}));
    const drawer=page.locator('#correspondence-drawer');
    const first=drawer.locator('.correspondence-item').first();
    const selectAll=drawer.locator('[data-correspondence-select-all]');
    const remove=drawer.locator('[data-correspondence-delete]');
    assert.equal(await first.locator('strong').getAttribute('title'),subjects[0]);
    assert.equal(await drawer.locator('.correspondence-risk-normal').first().isVisible(),false);
    assert.equal(await drawer.locator('.security-danger').isVisible(),true,'risk warnings stay visible');
    assert.equal(await remove.isEnabled(),false);
    await first.locator('.correspondence-check').click();
    assert.equal(await first.locator('input').isChecked(),true);
    assert(await first.evaluate(n=>n.classList.contains('selected')));
    assert.equal(await drawer.locator('#correspondence-selected-count').textContent(),'已选 1 / 18 封');
    assert.equal(await remove.isEnabled(),true);
    await selectAll.click();
    assert.equal(await selectAll.getAttribute('aria-pressed'),'true');
    assert.equal(await drawer.locator('input:checked').count(),18);
    await selectAll.click();
    assert.equal(await remove.isEnabled(),false);
    assert.equal(await selectAll.getAttribute('aria-pressed'),'false');
    for (const theme of ['dark','light']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await first.hover();
      for (const selector of ['strong','.correspondence-meta small','.correspondence-meta time','.correspondence-copy>p','.correspondence-direction']) await contrast(first.locator(selector));
      await selectAll.hover(); await contrast(selectAll);
      await first.locator('.correspondence-check').click();
      await remove.hover(); await contrast(remove);
      await first.locator('.correspondence-check').click();
      await page.keyboard.press('Tab');
      await first.locator('.correspondence-open').focus();
      assert.equal(await first.locator('.correspondence-open').evaluate(n=>getComputedStyle(n).outlineStyle),'solid');
      await drawer.locator('.correspondence-body').evaluate(n=>n.scrollTop=400);
      assert(await selectAll.evaluate(n=>{const r=n.getBoundingClientRect();const h=document.querySelector('.correspondence-header').getBoundingClientRect();return r.top>=h.bottom && r.bottom<innerHeight;}),'selection toolbar stays accessible while scrolling');
      await drawer.locator('.correspondence-body').evaluate(n=>n.scrollTop=0);
    }
    for (const width of [1440,560,390,320]) for (const scale of [1,1.25,1.5]) {
      await page.setViewportSize({width,height:960});
      await page.evaluate(scale=>{document.body.style.zoom=String(scale);document.documentElement.style.setProperty('--fz',String(scale));},scale);
      assert(await drawer.locator('.correspondence-panel').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=-1 && r.right<=innerWidth+1;}),`drawer fits ${width}, scale ${scale}`);
      assert(await drawer.locator('.correspondence-body').evaluate(n=>n.scrollWidth<=n.clientWidth+1),`no horizontal overflow at ${width}, scale ${scale}`);
      for (const item of [selectAll,remove]) assert(await item.evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=-1 && r.right<=innerWidth+1;}),'toolbar buttons fit');
    }
    await page.setViewportSize({width:1440,height:960});
    await page.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');document.documentElement.dataset.theme='dark';});
    await page.evaluate(()=>document.activeElement?.blur());
    await page.mouse.move(0,0);
    if (process.env.MAILAI_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.MAILAI_SCREENSHOT_DIR,{recursive:true});
      await drawer.locator('.correspondence-panel').screenshot({path:`${process.env.MAILAI_SCREENSHOT_DIR}/correspondence-dark.png`});
    }
    await page.keyboard.press('Escape');
    assert.equal(await drawer.isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log('Correspondence layout, selection, theme contrast, sticky controls and font scaling passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
