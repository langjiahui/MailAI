/* Recovery must not launch a new probe after document teardown. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium, webkit} = require('playwright');
(async () => {
  for (const [name, engine] of Object.entries({chromium, webkit})) {
    const browser = await engine.launch({headless:true});
    try {
      const page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<html><body></body></html>');
      await page.evaluate(() => {
        window.mailaiText = text => text;
        window.mailaiBindUI = (node, key, value) => { node[key] = value(); };
        window.probes = [];
        window.fetch = async url => {
          probes.push(url);
          return {ok:true, json:async () => ({imap_configured:true})};
        };
      });
      await page.addScriptTag({content:fs.readFileSync('app/web/static/interaction-core.js','utf8')});
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));
        // A background request rejects during navigation and asks for recovery.
        mailaiConnectionFailed(); mailaiConnectionFailed();
      });
      assert.deepEqual(await page.evaluate(() => probes), []);
      assert.equal(await page.locator('#connection-recovery').count(), 0);
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
        mailaiConnectionFailed();
      });
      await page.waitForFunction(() => document.querySelector('#connection-recovery')?.hidden === false && !document.querySelector('#connection-recovery button').disabled);
      assert.deepEqual(await page.evaluate(() => probes), ['/api/health'], 'Returning to a cached page must restore recovery');
      await page.evaluate(() => mailaiConnectionRestored());
      assert(await page.locator('#connection-recovery').isHidden());
      assert.deepEqual(errors, []);
      console.log(`${name}: navigation suppresses new health probes; restored pages recover normally`);
    } finally { await browser.close(); }
  }
})().catch(error => {console.error(error);process.exitCode=1;});
