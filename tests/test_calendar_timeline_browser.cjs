// End-to-end UI & layout verification for local calendar timeline + batch ICS export + mocked macOS Calendar sync.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium, webkit } = require('playwright');

const port = Number(process.env.MAILAI_TIMELINE_FIXTURE_PORT || 18858);
const base = `http://127.0.0.1:${port}`;
const pythonBin = process.env.MAILAI_FIXTURE_PYTHON || 'venv-mac/bin/python';
const shotDir = process.env.MAILAI_TIMELINE_SHOT_DIR || '';

const fixture = spawn(pythonBin, ['tests/workspace_preview.py'], {
  env: { ...process.env, MAILAI_FIXTURE_PORT: String(port), MAILAI_PROGRESS_FIXTURE: '1' },
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
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.route('**/api/productivity/calendar/system-calendars', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ supported: true, calendars: ['工作', '个人'], note: '' }),
      });
    });
    let sysAddPayload = null;
    await page.route('**/api/productivity/calendar/system-add', async route => {
      sysAddPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          calendar: sysAddPayload.calendar_name || '工作',
          created: (sysAddPayload.items || []).length,
          skipped: 0,
        }),
      });
    });

    await page.goto(base);
    await page.locator('#app-preloader').waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    // 1. Open from Todo Center -> 更多 -> 日程时间线
    await page.click('#btn-todos');
    await page.waitForSelector('#todo-center:not(.hidden)');
    await page.click('#todo-options summary');
    await page.click('#btn-todo-open-timeline');
    await page.waitForSelector('#calendar-timeline-modal:not(.hidden)');
    await page.waitForSelector('#timeline-summary-strip .timeline-metric');

    // Wait for mocked system calendars dropdown to populate
    await page.waitForFunction(() => {
      const sel = document.querySelector('#timeline-system-calendar');
      return sel && !sel.disabled && sel.options.length >= 2;
    });

    // 2. Close and re-open via command palette (#btn-command-palette)
    await page.click('#btn-close-timeline');
    await page.waitForSelector('#calendar-timeline-modal', { state: 'hidden' });
    await page.click('#btn-command-palette');
    await page.waitForSelector('#productivity-command-query');
    await page.fill('#productivity-command-query', '日程时间线');
    await page.waitForFunction(() => (document.querySelector('#productivity-commands')?.textContent || '').includes('日程时间线'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('#calendar-timeline-modal:not(.hidden)');

    // 3. Create two overlapping custom events tomorrow to trigger conflict badge
    const tomorrow = new Date(Date.now() + 86400000);
    const pad = n => String(n).padStart(2, '0');
    const tDate = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;

    await page.click('#timeline-toggle-create');
    await page.waitForSelector('#timeline-create-form:not(.hidden)');
    await page.fill('#timeline-create-title', '项目季度评审会');
    await page.fill('#timeline-create-start', `${tDate}T14:00`);
    await page.fill('#timeline-create-end', `${tDate}T15:00`);
    await page.fill('#timeline-create-location', 'A302 会议室');
    await page.click('#timeline-create-submit');
    await page.waitForFunction(() => document.querySelector('#timeline-list')?.textContent.includes('项目季度评审会'));

    await page.click('#timeline-toggle-create');
    await page.fill('#timeline-create-title', '技术架构对齐会');
    await page.fill('#timeline-create-start', `${tDate}T14:30`);
    await page.fill('#timeline-create-end', `${tDate}T15:30`);
    await page.click('#timeline-create-submit');
    await page.waitForFunction(() => {
      const text = document.querySelector('#timeline-list')?.textContent || '';
      return text.includes('技术架构对齐会') && text.includes('时段冲突');
    });

    // Ensure no horizontal modal overflow
    const overflow = await page.evaluate(() => {
      const dlg = document.querySelector('#calendar-timeline-modal .timeline-dialog');
      return dlg ? dlg.scrollWidth - dlg.clientWidth : 0;
    });
    assert(overflow <= 2, `Expected no horizontal overflow, got ${overflow}px`);

    if (shotDir) {
      await page.screenshot({ path: `${shotDir}/calendar-timeline.png` });
    }

    // 4. Filter by custom events
    await page.click('[data-timeline-kind="custom"]');
    await page.waitForFunction(() => {
      const badges = [...document.querySelectorAll('#timeline-list .timeline-item .timeline-badge')];
      return badges.length > 0 && badges.some(b => b.classList.contains('kind-custom')) &&
        !badges.some(b => b.classList.contains('kind-todo'));
    });

    // 5. Select all visible and export batch .ics
    await page.click('#timeline-select-all');
    const downloadPromise = page.waitForEvent('download');
    await page.click('#timeline-btn-export-batch');
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'schedule.ics');

    // 6. Test mocked macOS system calendar write
    await page.selectOption('#timeline-system-calendar', '工作');
    await page.click('#timeline-btn-system-add');
    await page.waitForFunction(() => !document.querySelector('#timeline-btn-system-add')?.disabled);
    assert(sysAddPayload && sysAddPayload.calendar_name === '工作' && (sysAddPayload.items || []).length >= 2);

    // 7. Complete a todo inline when showing all items
    await page.click('[data-timeline-kind="all"]');
    const firstCompleteBtn = page.locator('#timeline-list [data-action="complete-todo"]').first();
    if (await firstCompleteBtn.count()) {
      const prevCount = await page.locator('#timeline-list [data-action="complete-todo"]').count();
      await firstCompleteBtn.click();
      await page.waitForFunction(
        expected => document.querySelectorAll('#timeline-list [data-action="complete-todo"]').length < expected,
        prevCount
      );
    }

    // 8. Delete custom events we created
    for (const title of ['项目季度评审会', '技术架构对齐会']) {
      const item = page.locator('#timeline-list .timeline-item', { hasText: title }).first();
      await item.locator('[data-action="delete-custom"]').click();
      await page.waitForFunction(
        t => !(document.querySelector('#timeline-list')?.textContent || '').includes(t),
        title
      );
    }

    assert.deepEqual(errors, []);
    console.log(`PASS test_calendar_timeline_browser (${process.env.MAILAI_BROWSER || 'chromium'})`);
  } finally {
    await browser.close();
  }
})()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => { fixture.kill(); });
