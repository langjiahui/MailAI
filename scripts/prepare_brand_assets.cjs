/* Developer-only asset regeneration. Release builds use the committed PNGs.
 * Geometry comes from brand.js; Chromium rasterizes SVG at each native size. */
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),assets=path.join(root,'app/web/static/assets');
const source=fs.readFileSync(path.join(root,'app/web/static/brand.js'),'utf8');
const start=source.indexOf('  const paths = '),end=source.indexOf('  document.querySelectorAll');
const context={};vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.markup=markup;this.pathsMarkup=pathsMarkup;',context);
const palette={shade:'#292929',reflection:'#005eaa',backShade:'#6b9fc8'};
const mark=context.markup('#0e5a54','#94c7b6',palette,'mailai-mark').replace('aria-hidden="true"','role="img" aria-label="MailAI"');
// macOS template glyphs must remain monochrome for the system's light/dark tint.
const template='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'+context.pathsMarkup('#000','#000')+'</svg>';
// Approved glass artwork keeps its 824px Dock body and original folded-M paths.
const nativeMark=context.pathsMarkup('url(#graphite)','url(#fold)').replaceAll('<path class=', '<path filter="url(#bevel)" class=');
const artwork=fs.readFileSync(path.join(__dirname,'brand-app-icon.svg'),'utf8');
if(!artwork.includes('<!-- BRAND_MARK -->'))throw new Error('Native icon template is missing the shared mark');
const app=artwork.replace('<!-- BRAND_MARK -->',nativeMark);
// Keep the bundled/exportable wordmark from retaining the retired shield logo.
const lockup=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2057 764">
 <svg x="70" y="72" width="620" height="620" viewBox="0 0 1024 1024">${app.replace(/^<svg[^>]*>/,'').replace(/<\/svg>\s*$/,'')}</svg>
 <text x="720" y="478" font-family="-apple-system,BlinkMacSystemFont,Arial,sans-serif" font-size="346" font-weight="700" letter-spacing="-12" fill="#0e5a54">Mail<tspan fill="#005eaa">AI</tspan></text>
 <text x="732" y="606" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="66" letter-spacing="16" fill="#536b61">邮件安全与效率助手</text>
</svg>`;
(async()=>{
 fs.mkdirSync(assets,{recursive:true});
 fs.writeFileSync(path.join(assets,'mailai-mark.svg'),mark);
 fs.writeFileSync(path.join(assets,'mailai-app-icon.svg'),app);
 fs.writeFileSync(path.join(assets,'mailai-lockup.svg'),lockup);
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({deviceScaleFactor:1});
  async function render(svg,size,name,height=size){
   await page.setViewportSize({width:size,height});
   await page.setContent('<style>html,body{margin:0;background:transparent;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>'+svg);
   await page.screenshot({path:path.join(assets,name),omitBackground:true});
  }
  await render(mark,1024,'mailai-mark.png');
  await render(app,1024,'mailai-app-icon-1024.png');
  await render(app,256,'mailai-icon-256.png');
  await render(template,64,'mailai-menu-template.png');
  await render(lockup,2057,'mailai-lockup.png',764);
 } finally { await browser.close(); }
 console.log('Generated shared folded-M SVGs, native icons, menu template and brand lockup');
})().catch(error=>{console.error(error);process.exitCode=1;});
