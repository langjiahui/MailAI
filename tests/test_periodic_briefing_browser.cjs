// End-to-end UI + layout verification for periodic work briefing (weekly / monthly report) across Chromium & WebKit.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium, webkit } = require('playwright');

const port = Number(process.env.MAILAI_BRIEFING_FIXTURE_PORT || 18856);
const base = `http://127.0.0.1:${port}`;
const pythonBin = process.env.MAILAI_FIXTURE_PYTHON || 'venv-mac/bin/python';
const shotDir = process.env.MAILAI_BRIEFING_SHOT_DIR || '';

const fixture = spawn(pythonBin, ['tests/workspace_preview.py'], {
  env: { ...process.env, MAILAI_FIXTURE_PORT: String(port), MAILAI_PROGRESS_FIXTURE: '1', MAILAI_MEMORY_FIXTURE: '1' },
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

    const accountId = await page.evaluate(() => activeMailAccount()?.id || '');
    assert(accountId, 'Active mailbox account required');

    // 1. Open from Todo Center -> 更多 -> 生成工作简报
    await page.click('#btn-todos');
    await page.waitForSelector('#todo-center:not(.hidden)');
    await page.click('#todo-options summary');
    await page.click('#btn-todo-open-briefing');
    await page.waitForSelector('#digest-modal:not(.hidden)');
    await page.waitForSelector('#periodic-briefing-pane:not(.hidden)');

    // 2. Verify live metrics strip renders 4 cards
    await page.waitForFunction(() => document.querySelectorAll('#periodic-metrics-strip .periodic-metric-card').length === 4);

    // 3. Switch period to last_30_days and check custom date toggle
    await page.selectOption('#periodic-period-select', 'custom');
    await page.waitForSelector('#periodic-custom-range:not(.hidden)');
    await page.selectOption('#periodic-period-select', 'last_30_days');
    await page.waitForSelector('#periodic-custom-range', { state: 'hidden' });
    await page.selectOption('#periodic-style-select', 'leader');
    await page.fill('#periodic-focus-input', '本周核心进展与验收风险');

    // 4. Generate via Quick Local Summary -> inspect rendered Markdown & email source drawer
    await page.click('#periodic-btn-local');
    await page.waitForFunction(() => document.querySelector('#periodic-briefing-preview')?.textContent.includes('本周核心进展与验收风险'));
    await page.waitForFunction(() => Number(document.querySelector('#periodic-history-select')?.value || 0) > 0);
    if (shotDir) {
      await page.screenshot({ path: `${shotDir}/periodic-briefing-preview.png` });
    }

    // Click source email link inside rendered briefing if present
    const firstSourceLink = page.locator('#periodic-briefing-preview .digest-email-link').first();
    if (await firstSourceLink.count()) {
      await firstSourceLink.click();
      await page.waitForSelector('#digest-email-drawer:not(.hidden)');
      await page.locator('#digest-email-drawer .drawer-close, #digest-email-drawer [data-close-drawer]').first().click().catch(async () => {
        await page.evaluate(() => typeof closeDigestEmailDrawer === 'function' && closeDigestEmailDrawer());
      });
      await page.waitForSelector('#digest-email-drawer', { state: 'hidden' });
    }

    // 5. Switch to Edit Draft -> edit (including Markdown table) -> preview -> save -> verify history persists
    await page.click('#periodic-btn-edit');
    await page.waitForSelector('#periodic-briefing-editor:not(.hidden)');
    const editedTitle = '【工作月报】手动精修归档版';
    await page.fill('#periodic-title-input', editedTitle);
    const updatedMd = (await page.inputValue('#periodic-briefing-editor')) +
      '\n\n| 日期 | 主题 | 要点 |\n|---|---|---|\n| 11-13 | 联调测试 | 完成表格渲染与自测 [email_id:1] |\n\n- 补充：已完成内部自测验收。';
    await page.fill('#periodic-briefing-editor', updatedMd);
    await page.click('#periodic-btn-view');
    await page.waitForSelector('#periodic-briefing-preview table thead th');
    const tableCellCount = await page.locator('#periodic-briefing-preview table tbody td').count();
    assert.equal(tableCellCount, 3, 'Markdown table rows should render into HTML table cells');
    await page.click('#periodic-btn-save');
    await page.waitForFunction(title => {
      const opt = [...document.querySelectorAll('#periodic-history-select option')].find(o => o.selected);
      return opt && opt.textContent.includes(title);
    }, editedTitle);

    // 6. Send as Email opens Compose modal with cleaned content (no [email_id:...])
    await page.click('#periodic-btn-compose');
    await page.waitForSelector('#compose-modal:not(.hidden)');
    assert.equal(await page.inputValue('#compose-subject'), editedTitle);
    const composeText = await page.evaluate(() => document.getElementById('compose-message').innerText);
    assert(composeText.includes('已完成内部自测验收'), 'Compose body should include edited briefing content');
    assert(!composeText.includes('[email_id:'), 'Exported compose email must strip internal [email_id:] markers');
    await page.click('#btn-close-compose');
    await page.waitForSelector('#compose-modal', { state: 'hidden' });

    // 7. Open via Cmd+K / Command Palette, verify daily digest tab still switches cleanly, and delete saved history
    await page.click('#btn-command-palette');
    await page.waitForSelector('#productivity-command-query');
    await page.fill('#productivity-command-query', '周期工作简报');
    await page.waitForFunction(() => document.body.innerText.includes('周期工作简报（周报 / 月报）'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('#digest-modal:not(.hidden)');
    await page.waitForSelector('#periodic-briefing-pane:not(.hidden)');

    // Reload saved briefing & delete it
    const savedId = await page.evaluate(() => {
      const opt = [...document.querySelectorAll('#periodic-history-select option')].find(o => o.value);
      return opt ? opt.value : '';
    });
    assert(savedId, 'Expected saved periodic briefing ID in history select');
    await page.selectOption('#periodic-history-select', savedId);
    await page.waitForFunction(title => document.getElementById('periodic-title-input')?.value === title, editedTitle);
    await page.click('#periodic-delete-history');
    await page.waitForFunction(id => ![...document.querySelectorAll('#periodic-history-select option')].some(o => o.value === id), savedId);

    // Switch back to 今日日报 tab and confirm daily digest UI still renders cleanly
    await page.click('[data-briefing-tab="daily"]');
    await page.waitForSelector('#periodic-briefing-pane', { state: 'hidden' });
    await page.waitForSelector('#digest-body:not(.hidden)');

    assert.deepEqual(errors, [], `Unexpected pageerror(s): ${errors.join('; ')}`);
    console.log(`PASS test_periodic_briefing_browser (${process.env.MAILAI_BROWSER || 'chromium'})`);
  } finally {
    await browser.close();
    fixture.kill('SIGTERM');
  }
})().catch(err => {
  console.error(err);
  fixture.kill('SIGTERM');
  process.exit(1);
});
