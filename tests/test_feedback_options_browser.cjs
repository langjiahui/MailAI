/* Render the real feedback markup, handlers, i18n and CSS without a mailbox. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium,webkit}=require('playwright');
const dir=path.resolve(__dirname,'../app/web/static');
const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
const app=fs.readFileSync(path.join(dir,'app.js'),'utf8');
const links=html.match(/<link[^>]+rel="stylesheet"[^>]*>/g).join('\n');
const markup=html.slice(html.indexOf('<div id="feedback-modal"'),html.indexOf('<!-- 退出邮箱确认 -->'));
const handlers=app.slice(app.indexOf('const feedbackReasonOptions ='),app.indexOf("document.getElementById('btn-submit-feedback').addEventListener"));
const fixture=`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8">${links}</head><body>${markup}
<script src="/static/i18n.js"></script><script src="/static/i18n-catalog.js"></script><script src="/static/i18n-runtime.js"></script>
<script src="/static/reward-theme-bridge.js"></script>
<script>const selectedEmailDetail={id:1,status:'inbox'},allEmails=[];const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');${handlers}</script></body></html>`;
(async()=>{
  for(const type of [chromium,webkit]) {
    const browser=await type.launch({headless:true});
    try {
      const page=await browser.newPage({viewport:{width:1100,height:900},reducedMotion:'reduce'}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('http://feedback.test/**',route=>{
        const name=path.basename(new URL(route.request().url()).pathname);
        if(!name)return route.fulfill({contentType:'text/html',body:fixture});
        if(/\.(css|js)$/.test(name))return route.fulfill({contentType:name.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(path.join(dir,name),'utf8')});
        return route.fulfill({status:404,body:''});
      });
      await page.goto('http://feedback.test/');
      for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark'])for(const lang of ['zh-CN','en'])for(const kind of ['fp','fn']) {
        await page.evaluate(({theme,mode,lang,kind})=>{document.documentElement.dataset.theme=mode;if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme;setI18nLanguage(lang);feedbackEmail(1,kind);},{theme,mode,lang,kind});
        const buttons=page.locator('[data-feedback-reason]');assert.equal(await buttons.count(),6);
        async function inspect() {
          const rows=await buttons.evaluateAll(nodes=>nodes.map(node=>{
            const label=node.querySelector('span[data-i18n]'),mark=node.firstElementChild,style=getComputedStyle(label),bg=getComputedStyle(node),rect=label.getBoundingClientRect();
            const lum=color=>{const n=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return n[0]*.2126+n[1]*.7152+n[2]*.0722;};
            const a=lum(style.color),b=lum(bg.backgroundColor);
            return {text:label.textContent,fg:style.color,width:rect.width,height:rect.height,border:style.borderWidth,markWidth:mark.getBoundingClientRect().width,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),buttonHeight:node.getBoundingClientRect().height};
          }));
          for(const row of rows){const context=JSON.stringify({engine:type.name(),theme,mode,lang,kind,row});assert(row.text.trim(),context);assert(row.width>60,context);assert(row.height<=row.buttonHeight,context);assert.equal(row.border,'0px',context);assert.equal(row.markWidth,18,context);assert(row.ratio>=4.5,context);}
        }
        await inspect();await buttons.first().click();await buttons.nth(1).click();await inspect();
        assert.equal(await page.locator('.feedback-reasons button.selected').count(),2);
        assert.equal(await buttons.first().getAttribute('aria-pressed'),'true');
        await buttons.first().click();assert.equal(await buttons.first().getAttribute('aria-pressed'),'false');
        await buttons.last().click();assert.equal(await page.locator('#feedback-note').evaluate(n=>n===document.activeElement),true);
        await page.locator('#feedback-note').fill('UI check');assert.equal(await page.locator('#feedback-note-count').textContent(),'8');
        if(type===chromium && theme==='theme_baowu' && lang==='zh-CN' && kind==='fp') {
          await buttons.first().click();await page.screenshot({path:`/tmp/mailai-feedback-fixed-${mode}.png`});
        }
        await page.keyboard.press('Escape');assert.equal(await page.locator('#feedback-modal').isVisible(),false);
      }
      await page.setViewportSize({width:390,height:700});await page.evaluate(()=>{setI18nLanguage('en');feedbackEmail(1,'fp');});
      const bounds=await page.locator('.feedback-dialog').boundingBox();assert(bounds.x>=0 && bounds.x+bounds.width<=390);
      assert.equal(await page.locator('.feedback-reasons').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),1);
      const before=await page.locator('.feedback-dialog').evaluate(n=>n.scrollWidth<=n.clientWidth);assert(before,'No horizontal overflow');
      await page.locator('#btn-cancel-feedback').click();assert.deepEqual(errors,[]);
      console.log(`${type.name()}: feedback labels, six palettes, English/Chinese, selection, note, dismissal and narrow layout passed`);
    } finally {await browser.close();}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
