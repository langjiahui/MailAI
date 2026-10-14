// Isolated fixture only; exercise the actual CSS cascade in both browser engines.
const assert = require('node:assert/strict');
const {chromium, webkit} = require('playwright');
(async () => {
  const browser = await (process.env.MAILAI_BROWSER === 'webkit' ? webkit : chromium).launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'});
    await page.addInitScript(() => localStorage.setItem('mailai.onboarding.v2',JSON.stringify({mailboxDone:true,aiDone:true,deferred:true})));
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('.email-item').first().click();
    await page.locator('.reading-subject').waitFor({state:'visible'});
    await page.evaluate(() => setI18nLanguage('zh-CN'));
    await page.evaluate(async () => {
      for(const item of ['theme_monochrome','theme_baowu'])await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item,token:crypto.randomUUID()})});
      await mailaiPet.refresh();
    });
    let expectedTheme='',expectedMode='light';
    async function inspect(button, label) {
      const value = await button.evaluate(node => {
        const ctx = document.createElement('canvas').getContext('2d');
        const rgba = color => {ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
        const blend = (fg,bg) => fg.slice(0,3).map((v,i) => v*fg[3]/255+bg[i]*(1-fg[3]/255)).concat(255);
        const lum = rgb => rgb.slice(0,3).map(v => {v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i) => a+v*[.2126,.7152,.0722][i],0);
        let bg = [255,255,255,255];
        const ancestors=[];for(let n=node;n;n=n.parentElement)ancestors.unshift(n);
        for(const n of ancestors)bg=blend(rgba(getComputedStyle(n).backgroundColor),bg);
        const css=getComputedStyle(node), b=lum(bg);
        const children=[...node.querySelectorAll('span,svg')].filter(n => getComputedStyle(n).display!=='none');
        return {theme:document.documentElement.dataset.rewardTheme||'',mode:document.documentElement.dataset.theme,background:css.backgroundColor,transform:css.transform,outline:css.outlineStyle,
          ratios:[node,...children].map(n => {const a=lum(blend(rgba(getComputedStyle(n).color),bg));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);}),
          icon:getComputedStyle(node.querySelector('svg')).stroke,color:css.color};
      });
      assert.equal(value.theme,expectedTheme,`${label}: theme must remain equipped`);
      assert.equal(value.mode,expectedMode);
      assert(value.ratios.every(r => r>=4.5),`${label}: ${JSON.stringify(value)}`);
      assert.equal(value.icon,value.color,`${label}: icon must follow the readable foreground`);
      return value;
    }
    for(const shell of ['browser','macos','windows'])for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark']) {
      expectedTheme=theme;expectedMode=mode;
      await page.evaluate(async ({shell,theme,mode}) => {
        const root=document.documentElement;
        root.classList.remove('desktop-native-window','macos-native-window','windows-native-window');
        if(shell!=='browser')root.classList.add('desktop-native-window',shell+'-native-window');
        await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});
        await mailaiPet.refresh();
        applyTheme(mode);
      },{shell,theme,mode});
      const buttons=page.locator('.topbar .nav-action');
      for(let i=0;i<await buttons.count();i++) {
        const button=buttons.nth(i);if(!await button.isVisible() || !await button.isEnabled())continue;
        const id=await button.getAttribute('id'),label=`${shell}/${theme||'default'}/${mode}/${id}`;
        await page.mouse.move(20,900);await inspect(button,label+'/rest');
        const box=await button.boundingBox();
        await button.hover();const hover=await inspect(button,label+'/hover');
        assert.deepEqual(await button.boundingBox(),box,`${label}: hover must not move the button`);
        if(id==='btn-contacts' && shell==='macos' && theme==='theme_monochrome' && mode==='dark')
          await page.screenshot({path:'build/toolbar-hover-monochrome-dark.png'});
        if(id==='btn-compose')continue;
        await page.mouse.down();const pressed=await inspect(button,label+'/pressed');
        assert.notEqual(hover.background,pressed.background,`${label}: press feedback`);
        await page.mouse.move(20,900);await page.mouse.up();
        const original=await button.getAttribute('aria-expanded');
        await button.evaluate(n => n.setAttribute('aria-expanded','true'));await inspect(button,label+'/expanded');
        await button.evaluate((n,original) => original===null?n.removeAttribute('aria-expanded'):n.setAttribute('aria-expanded',original),original);
      }
      const contacts=page.locator('#btn-contacts');
      await page.keyboard.press('Tab');await contacts.focus();
      const focus=await inspect(contacts,`${shell}/${theme}/${mode}/focus`);
      assert.equal(focus.outline,'solid',`${shell}/${theme}/${mode}: keyboard focus`);
      await contacts.evaluate(n => n.blur());
    }
    await page.evaluate(async()=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});await mailaiPet.refresh();});
    console.log('Toolbar rest, hover, pressed, expanded, focus and icon contrast passed: 3 shells × 6 palettes');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
