const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const base = path.join(__dirname, '../app/web/static');
const theme = fs.readFileSync(path.join(base, 'theme.css'), 'utf8');
const index = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
const refined = theme.slice(theme.indexOf('/* Product-wide refinement:'));

assert.ok(refined.length > 0, 'missing product-wide refinement layer');
assert.match(refined, /--ui-control-height:40px/);
assert.match(refined, /\.email-item \{[\s\S]*?min-height:98px/);
assert.match(refined, /\.reading-workspace \{ width:min\(100%,1120px\)/);
assert.match(refined, /max-width:78ch/);
assert.match(refined, /:user-invalid/);
assert.match(refined, /@media\(prefers-contrast:more\)/);
assert.match(refined, /@media\(max-width:760px\)/);
assert.match(refined, /button,[\s\S]*?min-height:44px!important/);
assert.match(refined, /button \{ min-width:44px!important/);
assert.match(refined, /@media\(prefers-reduced-motion:reduce\)/);
assert.match(index, /theme\.css\?v=[^"']+/);

console.log('Product-wide hierarchy, controls, readability and accessibility refinements passed');
