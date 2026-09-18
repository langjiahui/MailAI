const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const appSource = fs.readFileSync('app/web/static/app.js', 'utf8');
const styleSource = fs.readFileSync('app/web/static/style.css', 'utf8');
const themeSource = fs.readFileSync('app/web/static/theme.css', 'utf8');

// 卡片渲染函数存在且走确认后才执行的协议
assert.match(appSource, /function renderAssistantActionCard\(bubble, action, account\)/);
assert.match(appSource, /\/api\/assistant\/actions\/execute/);
assert.match(appSource, /data-action-confirm/);
assert.match(appSource, /data-action-dismiss/);
// 流式协议接 action 事件
assert.match(appSource, /event\.type === 'action'/);
// 三类结果的反馈文案
for (const type of ['create_todo', 'mark_read', 'draft_reply']) {
  assert.ok(appSource.includes(`action.type === '${type}'`), `missing ${type} feedback`);
}

// 函数行为：卡片挂载到气泡、确认按钮触发提交
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const listeners = {};
const appended = [];
const bubble = { appendChild: node => appended.push(node) };
const confirmButton = { addEventListener: (kind, fn) => { listeners.confirm = fn; }, disabled: false };
const dismissButton = { addEventListener: (kind, fn) => { listeners.dismiss = fn; } };
const card = {
  className: '',
  innerHTML: '',
  querySelector: selector => selector.includes('confirm') ? confirmButton : dismissButton,
};
const ctx = vm.createContext({
  esc, document: { createElement: () => card },
});
vm.runInContext(appSource.slice(
  appSource.indexOf('function renderAssistantActionCard('),
  appSource.indexOf('function assistantTableCells(')), ctx);

ctx.renderAssistantActionCard(bubble, {type:'create_todo', summary:'创建待办：确认合同（截止 2026-09-25）', params:{title:'确认合同'}}, {id:'acc'});
assert.equal(appended.length, 1, 'card mounted into bubble');
assert.ok(listeners.confirm && listeners.dismiss, 'both buttons wired');
assert.match(card.innerHTML, /创建待办：确认合同/);
assert.match(card.innerHTML, /data-action-confirm/);

// XSS：summary 注入必须被转义
ctx.renderAssistantActionCard(bubble, {type:'create_todo', summary:'<img src=x onerror=alert(1)>', params:{}}, null);
assert.doesNotMatch(card.innerHTML, /<img/);

// 空动作不渲染
appended.length = 0;
ctx.renderAssistantActionCard(bubble, null, null);
assert.equal(appended.length, 0);

// 样式：浅色定义 + 暗色覆盖
assert.match(styleSource, /\.assistant-action-card/);
assert.match(themeSource, /html\[data-theme="dark"\] \.assistant-action-card/);

console.log('Assistant action card: mount, confirm/dismiss wiring, escaping and theming passed');
