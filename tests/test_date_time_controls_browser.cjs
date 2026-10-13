/* Exercise the actual stylesheet cascade in both desktop browser engines.
 * No mailbox, SMTP, account, or external service is used. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium,webkit}=require('playwright');
const dir=path.resolve(__dirname,'../app/web/static');
const links=fs.readFileSync(path.join(dir,'index.html'),'utf8').match(/<link[^>]+rel="stylesheet"[^>]*>/g).join('\n');
const fixture=`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8">${links}</head><body>
<dialog id="fixture" class="productivity-dialog"><header><h2>发送安排</h2></header><div class="productivity-body">
<form id="dates"><div class="productivity-grid"><label><span>计划发送时间</span><input type="datetime-local" id="send" value="2026-10-13T12:30"></label>
<label><span>截止日期</span><input type="date" id="deadline"></label><label><span>提醒时间</span><input type="time" id="time" value="09:30"></label></div>
<button id="submit" type="submit">保存</button></form>
<div class="special-mail-actions"><button class="action-btn action-primary compact" id="btn-edit-special"><svg viewBox="0 0 20 20"><path d="M4 4h12"/></svg><span>继续编辑</span></button></div>
<div class="productivity-actions"><button class="primary-action"><span>保存安排</span></button></div>
<div id="task-planner"><button id="plan-save"><span>保存任务</span></button></div>
<div class="library-dialog"><button type="submit"><span>开始恢复</span></button></div>
<button id="save-reminder">保存提醒</button><button class="contact-new-button">新建联系人</button>
<button id="outside">外部操作</button><div id="dynamic"></div></div></dialog>
<div class="topbar"><button id="btn-compose"><span>写邮件</span></button></div>
<script src="/static/i18n.js"></script><script src="/static/i18n-catalog.js"></script><script src="/static/i18n-runtime.js"></script><script src="/static/reward-theme-bridge.js"></script><script src="/static/date-time-picker.js"></script>
<script>document.querySelector('#fixture').showModal();window.events=[];document.querySelector('#send').addEventListener('change',e=>events.push(e.target.value));document.querySelector('form').addEventListener('submit',e=>e.preventDefault());</script>
</body></html>`;
async function contrast(locator) {
  return locator.evaluate(node=>{
    const css=getComputedStyle(node),parent=node.matches('button')?css:getComputedStyle(node.closest('button'));
    const lum=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
    const a=lum(css.color),b=lum(parent.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
}
(async()=>{
  for(const type of [chromium,webkit]) {
    const browser=await type.launch({headless:true});
    try {
      const page=await browser.newPage({viewport:{width:1100,height:850},reducedMotion:'reduce'}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('http://controls.test/**',route=>{
        const name=path.basename(new URL(route.request().url()).pathname);
        if(!name)return route.fulfill({contentType:'text/html',body:fixture});
        if(/\.(css|js)$/.test(name))return route.fulfill({contentType:name.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(path.join(dir,name),'utf8')});
        return route.fulfill({status:404,body:''});
      });
      await page.goto('http://controls.test/');
      const trigger=id=>page.locator(`#${id} + .datetime-trigger`),panel=page.locator('.datetime-panel:visible');
      assert.equal(await page.locator('.datetime-trigger').count(),3);
      assert.match(await trigger('send').textContent(),/2026.*10.*13.*12:30/);
      await trigger('send').click();
      await panel.locator('[data-date="2026-10-15"]').click();
      await panel.locator('.datetime-hour').fill('18');await panel.locator('.datetime-minute').fill('45');
      await panel.locator('.datetime-apply').click();
      assert.equal(await page.locator('#send').inputValue(),'2026-10-15T18:45');
      assert.deepEqual(await page.evaluate(()=>events),['2026-10-15T18:45']);
      await trigger('send').click();await panel.locator('.datetime-hour').fill('06');await panel.locator('.datetime-cancel').click();
      assert.equal(await page.locator('#send').inputValue(),'2026-10-15T18:45');
      await trigger('send').click();await page.keyboard.press('Escape');
      assert.equal(await trigger('send').getAttribute('aria-expanded'),'false');
      assert.equal(await trigger('send').evaluate(node=>node===document.activeElement),true);
      assert.equal(await page.locator('#fixture').evaluate(node=>node.open),true,'Escape closes only the picker');
      await trigger('send').click();await page.locator('h2').click();assert.equal(await panel.count(),0);
      await page.evaluate(()=>{document.querySelector('#send').value='2026-11-20T10:15';});
      assert.match(await trigger('send').textContent(),/2026.*11.*20.*10:15/);
      await trigger('send').click();
      await panel.locator('.datetime-navigation select').first().selectOption('1');
      await panel.locator('.datetime-navigation select').last().selectOption('2028');
      await panel.locator('[data-date="2028-02-29"]').click();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');
      assert.equal(await panel.locator('[aria-pressed="true"]').getAttribute('data-date'),'2028-03-01');
      await panel.locator('.datetime-apply').click();assert.equal(await page.locator('#send').inputValue(),'2028-03-01T10:15');
      await trigger('send').click();await panel.locator('.datetime-clear').click();assert.equal(await page.locator('#send').inputValue(),'');
      await page.evaluate(()=>{const input=document.querySelector('#send');input.required=true;input.min='2026-10-13T12:00';input.max='2026-10-16T18:00';input.value='2026-10-13T12:30';});
      await trigger('send').click();
      assert.equal(await panel.locator('.datetime-clear').isVisible(),false);
      assert.equal(await panel.locator('[data-date="2026-10-12"]').isDisabled(),true);
      await panel.locator('.datetime-hour').fill('11');assert.equal(await panel.locator('.datetime-apply').isDisabled(),true);
      await panel.locator('.datetime-hour').fill('25');assert.equal(await panel.locator('.datetime-apply').isDisabled(),true);
      await panel.locator('.datetime-hour').fill('12');await panel.locator('.datetime-minute').fill('99');assert.equal(await panel.locator('.datetime-apply').isDisabled(),true);
      await panel.locator('.datetime-minute').fill('00');assert.equal(await panel.locator('.datetime-apply').isEnabled(),true);
      await panel.locator('.datetime-cancel').click();
      await page.evaluate(()=>document.querySelector('#send').value='');await page.locator('#submit').click();
      await panel.waitFor({state:'visible'});assert.match(await panel.locator('.datetime-status').textContent(),/./);
      await page.keyboard.press('Escape');
      await page.evaluate(()=>{document.querySelector('#send').required=false;document.querySelector('#send').disabled=true;});
      assert.equal(await trigger('send').isDisabled(),true);
      await page.evaluate(()=>{document.querySelector('#send').disabled=false;document.querySelector('#send').readOnly=true;});assert.equal(await trigger('send').isDisabled(),true);
      await page.evaluate(()=>document.querySelector('#send').readOnly=false);
      await trigger('time').click();await panel.locator('.datetime-hour').fill('23');await panel.locator('.datetime-minute').fill('05');await page.keyboard.press('Enter');
      assert.equal(await page.locator('#time').inputValue(),'23:05');
      await trigger('deadline').click();await panel.locator('.datetime-shortcut').first().click();await panel.locator('.datetime-apply').click();
      assert.equal(await page.locator('#deadline').inputValue(),await page.evaluate(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}));
      await page.evaluate(()=>document.querySelector('#dates').reset());assert.match(await trigger('send').textContent(),/2026.*10.*13.*12:30/);
      await page.evaluate(()=>document.querySelector('#dynamic').innerHTML='<label><span>新提醒</span><input id="dynamic-date" type="datetime-local"></label><input id="internal-date" type="date" hidden>');
      await trigger('dynamic-date').waitFor();assert.equal(await page.locator('#internal-date + .datetime-trigger').count(),0);
      await page.evaluate(()=>document.querySelector('#dynamic-date').value='2026-12-01T09:00');assert.match(await trigger('dynamic-date').textContent(),/2026.*12.*01.*09:00/);
      await trigger('dynamic-date').click();await page.evaluate(()=>document.querySelector('#dynamic').replaceChildren());assert.equal(await panel.count(),0);
      for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark']) {
        await page.evaluate(({theme,mode})=>{document.documentElement.dataset.theme=mode;if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme;},{theme,mode});
        for(const selector of ['#btn-edit-special','#btn-edit-special span','.productivity-actions .primary-action','.productivity-actions .primary-action span','#plan-save','#save-reminder','.library-dialog button','.contact-new-button']) {
          for(const state of ['normal','hover','focus']) {
            const node=page.locator(selector);if(state==='hover')await node.hover();else if(state==='focus')await node.focus();else await page.locator('h2').click();
            assert(await contrast(node)>=4.5,`${type.name()}/${theme}/${mode}/${selector}/${state}: insufficient contrast`);
          }
        }
        assert.equal(await page.locator('#btn-edit-special svg').evaluate(node=>getComputedStyle(node).stroke),await page.locator('#btn-edit-special').evaluate(node=>getComputedStyle(node).color));
        await trigger('send').click();
        assert(await contrast(panel.locator('.datetime-apply'))>=4.5,`${theme}/${mode} picker apply contrast: ${await panel.locator('.datetime-apply').evaluate(n=>{const c=getComputedStyle(n),r=getComputedStyle(document.documentElement);return JSON.stringify({color:c.color,bg:c.backgroundColor,on:r.getPropertyValue('--control-on-accent'),accent:r.getPropertyValue('--control-accent')});})}`);
        const bounds=await panel.boundingBox();assert(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=1100 && bounds.y+bounds.height<=850);
        if(type===chromium && theme==='theme_baowu')await page.screenshot({path:`/tmp/mailai-controls-${mode}.png`});
        await page.keyboard.press('Escape');
      }
      await page.evaluate(()=>setI18nLanguage('en'));assert.equal(await trigger('deadline').getAttribute('aria-haspopup'),'dialog');
      await trigger('send').click();assert.equal(await panel.locator('.datetime-apply').textContent(),'Apply');
      await page.setViewportSize({width:390,height:600});
      // Viewport acknowledgment can precede the browser's resize event.
      await page.waitForFunction(()=>{
        const panel=document.querySelector('.datetime-panel:popover-open,.datetime-panel.is-open');
        if(!panel)return false;
        const bounds=panel.getBoundingClientRect();
        return bounds.x>=0 && bounds.right<=390 && bounds.y>=0 && bounds.bottom<=600;
      },null,{timeout:5000});
      const bounds=await panel.boundingBox();assert(bounds.x>=0 && bounds.x+bounds.width<=390 && bounds.y>=0 && bounds.y+bounds.height<=600,JSON.stringify({engine:type.name(),bounds}));
      const initial=await page.evaluate(()=>document.activeElement.className);for(let i=0;i<25;i++)await page.keyboard.press('Tab');
      assert(await page.evaluate(()=>document.activeElement.closest('.datetime-panel')!==null),`Tab stays within the open picker (${initial})`);
      await page.keyboard.press('Escape');
      // Exercise the non-Popover fallback used by older embedded webviews.
      await page.evaluate(()=>{HTMLElement.prototype.showPopover=undefined;HTMLElement.prototype.hidePopover=undefined;});
      await trigger('deadline').click();await panel.locator('.datetime-shortcut').first().click();await panel.locator('.datetime-apply').click();
      assert.deepEqual(errors,[]);
      console.log(`${type.name()}: dates/times, constraints, dynamic dialogs, keyboard, placement, fallback and all six theme palettes passed`);
    } finally {await browser.close();}
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
