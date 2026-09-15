const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.css'), 'utf8');

assert.match(js, /class="reading-header-inner"[\s\S]*class="reading-heading-row"[\s\S]*class="reading-subject"[\s\S]*class="security-result-trigger[^"]*"/,
  'The subject and security result should form the first row of the mail header');
assert.match(js, /class="reading-actions"><div class="reading-reply-actions">\$\{replyActions\}<\/div><div class="reading-decision-actions">\$\{decisionActions\}/,
  'Reply actions and security decisions should be visually grouped');
assert.doesNotMatch(js, /let actionButtons =/,
  'The old undifferentiated action wall should not return');
assert.match(css, /\.reading-header-inner\s*\{[^}]*max-width:1180px[^}]*padding:24px 30px 17px/,
  'The mail header should align to the reading content and stay compact');
assert.match(css, /\.reading-header \.reading-actions\s*\{[^}]*justify-content:space-between[^}]*border:0[^}]*background:#f4f7f5/,
  'Actions should sit in a quiet line-free toolbar below message identity');
assert.match(css, /\.reading-header\s*\{[^}]*border-bottom:0/,
  'The reading header should use spacing instead of another divider line');
assert.match(css, /\.reading-main>\.reading-section\s*\{[^}]*border-color:transparent/,
  'Reading cards should avoid repeated outlines');
assert.match(css, /@media\(max-width:620px\)[\s\S]*\.reading-header \.reading-actions\s*\{[^}]*flex-direction:column/,
  'The compact header should remain usable on narrow windows');

console.log('Mail reading header prioritizes the message and groups secondary actions');
