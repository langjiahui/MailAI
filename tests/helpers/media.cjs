// MediaQueryList events and style changes do not necessarily arrive together.
// Observe the notification before asserting the application's new motion state.
async function reducedMotion(page,value) {
  await page.evaluate(value=>{
    const query=matchMedia('(prefers-reduced-motion: reduce)');
    window.ciMotionApplied=query.matches===(value==='reduce');
    if(!ciMotionApplied) query.addEventListener('change',()=>{ciMotionApplied=true;},{once:true});
  },value);
  await page.emulateMedia({reducedMotion:value});
  await page.waitForFunction(()=>ciMotionApplied);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
module.exports={reducedMotion};
