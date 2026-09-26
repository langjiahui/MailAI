// Run only against tests/workspace_preview.py; no real mailbox or AI calls.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({reducedMotion:'no-preference'});
    await page.goto(process.env.MAILAI_PREVIEW_URL || 'http://127.0.0.1:18795');
    await page.locator('.email-item').first().waitFor();
    await page.evaluate(() => openCompose());
    const subject = '项目交付安排与后续事项确认';
    const body = '您好，项目组：\n\n请确认交付时间。👨‍👩‍👧‍👦 <文件> & 材料\n'.repeat(25);
    await page.evaluate(({subject, body}) => {
      renderComposeSignature('', '原有签名');
      composeAiSuggestion = {subject, body, signoff:'不要重复的签名'};
      applyComposeAiSuggestion('subject');
    }, {subject, body});
    await page.waitForFunction(full => {
      const value = document.getElementById('compose-subject').value;
      return value.length > 0 && value.length < full.length;
    }, subject);
    await page.waitForFunction(() => !composeAiTyping);
    assert.equal(await page.locator('#compose-subject').inputValue(), subject);
    await page.evaluate(() => applyComposeAiSuggestion('replace'));
    await page.waitForFunction(full => {
      const value = composeMessageText(); return value.length > 0 && value.length < full.trim().length;
    }, body);
    await page.waitForFunction(() => !composeAiTyping);
    assert.equal((await page.locator('#compose-message').innerText()).trim(), body.trim());
    assert.equal(await page.locator('#compose-message img').count(), 0);
    assert.equal(await page.locator('#compose-signature-content').innerText(), '原有签名');
    await page.evaluate(() => undoComposeAiEdit());
    assert.equal((await page.locator('#compose-message').innerText()).trim(), '');

    // Saving mid-animation receives the whole body, never the visible prefix.
    const saved = await page.evaluate(() => {
      applyComposeAiSuggestion('replace'); return draftPayload();
    });
    assert.ok(saved.body_html.includes('👨‍👩‍👧‍👦 &lt;文件&gt; &amp; 材料'));
    assert.equal((await page.locator('#compose-message').innerText()).trim(), body.trim());
    await page.evaluate(() => undoComposeAiEdit());

    // Typing interrupts the effect before the user's edit is made.
    await page.evaluate(() => applyComposeAiSuggestion('subject'));
    await page.locator('#compose-subject').press('End');
    await page.locator('#compose-subject').pressSequentially('补充');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#compose-subject').inputValue(), subject + '补充');

    // Append preserves existing rich content; immediate undo restores it exactly.
    await page.evaluate(() => {
      composeMessageElement().innerHTML = '<b>原有内容</b>';
      applyComposeAiSuggestion('append'); finishComposeAiTyping();
    });
    assert.equal(await page.locator('#compose-message b').innerText(), '原有内容');
    await page.evaluate(() => undoComposeAiEdit());
    assert.equal(await page.locator('#compose-message').innerHTML(), '<b>原有内容</b>');
    await page.evaluate(() => {
      applyComposeAiSuggestion('replace');
      composeMessageElement().innerHTML = '<p>手动更改</p>';
      finishComposeAiTyping();
    });
    assert.equal(await page.locator('#compose-message').innerText(), '手动更改');

    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.evaluate(() => {
      applyComposeAiSuggestion('subject'); return composeAiTyping === null;
    }), true);
    assert.equal(await page.locator('#compose-subject').inputValue(), subject);
    console.log('AI typing: progressive writing, complete saves, manual edits, signature and undo passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
