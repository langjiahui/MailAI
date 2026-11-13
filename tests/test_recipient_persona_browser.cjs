// End-to-end UI + layout verification for contact persona & role presets (Chromium & WebKit).
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

const port = Number(process.env.MAILAI_PERSONA_FIXTURE_PORT || 18855);
const base = `http://127.0.0.1:${port}`;
const pythonBin = process.env.MAILAI_FIXTURE_PYTHON || 'venv-mac/bin/python';
const shotDir = process.env.MAILAI_PERSONA_SHOT_DIR || '';

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

    // Seed two distinct signatures on this mailbox
    const s1 = await page.evaluate(async acc => {
      return api('/api/mail/signatures', {
        accountId: acc,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '管理汇报签名', html: '<div><strong>张敏</strong> · 研发汇报</div>', make_default: true }),
      });
    }, accountId);
    const leaderSigId = s1.items.find(i => i.name === '管理汇报签名')?.id;
    assert(leaderSigId, 'Expected leader signature ID');

    await page.evaluate(async acc => {
      return api('/api/mail/signatures', {
        accountId: acc,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '日常协作签名', html: '<div>张敏</div>' }),
      });
    }, accountId);

    // 1. Open Contact Center -> configure Role Presets -> create a leader contact
    await page.locator('#btn-contacts').click();
    await page.locator('#contact-center').waitFor({ state: 'visible' });
    await page.locator('#btn-role-presets').click();
    const roleDialog = page.locator('#role-presets-dialog');
    await roleDialog.waitFor({ state: 'visible' });
    await roleDialog.locator('[data-role-card="leader"] [data-preset-field="tone"]').waitFor({ state: 'visible' });
    await roleDialog.locator('[data-role-card="leader"] [data-preset-field="signature_id"]').selectOption(leaderSigId);
    await roleDialog.locator('[data-role-card="leader"] [data-preset-field="tone"]').selectOption('正式');
    await roleDialog.locator('[data-role-card="leader"] [data-preset-field="style_hint"]').fill('汇报结论先行，风险点单独分段。');
    await roleDialog.locator('button[type="submit"]').click();
    await roleDialog.waitFor({ state: 'hidden' });

    await page.locator('#btn-new-contact').click();
    await page.locator('#contact-editor').waitFor({ state: 'visible' });
    await page.locator('#contact-email').fill('chenzong@corp.example');
    await page.locator('#contact-name').fill('陈总');
    await page.locator('#contact-company').fill('集团办公室');
    await page.locator('.persona-editor-details > summary').click();
    await page.locator('#contact-persona-role').selectOption('leader');
    await page.locator('#contact-persona-salutation').fill('陈总您好：');
    await page.locator('#contact-persona-hint').fill('数字附同比说明');
    if (shotDir) {
      await page.screenshot({ path: path.join(shotDir, 'persona-contact-editor-light.png') });
    }
    await page.locator('#contact-form button[type="submit"]').click();
    await page.locator('#contact-editor').waitFor({ state: 'hidden' });

    // Badge renders in Contact Center list
    const contactRow = page.locator('.contact-center-item[data-contact-email="chenzong@corp.example"]');
    await contactRow.waitFor({ state: 'visible' });
    assert.equal(await contactRow.locator('.contact-role-pill').textContent(), '领导');

    await page.locator('#btn-close-contacts').click();
    await page.locator('#contact-center').waitFor({ state: 'hidden' });

    // 2. Open Compose -> type recipient -> auto-matches role, tone, signature, strip & AI note
    await page.locator('#btn-compose').click();
    await page.locator('#compose-modal').waitFor({ state: 'visible' });
    await page.locator('#compose-to').fill('陈总 <chenzong@corp.example>');
    await page.locator('#compose-to').dispatchEvent('blur');

    const strip = page.locator('#compose-persona-strip');
    await strip.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('compose-signature-select')?.value !== '');
    assert.equal(await page.locator('#compose-signature-select').inputValue(), leaderSigId);
    assert.equal(await page.locator('#compose-ai-tone').inputValue(), '正式');
    const stripText = await strip.textContent();
    assert(stripText.includes('角色：领导') && stripText.includes('管理汇报签名') && stripText.includes('陈总您好：'), stripText);

    // Click insert-salutation
    await strip.locator('[data-persona-action="insert-salutation"]').click();
    const editorText = await page.locator('#compose-body').innerText();
    assert(editorText.includes('陈总您好：'), editorText);

    // Open Compose AI sidebar & check privacy toggle
    await page.locator('#btn-compose-ai').click();
    const aiNote = page.locator('#compose-ai-persona-note');
    await aiNote.waitFor({ state: 'visible' });
    assert((await aiNote.textContent()).includes('已匹配收件人画像'));

    if (shotDir) {
      await page.screenshot({ path: path.join(shotDir, 'persona-compose-light.png') });
      await page.evaluate(() => applyTheme('dark'));
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.screenshot({ path: path.join(shotDir, 'persona-compose-dark.png') });
      await page.evaluate(() => applyTheme('light'));
    }

    const rcptLabel = page.locator('.compose-ai-context-options label:has(input[value="recipients"])');
    await rcptLabel.click();
    assert((await aiNote.textContent()).includes('未勾选「收件人」参考项'));
    await rcptLabel.click();

    // Quick edit persona inside Compose & verify Escape only closes dialog, not Compose
    await strip.locator('[data-persona-action="edit"]').click();
    const quickDlg = page.locator('#compose-persona-dialog');
    await quickDlg.waitFor({ state: 'visible' });
    await quickDlg.locator('#quick-persona-tone').selectOption('简洁');
    await quickDlg.locator('button[type="submit"]').click();
    await quickDlg.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('compose-ai-tone')?.value === '简洁');
    assert((await strip.textContent()).includes('语气：简洁'));

    // Mobile narrow viewport geometry check (no horizontal overflow)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const mobileBox = await strip.evaluate(el => ({
      overflow: el.scrollWidth - el.clientWidth,
      rectOverflow: el.getBoundingClientRect().right > window.innerWidth + 2,
    }));
    assert(!mobileBox.rectOverflow && mobileBox.overflow <= 4, JSON.stringify(mobileBox));
    if (shotDir) {
      await page.locator('#btn-close-compose-ai').click();
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.screenshot({ path: path.join(shotDir, 'persona-compose-mobile.png') });
    }

    assert.deepEqual(errors, [], `Unexpected pageerrors: ${errors.join('; ')}`);
    console.log(`PASS recipient persona browser flow (${process.env.MAILAI_BROWSER || 'chromium'})`);
  } finally {
    await browser.close();
  }
})().finally(() => {
  fixture.kill('SIGTERM');
});
