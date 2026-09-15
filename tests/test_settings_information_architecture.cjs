const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../app/web/static/index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const docs = fs.readFileSync(path.join(__dirname, '../docs/开发者架构与运行机制.md'), 'utf8');

assert.match(html, /data-system-tab="preferences">常用设置/);
assert.match(html, /data-system-tab="account">邮箱账号/);
assert.match(html, /data-system-tab="maintenance">数据与维护/);
assert.match(html, /data-system-tab="guide">使用帮助/);
assert.doesNotMatch(html, /id="btn-help"|设置与帮助/,
  'Help should have one canonical entry inside Settings');
assert.match(html, /id="btn-preferences"[^>]*class="nav-action[^>]*>[\s\S]*?<span>设置<\/span>/,
  'The top-level Settings action should open Settings directly');
assert.doesNotMatch(html, /data-system-(?:tab|panel)="(?:workflow|architecture)"/,
  'Developer architecture must not compete with user settings');
assert.match(html, /<details class="admin-settings">[\s\S]*模型服务配置[\s\S]*id="model-config-form"/,
  'Model API controls must live in a collapsed administrator area');
assert.match(docs, /邮件处理流程[\s\S]*分层架构[\s\S]*技术栈/,
  'Removed technical material must remain available to developers');
assert.doesNotMatch(html, /id="btn-switch-mail"/, 'Settings must not duplicate the sidebar mailbox switcher');
assert.match(html, /id="btn-manage-mail"[\s\S]*更新登录信息/, 'Settings must keep account maintenance actions');
assert.match(js, /\/api\/system\/mail\/account\/update/, 'Updating a saved account must not switch the active mailbox');
assert.match(js, /\/api\/system\/model\/test[\s\S]{0,260}body:\s*JSON\.stringify\(payload\)/,
  'Model connectivity test must use current form values without requiring a prior save');

console.log('Settings prioritize user tasks and route technical detail to developer docs');
