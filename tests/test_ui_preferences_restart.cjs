const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mailai-preferences-'));
const python = process.argv[2] || path.join(root, '.venv-build/bin/python');
const themeBoot = fs.readFileSync(path.join(root,'app/web/static/index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const code = `
import socket, uvicorn
from app.web.server import app
# Exercise real routes and middleware, without mail startup jobs.
app.router.on_startup.clear()
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1], flush=True)
uvicorn.Server(uvicorn.Config(app, log_level='error')).run(sockets=[s])
`;
let child, browser;
async function start() {
  child = spawn(python, ['-c', code], {cwd:root, env:{...process.env, MAILAI_HOME:home}, stdio:['ignore','pipe','pipe']});
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server startup timeout')), 20000);
    child.stdout.on('data', data => { output += data; if (output.includes('\n')) { clearTimeout(timeout); resolve(Number(output.trim())); } });
    child.once('exit', () => {clearTimeout(timeout); reject(new Error('server exited'));});
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i=0;i<100;i++) {
    try { if ((await fetch(url+'/api/health')).ok) return url; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('server not ready');
}
async function stop() { if (child) { const done = once(child,'exit'); child.kill('SIGTERM'); await done; child=null; } }
async function pageAt(url) {
  browser = await chromium.launch({...(process.env.CI ? {} : {channel:'chrome'}),headless:true});
  const page = await browser.newPage();
  // Use the actual bootstrap and adapter, but no mail-dependent UI scripts.
  await page.route(url+'/', route => route.fulfill({contentType:'text/html',body:'<script src="/api/ui-preferences.js"></script><script src="/static/preferences.js"></script><script>'+themeBoot+'</script>'}));
  await page.goto(url);
  return page;
}
(async () => {
  const values = {
    'mailai.preferences.theme.v1':'dark', 'mailai-language':'en',
    'mailai-density':'compact','mailai-font-scale':'1.2',
    'mailai-companion-motion':'off','mailai-assistant-floating':'true',
    'mailai-assistant-layout-v1':'{"width":400}',
    'mailai.workspace.paneSizes.v1':'{"sidebar":250,"list":420}',
    'mailai.preferences.showServerFolders.v1':'true',
    'mailai-browsing-account':'test-account', 'alias:test-account':'Work',
    'collapsed:test-account':'1', 'mailai-secretary-focus:test-account':'decision',
    'mailai.onboarding.v2':'{"dismissed":true}',
  };
  const first = await start();
  let page = await pageAt(first);
  await page.evaluate(values => { for (const [key,value] of Object.entries(values)) localStorage.setItem(key,value); }, values);
  assert.equal((await fetch(first+'/api/ui-preferences',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://evil.test'},body:'{"key":"mailai-language","value":"zh"}'})).status,403);
  assert.equal((await fetch(first+'/api/ui-preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"key":"password","value":"secret"}'})).status,400);
  await browser.close(); browser=null;
  await stop();
  const second = await start();
  assert.notEqual(first,second,'restart must use a different origin');
  page = await pageAt(second);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme),'dark', 'dark theme must apply in the head, before the workspace loads');
  assert.deepEqual(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key,localStorage.getItem(key)])),Object.keys(values)), values);
  await page.evaluate(() => localStorage.removeItem('mailai-assistant-layout-v1'));
  await browser.close(); browser=null;
  await stop();
  page = await pageAt(await start());
  assert.equal(await page.evaluate(() => localStorage.getItem('mailai-assistant-layout-v1')),null);
  assert.equal(await page.evaluate(() => localStorage.getItem('mailai.preferences.theme.v1')),'dark');
  page.on('dialog', dialog => dialog.dismiss());
  await page.route('**/api/ui-preferences', route => route.fulfill({status:500,body:'disk unavailable'}));
  assert.equal(await page.evaluate(() => {
    try { localStorage.setItem('mailai.preferences.theme.v1','light'); return false; } catch (_) { return true; }
  }),true,'a failed disk save must not be reported as successful');
  assert.equal(await page.evaluate(() => localStorage.getItem('mailai.preferences.theme.v1')),'dark');
  console.log('PASS disk persistence: 14 preferences, fresh browser + server + port, reset, origin protection');
})().catch(error => {console.error(error);process.exitCode=1;}).finally(async () => {
  if (browser) await browser.close();
  await stop();
  fs.rmSync(home,{recursive:true,force:true});
});
