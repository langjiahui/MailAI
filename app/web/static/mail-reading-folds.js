/* Display the complete message in source order, including signatures and quotes. */
(() => {
  window.mailaiReadingText = (email) => mdToHtml(email?.body_text || '');
})();

/* Presentation-only compatibility for Windows-authored HTML signatures. */
window.mailaiPrepareReadingMarkup = doc => {
  const view = doc.defaultView;
  for (const node of doc.body.querySelectorAll('span,font')) {
    // Only Wingdings' documented phone/envelope slots. Other symbol fonts and
    // unknown glyphs must retain their original meaning and content.
    const family = view.getComputedStyle(node).fontFamily.split(',')[0].replace(/["']/g,'').trim();
    if (!/^Wingdings$/i.test(family)) continue;
    for (const text of [...node.childNodes].filter(child=>child.nodeType===3)) {
      const converted = text.nodeValue.replace(/[\u0028\u0029\u002a\uF028\uF029\uF02A]/g, glyph => {
        const slot=glyph.charCodeAt(0)&255;
        return slot===42 ? '✉' : '☎';
      });
      if (converted===text.nodeValue) continue;
      // Split runs so unknown characters still use the sender's original font.
      const fragment=doc.createDocumentFragment();
      for (const glyph of text.nodeValue) {
        if (/[\u0028\u0029\u002a\uF028\uF029\uF02A]/.test(glyph)) {
          const icon=doc.createElement('span');
          icon.style.setProperty('font-family','Arial, sans-serif','important');
          icon.textContent=(glyph.charCodeAt(0)&255)===42?'✉':'☎';
          fragment.append(icon);
        } else fragment.append(doc.createTextNode(glyph));
      }
      text.replaceWith(fragment);
    }
  }
  // Word-pasted signatures can carry tiny image tags whose file:/CID source
  // was unavailable and stripped. Hide only empty decorative slots, not real
  // images, remote-image placeholders, or meaningful alternative text.
  for (const image of doc.querySelectorAll('img:not([src]):not([srcset])')) {
    const width=Number(image.getAttribute('width')), height=Number(image.getAttribute('height'));
    if (width>0 && height>0 && width<=24 && height<=24 && !(image.getAttribute('alt')||'').trim()) {
      image.style.setProperty('display','none','important');
    }
  }
  // Recognize a complete, dedicated forward-header box by its direct rows.
  // Never move subsequent siblings (the actual message body) into the fold.
  const labels=/^(?:发件人|发送时间|收件人|抄送|主题|From|Sent|Date|To|Cc|Subject)\s*[:：]/i;
  const headers=[...doc.querySelectorAll('[id="divRplyFwdMsg"]')];
  for (const box of doc.querySelectorAll('blockquote div')) {
    const rows=[...box.children];
    if (rows.length<3 || rows.length>7 || rows.some(row=>row.tagName!=='DIV' || !labels.test(row.textContent.trim()))) continue;
    if ([...box.childNodes].some(node=>node.nodeType===3 && node.nodeValue.trim())) continue;
    const text=box.textContent;
    if (/(?:发件人|From)\s*[:：]/i.test(text) && /(?:收件人|To)\s*[:：]/i.test(text) && /(?:主题|Subject)\s*[:：]/i.test(text)) headers.push(box);
  }
  for (const header of headers) {
    if (header.closest('[data-mailai-history-header]')) continue;
    const text=header.textContent || '';
    if (!/(?:From|发件人)\s*[:：]/i.test(text) || !/(?:Subject|主题)\s*[:：]/i.test(text)) continue;
    const details=doc.createElement('details');
    details.setAttribute('data-mailai-history-header','');
    const summary=doc.createElement('summary');
    summary.textContent=mailaiT('read.historyHeader') || MAILAI_UI_COPY['read.historyHeader'][currentI18nLanguage()==='en' ? 1 : 0];
    header.before(details); details.append(summary,header);
  }
};
