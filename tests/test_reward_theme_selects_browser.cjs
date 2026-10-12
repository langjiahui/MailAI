/* Exercise the real CSS cascade and palette bridge without mailbox services. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit} = require('playwright');
const staticDir = path.resolve(__dirname, '../app/web/static');
const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
const links = html.match(/<link[^>]+rel="stylesheet"[^>]*>/g).join('\n');
const fixture = `<!doctype html><html data-theme="light"><head><meta charset="utf-8">${links}</head><body>
  <dialog open class="productivity-dialog">
    <header><h2>高级搜索</h2></header><div class="productivity-body">
      <div class="productivity-grid">
        <label>邮件范围<select id="mailbox"><option value="all">全部正常邮件（含发件、草稿）</option><option value="inbox">收件箱</option></select></label>
        <label>处理状态<select id="state"><option>不限</option><option>待回复</option></select></label>
      </div>
      <div class="productivity-actions"><select id="productivity-saved-search"><option>已保存的搜索…</option></select></div>
      <div class="compose-format-tools"><select id="format"><option>标准</option></select></div>
      <select id="disabled" disabled><option>不可用</option></select>
      <select id="multiple" multiple><option>第一项</option><option>第二项</option></select>
    </div>
  </dialog><script src="/static/reward-theme-bridge.js"></script>
</body></html>`;

(async () => {
  for (const [engine, browserType] of Object.entries({chromium, webkit})) {
    const browser = await browserType.launch({headless: true});
    try {
      const page = await browser.newPage({viewport: {width: 1100, height: 850}});
      await page.emulateMedia({reducedMotion: 'reduce'});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('http://selects.test/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') return route.fulfill({contentType: 'text/html', body: fixture});
        const name = path.basename(pathname);
        if (/\.(css|js)$/.test(name)) return route.fulfill({
          contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript',
          body: fs.readFileSync(path.join(staticDir, name), 'utf8'),
        });
        return route.fulfill({status: 404, body: ''});
      });
      await page.goto('http://selects.test/');
      for (const theme of ['', 'theme_monochrome', 'theme_baowu', '']) {
        for (const mode of ['light', 'dark']) {
          await page.evaluate(({theme, mode}) => {
            document.documentElement.dataset.theme = mode;
            if (theme) document.documentElement.dataset.rewardTheme = theme;
            else delete document.documentElement.dataset.rewardTheme;
          }, {theme, mode});
          for (const state of ['normal', 'hover', 'focus']) {
            if (state === 'normal') await page.locator('h2').click();
            if (state === 'hover') await page.locator('#mailbox').hover();
            if (state === 'focus') await page.locator('#mailbox').focus();
            for (const id of ['mailbox', 'state', 'productivity-saved-search', 'format', 'disabled']) {
              const style = await page.locator(`#${id}`).evaluate(node => {
                const css = getComputedStyle(node);
                const root = getComputedStyle(document.documentElement);
                const color = name => {
                  const probe = document.createElement('span');
                  probe.style.color = root.getPropertyValue(`--reward-${name}`);
                  document.body.append(probe);
                  const result = getComputedStyle(probe).color;
                  probe.remove(); return result;
                };
                return {image: css.backgroundImage, repeat: css.backgroundRepeat,
                  position: css.backgroundPosition, size: css.backgroundSize, padding: css.paddingRight,
                  background: css.backgroundColor, color: css.color,
                  expectedColor: color('ink'), expectedBackgrounds: [color('surface'), color('soft')]};
              });
              const context = `${engine}/${theme || 'default'}/${mode}/${state}/${id}`;
              assert.match(style.image, /data:image\/svg\+xml/, `${context}: arrow must remain visible`);
              assert.equal(style.repeat, 'no-repeat', `${context}: arrow must not tile`);
              assert.equal(style.size, id === 'format' ? '11px 11px' : '14px 14px', context);
              assert.equal(style.position, id === 'format' ? 'calc(100% - 6px) 50%' : 'calc(100% - 10px) 50%', context);
              assert(parseFloat(style.padding) >= (id === 'format' ? 22 : 32), `${context}: text must leave room for arrow`);
              if (theme) {
                assert.equal(style.color, style.expectedColor, `${context}: theme text color`);
                assert(style.expectedBackgrounds.includes(style.background), `${context}: theme field background ${style.background}`);
              }
            }
          }
          assert.equal(await page.locator('#multiple').evaluate(n => getComputedStyle(n).backgroundImage), 'none');
        }
      }
      await page.locator('#mailbox').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'state', `${engine}: keyboard focus order`);
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'light';
        document.documentElement.dataset.rewardTheme = 'theme_baowu';
      });
      await page.screenshot({path: `/tmp/mailai-selects-${engine}.png`});
      await page.setViewportSize({width: 390, height: 844});
      assert(await page.locator('.productivity-dialog').evaluate(n => n.scrollWidth <= n.clientWidth + 1), `${engine}: narrow dialog must not overflow`);
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine}: default/redeemed themes, light/dark, hover/focus, compact/disabled/multiple controls, keyboard focus and narrow dialog`);
    } finally { await browser.close(); }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
