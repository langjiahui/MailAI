const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:18795/');
    await page.waitForFunction(() => allEmails.length > 0);
    await page.locator('#app-preloader').waitFor({state:'detached',timeout:15000});
    const accounts = await page.evaluate(() => api('/api/system/config'));
    assert(accounts.accounts.every(a => a.user.endsWith('@example.test')));
    assert(await page.locator('#btn-empty-trash').isHidden());
    let executions = 0, lastPreview;
    await page.route('**/api/trash/purge/preview*', route => {
      lastPreview = route.request().postDataJSON();
      return route.fulfill({json:{token:'fixture-only', count:3, account:'work@example.test'}});
    });
    await page.route('**/api/trash/purge/execute*', route => {
      executions++;
      assert.equal(route.request().postDataJSON().confirmed, true);
      return route.fulfill({json:{completed:3,errors:[]}});
    });
    await page.evaluate(async () => {
      await openAccountMailbox(_systemConfig.accounts[0].id, 'inbox');
      currentFilter.status = 'trash';
      selectedMailIds = new Set([allEmails[0].id]);
      updateBulkToolbar();
    });
    assert(await page.locator('[data-bulk-action="purge"]').isVisible());
    assert(await page.locator('[data-bulk-action="trash"]').isHidden());
    assert(await page.locator('#btn-empty-trash').isVisible());
    for (const width of [1280, 1024, 760]) {
      await page.setViewportSize({width, height:900});
      const fits = await page.locator('#btn-empty-trash').evaluate(button => {
        const rect = button.getBoundingClientRect();
        const parent = button.closest('.list-pane').getBoundingClientRect();
        return rect.width > 0 && rect.left >= parent.left && rect.right <= parent.right;
      });
      assert(fits, `Trash action must fit at ${width}px`);
    }
    await page.setViewportSize({width:1280,height:900});
    await page.screenshot({path:'build/trash-purge-light.png'});
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.screenshot({path:'build/trash-purge-dark.png'});
    page.once('dialog', async dialog => {
      assert.match(dialog.message(), /无法撤销/);
      assert.match(dialog.message(), /work@example.test/);
      await dialog.dismiss();
    });
    await page.locator('[data-bulk-action="purge"]').click();
    await page.waitForFunction(() => !bulkOperationActive);
    assert.equal(executions, 0);
    assert.equal(lastPreview.empty, false);
    assert.equal(lastPreview.ids.length, 1);
    page.once('dialog', async dialog => {
      assert.match(dialog.message(), /不受搜索条件限制/);
      await dialog.accept();
    });
    await page.locator('#btn-empty-trash').click();
    await page.waitForFunction(() => !bulkOperationActive);
    assert.equal(executions, 1);
    assert.equal(lastPreview.empty, true);
    assert.equal(await page.evaluate(() => selectedMailIds.size), 0);
    await page.unroute('**/api/trash/purge/preview*');
    await page.unroute('**/api/trash/purge/execute*');
    const localResult = await page.evaluate(async () => {
      const rows = await api('/api/emails?days=9999&status=inbox');
      const id = rows[0].id;
      const post = (url,body) => api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      await post('/api/emails/bulk',{ids:[id],action:'trash'});
      const plan = await post('/api/trash/purge/preview',{ids:[id]});
      const result = await post('/api/trash/purge/execute',{token:plan.token,confirmed:true});
      const remaining = await api('/api/emails?days=9999&status=trash');
      return {result, restored:remaining.some(row=>row.id===id), status:await api('/api/trash/purge/status')};
    });
    assert.equal(localResult.result.completed, 1);
    assert.equal(localResult.restored, false);
    assert(localResult.status.blocked >= 1, 'Unverified fixture remote identity must remain local-only');
    await page.evaluate(() => refreshTaskCenter());
    await page.waitForFunction(() => document.getElementById('task-center-list').textContent.includes('仅本地完成'));
    assert.match(await page.locator('#task-center-list').textContent(), /服务器可能仍保留/);
    assert.deepEqual(errors, []);
    console.log('PASS trash actions, confirmations, local-only scope, real local deletion API and durable remote status');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
