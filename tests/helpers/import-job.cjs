const assert = require('node:assert/strict');

// waitForFunction treats an async predicate's Promise as truthy in our pinned
// Playwright runtime, even when it later resolves false. Await each API result
// in Node so a background import must actually finish before UI assertions.
async function waitForImport(page, token, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let job;
  do {
    job = await page.evaluate(token => api('/api/mail/client-imports/' + token), token);
    if (job.state === 'completed') return job;
    assert.notEqual(job.state, 'failed', JSON.stringify(job));
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  assert.equal(job.state, 'completed', 'Import did not complete: ' + JSON.stringify(job));
}

module.exports = {waitForImport};
