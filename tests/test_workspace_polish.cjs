const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '../app/web/static');
const workspace = fs.readFileSync(path.join(root, 'workspace.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'workspace.css'), 'utf8');
const outboxSource = workspace.slice(workspace.indexOf('function actionableOutboxRows('), workspace.indexOf('\nasync function refreshTaskCenter'));
const outboxCtx = {};
vm.createContext(outboxCtx); vm.runInContext(outboxSource, outboxCtx);
assert.deepEqual(Array.from(outboxCtx.actionableOutboxRows([
  {token:'new-success',draft_id:1,status:'sent'}, {token:'old-failure',draft_id:1,status:'failed'},
  {token:'current-failure',draft_id:2,status:'failed'}, {token:'history',status:'canceled'},
])), [{token:'current-failure',draft_id:2,status:'failed'}]);
const source = workspace.slice(workspace.indexOf('function updateAssistantScopeControl()'), workspace.indexOf('function initializeAssistantPolish()'));
const classes = new Set(['assistant-visible']);
const scopeSummary = {setAttribute(name,value) { this[name] = value; }};
const nodes = {
  'assistant-scope': {value:'account'},
  'assistant-scope-label': {},
  'assistant-scope-clear': {classList:{toggle(name, value) { this.hidden = value; }}},
  'reading-content': {classList:{contains:() => true}},
  'assistant-panel': {style:{setProperty(){}}},
  'assistant-float': {setAttribute(name,value) { this[name] = value; }},
};
const ctx = {
  document: {
    body:{classList:{contains:name => classes.has(name),toggle(name,value) { value ? classes.add(name) : classes.delete(name); }}},
    getElementById:id => nodes[id], querySelectorAll:() => [],
    querySelector:selector => selector === '#assistant-scope-picker summary' ? scopeSummary : selector === '.layout' ? {getClientRects:()=>[{}],getBoundingClientRect:()=>({top:100})} : {getBoundingClientRect:()=>({left:650,top:100,width:700,height:780})},
  },
  assistantPinnedScope:null, selectedEmailId:null, selectedEmailDetail:null,
  allEmails:[{id:7,subject:'合同确认'}], activeMailAccount:()=>({user:'work@example.test'}), innerWidth:1440,
};
vm.createContext(ctx); vm.runInContext(source, ctx);
ctx.updateAssistantScopeControl(); assert.equal(nodes['assistant-scope-label'].textContent,'当前邮箱');
nodes['assistant-scope'].value='selected'; ctx.assistantPinnedScope=[7];
ctx.updateAssistantScopeControl(); assert.equal(nodes['assistant-scope-label'].textContent,'合同确认');
assert.equal(scopeSummary['aria-label'], '参考范围：合同确认，点击更改');
ctx.assistantPinnedScope=[7,8]; ctx.updateAssistantScopeControl(); assert.equal(nodes['assistant-scope-label'].textContent,'2 封指定邮件');
ctx.assistantPinnedScope=null; nodes['assistant-scope'].value='filtered'; ctx.updateAssistantScopeControl();
assert.equal(nodes['assistant-scope-label'].textContent,'当前列表 · 本邮箱');
ctx.updateAssistantPlacement(); assert.ok(classes.has('assistant-home')); assert.ok(!classes.has('assistant-docked'));
nodes['reading-content'].classList.contains=()=>false; ctx.updateAssistantPlacement(); assert.ok(!classes.has('assistant-home'));
ctx.innerWidth=1800; ctx.updateAssistantPlacement(); assert.ok(classes.has('assistant-docked'));
classes.add('assistant-floating'); ctx.updateAssistantPlacement(); assert.ok(!classes.has('assistant-docked'));
classes.delete('assistant-floating'); classes.delete('assistant-visible'); ctx.updateAssistantPlacement(); assert.ok(!classes.has('assistant-home'));
assert.equal((html.match(/id="assistant-float"/g)||[]).length,1);
assert.ok(html.indexOf('id="assistant-scope-picker"') > html.indexOf('id="assistant-messages"'));
assert.match(app,/assistantPinnedScope = \[\.\.\.explicitIds\]/);
assert.match(app,/assistantPinnedScope = null;\s*document.getElementById\('assistant-scope'\).value = 'account'/);
assert.match(app,/aria-expanded="\$\{!collapsed\}"/);
assert.match(app,/data-account-manage/);
assert.doesNotMatch(css,/assistant-visible:not\(\.assistant-floating\) .layout/);
assert.match(workspace, /function actionableOutboxRows[\s\S]*seenDrafts[\s\S]*\['queued','sending','failed','unknown'\]\.includes\(row\.status\)/,
  'Task center should hide successful and canceled outbox history');
assert.match(workspace, /sync\.running \|\| sync\.error \|\| sync\.canceled \|\| sync\.resumable/,
  'Task center should only show active or actionable sync jobs');
assert.match(workspace, /目前没有需要处理的任务[\s\S]*正常同步进度会显示在左侧邮箱区域/,
  'Task center should explain its empty state');
assert.match(workspace, /data-sync-retry[\s\S]*重新同步/,
  'Interrupted synchronization should offer a retry action');
assert.match(workspace, /setTimeout\(\(\) => refreshTaskCenter\(\{lightweight:true\}\), 2500\)/,
  'Only live tasks should enable bounded lightweight polling');
assert.match(workspace, /task-center-backdrop[\s\S]*event\.key === 'Escape'/,
  'Task drawer should support backdrop and keyboard dismissal');
assert.match(css, /@media\(max-width:600px\)\{\.task-center\{inset:8px/,
  'Task drawer should remain usable on small screens');
console.log('Workspace polish: scope labels, account isolation reset, responsive placement and navigation controls passed');
