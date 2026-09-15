const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/web/static/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/web/static/select-ui.css'), 'utf8');

assert.match(html, /select-ui\.css\?v=1/, 'shared select styles must load after component styles');
assert.match(css, /appearance:\s*none/, 'native closed-control chrome should be normalized');
assert.match(css, /--select-arrow:/, 'selects should use a consistent custom chevron');
assert.match(css, /\.contact-group-toolbar #contact-group-filter/, 'contact group selector should align with toolbar actions');
assert.match(css, /\.filter-select-row #filter-domain/, 'domain selector should have a readable compact treatment');
assert.match(css, /html\[data-theme="dark"\]/, 'dark appearance must define select colors and chevron');
assert.match(css, /:focus-visible/, 'keyboard focus must remain visible');
assert.match(css, /select option \{ color: #e9f5ed; background: #17291f; \}/, 'dark native menu options must remain legible');
console.log('PASS unified select visuals, focus and dark-theme contrast');
