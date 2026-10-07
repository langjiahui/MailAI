const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const workspaceCss = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.css'), 'utf8');
const styleCss = fs.readFileSync(path.join(__dirname, '../app/web/static/style.css'), 'utf8');

assert.match(js, /function mailSummaryDisclosure\(/,
  'The summary should have an optional disclosure');
assert.match(js, /e\.summary \? \(mailaiT\('read\.summaryTitle'\) \|\| 'AI 摘要'\) : \(mailaiT\('read\.previewTitle'\) \|\| '正文预览'\)/,
  'A missing AI summary must identify the fallback as a body preview');
assert.match(js, /mailai-summary-expanded/,
  'The disclosure state should persist');
assert.doesNotMatch(js, /btn-toggle-primary-summary|togglePrimarySummary|syncPrimarySummaryControl|展开完整摘要|收起摘要/,
  'The extra expand interaction should be removed');
assert.doesNotMatch(workspaceCss, /summary-collapsible/,
  'Workspace overrides should not reintroduce summary clipping');
assert.doesNotMatch(styleCss, /summary-collapsible|summary-expand-button/,
  'Base styles should not retain dead summary clipping controls');

console.log('AI summary can be expanded while the mail body remains visible');
