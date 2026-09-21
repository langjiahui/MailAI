const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async () => {
  const root = path.join(__dirname, '../app/web/static');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const hidePreloaderSource = appSource.slice(
    appSource.indexOf('function hideAppPreloader('),
    appSource.indexOf('// ===== 三栏宽度拖拽与本地记忆 ====='),
  );
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const browser = await chromium.launch({...(process.env.CI ? {} : {channel:'chrome'}), headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}, recordVideo:{dir:path.resolve(__dirname,'../build/startup-video'),size:{width:1440,height:900}}});
    await page.route('http://mailai.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: html});
      const file = path.join(root, url.pathname.replace('/static/', ''));
      return fs.existsSync(file) ? route.fulfill({path: file}) : route.abort();
    });
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.goto('http://mailai.test/');
    await page.addScriptTag({path: path.join(root, 'companion.js')});
    await page.addScriptTag({content: hidePreloaderSource});

    const preloader = page.locator('#app-preloader');
    const mascot = page.locator('.preloader-companion .mail-companion');
    assert(await preloader.isVisible(), 'preloader should be visible before initial data resolves');
    assert.equal(await mascot.count(), 1, 'startup should reuse the XiaoYou vector rig');
    assert.equal(await page.locator('.preloader-route-line path').count(), 1,
      'the mail route must be a single continuous curve');
    assert.equal(await page.locator('.preloader-route-line path').evaluate(el => getComputedStyle(el).vectorEffect), 'non-scaling-stroke',
      'route stroke weight must survive responsive resizing');
    const checkRouteCards = async () => {
      const track = await page.locator('.preloader-route').boundingBox();
      for (const card of await page.locator('.preloader-mail').all()) {
        const box = await card.boundingBox();
        assert(box.y >= track.y && box.y + box.height <= track.y + track.height,
          'mail cards must not be clipped by the route');
      }
    };
    await checkRouteCards();
    const checkFrames = async () => {
      // Zoom and responsive layout updates cross rendering frames; wait for
      // actual geometry instead of assuming a CI machine settles in 60 ms.
      await page.waitForFunction(() => [...document.querySelectorAll('[data-startup-pane]')].every(frame => {
        if (frame.hidden) return true;
        const pane = document.querySelector(`.layout > .${frame.dataset.startupPane}`);
        if (!pane) return true;
        const a = frame.getBoundingClientRect(), b = pane.getBoundingClientRect();
        return ['x','y','width','height'].every(key => Math.abs(a[key]-b[key]) < 2);
      }), null, {timeout:3000});
      for (const name of ['sidebar', 'list-pane', 'reading-pane']) {
        const frame = await page.locator(`[data-startup-pane="${name}"]`).boundingBox();
        const pane = await page.locator(`.layout > .${name}`).boundingBox();
        if (!frame || !pane) continue;
        for (const key of ['x', 'y', 'width', 'height']) {
          assert(Math.abs(frame[key]-pane[key]) < 2, `startup ${name} ${key} must match the live layout`);
        }
      }
    };
    assert.equal(await page.locator('.preloader-frame:visible').count(), 3,
      'desktop startup should show the three workspace silhouettes');
    await checkFrames();
    assert(await page.locator('.preloader-companion').evaluate(el => el.classList.contains('introducing')),
      'XiaoYou should begin with an entrance and greeting, not a walking loop');
    assert.equal(await mascot.locator('.companion-wave').evaluate(el => getComputedStyle(el).animationName), 'startup-welcome');
    await page.waitForTimeout(700);
    await page.screenshot({path:path.resolve(__dirname,'../build/preloader-welcome.png')});
    await page.waitForTimeout(1200);
    const poses = [];
    for (let i=0;i<3;i++) {
      poses.push(await mascot.locator('.companion-torso').evaluate(el=>getComputedStyle(el).transform));
      await page.waitForTimeout(90);
    }
    assert(new Set(poses).size>1, 'walking should start after the welcome finishes');
    assert.equal((await page.locator('.preloader-status span').textContent()).trim(), '正在初始化邮件工作台');
    assert((await page.locator('.preloader-brand').boundingBox()).width < 150, 'brand signature must stay compact');
    assert.match(appSource, /app\.preloaderLoading.*正在载入邮箱数据/s,
      'connected startup should report mailbox-data initialization');
    assert.match(appSource, /app\.preloaderConnect.*正在准备邮箱连接/s,
      'first-run startup should not claim that mail is already loading');

    const themes = {};
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      themes[theme] = await page.evaluate(() => ({
        backdrop: getComputedStyle(document.querySelector('.app-preloader'), '::before').backgroundImage,
        status: getComputedStyle(document.querySelector('.preloader-status span')).color,
        mail: getComputedStyle(document.querySelector('.preloader-mail')).backgroundColor,
      }));
      await page.screenshot({path: path.resolve(__dirname, `../build/preloader-${theme}.png`)});
    }
    assert.notDeepEqual(themes.light, themes.dark, 'light and dark launch themes must be visually distinct');

    await page.setViewportSize({width: 390, height: 844});
    await page.waitForTimeout(550);
    await checkFrames();
    await checkRouteCards();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await page.screenshot({path: path.resolve(__dirname, `../build/preloader-mobile-${theme}.png`)});
    }
    for (const selector of ['.preloader-brand', '.preloader-status', '.preloader-companion']) {
      const box = await page.locator(selector).boundingBox();
      assert(box.x >= 0 && box.x + box.width <= 390, `${selector} should fit the narrow launch viewport`);
      assert(box.y >= 0 && box.y + box.height <= 844, `${selector} should fit the narrow launch viewport`);
    }
    await page.setViewportSize({width: 1440, height: 900});

    const before = await page.locator('.preloader-companion').boundingBox();
    const target = await page.locator('#assistant-orb .companion-art').boundingBox();
    await page.evaluate(() => hideAppPreloader());
    await page.waitForTimeout(900);
    assert(await page.locator('.preloader-workspace').evaluate(el => Number(getComputedStyle(el).opacity) < .5),
      'workspace silhouettes should dissolve as the real panes emerge');
    const middle = await page.locator('.preloader-companion').boundingBox();
    assert(middle.x > before.x && middle.x < target.x,
      'the hand-off should interpolate through an in-between position');
    assert(middle.width < before.width && middle.width > target.width,
      'the hand-off should scale continuously instead of jumping at the end');
    const walkingParts = await page.locator('.preloader-companion').evaluate(el =>
      el.getAnimations({subtree:true}).map(animation => animation.effect?.target?.getAttribute?.('class') || ''));
    assert(walkingParts.some(value => value.includes('companion-foot-left')),
      'the hand-off should include a walking foot cycle');
    assert(walkingParts.some(value => value.includes('companion-bag')),
      'the envelope bag should follow through during the walk');
    // Inspect exact terminal keyframes while the overlay is still alive.
    // A wall-clock sample 55 ms before removal races on shared CI runners.
    await page.locator('.preloader-companion').evaluate(el => el.getAnimations().forEach(animation => animation.finish()));
    const after = await page.locator('.preloader-companion').boundingBox();
    assert(after.x > before.x + 300, 'XiaoYou should move horizontally toward the persistent launcher');
    assert(Math.abs(after.x - target.x) < 2 && Math.abs(after.y - target.y) < 2,
      'XiaoYou should finish at the persistent launcher’s exact rectangle');
    assert(Math.abs(after.width - target.width) < 2 && Math.abs(after.height - target.height) < 2,
      'XiaoYou should smoothly adopt the persistent launcher’s exact scale');
    const brandOpacity = await page.locator('.topbar .brand').evaluate(el => {
      el.getAnimations().forEach(animation => animation.finish());
      return Number(getComputedStyle(el).opacity);
    });
    assert(brandOpacity > .95, 'the startup brand should cross-fade into the real topbar brand');
    await preloader.waitFor({state:'detached'});

    // CSS zoom changes visual coordinates; verify the logo's actual pieces,
    // not just the opacity of its parent, before the cross-fade completes.
    await page.reload();
    await page.addScriptTag({path: path.join(root, 'companion.js')});
    await page.addScriptTag({content: hidePreloaderSource});
    await page.evaluate(() => {
      document.body.style.zoom = '1.2';
      document.documentElement.style.setProperty('--fz', '1.2');
    });
    await page.waitForTimeout(60);
    await checkFrames();
    await page.evaluate(() => {
      hideAppPreloader();
      hideAppPreloader(); // repeated readiness signals must be harmless
    });
    await page.waitForTimeout(200);
    assert(!await preloader.evaluate(el => el.classList.contains('leaving')),
      'fast initialization must not interrupt the birth or welcome');
    await page.waitForFunction(() => document.getElementById('app-preloader')?.dataset.handoff === 'running');
    await page.waitForTimeout(1150);
    for (const selector of ['img', 'strong', 'small']) {
      const from = await page.locator(`.preloader-brand ${selector}`).boundingBox();
      const to = await page.locator(`.topbar .brand ${selector}`).boundingBox();
      if (!from || !to) continue;
      for (const key of ['x', 'y', 'width', 'height']) {
        assert(Math.abs(from[key]-to[key]) < 2, `zoomed brand ${selector} ${key} should align exactly`);
      }
    }
    await page.waitForTimeout(800);
    assert.equal(await preloader.count(), 0, 'handoff should remove its overlay and animation effects');

    await page.reload();
    await page.addScriptTag({path: path.join(root, 'companion.js')});
    await page.emulateMedia({reducedMotion: 'reduce'});
    assert.equal(await page.locator('.preloader-mail-one').evaluate(el => getComputedStyle(el).animationName), 'none');
    assert(!await page.locator('.preloader-companion').evaluate(el => el.getAnimations({subtree:true}).some(animation => {
      const target = animation.effect?.target;
      return target?.closest?.('.companion-figure');
    })), 'startup XiaoYou must not inherit ambient bobbing or acting clips');
    await page.addScriptTag({content:hidePreloaderSource});
    await page.evaluate(() => hideAppPreloader());
    await page.waitForTimeout(260);
    assert.equal(await preloader.count(), 0, 'reduced motion must skip the welcome hold');
    console.log('preloader theme, horizontal hand-off and reduced-motion checks passed');
    const video = page.video();
    await page.close();
    await video.saveAs(path.resolve(__dirname,'../build/startup-walk-review.webm'));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
