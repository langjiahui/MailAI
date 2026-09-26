const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('app/web/static/app.js', 'utf8');
const functionText = source.slice(source.indexOf('async function uploadSharedFileWithCard('), source.indexOf('function createFileList('));
const file = {name: 'report.zip', size: 25 * 1024 * 1024};
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };
function harness(api) {
  const actions = [], session = {attachmentReads: 0};
  const ctx = {draftSession: session, composeAccountId: 'a', api: (path, opts) => path.endsWith('/config') ? api(path, opts) : Promise.resolve({url:'https://example.test',name:'report.zip'}),
    saveCurrentDraft: async () => { session.id = 1; },
    composeMessageElement: () => ({querySelectorAll:()=>[],lastElementChild:{dataset:{}}}),
    renderSharedFileCards: () => {}, toast: (...args) => actions.push(args),
    openShareLinkDialog: async () => actions.push('opened'),
    uploadCosFile: async () => { actions.push('uploaded'); return {id:'task'}; },
    insertSharedLink: () => actions.push('inserted'),
    document: {getElementById: () => ({})}, createFileList: x => x,
  };
  vm.createContext(ctx); vm.runInContext(functionText, ctx);
  return {ctx, actions, session};
}
(async () => {
  for (const configured of [true, false]) {
    const pending = deferred();
    const {ctx, actions, session} = harness(() => pending.promise);
    const work = ctx.addLargeSharedFiles([file]);
    assert.equal(session.attachmentReads, 1, 'draft can close during configuration lookup');
    ctx.draftSession = {attachmentReads: 0}; ctx.composeAccountId = 'b';
    pending.resolve({credential_available: configured}); await work;
    assert.deepEqual(actions, [], 'late lookup acted on another draft');
    assert.equal(session.attachmentReads, 0);
    assert.equal(ctx.draftSession.attachmentReads, 0);
  }
  {
    const {ctx, actions, session} = harness(async () => ({credential_available: true}));
    const upload = deferred();
    ctx.uploadCosFile = () => upload.promise;
    const work = ctx.addLargeSharedFiles([file]);
    await new Promise(r => setImmediate(r));
    await ctx.addLargeSharedFiles([file]); // no concurrent duplicate
    ctx.draftSession = {}; ctx.composeAccountId = 'b';
    upload.resolve({url: 'https://example.test'}); await work;
    assert.ok(!actions.includes('inserted'));
    assert.equal(session.attachmentReads, 0);
  }
  {
    const {ctx, actions, session} = harness(async () => ({credential_available: true}));
    await ctx.addLargeSharedFiles([file]);
    assert.ok(actions.includes('uploaded') && actions.includes('inserted'));
    assert.equal(session.attachmentReads, 0);
  }
  console.log('Large-attachment draft/account isolation and duplicate upload guards passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
