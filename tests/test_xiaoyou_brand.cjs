const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const files = [
  'app/mail_assistant.py',
  'app/assistant_vision.py',
  'app/web/static/index.html',
  'app/web/static/assistant-attachments.js',
];
const legacyName = ['秘', '书'].join('');
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(!source.includes(legacyName), `${file} still exposes the legacy assistant name`);
}
const html = fs.readFileSync(path.join(root, 'app/web/static/index.html'), 'utf8');
assert.match(html, /<h2>小邮<\/h2>/, 'The assistant should use the concise Xiaoyou name');
assert.match(html, /和小邮一起，把工作理清楚/, 'The welcome copy should use Xiaoyou consistently');

console.log('Assistant naming is consistently presented as Xiaoyou');
