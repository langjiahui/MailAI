const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const workspaceCss = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.css'), 'utf8');
const styleCss = fs.readFileSync(path.join(__dirname, '../app/web/static/style.css'), 'utf8');

assert.match(js, /<div id="primary-summary-content" class="markdown-body summary-box">/,
  'The primary AI summary should render without a collapsed state');
assert.match(js, /<span>AI 摘要<\/span><small>提炼重点，完整展示<\/small>/,
  'The summary heading should explain that the full summary is visible');
assert.doesNotMatch(js, /btn-toggle-primary-summary|togglePrimarySummary|syncPrimarySummaryControl|展开完整摘要|收起摘要/,
  'The extra expand interaction should be removed');
assert.doesNotMatch(workspaceCss, /summary-collapsible/,
  'Workspace overrides should not reintroduce summary clipping');
assert.doesNotMatch(styleCss, /summary-collapsible|summary-expand-button/,
  'Base styles should not retain dead summary clipping controls');

console.log('AI summary is fully visible without an extra expansion step');
