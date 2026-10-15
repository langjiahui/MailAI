const i18nContext = require('./helpers/i18n.cjs');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const scope={window:{},mdToHtml:text=>String(text).replace(/</g,'&lt;')};vm.createContext(i18nContext(scope));vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/web/static/mail-reading-folds.js'),'utf8'),scope);
const original='当前结论\n-- \n张三\n-----Original Message-----\nFrom: old@example.test\nDate: 2026-01-01\n历史正文';
assert.equal(scope.window.mailaiReadingText({body_text:original}),original,'Signatures and quotes remain complete and in source order');
const unchanged='普通邮件中的报价\n周五交付，不是历史引用。';assert.equal(scope.window.mailaiReadingText({body_text:unchanged}),unchanged);
const html=scope.window.mailaiReadingText({body_text:'当前正文\n-----Original Message-----\n<script>bad()</script>'});assert(html.includes('-----Original Message-----')&&html.includes('&lt;script>'));assert(!html.includes('<script>')&&!html.includes('<details'));
assert.equal(scope.window.mailaiReadingText({}), '');
console.log('PASS complete mail rendering: signature/quote order preserved, no injected folds, safe text rendering');
