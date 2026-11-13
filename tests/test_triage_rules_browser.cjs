// End-to-end UI & layout verification for subscription cleanup & auto-triage rules center.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium, webkit } = require('playwright');

const port = Number(process.env.MAILAI_TRIAGE_FIXTURE_PORT || 18860);
const base = `http://127.0.0.1:${port}`;
const pythonBin = process.env.MAILAI_FIXTURE_PYTHON || 'venv-mac/bin/python';
const shotDir = process.env.MAILAI_TRIAGE_SHOT_DIR || '';

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

    // 1. Open from Todo Center -> 更多 -> 订阅降噪 & 自动分流
    await page.click('#btn-todos');
    await page.waitForSelector('#todo-center:not(.hidden)');
    await page.click('#todo-options summary');
    await page.click('#btn-todo-open-triage');
    await page.waitForSelector('#triage-rules-modal:not(.hidden)');
    await page.waitForSelector('#triage-subs-list .triage-card');
    await page.waitForFunction(() => document.querySelectorAll('#triage-subs-summary .triage-metric').length === 4);

    // 2. Close and re-open via command palette
    await page.click('#btn-close-triage');
    await page.waitForSelector('#triage-rules-modal', { state: 'hidden' });
    await page.click('#btn-command-palette');
    await page.waitForSelector('#productivity-command-query');
    await page.fill('#productivity-command-query', '订阅降噪');
    await page.waitForFunction(() => (document.querySelector('#productivity-commands')?.textContent || '').includes('订阅降噪'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('#triage-rules-modal:not(.hidden)');
    await page.waitForSelector('#triage-subs-list .triage-card');

    if (shotDir) {
      await page.screenshot({ path: `${shotDir}/triage-subs.png` });
    }

    // 3. Batch clean keeping latest
    const keepLatestBtn = page.locator('#triage-subs-list [data-sub-action="keep_latest_done"]').first();
    await keepLatestBtn.click();
    await page.waitForFunction(() => {
      const btn = document.querySelector('#triage-subs-list [data-sub-action="all_done"]');
      return btn && !btn.disabled;
    });

    // 4. Click "设为自动规则" -> opens pre-filled editor in rules tab
    await page.locator('#triage-subs-list [data-sub-rule]').first().click();
    await page.waitForSelector('#triage-pane-rules:not(.hidden)');
    await page.waitForSelector('#triage-rule-editor:not(.hidden)');
    await page.fill('#triage-rule-name', '培训与周报自动归档');

    // Add second condition (subject contains 部门培训通知)
    await page.click('#triage-btn-add-cond');
    const condRows = page.locator('#triage-cond-list .triage-cond-row');
    assert.equal(await condRows.count(), 2);
    await condRows.nth(1).locator('.triage-cond-field').selectOption('subject');
    await condRows.nth(1).locator('.triage-cond-op').selectOption('contains');
    await condRows.nth(1).locator('.triage-cond-val').fill('部门培训通知');

    // Preview matches
    await page.click('#triage-btn-preview-rule');
    await page.waitForSelector('#triage-rule-preview:not(.hidden)');
    await page.waitForFunction(() => (document.querySelector('#triage-rule-preview')?.textContent || '').includes('命中'));

    // Save rule
    await page.click('#triage-btn-save-rule');
    await page.waitForSelector('#triage-rule-editor', { state: 'hidden' });
    await page.waitForFunction(() => (document.querySelector('#triage-rules-list')?.textContent || '').includes('培训与周报自动归档'));

    // 5. Run all rules & verify hit count updates
    await page.click('#triage-btn-apply-all');
    await page.waitForFunction(() => {
      const text = document.querySelector('#triage-rules-list')?.textContent || '';
      return text.includes('已命中') && !text.includes('已命中 0 次');
    });

    const overflow = await page.evaluate(() => {
      const dlg = document.querySelector('#triage-rules-modal .triage-dialog');
      return dlg ? dlg.scrollWidth - dlg.clientWidth : 0;
    });
    assert(overflow <= 2, `Expected no horizontal overflow, got ${overflow}px`);

    if (shotDir) {
      await page.screenshot({ path: `${shotDir}/triage-rules.png` });
    }

    // 6. Toggle off then delete
    await page.locator('#triage-rules-list [data-rule-action="toggle"]').first().click();
    await page.waitForFunction(() => (document.querySelector('#triage-rules-list')?.textContent || '').includes('已停用'));

    await page.locator('#triage-rules-list [data-rule-action="delete"]').first().click();
    await page.waitForFunction(() => !(document.querySelector('#triage-rules-list')?.textContent || '').includes('培训与周报自动归档'));

    assert.deepEqual(errors, []);
    console.log(`PASS test_triage_rules_browser (${process.env.MAILAI_BROWSER || 'chromium'})`);
  } finally {
    await browser.close();
  }
})()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => { fixture.kill(); });
