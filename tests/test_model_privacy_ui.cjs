const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const base = path.join(__dirname, '../app/web/static');
const source = fs.readFileSync(path.join(base, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
const start = source.indexOf("const CLOUD_MODEL_PROVIDERS");
const end = source.indexOf("document.getElementById('model-provider').addEventListener", start);
const context = vm.createContext({URL, mailaiT: () => null, document: {getElementById: () => null}});
vm.runInContext(source.slice(start, end), context);

assert.match(html, /id="model-data-notice"[^>]*role="status"[^>]*aria-live="polite"/,
  'Model configuration must expose an accessible data destination notice');
assert.equal(context.modelDataNotice('deepseek', 'https://api.deepseek.com/v1').kind, 'cloud');
assert.equal(context.modelDataNotice('kimi', 'https://api.moonshot.cn/v1').kind, 'cloud');
assert.equal(context.modelDataNotice('other', 'https://vendor.example/v1').kind, 'cloud');
assert.equal(context.modelDataNotice('custom', 'http://localhost:11434/v1').kind, 'local');
assert.equal(context.modelDataNotice('custom', 'http://127.0.0.1:8080/v1').kind, 'local');
assert.equal(context.modelDataNotice('custom', 'http://[::1]:8080/v1').kind, 'local');
assert.equal(context.modelDataNotice('custom', 'https://llm.corp.example/v1').kind, 'self-hosted');
assert.match(context.modelDataNotice('deepseek', '').copy, /邮件正文、上下文及相关附件/);
assert.match(context.modelDataNotice('custom', 'http://localhost:11434/v1').copy, /不会发送给云端模型服务商/);

console.log('Cloud privacy notice and local/self-hosted trust notices passed');
