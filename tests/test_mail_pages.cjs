const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../app/web/static/index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../app/web/static/style.css'), 'utf8');
const workspaceStyles = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.css'), 'utf8');
const groupStart = source.indexOf('function mailDateGroup(');
const groupEnd = source.indexOf('\nfunction fmtDate(', groupStart);
const groupContext = vm.createContext({Date, Number, String, mailaiT: () => null});
vm.runInContext(source.slice(groupStart, groupEnd), groupContext);
const referenceNow = new Date(2026, 8, 7, 12, 0, 0);
assert.deepEqual(
  JSON.parse(JSON.stringify(groupContext.mailDateGroup('2026-09-05T11:08:26+08:00', referenceNow))),
  {key:'2026-09-05', label:'9月5日'}
);
assert.deepEqual(
  JSON.parse(JSON.stringify(groupContext.mailDateGroup('2022-09-05T11:08:26+08:00', referenceNow))),
  {key:'2022-09-05', label:'2022年9月5日'},
  'The same month and day in another year must be a separate, year-labeled group'
);
assert.notEqual(
  groupContext.mailDateGroup('2022-09-05T11:08:26+08:00', referenceNow).key,
  groupContext.mailDateGroup('2026-09-05T11:08:26+08:00', referenceNow).key
);
assert.equal(groupContext.mailDateGroup('', referenceNow).label, '未知时间');
assert.match(source, /function syncSelectedEmailVisual\(/, 'Selected mail must have one centralized visual state');
assert.match(source, /async function revealEmailFromSource\(/, 'Source links must reveal and emphasize their mail item');
assert.match(source, /await revealEmailFromSource\(Number\(source\.dataset\.todoEmail\)\)/, 'Todo source links must use the source-navigation flow');
assert.match(source, /async function refreshMailboxIfChanged\(/, 'Background delivery must refresh the mailbox automatically');
assert.match(source, /window\.mailaiMailboxUpdated = \(\) => refreshMailboxIfChanged\(true\)/, 'Native delivery signal must trigger an immediate refresh');
assert.match(source, /new_high_risk_count/, 'Assistant alerts must distinguish high-risk mail from suspicious mail');
assert.match(source, /新增可疑邮件/, 'Suspicious mail must not be mislabeled as high risk');
assert.match(source, /function analyzeNewAssistantAlerts\(\)/, 'Alert action must analyze the newly alerted messages');
assert.match(source, /请只分析这次提醒的新增邮件/, 'Alert analysis must not mix in historical risk mail or overdue todos');
assert.match(source, /const sender = item\.from_name \|\| item\.from_addr/, 'Alert analysis must identify mail by sender instead of a database ID');
assert.match(source, /const received = item\.date \? fmtDate/, 'Alert analysis must include a recognizable received time');
assert.doesNotMatch(source, /items\.map\(item => `第\$\{item\.id\}封`\)/, 'Alert analysis must not expose internal database sequence numbers');
assert.match(source, /else if \(event\.type === 'status'\)/, 'Assistant must display stream retry and fallback status');
assert.match(source, /function assistantProgressHtml\(/, 'Assistant must render a reusable, accessible progress state');
assert.match(source, /const firstDelta = !answer\.trim\(\)/, 'The first answer text must replace progress immediately');
assert.match(source, /event\.detail_en \|\| event\.detail/, 'Assistant progress must explain the current stage and preserve the selected language');
assert.match(source, /if \(!retrying\) assistantHistory\.push/, 'Retry must not append the same user question to history twice');
assert.match(source, /event\.state === 'searching' && emailIds\?\.length/, 'Selected-mail analysis must be described as reading, not a mailbox search');
assert.match(source, /if \(sources\.length\) document\.getElementById\('assistant-scope-note'\)/, 'A zero-source event must not claim that zero mails were analyzed');
assert.match(workspaceStyles, /\.assistant-progress-copy small/, 'Assistant progress must use compact title and detail typography');
assert.match(styles, /compose-modal:has\(> \.compose-ai-panel:not\(\.hidden\)\) > \.compose-card \{ translate:-210px 0; \}/, 'Compose sidecar movement must not overwrite the modal transform animation');
assert.match(fs.readFileSync(path.join(__dirname, '../app/web/static/onboarding.js'), 'utf8'), /getElementById\('app'\)[\s\S]*append\(card\)/, 'Onboarding coach mark must share the app stacking context');
assert.match(source, /api\('\/api\/mailbox\/revision'\)/, 'Automatic refresh must use a lightweight revision endpoint');
assert.match(source, /loadData\(\{includeAncillary:false, silent:true\}\)/, 'Background refresh must use the silent list-rendering path');
assert.match(source, /if \(silent && signature === emailListRenderSignature\)/, 'Background refresh must skip unchanged visible list DOM');
assert.match(source, /container\.scrollTop = scrollTop/, 'Silent refresh must preserve the mail-list scroll position');
assert.match(styles, /\.email-list\.silent-refresh \.email-item\s*\{\s*animation:none/, 'Silent refresh must not replay mail entrance animations');
assert.match(html, /id="compose-ai-panel"/, 'Compose must expose a dedicated AI writing sidecar');
assert.match(html, /class="compose-perch-art"/, 'Compose must expose the shared Xiaoyou character mount');
assert.match(html, /MailAI Copilot · 写作模式/, 'Compose must describe AI writing as a mode of the same assistant');
assert.match(html, /class="compose-ai-scroll"/, 'AI sidecar must keep its header visible and use one content scroller');
assert.match(html, /id="compose-ai-preview"/, 'AI output must be previewed before it can change the body');
assert.match(source, /focus\(\{preventScroll:true\}\)/, 'Opening AI writing must not restore a stale scrolled position');
assert.match(source, /original_text: e\.body_text \|\| ''/, 'Reply compose must carry its own source email context');
assert.doesNotMatch(source, /original_text:selectedEmailDetail/, 'New compose must never reuse an unrelated selected email as AI context');
assert.match(source, /function applyComposeAiSuggestion\(mode\)/, 'AI suggestions require an explicit append or replace action');
assert.match(source, /return `<div class="assistant-answer">/, 'Assistant answers must use the structured readable renderer');
assert.match(source, /结论\|建议动作\|行动建议\|分析理由\|关键依据\|需要确认/, 'Assistant renderer must recognize scan-friendly answer sections');
assert.match(source, /setBulkOperationState\(true/, 'Bulk mail actions must expose a persistent busy state');
assert.match(source, /bulkOperationActive/, 'Bulk mail actions must prevent duplicate submissions');
assert.match(source, /const readSyncJobs = new Map\(\)/, 'Read-state writes must deduplicate the same account and message');
assert.match(source, /async function drainEmailReadSyncQueue/, 'Read-state writes must be serialized so IMAP timeouts cannot occupy every browser connection');
assert.match(source, /document\.body\.classList\.add\('compose-open'\)/, 'Opening compose must hand the global assistant into writing mode');
assert.match(html, /id="compose-message"[^>]+contenteditable="true"/, 'Current message must have its own editable region');
assert.match(html, /id="compose-block-format"[\s\S]*id="compose-font-name"[\s\S]*id="compose-font-size"/, 'Composer must expose paragraph, font and size controls');
assert.match(html, /data-command="underline"[\s\S]*data-command="justifyCenter"[\s\S]*data-command="insertOrderedList"/, 'Composer must expose expected rich text commands');
assert.match(html, /id="btn-insert-compose-image"[\s\S]*id="compose-image-input"/, 'Composer must support inline images');
assert.match(html, /id="btn-compose-preview"[\s\S]*id="compose-preview-modal"/, 'Composer must provide a sent-result preview');
assert.match(html, /id="compose-signature-select"[\s\S]*id="signature-manager"/, 'Composer must provide signature selection and management');
assert.match(source, /data-mailai-signature/, 'Draft and send HTML must preserve the selected signature boundary');
assert.match(source, /contactInput\.value = \[prefix, contactRecipientValue\(item\)\]\.filter\(Boolean\)\.join\(', '\)/, 'Choosing a contact must retain its display name without leaving a trailing comma');
const recipientStart = source.indexOf('function lastRecipientSeparatorIndex');
const recipientEnd = source.indexOf('function hideContactSuggestions', recipientStart);
const recipientContext = vm.createContext({String, mailaiT: () => null});
vm.runInContext(source.slice(recipientStart, recipientEnd), recipientContext);
assert.equal(recipientContext.normalizeRecipientText(' first@example.com， second@example.com； '), 'first@example.com, second@example.com');
assert.equal(recipientContext.normalizeRecipientText('first@example.com, '), 'first@example.com');
assert.equal(recipientContext.contactRecipientValue({name:'龚晓',email:'gongxiao@example.com'}), '龚晓 <gongxiao@example.com>');
assert.equal(recipientContext.contactRecipientValue({name:'张三,研发部',email:'zhang@example.com'}), '"张三,研发部" <zhang@example.com>');
assert.equal(recipientContext.normalizeRecipientText('"张三,研发部" <zhang@example.com>； 龚晓 <gong@example.com>'), '"张三,研发部" <zhang@example.com>, 龚晓 <gong@example.com>');
assert.match(source, /api\('\/api\/mail\/signatures'/, 'Signature state must be loaded from the active mailbox');
assert.match(html, /id="compose-quote"[^>]+contenteditable="false"/, 'Quoted history must be a separate read-only region');
assert.match(source, /body_html: composeBodyHtml\(\)/, 'Drafts and sends must serialize the current message together with its quote');
assert.match(source, /body: composeMessageText\(\)/, 'AI context must use only the current editable message');
assert.match(source, /message_html: '', quote_html: quoteOriginal\(e, mode\)/, 'Reply and forward flows must place the source mail below the editable message');
assert.match(source, /composeContext\.mode === 'forward' \? 'forward' : 'draft'/, 'Forward AI generation must use its own insertion semantics');
assert.match(html, /id="allowlist-form"/, 'Rule center must provide a domain allowlist form');
assert.match(source, /function renderAllowlist\(\)/, 'Rule center must render persisted domain allowlist entries');
assert.match(source, /class="rule-help"[\s\S]*class="rule-detail-popover"[\s\S]*什么时候会命中[\s\S]*白名单[\s\S]*技术标识/,
  'Every advanced rule card must expose understandable hover and keyboard-focus details');
assert.match(source, /item\.readonly === true[\s\S]*allowlist-source[\s\S]*item\.source/,
  'Rule center must identify configured read-only trust entries and their source');
assert.doesNotMatch(source, /chain-final \$\{c\.final_domain \? 'danger'/,
  'A resolved domain or IP must not be presented as dangerous by default');
assert.match(source, /const trusted = c\.trusted_final === true;/,
  'Configured trusted landing domains must use the backend trust decision');
assert.doesNotMatch(source, /trustedBusinessDomain/,
  'The client must not contain organization-specific trusted domains');
assert.match(source, /api\(`\/api\/rules\/allowlist\/\$\{entry\.kind\}\/\$\{entry\.id\}`/, 'Allowlist entries must support typed deletion');
assert.match(html, /id="rule-scenario-grid"/, 'Rule center must expose plain-language scenario controls');
assert.match(source, /function renderRuleScenarios\(\)/, 'Plain-language security scenarios must be rendered');
assert.match(source, /api\(`\/api\/rules\/categories\/\$\{encodeURIComponent\(category\)\}`/, 'Scenario sensitivity must persist through the API');
assert.match(html, /id="dashboard-attention-list"/, 'Dashboard must lead with an actionable review queue');
assert.match(html, /id="dashboard-outcome"/, 'Dashboard must explain what happened after risk detection');
assert.match(source, /function renderDashboardAttention\(items\)/, 'Dashboard risk items must be rendered as direct actions');
assert.match(source, /if \(!history\.length\) return ''/, 'Empty thread history must not render a misleading context card');
assert.match(source, /class="thread-timeline"/, 'Thread history must use a structured readable timeline');
assert.match(html, /id="btn-dashboard-review"[\s\S]*处理待确认邮件[\s\S]*<svg/, 'Dashboard primary action must use a composed label and icon');
assert.match(styles, /\.dashboard-priority-actions \.primary-action[\s\S]*border-radius:12px!important/, 'Dashboard primary action must visually belong to its rounded status card');
assert.match(source, /await revealEmailFromSource\(emailId\)/, 'Dashboard actions must navigate back to source mail evidence');
assert.match(styles, /\.sidebar,[\s\S]*scrollbar-width:\s*none !important/, 'Workspace panels must suppress native scrollbars even when macOS forces them visible');
assert.match(styles, /\.reading-pane::-webkit-scrollbar[\s\S]*display:\s*none !important/, 'WKWebView native scrollbar chrome must be removed');
assert.match(styles, /\.mailai-scroll-indicator[\s\S]*border-radius:\s*999px/, 'The replacement scroll indicator must have fully rounded ends');
assert.match(styles, /\.mailai-scroll-indicator\.is-visible\s*\{\s*opacity:\s*1/, 'The replacement indicator must only appear in its active state');
assert.doesNotMatch(styles, /\.(?:sidebar|email-list|reading-pane):hover::-webkit-scrollbar-thumb/, 'Main panel scrollbars must not remain visible merely because the pointer is hovering');
assert.match(source, /function showScrollIndicator\(target\)[\s\S]*classList\.add\('is-visible'\)[\s\S]*classList\.remove\('is-visible'\)[\s\S]*}, 520\)/, 'The custom indicator must automatically clear after scroll inactivity');
const start = source.indexOf('async function loadMailPages(');
const end = source.indexOf('// ===== 侧边栏统计', start);
let release;
let delayed = false;
let renderCount = 0;
const context = vm.createContext({
  mailaiT: () => null, Map, Promise, encodeURIComponent,
  document: {getElementById: () => null},
  mailLoadRevision: 0, draftListRevision: 0, currentServerFolder: '', currentFilter: {days: 9999},
  allEmails: [], allTodos: [], sentMessages: [], savedDrafts: [],
  updateSidebar() { renderCount++; }, updateDomainFilter() {}, applyFilters() {},
  loadAssistantAlerts() {},
  toast() { throw new Error('Unexpected error toast'); },
  async api(url) {
    if (!url.startsWith('/api/emails?')) return [];
    if (delayed) {
      delayed = false;
      await new Promise(resolve => { release = resolve; });
    }
    const offset = Number(new URL(url, 'http://local').searchParams.get('offset'));
    return Array.from({length: Math.max(0, Math.min(1000, 2505 - offset))}, (_, i) => ({id: offset + i}));
  },
});
vm.runInContext(source.slice(start, end), context);
(async () => {
  await context.loadData();
  assert.equal(context.allEmails.length, 2505, 'Normal mailbox view must retrieve all paginated metadata');
  assert.equal(context.allEmails.at(-1).id, 2504);
  assert.equal(renderCount, 1);
  delayed = true;
  const old = context.loadData();
  await new Promise(resolve => setImmediate(resolve));
  context.currentServerFolder = 'Other';
  await context.loadData();
  release();
  await old;
  assert.equal(renderCount, 2, 'Stale folder results must not repaint current list');
  let current = true;
  const original = context.api;
  context.api = async url => { const rows = await original(url); current = false; return rows; };
  assert.equal(await context.loadMailPages('/api/emails?days=9999', () => current), null);
  console.log('2505-row pagination, stale-load suppression and cancellation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
