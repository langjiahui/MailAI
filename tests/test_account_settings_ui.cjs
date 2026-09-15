const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../app/web/static/index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.css'), 'utf8');

assert.match(html, /id="mail-config-form" class="account-workspace"[\s\S]*class="account-directory"[\s\S]*class="account-detail"/,
  'Account settings should separate account selection from account maintenance');
assert.match(html, /id="account-count"[\s\S]*id="saved-accounts"[\s\S]*id="btn-add-mail"/,
  'The account directory should expose its count, list, and add action in one place');
assert.match(html, /id="account-selection-actions"[\s\S]*id="selected-account-state"[\s\S]*id="selected-account-host"/,
  'The selected account should have a readable status summary');
assert.match(html, /id="selected-account-avatar"[\s\S]*id="selected-account-role"[\s\S]*id="selected-account-name"/,
  'The account identity block should expose avatar, role, and address in reading order');
assert.match(html, /class="account-danger-zone"[\s\S]*id="btn-delete-mail"/,
  'Destructive account removal should be visually demoted behind a disclosure');
assert.match(css, /\.account-workspace\s*\{[^}]*grid-template-columns:320px minmax\(0,1fr\)/,
  'Wide account settings should use a directory-detail layout');
assert.match(css, /\.account-profile>\.saved-account-avatar\s*\{[^}]*display:grid[^}]*place-items:center/,
  'The account avatar must stay centered despite generic profile text styles');
assert.match(css, /@media\(max-width:900px\)[\s\S]*\.account-workspace\s*\{[^}]*grid-template-columns:1fr/,
  'Account settings should collapse cleanly on narrower windows');
assert.match(js, /accounts\.find\(account => account\.active\) \|\| accounts\[0\]/,
  'Opening settings should select the active account, then fall back to the first account');
assert.match(js, /if \(!document\.getElementById\('mail-add-panel'\)\.classList\.contains\('hidden'\)\) closeMailAddPanel\(\)/,
  'Selecting another account should close a stale credential editor first');
assert.match(js, /\/api\/system\/mail\/preferred[\s\S]{0,180}account_id:accountId/,
  'Selecting an account must persist the preferred account beyond browser storage');
assert.match(html, /id="digest-account-label"/,
  'Daily reports must identify the mailbox whose history is shown');
assert.match(js, /api\('\/api\/digests', \{accountId\}\)/,
  'Daily-report history must remain pinned to its opening account');

console.log('Account settings use a clear, responsive directory-detail workspace');
