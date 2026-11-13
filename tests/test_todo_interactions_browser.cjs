// End-to-end UI & layout test for standalone todo quick-add, Cmd+K entry, snooze popover, and recurring completion.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium, webkit } = require('playwright');

const port = Number(process.env.MAILAI_TODO_INTERACTION_PORT || 18865);
const base = `http://127.0.0.1:${port}`;
const pythonBin = process.env.MAILAI_FIXTURE_PYTHON || 'venv-mac/bin/python';
const shotDir = process.env.MAILAI_TODO_SHOT_DIR || '';

const fixture = spawn(pythonBin, ['tests/workspace_preview.py'], {
  env: { ...process.env, MAILAI_FIXTURE_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
fixture.stdout.on('data', chunk => { log += chunk; });
fixture.stderr.on('data', chunk => { log += chunk; });

(async () => {
  let ready = false;
  for (let n = 0; n < 150; n++) {
    if (fixture.exitCode !== null) throw new Error(log);
    try { ready = (await fetch(base + '/api/health')).ok; } catch (_) {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log);

  const engine = process.env.MAILAI_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(base);
    await page.locator('#app-preloader').waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    // 1. Cmd+K entry opens Todo Center and focuses #todo-quick-title
    await page.click('#btn-command-palette');
    await page.waitForSelector('#productivity-command-query');
    await page.fill('#productivity-command-query', '快速新建待办');
    await page.click('[data-command-id="todo-quick-add"]');
    await page.waitForSelector('#todo-center:not(.hidden)');
    await page.waitForFunction(() => document.activeElement?.id === 'todo-quick-title');

    // 2. Quick-create a weekly standalone todo with deadline
    const today = await page.evaluate(() => localDateKey());
    await page.fill('#todo-quick-title', '提交每周项目进度周报');
    await page.fill('#todo-quick-deadline', today);
    await page.selectOption('#todo-quick-recurrence', 'weekly');
    await page.click('#todo-quick-submit');

    // Newly created task appears with recurrence chip and manual source label (not a broken mail button)
    await page.waitForFunction(() => [...document.querySelectorAll('#todo-list .todo-title-input')].some(el => el.value === '提交每周项目进度周报'));
    const createdCard = page.locator('#todo-list .todo-center-item', { has: page.locator('.todo-recurrence-chip') }).first();
    assert.match(await createdCard.locator('.todo-recurrence-chip').textContent(), /每周重复/);
    assert.equal(await createdCard.locator('.todo-source-manual').count(), 1);
    assert.equal(await createdCard.locator('[data-todo-email]').count(), 0);

    // 3. Quick snooze (+3 天) shifts deadline without horizontal overflow
    await createdCard.locator('.todo-snooze-menu > summary').click();
    await createdCard.locator('[data-snooze-preset="plus_3d"]').click();
    const expectedPlus3 = await page.evaluate(() => {
      const d = new Date(); d.setDate(d.getDate() + 3);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    await page.waitForFunction((expected) => {
      return [...document.querySelectorAll('#todo-list .todo-center-item')].some(card =>
        card.querySelector('.todo-title-input')?.value === '提交每周项目进度周报'
        && card.querySelector('input[type="date"]')?.value === expected
      );
    }, expectedPlus3);

    // 4. Completing the weekly recurring todo archives done row and spawns next-week open row
    await createdCard.locator('.todo-complete-action').click();
    const expectedNextWeek = await page.evaluate((baseIso) => {
      const d = new Date(baseIso + 'T00:00:00'); d.setDate(d.getDate() + 7);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }, expectedPlus3);
    await page.waitForFunction((expected) => {
      return [...document.querySelectorAll('#todo-list .todo-center-item')].some(card =>
        !card.classList.contains('done')
        && card.querySelector('.todo-title-input')?.value === '提交每周项目进度周报'
        && card.querySelector('input[type="date"]')?.value === expected
      );
    }, expectedNextWeek);

    // Verify zero horizontal overflow in both desktop and narrow 390px viewports
    const desktopOverflow = await page.evaluate(() => {
      const card = document.querySelector('#todo-center .todo-center-card');
      const list = document.getElementById('todo-list');
      return Math.max(card.scrollWidth - card.clientWidth, list.scrollWidth - list.clientWidth);
    });
    assert(desktopOverflow <= 1, `Unexpected horizontal overflow on desktop: ${desktopOverflow}`);

    if (shotDir) {
      await page.screenshot({ path: `${shotDir}/todo-interactions-light.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await page.screenshot({ path: `${shotDir}/todo-interactions-dark.png` });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOverflow = await page.evaluate(() => {
      const card = document.querySelector('#todo-center .todo-center-card');
      return card.scrollWidth - card.clientWidth;
    });
    assert(mobileOverflow <= 2, `Unexpected horizontal overflow at 390px: ${mobileOverflow}`);

    if (shotDir) {
      await page.screenshot({ path: `${shotDir}/todo-interactions-mobile.png` });
    }

    assert.deepEqual(errors, []);
    console.log(`PASS (${process.env.MAILAI_BROWSER || 'chromium'}): Cmd+K manual todo creation, weekly recurrence badge & next-cycle spawn, +3d snooze, zero overflow desktop/mobile`);
  } finally {
    await browser.close();
    fixture.kill('SIGTERM');
  }
})();
