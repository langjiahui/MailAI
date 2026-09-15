const fs = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app/web/static/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/web/static/workspace.css'), 'utf8');
const start = source.indexOf('function assistantTableCells');
const end = source.indexOf('function assistantAnswerHtml');
assert.ok(start >= 0 && end > start, 'Table parsing helpers must be present');
const context = {};
vm.runInNewContext(`${source.slice(start, end)}\nthis.cells=assistantTableCells;this.block=assistantTableBlock;`, context);

const inline = value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const standard = context.block([
  '| 对比维度 | 邮件正文 | 附件 |',
  '|:---|:---:|---:|',
  '| 人数 | 7 | 9 |',
  '| 时间 | 09:30 | 11:38 |',
  '',
], 0, inline);
assert.ok(standard, 'A valid Markdown table should be recognized');
assert.match(standard.html, /<table><thead><tr><th class="align-left" scope="col">对比维度<\/th>/);
assert.match(standard.html, /<th class="align-center" scope="col">邮件正文<\/th>/);
assert.match(standard.html, /<td class="align-right">9<\/td>/);
assert.equal(standard.next, 4, 'Parser should leave following content for the answer renderer');
const extra = context.block(['| 项目 | 说明 |', '|---|---|', '| 排期 | 周五 | 需要核实 |'], 0, inline);
assert.match(extra.html, /周五 \| 需要核实/, 'Extra model-generated cells must not lose text');
assert.deepEqual(Array.from(context.cells('| 含竖线 | A\\|B |')), ['含竖线', 'A|B']);
assert.equal(context.block(['普通 | 文字', '不是 | 表格'], 0, inline), null, 'Ordinary pipe text must not become a table');
const escaped = context.block(['| 字段 | 内容 |', '|---|---|', '| 安全 | <img onerror=x> |'], 0, inline);
assert.doesNotMatch(escaped.html, /<img onerror=/, 'Table cells must pass through safe inline rendering');

assert.match(css, /\.assistant-table-wrap\s*\{[^}]*overflow-x:auto/, 'Wide tables should scroll within the assistant panel');
assert.match(css, /\.assistant-panel \.assistant-form textarea\s*\{[^}]*max-height:128px[^}]*overflow-y:hidden/, 'The composer should grow up to a stable maximum');
assert.match(source, /function resizeAssistantInput\(\)[\s\S]*assistantInput\.scrollHeight[\s\S]*overflowY/, 'Composer height should track its content');
assert.match(source, /!event\.isComposing && event\.keyCode !== 229/, 'Enter must not submit while a Chinese IME is composing');

console.log('Assistant renders safe Markdown tables and grows the composer for long prompts');
