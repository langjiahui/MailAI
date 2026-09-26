// Run against tests/workspace_preview.py, never a live mailbox.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.CI ? {} : {channel:'chrome'})});
  try {
    const page = await browser.newPage();
    await page.goto(process.env.MAILAI_PREVIEW_URL || 'http://127.0.0.1:18795');
    await page.locator('.email-item').first().waitFor();
    await page.evaluate(() => openCompose());
    await page.evaluate(() => toggleComposeAiPanel(true));
    const emptyContext = await page.locator('.compose-ai-context-options label.unavailable').evaluateAll(labels =>
      labels.map(label => ({native: getComputedStyle(label.querySelector('input')).display,
        marker: getComputedStyle(label.querySelector('span'), '::before').content})));
    assert.ok(emptyContext.length > 0);
    assert.ok(emptyContext.every(item => item.native === 'none' && item.marker === 'none'));
    const requests = [];
    await page.route('**/api/mail/compose/assist-stream', route => route.fulfill({status:404, body:'{}'}));
    await page.route('**/api/mail/compose/assist', route => {
      requests.push(route.request().postDataJSON());
      if (requests.at(-1).operation === 'translate_zh')
        return route.fulfill({status:400, contentType:'application/json', body:JSON.stringify({detail:'不支持的 AI 写信操作'})});
      const response = requests.length === 1
        ? {content:'主题：项目材料\n\n请查收项目材料。\n\n此致\n敬礼', basis:['写作要求']}
        : requests.length === 2
          ? {content:'请查收项目材料。', subject:'项目材料', signoff:'此致\n敬礼', basis:['写作要求']}
          : {content:'感谢您的邮件。我们想确认价格。\n\n此致\n敬礼', basis:['已有正文']};
      return route.fulfill({contentType:'application/json', body:JSON.stringify(response)});
    });
    await page.locator('#compose-ai-instruction').fill('写一封材料邮件');
    await page.evaluate(() => aiCompose('draft', document.getElementById('btn-ai-generate')));
    assert.equal(requests.at(-1).has_signature, false);
    assert.equal(await page.locator('[data-ai-fill=subject]').isVisible(), true);
    await page.locator('[data-ai-fill=subject]').click();
    assert.equal(await page.locator('#compose-subject').inputValue(), '项目材料');
    assert.equal((await page.locator('#compose-message').innerText()).trim(), '');
    assert.equal((await page.locator('#compose-signature-content').innerText()).trim(), '');
    await page.locator('#btn-ai-replace').click();
    assert.equal(await page.locator('#compose-subject').inputValue(), '项目材料');
    assert.equal((await page.locator('#compose-message').innerText()).trim(), '请查收项目材料。');
    assert.match(await page.locator('#compose-signature-content').innerText(), /此致/);
    assert.equal(await page.locator('#compose-signature-select option').first().innerText(), 'AI 落款');
    await page.evaluate(() => {
      signatureState.items = [{id:'manual', name:'工作签名', html:'正式签名'}];
      renderComposeSignature('manual');
    });
    await page.evaluate(() => aiCompose('draft', document.getElementById('btn-ai-generate')));
    assert.equal(requests.at(-1).has_signature, true);
    await page.locator('#compose-subject').fill('用户原有主题');
    await page.locator('#btn-ai-replace').click();
    assert.equal(await page.locator('#compose-subject').inputValue(), '用户原有主题');
    assert.equal(await page.locator('#compose-signature-content').innerText(), '正式签名');
    assert.doesNotMatch(await page.locator('#compose-message').innerText(), /此致/);
    const placeholder = await page.evaluate(() => normalizeComposeAiSuggestion({
      content:'主题：【待确认：邮件主题】\n\n尊敬的收件人：\n您好！\n\n此致\n敬礼\nXX（发件人姓名）'
    }, true, false));
    assert.equal(placeholder.subject, '【待确认：邮件主题】');
    assert.equal(placeholder.body, '尊敬的收件人：\n您好！');
    assert.equal(placeholder.signoff, '');
    await page.locator('#compose-message').fill('Dear team, thank you for your email. Could you confirm the pricing details?');
    assert.equal(await page.locator('[data-ai-compose="translate_zh"]').innerText(), '译为中文');
    assert.equal(await page.locator('[data-ai-compose="translate_en"]').innerText(), '译为英文');
    await page.locator('[data-ai-compose="translate_zh"]').click();
    await page.waitForFunction(() => document.getElementById('compose-ai-output').innerText.includes('感谢您的邮件'));
    assert.equal(requests.at(-2).operation, 'translate_zh');
    assert.equal(requests.at(-1).operation, 'polish');
    assert.equal(requests.at(-1).has_signature, true);
    assert.match(requests.at(-1).user_instruction, /不要生成落款或签名/);
    await page.locator('#btn-ai-replace').click();
    assert.equal(await page.locator('#compose-subject').inputValue(), '用户原有主题');
    assert.equal(await page.locator('#compose-signature-content').innerText(), '正式签名');
    assert.equal((await page.locator('#compose-message').innerText()).trim(), '感谢您的邮件。我们想确认价格。');
    assert.equal(await page.locator('[data-ai-compose="translate_zh"]').innerText(), '译为中文');
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      window.fetch = (url, options) => {
        if (!String(url).includes('/api/mail/compose/assist-stream')) return originalFetch(url, options);
        const encoder = new TextEncoder();
        return Promise.resolve(new Response(new ReadableStream({start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({type:'delta', content:'主题：流式通知\n\n正在生成'}) + '\n'));
          window.__finishComposeStream = () => {
            controller.enqueue(encoder.encode(JSON.stringify({type:'delta', content:'完整正文。'}) + '\n'));
            controller.enqueue(encoder.encode(JSON.stringify({type:'done', subject:'流式通知', content:'正在生成完整正文。', signoff:'', basis:['写作要求']}) + '\n'));
            controller.close();
          };
        }}), {status:200, headers:{'Content-Type':'application/x-ndjson'}}));
      };
      window.__composeStreamTask = aiCompose('draft', document.getElementById('btn-ai-generate'))
        .finally(() => { window.fetch = originalFetch; });
    });
    await page.waitForFunction(() => document.getElementById('compose-ai-output').innerText.includes('正在生成'));
    assert.equal(await page.locator('#btn-ai-replace').isDisabled(), true);
    assert.equal(await page.locator('[data-ai-fill=subject]').isDisabled(), true);
    await page.evaluate(async () => { window.__finishComposeStream(); await window.__composeStreamTask; });
    assert.equal(await page.locator('#btn-ai-replace').isEnabled(), true);
    assert.equal(await page.locator('[data-ai-fill=subject]').isEnabled(), true);
    assert.match(await page.locator('#compose-ai-output').innerText(), /正在生成完整正文/);
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      window.fetch = (url, options) => {
        if (!String(url).includes('/api/mail/compose/assist-stream')) return originalFetch(url, options);
        const encoder = new TextEncoder();
        return Promise.resolve(new Response(new ReadableStream({start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({type:'delta', content:'主题：第二轮\n\n第二轮片段'}) + '\n'));
          window.__finishRegenerate = () => {
            const body = '第二轮片段\n\n' + '较长的正文。\n\n'.repeat(80);
            controller.enqueue(encoder.encode(JSON.stringify({type:'done', subject:'第二轮', content:body, signoff:'', basis:['写作要求']}) + '\n'));
            controller.close();
            window.fetch = originalFetch;
          };
        }}), {status:200, headers:{'Content-Type':'application/x-ndjson'}}));
      };
    });
    await page.locator('#btn-ai-regenerate').click();
    await page.waitForFunction(() => document.getElementById('compose-ai-output').innerText.includes('第二轮片段'));
    assert.equal(await page.locator('#btn-ai-replace').isDisabled(), true);
    assert.equal(await page.locator('.compose-ai-preview-actions').isVisible(), true);
    await page.evaluate(() => window.__finishRegenerate());
    await page.waitForFunction(() => !document.getElementById('btn-ai-replace').disabled);
    const footerInPanel = await page.evaluate(() => {
      const panel = document.getElementById('compose-ai-panel').getBoundingClientRect();
      const footer = document.querySelector('.compose-ai-panel > .compose-ai-preview-actions').getBoundingClientRect();
      return footer.top >= panel.top && footer.bottom <= panel.bottom + 1;
    });
    assert.equal(footerInPanel, true);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
