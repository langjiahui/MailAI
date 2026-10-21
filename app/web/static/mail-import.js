/* Exported client mail stays local; each dialog/job pins its selected account. */
(() => {
  const dialog = document.createElement('dialog');
  dialog.id = 'mail-import-dialog'; dialog.className = 'mail-import-dialog';
  dialog.setAttribute('aria-labelledby', 'mail-import-title');
  dialog.innerHTML = `<header><div><h2 id="mail-import-title"><span data-i18n="ui.ab20177968ee">导入 Foxmail 邮件</span></h2><p><span data-i18n="ui.42b74f6b3e4b">把旧邮件补到 MailAI 本地，原邮件和邮箱服务器保持不变。</span></p></div><button type="button" data-import-close aria-label="关闭导入窗口" data-i18n-aria="ui.d20b0bd83630">×</button></header>
    <ol class="mail-import-steps" aria-label="导入步骤" data-i18n-aria="ui.4936fcb3bd29"><li data-step="select"><span>1</span><span data-i18n="ui.822fb37dba29">选择文件</span></li><li data-step="review"><span>2</span><span data-i18n="ui.729cd4b71e0a">核对结果</span></li><li data-step="apply"><span>3</span><b data-import-final-step><span data-i18n="ui.a2614ead6041">导入邮件</span></b></li></ol>
    <div class="mail-import-body">
      <div class="mail-import-options"><label><span data-i18n="ui.3bd43bd793d1">导入到哪个邮箱？</span><select id="mail-import-account"></select></label><label><span data-i18n="ui.ffab51e77800">归档名称</span><input id="mail-import-label" value="Foxmail 导入" maxlength="80"></label></div>
      <p class="mail-import-location"><span data-i18n="mailImport.location">导入后在「本地归档」中查看，默认已读；可移到 MailAI 收件箱，仅在本机整理。</span></p>
      <section data-import-select><details class="mail-import-help"><summary><span data-i18n="ui.ca48255d93ad">如何从 Foxmail 导出邮件？</span></summary><ol><li><span data-i18n="ui.81cda90241df">在 Foxmail 中进入收件箱、已发送等文件夹，选中要迁移的邮件，选择「导出邮件」。</span></li><li><span data-i18n="ui.34ed41f26457">把每个文件夹的邮件分别导出，放在同一个总目录下。这样可保留文件夹名称。</span></li><li><span data-i18n="ui.b9c4156320e0">回到这里选择导出的文件或总目录。附件须在 Foxmail 中下载完整后再导出。</span></li></ol><p><span data-i18n="ui.0f7bb2368cf9">支持 EML、MBOX 邮件文件，也适用于其他客户端导出的同类文件。Foxmail 的 Storage、.fox 数据库请先通过 Foxmail 导出。</span></p></details>
      <div class="mail-import-file-box"><b><span data-i18n="ui.fee481c85284">选择 Foxmail 导出的邮件</span></b><p><span data-i18n="ui.737c928009f0">可以一次选择多封邮件，也可以选择整个导出目录。</span></p><div><button type="button" data-import-files><span data-i18n="ui.bfe1dea0b951">选择邮件文件</span></button><button type="button" data-import-folder><span data-i18n="ui.046b6f007bf0">选择导出目录</span></button></div><small><span data-i18n="ui.df468f0acffe">单个文件最多 1 GB；单封邮件最多 64 MB；每批最多 10 GB。</span></small></div>
      <input type="file" id="mail-import-files" accept=".eml,.mbox" multiple hidden><input type="file" id="mail-import-folder" webkitdirectory multiple hidden>
      <div data-import-selected aria-live="polite"></div></section>
      <section class="mail-import-progress" data-import-progress hidden><p data-import-status role="status" aria-live="polite"></p><progress aria-label="导入进度" data-i18n-aria="ui.5b676bd12914"></progress><small data-import-progress-note></small><small data-import-current hidden></small><div class="mail-import-live" data-import-live hidden></div></section>
      <section data-import-result hidden><div class="mail-import-counts"><div><small><span data-i18n="ui.36689263737d">识别邮件</span></small><b data-count="found">0</b></div><div><small><span data-i18n="ui.b2d9abb23920">待新增</span></small><b data-count="new">0</b></div><div><small><span data-i18n="ui.b83bf31b01f2">重复跳过</span></small><b data-count="duplicates">0</b></div><div><small><span data-i18n="ui.751d82db8361">无法导入</span></small><b data-count="failed">0</b></div></div><p class="mail-import-result-message" data-import-summary></p><details class="mail-import-folders" data-import-folders hidden><summary><span data-i18n="ui.8b9f60b1b5e1">邮件将放在哪些文件夹？</span></summary><p><span data-i18n="ui.8026d5ac9274">在「本地归档」中按以下文件夹保留。本表是扫描时预计新增的数量。</span></p><ul></ul><small></small></details><div data-import-samples></div></section><details data-import-errors hidden><summary><span data-i18n="ui.90d83999bd64">查看需要检查的文件</span></summary><p data-import-issues-note></p><div></div><button type="button" data-import-report><span data-i18n="ui.c9630d09a5f2">下载完整问题清单</span></button></details>
      <p data-import-error role="alert"></p><p data-import-failed-file hidden></p><p data-import-retry-help hidden></p><p data-import-skipped hidden></p><section class="mail-import-history" data-import-history></section>
    </div><footer><button type="button" data-import-reset hidden><span data-i18n="ui.9b904c0e2faf">重新选择</span></button><button type="button" data-import-skip hidden><span data-i18n="mailImport.skipFile">跳过此文件，继续添加</span></button><button type="button" data-import-pause hidden><span data-i18n="ui.8d12fc0d4eb2">暂停</span></button><span></span><button type="button" data-import-close><span data-i18n="ui.3fd47edce45b">关闭</span></button><button type="button" class="primary-action" data-import-action disabled><span data-i18n="ui.afcd60d848dc">扫描并去重</span></button></footer>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector);
  let files = [], job = null, accountId = '', uploading = false, controller = null, inFlight = false;
  let renderedSamples = '', renderedIssues = '', renderedFolders = '';
  let timer = 0, generation = 0, pendingDone = null, returnFocus = null, uploadCursor = 0, failedUpload = null;
  const canResumeUpload = () => job?.state === 'collecting' && job.phase === 'upload';
  const fileName = file => file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
  const transferError = error => error instanceof TypeError ? mailaiText('文件传输中断。已添加的文件已保留，请点击「继续添加」；若文件已移动，请重新选择原文件。') : mailaiSystemMessage(error.message);
  const busy = () => inFlight || uploading || ['scanning', 'importing', 'uploading'].includes(job?.state);
  const request = (path, options = {}) => api('/api/mail/client-imports' + path, {accountId, ...options});
  const post = path => request(path, {method:'POST'});
  function setPending(working) {
    if (working && !pendingDone) pendingDone = window.mailaiMotion?.pending($('[data-import-status]')) || (() => {});
    if (!working && pendingDone) { pendingDone(); pendingDone = null; }
  }
  function uploadAdvice(reason) {
    if (/64\s*MB|1\s*GB|10\s*GB|超过.*封|超过.*文件/i.test(reason)) return mailaiText("单封邮件需小于等于 64 MB，MBOX 需小于等于 1 GB，每批不超过 10 GB。请在原客户端分批导出；单封超大邮件可保留原件后，另存较小副本再导入。");
    if (/为空|空文件/i.test(reason)) return mailaiText("此文件没有邮件内容。请在原客户端打开邮件，下载完整正文和附件后重新导出；确认文件大小不为 0，再单独导入。");
    if (/找不到|不存在|读取失败/i.test(reason)) return mailaiText("请确认源文件仍在原位置且可读取，云盘文件需先下载到本机。若暂存文件已丢失，请重新选择原文件建立新批次；已导入邮件会自动去重。");
    if (/磁盘|权限|暂存|保存|写入/i.test(reason)) return mailaiText("请检查 MailAI 数据目录所在磁盘的剩余空间和写入权限，并确认源文件可读取。处理后重试；已成功导入的邮件会保留。");
    if (/传输|连接|fetch|network|中断/i.test(reason)) return mailaiText("请确认 MailAI 服务仍在运行，源文件未被移动或删除；云盘文件需先下载到本机。可点击继续添加重试，仍失败时先跳过，稍后单独导入。");
    if (/顺序|不一致|变化/i.test(reason)) return mailaiText("恢复任务时请选择原批次文件并保持原顺序。若已修改文件，请新建导入批次；已有邮件会自动去重。");
    if (/路径/i.test(reason)) return mailaiText("请将文件复制到本机普通目录，缩短文件名及目录层级，避免特殊路径字符后重新选择。");
    if (/原文不完整|同标识/i.test(reason)) return mailaiText("请先核对本机已有的同一邮件，补齐原文和附件后再试；系统会跳过无法确认内容的同标识邮件，避免误建重复记录。");
    return mailaiText("请用原邮件客户端打开此文件并确认正文和附件完整，再重新导出为 EML 或 MBOX；不要仅修改文件扩展名。可先导入其他文件，修复后将此文件单独补导。");
  }
  function labelError() {
    const name = $('#mail-import-label').value.trim();
    return !name ? mailaiText('请填写归档名称，方便以后查找这批邮件。') : /[\\/\x00]/.test(name) ? mailaiText('归档名称不能包含斜杠，请改用文字或空格。') : '';
  }
  function paint() {
    const working = busy(), state = job?.state;
    const reviewed = ['ready','importing','completed'].includes(state) || (['paused','failed'].includes(state) && job.phase === 'import');
    const step = !job || job.phase === 'upload' || job.phase === 'scan' && !reviewed ? 'select' : job.phase === 'import' ? 'apply' : 'review';
    mailaiBindUI($('[data-import-final-step]'), "textContent", () => (state === 'completed' ? mailaiText('导入完成') : mailaiText('导入邮件')));
    dialog.querySelectorAll('[data-step]').forEach(n => { n.classList.toggle('active', n.dataset.step === step); if (n.dataset.step === step) n.setAttribute('aria-current','step'); else n.removeAttribute('aria-current'); });
    $('#mail-import-account').disabled = Boolean(job) || busy();
    $('#mail-import-label').disabled = Boolean(job) || busy();
    $('[data-import-files]').disabled = busy(); $('[data-import-folder]').disabled = busy();
    dialog.querySelectorAll('[data-import-job]').forEach(n => n.disabled = busy());
    $('[data-import-select]').hidden = Boolean(job) && (!canResumeUpload() || working);
    $('[data-import-progress]').hidden = !job;
    mailaiBindUI($('[data-import-status]'), "textContent", () => (uploading ? mailaiTemplate`正在添加文件：${job?.processed || 0} / ${files.length}` : state === 'paused' ? mailaiTemplate`${job.phase === 'import' ? mailaiText('导入') : mailaiText('扫描')}已暂停。点击「继续」恢复。` : mailaiSystemMessage(job?.error) || (job?.state === 'collecting' && job.expected_files && job.files !== job.expected_files ? mailaiTemplate`已保留 ${job.files - (job.skipped_files || 0)} / ${job.expected_files} 个文件。${files.length ? mailaiText('点击「继续添加」接着传输。') : mailaiText('请选择原批次文件继续，已添加的文件会校验复用。')}` : mailaiSystemMessage(job?.message)) || mailaiText('文件已添加，点击继续扫描')));
    setPending(working);
    const progress = $('progress');
    const total = job?.phase === 'upload' ? job.expected_files : job?.total || 0;
    progress.max = Math.max(total, 1);
    if (total) progress.value = job?.phase === 'upload' ? (uploading ? uploadCursor : job.files) : job?.processed || 0; else progress.removeAttribute('value');
    mailaiBindUI($('[data-import-progress-note]'), "textContent", () => (uploading ? mailaiText('正在复制到本机工作目录。中断可继续；关闭软件后可重选原批次文件恢复。') : state === 'importing' ? mailaiText('可暂停或关闭窗口。关闭后会在后台继续导入。') : state === 'scanning' ? mailaiText('扫描只核对邮件，尚未导入。关闭窗口后会继续扫描。') : ['paused','failed'].includes(state) ? (job.phase === 'import' ? mailaiText('已成功导入的邮件会保留，继续时会自动跳过。') : mailaiText('继续后会重新扫描整批文件，扫描不会修改已有邮件。')) : ''));
    const current = $('[data-import-current]');
    current.hidden = !job?.current_source || job?.phase === 'upload';
    mailaiBindUI(current, "textContent", () => (job?.current_source ? mailaiTemplate`当前文件：${job.current_source}${job.phase === 'scan' && job.source_total ? mailaiTemplate` · 已扫描 ${Number(job.source_processed || 0).toLocaleString(currentI18nLanguage())} / ${Number(job.source_total).toLocaleString(currentI18nLanguage())} 封` : ''}` : ''));
    const live = $('[data-import-live]');
    live.hidden = !job || job.phase === 'upload' || reviewed;
    mailaiBindUI(live, "textContent", () => (job ? mailaiTemplate`已识别 ${Number(job.found || 0).toLocaleString(currentI18nLanguage())} 封 · 待新增 ${Number(job.new || 0).toLocaleString(currentI18nLanguage())} 封 · 重复 ${Number(job.duplicates || 0).toLocaleString(currentI18nLanguage())} 封 · 无法导入 ${Number(job.failed || 0).toLocaleString(currentI18nLanguage())} 项` : ''));
    $('[data-import-result]').hidden = !reviewed;
    if (reviewed) {
      for (const n of dialog.querySelectorAll('[data-count]')) n.textContent = Number(job[n.dataset.count] || 0).toLocaleString(currentI18nLanguage());
      const imported = Number(job.imported || 0);
      $('[data-count="new"]').textContent = state === 'completed' || job.phase === 'import' ? imported.toLocaleString(currentI18nLanguage()) : Number(job.new || 0).toLocaleString(currentI18nLanguage());
      mailaiBindUI($('[data-count="new"]').previousElementSibling, "textContent", () => (job.phase === 'import' ? mailaiText('已新增') : mailaiText('待新增')));
      mailaiBindUI($('[data-import-summary]'), "textContent", () => (state === 'completed' ? mailaiTemplate`已新增 ${imported} 封，跳过重复 ${job.duplicates} 封${job.failed ? mailaiTemplate`，${job.failed} 项未能导入` : ''}。在「本地归档」中查看。` : !job.new ? (job.skipped_files ? mailaiTemplate`没有可新增的邮件，已单独跳过 ${job.skipped_files} 个文件。请查看下方原因和处理建议，修复后另行补导。` : job.failed ? mailaiTemplate`没有可新增的邮件，${job.failed} 项无法识别。请查看下方原因，重新导出后再选择。` : job.errors?.length ? mailaiText('没有可确认新增的邮件。部分已有邮件原文不完整，请展开文件说明，重新同步后再导入。') : mailaiText('没有需要新增的邮件。已有邮件会保留，无需再次导入。')) : mailaiTemplate`预计新增 ${job.new} 封邮件；重复项会自动跳过，原有邮件不会被覆盖。`));
      const sampleKey = JSON.stringify(job.samples || []);
      if (renderedSamples !== sampleKey) {
        const wasOpen = $('[data-import-samples] details')?.open;
        $('[data-import-samples]').innerHTML = (job.samples || []).length ? `<details><summary><span data-i18n="ui.4763e4c7a5ee">预览前 ${(job.samples || []).length} 封待新增邮件</span></summary><div class="mail-import-samples">${job.samples.map(row=>`<article><b>${esc(row.subject)}</b><small>${esc(row.from_addr)} · ${esc(row.date || mailaiText('日期未记录'))}${row.folder ? ` · ${esc(row.folder)}` : ''}</small></article>`).join('')}</div></details>` : '';
        if (wasOpen && $('[data-import-samples] details')) $('[data-import-samples] details').open = true;
        renderedSamples = sampleKey;
      }
      const folders = job.folders || [];
      const folderKey = JSON.stringify([job.label, folders]);
      $('[data-import-folders]').hidden = !folders.length;
      if (renderedFolders !== folderKey) {
        $('[data-import-folders] ul').innerHTML = folders.map(row=>`<li><span>${esc(job.label)}${row.name ? ' / ' + esc(row.name) : mailaiText(' / 未分文件夹')}</span><b><span data-i18n="ui.13d9598b4990">${Number(row.count).toLocaleString(currentI18nLanguage())} 封</span></b></li>`).join('');
        mailaiBindUI($('[data-import-folders] small'), "textContent", () => (job.folder_count > folders.length ? mailaiTemplate`共 ${job.folder_count} 个文件夹，这里显示前 ${folders.length} 个。` : ''));
        renderedFolders = folderKey;
      }
    }
    const issues = job?.errors || [];
    $('[data-import-errors]').hidden = !issues.length;
    const issueKey = JSON.stringify(issues);
    if (renderedIssues !== issueKey) {
      $('[data-import-errors] > div').innerHTML = issues.map(row=>`<p><b>${esc(row.file)}</b><br>${esc(mailaiSystemMessage(row.reason))}${row.advice ? `<br><small>${esc(mailaiText('处理建议：'))}${esc(mailaiText(row.advice))}</small>` : ''}</p>`).join('');
      renderedIssues = issueKey;
    }
    const issueCount = job?.issue_count ?? issues.length;
    mailaiBindUI($('[data-import-issues-note]'), "textContent", () => (issueCount > issues.length ? mailaiTemplate`共有 ${issueCount} 项需要检查，这里显示前 ${issues.length} 项。下载清单可查看全部文件和处理建议。` : mailaiText('每项都附有原因和处理建议。可下载清单，逐项重新导出或重试。')));
    $('[data-import-report]').disabled = working || !issueCount;
    $('[data-import-reset]').hidden = !job;
    $('[data-import-reset]').disabled = working;
    const pause = $('[data-import-pause]'); pause.hidden = !uploading && !['scanning','importing'].includes(state);
    pause.disabled = !uploading && (inFlight || Boolean(job?.cancel)); mailaiBindUI(pause, "textContent", () => (uploading ? mailaiText('停止添加') : job?.cancel ? mailaiText('正在暂停…') : mailaiText('暂停')));
    const skip = $('[data-import-skip]');
    skip.hidden = !failedUpload || !canResumeUpload();
    skip.disabled = working;
    $('[data-import-failed-file]').hidden = !failedUpload;
    mailaiBindUI($('[data-import-failed-file]'), 'textContent', () => failedUpload ? mailaiTemplate`失败文件：${failedUpload.name}。可以重试，或单独跳过后先添加其他文件。` : '');
    $('[data-import-retry-help]').hidden = !failedUpload;
    mailaiBindUI($('[data-import-retry-help]'), 'textContent', () => failedUpload ? uploadAdvice(failedUpload.reason) : '');
    $('[data-import-skipped]').hidden = !job?.skipped_files;
    mailaiBindUI($('[data-import-skipped]'), 'textContent', () => job?.skipped_files ? mailaiTemplate`已单独跳过 ${job.skipped_files} 个文件，扫描后的问题清单会保留记录，方便之后补导。` : '');
    const action = $('[data-import-action]');
    mailaiBindUI(action, "textContent", () => (inFlight && !uploading ? mailaiText('请稍候…') : state === 'completed' ? mailaiText('查看导入邮件') : ['paused','failed'].includes(state) ? mailaiText('继续') : state === 'ready' ? mailaiTemplate`导入缺少的 ${job.new} 封邮件` : canResumeUpload() && job.files < job.expected_files ? mailaiText('继续添加') : mailaiText('扫描并去重')));
    action.disabled = working || (state === 'collecting' && job.files !== job.expected_files && files.length !== job.expected_files) || (!job ? !files.length || !accountId || Boolean(labelError()) : state === 'ready' ? !job.new : !['completed','paused','failed','collecting'].includes(state));
  }
  function selected() {
    const ignored = files.filter(n => !/\.(eml|mbox)$/i.test(n.name)).length;
    files = files.filter(n => /\.(eml|mbox)$/i.test(n.name));
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    const error = canResumeUpload() && files.length !== job.expected_files ? mailaiTemplate`请选回原批次的 ${job.expected_files} 个邮件文件，已添加的文件会校验复用。` : files.length > 20000 ? mailaiText('一批最多选择 20000 个文件，请分批选择。') : '';
    mailaiBindUI($('[data-import-error]'), "textContent", () => (error || (files.length ? labelError() : '') || (!files.length ? mailaiText('未找到邮件文件，请先从 Foxmail 导出为 EML 或 MBOX。') : '')));
    $('[data-import-selected]').innerHTML = files.length ? `<p><b><span data-i18n="ui.e49d139a999a">已选择 ${files.length} 个邮件文件</span></b> · ${formatFileSize(bytes)}${ignored ? mailaiTemplate` · 跳过 ${ignored} 个非邮件文件` : ''}</p><ul>${files.slice(0,5).map(file=>`<li>${esc(file.webkitRelativePath || file.name)}</li>`).join('')}</ul>` : '';
    if (error) files = [];
    if (files.length) $('.mail-import-help').open = false;
    paint();
  }
  async function listHistory(version = generation) {
    try {
      const rows = (await request('')).filter(row=>row.files);
      if (version !== generation || !dialog.open) return;
      $('[data-import-history]').innerHTML = rows.length ? `<details><summary><span data-i18n="ui.707aadea85c0">最近导入记录 · ${rows.length}</span></summary>${rows.map(row=>`<button type="button" data-import-job="${esc(row.token)}"><span>${esc(row.label)}<small><span data-i18n="ui.3d402f1680c6">${new Date(row.created_at * 1000).toLocaleString(currentI18nLanguage())} · ${row.files} 个文件</span></small></span><b>${esc({get collecting() { return mailaiText('待扫描'); },get scanning() { return mailaiText('扫描中'); },get ready() { return mailaiText('待确认'); },get importing() { return mailaiText('导入中'); },completed:mailaiTemplate`新增 ${row.imported} 封`,get paused() { return mailaiText('已暂停'); },get failed() { return mailaiText('待重试'); }}[row.state] || mailaiText('待重新选择'))}</b></button>`).join('')}</details>` : '';
    } catch (error) { if (version === generation) $('[data-import-error]').textContent = mailaiSystemMessage(error.message); }
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
      } catch (error) { if (version === generation) mailaiBindUI($('[data-import-error]'), "textContent", () => (mailaiTemplate`${mailaiSystemMessage(error.message)}。恢复连接后会继续读取进度。`)); }
      if (version === generation) poll();
    }, 800);
  }
  async function open(id = '') {
    if (dialog.open) return;
    generation++; clearTimeout(timer); job = null; files = []; uploadCursor = 0; failedUpload = null; uploading = false; inFlight = false;
    renderedSamples = renderedIssues = renderedFolders = '';
    $('[data-import-errors]').open = false; $('[data-import-folders]').open = false;
    accountId = id || activeMailAccount()?.id || '';
    returnFocus = document.activeElement;
    const accounts = _systemConfig?.accounts || [];
    $('#mail-import-account').innerHTML = accounts.map(row=>`<option value="${esc(row.id)}">${esc(row.user)} · ${esc(row.host || '')}</option>`).join('');
    $('#mail-import-account').value = accountId;
    accountId = $('#mail-import-account').value;
    $('#mail-import-label').value = mailaiText('Foxmail 导入');
    $('#mail-import-files').value = ''; $('#mail-import-folder').value = '';
    $('[data-import-selected]').replaceChildren(); $('[data-import-history]').replaceChildren();
    mailaiBindUI($('[data-import-error]'), "textContent", () => (accountId ? '' : mailaiText('请先在「设置 → 邮箱账号」添加邮箱，再导入旧邮件。')));
    paint(); dialog.showModal(); $('#mail-import-account').focus(); listHistory();
  }
  async function close() {
    if (inFlight && !uploading) { mailaiBindUI($('[data-import-error]'), "textContent", () => (mailaiText('正在提交操作，请稍候再关闭窗口。'))); return; }
    if (uploading) { mailaiBindUI($('[data-import-error]'), "textContent", () => (mailaiText('正在添加文件。请先点击「停止添加」，再关闭窗口。'))); return; }
    clearTimeout(timer); generation++; setPending(false); dialog.close();
    returnFocus?.focus({preventScroll:true});
  }
  dialog.querySelectorAll('[data-import-close]').forEach(n=>n.onclick=close);
  dialog.addEventListener('cancel', event=>{event.preventDefault();close();});
  $('#mail-import-account').onchange = () => { accountId = $('#mail-import-account').value; generation++; paint(); listHistory(); };
  $('#mail-import-label').oninput = () => { $('[data-import-error]').textContent = labelError(); paint(); };
  $('[data-import-files]').onclick = () => $('#mail-import-files').click();
  $('[data-import-folder]').onclick = () => $('#mail-import-folder').click();
  for (const selector of ['#mail-import-files','#mail-import-folder']) $(selector).onchange=event=>{if (busy() || (job && !canResumeUpload())) return; files=Array.from(event.target.files || []); uploadCursor = 0; failedUpload = null; selected();};
  $('[data-import-history]').onclick = async event => {
    const n = event.target.closest('[data-import-job]'); if (!n || busy()) return;
    const version = ++generation; inFlight = true; paint();
    try { const result = await request('/' + n.dataset.importJob); if (version !== generation) return;
      job = result; files = []; uploadCursor = 0; failedUpload = null; renderedSamples = renderedIssues = renderedFolders = ''; $('#mail-import-label').value = job.label;
    } catch (error) { $('[data-import-error]').textContent = mailaiSystemMessage(error.message); }
    finally { inFlight = false; paint(); poll(); }
  };
  $('[data-import-reset]').onclick = async () => {
    if (busy()) return;
    inFlight = true; paint();
    try { if (job && job.state !== 'completed') await request('/' + job.token, {method:'DELETE'});
      job = null; files = []; uploadCursor = 0; failedUpload = null; generation++; clearTimeout(timer); setPending(false);
      $('#mail-import-files').value = ''; $('#mail-import-folder').value = '';
      $('[data-import-errors]').open = false; $('[data-import-folders]').open = false;
      $('[data-import-selected]').replaceChildren(); $('[data-import-error]').textContent = ''; paint(); listHistory();
    } catch (error) { $('[data-import-error]').textContent = mailaiSystemMessage(error.message); }
    finally { inFlight = false; paint(); poll(); }
  };
  $('[data-import-pause]').onclick = async () => {
    if (uploading) { controller?.abort(); return; }
    if (inFlight || !job) return;
    inFlight = true; paint();
    try { job = await post('/' + job.token + '/pause'); }
    catch (error) { $('[data-import-error]').textContent = mailaiSystemMessage(error.message); }
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
        const result = await response.json(); throw new Error(result.detail || mailaiText('无法下载清单，请稍后重试'));
      }
      url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = mailaiText('MailAI-导入问题清单.csv');
      document.body.append(link); link.click(); link.remove();
    } catch (error) { if (version === generation) $('[data-import-error]').textContent = mailaiSystemMessage(error.message); }
    finally {
      if (url) setTimeout(()=>URL.revokeObjectURL(url), 1000);
      if (version === generation) { inFlight = false; paint(); poll(); }
    }
  };
  $('[data-import-skip]').onclick = async () => {
    if (busy() || !failedUpload || !canResumeUpload()) return;
    const failed = failedUpload, version = generation;
    let resume = false;
    inFlight = true; paint();
    try {
      job = await request('/' + job.token + '/skip-file', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({index:failed.index, name:failed.name, reason:failed.reason.slice(0,500)})});
      if (version !== generation) return;
      uploadCursor = failed.index + 1; failedUpload = null;
      $('[data-import-error]').textContent = '';
      resume = true;
    } catch (error) {
      if (version === generation) $('[data-import-error]').textContent = transferError(error);
    } finally {
      if (version === generation) { inFlight = false; paint(); }
    }
    if (resume && version === generation) $('[data-import-action]').click();
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
        uploadCursor = 0; failedUpload = null;
      }
      if (canResumeUpload() && files.length && uploadCursor < files.length) {
        uploading = true; controller = new AbortController(); paint();
        for (let i=uploadCursor; i<files.length; i++) {
          const file = files[i];
          // Stable ordinals make retries safe even if the server saved a file
          // but its response never reached this browser.
          for (let attempt=0; ; attempt++) {
            try {
              job = await request('/' + job.token + '/files?index=' + i + '&name=' + encodeURIComponent(fileName(file)), {method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file,signal:controller.signal});
              break;
            } catch (error) {
              if (controller.signal.aborted || attempt >= 2 || !(error instanceof TypeError)) {
                if (!controller.signal.aborted) failedUpload = {index:i, name:fileName(file), reason:error instanceof TypeError ? mailaiCopySource(mailaiText('文件传输中断，已添加的文件已保留，请继续添加')) : String(error.message)};
                throw error;
              }
              await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
              if (controller.signal.aborted) throw new DOMException('Stopped', 'AbortError');
            }
          }
          failedUpload = null; uploadCursor = i + 1;
          job.processed = uploadCursor;
          if (i % 10 === 0 || uploadCursor === files.length) paint();
        }
        uploading = false; controller = null;
      }
      job = await post('/' + job.token + (job.state === 'ready' || job.phase === 'import' ? '/apply' : '/scan'));
      if (version === generation) { paint(); poll(); }
    } catch (error) {
      uploading = false; controller = null; setPending(false);
      if (version === generation) {
        if (job) { try { job = await request('/' + job.token); } catch (_) {} }
        mailaiBindUI($('[data-import-error]'), "textContent", () => (error.name === 'AbortError' ? mailaiText('已停止添加，已添加的文件已保留。点击「继续添加」即可接着传输。') : transferError(error)));
        paint();
      }
    } finally { if (version === generation) { inFlight = false; paint(); poll(); } }
  };
  document.getElementById('btn-import-client-mail').onclick = () => open();
  document.getElementById('btn-account-import-mail').onclick = () => open(selectedManagedAccountId || activeMailAccount()?.id);
  window.mailaiMailImport = {open};
})();
