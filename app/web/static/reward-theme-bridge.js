/* Resolve legacy fixed UI colors through the reward palette. Layout, semantic
 * status colors, mail content, images and independently equipped pets are kept.
 * The bridge is scoped: the original themes retain their original CSS values. */
(() => {
  const colorToken = /#[\da-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/gi;
  function rgba(value) {
    if (value === 'white') return [255,255,255,1];
    if (value === 'black') return [0,0,0,1];
    if (value[0] === '#') {
      let hex=value.slice(1);
      if (hex.length===3 || hex.length===4) hex=[...hex].map(char=>char+char).join('');
      if (hex.length!==6 && hex.length!==8) return null;
      return [0,2,4].map(index=>parseInt(hex.slice(index,index+2),16)).concat(hex.length===8 ? parseInt(hex.slice(6),16)/255 : 1);
    }
    const parts=value.match(/[\d.]+/g)?.map(Number);
    return parts?.length>=3 ? [...parts.slice(0,3),parts[3] ?? 1] : null;
  }
  function tone(value) {
    const channels=rgba(value.toLowerCase());
    if (!channels) return null;
    const [r,g,b,alpha]=channels,high=Math.max(r,g,b),low=Math.min(r,g,b),delta=high-low;
    let hue=delta ? high===r ? (g-b)/delta : high===g ? (b-r)/delta+2 : (r-g)/delta+4 : 0;
    hue=(hue*60+360)%360;
    return {alpha,light:(high+low)/510,saturation:high ? delta/high : 0,hue};
  }
  function translate(value, property, onAccent) {
    return value.replace(colorToken,original=>{
      const color=tone(original);
      if (!color || color.alpha===0) return original;
      const {alpha,light,saturation,hue}=color;
      // Red, amber and other categorical colors continue conveying their meaning.
      if (saturation>.24 && (hue<55 || hue>265)) return original;
      let role;
      if (/shadow/.test(property)) {
        if (saturation<.24) return original;
        role='accent';
      }
      else if (/accent|primary|highlight|focus|caret/.test(property)) role='accent';
      else if (/color$|ink|text|copy|muted|subtle/.test(property) && !/background|border|outline/.test(property)) {
        role=onAccent && light>.72 ? 'on-accent' : saturation>.28 ? 'accent' : light<.32 || light>.72 ? 'ink' : 'muted';
      } else if (/border|outline|line|edge|rim|separator/.test(property)) role=saturation>.3 && light<.7 ? 'accent' : 'line';
      else if (/fill|stroke/.test(property)) role='accent';
      else {
        if (light<.04 && alpha<.9) return original; // Backdrops remain neutral translucent black.
        role=light>.96 ? 'surface' : light>.87 ? 'soft' : saturation>.28 && light>.2 && light<.72 ? 'accent' : light>.6 ? 'selected' : 'soft';
      }
      const variable=`var(--reward-${role})`;
      return alpha<1 ? `color-mix(in srgb,${variable} ${Math.round(alpha*10000)/100}%,transparent)` : variable;
    });
  }
  function selectors(value) {
    // Commas inside :is(), :not() or attribute values are not selector boundaries.
    const parts=[];let start=0,depth=0,quote='';
    for (let index=0;index<value.length;index++) {
      const char=value[index];
      if (char==='\\') { index++;continue; }
      if (quote) { if (char===quote) quote='';continue; }
      if (char==='"' || char==="'") quote=char;
      else if (char==='(' || char==='[') depth++;
      else if (char===')' || char===']') depth--;
      else if (char===',' && !depth) { parts.push(value.slice(start,index).trim());start=index+1; }
    }
    parts.push(value.slice(start).trim());return parts;
  }
  function scope(selector) {
    return /^(?:html(?=[.#[:\s>]|$)|:root)/.test(selector)
      ? selector.replace(/^(html|:root)/,'$1[data-reward-theme]')
      : `html[data-reward-theme] ${selector}`;
  }
  function bridge(rules) {
    let result='';
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const selector=selectors(rule.selectorText).filter(value=>
          !/\.(?:growth-|mail-companion|companion-(?:leaf|gaze|body|eyes))|pet-item-art|pet-theme-preview|pet-theme-mini/.test(value) &&
          !/\b(?:success|danger|warn(?:ing)?|risk-|security-|priority-|diagnostic-(?:error|warn))/.test(value)
        ).map(scope).join(',');
        if (!selector) continue;
        const background=rule.style.getPropertyValue('background') || rule.style.getPropertyValue('background-color');
        const onAccent=/var\(--(?:primary|desk-accent|success)/.test(background) || [...background.matchAll(colorToken)].some(match=>{
          const color=tone(match[0]);return color && color.alpha>=.8 && color.saturation>.28 && color.light>.2 && color.light<.72;
        });
        let declarations='';
        for (const property of rule.style) {
          if (!/^(?:--|color$|background(?:-color|-image)?$|border(?:-(?:top|right|bottom|left))?(?:-color)?$|outline(?:-color)?$|box-shadow$|text-shadow$|fill$|stroke$|caret-color$|accent-color$|text-decoration-color$)/.test(property)) continue;
          if (/^--.*(?:success|danger|warn)/.test(property)) continue;
          const value=rule.style.getPropertyValue(property),mapped=translate(value,property,onAccent);
          // Keep later transparent/currentColor resets in the same cascade as
          // mapped rules; otherwise an earlier fixed background can reappear.
          if (value!==mapped || !property.startsWith('--')) declarations+=`${property}:${mapped}!important;`;
        }
        if (declarations) result+=`${selector}{${declarations}}\n`;
      } else if (rule.cssRules && !/keyframes/i.test(rule.cssText.slice(0,40))) {
        const nested=bridge(rule.cssRules);
        if (nested) result+=`${rule.cssText.slice(0,rule.cssText.indexOf('{'))}{${nested}}\n`;
      }
    }
    return result;
  }
  let css='';
  for (const sheet of document.styleSheets) {
    if (!sheet.href?.includes('/static/') || /(?:reward-themes|companion(?:-growth)?)\.css/.test(sheet.href)) continue;
    try { css+=bridge(sheet.cssRules); } catch (_) { /* A non-local stylesheet is outside the workspace. */ }
  }
  const style=document.createElement('style');
  style.id='reward-theme-legacy-bridge';style.textContent=css;
  document.querySelector('link[href*="/reward-themes.css"]')?.before(style);
  function syncBrandIcon() {
    const icon=document.querySelector('link[rel="icon"]'),mark=document.querySelector('.reward-brand-mark');
    if (!icon || !mark) return;
    if (!document.documentElement.dataset.rewardTheme) {
      icon.type='image/png';icon.href='/static/assets/mailai-mark.png';return;
    }
    const palette=getComputedStyle(document.documentElement),svg=mark.cloneNode(true);
    svg.setAttribute('xmlns','http://www.w3.org/2000/svg');svg.removeAttribute('class');
    for (const [selector,property,role] of [
      ['.reward-brand-shield','fill','accent'],['.reward-brand-base','fill','pet'],
      ['.reward-brand-check','stroke','accent'],['.reward-brand-star','fill','pet-outline']
    ]) svg.querySelector(selector).setAttribute(property,palette.getPropertyValue(`--reward-${role}`).trim());
    icon.type='image/svg+xml';icon.href=`data:image/svg+xml,${encodeURIComponent(svg.outerHTML)}`;
  }
  document.addEventListener('mailai:reward-themechange',syncBrandIcon);
  document.addEventListener('mailai:themechange',syncBrandIcon);
})();
