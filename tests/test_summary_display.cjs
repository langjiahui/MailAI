const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');

const js = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const workspaceCss = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.css'), 'utf8');
const styleCss = fs.readFileSync(path.join(__dirname, '../app/web/static/style.css'), 'utf8');

assert.match(js, /function mailSummaryDisclosure\(/,
  'The summary should have an optional disclosure');
const names=new Set(['mailSummaryToolbarButton','mailSummaryDisclosure']);
const functions=acorn.parse(js,{ecmaVersion:'latest',sourceType:'script'}).body.filter(node=>node.type==='FunctionDeclaration'&&names.has(node.id.name));
assert.equal(functions.length,2);
let markdown;
const scope=vm.createContext({localStorage:{getItem:()=>null},mailaiT:key=>({'read.summaryTitle':'AI summary','read.previewTitle':'Body preview','read.noSummary':'No summary'}[key]||''),mdToHtml:text=>{markdown=text;return text;}});
vm.runInContext(functions.map(node=>js.slice(node.start,node.end)).join('\n'),scope);
for(const summary of [undefined,null,'',' \t\n\u3000']) {
  scope.mail={summary,snippet:'    original indented preview\n'};
  const toolbar=vm.runInContext('mailSummaryToolbarButton(mail)',scope);
  assert.match(toolbar,/data-i18n="read.previewTitle"/,'A missing or blank AI summary must identify the fallback as a body preview');
  for(const drawer of [false,true]) {
    vm.runInContext(`mailSummaryDisclosure(mail,{drawer:${drawer}})`,scope);
    assert.equal(markdown,scope.mail.snippet,'Fallback previews retain their original Markdown formatting');
  }
}
scope.mail={summary:'    original indented summary\n',snippet:'unused preview'};
assert.match(vm.runInContext('mailSummaryToolbarButton(mail)',scope),/data-i18n="read.summaryTitle"/);
vm.runInContext('mailSummaryDisclosure(mail)',scope);
assert.equal(markdown,scope.mail.summary,'Real summaries retain their original Markdown formatting');
scope.mail={summary:' \n ',snippet:'\t'};
vm.runInContext('mailSummaryDisclosure(mail)',scope);
assert.equal(markdown,'No summary','An empty summary and preview retain the localized empty state');
assert.match(js, /mailai-summary-expanded/,
  'The disclosure state should persist');
assert.doesNotMatch(js, /btn-toggle-primary-summary|togglePrimarySummary|syncPrimarySummaryControl|展开完整摘要|收起摘要/,
  'The extra expand interaction should be removed');
assert.doesNotMatch(workspaceCss, /summary-collapsible/,
  'Workspace overrides should not reintroduce summary clipping');
assert.doesNotMatch(styleCss, /summary-collapsible|summary-expand-button/,
  'Base styles should not retain dead summary clipping controls');

console.log('AI summary can be expanded while the mail body remains visible');
