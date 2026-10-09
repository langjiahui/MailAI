const i18nContext = require('./helpers/i18n.cjs');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const scope={window:{},mdToHtml:text=>String(text).replace(/</g,'&lt;')};vm.createContext(i18nContext(scope));vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/web/static/mail-reading-folds.js'),'utf8'),scope);
const sections=scope.window.mailaiMailTextSections('当前结论\n-- \n张三\n-----Original Message-----\nFrom: old@example.test\nDate: 2026-01-01\n历史正文');
assert.equal(sections.body,'当前结论\n');assert(sections.signature.includes('张三'));assert(sections.quote.includes('历史正文'));
const unchanged='普通邮件中的报价\n周五交付，不是历史引用。';assert.equal(scope.window.mailaiMailTextSections(unchanged).body,unchanged);
const html=scope.window.mailaiReadingText({body_text:'当前正文\n-----Original Message-----\n<script>bad()</script>'});assert(html.includes('历史引用 · 展开原文')&&html.includes('&lt;script>'));assert(!html.includes('<script>'));
console.log('PASS reading folds: explicit boundaries, preserved plain body, expandable originals and escaped text');
