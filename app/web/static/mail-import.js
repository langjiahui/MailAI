/* Exported client mail stays local; each dialog/job pins its selected account. */
(() => {
  const dialog = document.createElement('dialog');
  dialog.id = 'mail-import-dialog'; dialog.className = 'mail-import-dialog';
  dialog.setAttribute('aria-labelledby', 'mail-import-title');
  dialog.innerHTML = `<header><div><h2 id="mail-import-title">导入 Foxmail 邮件</h2><p>把旧邮件补到 MailAI 本地，原邮件和邮箱服务器保持不变。</p></div><button type="button" data-import-close aria-label="关闭导入窗口">×</button></header>
    <ol class="mail-import-steps" aria-label="导入步骤"><li data-step="select"><span>1</span>选择文件</li><li data-step="review"><span>2</span>核对结果</li><li data-step="apply"><span>3</span><b data-import-final-step>导入邮件</b></li></ol>
    <div class="mail-import-body">
      <div class="mail-import-options"><label>导入到哪个邮箱？<select id="mail-import-account"></select></label><label>归档名称<input id="mail-import-label" value="Foxmail 导入" maxlength="80"></label></div>
      <p class="mail-import-location">导入后在左侧此邮箱的「本地归档」中查看，默认标为已读。</p>
      <section data-import-select><details class="mail-import-help"><summary>如何从 Foxmail 导出邮件？</summary><ol><li>在 Foxmail 中进入收件箱、已发送等文件夹，选中要迁移的邮件，选择「导出邮件」。</li><li>把每个文件夹的邮件分别导出，放在同一个总目录下。这样可保留文件夹名称。</li><li>回到这里选择导出的文件或总目录。附件须在 Foxmail 中下载完整后再导出。</li></ol><p>支持 EML、MBOX 邮件文件，也适用于其他客户端导出的同类文件。Foxmail 的 Storage、.fox 数据库请先通过 Foxmail 导出。</p></details>
      <div class="mail-import-file-box"><b>选择 Foxmail 导出的邮件</b><p>可以一次选择多封邮件，也可以选择整个导出目录。</p><div><button type="button" data-import-files>选择邮件文件</button><button type="button" data-import-folder>选择导出目录</button></div><small>单个文件最多 1 GB；单封邮件最多 64 MB；每批最多 10 GB。</small></div>
      <input type="file" id="mail-import-files" accept=".eml,.mbox" multiple hidden><input type="file" id="mail-import-folder" webkitdirectory multiple hidden>
      <div data-import-selected aria-live="polite"></div></section>
      <section class="mail-import-progress" data-import-progress hidden><p data-import-status role="status" aria-live="polite"></p><progress aria-label="导入进度"></progress><small data-import-progress-note></small><small data-import-current hidden></small><div class="mail-import-live" data-import-live hidden></div></section>
      <section data-import-result hidden><div class="mail-import-counts"><div><small>识别邮件</small><b data-count="found">0</b></div><div><small>待新增</small><b data-count="new">0</b></div><div><small>重复跳过</small><b data-count="duplicates">0</b></div><div><small>无法导入</small><b data-count="failed">0</b></div></div><p class="mail-import-result-message" data-import-summary></p><details class="mail-import-folders" data-import-folders hidden><summary>邮件将放在哪些文件夹？</summary><p>在「本地归档」中按以下文件夹保留。本表是扫描时预计新增的数量。</p><ul></ul><small></small></details><div data-import-samples></div></section><details data-import-errors hidden><summary>查看需要检查的文件</summary><p data-import-issues-note></p><div></div><button type="button" data-import-report>下载完整问题清单</button></details>
      <p data-import-error role="alert"></p><section class="mail-import-history" data-import-history></section>
    </div><footer><button type="button" data-import-reset hidden>重新选择</button><button type="button" data-import-pause hidden>暂停</button><span></span><button type="button" data-import-close>关闭</button><button type="button" class="primary-action" data-import-action disabled>扫描并去重</button></footer>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector);
  let files = [], job = null, accountId = '', uploading = false, controller = null, inFlight = false;
  let renderedSamples = '', renderedIssues = '', renderedFolders = '';
  let timer = 0, generation = 0, pendingDone = null, returnFocus = null;
  const busy = () => inFlight || uploading || ['scanning', 'importing', 'uploading'].includes(job?.state);
  const request = (path, options = {}) => api('/api/mail/client-imports' + path, {accountId, ...options});
  const post = path => request(path, {method:'POST'});
  function setPending(working) {
    if (working && !pendingDone) pendingDone = window.mailaiMotion?.pending($('[data-import-status]')) || (() => {});
    if (!working && pendingDone) { pendingDone(); pendingDone = null; }
  }
  function labelError() {
    const name = $('#mail-import-label').value.trim();
    return !name ? '请填写归档名称，方便以后查找这批邮件。' : /[\\/\x00]/.test(name) ? '归档名称不能包含斜杠，请改用文字或空格。' : '';
  }
  function paint() {
    const working = busy(), state = job?.state;
    const reviewed = ['ready','importing','completed'].includes(state) || (['paused','failed'].includes(state) && job.phase === 'import');
    const step = !job || job.phase === 'upload' || job.phase === 'scan' && !reviewed ? 'select' : job.phase === 'import' ? 'apply' : 'review';
    $('[data-import-final-step]').textContent = state === 'completed' ? '导入完成' : '导入邮件';
    dialog.querySelectorAll('[data-step]').forEach(n => { n.classList.toggle('active', n.dataset.step === step); if (n.dataset.step === step) n.setAttribute('aria-current','step'); else n.removeAttribute('aria-current'); });
    $('#mail-import-account').disabled = Boolean(job) || busy();
    $('#mail-import-label').disabled = Boolean(job) || busy();
    $('[data-import-files]').disabled = busy(); $('[data-import-folder]').disabled = busy();
    dialog.querySelectorAll('[data-import-job]').forEach(n => n.disabled = busy());
    $('[data-import-select]').hidden = Boolean(job);
    $('[data-import-progress]').hidden = !job;
    $('[data-import-status]').textContent = uploading ? `正在添加文件：${job?.processed || 0} / ${files.length}` : state === 'paused' ? `${job.phase === 'import' ? '导入' : '扫描'}已暂停。点击「继续」恢复。` : job?.error || (job?.state === 'collecting' && job.expected_files && job.files !== job.expected_files ? `文件添加未完成（${job.files} / ${job.expected_files}）。请点击「重新选择」添加整批文件。` : job?.message) || '文件已添加，点击继续扫描';
    setPending(working);
    const progress = $('progress');
    const total = uploading ? files.length : job?.total || 0;
    progress.max = Math.max(total, 1);
    if (total) progress.value = job?.processed || 0; else progress.removeAttribute('value');
    $('[data-import-progress-note]').textContent = uploading ? '正在复制到本机工作目录。停止后可重新选择文件。' : state === 'importing' ? '可暂停或关闭窗口。关闭后会在后台继续导入。' : state === 'scanning' ? '扫描只核对邮件，尚未导入。关闭窗口后会继续扫描。' : ['paused','failed'].includes(state) ? (job.phase === 'import' ? '已成功导入的邮件会保留，继续时会自动跳过。' : '继续后会重新扫描整批文件，扫描不会修改已有邮件。') : '';
    const current = $('[data-import-current]');
    current.hidden = !job?.current_source || job?.phase === 'upload';
    current.textContent = job?.current_source ? `当前文件：${job.current_source}${job.phase === 'scan' && job.source_total ? ` · 已扫描 ${Number(job.source_processed || 0).toLocaleString()} / ${Number(job.source_total).toLocaleString()} 封` : ''}` : '';
    const live = $('[data-import-live]');
    live.hidden = !job || job.phase === 'upload' || reviewed;
    live.textContent = job ? `已识别 ${Number(job.found || 0).toLocaleString()} 封 · 待新增 ${Number(job.new || 0).toLocaleString()} 封 · 重复 ${Number(job.duplicates || 0).toLocaleString()} 封 · 无法导入 ${Number(job.failed || 0).toLocaleString()} 项` : '';
    $('[data-import-result]').hidden = !reviewed;
    if (reviewed) {
      for (const n of dialog.querySelectorAll('[data-count]')) n.textContent = Number(job[n.dataset.count] || 0).toLocaleString();
      const imported = Number(job.imported || 0);
      $('[data-count="new"]').textContent = state === 'completed' || job.phase === 'import' ? imported.toLocaleString() : Number(job.new || 0).toLocaleString();
      $('[data-count="new"]').previousElementSibling.textContent = job.phase === 'import' ? '已新增' : '待新增';
      $('[data-import-summary]').textContent = state === 'completed' ? `已新增 ${imported} 封，跳过重复 ${job.duplicates} 封${job.failed ? `，${job.failed} 项未能导入` : ''}。在「本地归档」中查看。` : !job.new ? (job.failed ? `没有可新增的邮件，${job.failed} 项无法识别。请查看下方原因，重新导出后再选择。` : job.errors?.length ? '没有可确认新增的邮件。部分已有邮件原文不完整，请展开文件说明，重新同步后再导入。' : '没有需要新增的邮件。已有邮件会保留，无需再次导入。') : `预计新增 ${job.new} 封邮件；重复项会自动跳过，原有邮件不会被覆盖。`;
      const sampleKey = JSON.stringify(job.samples || []);
      if (renderedSamples !== sampleKey) {
        const wasOpen = $('[data-import-samples] details')?.open;
        $('[data-import-samples]').innerHTML = (job.samples || []).length ? `<details><summary>预览前 ${(job.samples || []).length} 封待新增邮件</summary><div class="mail-import-samples">${job.samples.map(row=>`<article><b>${esc(row.subject)}</b><small>${esc(row.from_addr)} · ${esc(row.date || '日期未记录')}${row.folder ? ` · ${esc(row.folder)}` : ''}</small></article>`).join('')}</div></details>` : '';
        if (wasOpen && $('[data-import-samples] details')) $('[data-import-samples] details').open = true;
        renderedSamples = sampleKey;
      }
      const folders = job.folders || [];
      const folderKey = JSON.stringify([job.label, folders]);
      $('[data-import-folders]').hidden = !folders.length;
      if (renderedFolders !== folderKey) {
        $('[data-import-folders] ul').innerHTML = folders.map(row=>`<li><span>${esc(job.label)}${row.name ? ' / ' + esc(row.name) : ' / 未分文件夹'}</span><b>${Number(row.count).toLocaleString()} 封</b></li>`).join('');
        $('[data-import-folders] small').textContent = job.folder_count > folders.length ? `共 ${job.folder_count} 个文件夹，这里显示前 ${folders.length} 个。` : '';
        renderedFolders = folderKey;
      }
    }
    const issues = job?.errors || [];
    $('[data-import-errors]').hidden = !issues.length;
    const issueKey = JSON.stringify(issues);
    if (renderedIssues !== issueKey) {
      $('[data-import-errors] > div').innerHTML = issues.map(row=>`<p><b>${esc(row.file)}</b><br>${esc(row.reason)}</p>`).join('');
      renderedIssues = issueKey;
    }
    const issueCount = job?.issue_count ?? issues.length;
    $('[data-import-issues-note]').textContent = issueCount > issues.length ? `共有 ${issueCount} 项需要检查，这里显示前 ${issues.length} 项。下载清单可查看全部文件和处理建议。` : '每项都附有原因和处理建议。可下载清单，逐项重新导出或重试。';
    $('[data-import-report]').disabled = working || !issueCount;
    $('[data-import-reset]').hidden = !job;
    $('[data-import-reset]').disabled = working;
    const pause = $('[data-import-pause]'); pause.hidden = !uploading && !['scanning','importing'].includes(state);
    pause.disabled = !uploading && (inFlight || Boolean(job?.cancel)); pause.textContent = uploading ? '停止添加' : job?.cancel ? '正在暂停…' : '暂停';
    const action = $('[data-import-action]');
    action.textContent = inFlight && !uploading ? '请稍候…' : state === 'completed' ? '查看导入邮件' : ['paused','failed'].includes(state) ? '继续' : state === 'ready' ? `导入缺少的 ${job.new} 封邮件` : '扫描并去重';
    action.disabled = working || (state === 'collecting' && (!job.files || job.expected_files && job.files !== job.expected_files)) || (!job ? !files.length || !accountId || Boolean(labelError()) : state === 'ready' ? !job.new : !['completed','paused','failed','collecting'].includes(state));
  }
  function selected() {
    const ignored = files.filter(n => !/\.(eml|mbox)$/i.test(n.name)).length;
    files = files.filter(n => /\.(eml|mbox)$/i.test(n.name));
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    const tooLarge = files.find(file => file.size > (/\.eml$/i.test(file.name) ? 64 * 1024**2 : 1024**3));
    const error = tooLarge ? `${tooLarge.name} 超过 ${/\.eml$/i.test(tooLarge.name) ? '单封邮件 64 MB' : '单个文件 1 GB'} 的限制，请在 Foxmail 中检查后重新导出。` : bytes > 10 * 1024**3 ? '所选文件超过 10 GB，请分批选择。' : files.length > 20000 ? '一批最多选择 20000 个文件，请分批选择。' : '';
    $('[data-import-error]').textContent = error || (files.length ? labelError() : '') || (!files.length ? '未找到邮件文件，请先从 Foxmail 导出为 EML 或 MBOX。' : '');
    $('[data-import-selected]').innerHTML = files.length ? `<p><b>已选择 ${files.length} 个邮件文件</b> · ${formatFileSize(bytes)}${ignored ? ` · 跳过 ${ignored} 个非邮件文件` : ''}</p><ul>${files.slice(0,5).map(file=>`<li>${esc(file.webkitRelativePath || file.name)}</li>`).join('')}</ul>` : '';
    if (error) files = [];
    if (files.length) $('.mail-import-help').open = false;
    paint();
  }
  async function listHistory(version = generation) {
    try {
      const rows = (await request('')).filter(row=>row.files);
      if (version !== generation || !dialog.open) return;
      $('[data-import-history]').innerHTML = rows.length ? `<details><summary>最近导入记录 · ${rows.length}</summary>${rows.map(row=>`<button type="button" data-import-job="${esc(row.token)}"><span>${esc(row.label)}<small>${new Date(row.created_at * 1000).toLocaleString()} · ${row.files} 个文件</small></span><b>${esc({collecting:'待扫描',scanning:'扫描中',ready:'待确认',importing:'导入中',completed:`新增 ${row.imported} 封`,paused:'已暂停',failed:'待重试'}[row.state] || '待重新选择')}</b></button>`).join('')}</details>` : '';
    } catch (error) { if (version === generation) $('[data-import-error]').textContent = error.message; }
  }
  function poll() {
    clearTimeout(timer);
    if (!dialog.open || !job || !['scanning','importing','uploading'].includes(job.state)) return;
    const version = generation, token = job.token;
    timer = setTimeout(async () => {
      try {
        const result = await request('/' + token);
        if (version !== generation || job?.token !== token || !dialog.open) return;
        job = result; $('[data-import-error]').textContent = ''; paint();
        if (job.state === 'completed') { listHistory(version); }
      } catch (error) { if (version === generation) $('[data-import-error]').textContent = `${error.message}。恢复连接后会继续读取进度。`; }
      if (version === generation) poll();
    }, 800);
  }
  async function open(id = '') {
    if (dialog.open) return;
    generation++; clearTimeout(timer); job = null; files = []; uploading = false; inFlight = false;
    renderedSamples = renderedIssues = renderedFolders = '';
    $('[data-import-errors]').open = false; $('[data-import-folders]').open = false;
    accountId = id || activeMailAccount()?.id || '';
    returnFocus = document.activeElement;
    const accounts = _systemConfig?.accounts || [];
    $('#mail-import-account').innerHTML = accounts.map(row=>`<option value="${esc(row.id)}">${esc(row.user)} · ${esc(row.host || '')}</option>`).join('');
    $('#mail-import-account').value = accountId;
    accountId = $('#mail-import-account').value;
    $('#mail-import-label').value = 'Foxmail 导入';
    $('#mail-import-files').value = ''; $('#mail-import-folder').value = '';
    $('[data-import-selected]').replaceChildren(); $('[data-import-history]').replaceChildren();
    $('[data-import-error]').textContent = accountId ? '' : '请先在「设置 → 邮箱账号」添加邮箱，再导入旧邮件。';
    paint(); dialog.showModal(); $('#mail-import-account').focus(); listHistory();
  }
  async function close() {
    if (inFlight && !uploading) { $('[data-import-error]').textContent = '正在提交操作，请稍候再关闭窗口。'; return; }
    if (uploading) { $('[data-import-error]').textContent = '正在添加文件。请先点击「停止添加」，再关闭窗口。'; return; }
    clearTimeout(timer); generation++; setPending(false); dialog.close();
    returnFocus?.focus({preventScroll:true});
  }
  dialog.querySelectorAll('[data-import-close]').forEach(n=>n.onclick=close);
  dialog.addEventListener('cancel', event=>{event.preventDefault();close();});
  $('#mail-import-account').onchange = () => { accountId = $('#mail-import-account').value; generation++; paint(); listHistory(); };
  $('#mail-import-label').oninput = () => { $('[data-import-error]').textContent = labelError(); paint(); };
  $('[data-import-files]').onclick = () => $('#mail-import-files').click();
  $('[data-import-folder]').onclick = () => $('#mail-import-folder').click();
  for (const selector of ['#mail-import-files','#mail-import-folder']) $(selector).onchange=event=>{if (busy() || job) return; files=Array.from(event.target.files || []);selected();};
  $('[data-import-history]').onclick = async event => {
    const n = event.target.closest('[data-import-job]'); if (!n || busy()) return;
    const version = ++generation; inFlight = true; paint();
    try { const result = await request('/' + n.dataset.importJob); if (version !== generation) return;
      job = result; renderedSamples = renderedIssues = renderedFolders = ''; $('#mail-import-label').value = job.label;
    } catch (error) { $('[data-import-error]').textContent = error.message; }
    finally { inFlight = false; paint(); poll(); }
  };
  $('[data-import-reset]').onclick = async () => {
    if (busy()) return;
    inFlight = true; paint();
    try { if (job && job.state !== 'completed') await request('/' + job.token, {method:'DELETE'});
      job = null; files = []; generation++; clearTimeout(timer); setPending(false);
      $('#mail-import-files').value = ''; $('#mail-import-folder').value = '';
      $('[data-import-selected]').replaceChildren(); $('[data-import-error]').textContent = ''; paint(); listHistory();
    } catch (error) { $('[data-import-error]').textContent = error.message; }
    finally { inFlight = false; paint(); poll(); }
  };
  $('[data-import-pause]').onclick = async () => {
    if (uploading) { controller?.abort(); return; }
    if (inFlight || !job) return;
    inFlight = true; paint();
    try { job = await post('/' + job.token + '/pause'); }
    catch (error) { $('[data-import-error]').textContent = error.message; }
    finally { inFlight = false; paint(); poll(); }
  };
  $('[data-import-report]').onclick = async () => {
    if (busy() || !job) return;
    $('[data-import-error]').textContent = '';
    inFlight = true; paint();
    const version = generation;
    let url;
    try {
      const response = await fetch(mailboxResourceUrl('/api/mail/client-imports/' + job.token + '/report', accountId));
      if (!response.ok) {
        const result = await response.json(); throw new Error(result.detail || '无法下载清单，请稍后重试');
      }
      url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'MailAI-导入问题清单.csv';
      document.body.append(link); link.click(); link.remove();
    } catch (error) { if (version === generation) $('[data-import-error]').textContent = error.message; }
    finally {
      if (url) setTimeout(()=>URL.revokeObjectURL(url), 1000);
      if (version === generation) { inFlight = false; paint(); poll(); }
    }
  };
  $('[data-import-action]').onclick = async () => {
    if (busy() || $('[data-import-action]').disabled) return;
    $('[data-import-error]').textContent = '';
    const version = generation;
    // Lock before awaiting creation: a second click cannot create another batch.
    inFlight = true; paint();
    try {
      if (job?.state === 'completed') {
        const target = accountId; inFlight = false; await close(); hideSystemView(true); await openAccountMailbox(target, 'local_archive'); return;
      }
      if (!job) {
        job = await request('', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:$('#mail-import-label').value.trim(),expected_files:files.length})});
        uploading = true; controller = new AbortController(); paint();
        for (let i=0; i<files.length; i++) {
          const file = files[i];
          let name = file.webkitRelativePath || file.name;
          if (file.webkitRelativePath) name = name.split('/').slice(1).join('/');
          job = await request('/' + job.token + '/files?name=' + encodeURIComponent(name), {method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file,signal:controller.signal});
          job.processed = i + 1; paint();
        }
        uploading = false; controller = null;
      }
      job = await post('/' + job.token + (job.state === 'ready' || job.phase === 'import' ? '/apply' : '/scan'));
      if (version === generation) { paint(); poll(); }
    } catch (error) {
      uploading = false; controller = null; setPending(false);
      if (version === generation) {
        if (job) { try { job = await request('/' + job.token); } catch (_) {} }
        $('[data-import-error]').textContent = error.name === 'AbortError' ? '已停止添加。点击「重新选择」后可重新添加整批文件。' : error.message;
        paint();
      }
    } finally { if (version === generation) { inFlight = false; paint(); poll(); } }
  };
  document.getElementById('btn-import-client-mail').onclick = () => open();
  document.getElementById('btn-account-import-mail').onclick = () => open(selectedManagedAccountId || activeMailAccount()?.id);
  window.mailaiMailImport = {open};
})();
