/* Fold only explicit mail quote/signature markers. The original message stays intact. */
(() => {
  const quoteMarker =
    /^(?:[-_]{3,}[^\n]{0,50}(?:Original Message|原始邮件)[^\n]*|On [^\n]{1,180}wrote:|在[^\n]{1,180}写道[:：])\s*$/im;
  const headerMarker =
    /^(?:From:|发件人[:：])[^\n]*\n(?:[^\n]*\n){0,2}(?:Sent:|Date:|发送时间[:：]|日期[:：])/im;
  function split(text) {
    text = String(text || "").replace(/\r\n?/g, "\n");
    const marker = quoteMarker.exec(text) || headerMarker.exec(text);
    let body = marker ? text.slice(0, marker.index) : text;
    const quote = marker ? text.slice(marker.index) : "";
    const signatureMarker = /^-- ?\n/m.exec(body);
    let signature = "";
    if (signatureMarker && body.length - signatureMarker.index <= 2500) {
      signature = body.slice(signatureMarker.index);
      body = body.slice(0, signatureMarker.index);
    }
    return { body, quote, signature };
  }
  window.mailaiReadingText = (email) => {
    const parts = split(email.body_text);
    return (
      mdToHtml(parts.body) +
      (parts.signature
        ? `<details class="mail-reading-fold"><summary>签名与落款 · 展开</summary><div>${mdToHtml(parts.signature)}</div></details>`
        : "") +
      (parts.quote
        ? `<details class="mail-reading-fold"><summary>历史引用 · 展开原文</summary><div>${mdToHtml(parts.quote)}</div></details>`
        : "")
    );
  };
  window.mailaiFoldReadingDocument = (doc, frame) => {
    if (!frame.closest("#reading-content,#digest-email-drawer")) return;
    const style = doc.createElement("style");
    style.textContent =
      'details[data-mailai-fold]{margin:16px 0;border-top:1px solid #dce5df;padding-top:10px}details[data-mailai-fold]>summary{cursor:pointer;color:#63776a;font:13px/1.7 Arial,sans-serif;padding:6px 0}html[data-mailai-theme="dark"] details[data-mailai-fold]{border-color:#41584b}html[data-mailai-theme="dark"] details[data-mailai-fold]>summary{color:#adc4b5}';
    doc.head.append(style);
    window.mailaiMotion?.bindDisclosures(doc);
    for (const [selector, label] of [
      [
        'blockquote[type="cite"],blockquote[cite],.gmail_quote,.yahoo_quoted,[data-mailai-quote],[data-compose-section="quote"]',
        "历史引用 · 展开原文",
      ],
      [
        '.gmail_signature,.moz-signature,[data-mailai-signature],[data-compose-section="signature"]',
        "签名与落款 · 展开",
      ],
    ]) {
      const nodes = [...doc.querySelectorAll(selector)].filter(
        (node) =>
          !node.parentElement?.closest(selector) &&
          !node.closest("details[data-mailai-fold]"),
      );
      for (const node of nodes) {
        if (!node.textContent.trim() && !node.querySelector("img")) continue;
        const details = doc.createElement("details");
        details.dataset.mailaiFold = "true";
        const summary = doc.createElement("summary");
        summary.textContent = label;
        node.before(details);
        details.append(summary, node);
      }
    }
  };
  window.mailaiMailTextSections = split;
})();
