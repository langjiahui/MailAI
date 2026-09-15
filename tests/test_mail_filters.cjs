const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/web/static/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app/web/static/app.js'), 'utf8');

assert.match(html, /筛选条件[\s\S]*收件时间[\s\S]*重要程度[\s\S]*由 MailAI 判断处理紧急程度/);
assert.match(html, /发件人域名[\s\S]*发件邮箱中 @ 后面的部分/);
assert.match(html, /id="filter-days"[\s\S]*class="active" data-value="9999"/, 'All time must be the visible default');
assert.match(js, /days:\s*9999/, 'All time must be the state default');
assert.match(js, /specialMailbox = ''; currentServerFolder = '';/, 'Clear must leave special/server mailboxes');
assert.match(js, /setSegmentedFilter\('filter-days', '9999'\)/, 'Clear must update the time control');
assert.match(js, /filter === 'verdict'[\s\S]*currentFilter\.verdict = currentFilter\.verdict === value \? '' : value;/,
  'Risk navigation must toggle without replacing the mailbox scope');
assert.match(js, /filter === 'category'[\s\S]*currentFilter\.category = currentFilter\.category === value \? '' : value;/,
  'AI category navigation must toggle without replacing the mailbox or risk scope');
assert.match(js, /specialMailbox && \(filter === 'verdict' \|\| filter === 'category'\)[\s\S]*请先选择收件箱/,
  'Received-mail facets must not silently change sent or draft mailbox state');
assert.doesNotMatch(js, /currentFilter\.category === '' && v === '未分类'/,
  'Uncategorized must not look selected until the user selects it');
assert.match(js, /function mailVerdictKey[\s\S]*getRiskLabel[\s\S]*mailVerdictKey\(e\) === verdict/,
  'Risk counts and filtering must use the same classification as mail cards');
assert.match(html, /facet-scope-label[\s\S]*风险等级[\s\S]*facet-scope-label[\s\S]*AI 分类|风险等级[\s\S]*facet-scope-label[\s\S]*AI 分类[\s\S]*facet-scope-label/,
  'Risk and AI category sections must disclose their mailbox scope');
assert.match(js, /全局搜索返回完整历史[\s\S]*received >= cutoff/,
  'Time range must also constrain global search results');
assert.match(js, /当前条件下没有邮件[\s\S]*查看全部分类/,
  'An empty filtered scope must offer a clear route back to all categories');
assert.match(js, /还没有可分类的邮件[\s\S]*同步邮件/,
  'A genuinely empty mailbox must explain that categories appear after sync');
assert.match(js, /renderCategoryNav\(list\);[\s\S]*if \(currentFilter\.category\)/,
  'AI category counts must follow every other filter while remaining switchable as a facet');
const mailboxBadgeRefresh = js.slice(js.indexOf('function updateSidebar()'), js.indexOf('function currentMailboxScopeLabel()'));
for (const facet of ['phishing', 'suspicious', 'clean', 'unreviewed']) {
  assert.doesNotMatch(mailboxBadgeRefresh, new RegExp(`${facet}:`),
    `Late mailbox-folder refresh must not overwrite the ${facet} count for the selected scope`);
}
assert.match(js, /function applyFilters\(\{silent = false\} = \{\}\)[\s\S]*mailVerdictKey\(e\) === verdict[\s\S]*renderCategoryNav\(list\)/,
  'Risk and category badges must be owned by the current filtered mailbox scope');

console.log('Mail filters have clear semantics and a complete reset path');
