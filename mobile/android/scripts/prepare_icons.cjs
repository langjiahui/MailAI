// Render the approved desktop artwork; geometry and glass colors stay shared.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const res = path.join(root, 'app/src/main/res');
const original = fs.readFileSync(path.join(root, 'brand/app-icon.svg'), 'utf8');
const defs = original.match(/<defs>[\s\S]*?<\/defs>/)[0];
const paths = [...original.matchAll(/<path[^>]*class="brand-[^>]*\/>/g)].map(x => x[0]).join('');
if (!paths || !defs) throw Error('Approved M geometry missing');
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">${defs}<g transform="translate(22 22)">${paths}</g></svg>`;
const background = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${defs}${['glass','bloom','baowu','sheen','refract'].map(fill => `<rect width="1024" height="1024" fill="url(#${fill})"/>`).join('')}</svg>`;
(async () => {
 const browser = await chromium.launch({headless: true});
 try {
  const page = await browser.newPage({deviceScaleFactor: 1});
  for (const [name, svg, size] of [['mailai_brand',original,256], ['launcher_foreground',foreground,432], ['launcher_background',background,432]]) {
   await page.setViewportSize({width:size, height:size});
   await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);
   await page.screenshot({path:path.join(res,'drawable-nodpi',name+'.png'),omitBackground:true});
  }
 } finally { await browser.close(); }
 const d = [...original.matchAll(/<path[^>]*class="brand-[^>]*d="([^"]+)"/g)].map(x=>x[1]);
 const vector=(size,viewport,scale,tx,ty)=>`<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${size}dp" android:height="${size}dp" android:viewportWidth="${viewport}" android:viewportHeight="${viewport}"><group android:scaleX="${scale}" android:scaleY="${scale}" android:translateX="${tx}" android:translateY="${ty}">${d.map(p=>`<path android:fillColor="#FFFFFFFF" android:pathData="${p}"/>`).join('')}</group></vector>\n`;
 fs.writeFileSync(path.join(res,'drawable/ic_notification.xml'),vector(24,24,.34,1,1.3));
 fs.writeFileSync(path.join(res,'drawable/launcher_monochrome.xml'),vector(108,108,1,22,22));
 console.log('Approved M: adaptive foreground/background, brand artwork and monochrome glyphs rendered');
})().catch(e=>{console.error(e);process.exitCode=1;});
