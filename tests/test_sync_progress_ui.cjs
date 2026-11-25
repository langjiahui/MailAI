const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const i18nContext = require('./helpers/i18n.cjs');

const read = name => fs.readFileSync(path.join(__dirname, '../app/web/static', name), 'utf8');
const html = read('index.html');
const workspace = read('workspace.js');
const context = vm.createContext(i18nContext({
  URLSearchParams,
  mailaiT:key => key === 'acct.updateBtn' ? '更新登录信息' : '',
  esc:value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
}));
vm.runInContext(workspace.slice(workspace.indexOf('function taskSyncNeedsAttention'), workspace.indexOf('async function refreshTaskCenter')), context);
const running = {running:true, operation:'sync_folders', processed:189,total:1295,
  current_folder:'Deleted Messages',
  folder_progress:[{name:'Deleted Messages', role:'trash', processed:179,total:524,status:'running'},
    {name:'<Custom>', processed:0,total:20,status:'pending'}]};

assert.doesNotMatch(html, /id="fetch-overlay"|id="mailbox-sync-tracker"/);
assert.match(read('style.css'), /\[data-system-panel="ai"\] \.connection-actions\s*\{[^}]*position:sticky/);
assert.match(html, /id="inbox-ready-notice"[^>]+hidden[\s\S]+data-inbox-sync-task/);
const card = context.renderTaskSync(running);
assert.match(card, /其他文件夹[\s\S]*189 \/ 1295 封[\s\S]*<progress[\s\S]*已删除邮件[\s\S]*179 \/ 524 封/);
assert.match(card, /data-task-sync-pause="operation=sync_folders&amp;folder="/);
assert.match(context.renderTaskSync({running:true, operation:'poll'}), /data-task-sync-pause="operation=poll&amp;folder="/);
assert.match(card, /&lt;Custom>/);
assert.doesNotMatch(card, /解析与 AI 分析/);
assert.match(context.renderTaskSync({...running,canceled:true}), /正在暂停…[\s\S]*data-task-sync-pause[^>]+disabled/);
const paused = {...running,running:false,canceled:true,resumable:true};
assert.equal(context.taskSyncNeedsAttention(paused), false);
assert.match(context.renderTaskSync(paused), /已暂停的任务[\s\S]*data-sync-retry="\/api\/fetch_all">继续同步/);
assert.match(context.renderTaskSync({...paused, operation:'sync_folder', folder:'测试 & 审阅', folder_limit:20}),
  /folder=%E6%B5%8B%E8%AF%95\+%26\+%E5%AE%A1%E9%98%85&amp;limit=20&amp;resume=true/);
const failed = {running:false,error:'Authorization failed',issue_kind:'credentials',operation:'fetch_all'};
assert.equal(context.taskSyncNeedsAttention(failed), true);
assert.match(context.renderTaskSync(failed, {id:'a'}), /需要处理[\s\S]*data-task-sync-login/);
assert.equal(context.renderTaskSync({running:false,operation:'sync_folders'}), '');
console.log('Mailbox progress, pause and recovery stay in Tasks & Outbox');
