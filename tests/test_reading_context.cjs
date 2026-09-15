const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');

assert.match(source, /function resetReadingPane\(\)[\s\S]*readingLoadRevision \+= 1[\s\S]*selectedEmailId = null[\s\S]*selectedEmailDetail = null[\s\S]*content\.replaceChildren\(\)/,
  'Resetting the reading pane must invalidate requests and remove stale detail content');
assert.match(source, /function reconcileReadingPane\(emails\)[\s\S]*emails\.some[\s\S]*else resetReadingPane\(\)/,
  'A selected message that leaves the visible result set must be cleared');
assert.match(source, /async function onNavClick\(e\)[\s\S]*e\.stopPropagation\(\);\s*resetReadingPane\(\);/,
  'Every left-navigation context switch must clear the reading pane immediately');
assert.match(source, /async function loadServerFolder\(folder\) \{\s*resetReadingPane\(\);/,
  'Direct server-folder navigation must clear the previous detail');
assert.match(source, /async function selectEmail\(id, options = \{\}\)[\s\S]*const requestRevision = \+\+readingLoadRevision[\s\S]*requestRevision !== readingLoadRevision \|\| selectedEmailId !== id/,
  'Late detail responses must not repaint a newer reading context');
assert.match(source, /currentFilter\.search = query;\s*resetReadingPane\(\);/,
  'Search changes must clear stale detail while new results load');
assert.match(source, /async function applySidebarFilter[\s\S]*resetReadingPane\(\);/,
  'Every sidebar filter must clear detail while sorting may preserve it');

console.log('Reading pane follows navigation, filtering and asynchronous selection context');
