/* 验收：各界面字号档位下的溢出检查 + 截图 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8799/';
const OUT = '/tmp/mailai-fontcheck';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') console.log('JS-ERR:', m.text().slice(0, 200)); });
  page.on('pageerror', e => console.log('PAGE-ERR:', String(e).slice(0, 300)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // 等界面就绪（邮箱列表或空态）
  await page.screenshot({ path: `${OUT}/0-boot.png` });

  const scales = [['0.92', 'small'], ['1', 'standard'], ['1.12', 'large'], ['1.25', 'xlarge']];
  const report = [];

  for (const [scale, name] of scales) {
    await page.evaluate(v => { localStorage.setItem('mailai-font-scale', v); document.body.style.zoom = v; }, scale);
    await page.waitForTimeout(600);

    // 1) 页面级横向溢出
    const pageOverflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      bodyScrollW: document.body.scrollWidth,
    }));

    // 2) 元素级：任何可见元素的右/左边缘越出视口
    const offenders = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const bad = [];
      const all = document.querySelectorAll('body *');
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        if (r.bottom < -50 || r.top > innerHeight + 50) continue; // 屏外纵向不管
        if (r.right > vw + 2 || r.left < -2) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? '#' + el.id : '';
          const cls = typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').slice(0, 2).join('.') : '';
          bad.push(`${tag}${id}${cls} right=${Math.round(r.right)} left=${Math.round(r.left)} vw=${vw}`);
        }
      }
      return bad.slice(0, 15);
    });

    // 3) 关键容器内部横向滚动
    const containerScroll = await page.evaluate(() => {
      const ids = ['email-list', 'reading-pane', 'sidebar', 'app'];
      const out = [];
      for (const sel of ['.topbar', '.list-pane', '.reading-pane', '.sidebar', '#email-list', '.global-actions']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        if (el.scrollWidth > el.clientWidth + 2 && !['auto', 'scroll'].includes(getComputedStyle(el).overflowX)) {
          out.push(`${sel} scrollW=${el.scrollWidth} clientW=${el.clientWidth}`);
        }
      }
      return out;
    });

    report.push({ name, scale, pageOverflow, offenders, containerScroll });
    await page.screenshot({ path: `${OUT}/main-${name}.png` });
  }

  // 设置页（偏好卡片 + 字号选项）在最大档下的表现
  await page.evaluate(() => { document.body.style.zoom = '1.25'; });
  await page.evaluate(() => document.getElementById('btn-preferences')?.click());
  await page.waitForTimeout(1200);
  const settingsOverflow = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [];
    document.querySelectorAll('#system-view *, .system-view *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (getComputedStyle(el).display === 'none') return;
      if (r.right > vw + 2 || r.left < -2) {
        const id = el.id ? '#' + el.id : '';
        const cls = typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').slice(0, 2).join('.') : '';
        bad.push(`${el.tagName.toLowerCase()}${id}${cls} right=${Math.round(r.right)}`);
      }
    });
    return bad.slice(0, 12);
  });
  await page.screenshot({ path: `${OUT}/settings-xlarge.png` });
  report.push({ name: 'settings-xlarge', settingsOverflow });

  // 窄窗口 + 最大字号（顶栏挤压风险最高）
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(600);
  const narrow = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [];
    document.querySelectorAll('.topbar *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (r.right > vw + 2) bad.push(`${el.tagName.toLowerCase()}#${el.id || ''} right=${Math.round(r.right)} vw=${vw}`);
    });
    return { vw, bad: bad.slice(0, 10), topbarScroll: (t => t ? `${t.scrollWidth}>${t.clientWidth}` : 'none')(document.querySelector('.topbar')) };
  });
  await page.screenshot({ path: `${OUT}/narrow-xlarge.png` });
  report.push({ name: 'narrow-1100-xlarge', narrow });

  console.log(JSON.stringify(report, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
