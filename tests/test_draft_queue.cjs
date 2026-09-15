const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app/web/static/app.js'), 'utf8');
const start = source.indexOf('function draftFingerprint(');
const end = source.indexOf('\nfunction queueDraftSave()', start);
const calls = [];
let release;
const barrier = new Promise(resolve => { release = resolve; });
const context = vm.createContext({
  composeAccountId: 'draft-test-account',
  Promise, JSON, Date, clearTimeout, setTimeout,
  draftSaveTimer: null, draftMaxSaveTimer:null, draftListRevision:0, currentDraftId: null, savedDrafts: [], specialMailbox:'',
  draftSession: {id: null, pending: Promise.resolve(), canceled: false, busy: false},
  document: {getElementById: () => ({textContent: '',dataset:{}})},
  draftPayload: () => ({id: null, subject: 'draft', attachments: []}),
  updateSidebar() {},
  async api(url, options) {
    if (!options?.method) return [];
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) await barrier;
    return {id: 42};
  },
});
vm.runInContext(source.slice(start, end), context);
context.draftHasContent = () => true;
context.draftEditingFingerprint = () => 'edited';
context.activeMailAccount = () => ({id:'draft-test-account'});
(async () => {
  const first = context.saveCurrentDraft();
  context.draftPayload = () => ({id:null,subject:'newer edit',attachments:[]});
  const second = context.saveCurrentDraft();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'Concurrent saves must serialize');
  release();
  await Promise.all([first, second]);
  assert.equal(calls[0].id, null);
  assert.equal(calls[1].id, 42, 'Second save must update the first draft');
  assert.equal(calls[1].subject, 'newer edit');
  await context.saveCurrentDraft();
  assert.equal(calls.length,2,'Unchanged content must not write again');
  context.draftSession.canceled = true;
  await context.saveCurrentDraft();
  assert.equal(calls.length, 2, 'Canceled editor cannot recreate a discarded draft');
  context.draftSession.canceled = false;
  let releaseEdit;
  const editBarrier = new Promise(resolve=>{releaseEdit=resolve;});
  context.api = async (url, options) => {
    const payload = JSON.parse(options.body); calls.push(payload);
    if (payload.subject === 'temporary') await editBarrier;
    return {id:42};
  };
  context.draftPayload = () => ({id:42,subject:'temporary',attachments:[]});
  const temporary = context.saveCurrentDraft();
  await new Promise(resolve=>setImmediate(resolve));
  context.draftPayload = () => ({id:42,subject:'newer edit',attachments:[]});
  const reverted = context.saveCurrentDraft();
  releaseEdit(); await Promise.all([temporary,reverted]);
  assert.equal(calls.at(-1).subject,'newer edit','Reverting during an in-flight save must persist the reverted content');
  assert.equal(context.savedDrafts[0].subject,'newer edit','Cached draft must match disk without reloading the whole list');
  context.api = async () => {throw Error('disk failure');};
  context.draftPayload = () => ({id:42,subject:'failed edit',attachments:[]});
  await assert.rejects(context.saveCurrentDraft(),/disk failure/);
  context.draftPayload = () => ({id:42,subject:'newer edit',attachments:[]});
  await context.saveCurrentDraft(); // Disk already holds the reverted version.
  context.draftSession = {id:null,pending:Promise.resolve(),initialEdit:'empty'};
  context.draftHasContent = () => false;
  context.draftEditingFingerprint = () => 'empty';
  await context.saveCurrentDraft(); // Must not call the failing API for an empty draft.
  console.log('PASS serialized drafts, no-op saves, cancellation, revert during save, cache freshness and empty editor');
})().catch(error => { console.error(error); process.exitCode = 1; });
