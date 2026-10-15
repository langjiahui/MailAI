/* Developer-only asset regeneration. Release builds use the committed PNGs.
 * Geometry comes from brand.js; Chromium rasterizes SVG at each native size. */
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),assets=path.join(root,'app/web/static/assets');
const source=fs.readFileSync(path.join(root,'app/web/static/brand.js'),'utf8');
const start=source.indexOf('  const paths = '),end=source.indexOf('  document.querySelectorAll');
const context={};vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.markup=markup;',context);
const mark=context.markup('#0e5a54','#94c7b6').replace('aria-hidden="true"','role="img" aria-label="MailAI"');
const template=context.markup('#000','#000');
// Native surfaces keep a neutral identity; in-app marks retain theme colors.
const nativeMark=context.markup('url(#graphite)','url(#fold)');
// Native Dock artwork uses an 824px body on a 1024px canvas, matching the
// visual bounds of neighboring apps. Scale the tile and mark together.
const app=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="glass" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#ffffff" stop-opacity=".98"/><stop offset=".55" stop-color="#f4f5f6" stop-opacity=".97"/><stop offset="1" stop-color="#e4e7ea" stop-opacity=".96"/></linearGradient>
  <linearGradient id="rim" x1="0" y1="0" x2=".6" y2="1"><stop stop-color="#ffffff"/><stop offset=".55" stop-color="#ffffff" stop-opacity=".6"/><stop offset="1" stop-color="#bfc5cb" stop-opacity=".72"/></linearGradient>
  <linearGradient id="graphite" x1="0" y1="0" x2=".6" y2="1"><stop stop-color="#42484e"/><stop offset="1" stop-color="#24292e"/></linearGradient>
  <linearGradient id="fold" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="#969da4"/><stop offset="1" stop-color="#737b83"/></linearGradient>
</defs>
<g transform="translate(90.112 90.112) scale(0.824)">
  <rect x="12" y="12" width="1000" height="1000" rx="224" fill="url(#glass)"/>
  <rect x="14" y="14" width="996" height="996" rx="222" fill="none" stroke="url(#rim)" stroke-width="4"/>
  <rect x="20" y="20" width="984" height="984" rx="216" fill="none" stroke="#ffffff" stroke-opacity=".38" stroke-width="2"/>
  <g transform="translate(145 127) scale(11.46875)">${nativeMark.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</g>
</g></svg>`;
(async()=>{
 fs.mkdirSync(assets,{recursive:true});
 fs.writeFileSync(path.join(assets,'mailai-mark.svg'),mark);
 fs.writeFileSync(path.join(assets,'mailai-app-icon.svg'),app);
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({deviceScaleFactor:1});
  async function render(svg,size,name){
   await page.setViewportSize({width:size,height:size});
   await page.setContent('<style>html,body{margin:0;background:transparent;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>'+svg);
   await page.screenshot({path:path.join(assets,name),omitBackground:true});
  }
  await render(mark,1024,'mailai-mark.png');
  await render(app,1024,'mailai-app-icon-1024.png');
  await render(app,256,'mailai-icon-256.png');
  await render(template,64,'mailai-menu-template.png');
 } finally { await browser.close(); }
 console.log('Generated shared folded-M SVGs, 1024/256px app icons and menu template');
})().catch(error=>{console.error(error);process.exitCode=1;});
