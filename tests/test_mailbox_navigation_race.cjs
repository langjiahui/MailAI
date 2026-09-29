const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const onNavClick = source.slice(source.indexOf('async function onNavClick('), source.indexOf('function bindNavItems('));
let loads = 0;
let renders = 0;
let failures = 0;
let responses = [true];
const button = {
  dataset: {filter:'status', value:'inbox'},
  textContent:'收件箱 208',
  closest(selector) { return selector === '#folder-nav' ? {} : null; },
};
const context = vm.createContext({
  bulkOperationActive:false,
  currentFilter:{status:'trash', days:9999, verdict:'', category:''},
  currentServerFolder:'', specialMailbox:'', unifiedMailbox:false,
  mailboxNavigationRevision:0,
  resetReadingPane(){}, beginMailboxTransition(){}, finishMailboxTransition(){},
  activeMailAccount(){return {id:'account'};}, selectedMailboxAccountId:'',
  loadData:async()=>{loads++;return responses.shift();},
  updateActiveNav(){}, applyFilters(){renders++;}, showMailboxLoadFailure(){failures++;},
  toast(){}, console,
});
vm.runInContext(onNavClick, context);
const click = () => context.onNavClick({target:{closest:selector=>selector === '.nav-item' ? button : null}, preventDefault(){}, stopPropagation(){}});

(async()=>{
  await click();
  assert.equal(loads, 1, 'returning from Trash must reload Inbox rows');
  assert.equal(context.currentFilter.status, 'inbox');
  assert.equal(failures, 0);

  context.currentFilter.status = 'trash';
  responses = [null, true];
  await click();
  assert.equal(loads, 3, 'a superseded load should be retried for the active navigation');
  assert.equal(failures, 0);

  context.currentFilter.status = 'trash';
  responses = [false];
  await click();
  assert.equal(failures, 1, 'a real failure must show retry instead of an empty mailbox');
  assert.equal(renders, 0, 'stale rows must not be filtered into the failed mailbox');
  console.log('Inbox navigation reload and race handling passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
