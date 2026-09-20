const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const base = path.join(__dirname, '../app/web/static');
const theme = fs.readFileSync(path.join(base, 'theme.css'), 'utf8');
const onboarding = fs.readFileSync(path.join(base, 'onboarding.css'), 'utf8');
const html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
const premium = theme.slice(theme.indexOf('/* Premium graphite dark palette.'));

assert.ok(premium.length > 4000, 'premium dark palette must remain a complete final override layer');
assert.match(premium, /--bg:#0d1210/);
assert.match(premium, /--dark-field:#19231d/);
assert.match(premium, /--dark-highlight:#72b995/);
assert.match(premium, /\.model-data-notice\.cloud[^}]+#342b1d/);
assert.match(premium, /\.model-data-notice:is\(\.local,\.self-hosted\)[^}]+#183329/);
assert.match(onboarding, /\.start-model-panel[^\n]+background:#141b17/);
assert.match(html, /theme\.css\?v=dark-graphite-1/);
assert.match(html, /onboarding\.css\?v=dark-graphite-1/);
assert.match(html, /select-ui\.css\?v=dark-graphite-1/);

console.log('Premium graphite dark palette, semantic notices and cache versions passed');
