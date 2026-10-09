/* Help entry points only navigate: they never sync, send or clean mail. */
(() => {
  const panel = document.querySelector('[data-system-panel="guide"]');
  if (!panel) return;
  const search = panel.querySelector('#guide-search');
  const entries = [...panel.querySelectorAll('[data-help-entry]')];
  const filters = [...panel.querySelectorAll('[data-help-filter]')];
  const topics = [...panel.querySelectorAll('.help-topic details')];
  let category = 'all';
  const normalize = value => value.toLocaleLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
  const queryWords = () => [...new Set(normalize(search.value).split(' ').filter(Boolean))];
  const content = entry => [...entry.querySelectorAll('.help-topic-copy [data-i18n], .help-location, .help-topic-body li, .help-faq-copy [data-i18n], .help-faq>div>p')];

  // Retain source character positions when normalization expands a character.
  function ranges(text, words) {
    let normalized = '', offset = 0;
    const positions = [];
    for (const char of text) {
      const part = char.toLocaleLowerCase().normalize('NFKC');
      for (let i = 0; i < part.length; i++) positions.push([offset, offset + char.length]);
      normalized += part; offset += char.length;
    }
    const found = [];
    for (const word of words) {
      let at = normalized.indexOf(word);
      while (at !== -1) {
        found.push([positions[at][0], positions[at + word.length - 1][1]]);
        at = normalized.indexOf(word, at + word.length);
      }
    }
    found.sort((a, b) => a[0] - b[0]);
    return found.reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push(range);
      return merged;
    }, []);
  }
  function highlight(node, words) {
    const source = node.textContent, fragment = document.createDocumentFragment();
    let at = 0;
    for (const [start, end] of ranges(source, words)) {
      fragment.append(document.createTextNode(source.slice(at, start)));
      const mark = document.createElement('mark'); mark.textContent = source.slice(start, end);
      fragment.append(mark); at = end;
    }
    fragment.append(document.createTextNode(source.slice(at)));
    node.replaceChildren(fragment);
  }
  for (const entry of entries) {
    const isTopic = entry.classList.contains('help-topic');
    let copy = entry.querySelector('.help-topic-copy');
    if (!isTopic) {
      const title = entry.querySelector('summary>[data-i18n]');
      copy = document.createElement('span'); copy.className = 'help-faq-copy';
      title.before(copy); copy.append(title);
    }
    const match = document.createElement('span'); match.className = 'help-match'; match.hidden = true;
    copy.append(match);
  }
  function refresh() {
    const words = queryWords();
    let topicCount = 0, faqCount = 0;
    for (const entry of entries) {
      const nodes = content(entry);
      const matchesCategory = category === 'all' || entry.dataset.helpCategory === category;
      const text = normalize(nodes.map(node => node.textContent).join(' '));
      entry.hidden = !matchesCategory || !words.every(word => text.includes(word));
      const details = entry.matches('details') ? entry : entry.querySelector('details');
      if (entry.hidden) details.open = false;
      else if (entry.classList.contains('help-topic')) topicCount++;
      else faqCount++;
      const match = entry.querySelector('.help-match');
      const bodyNodes = nodes.filter(node => node.matches('li, p:not(.help-location)'));
      const source = words.length && bodyNodes.find(node => words.some(word => normalize(node.textContent).includes(word)));
      match.hidden = !source || entry.hidden;
      match.textContent = '';
      if (source && !entry.hidden) {
        const text = source.textContent;
        const first = ranges(text, words)[0]?.[0] || 0;
        const start = Math.max(0, first - 28), end = Math.min(text.length, start + 140);
        match.textContent = (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
      }
      entry.querySelectorAll('.help-topic-copy [data-i18n], .help-faq-copy [data-i18n], .help-match').forEach(node => highlight(node, words));
    }
    const active = !!words.length || category !== 'all';
    filters.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.helpFilter === category)));
    panel.querySelector('#guide-clear').hidden = !search.value;
    panel.querySelector('.help-reset').hidden = !active;
    panel.querySelector('.help-start').hidden = active;
    panel.querySelector('.help-feature-section').hidden = !topicCount;
    panel.querySelector('.help-faq-section').hidden = !faqCount;
    panel.querySelector('#guide-empty').hidden = topicCount + faqCount > 0;
    panel.querySelector('.help-shortcuts').hidden = active;
    mailaiBindUI(panel.querySelector('#guide-results'), "textContent", () => ((mailaiT('guide.results') || '{topics} 个功能主题 · {faqs} 个常见问题')
      .replace('{topics}', String(topicCount)).replace('{faqs}', String(faqCount))));
  }
  function keepSummaryVisible(summary) {
    requestAnimationFrame(() => {
      const top = panel.querySelector('.help-toolbar').getBoundingClientRect().bottom + 12;
      const rect = summary.getBoundingClientRect();
      if (rect.top < top) panel.scrollTop += (rect.top - top) / (panel.getBoundingClientRect().width / panel.offsetWidth || 1);
      else if (rect.bottom > panel.getBoundingClientRect().bottom) summary.scrollIntoView({block:'nearest'});
    });
  }
  topics.forEach(details => details.addEventListener('toggle', () => {
    if (!details.open) return;
    topics.forEach(other => { if (other !== details) other.open = false; });
    if (!panel.classList.contains('hidden')) keepSummaryVisible(details.querySelector('summary'));
  }));
  const reset = () => { search.value = ''; category = 'all'; refresh(); search.focus({preventScroll:true}); panel.scrollTop = 0; };
  search.addEventListener('input', refresh);
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape' && search.value) {
      event.preventDefault(); event.stopPropagation(); search.value = ''; refresh();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const first = entries.find(entry => !entry.hidden);
      if (first) {
        const details = first.matches('details') ? first : first.querySelector('details');
        details.open = true; details.querySelector('summary').focus({preventScroll:true});
        keepSummaryVisible(details.querySelector('summary'));
      }
    }
  });
  panel.querySelector('#guide-clear').addEventListener('click', () => { search.value = ''; refresh(); search.focus({preventScroll:true}); });
  panel.querySelector('.help-categories').addEventListener('keydown', event => {
    const index = filters.indexOf(event.target);
    if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? filters.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + filters.length) % filters.length;
    filters[next].focus({preventScroll:true}); filters[next].scrollIntoView({block:'nearest', inline:'nearest'}); filters[next].click();
  });
  panel.addEventListener('click', event => {
    const filter = event.target.closest('[data-help-filter]');
    if (filter) { category = filter.dataset.helpFilter; refresh(); panel.scrollTop = 0; return; }
    if (event.target.closest('[data-help-reset]')) { reset(); return; }
    const collapse = event.target.closest('[data-help-collapse]');
    if (collapse) {
      const details = collapse.closest('details'); details.open = false;
      const summary = details.querySelector('summary'); summary.focus({preventScroll:true}); keepSummaryVisible(summary); return;
    }
    const settings = event.target.closest('[data-help-settings]');
    if (settings) {
      const tab = settings.dataset.helpSettings;
      if (!document.querySelector(`[data-system-tab="${tab}"]`)) return;
      selectSystemTab(tab);
      if (tab === 'maintenance') loadBackups();
      document.querySelector(`[data-system-tab="${tab}"]`)?.focus();
      return;
    }
    const action = event.target.closest('[data-help-action]');
    if (!action) return;
    const targets = {contacts:'btn-contacts', attachments:'btn-attachments', todos:'btn-todos', outbox:'btn-task-center', digest:'btn-digest', rules:'btn-rules'};
    const name = action.dataset.helpAction;
    if (!['mail', 'search', ...Object.keys(targets)].includes(name)) return;
    hideSystemView();
    if (!document.getElementById('system-view').classList.contains('hidden')) return;
    if (name === 'search') window.mailaiProductivity?.openSearch();
    else if (name === 'mail') document.getElementById('global-search')?.focus();
    else document.getElementById(targets[name])?.click();
  });
  document.addEventListener('mailai:language-changed', refresh);
  refresh();
})();
