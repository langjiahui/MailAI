const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const base = path.join(__dirname,'../app/web/static');
const source = fs.readFileSync(path.join(base,'workspace.js'),'utf8');
const html = fs.readFileSync(path.join(base,'index.html'),'utf8');
const themeCss = fs.readFileSync(path.join(base,'theme.css'),'utf8');
assert.equal((html.match(/name="workspace-density-choice"/g)||[]).length,2);
assert.equal((html.match(/name="theme-mode-choice"/g)||[]).length,3);
assert.equal((html.match(/name="notification-mode"/g)||[]).length,4);
for (const id of ['theme-mode','workspace-density','notification-preference','notification-account','show-server-folders']) {
  assert.equal((html.match(new RegExp(`id="${id}"`,'g'))||[]).length,1);
}
assert.match(html, /mailai\.preferences\.theme\.v1/);
assert.match(source, /themeMediaQuery.*prefers-color-scheme: dark/);
assert.match(source, /themeMediaQuery\?\.addEventListener.*change/);
assert.match(source, /document\.documentElement\.dataset\.theme = resolved/);
assert.doesNotMatch(source,/insertAdjacentHTML\('beforeend', `<article class="preference-card/);
for (const selector of [
  '.reading-header .reading-actions',
  '.email-body :not(',
  '.compose-card',
  '.account-directory',
  '.assistant-panel',
  '.fetch-progress-box',
  '.attachment-center-card',
  '.contact-center-item',
  '.todo-center-item',
  '.compose-ai-panel-head',
  '.notification-choice:has',
  '.rule-scenario-card',
  '.allowlist-panel',
  '.signature-manager-body>aside',
  '#assistant-attachment-stage',
  '.app-preloader',
  '.threshold-panel',
  '.top-menu-popover',
  '.backup-item',
  '[data-system-panel="maintenance"] .admin-settings .connection-actions'
  ,'.compose-toolbar-status #draft-state'
  ,'.signature-list>button small'
  ,'.recipient-list'
  ,'.assistant-message.bot .assistant-bubble'
  ,'.assistant-answer>p'
  ,'.assistant-history-item.active'
  ,'.unified-inbox-button.active'
  ,'.mail-filter-group'
  ,'.filter-segments button.active'
  ,'.toast.info'
  ,'.assistant-bubble .operation-note'
  ,'#compose-signature-content'
  ,'.assistant-sources button:hover'
  ,'.secretary-card'
  ,'.secretary-card:hover'
  ,'#account-mailbox-nav .sidebar-account-identity b'
  ,'#account-mailbox-nav .sidebar-account-folders button.active'
  ,'.account-mailbox-group .nav-title button:hover'
  ,'.bulk-toolbar #bulk-count::before'
  ,'.email-item.bulk-selected'
  ,'.email-item.selected.bulk-selected'
  ,'#category-nav .category-empty-state'
  ,'#category-nav .category-empty-state button:hover'
  ,'.special-mail-body .rich-email-frame'
  ,'.special-mail-attachment-item'
]) assert.ok(themeCss.includes(selector), `Dark-theme surface is missing: ${selector}`);
assert.match(html, /theme\.css\?v=theme-15/);
const nodes = Object.fromEntries(['notification-options','notification-save-status','notification-account','notification-retry-load','notification-preference'].map(id => [id,{classList:{add(){this.hidden=true;},remove(){this.hidden=false;}}}]));
const ctx = {preferencesSaving:false,preferencesAccount:'',preferencesLoadRevision:0,account:{id:'a',user:'a@example.test'},
  document:{getElementById:id=>nodes[id]}, syncPreferenceChoices(){},
  activeMailAccount(){return ctx.account;}, api:async(url,options)=>{assert.equal(options.accountId,'a');return {notifications:'high_risk'};}};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('async function loadWorkspacePreferences()'),source.indexOf('function syncPreferenceChoices()')),ctx);
(async()=>{
  await ctx.loadWorkspacePreferences();
  assert.equal(nodes['notification-preference'].value,'high_risk');
  assert.equal(nodes['notification-options'].disabled,false);
  assert.equal(nodes['notification-save-status'].textContent,'已保存');
  ctx.api=async()=>{throw new Error('offline');};
  await ctx.loadWorkspacePreferences();
  assert.equal(nodes['notification-options'].disabled,true);
  assert.equal(nodes['notification-retry-load'].classList.hidden,false);
  assert.match(nodes['notification-save-status'].textContent,/重试/);
  let finish;
  ctx.api=()=>new Promise(resolve=>{finish=resolve;});
  const pending=ctx.loadWorkspacePreferences();
  ctx.account={id:'b',user:'b@example.test'};
  finish({notifications:'off'}); await pending;
  assert.equal(nodes['notification-preference'].value,'high_risk','Late account A response must not repaint B');
  ctx.account=null; await ctx.loadWorkspacePreferences();
  assert.equal(nodes['notification-options'].disabled,true);
  assert.match(nodes['notification-save-status'].textContent,/添加邮箱/);
  console.log('Preference choices, account-scoped loading, failure state and stale responses passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
