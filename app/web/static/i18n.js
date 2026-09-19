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

function applyI18n(root) {
  const lang = currentI18nLanguage();
  const dict = I18N_MESSAGES[lang] || {};
  document.documentElement.lang = lang;
  const title = dict['app.title'];
  if (title) document.title = title;
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('[data-i18n]').forEach(node => {
    const value = dict[node.dataset.i18n];
    if (value) node.textContent = value;
  });
  for (const [attr, target] of [['data-i18n-placeholder', 'placeholder'], ['data-i18n-title', 'title'], ['data-i18n-aria', 'aria-label']]) {
    scope.querySelectorAll(`[${attr}]`).forEach(node => {
      const value = dict[node.getAttribute(attr)];
      if (value) {
        if (target === 'aria-label') node.setAttribute('aria-label', value);
        else node[target] = value;
      }
    });
  }
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
