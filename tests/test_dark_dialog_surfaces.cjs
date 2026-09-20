const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const base = path.join(__dirname, '../app/web/static');
const theme = fs.readFileSync(path.join(base, 'theme.css'), 'utf8');
const preview = fs.readFileSync(path.join(base, 'attachment-preview.css'), 'utf8');
const audited = theme.slice(theme.indexOf('/* Dialog audit:'));

for (const selector of [
  '.library-dialog', '.update-dialog', '.share-app-dialog', '.migration-password-dialog',
  '#reminder-dialog', '#task-planner', '#assistant-attachment-picker', '#assistant-image-zoom',
  '.attachment-center-card', '.contact-editor-card', '.preflight-dialog',
  '.feedback-dialog', '.logout-choice', '.compose-subdialog>section',
  '.signature-manager-card', '#correspondence-drawer',
]) assert.ok(audited.includes(selector), `missing audited dark dialog selector: ${selector}`);

assert.match(audited, /background:#141b17!important/);
assert.match(audited, /background:rgba\(3,7,5,.8\)!important/);
assert.match(audited, /\.feedback-modal \.feedback-dialog/);
assert.match(audited, /:is\(\.logout-actions,\.account-danger-zone\) \.action-danger/);
assert.match(preview, /html\[data-theme="dark"\] \.file-preview \{[\s\S]*?background:#141b17/);
assert.doesNotMatch(preview.slice(preview.indexOf('html[data-theme="dark"] .file-preview')), /background:#203129/);

console.log('All dialog families use the audited graphite surface hierarchy');
