const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const start = source.indexOf('function setLoading(');
const end = source.indexOf('\nfunction esc(', start);
const flow = source.slice(start, end);

assert.match(flow, /dataset\.originalHtml = el\.innerHTML/,
  'Loading state must preserve the original icon markup');
assert.match(flow, /find\(child => child\.tagName === 'SPAN'\)/,
  'Buttons with an icon must update only their visible label');
assert.match(flow, /el\.innerHTML = el\.dataset\.originalHtml/,
  'Finishing loading must restore the complete button markup');
assert.doesNotMatch(flow, /dataset\.originalText/,
  'Text-only restoration would permanently remove button icons');

console.log('Loading buttons preserve and restore their SVG icons');
