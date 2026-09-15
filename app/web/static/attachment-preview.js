(() => {
  const dialog = document.createElement('dialog');
  dialog.className = 'file-preview';
  dialog.setAttribute('aria-labelledby', 'file-preview-title');
  dialog.innerHTML = `<header><div><small>附件预览</small><h2 id="file-preview-title"></h2></div><a class="btn-ghost" data-preview-download download>下载原文件</a><button type="button" aria-label="关闭预览">×</button></header><p class="file-preview-note" role="status"></p><main aria-busy="false"></main>`;
  document.body.append(dialog);
  const content = dialog.querySelector('main');
  const note = dialog.querySelector('.file-preview-note');
  const download = dialog.querySelector('a');
  let controller, objectUrl, generation = 0, previousFocus;
  function cleanup() {
    generation++;
    controller?.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    content.replaceChildren();
  }
  function close() { dialog.close(); }
  dialog.querySelector('button').addEventListener('click', close);
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('close', () => { cleanup(); previousFocus?.focus?.(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.addEventListener('keydown', event => {
    if (dialog.open && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    }
  }, true);
  function showText(text) {
    const pre = document.createElement('pre');
    pre.textContent = text || '没有可提取的文字，此文件可能为扫描件。请查看原版 PDF 或下载原文件。';
    content.replaceChildren(pre);
  }
  function showDocument(data, sourceUrl, current) {
    const tools = document.createElement('div'); tools.className = 'file-reader-tools';
    const viewport = document.createElement('div'); viewport.className = 'file-reader-viewport';
    const paper = document.createElement(data.kind === 'pdf' ? 'img' : 'article');
    paper.className = 'file-reader-paper';
    const zoom = document.createElement('select'); zoom.setAttribute('aria-label', '预览缩放');
    for (const [value, label] of [['fit','适合宽度'],['75','75%'],['100','100%'],['125','125%'],['150','150%']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; zoom.append(option);
    }
    zoom.addEventListener('change', () => {
      paper.style.width = zoom.value === 'fit' ? '' : (794 * Number(zoom.value) / 100) + 'px';
      paper.style.maxWidth = zoom.value === 'fit' ? '' : 'none';
    });
    tools.append(zoom); viewport.append(paper); content.replaceChildren(tools, viewport);
    if (data.kind !== 'pdf') {
      // Server emits a strict tag/attribute allowlist, with local raster images only.
      paper.innerHTML = data.html || '<p>文档没有可显示的正文</p>';
      return;
    }
    const previous = document.createElement('button'), next = document.createElement('button');
    previous.type = next.type = 'button'; previous.textContent = '上一页'; next.textContent = '下一页';
    const label = document.createElement('span'); label.setAttribute('aria-live', 'polite');
    tools.prepend(previous, label, next);
    let page = data.page, count = data.page_count;
    function display(value) {
      paper.src = 'data:image/png;base64,' + value.data; paper.alt = 'PDF 第 ' + (value.page + 1) + ' 页';
      page = value.page; label.textContent = (page + 1) + ' / ' + count;
      previous.disabled = page <= 0; next.disabled = page >= count - 1;
      viewport.scrollTop = 0;
    }
    async function navigate(target) {
      previous.disabled = next.disabled = true;
      const request = new AbortController(); controller = request;
      const timer = setTimeout(() => request.abort(), 25000);
      try {
        const url = new URL(sourceUrl); url.searchParams.set('page', target);
        const response = await fetch(url, {signal:request.signal});
        if (!response.ok) throw new Error('页面加载失败');
        const value = await response.json();
        if (current !== generation || !dialog.open) return;
        if (value.kind !== 'pdf') throw new Error(value.message || '页面加载失败');
        display(value); note.textContent = value.message;
      } catch (error) {
        if (current === generation && dialog.open) note.textContent = '页面加载失败，请重试或下载原文件';
      } finally {
        clearTimeout(timer);
        if (current === generation) { previous.disabled = page <= 0; next.disabled = page >= count - 1; }
      }
    }
    previous.addEventListener('click', () => navigate(page - 1));
    next.addEventListener('click', () => navigate(page + 1));
    display(data);
  }
  function showWorkbook(sheets) {
    const picker = document.createElement('select');
    picker.setAttribute('aria-label', '切换工作表');
    picker.className = 'file-sheet-picker';
    const viewport = document.createElement('div');
    viewport.className = 'file-sheet-scroll';
    sheets.forEach((sheet, index) => {
      const option = document.createElement('option');
      option.value = index; option.textContent = sheet.name; picker.append(option);
    });
    function render() {
      const sheet = sheets[Number(picker.value)];
      viewport.replaceChildren();
      if (!sheet?.rows?.length) { viewport.textContent = '此工作表为空'; return; }
      const table = document.createElement('table');
      table.setAttribute('aria-label', sheet.name);
      const head = table.createTHead().insertRow();
      const count = Math.max(...sheet.rows.map(row => row.length));
      for (let c = 0; c <= count; c++) {
        const th = document.createElement('th');
        let label = '', n = c;
        while (n) { n--; label = String.fromCharCode(65 + n % 26) + label; n = Math.floor(n / 26); }
        th.textContent = label; head.append(th);
      }
      const body = table.createTBody();
      sheet.rows.forEach((values, index) => {
        const row = body.insertRow();
        const number = document.createElement('th'); number.scope = 'row';
        number.textContent = index + 1; row.append(number);
        for (let c = 0; c < count; c++) row.insertCell().textContent = values[c] ?? '';
      });
      viewport.append(table);
    }
    picker.addEventListener('change', render);
    content.replaceChildren(picker, viewport); render();
  }
  window.openAttachmentPreview = async link => {
    cleanup();
    const current = generation;
    previousFocus = document.activeElement;
    const url = new URL(link.href, location.origin);
    const name = link.getAttribute('download') || link.querySelector('b, .att-name')?.textContent || '附件';
    dialog.querySelector('h2').textContent = name;
    download.href = url.href;
    download.download = name;
    note.textContent = '正在加载预览…';
    content.setAttribute('aria-busy', 'true');
    if (!dialog.open) dialog.showModal();
    controller = new AbortController();
    const requestController = controller;
    const timer = setTimeout(() => requestController.abort(), 25000);
    try {
      url.pathname += '/preview';
      const response = await fetch(url, {signal: controller.signal});
      if (!response.ok) throw new Error('预览加载失败，请重试或下载原文件');
      const data = await response.json();
      if (current !== generation || !dialog.open) return;
      note.textContent = data.message || '';
      if (data.kind === 'spreadsheet') {
        showWorkbook(data.sheets || []);
      } else if (data.kind === 'image') {
        const img = document.createElement('img');
        img.alt = data.name; img.src = 'data:image/png;base64,' + data.data;
        content.append(img);
      } else if (data.kind === 'pdf' || data.kind === 'document') {
        showDocument(data, url.href, current);
      } else if (data.kind === 'text') {
        showText(data.text);
      } else {
        showText(data.message || '暂不支持此格式，请下载原文件查看。');
      }
    } catch (error) {
      if (current !== generation || !dialog.open) return;
      note.textContent = error.name === 'AbortError' ? '预览加载超时，请重试或下载原文件' : error.message;
    } finally {
      clearTimeout(timer);
      if (current === generation) content.setAttribute('aria-busy', 'false');
    }
  };
})();
