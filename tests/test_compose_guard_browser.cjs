// End-to-end UI & layout verification for inline compose pre-send highlights + hover tooltips.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium, webkit } = require('playwright');

const port = Number(process.env.MAILAI_GUARD_FIXTURE_PORT || 18862);
const base = `http://127.0.0.1:${port}`;
const pythonBin = process.env.MAILAI_FIXTURE_PYTHON || 'venv-mac/bin/python';
const shotDir = process.env.MAILAI_GUARD_SHOT_DIR || '';

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

    // 1. Open compose dialog and check self-audit button visibility (no banner box in DOM)
    await page.click('#btn-compose');
    await page.waitForSelector('#compose-modal:not(.hidden)');
    await page.waitForSelector('#btn-compose-guard');
    assert.equal(await page.locator('#compose-guard-banner').count(), 0);

    // 2. Run self-audit with bad weekday, unfilled placeholder, and synthetic token
    const secretToken = 'sk-' + 'proj-' + ['Sample', 'Token', '99887766'].join('');
    await page.fill('#compose-subject', '【待补充】会议安排');
    await page.fill('#compose-message', `定于2026年11月14日（周三）核对，测试令牌 ${secretToken}`);
    await page.click('#btn-compose-guard');

    // Overlay marks rendered in #compose-guard-layer without mutating #compose-message HTML
    await page.waitForFunction(() => document.querySelectorAll('#compose-guard-layer .compose-guard-mark').length >= 2);
    const bodyHtml = await page.locator('#compose-message').innerHTML();
    assert(!bodyHtml.includes('compose-guard-mark'), 'Highlights must not pollute editable message HTML');
    const subjectHighlighted = await page.locator('#compose-subject.compose-guard-field-high').count();
    assert.equal(subjectHighlighted, 1);

    // Badge on guard button shows issue count
    const badgeCount = await page.locator('#btn-compose-guard .compose-guard-count').textContent();
    assert(Number(badgeCount) >= 3, `Expected >= 3 highlighted issues, got ${badgeCount}`);

    // Hover over first inline body mark -> mark pulses (.is-active), sibling dims (.has-active), tooltip opens without exposing raw token
    const markBox = await page.locator('#compose-guard-layer .compose-guard-mark').first().boundingBox();
    assert(markBox, 'Expected bounding box on inline mark');
    await page.mouse.move(markBox.x + markBox.width / 2, markBox.y + markBox.height / 2);
    await page.waitForSelector('#compose-guard-tooltip:not(.hidden)');
    await page.waitForSelector('#compose-guard-layer.has-active .compose-guard-mark.is-active');
    const tipText = await page.locator('#compose-guard-tooltip').innerText();
    assert(tipText.length > 5 && !tipText.includes(secretToken), tipText);

    if (shotDir) {
      await page.screenshot({ path: `${shotDir}/compose-guard-inline.png` });
    }

    // Hover over guard button -> interactive summary menu lets hovering each row spotlight ONLY its corresponding spot
    const guardBtnBox = await page.locator('#btn-compose-guard').boundingBox();
    await page.mouse.move(guardBtnBox.x + guardBtnBox.width / 2, guardBtnBox.y + guardBtnBox.height / 2);
    await page.waitForSelector('#compose-guard-tooltip.is-interactive:not(.hidden)');
    const subjRow = page.locator('#compose-guard-tooltip .compose-guard-tip-row', { hasText: '占位符' }).first();
    const subjRowBox = await subjRow.boundingBox();
    assert(subjRowBox, 'Expected placeholder row inside guard button tooltip');
    await page.mouse.move(subjRowBox.x + subjRowBox.width / 2, subjRowBox.y + subjRowBox.height / 2);
    await page.waitForSelector('#compose-subject.compose-guard-field-active');

    // Hover over highlighted subject directly shows tooltip + pulses subject field
    const subjBox = await page.locator('#compose-subject').boundingBox();
    await page.mouse.move(subjBox.x + 20, subjBox.y + subjBox.height / 2);
    await page.waitForSelector('#compose-guard-tooltip:not(.hidden)');
    const subjTip = await page.locator('#compose-guard-tooltip').innerText();
    assert(subjTip.includes('占位符'), subjTip);

    // 3. Editing subject automatically clears inline marks & tooltip
    await page.fill('#compose-subject', '项目周度排期确认');
    await page.waitForFunction(() => document.querySelectorAll('#compose-guard-layer .compose-guard-mark').length === 0);
    await page.waitForSelector('#compose-guard-tooltip', { state: 'hidden' });

    // 4. Non-blocking behavior: date/placeholder checks NEVER block send when clicked
    await page.fill('#compose-to', 'colleague@example.test');
    await page.fill('#compose-message', '您好，2026年11月14日（周三）核对，请查收 {{姓名}}。');
    let outboxRequested = false;
    await page.route('**/api/mail/outbox', async route => {
      outboxRequested = true;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 99, status: 'queued' }) });
    });
    const outboxResp = page.waitForResponse('**/api/mail/outbox');
    await page.click('#btn-send-mail');
    await outboxResp;
    assert.equal(outboxRequested, true);
    assert.equal(await page.locator('#compose-preflight.hidden').count(), 1, 'Self-audit checks must not block send');

    assert.deepEqual(errors, []);
    console.log(`PASS test_compose_guard_browser (${process.env.MAILAI_BROWSER || 'chromium'})`);
  } finally {
    await browser.close();
  }
})().then(
  () => { fixture.kill(); process.exit(0); },
  err => { console.error(err); fixture.kill(); process.exit(1); }
);
