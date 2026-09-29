// Shared canvas and search geometry, using only the isolated example.test fixture.
const assert = require('node:assert/strict');
const {chromium,webkit} = require('playwright');
(async()=>{
  const browser=await (process.env.MAILAI_PRELOADER_WEBKIT==='1'?webkit:chromium).launch({headless:true});
  const errors=[];
  try {
    for(const shell of ['browser','macos','windows']) {
      const page=await browser.newPage({viewport:{width:1512,height:950},reducedMotion:'reduce'});
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`http://127.0.0.1:18795/?shell=${shell}`);
      await page.locator('#app-preloader').waitFor({state:'detached'});
      await page.locator('#email-list .email-item').first().click();
      for(const theme of ['light','dark']) {
        await page.evaluate(theme=>applyTheme(theme),theme);
        await page.waitForTimeout(550);
        const surfaces=await page.evaluate(()=>{
          const style=selector=>getComputedStyle(document.querySelector(selector));
          return {
            rail:style('.sidebar').backgroundColor,list:style('.list-pane').backgroundColor,
            footer:style('.list-footer').backgroundColor,corner:style('.sidebar').borderTopRightRadius,
            top:style('.topbar').backgroundImage,search:style('.global-search').backgroundColor,
            join:document.querySelector('.list-pane').getBoundingClientRect().top-document.querySelector('.topbar').getBoundingClientRect().bottom,
          };
        });
        assert.equal(surfaces.rail,surfaces.list);
        assert.equal(surfaces.list,surfaces.footer);
        assert.equal(surfaces.corner,'0px');
        assert.equal(surfaces.join,0);
        assert.match(surfaces.top,/linear-gradient\(90deg/);
        assert.notEqual(surfaces.search,surfaces.rail);
        const searchWidths=[];
        for(const list of [320,405,480]) {
          await page.evaluate(list=>applyPaneSizes({sidebar:226,list}),list);
          await page.waitForTimeout(120);
          const boxes=await page.evaluate(()=>{
            const rect=selector=>document.querySelector(selector).getBoundingClientRect();
            const search=rect('.global-search'),title=rect('.list-title'),list=rect('.list-pane');
            return {left:search.left-title.left,listWidth:list.width,inset:title.left-list.left,width:search.width};
          });
          assert(Math.abs(boxes.left)<1,`${shell}: search must align with the mail title`);
          assert(boxes.width>=boxes.listWidth+60,`${shell}: search should extend past the narrow mail list`);
          searchWidths.push(boxes.width);
        }
        assert(searchWidths[0]<searchWidths[1]&&searchWidths[1]<searchWidths[2],`${shell}: search should grow with the mail list`);
        await page.evaluate(()=>applyPaneSizes({sidebar:226,list:405}));
        for(const [width,scale] of [[900,1],[1025,1],[1150,1],[1200,1.3],[1300,1],[1920,1],[2560,1]]) {
          await page.setViewportSize({width,height:900});
          await page.evaluate(scale=>{document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale)},scale);
          await page.waitForTimeout(150);
          const metrics=await page.evaluate(()=>{
            const search=document.querySelector('.global-search').getBoundingClientRect(),actions=document.querySelector('.global-actions').getBoundingClientRect(),title=document.querySelector('.list-title').getBoundingClientRect();
            return {overflow:document.documentElement.scrollWidth>innerWidth,overlap:search.right>actions.left+1,searchWidth:search.width,leftOffset:search.left-title.left};
          });
          assert(!metrics.overflow&&!metrics.overlap,JSON.stringify({shell,width,scale,metrics}));
          assert(metrics.searchWidth>=260,JSON.stringify({shell,width,scale,metrics}));
          if(width>=1025&&scale===1) assert(metrics.searchWidth>=420,JSON.stringify({shell,width,scale,metrics}));
          if(width>=1025) assert(Math.abs(metrics.leftOffset)<2,JSON.stringify({shell,width,scale,metrics}));
        }
        await page.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1')});
        await page.setViewportSize({width:1512,height:950});
        await page.evaluate(()=>applyPaneSizes({sidebar:226,list:405}));
      }
      if(shell==='browser') {
        await page.setViewportSize({width:390,height:844});
        await page.waitForTimeout(200);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        assert(await page.locator('.global-search').isVisible());
        assert(await page.locator('#btn-preferences').isVisible());
      }
      await page.close();
    }
    assert.deepEqual(errors,[]);
    console.log('Workspace shell: unified surfaces, toolbar gradient, adaptive search width after pane resizing, desktop font scaling and mobile controls passed for browser/macOS/Windows');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
