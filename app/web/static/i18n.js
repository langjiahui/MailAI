/* 国际化（i18n）框架与首个英文切片。
 *
 * 约定：
 * - 中文（zh-CN）是源码语言：HTML 中的静态文案即中文原文，无需字典；
 * - 其他语言以键值字典登记在 I18N_MESSAGES 中，键为点分层级的稳定 ID
 *   （如 nav.compose），缺失的键回落到 HTML 中的中文原文，永不显示空白；
 * - 静态文案用 data-i18n 属性标记：data-i18n（文本）、data-i18n-placeholder、
 *   data-i18n-title、data-i18n-aria（aria-label），applyI18n 统一套用；
 * - 动态渲染的 JS 文案用 mailaiT('some.key') 取值；语言选择只保存在本机
 *   localStorage（与主题、密度一致），切换后立即套用并派发
 *   'mailai:language-changed' 事件，动态模块可监听后重渲染。
 */
const I18N_DEFAULT_LANG = 'zh-CN';
const I18N_STORAGE_KEY = 'mailai-language';

const I18N_MESSAGES = {
  en: {
    'app.title': 'MailAI · Mail Security & Productivity Assistant',
    'app.preloader': 'Preparing your mail workspace',
    'search.placeholder': 'Search subject, sender, body or pinyin...',
    'nav.compose': 'Compose',
    'nav.contacts': 'Contacts',
    'nav.attachments': 'Attachments',
    'nav.todos': 'To-dos',
    'nav.security': 'Security',
    'nav.sync': 'Sync',
    'nav.digest': 'Daily Digest',
    'nav.settings': 'Settings',
    'security.heading': 'Security Management',
    'security.headingHint': 'Review, rules and handling policy',
    'security.dashboard': 'Security Dashboard',
    'security.dashboardHint': 'Trends and outcomes',
    'security.rules': 'Rule Center',
    'security.rulesHint': 'Rules and scoring weights',
    'security.policy': 'Handling Policy',
    'security.policyHint': 'Default action for high-risk mail',
    'policy.observe': 'Observe only',
    'policy.review': 'Manual review',
    'policy.auto': 'Auto-handle',
    'settings.title': 'Settings',
    'settings.subtitle': 'Manage display preferences, mail accounts and local data.',
    'settings.back': 'Back to inbox',
    'tabs.preferences': 'General',
    'tabs.account': 'Accounts',
    'tabs.maintenance': 'Data & Maintenance',
    'tabs.guide': 'Guide',
    'tabs.about': 'About & Privacy',
    'prefs.intro': 'Make the workspace fit your habits',
    'prefs.introHint': 'Adjust reading and reminders; changes save automatically.',
    'prefs.display': 'Display & Reading',
    'prefs.displayHint': 'Only affects this device',
    'prefs.theme': 'Theme',
    'prefs.themeHint': 'Pick a fixed palette, or follow the system light/dark setting.',
    'theme.light': 'Light',
    'theme.lightHint': 'Keep the fresh default palette',
    'theme.dark': 'Dark',
    'theme.darkHint': 'Lower brightness for night reading',
    'theme.system': 'System',
    'theme.systemHint': 'Switch automatically with the device theme',
    'prefs.density': 'List Density',
    'prefs.densityHint': 'Choose more breathing room, or see more mails per screen.',
    'density.comfortable': 'Comfortable',
    'density.comfortableHint': 'Shows previews, easier to read',
    'density.compact': 'Compact',
    'density.compactHint': 'Shorter previews, more mails',
    'prefs.serverFolders': 'Show server folders',
    'prefs.serverFoldersHint': 'Show the raw IMAP folders in the sidebar.',
    'prefs.serverFoldersNote': 'Off by default; background sync is unaffected.',
    'prefs.language': 'Interface Language',
    'prefs.languageHint': 'Switch the interface language; only affects this device.',
    'prefs.notifications': 'Mail Notifications',
    'prefs.notificationsHint': 'Configurable per mailbox',
    'dash.eyebrow': 'Security Operations',
    'dash.title': 'Handle risks first, then trends and outcomes',
    'dash.period': 'Period',
    'dash.days7': 'Last 7 days',
    'dash.days30': 'Last 30 days',
    'dash.refresh': 'Refresh',
    'dash.back': 'Back to mail',
    'kpi.pending': 'Awaiting review',
    'kpi.pendingHint': 'Needs manual judgment',
    'kpi.risk': 'Risk mail this period',
    'kpi.auto': 'Auto-handled',
    'kpi.feedback': 'Manual corrections',
    'kpi.feedbackHint': 'False positive / missed reports',

    // 批一：主干界面（侧栏 / 列表 / 阅读区 / 写信）
    'app.tagline': 'Mail Security & Productivity Assistant',
    'nav.openFolders': 'Open mail folders',
    'side.workbench': 'Workbench',
    'side.attachmentCenter': 'Attachment Center',
    'side.todoCenter': 'To-do Center',
    'side.accounts': 'Mail Accounts',
    'side.addAccount': 'Add account',
    'side.folders': 'Mail Folders',
    'side.all': 'All Mail',
    'side.favorites': 'Favorites',
    'side.inbox': 'Inbox',
    'side.sent': 'Sent',
    'side.drafts': 'Drafts',
    'side.trash': 'Trash',
    'side.quarantine': 'Quarantine',
    'side.spam': 'Spam',
    'side.serverFolders': 'Server Folders',
    'side.newFolder': 'New folder',
    'side.loading': 'Loading…',
    'side.risk': 'Risk Level',
    'side.inInbox': 'In inbox',
    'side.categories': 'AI Categories',
    'side.closeFolders': 'Close folders',
    'risk.phishing': 'Phishing',
    'risk.suspicious': 'Suspicious',
    'risk.clean': 'Clean',
    'risk.unreviewed': 'Pending analysis',
    'filter.title': 'Filters',
    'filter.titleHint': 'All selected conditions apply together',
    'filter.days': 'Received',
    'filter.daysHint': 'By actual received time',
    'filter.7d': '7 days',
    'filter.30d': '30 days',
    'filter.all': 'All',
    'filter.priority': 'Priority',
    'filter.priorityHint': 'Urgency judged by MailAI',
    'filter.any': 'Any',
    'filter.high': 'High',
    'filter.medium': 'Medium',
    'filter.low': 'Low',
    'filter.domain': 'Sender Domain',
    'filter.domainHint': 'The part after @ in the sender address',
    'filter.anyDomain': 'Any domain',
    'filter.unread': 'Unread only',
    'filter.unreadHint': 'Only show unread incoming mail',
    'filter.attachments': 'Has attachments',
    'filter.attachmentsHint': 'Only show mail with attachments',
    'filter.clear': 'Clear all',
    'resize.sidebar': 'Resize folder pane',
    'resize.list': 'Resize mail list',
    'list.sortDesc': 'Newest first',
    'list.sortAsc': 'Oldest first',
    'list.sortScore': 'By risk score',
    'list.fetchMore': 'Sync older mail',
    'list.fetchAll': 'Sync all history',
    'bulk.read': 'Read',
    'bulk.readTitle': 'Mark as read',
    'bulk.unread': 'Unread',
    'bulk.unreadTitle': 'Mark as unread',
    'bulk.star': 'Star',
    'bulk.starTitle': 'Add star',
    'bulk.trash': 'Trash',
    'bulk.trashTitle': 'Move to Trash',
    'bulk.move': 'Move to…',
    'bulk.moveAria': 'Move selected mail',
    'bulk.done': 'Done',
    'bulk.cancel': 'Cancel selection',
    'bulk.actionsAria': 'Bulk mail actions',
    'read.emptyTitle': 'Select a mail to read',
    'read.emptyHint': 'Summary, security result and body appear here',
    'compose.title': 'Compose',
    'compose.close': 'Save draft and close',
    'compose.from': 'From',
    'compose.fromAria': 'Select sender account',
    'compose.to': 'To',
    'compose.toPh': 'Type or pick from contacts',
    'compose.toBook': 'Add recipient from contacts',
    'compose.ccBcc': 'Cc / Bcc',
    'compose.cc': 'Cc',
    'compose.ccBook': 'Add Cc from contacts',
    'compose.bcc': 'Bcc',
    'compose.bccBook': 'Add Bcc from contacts',
    'compose.optional': 'Optional',
    'compose.subject': 'Subject',
    'compose.subjectPh': 'Subject',
    'compose.aiLabel': 'AI Compose',
    'compose.aiHint': 'Tap to write together',
    'compose.aiAria': 'AI compose: expand or collapse the writing panel',
    'compose.format': 'Body format',
    'compose.preview': 'Preview',
    'compose.previewTitle': 'Preview what recipients see',
    'compose.attach': 'Attachments',
    'compose.paste': 'Paste',
    'compose.pasteTitle': 'Paste attachments copied from the file manager',
    'compose.noSignature': 'No signature',
    'compose.signatureAria': 'Select mail signature',
    'compose.manage': 'Manage',
    'compose.manageTitle': 'Manage signatures',
    'compose.autosave': 'Draft autosaved',
    'compose.autosaveTitle': 'Drafts are stored locally only and never synced to the mail server',
    'compose.attachHint': 'Drag files in or paste attachments · 20MB each / 25MB total · click to preview',
    'compose.bodyPh': 'Write your message…',
    'compose.signatureAria': 'Mail signature',
    'compose.quoteAria': 'Quoted original mail',
    'compose.quoteLabel': 'Quoted original mail',
    'compose.quoteHint': 'Never rewritten by AI',
    'compose.discard': 'Discard draft',
    'compose.discardTitle': 'Delete this local draft',
    'compose.saveDraft': 'Save draft & close',
    'compose.saveDraftTitle': 'Save to the local Drafts box and continue later',
    'compose.sendNoSmtp': 'Send (SMTP not configured)',
    'compose.sendNoSmtpTitle': 'Available after SMTP is configured',
    'fmt.p': 'Body',
    'fmt.h2': 'Heading',
    'fmt.h3': 'Subheading',
    'fmt.quote': 'Quote',
    'fmt.styleAria': 'Paragraph style',
    'fmt.fontAria': 'Font',
    'fmt.sizeAria': 'Font size',
    'fmt.sizeS': 'Small',
    'fmt.sizeNormal': 'Normal',
    'fmt.sizeM': 'Medium',
    'fmt.sizeL': 'Large',
    'fmt.sizeXL': 'XL',
    'fmt.undo': 'Undo',
    'fmt.redo': 'Redo',
    'fmt.bold': 'Bold',
    'fmt.italic': 'Italic',
    'fmt.underline': 'Underline',
    'fmt.strike': 'Strikethrough',
    'fmt.color': 'Text color',
    'fmt.highlight': 'Highlight color',
    'fmt.left': 'Align left',
    'fmt.center': 'Align center',
    'fmt.right': 'Align right',
    'fmt.ul': 'Bullet list',
    'fmt.ol': 'Numbered list',
    'fmt.outdent': 'Decrease indent',
    'fmt.indent': 'Increase indent',
    'fmt.link': 'Insert link',
    'fmt.linkText': 'Link',
    'fmt.image': 'Insert inline image',
    'fmt.imageText': 'Image',
    'fmt.clear': 'Clear formatting',
    'fmt.clearText': 'Clear',
    'copilot.kicker': 'MailAI Copilot · Writing',
    'copilot.panelAria': 'AI writing assistant',
    'copilot.scene': 'Tell me what this mail should achieve',
    'copilot.status': 'Same AI as the mailbox guardian; drafts go to preview only, never overwrite your text.',
    'copilot.close': 'Collapse AI writing assistant',
    'copilot.request': 'What should this mail achieve?',
    'copilot.requestPh': "E.g.: invite the project team to Friday's review and remind everyone to prepare demo materials",
    'copilot.context': 'Reference content',
    'copilot.basis': 'Fill in at least one item',
    'copilot.ctxSubject': 'Subject',
    'copilot.ctxRecipients': 'Recipients',
    'copilot.ctxOriginal': 'Original mail',
    'copilot.ctxBody': 'Current body',
    'copilot.ctxAttachments': 'Attachment names',
    'copilot.tone': 'Tone',
    'copilot.toneFormal': 'Formal',
    'copilot.toneConcise': 'Concise',
    'copilot.toneFriendly': 'Friendly',
    'copilot.toneFirm': 'Firm',
    'copilot.length': 'Length',
    'copilot.lengthShort': 'Short',
    'copilot.lengthMedium': 'Medium',
    'copilot.lengthLong': 'Detailed',
    'copilot.generate': 'Generate draft',
    'copilot.quickAria': 'AI quick rewrite',
    'copilot.polish': 'Polish',
    'copilot.shorten': 'Shorten',
    'copilot.translateEn': 'Translate to English',
    'copilot.previewTitle': 'AI Draft Preview',
    'copilot.previewCheck': 'Verify facts, dates and recipients',
    'copilot.regenerate': 'Regenerate',
    'copilot.append': 'Append to body',
    'copilot.replace': 'Replace body',
    'copilot.privacy': 'Only checked content is sent to your configured AI model; attachment names are shared, not their content.',
    'preview.eyebrow': 'Sending Preview',
    'preview.title': 'Mail Preview',
    'preview.to': 'To',
    'preview.subject': 'Subject',
    'preview.close': 'Close preview',
    'preview.frame': 'Mail body preview',
    'sig.eyebrow': 'Personalized Sending',
    'sig.title': 'Signatures',
    'sig.close': 'Close signature manager',
    'sig.new': 'New signature',
    'sig.profile': 'Sender Profile',
    'sig.profileHint': 'Used for signature display and AI generation',
    'sig.styleProfessional': 'Professional',
    'sig.styleWarm': 'Warm & friendly',
    'sig.styleTech': 'Tech & creative',
    'sig.styleExecutive': 'Executive',
    'sig.name': 'Name',
    'sig.jobTitle': 'Title',
    'sig.department': 'Department',
    'sig.company': 'Company',
    'sig.phone': 'Phone',
    'sig.email': 'Email',
    'sig.website': 'Website',
    'sig.aiGenerate': 'AI: generate 3 creative signatures',
    'sig.sigName': 'Signature name',
    'sig.sigNamePh': 'E.g.: Work signature',
    'sig.content': 'Signature content',
    'sig.contentHint': 'Edit text and formatting directly',
    'sig.makeDefault': 'Set as default signature',
    'sig.delete': 'Delete signature',
    'sig.cancel': 'Cancel',
    'sig.save': 'Save signature',
    'fb.title': 'Help MailAI improve',
    'fb.action': 'Mark as false positive',
    'fb.close': 'Close',
    'fb.reasons': 'Main reasons',
    'fb.reasonsHint': 'Multi-select, or add a note below',
    'fb.note': 'Additional note',
    'fb.optional': 'Optional',
    'fb.privacy': 'Feedback is only used for local rule calibration and audit logs, never uploaded.',
    'fb.cancel': 'Cancel',
    'fb.confirm': 'Confirm',
    'sync.expand': 'Expand sync details',
    'sync.pulling': 'Syncing mail',
    'sync.wait': 'Please wait...',
    'sync.pause': 'Pause sync',

    // 动态文案（JS 用 mailaiT 取值，|| 回落中文）
    'list.allInboxes': 'All inboxes',
    'list.localArchive': 'Local archive',
    'list.countMail': ' mails',
    'list.countDraft': ' drafts',
    'list.countScoped': '{count} mails (of {total} in scope)',
    'list.countScopedTitle': '{count} mails match the filters; {total} in the mailbox scope',
    'list.loadingTrash': 'Loading deleted mail…',
    'list.loadingFolder': 'Syncing server folder…',
    'read.favorite': 'Favorite',
    'read.favorited': 'Favorited',
    'read.todo': 'Add to to-dos',
    'read.remind': 'Remind later',
    'read.summary': 'Summarize',
    'read.image': 'Analyze images',
    'read.ask': 'Ask Xiaoyou',
    'semantic.needAccount': 'Add a mailbox first',
    'semantic.cardTitle': 'Semantic Search (Beta)',
    'semantic.cardDesc': 'Understands mails with similar meaning via a local embedding model, improving the assistant\'s retrieval',
    'semantic.enable': 'Enable semantic search',
    'semantic.enableHint': 'First reindex downloads the model (~100MB); data never leaves this device',
    'semantic.note': 'When disabled, the assistant uses keyword search. Source checkouts additionally need the optional dependency (requirements-semantic.txt).',
    'semantic.reindexBtn': 'Rebuild index',
    'semantic.noDeps': 'Optional component not installed (requirements-semantic.txt)',
    'semantic.indexed': 'Indexed {n} mails',
    'semantic.notIndexed': 'Not indexed yet',
    'semantic.error': 'Unable to read status',
    'semantic.saving': 'Saving…',
    'semantic.enabledToast': 'Semantic search enabled',
    'semantic.disabledToast': 'Semantic search disabled',
    'semantic.saveFailed': 'Save failed, please retry',
    'semantic.reindexing': 'Rebuilding index (first run downloads the model, please wait)…',
    'semantic.reindexed': 'Index rebuilt: {n} mails',
  },
};

function currentI18nLanguage() {
  try {
    const saved = localStorage.getItem(I18N_STORAGE_KEY);
    if (saved && (saved === I18N_DEFAULT_LANG || I18N_MESSAGES[saved])) return saved;
  } catch (_) {}
  return I18N_DEFAULT_LANG;
}

function mailaiT(key) {
  const lang = currentI18nLanguage();
  if (lang === I18N_DEFAULT_LANG) return null;
  return I18N_MESSAGES[lang]?.[key] ?? null;
}

// 首次套用前缓存节点的中文原文，切回中文（或键缺失）时恢复，绝不留残留英文。
const i18nOriginals = new WeakMap();

function i18nApply(node, slot, key, dict, read, write) {
  if (!key) return;
  let original = i18nOriginals.get(node);
  if (!original) { original = {}; i18nOriginals.set(node, original); }
  if (!(slot in original)) original[slot] = read();
  const value = dict[key] ?? original[slot];
  if (value !== undefined && value !== null) write(value);
}

function applyI18n(root) {
  const lang = currentI18nLanguage();
  const dict = I18N_MESSAGES[lang] || {};
  document.documentElement.lang = lang;
  if (applyI18n._originalTitle === undefined) applyI18n._originalTitle = document.title;
  document.title = dict['app.title'] || applyI18n._originalTitle;
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('[data-i18n]').forEach(node => {
    i18nApply(node, 'text', node.dataset.i18n, dict,
      () => node.textContent, value => { node.textContent = value; });
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach(node => {
    i18nApply(node, 'placeholder', node.getAttribute('data-i18n-placeholder'), dict,
      () => node.placeholder, value => { node.placeholder = value; });
  });
  scope.querySelectorAll('[data-i18n-title]').forEach(node => {
    i18nApply(node, 'title', node.getAttribute('data-i18n-title'), dict,
      () => node.title, value => { node.title = value; });
  });
  scope.querySelectorAll('[data-i18n-aria]').forEach(node => {
    i18nApply(node, 'aria', node.getAttribute('data-i18n-aria'), dict,
      () => node.getAttribute('aria-label'), value => node.setAttribute('aria-label', value));
  });
  // 富文本编辑器用 data-placeholder 自定义属性（CSS attr() 读取），
  // 不是原生 placeholder，需要单独映射。
  scope.querySelectorAll('[data-i18n-data-placeholder]').forEach(node => {
    i18nApply(node, 'dplaceholder', node.getAttribute('data-i18n-data-placeholder'), dict,
      () => node.getAttribute('data-placeholder'), value => node.setAttribute('data-placeholder', value));
  });
}

function setI18nLanguage(lang) {
  if (lang !== I18N_DEFAULT_LANG && !I18N_MESSAGES[lang]) return;
  try { localStorage.setItem(I18N_STORAGE_KEY, lang); } catch (_) {}
  applyI18n();
  document.dispatchEvent(new CustomEvent('mailai:language-changed', { detail: { language: lang } }));
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    applyI18n();
    const choice = document.getElementById('interface-language');
    if (choice) {
      choice.value = currentI18nLanguage();
      choice.addEventListener('change', () => setI18nLanguage(choice.value));
    }
  });
}
