/* Audit declared UI text, dynamic templates, and HTML hooks. Raw protocol strings
 * require reviewed exceptions; email bodies and user-entered values stay intact. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),acorn=require('acorn');
const root=path.join(__dirname,'..'),base=path.join(root,'app/web/static');
const hasHan=s=>/[\u3400-\u9fff]/.test(s);
const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(base,'i18n.js'),'utf8')+fs.readFileSync(path.join(base,'i18n-catalog.js'),'utf8')+';this.copy=MAILAI_UI_COPY;this.en=I18N_MESSAGES.en;',ctx);
const sources=new Map(Object.entries(ctx.copy).map(([key,[zh,en]])=>{assert.equal(typeof en,'string',key);assert(!hasHan(en),`Chinese in English copy: ${key}`);const tokens=s=>[...new Set([...s.matchAll(/\{(\d+)\}/g)].map(m=>m[1]))].sort().join();assert.equal(tokens(zh),tokens(en),`Interpolation mismatch: ${key}`);return[zh,key]}));
const en={...ctx.en,...Object.fromEntries(Object.entries(ctx.copy).map(([k,v])=>[k,v[1]]))};
vm.runInContext(fs.readFileSync(path.join(base,'i18n-runtime.js'),'utf8')+';this.css=mailaiCSSCopy;',ctx);
for(const [property,source] of Object.entries(ctx.css)) assert(sources.has(source),`CSS copy missing: ${property}`);
for(const file of fs.readdirSync(base).filter(file=>file.endsWith('.css'))) {
  const css=fs.readFileSync(path.join(base,file),'utf8');
  for(const match of css.matchAll(/content\s*:\s*([^;}]+)/g)) if(hasHan(match[1])) {
    const property=match[1].match(/var\((--mailai-copy-[\w-]+)/)?.[1];
    assert(property&&ctx.css[property],`Unlocalized CSS content in ${file}: ${match[1]}`);
  }
}
let exceptions=[];try{exceptions=JSON.parse(fs.readFileSync(path.join(root,'frontend/i18n-exceptions.json'),'utf8'));}catch{}
const missing=[],raw=[];
const walk=(n,cb,parents=[])=>{if(!n||typeof n!=='object')return;if(cb(n,parents)===false)return;for(const[k,v]of Object.entries(n)){if(['loc','start','end'].includes(k))continue;if(Array.isArray(v))v.forEach(c=>walk(c,cb,[...parents,n]));else if(v?.type)walk(v,cb,[...parents,n]);}};
(async()=>{const {parse,parseFragment}=await import('parse5');
function htmlAudit(html,file,full=false){const tree=(full?parse:parseFragment)(html);const visit=(n,ancestors=[])=>{const attrs=Object.fromEntries((n.attrs||[]).map(a=>[a.name,a.value]));for(const[attr,hook]of [['placeholder','data-i18n-placeholder'],['title','data-i18n-title'],['aria-label','data-i18n-aria'],['alt','data-i18n-alt'],['data-placeholder','data-i18n-data-placeholder'],['data-tooltip','data-i18n-tooltip'],['data-action-hint','data-i18n-action-hint']])if(hasHan(attrs[attr]||'')&&!attrs[hook])missing.push({file,text:attrs[attr],reason:`Unmarked ${attr}`});for(const[k,v]of Object.entries(attrs))if(k==='data-i18n'||k.startsWith('data-i18n-')){if(!v.includes('___MUI_SLOT_')&&!(v in en))missing.push({file,text:v,reason:'Missing dictionary key'});}
if(n.nodeName==='#text'&&hasHan(n.value)&&!ancestors.some(p=>['script','style','title','textarea'].includes(p.tagName)||(p.attrs||[]).some(a=>a.name==='data-i18n'||a.name==='contenteditable'&&a.value==='true')))missing.push({file,text:n.value.trim(),reason:'Unmarked HTML text'});
for(const c of n.childNodes||[])visit(c,[...ancestors,n]);if(n.content)visit(n.content,[...ancestors,n]);};visit(tree);}
htmlAudit(fs.readFileSync(path.join(base,'index.html'),'utf8'),'index.html',true);
for(const file of fs.readFileSync(path.join(root,'frontend/sources.txt'),'utf8').split(/\r?\n/).filter(s=>s&&!s.startsWith('#')&&!s.startsWith('i18n'))){const code=fs.readFileSync(path.join(base,file),'utf8');const ast=acorn.parse(code,{ecmaVersion:'latest',locations:true});walk(ast,(n,parents)=>{
if(n.type==='CallExpression'&&n.callee.name==='mailaiText'&&n.arguments[0]?.type==='Literal'){const text=n.arguments[0].value;if(hasHan(text)&&!sources.has(text))missing.push({file,line:n.loc.start.line,text,reason:'Missing dynamic copy'});return false;}
if(n.type==='TaggedTemplateExpression'&&n.tag.name==='mailaiTemplate'){const t=n.quasi,text=t.quasis.map((q,i)=>q.value.cooked+(i<t.expressions.length?`{${i}}`:'')).join('');if(hasHan(text)&&!sources.has(text))missing.push({file,line:n.loc.start.line,text,reason:'Missing template copy'});return;}
return check(n,parents);
});function check(n,parents){if(n.type==='TemplateLiteral'&&parents.at(-1)?.type==='TaggedTemplateExpression'&&parents.at(-1).tag.name==='mailaiTemplate')return;let text;if(n.type==='Literal'&&typeof n.value==='string')text=n.value;else if(n.type==='TemplateLiteral')text=n.quasis.map((q,i)=>q.value.cooked+(i<n.expressions.length?`___MUI_SLOT_${i}___`: '')).join('');else return;if(!hasHan(text))return;
if(/<[a-z][a-z0-9-]*[\s>]/i.test(text)){htmlAudit(text,file);return;}
if(parents.some(p=>p.type==='LogicalExpression'&&p.operator==='||'&&/mailaiT\(|cleanupT\(/.test(code.slice(p.left.start,p.left.end))))return;
if(parents.some(p=>p.type==='CallExpression'&&['t','translate','cleanupT'].includes(p.callee.name)))return;
if(parents.at(-1)?.type==='Property'&&parents.at(-1).key===n&&!parents.at(-1).computed)return;
if(exceptions.some(r=>r.file===file&&r.text===text))return;
raw.push({file,line:n.loc.start.line,text,context:code.slice(Math.max(0,n.start-70),n.end+70)});
}
}
if(process.env.MAILAI_I18N_AUDIT_REPORT){fs.writeFileSync(process.env.MAILAI_I18N_AUDIT_REPORT,JSON.stringify({missing,raw},null,2));console.log(`Audit: ${missing.length} missing hooks/copy, ${raw.length} raw strings`);return;}
assert.deepEqual(missing,[],'Interface text requires a declared translation');assert.deepEqual(raw,[],'Review raw Chinese literals as protocol/data or localize them');console.log(`i18n coverage passed: ${sources.size} copy entries, all frontend sources and HTML hooks audited`);
})().catch(e=>{console.error(e);process.exitCode=1});
