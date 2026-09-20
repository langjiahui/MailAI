const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../app/web/static/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.css'), 'utf8');
const onboarding = fs.readFileSync(path.join(__dirname, '../app/web/static/onboarding.js'), 'utf8');

for (const panel of ['preferences', 'account', 'maintenance', 'guide']) {
  const match = html.match(new RegExp(`data-system-panel="${panel}"[\\s\\S]*?<div class="([^"]*settings-page-intro[^"]*)"`));
  assert.ok(match, `${panel} should use the shared Settings page intro`);
}
assert.match(css, /#system-view \.system-header,#system-view \.system-tabs,#system-view \.system-panel\s*\{[^}]*max-width:1280px/,
  'Every Settings tab should share one content width');
assert.match(css, /#system-view \.system-tabs\s*\{[^}]*background:#edf2ee[^}]*box-shadow:none/,
  'Settings navigation should use one quiet tab treatment');
assert.match(html, /class="maintenance-grid"[\s\S]*id="btn-run-diagnostics"[\s\S]*id="btn-create-backup"/,
  'Maintenance actions should use the same balanced card grid');
assert.match(css, /\[data-system-panel="guide"\] \.guide-grid article\s*\{[^}]*background:#fff/,
  'Help cards should match other Settings surfaces');
assert.match(html, /class="guide-intro-actions"><span[^>]*>6 个使用主题<\/span><\/div>/,
  'Replay belongs to the guide heading action area instead of floating above the cards');
assert.match(onboarding, /\.guide-intro-actions'\)\.append\(replay\)/,
  'Replay action should be mounted inside the guide heading');
assert.match(css, /\.guide-replay-action\s*\{[^}]*min-height:34px[^}]*border-radius:10px/,
  'Replay should use a compact secondary-action treatment');
assert.match(css, /\.guide-replay-action:focus-visible/,
  'Replay must retain a visible keyboard focus state');

console.log('All Settings tabs share one page, navigation, and card system');
