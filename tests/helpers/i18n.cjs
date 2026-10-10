/* Use the production text formatter in isolated UI function tests. DOM observation
 * is exercised by the browser suite; existing stubs still own their fake DOM. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.join(__dirname, '../../app/web/static');
const sources = ['i18n.js', 'i18n-catalog.js', 'i18n-runtime.js'].map(file => fs.readFileSync(path.join(base, file), 'utf8')).join('\n');
module.exports = function i18nContext(target = {}) {
  const sandbox = {document: undefined, localStorage: target.localStorage};
  vm.createContext(sandbox);
  vm.runInContext(sources + '\nthis.helpers = {mailaiText, mailaiTemplate, mailaiBindUI, mailaiSystemMessage, mailaiLabelHTML, mailaiCopySource, currentI18nLanguage};', sandbox);
  for (const [key, value] of Object.entries(sandbox.helpers)) if (!(key in target)) target[key] = value;
  return target;
};
