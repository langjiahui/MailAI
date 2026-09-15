const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../app/web/static/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.css'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../app/web/server.py'), 'utf8');

assert.match(js, /<span>往来邮件<\/span>/, 'Reading actions should expose correspondence');
assert.match(js, /\/correspondence\?limit=50/, 'The drawer should use the scoped correspondence endpoint');
assert.match(js, /item\.direction === 'sent' \? '发出' : '收到'/, 'Rows should distinguish sent and received mail');
assert.match(js, /还没有往来邮件/, 'The drawer needs a useful empty state');
assert.match(js, /await revealEmailFromSource\(Number\(emailId\)\)/, 'History rows should navigate to the selected message');
assert.match(js, /data-correspondence-select=/, 'Each correspondence result should expose an individual selector');
assert.match(js, /data-correspondence-select-all/, 'Correspondence results should support selecting all deletable mail');
assert.match(js, /async function deleteSelectedCorrespondence\(/, 'Selected correspondence mail should support a guarded delete flow');
assert.match(js, /function closeCorrespondence\(\) \{[\s\S]*if \(correspondenceBusy\)/, 'The drawer must not close during an in-flight deletion');
assert.match(js, /确认将选中的 \$\{ids\.length\} 封/, 'Deleting correspondence mail must require explicit confirmation with a count');
assert.match(js, /body:JSON\.stringify\(\{ids:batch, action:'trash'\}\)/, 'Correspondence deletion must use the server-resolved trash operation');
assert.match(js, /correspondenceAccountId = source\.accountId \|\| activeMailAccount\(\)\?\.id/, 'The drawer must retain the source mailbox identity');
assert.match(js, /const accountId = correspondenceAccountId \|\| selectedEmailAccountId/, 'Deletion must remain scoped to the mailbox used by the result drawer');
assert.match(js, /start \+= 100/, 'Large selections should be processed in bounded batches');
assert.match(js, /status:'trash'/, 'Successful rows should immediately become non-selectable trash entries');
assert.match(html, /id="correspondence-drawer"[\s\S]*aria-labelledby="correspondence-title"/, 'A labelled modal drawer is required');
assert.match(css, /\.correspondence-item:hover/, 'History rows should have a polished interactive state');
assert.match(css, /\.correspondence-item\.selected/, 'Selected correspondence rows need an explicit visual state');
assert.match(html, /id="correspondence-processing"[\s\S]*correspondence-processing-spinner/, 'Deletion should expose a dedicated blocking wait state');
const deleteFlow = js.slice(js.indexOf('async function deleteSelectedCorrespondence'), js.indexOf('async function openCorrespondenceEmail'));
assert.doesNotMatch(deleteFlow, /await loadData\(\)/, 'Mailbox refresh must not extend the visible deletion wait state');
assert.match(deleteFlow, /loadData\(\)\.catch/, 'Background refresh failures should be handled');
assert.match(css, /@keyframes correspondence-progress/, 'The wait state should include visible indeterminate progress');
assert.match(server, /@app\.get\("\/api\/emails\/\{email_id\}\/correspondence"\)/, 'The correspondence endpoint must exist');
assert.match(server, /@app\.get\("\/api\/mail\/contacts\/correspondence"\)/, 'Contacts need a direct correspondence endpoint');
assert.match(js, /function reloadCorrespondence\(\)/, 'Retry should preserve whether the drawer was opened from a message or contact');

console.log('Correspondence drawer entry, states, direction and navigation are wired');
