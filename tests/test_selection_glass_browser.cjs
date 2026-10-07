const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium,webkit} = require('playwright');

(async () => {
  const root = path.join(__dirname, '../app/web/static');
  const browser = await (process.env.MAILAI_SELECTION_WEBKIT === '1' ? webkit : chromium).launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:960,height:700}});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.setContent(`<html data-theme="light"><body>
      <div class="layout" style="display:flex;height:600px">
        <aside class="sidebar" style="position:relative;width:240px;overflow:auto;padding:12px">
          <section id="primary-folder-group"><nav id="folder-nav">
            <button class="nav-item active" data-filter="status" data-value="inbox">收件箱</button>
            <button class="nav-item" data-filter="status" data-value="sent">已发送</button>
          </nav></section>
        </aside>
        <div class="list-pane"><div id="email-list" style="position:relative;width:400px;height:430px;overflow:auto">
          <div class="email-item selected" data-id="1" data-account-id="a">第一封</div>
          <div class="email-item" data-id="2" data-account-id="a">第二封</div>
        </div></div>
      </div></body></html>`);
    await page.addStyleTag({content:`
      * {box-sizing:border-box} body {margin:0;background:#edf2ee}
      .nav-item,.email-item {display:block;width:100%;height:54px;margin:0 0 8px;padding:12px;border:0;border-radius:9px;background:transparent}
      .email-item {height:105px;margin:0 6px 8px;width:388px}
    `});
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'selection-glass.css'),'utf8')});
    await page.addScriptTag({path:path.join(root,'selection-glass.js')});
    await page.waitForFunction(() => document.querySelectorAll('.selection-glass-plate').length === 2);
    async function aligned(plate, selected) {
      const boxes = await Promise.all([page.locator(plate).boundingBox(),page.locator(selected).boundingBox()]);
      assert(boxes.every(Boolean));
      for (const key of ['x','y','width','height']) assert(Math.abs(boxes[0][key]-boxes[1][key]) < 1.5, `${plate} ${key}`);
    }
    await aligned('.sidebar .selection-glass-plate','.sidebar .nav-item.active');
    await aligned('#email-list .selection-glass-plate','#email-list .email-item.selected');

    await page.evaluate(() => {
      document.querySelector('.sidebar .nav-item.active').classList.remove('active');
      document.querySelectorAll('.sidebar .nav-item')[1].classList.add('active');
      document.querySelector('#email-list .email-item.selected').classList.remove('selected');
      document.querySelectorAll('#email-list .email-item')[1].classList.add('selected');
    });
    await page.waitForFunction(() => document.querySelector('#email-list .selection-glass-plate').getAnimations().length > 0);
    const stretch = await page.evaluate(() => {
      const plate = document.querySelector('#email-list .selection-glass-plate');
      const animation = plate.getAnimations()[0];
      animation.pause();
      animation.effect.updateTiming({easing:'linear'});
      animation.currentTime = animation.effect.getTiming().duration * .56;
      const ratio = plate.getBoundingClientRect().height /
        document.querySelector('#email-list .email-item.selected').getBoundingClientRect().height;
      animation.play();
      return ratio;
    });
    assert(stretch > 1.05, 'the moving plate should stretch in its travel direction');
    await page.locator('#email-list .email-item.selected').evaluate(node => node.classList.add('unread'));
    await page.waitForTimeout(55);
    assert.equal(await page.locator('#email-list .selection-glass-plate').evaluate(node => node.getAnimations().length),
      1, 'unrelated row updates must not cancel the slide');
    await page.waitForTimeout(360);
    await aligned('.sidebar .selection-glass-plate','.sidebar .nav-item.active');
    await aligned('#email-list .selection-glass-plate','#email-list .email-item.selected');
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        const rows = document.querySelectorAll('#email-list .email-item');
        rows.forEach(row => row.classList.toggle('selected'));
      });
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(300);
    await aligned('#email-list .selection-glass-plate','#email-list .email-item.selected');
    assert.equal(await page.locator('#email-list .selection-glass-plate').count(),1);
    if (process.env.MAILAI_SELECTION_SCREENSHOT) {
      await page.screenshot({path:process.env.MAILAI_SELECTION_SCREENSHOT});
    }
    const visual = await page.locator('#email-list .email-item.selected').evaluate(node => getComputedStyle(node).backgroundColor);
    assert.equal(visual, 'rgba(0, 0, 0, 0)', 'selected content must stay clear above the plate');
    const lightFill = await page.locator('#email-list .selection-glass-plate').evaluate(node => getComputedStyle(node).backgroundImage);
    await page.locator('html').evaluate(node => { node.dataset.theme = 'dark'; });
    const darkFill = await page.locator('#email-list .selection-glass-plate').evaluate(node => getComputedStyle(node).backgroundImage);
    assert.notEqual(lightFill,darkFill,'the glass material should adapt to dark mode');

    await page.evaluate(() => {
      document.getElementById('email-list').innerHTML = '<div class="email-item selected" data-id="3" data-account-id="a">新列表</div>';
    });
    await page.waitForFunction(() => document.querySelector('#email-list .selection-glass-plate'));
    await aligned('#email-list .selection-glass-plate','#email-list .email-item.selected');

    await page.evaluate(() => { document.body.style.zoom = '1.25'; });
    await page.waitForTimeout(50);
    await aligned('.sidebar .selection-glass-plate','.sidebar .nav-item.active');
    await aligned('#email-list .selection-glass-plate','#email-list .email-item.selected');
    await page.evaluate(() => { document.body.style.zoom = ''; });

    await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar');
      sidebar.style.height = '95px';
      for (let i = 0; i < 8; i++) {
        const button = document.createElement('button');
        button.className = 'nav-item';
        button.dataset.filter = 'status';
        button.dataset.value = `folder-${i}`;
        button.textContent = `文件夹 ${i}`;
        document.getElementById('folder-nav').append(button);
      }
      sidebar.querySelector('.nav-item.active').classList.remove('active');
      const last = sidebar.querySelector('.nav-item:last-child');
      last.classList.add('active');
      last.scrollIntoView({block:'end'});
    });
    await page.waitForTimeout(40);
    await aligned('.sidebar .selection-glass-plate','.sidebar .nav-item.active');

    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(() => {
      document.querySelector('.sidebar .nav-item.active').classList.remove('active');
      document.querySelector('.sidebar .nav-item').classList.add('active');
      document.querySelector('.sidebar .nav-item.active').scrollIntoView({block:'start'});
    });
    await page.waitForTimeout(40);
    assert.equal(await page.locator('.sidebar .selection-glass-plate').evaluate(node => node.getAnimations().length),0);
    await aligned('.sidebar .selection-glass-plate','.sidebar .nav-item.active');
    console.log('Glass selection alignment, slide, rerender and reduced motion passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
