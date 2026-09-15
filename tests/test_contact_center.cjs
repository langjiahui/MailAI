const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/web/static/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app/web/static/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/web/static/style.css'), 'utf8');

for (const id of ['btn-contacts', 'contact-center', 'contact-center-search', 'contact-center-list', 'contact-form']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`missing contact UI: ${id}`);
}
for (const target of ['compose-to', 'compose-cc', 'compose-bcc']) {
  if (!html.includes(`data-contact-target="${target}"`)) throw new Error(`missing picker for ${target}`);
}
for (const feature of ['openContactCenter', 'appendRecipients', 'contactRecipientValue', '/api/mail/contacts/favorite', 'data-contact-compose', 'data-contact-correspondence', 'openContactCorrespondence']) {
  if (!js.includes(feature)) throw new Error(`missing contact behavior: ${feature}`);
}
if (!js.includes('`${safeName} <${email}>`')) throw new Error('selected contacts should retain their display names');
if (!js.includes('/api/mail/contacts/correspondence?email=${encodeURIComponent(source.email)}')) throw new Error('contact history should query by exact contact email');
if (!/closeContactCenter\(\);\r?\n\s*return loadCorrespondence/.test(js)) throw new Error('contact center should close before its history drawer opens');
if (!css.includes('.contact-center-item') || !css.includes('.recipient-book-button') || !css.includes('.contact-correspondence-trigger:focus-visible')) throw new Error('missing contact styles');
console.log('PASS contact center integration');
