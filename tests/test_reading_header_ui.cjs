const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.css'), 'utf8');

assert.match(js, /class="reading-header-inner"[\s\S]*class="reading-heading-row"[\s\S]*class="reading-subject"[\s\S]*class="security-result-trigger[^"]*"/,
  'The subject and security result should form the first row of the mail header');
for (const group of ['reading-mail-group', 'reading-ai-group', 'reading-risk-group']) {
  assert.match(js, new RegExp(`class="reading-action-group ${group}"`), `${group} should be visible in the reading toolbar`);
}
for (const label of ['回复', '回复全部', '转发', '查看往来邮件']) {
  assert.match(js, new RegExp(`aria-label="${label}"[^>]*data-tooltip="${label}"`), `${label} should have an accessible name and hover hint`);
}
assert.match(css, /\.reading-icon-action:focus-visible::after/, 'Keyboard focus should reveal the action hint');
assert.match(css, /@media\(hover:none\)[^\n]*\.reading-action-label\{display:inline/, 'Touch controls should show short labels without hover');
assert.doesNotMatch(js, /let actionButtons =/,
  'The old undifferentiated action wall should not return');
assert.match(css, /\.reading-header-inner\s*\{[^}]*max-width:1180px[^}]*padding:24px 30px 17px/,
  'The mail header should align to the reading content and stay compact');
assert.match(css, /\.reading-header \.reading-actions\{container-type:inline-size;display:flex/,
  'Actions should sit in one flat, responsive strip');
assert.match(css, /\.reading-header \.reading-actions \.reading-ai-group,\.reading-header \.reading-actions \.reading-risk-group\{padding-left:10px;border-left:1px solid/,
  'Functional groups should use only thin separators');
assert.match(css, /@container \(max-width: 1080px\)[^\n]*reading-action-label[^\n]*display:none/,
  'Constrained reading panes should show action icons without labels');
assert.match(css, /\.reading-header\s*\{[^}]*border-bottom:0/,
  'The reading header should use spacing instead of another divider line');
assert.match(css, /\.reading-main>\.reading-section\s*\{[^}]*border-color:transparent/,
  'Reading cards should avoid repeated outlines');
assert.match(css, /@media\(max-width:620px\)[\s\S]*\.reading-header \.reading-actions\s*\{[^}]*flex-direction:column/,
  'The compact header should remain usable on narrow windows');

console.log('Mail reading header prioritizes the message and groups secondary actions');
