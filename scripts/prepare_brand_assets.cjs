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
// Native icons use one fixed blue identity, independent of workspace themes.
const nativeMark=context.markup('#005eaa','#8ab5d8');
// Native Dock artwork uses an 824px body on a 1024px canvas, matching the
// visual bounds of neighboring apps. Scale the tile and mark together.
const app=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g transform="translate(90.112 90.112) scale(0.824)"><rect x="12" y="12" width="1000" height="1000" rx="224" fill="#f5f8fc"/><rect x="13" y="13" width="998" height="998" rx="223" fill="none" stroke="#d3dfed" stroke-width="2"/><g transform="translate(145 127) scale(11.46875)">${nativeMark.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</g></g></svg>`;
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
