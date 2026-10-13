/* Badge/icon styling must never leak onto translated UI labels. No services. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium,webkit}=require('playwright');
const dir=path.resolve(__dirname,'../app/web/static');
const read=file=>fs.readFileSync(path.join(dir,file),'utf8');
const html=read('index.html'),app=read('app.js'),workspace=read('workspace.js'),mailImport=read('mail-import.js'),directory=read('contact-directory.js');
const links=html.match(/<link[^>]+rel="stylesheet"[^>]*>/g).join('\n');
const segment=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))+end.length);
const steps=segment(mailImport,'<ol class="mail-import-steps"','</ol>');
const task=segment(workspace.slice(workspace.indexOf('const outboxBlock')),'<h3>','</h3>').replace('${visibleRows.length}','5');
const taskCount=workspace.match(/<span class="attention"><span data-i18n="[^"]+">[^]*?<\/span><\/span>/)[0].replace(/\$\{[^}]+\}/g,'5');
const counts=segment(directory,'<div class="directory-counts"','</div>').replace(/\$\{[^}]+\}/g,'2');
const contactError=app.match(/<div class="contact-empty"><b><span data-i18n="[^"]+">通讯录加载失败<\/span><\/b><small>[^]*?<\/small><\/div>/)[0].replace(/\$\{[^}]+\}/g,'Fixture error');
(async()=>{
  const {parse,serializeOuter}=await import('parse5');
  const tree=parse(html);function find(node,cls){if(node.attrs?.some(a=>a.name==='class' && a.value.split(' ').includes(cls)))return node;for(const child of node.childNodes||[]){const found=find(child,cls);if(found)return found;}}
  const toolbar=serializeOuter(find(tree,'compose-toolbar'));
  const fixture=`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8">${links}</head><body>
  <main style="padding:16px;box-sizing:border-box;width:100%;max-width:760px;margin:auto;overflow:auto">
    <section class="mail-import-dialog">${steps}</section><section class="task-section">${task}</section>
    <div class="task-overview-counts">${taskCount}</div><section class="directory-dialog">${counts}</section>
    <section id="contact-center">${contactError}<div class="contact-empty"><span aria-hidden="true">◎</span><b>Empty contacts</b></div></section>
    <section class="compose-card">${toolbar}</section>
  </main><script src="/static/i18n.js"></script><script src="/static/i18n-catalog.js"></script><script src="/static/i18n-runtime.js"></script><script src="/static/reward-theme-bridge.js"></script></body></html>`;
  for(const type of [chromium,webkit]) {
    const browser=await type.launch({headless:true});
    try {
      const page=await browser.newPage({viewport:{width:1100,height:1000},reducedMotion:'reduce'}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('http://span-styles.test/**',route=>{
        const name=path.basename(new URL(route.request().url()).pathname);
        if(!name)return route.fulfill({contentType:'text/html',body:fixture});
        if(/\.(css|js)$/.test(name))return route.fulfill({contentType:name.endsWith('.css')?'text/css':'application/javascript',body:read(name)});
        return route.fulfill({status:404,body:''});
      });
      await page.goto('http://span-styles.test/');
      for(const width of [1100,390])for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark'])for(const lang of ['zh-CN','en']) {
        await page.setViewportSize({width,height:1000});
        await page.evaluate(({theme,mode,lang})=>{document.documentElement.dataset.theme=mode;if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme;setI18nLanguage(lang);},{theme,mode,lang});
        const state=await page.evaluate(()=>{
          const inspect=selector=>[...document.querySelectorAll(selector)].map(n=>{const c=getComputedStyle(n),r=n.getBoundingClientRect();return {text:n.textContent,width:r.width,height:r.height,font:c.fontSize,bg:c.backgroundColor,fg:c.color,radius:c.borderRadius,padding:c.padding,display:c.display};});
          return {steps:inspect('.mail-import-steps [data-i18n]'),numbers:inspect('.mail-import-steps li>span:first-child'),heading:inspect('.task-section h3>[data-i18n]'),taskCount:inspect('.task-overview-counts [data-i18n]'),directoryCount:inspect('.directory-counts [data-i18n]'),error:inspect('.contact-empty b [data-i18n]'),icon:inspect('.contact-empty>span'),formats:inspect('.compose-format-group'),stepOverflow:document.querySelector('.mail-import-steps').scrollWidth>document.querySelector('.mail-import-steps').clientWidth};
        });
        const context=`${type.name()}/${width}/${theme}/${mode}/${lang}`;
        for(const node of [...state.steps,...state.heading,...state.error]){assert(node.width>24,`${context}: clipped ${JSON.stringify(node)}`);assert.equal(node.radius,'0px',`${context}: text got a badge`);assert.notEqual(node.display,'none',context);}
        for(const node of state.numbers){assert.equal(node.width,24,context);assert.equal(node.height,24,context);}
        for(const node of [...state.taskCount,...state.directoryCount]){assert.equal(node.padding,'0px',`${context}: duplicate padding`);assert.equal(node.bg,'rgba(0, 0, 0, 0)',`${context}: duplicate badge background`);}
        assert.equal(state.taskCount[0].fg,await page.locator('.task-overview-counts>.attention').evaluate(n=>getComputedStyle(n).color),`${context}: attention color must inherit`);
        assert.equal(state.icon[0].width,52,context);assert.equal(state.icon[0].height,52,context);
        assert(state.formats.length>0 && state.formats.every(n=>n.display!=='none' && n.width>0),`${context}: formatting controls hidden`);
        assert.equal(state.stepOverflow,false,`${context}: import steps overflow`);
      }
      assert.deepEqual(errors,[]);console.log(`${type.name()}: import steps, task headings/counts, directory counts/errors and compose controls passed in six palettes, two languages and narrow layouts`);
    } finally {await browser.close();}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
