/* Display the complete message in source order, including signatures and quotes. */
(() => {
  window.mailaiReadingText = (email) => mdToHtml(email?.body_text || '');
})();
