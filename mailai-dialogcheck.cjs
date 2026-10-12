/* 验收②：特大字号下各弹框/面板的可视范围与按钮可点性 */
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = '/tmp/mailai-fontcheck';
fs.mkdirSync(OUT, { recursive: true });

const TARGETS = [
  ['compose', '.compose-modal'],
  ['digest', '#digest-modal'],
  ['contacts', '#contact-center'],
  ['todos', '#todo-center'],
  ['attachments', '#attachment-center'],
  ['assistant', '.assistant-panel'],
  ['task-center', '#task-center'],
  ['security-popover', '.top-menu-popover'],
  ['digest-drawer', '#digest-email-drawer'],
];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:8799/', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('mailai-font-scale'));
  await page.waitForTimeout(2000);

  for (const zoom of ['1.25', '1']) {
    await page.evaluate(z => { document.body.style.zoom = z; document.documentElement.style.setProperty('--fz', z); }, zoom);
    await page.waitForTimeout(300);
    for (const [name, sel] of TARGETS) {
      const vscroll = await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
      await page.evaluate(({ sel }) => { const el = document.querySelector(sel); el?.classList.remove('hidden'); if (el) el.style.display=''; }, { sel });
      await page.waitForTimeout(450);
      const result = await page.evaluate(({ sel }) => {
        const el = document.querySelector(sel);
        if (!el) return { name: sel, missing: true };
        const wasHidden = true;
        const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
        const r = el.getBoundingClientRect();
        const frame = {
          overflow: r.left < -2 || r.top < -2 || r.right > vw + 2 || r.bottom > vh + 2,
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
          vw, vh,
        };
        // 交互元素：在视口内 + 命中测试可点
        const badClick = [];
        el.querySelectorAll('button, select, input, a[href], [role="button"]').forEach(btn => {
          const br = btn.getBoundingClientRect();
          if (!br.width || !br.height) return;
          if (getComputedStyle(btn).visibility === 'hidden') return;
          const cx = Math.min(Math.max(br.left + br.width / 2, 1), vw - 1);
          const cy = Math.min(Math.max(br.top + br.height / 2, 1), vh - 1);
          const outOfView = br.right < 0 || br.bottom < 0 || br.left > vw || br.top > vh;
          const hit = document.elementFromPoint(cx, cy);
          const clickable = hit && (hit === btn || btn.contains(hit) || hit.closest('button,select,input,a,[role="button"]') === btn);
          if (outOfView || !clickable) {
            const label = (btn.textContent || btn.getAttribute('aria-label') || btn.id || btn.className || '').trim().slice(0, 24);
            badClick.push(`${btn.tagName}[${label}] out=${outOfView} hit=${hit ? (hit.id || hit.className || hit.tagName) : 'none'}`);
          }
        });
        if (wasHidden) el.classList.add('hidden');
        return { frame, badClick: badClick.filter(b => b.includes('out=true')).slice(0, 8), clickCount: el.querySelectorAll('button,select,input,a[href]').length };
      }, { sel });
      if (result.missing) { console.log(`${zoom} ${name}: MISSING`); continue; }
      const flag = result.frame.overflow || result.badClick.length ? 'PROBLEM' : 'ok';
      console.log(`${zoom} ${name}: ${flag} rect=${result.frame.rect.join(',')} vw=${result.frame.vw} vh=${result.frame.vh} buttons=${result.clickCount} vscroll=${vscroll}`);
      if (result.frame.overflow) console.log(`   frame overflows viewport!`);
      result.badClick.forEach(b => console.log(`   bad-click: ${b}`));
      if (zoom === '1.25') {
        await page.evaluate(sel => { const el = document.querySelector(sel); el?.classList.remove('hidden'); if (el) el.style.display = ''; }, sel);
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${OUT}/dlg-${name}.png` });
        await page.evaluate(sel => { document.querySelector(sel)?.classList.add('hidden'); }, sel);
      }
    }
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
