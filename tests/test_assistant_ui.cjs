const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../app/web/static/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');

assert.match(html, /id="assistant-new"[\s\S]*?<svg[^>]*>[\s\S]*?id="assistant-history"[\s\S]*?<svg/,
  'New conversation and history should use aligned SVG icons');
assert.match(js, /setAttribute\('aria-label', `参考范围：\$\{label\}，点击更改`\)/,
  'The compact scope chip must expose its current value and purpose to assistive technology');
assert.match(html, /id="assistant-welcome-template"[\s\S]*?id="assistant-quick"[\s\S]*?<\/template>/,
  'Example questions belong in the new-conversation template, not the fixed composer');
assert.match(css, /\.assistant-head-actions \.btn-ghost,\.assistant-menu summary\s*\{[^}]*width:32px[^}]*height:32px[^}]*place-items:center/,
  'Header actions should share one geometry and alignment rule');
assert.match(css, /\.assistant-panel \.assistant-form \.assistant-send-button\s*\{[^}]*width:36px[^}]*height:36px[^}]*flex:0 0 36px[^}]*aspect-ratio:1/,
  'The send button should retain a fixed square geometry');
assert.match(css, /\.assistant-quick\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*overflow:visible/,
  'Quick prompts should remain fully visible instead of becoming a clipped strip');
assert.match(html, /id="assistant-float"[^>]*aria-label="切换为浮动窗口"[\s\S]*?<svg/,
  'Window mode should be a direct icon action instead of a one-item overflow menu');
assert.doesNotMatch(html, /class="assistant-menu"/,
  'A one-item overflow menu should not add an unnecessary interaction layer');
assert.match(js, /floating \? '恢复自动布局' : '切换为浮动窗口'/,
  'Display mode copy should explain the resulting action');
for (const name of ['openContactCenter','openCompose','showDashboard','showRulesView','showSystemView','openDigestModal','openAttachmentCenter','openTodoCenter']) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  assert.match(appJs.slice(start, start + 180), /closeAssistant\(\);/,
    `${name} should retire the assistant before opening a primary workspace`);
}
assert.match(js, /async function openTaskCenter\(\)\s*\{\s*window\.closeAssistant\?\.\(\);/,
  'Opening the task center should retire the assistant');
assert.match(appJs, /function closeAssistant\(\)[\s\S]*?assistant-orb['"]\)\?\.setAttribute\('aria-expanded', 'false'\)/,
  'Closing the assistant should update the launcher accessibility state');

console.log('Assistant panel uses aligned icons, stable controls and unclipped prompts');
