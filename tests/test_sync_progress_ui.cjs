const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../app/web/static/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../app/web/static/style.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');

assert.match(html, /id="btn-toggle-fetch"[^>]*aria-expanded="false"/,
  'Synchronization status must expose an accessible expand control');
assert.match(css, /\.fetch-overlay\.settings-context:not\(\.expanded\) \.fetch-progress-box\s*\{[^}]*min-height:58px/,
  'Settings should use a compact synchronization dock');
assert.match(css, /\[data-system-panel="maintenance"\] \.admin-settings \.connection-actions\s*\{[^}]*position:sticky/,
  'Model configuration actions should remain visible while scrolling');
assert.match(js, /function setFetchSettingsContext\(active\)/,
  'The synchronization dock should respond to Settings visibility');
assert.match(js, /showSystemView[\s\S]*?setFetchSettingsContext\(true\)/,
  'Opening Settings should compact the synchronization dock');
assert.match(js, /btn-toggle-fetch'[\s\S]*?classList\.toggle\('expanded'\)/,
  'Users should be able to expand synchronization details on demand');

console.log('Settings keeps configuration actions visible during background synchronization');
