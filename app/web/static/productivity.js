/* Local productivity: explicit account ownership, stale-response guards, recoverable edits. */
(() => {
  const labels = {
    unhandled: "未处理",
    reply: "待回复",
    waiting: "等待对方",
    later: "稍后处理",
    done: "已处理",
  };
  let prefs = {};
  try {
    prefs = JSON.parse(
      localStorage.getItem("mailai.productivity.preferences.v1") || "{}",
    );
  } catch (_) {}
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
  const savePreference = (key, value) => {
    const previous = prefs[key];
    prefs[key] = value;
    try {
      localStorage.setItem(
        "mailai.productivity.preferences.v1",
        JSON.stringify(prefs),
      );
      return true;
    } catch (error) {
      prefs[key] = previous;
      toast("显示偏好未保存，请稍后重试", "warn");
      return false;
    }
  };
  const state = {
    view: "all",
    conversations: false,
    compact: false,
    workflow: new Map(),
    revision: 0,
    account: "",
    senders: new Map(),
    loadedAccounts: new Set(),
  };
  const owner = () => activeMailAccount()?.id || "";
  const json = (data) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const button = (text, action, extra = "") =>
    `<button type="button" data-productivity-action="${action}" ${extra}>${text}</button>`;
  let dialog,
    modalRevision = 0,
    dialogAccount = "",
    returnFocus;
  const msg = (text, error = false) => {
    const node = dialog?.querySelector("[data-message]");
    if (node) {
      node.textContent = text;
      node.className = error ? "productivity-error" : "productivity-hint";
    }
  };
  const busy = async (node, fn) => {
    if (node?.disabled) return;
    const rev = modalRevision;
    node && (node.disabled = true);
    node?.setAttribute("aria-busy", "true");
    node?.classList.add("motion-working");
    try {
      return await fn();
    } catch (error) {
      if (live(rev)) msg(error.message, true);
      toast(error.message, "error");
    } finally {
      if (node?.isConnected) {
        node.disabled = false;
        node.removeAttribute("aria-busy");
        node.classList.remove("motion-working");
      }
    }
  };
  // Bind loading feedback to the original nodes, so closing or replacing a
  // dialog cannot let an old request clear the next screen's state.
  async function panelRequest(rev, label, path, options) {
    const status = dialog.querySelector("[data-message]");
    const controls = [...dialog.querySelectorAll(".productivity-body button")]
      .map(node => [node, node.disabled]);
    controls.forEach(([node]) => { node.disabled = true; });
    status.textContent = label;
    const finish = window.mailaiMotion.pending(status);
    try { return await api(path, options); }
    finally {
      finish();
      controls.forEach(([node, disabled]) => { if (node.isConnected) node.disabled = disabled; });
      if (live(rev)) status.textContent = "";
    }
  }
  function open(title, body, account = owner()) {
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "productivity-dialog";
      dialog.className = "productivity-dialog";
      dialog.setAttribute("aria-labelledby", "productivity-title");
      document.body.append(dialog);
      dialog.addEventListener("close", () => {
        document
          .querySelector(".search-filter-button")
          ?.setAttribute("aria-expanded", "false");
        ++modalRevision;
        returnFocus?.isConnected && returnFocus.focus();
      });
      dialog.addEventListener("click", (event) => {
        if (
          event.target === dialog &&
          event.offsetX >= 0 &&
          event.offsetY >= 0
        ) {
          const rect = dialog.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            dialog.close();
        }
      });
    }
    ++modalRevision;
    document
      .querySelector(".search-filter-button")
      ?.setAttribute("aria-expanded", String(title === "高级搜索"));
    dialogAccount = account;
    if (!dialog.open) returnFocus = document.activeElement;
    dialog.classList.remove("productivity-search-results-ready");
    dialog.dataset.panel = "";
    dialog.innerHTML = `<header><h2 id="productivity-title">${esc(title)}</h2><button type="button" data-close-productivity aria-label="关闭${esc(title)}">✕</button></header><div class="productivity-body"><p class="productivity-hint" data-account-label></p>${body}<p data-message role="status" aria-live="polite"></p></div>`;
    const accountRow = _systemConfig?.accounts?.find((a) => a.id === account);
    dialog.querySelector("[data-account-label]").textContent =
      `${accountRow?.user || "当前邮箱"} · 数据保存在本机`;
    dialog.querySelector("[data-close-productivity]").onclick = () =>
      dialog.close();
    if (!dialog.open) dialog.showModal();
    (
      dialog.querySelector(
        "input:not([type=checkbox]):not([type=hidden]),textarea",
      ) || dialog.querySelector("[data-close-productivity]")
    ).focus();
    return modalRevision;
  }
  const live = (rev) => dialog?.open && modalRevision === rev;
  function refresh() {
    emailListRenderSignature = "";
    applyFilters({ silent: true });
  }
  function updateWorkflowRows() {
    for (const e of allEmails) {
      const extra = state.workflow.get(`${e._account_id || owner()}:${e.id}`);
      if (extra) Object.assign(e, extra);
      else if (state.loadedAccounts.has(e._account_id || owner()))
        Object.assign(e, {
          handle_state: "unhandled",
          snoozed_until: "",
          followup_at: "",
          focus_override: "",
        });
    }
  }
  async function loadWorkflow() {
    const account = owner(),
      revision = ++state.revision;
    const accounts = unifiedMailbox
      ? (_systemConfig?.accounts || []).map((a) => a.id)
      : [account];
    const results = await Promise.allSettled(
      accounts.map((id) =>
        api("/api/productivity/workflow", { accountId: id }),
      ),
    );
    if (account !== owner() || revision !== state.revision) return;
    const snapshot =
      account +
      String(unifiedMailbox) +
      JSON.stringify(
        results.map((result) =>
          result.status === "fulfilled" ? result.value : null,
        ),
      );
    if (state.workflowSnapshot === snapshot) return;
    state.workflowSnapshot = snapshot;
    state.account = account;
    state.workflow.clear();
    state.senders.clear();
    state.loadedAccounts.clear();
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        state.loadedAccounts.add(accounts[i]);
        for (const row of result.value.items)
          state.workflow.set(`${accounts[i]}:${row.id}`, row);
        for (const sender of result.value.senders || [])
          state.senders.set(`${accounts[i]}:${sender.address}`, sender.choice);
      } else console.warn("处理状态未更新", result.reason.message);
    });
    updateWorkflowRows();
    refresh();
    if (selectedEmailDetail) {
      const row = allEmails.find(
        (item) =>
          item.id === selectedEmailDetail.id &&
          (!item._account_id || item._account_id === owner()),
      );
      if (row)
        for (const key of [
          "handle_state",
          "snoozed_until",
          "followup_at",
          "focus_override",
        ])
          selectedEmailDetail[key] = row[key];
      decorateReading();
    }
  }
  window.mailaiProductivityFilter = (rows) => {
    if (state.navigation !== mailboxNavigationRevision) {
      state.navigation = mailboxNavigationRevision;
      state.view = "all";
      const select = document.getElementById('productivity-workflow-filter');
      if (select) select.value = 'all';
    }
    if (specialMailbox) return rows;
    let result = rows;
    if (state.view === "focus")
      result = result.filter(
        (e) =>
          e.focus_override === "focus" ||
          (!e.focus_override &&
            (state.senders.get(
              `${e._account_id || owner()}:${(e.from_addr || "").toLowerCase()}`,
            ) === "focus" ||
              (e.priority === "高" &&
                state.senders.get(
                  `${e._account_id || owner()}:${(e.from_addr || "").toLowerCase()}`,
                ) !== "other"))),
      );
    else if (state.view !== "all")
      result = result.filter(
        (e) => (e.handle_state || "unhandled") === state.view,
      );
    return result;
  };
  window.mailaiProductivityList = (rows) => {
    if (specialMailbox || !state.conversations) return rows;
    const result = rows;
    const groups = new Map();
    for (const row of result) {
      const key = `${row._account_id || owner()}:${row.thread_id || row.message_id || "single-" + row.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups.values()].map((group) => ({
      ...group[0],
      _conversationCount: group.length,
    }));
  };
  window.mailaiProductivityTitle = (title) =>
    state.view === "all" || specialMailbox
      ? title
      : title +
        " · " +
        (state.view === "focus" ? "重点邮件" : labels[state.view]);
  window.mailaiProductivityTags = (e) =>
    `${e.handle_state && e.handle_state !== "unhandled" ? `<span class="tag productivity-workflow-tag">${esc(labels[e.handle_state])}${e.snoozed_until ? " · " + esc(new Date(e.snoozed_until).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })) : ""}</span>` : ""}${e._conversationCount > 1 ? `<span class="tag">${e._conversationCount} 封往来</span>` : ""}`;
  function initControls() {
    // Each tool lives in its own panel; the mailbox list has one filter trigger.
    const entry = (host, label, action) => {
      if (!host) return;
      const node = document.createElement("button");
      node.type = "button";
      node.className = "productivity-panel-entry";
      node.textContent = label;
      node.onclick = action;
      host.append(node);
    };
    entry(document.querySelector(".contact-center-tools"), "导入 / 导出", () => contacts(contactAccountId()));
    entry(document.querySelector(".attachment-center-tools"), "查找文件内容", () => attachments(attachmentCenterAccountId));
    entry(document.querySelector(".attachment-center-tools"), "已分享文件", () => shares(attachmentCenterAccountId));
    entry(document.querySelector(".task-account-picker"), "发信跟进", () => followups(taskCenterScope()));
    entry(document.querySelector(".todo-center-tools"), "日历文件", () => calendar(todoCenterAccountId));
    const filter = document.getElementById("btn-filter-panel");
    document.querySelector(".list-sort").prepend(filter);
    const task = document.getElementById("btn-task-center");
    task.className = "nav-action productivity-outbox-entry";
    task.removeAttribute("data-i18n");
    task.innerHTML = '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v5h16v-5M12 14V4m-4 4 4-4 4 4"/></svg><span>发件箱</span><i data-task-count hidden></i>';
    task.setAttribute("aria-label", "任务与发件箱");
    task.title = "任务与发件箱";
    document.querySelector(".nav-system-cluster").prepend(task);
    const workflow = document.createElement('label');
    workflow.className = 'filter-select-row';
    workflow.innerHTML = '<span><b>邮件范围</b><small>按重要程度或处理标记筛选</small></span><select id="productivity-workflow-filter"><option value="all">全部邮件</option><option value="focus">重点邮件</option><option value="reply">待回复</option><option value="waiting">等待对方</option><option value="later">稍后处理</option><option value="done">已处理</option></select>';
    document.querySelector('.filter-form').prepend(workflow);
    const select = workflow.querySelector('select');
    select.onchange = () => { state.navigation = mailboxNavigationRevision; state.view = select.value; clearMailSelection(); refresh(); window.mailaiWorkflowChanged?.(); };
    window.mailaiWorkflowFilterLabel = () => !specialMailbox && state.view !== 'all' ? state.view === 'focus' ? '重点邮件' : labels[state.view] : '';
    window.mailaiClearWorkflowFilter = () => { state.view = 'all'; select.value = 'all'; };
    document.getElementById('btn-reset-filter').addEventListener('click', window.mailaiClearWorkflowFilter);
    const searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.className = "search-filter-button";
    searchBtn.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h6m4 0h4M3 10h2m4 0h8M3 15h8m4 0h2"/><circle cx="11" cy="5" r="2"/><circle cx="7" cy="10" r="2"/><circle cx="13" cy="15" r="2"/></svg>';
    searchBtn.title = "高级搜索";
    searchBtn.setAttribute("aria-haspopup", "dialog");
    searchBtn.setAttribute("aria-controls", "productivity-dialog");
    searchBtn.setAttribute("aria-expanded", "false");
    searchBtn.setAttribute("aria-label", "高级搜索与保存搜索");
    searchBtn.onclick = () => openSearch();
    document.querySelector(".global-search").append(searchBtn);
    for (const nav of ["risk-nav", "category-nav"]) {
      const section = document.getElementById(nav)?.closest(".nav-group");
      const title = section?.querySelector(".nav-title");
      if (!title) continue;
      const toggle = document.createElement("button");
      toggle.className = "productivity-nav-toggle";
      toggle.type = "button";
      toggle.innerHTML = title.innerHTML + '<span aria-hidden="true">⌃</span>';
      toggle.setAttribute("aria-expanded", "true");
      title.replaceChildren(toggle);
      toggle
        .querySelectorAll(".facet-scope-label")
        .forEach((node) => node.removeAttribute("data-i18n"));
      const initiallyOpen = prefs[nav] !== false;
      document.getElementById(nav).hidden = !initiallyOpen;
      toggle.setAttribute("aria-expanded", String(initiallyOpen));
      toggle.lastElementChild.textContent = initiallyOpen ? "⌃" : "⌄";
      toggle.onclick = () => {
        const content = document.getElementById(nav);
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        if (!savePreference(nav, !expanded)) return;
        content.hidden = expanded;
        toggle.setAttribute("aria-expanded", String(!expanded));
        toggle.lastElementChild.textContent = expanded ? "⌄" : "⌃";
      };
    }
    // Reuse the existing filter controls; place them beside their list trigger.
    const filters = document.querySelector(".mail-filter-group");
    if (filters) {
      filters.classList.add("productivity-filters");
      const heading = filters.querySelector(".filter-heading");
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "收起";
      close.onclick = () => document.getElementById("btn-filter-panel").click();
      heading.append(close);
    }
  }
  function getCriteria() {
    const result = {};
    dialog
      .querySelectorAll("[data-criterion]")
      .forEach(
        (n) =>
          (result[n.dataset.criterion] =
            n.type === "checkbox" ? n.checked : n.value),
      );
    return result;
  }
  function openSearch(seed = {}, allAccounts = false) {
    const rev = open(
      "高级搜索",
      `<form id="productivity-search-form"><div class="productivity-grid"><label class="wide">关键词或搜索条件<input data-criterion="query" placeholder="例如 from:person@example.com filename:pdf"></label><label>发件人<input data-criterion="sender"></label><label>收件人 / 抄送<input data-criterion="recipient"></label><label>主题<input data-criterion="subject"></label><label>附件名称或类型<input data-criterion="filename" placeholder="例如 合同.pdf 或 .xlsx"></label><label>开始日期<input type="date" data-criterion="after"></label><label>结束日期<input type="date" data-criterion="before"></label><label>邮件范围<select data-criterion="mailbox"><option value="all">全部正常邮件（含发件、草稿）</option><option value="inbox">收件箱</option><option value="sent">已发送</option><option value="drafts">草稿</option><option value="trash">已删除</option><option value="quarantine">隔离区</option><option value="spam">垃圾邮件</option></select></label><label>AI 分类<input data-criterion="category" placeholder="例如 订阅推送、项目工作"></label><label>处理状态<select data-criterion="state"><option value="">不限</option>${Object.entries(
        labels,
      )
        .map(([k, v]) => `<option value="${k}">${v}</option>`)
        .join(
          "",
        )}<option value="due">等待反馈已到期</option><option value="focus">重点邮件</option></select></label><label><span><input type="checkbox" data-criterion="has_attachment"> 有附件</span></label><label><span><input type="checkbox" data-criterion="unread"> 仅未读</span></label></div><label><input type="checkbox" id="productivity-all-accounts"> 搜索所有可见账号</label><div class="productivity-actions"><button type="submit" class="primary-action">搜索</button>${button("保存本次条件", "save-search")}<select id="productivity-saved-search" aria-label="使用已保存的搜索"><option value="">已保存的搜索…</option></select></div></form><p class="productivity-hint">所有条件同时满足；仅搜索本地已同步数据。搜索结果不会调用 AI。附件内容请到“附件中心 → 文字与版本”搜索。</p><div class="productivity-actions"><button type="button" data-search-expand hidden>展开搜索条件</button></div><div id="productivity-search-results" aria-live="polite"></div>`,
    );
    dialog.querySelectorAll("[data-criterion]").forEach((n) => {
      const v = seed[n.dataset.criterion];
      if (n.type === "checkbox") n.checked = Boolean(v);
      else if (v !== undefined) n.value = v;
    });
    dialog.querySelector("#productivity-all-accounts").checked = allAccounts;
    let criteria = {},
      offset = 0,
      all = false;
    const account = dialogAccount;
    const run = async (append = false) => {
      const submit = dialog.querySelector("[type=submit]");
      return busy(submit, async () => {
        if (!append) {
          criteria = getCriteria();
          offset = 0;
          all = dialog.querySelector("#productivity-all-accounts").checked;
        }
        msg("正在搜索…");
        const result = await api("/api/productivity/search", {
          accountId: account,
          ...json({ criteria, offset, limit: 50, all_accounts: all }),
        });
        if (!live(rev)) return;
        dialog.classList.add("productivity-search-results-ready");
        const expand = dialog.querySelector("[data-search-expand]");
        expand.hidden = false;
        expand.onclick = () => {
          const collapsed = dialog.classList.toggle(
            "productivity-search-results-ready",
          );
          expand.textContent = collapsed ? "展开搜索条件" : "收起搜索条件";
        };
        const host = dialog.querySelector("#productivity-search-results");
        host.querySelector("[data-more-search]")?.remove();
        if (!append) host.replaceChildren();
        for (const row of result.items) {
          const node = document.createElement("button");
          node.type = "button";
          node.className = "productivity-result";
          node.innerHTML = `<strong>${esc(row.subject || "无主题")}</strong><small>${esc(row.account_user || "")} ${esc({ email: "邮件", sent: "已发送", draft: "草稿" }[row.kind])} · ${esc(row.from_addr || row.to_addr || "")} · ${esc(row.date ? new Date(row.date).toLocaleString() : "")}</small><small>${esc(row.preview || "")}</small>`;
          node.onclick = () =>
            busy(node, async () => {
              await revealResult(row, account);
              if (live(rev)) dialog.close();
            });
          host.append(node);
        }
        window.mailaiMotion.reveal(host);
        offset += result.items.length;
        if (result.has_more) {
          const more = document.createElement("button");
          more.type = "button";
          more.dataset.moreSearch = "";
          more.textContent = "继续显示";
          more.onclick = () => run(true);
          host.append(more);
        }
        if (!offset)
          host.textContent = "没有匹配结果，可减少条件或扩大时间范围。";
        msg(
          result.scope +
            (result.failed_accounts?.length
              ? "；部分账号未读取，请切换对应账号检查"
              : "") +
            ` · 已显示 ${offset} 项`,
        );
      });
    };
    dialog.querySelector("form").onsubmit = (event) => {
      event.preventDefault();
      run();
    };
    const saved = dialog.querySelector("#productivity-saved-search");
    api("/api/productivity/searches", { accountId: account })
      .then((items) => {
        if (!live(rev)) return;
        for (const item of items) {
          const option = new Option(item.name, String(item.id));
          saved.add(option);
        }
        saved.onchange = () => {
          const item = items.find((x) => String(x.id) === saved.value);
          if (item) openSearch(item.criteria, all);
        };
      })
      .catch(
        (error) =>
          live(rev) && msg("已保存搜索暂时无法读取：" + error.message, true),
      );
    dialog.querySelector('[data-productivity-action="save-search"]').onclick = (
      event,
    ) =>
      busy(event.currentTarget, async () => {
        const name = await mailaiAsk({
          title: "保存搜索条件",
          label: "名称",
          value: "常用搜索",
        });
        if (!name || !live(rev)) return;
        const criteria = getCriteria();
        const result = await api("/api/productivity/searches", {
          accountId: account,
          ...json({ name, criteria }),
        });
        if (live(rev)) {
          msg("搜索条件已保存");
          saved.add(new Option(name, String(result.id)));
          saved.addEventListener("change", () => {
            if (saved.value === String(result.id)) openSearch(criteria, all);
          });
        }
      });
    if (Object.keys(seed).length) run();
  }
  async function revealResult(row, account) {
    const id = row.account_id || account;
    if (id !== owner())
      await openAccountMailbox(
        id,
        row.kind === "sent" ? "sent" : row.kind === "draft" ? "drafts" : "all",
      );
    if (row.kind === "draft") {
      const draft = await api(`/api/drafts/${row.id}`, { accountId: id });
      return openCompose({ ...draft, account_id: id });
    }
    if (row.kind === "sent") {
      const item = await api(`/api/mail/sent/${row.id}`, { accountId: id });
      await openAccountMailbox(id, "sent");
      return selectSpecialMessage(row.id, item);
    }
    if (row.status === "trash") await openAccountMailbox(id, "trash");
    else if (specialMailbox) await openAccountMailbox(id, "all");
    return revealEmailFromSource(row.id);
  }
  let snippetRange = null;
  function captureSnippetRange() {
    const selection = window.getSelection();
    snippetRange =
      selection?.rangeCount &&
      composeMessageElement().contains(
        selection.getRangeAt(0).commonAncestorContainer,
      )
        ? selection.getRangeAt(0).cloneRange()
        : null;
  }
  async function snippets() {
    const writing = document.body.classList.contains("compose-open"),
      account = writing ? composeAccountId : owner(),
      session = draftSession,
      range = snippetRange;
    const rev = open(
      "常用短语",
      `<div class="productivity-grid"><label>已有短语<select data-snippet-select><option value="">新建短语</option></select></label><label>名称<input data-snippet-name maxlength="80"></label><label class="wide">内容<textarea data-snippet-body rows="7" maxlength="5000"></textarea></label></div><div class="productivity-actions">${button("保存短语", "snippet-save", 'class="primary-action"')}${button("插入正文光标位置", "snippet-insert", writing ? "" : "disabled")}${button("删除短语", "snippet-delete")}</div><p class="productivity-hint">仅插入文字，保留正文其他部分、签名和引用。选中一段文字时替换该段；未指定光标时插入正文末尾。</p>`,
      account,
    );
    let items = [];
    try {
      items = await panelRequest(rev, "正在读取常用短语…", "/api/productivity/snippets", { accountId: account });
      if (!live(rev)) return;
      const select = dialog.querySelector("[data-snippet-select]"),
        name = dialog.querySelector("[data-snippet-name]"),
        body = dialog.querySelector("[data-snippet-body]");
      items.forEach((item) => select.add(new Option(item.name, item.id)));
      select.onchange = () => {
        const item = items.find((r) => String(r.id) === select.value);
        name.value = item?.name || "";
        body.value = item?.body || "";
      };
      dialog.querySelector(
        '[data-productivity-action="snippet-save"]',
      ).onclick = (e) =>
        busy(e.currentTarget, async () => {
          await api("/api/productivity/snippets", {
            accountId: account,
            ...json({
              id: select.value ? Number(select.value) : undefined,
              name: name.value,
              body: body.value,
            }),
          });
          if (live(rev)) snippets();
        });
      dialog.querySelector(
        '[data-productivity-action="snippet-insert"]',
      ).onclick = (e) =>
        busy(e.currentTarget, async () => {
          if (!body.value.trim()) throw Error("请先填写或选择短语");
          if (
            session !== draftSession ||
            account !== composeAccountId ||
            !document.body.classList.contains("compose-open")
          )
            throw Error("写信窗口或发件账号已变化，请重新打开短语");
          const text = body.value,
            target = composeMessageElement();
          let insertion = range;
          if (insertion && !target.contains(insertion.commonAncestorContainer))
            throw Error("正文位置已变化，请重新选择插入位置");
          if (!insertion) {
            insertion = document.createRange();
            insertion.selectNodeContents(target);
            insertion.collapse(false);
          }
          dialog.close();
          target.focus();
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(insertion);
          document.execCommand("insertText", false, text);
          rememberComposeSelection();
          clearComposePreflight();
          queueDraftSave();
        });
      dialog.querySelector(
        '[data-productivity-action="snippet-delete"]',
      ).onclick = (e) =>
        busy(e.currentTarget, async () => {
          if (!select.value) throw Error("请选择短语");
          if (
            !(await mailaiAsk({
              title: "删除这条短语？",
              message: "已插入邮件的文字会保留。",
              confirmText: "删除",
            }))
          )
            return;
          if (!live(rev)) return;
          await api("/api/productivity/snippets/" + select.value, {
            accountId: account,
            method: "DELETE",
          });
          if (live(rev)) snippets();
        });
    } catch (error) {
      live(rev) && msg(error.message, true);
    }
  }
  async function templates() {
    const account = document.body.classList.contains("compose-open")
      ? composeAccountId
      : owner();
    const rev = open(
      "邮件模板",
      `<div class="productivity-grid"><label>选择模板<select id="productivity-template"><option value="">新建模板</option></select></label><label>模板名称<input id="productivity-template-name" maxlength="80"></label><label class="wide">主题<input id="productivity-template-subject" maxlength="300"></label><label class="wide">正文<textarea id="productivity-template-body" rows="8"></textarea></label></div><div class="productivity-actions">${button("保存模板", "save-template", 'class="primary-action"')}${button("使用模板", "use-template")}${button("保存当前正文为模板", "current-template")}${button("删除模板", "delete-template")}</div><p class="productivity-hint">模板只包含主题和正文，不保存收件人、附件和签名；使用前可继续修改。</p>`,
      account,
    );
    let items = [];
    try {
      items = await panelRequest(rev, "正在读取邮件模板…", "/api/productivity/templates", { accountId: account });
      if (!live(rev)) return;
      const select = dialog.querySelector("#productivity-template");
      items.forEach((item) => select.add(new Option(item.name, item.id)));
      const fill = (item) => {
        for (const field of ["name", "subject", "body"])
          dialog.querySelector("#productivity-template-" + field).value =
            item?.[field] || "";
      };
      select.onchange = () =>
        fill(items.find((x) => String(x.id) === select.value));
      dialog.querySelector(
        '[data-productivity-action="current-template"]',
      ).onclick = () => {
        fill({
          name: "常用邮件",
          subject: document.getElementById("compose-subject").value,
          body: composeMessageText(),
        });
        select.value = "";
      };
      dialog.querySelector(
        '[data-productivity-action="save-template"]',
      ).onclick = (e) =>
        busy(e.currentTarget, async () => {
          const data = Object.fromEntries(
            ["name", "subject", "body"].map((f) => [
              f,
              dialog.querySelector("#productivity-template-" + f).value,
            ]),
          );
          if (select.value) data.id = Number(select.value);
          await api("/api/productivity/templates", {
            accountId: account,
            ...json(data),
          });
          if (live(rev)) templates();
        });
      dialog.querySelector(
        '[data-productivity-action="use-template"]',
      ).onclick = (e) =>
        busy(e.currentTarget, async () => {
          const subject = dialog.querySelector(
              "#productivity-template-subject",
            ).value,
            body = dialog.querySelector("#productivity-template-body").value;
          if (!body.trim()) throw Error("模板正文不能为空");
          if (document.body.classList.contains("compose-open")) {
            if (composeAccountId !== account)
              throw Error("发件账号已变化，请重新打开模板");
            if (
              composeMessageText() &&
              !(await mailaiAsk({
                title: "使用模板替换正文？",
                message: "主题和正文会替换，签名、附件和引用保留。",
                confirmText: "使用模板",
              }))
            )
              return;
            if (!live(rev)) return;
            document.getElementById("compose-subject").value = subject;
            composeMessageElement().innerHTML = esc(body).replace(
              /\n/g,
              "<br>",
            );
            queueDraftSave();
          } else
            await openCompose({
              subject,
              body_html: esc(body).replace(/\n/g, "<br>"),
              account_id: account,
            });
          if (live(rev)) dialog.close();
        });
      dialog.querySelector(
        '[data-productivity-action="delete-template"]',
      ).onclick = (e) =>
        busy(e.currentTarget, async () => {
          if (!select.value) throw Error("请选择要删除的模板");
          if (
            !(await mailaiAsk({
              title: "删除这个模板？",
              message: "不会删除已经使用模板写好的邮件。",
              confirmText: "删除模板",
            }))
          )
            return;
          if (!live(rev)) return;
          await api("/api/productivity/templates/" + select.value, {
            accountId: account,
            method: "DELETE",
          });
          if (live(rev)) templates();
        });
    } catch (error) {
      live(rev) && msg(error.message, true);
    }
  }
  function workflowDialog() {
    const email = selectedEmailDetail;
    if (!email) return toast("请先选择一封收件邮件", "warn");
    const account = owner();
    const rev = open(
      "安排邮件处理",
      `<div class="productivity-grid"><label>处理状态<select id="productivity-state">${Object.entries(
        labels,
      )
        .map(([k, v]) => `<option value="${k}">${v}</option>`)
        .join(
          "",
        )}</select></label><label id="productivity-at-label">重新出现 / 跟进时间<input id="productivity-at" type="datetime-local"></label></div><div class="productivity-actions">${button("明天上午 9 点", "tomorrow")}${button("下周一上午 9 点", "next-week")}${button("保存安排", "save-workflow", 'class="primary-action"')}</div><p class="productivity-hint">“稍后处理”到点恢复为未处理。“等待对方”可安排到期跟进；收到直接回复后解除等待。不移动服务器邮件，也不会自动发送催办。</p>`,
      account,
    );
    const select = dialog.querySelector("#productivity-state"),
      at = dialog.querySelector("#productivity-at");
    select.value = email.handle_state || "unhandled";
    const time = email.snoozed_until || email.followup_at;
    at.value = time?.slice(0, 16) || "";
    const update = () => {
      dialog.querySelector("#productivity-at-label").hidden = ![
        "later",
        "waiting",
      ].includes(select.value);
    };
    select.onchange = update;
    update();
    dialog.querySelectorAll("[data-productivity-action]").forEach(
      (n) =>
        (n.onclick = () => {
          const action = n.dataset.productivityAction;
          if (action === "save-workflow")
            return busy(n, async () => {
              const result = await api(
                `/api/productivity/workflow/${email.id}`,
                {
                  accountId: account,
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    state: select.value,
                    at: at.value,
                    followup_at: at.value,
                  }),
                },
              );
              if (live(rev)) {
                Object.assign(email, {
                  handle_state: result.state,
                  snoozed_until: result.state === "later" ? result.at : "",
                  followup_at: result.state === "waiting" ? result.at : "",
                });
                dialog.close();
                await loadWorkflow();
                decorateReading();
                toast("处理安排已保存", "success");
              }
            });
          const date = new Date();
          date.setHours(9, 0, 0, 0);
          date.setDate(
            date.getDate() +
              (action === "tomorrow" ? 1 : (8 - date.getDay()) % 7 || 7),
          );
          at.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16);
          if (!["later", "waiting"].includes(select.value))
            select.value = "later";
          update();
        }),
    );
  }
  function contacts(accountId = owner(), basic = false) {
    if (!basic && window.mailaiDirectoryImport) return window.mailaiDirectoryImport(accountId,()=>contacts(accountId,true));
    const rev = open("通讯录导入与导出", `<div class="productivity-tabs" role="tablist" aria-label="通讯录操作"><button role="tab" aria-selected="true" aria-controls="contact-import-panel" id="contact-import-tab">导入联系人</button><button role="tab" aria-selected="false" aria-controls="contact-export-panel" id="contact-export-tab">导出联系人</button></div>
      <section id="contact-import-panel" role="tabpanel" aria-labelledby="contact-import-tab"><p class="productivity-lead">从其他邮箱迁移联系人</p><p class="productivity-hint">选择 CSV 或 vCard 文件，先核对名单，再确认导入。</p><label class="productivity-file-picker"><input id="productivity-contact-file" type="file" accept=".csv,.vcf,text/csv,text/vcard"><strong>选择通讯录文件</strong><span data-file-name>支持 .csv、.vcf · 最大 2 MB</span></label><label class="productivity-check-row"><input id="productivity-overwrite" type="checkbox"><span>更新重复联系人的资料<small>默认保留已有资料；勾选后更新姓名、公司和分组。</small></span></label><div id="productivity-contact-preview"></div><div class="productivity-actions productivity-dialog-footer">${button("预览名单", "preview-contacts", 'disabled')}${button("确认导入", "import-contacts", 'disabled class="primary-action"')}</div><details class="productivity-help"><summary>CSV 格式与导入范围</summary><p>列名可用“邮箱、姓名、公司、分组”，或 email、name、company、group_name。每次最多 2000 人。导入只保存联系人，不会发送邮件。</p></details></section>
      <section id="contact-export-panel" role="tabpanel" aria-labelledby="contact-export-tab" hidden><p class="productivity-lead">导出当前邮箱的联系人</p><p class="productivity-hint">下载到电脑后，可导入其他邮箱或保留备份。</p><div class="productivity-choice-cards"><button type="button" data-productivity-action="export-csv"><strong>CSV 表格</strong><span>适合 Excel 和多数邮箱通讯录</span><small>下载 .csv</small></button><button type="button" data-productivity-action="export-vcard"><strong>vCard 通讯录</strong><span>适合系统通讯录及支持 vCard 的邮箱</span><small>下载 .vcf</small></button></div></section>`, accountId);
    dialog.dataset.panel = 'contacts';
    const account = dialogAccount, preview = dialog.querySelector('[data-productivity-action="preview-contacts"]'), apply = dialog.querySelector('[data-productivity-action="import-contacts"]');
    let text = '', format = 'csv', fileRevision = 0, canImport = false, imported = false;
    const reset = () => { ++fileRevision; canImport = false; imported = false; apply.disabled = true; dialog.querySelector('#productivity-contact-preview').replaceChildren(); msg(''); };
    for (const type of ['import','export']) {
      const tab = dialog.querySelector('#contact-'+type+'-tab');
      tab.onclick = () => {
        for (const key of ['import','export']) { dialog.querySelector('#contact-'+key+'-panel').hidden = key !== type; dialog.querySelector('#contact-'+key+'-tab').setAttribute('aria-selected', String(key === type)); }
      };
      tab.onkeydown = event => { if (['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const next = dialog.querySelector('#contact-'+(type === 'import' ? 'export' : 'import')+'-tab'); next.click(); next.focus(); } };
    }
    dialog.querySelector('#productivity-contact-file').onchange = async event => {
      reset(); preview.disabled = true; text = '';
      const epoch = fileRevision, file = event.target.files[0];
      dialog.querySelector('[data-file-name]').textContent = file ? file.name : '支持 .csv、.vcf · 最大 2 MB';
      if (!file) return;
      if (file.size > 2*1024*1024) return msg('文件超过 2 MB，请拆分后导入', true);
      try { const value = await file.text(); if (!live(rev) || epoch !== fileRevision) return; text = value; format = file.name.toLowerCase().endsWith('.vcf') ? 'vcard' : 'csv'; preview.disabled = !text; } catch(error) { if (live(rev)) msg('文件读取失败，请重新选择',true); }
    };
    dialog.querySelector('#productivity-overwrite').onchange = reset;
    for (const node of [preview,apply]) node.onclick = () => busy(node, async () => {
      if (!text) throw Error('请先选择通讯录文件');
      const epoch = fileRevision;
      const result = await api('/api/productivity/contacts/import',{accountId:account,...json({text,format,apply:node === apply,overwrite:dialog.querySelector('#productivity-overwrite').checked})});
      if (!live(rev) || epoch !== fileRevision) return;
      dialog.querySelector('#productivity-contact-preview').innerHTML = `<div class="productivity-preview-summary"><strong>${result.applied ? '已导入' : '可导入'} ${result.accepted} 人</strong><span>保留已有 ${result.skipped} 人 · 无效记录 ${result.invalid_rows.length} 条</span></div>` + (result.preview.length ? `<table class="productivity-contact-table"><thead><tr><th>姓名</th><th>邮箱</th></tr></thead><tbody>${result.preview.map(r=>`<tr><td>${esc(r.name || '—')}</td><td>${esc(r.email)}</td></tr>`).join('')}</tbody></table>` : '') + (result.accepted > 20 ? '<p class="productivity-hint">预览显示前 20 人；确认后导入全部有效记录。</p>' : '');
      canImport = !result.applied && Boolean(result.accepted); imported = result.applied; apply.disabled = !canImport;
      if (result.applied) { preview.disabled = true; msg('导入完成，可关闭此窗口查看通讯录。'); if (contactAccountId() === account) await loadContactCenter(); }
    }).finally(()=>{ if (live(rev)) { apply.disabled = !canImport; preview.disabled = !text || imported; } });
    for (const node of dialog.querySelectorAll('[data-productivity-action^="export-"]')) node.onclick = () => busy(node, async () => {
      const kind = node.dataset.productivityAction.slice(7);
      const response = await fetch('/api/productivity/contacts/export?format='+kind,{headers:{'X-MailAI-Account':account},signal:AbortSignal.timeout(20000)});
      if (!response.ok) throw Error((await response.json()).detail || '导出未完成');
      download(await response.blob(),'contacts.'+(kind === 'csv' ? 'csv' : 'vcf'),'text/plain');
      if (live(rev)) msg('通讯录已下载到电脑');
    });
  }
  function download(text, name, type) {
    const blob = text instanceof Blob ? text : new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function attachments(accountId = owner(), seed = null, compareFirst = false) {
    const rev = open('查找与对比附件', `<p class="productivity-lead">先选择文件，再查找其中的内容</p><label class="productivity-field">邮件附件<select data-file-choice aria-label="选择邮件附件"><option>正在读取附件…</option></select></label><p class="productivity-hint" data-file-source></p><div class="productivity-tabs" role="tablist" aria-label="附件操作"><button type="button" role="tab" id="attachment-content-tab" aria-controls="attachment-content-panel" aria-selected="true">搜索文件内容</button><button type="button" role="tab" id="attachment-compare-tab" aria-controls="attachment-compare-panel" aria-selected="false">比较同名文件</button></div><section id="attachment-content-panel" role="tabpanel" aria-labelledby="attachment-content-tab"><form data-file-search class="productivity-search-line"><input data-file-query aria-label="文件内容关键词" placeholder="例如：交货日期、合同编号、报价"><button type="submit" class="primary-action">搜索内容</button></form><p class="productivity-hint">在本机读取所选文件的可提取文字，不会上传给 AI。扫描件、图片和图表可能无法搜索。</p><div data-file-results aria-live="polite"></div></section><section id="attachment-compare-panel" role="tabpanel" aria-labelledby="attachment-compare-tab" hidden><p class="productivity-hint">自动查找其他邮件里的同名文件，再选两份比较文字内容。文件同名不代表属于同一份合同或材料。</p><div data-file-versions aria-live="polite"></div></section>`, accountId);
    dialog.dataset.panel = 'attachments';
    let files = [], versionsRevision = 0;
    const choice = dialog.querySelector('[data-file-choice]');
    const compareHost = dialog.querySelector('[data-file-versions]');
    const findVersions = async () => {
      const epoch = ++versionsRevision, file = files[Number(choice.value)];
      if (!file) return;
      compareHost.textContent = '正在查找同名附件…';
      const finish = window.mailaiMotion.pending(compareHost);
      try {
        const result = await api('/api/productivity/attachments/versions?name='+encodeURIComponent(file.name),{accountId});
        if (!live(rev) || epoch !== versionsRevision) return;
        const items = result.items;
        if (items.length < 2) { compareHost.innerHTML = '<div class="productivity-empty"><strong>没有其他同名附件</strong><p>只有这一份 '+esc(file.name)+'，暂时无需对比。</p></div>'; return; }
        const options = items.map((r,i)=>`<option value="${i}">${esc(fmtDate(r.date))} · ${esc(r.subject || '无主题')}</option>`).join('');
        compareHost.innerHTML = `<div class="productivity-grid"><label>第一份文件<select data-compare-before>${options}</select></label><label>第二份文件<select data-compare-after>${options}</select></label></div><button type="button" data-compare-run class="primary-action">比较这两份文件</button><div data-compare-summary></div><div class="productivity-diff" data-compare-output hidden></div>`;
        compareHost.querySelector('[data-compare-before]').value = '1';
        compareHost.querySelector('[data-compare-run]').onclick = event => busy(event.currentTarget, async () => {
          const first = compareHost.querySelector('[data-compare-before]').value, second = compareHost.querySelector('[data-compare-after]').value;
          if (first === second) throw Error('请选择两份不同的文件');
          const currentEpoch = versionsRevision;
          const result = await api('/api/productivity/attachments/compare',{accountId,...json({items:[items[first],items[second]].map(r=>({email_id:r.email_id,index:Number(r.attachment_index)}))})});
          if (!live(rev) || currentEpoch !== versionsRevision) return;
          compareHost.querySelector('[data-compare-summary]').textContent = result.identical ? '两份文件完全相同。' : result.text_equal ? '提取到的文字相同，格式或图片可能不同。' : '文字有变化：红色为第一份内容，绿色为第二份内容。';
          const output = compareHost.querySelector('[data-compare-output]'); output.hidden = !result.diff; output.innerHTML = (result.diff || '').split('\n').filter(line=>!line.startsWith('---')&&!line.startsWith('+++')&&!line.startsWith('@@')).map(line=>`<div class="${line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context'}"><small>${line.startsWith('+') ? '第二份' : line.startsWith('-') ? '第一份' : '相同'}</small><span>${esc(line.slice(1))}</span></div>`).join('');
          window.mailaiMotion.reveal(output);
          msg('只比较可提取的文字，不包含版式、图片和图表。'+result.notes.filter(note=>/仅提取|截断/.test(note)).join('；'));
        });
      } catch(error) { if (live(rev) && epoch === versionsRevision) compareHost.textContent = '无法读取：'+error.message; }
      finally { finish(); }
    };
    for (const type of ['content','compare']) {
      const tab = dialog.querySelector('#attachment-'+type+'-tab');
      tab.onclick = () => { dialog.querySelector('.productivity-lead').textContent = type === 'compare' ? '核对邮件里的同名文件' : '先选择文件，再查找其中的内容'; for (const key of ['content','compare']) { dialog.querySelector('#attachment-'+key+'-panel').hidden = key !== type; dialog.querySelector('#attachment-'+key+'-tab').setAttribute('aria-selected',String(key === type)); } if (type === 'compare') findVersions(); };
      tab.onkeydown = event => { if (['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const next=dialog.querySelector('#attachment-'+(type==='content'?'compare':'content')+'-tab'); next.click(); next.focus(); } };
    }
    choice.onchange = () => { ++versionsRevision; msg(''); dialog.querySelector('[data-file-results]').replaceChildren(); const file=files[Number(choice.value)]; dialog.querySelector('[data-file-source]').textContent=file ? fmtDate(file.date)+' · '+(file.subject || '无主题') : ''; if (!dialog.querySelector('#attachment-compare-panel').hidden) findVersions(); };
    dialog.querySelector('[data-file-query]').oninput = () => { ++versionsRevision; dialog.querySelector('[data-file-results]').replaceChildren(); msg(''); };
    dialog.querySelector('[data-file-search]').onsubmit = event => {
      event.preventDefault();
      const node=event.submitter;
      return busy(node,async()=>{
        const file=files[Number(choice.value)], query=dialog.querySelector('[data-file-query]').value.trim(), epoch=versionsRevision;
        if (!file) throw Error('请先选择文件'); if (!query) throw Error('请输入要查找的文字');
        msg('正在读取文件并搜索…');
        const result=await api(`/api/productivity/attachments/${file.email_id}/${file.index}/search`,{accountId,...json({query})});
        if (!live(rev) || epoch !== versionsRevision) return;
        dialog.querySelector('[data-file-results]').innerHTML = result.excerpts.length ? `<strong>找到 ${result.excerpts.length}${result.more ? ' 处以上' : ' 处'}匹配</strong>`+result.excerpts.map(value=>`<blockquote class="productivity-source-quote">${esc(value)}</blockquote>`).join('') : `<div class="productivity-empty"><strong>${result.empty ? '没有提取到可搜索的文字' : '没有找到这段文字'}</strong><p>${result.empty ? '该文件可能是扫描件、图片或不支持的格式，请下载后查看原文件。' : '请换一个关键词，或下载文件核对。'}</p></div>`;
        window.mailaiMotion.reveal(dialog.querySelector('[data-file-results]'));
        msg(/仅提取|截断/.test(result.note || '') ? '文件较长，本次仅搜索已提取的部分文字。' : '搜索完成；仅覆盖所选文件可提取的文字。');
      });
    };
    try {
      files=await panelRequest(rev, '正在读取附件列表…', '/api/attachments?limit=300',{accountId});
      if (!live(rev)) return;
      if (seed && !files.some(r=>r.email_id===seed.email_id && Number(r.index)===Number(seed.index))) files.unshift(seed);
      choice.innerHTML=files.length ? files.map((r,i)=>`<option value="${i}">${esc(r.name)} · ${esc(fmtDate(r.date))}</option>`).join('') : '<option value="">没有可用附件</option>';
      choice.disabled=!files.length;
      dialog.querySelector('[type=submit]').disabled=!files.length;
      if (seed) choice.value=String(files.findIndex(r=>r.email_id===seed.email_id && Number(r.index)===Number(seed.index)));
      choice.onchange();
      if (compareFirst) dialog.querySelector('#attachment-compare-tab').click();
    } catch(error) { if (live(rev)) msg('附件读取失败：'+error.message,true); }
  }
  async function shares(accountId = owner()) {
    const rev = open(
      "已分享文件",
      `<p class="productivity-lead">管理邮件里的大文件下载链接</p><p class="productivity-hint">大文件上传到你配置的腾讯云存储，再把下载链接插入邮件。这里只显示已上传文件，普通邮件附件不会自动出现在这里。</p><div class="productivity-actions">${button("写邮件并添加大文件", "new-share")}</div><div data-share-links></div><details class="productivity-help"><summary>链接到期后会怎样？</summary><p>收件人将无法使用已到期的链接。重新生成后，需要把新链接发给收件人；旧邮件不会自动更新。上传的文件仍在你的存储桶内。</p></details>`,
      accountId,
    );
    dialog.dataset.panel = 'shares';
    const account = dialogAccount;
    dialog.querySelector('[data-productivity-action="new-share"]').onclick = event => busy(event.currentTarget,async()=>{ dialog.close(); closeAttachmentCenter(); const opened=await openCompose({account_id:account}); if (opened !== false && composeAccountId === account) await openShareLinkDialog(); });
    try {
      const items = await panelRequest(rev, "正在读取分享链接…", "/api/productivity/shares/list", {
        accountId: account,
      });
      if (!live(rev)) return;
      const host = dialog.querySelector("[data-share-links]");
      host.innerHTML =
        items
          .map(
            (r, i) =>
              `<div class="productivity-source-quote"><strong>${esc(r.name)}</strong><p>${new Date(r.expires_at) <= new Date() ? "已过期" : "有效至"} ${esc(new Date(r.expires_at).toLocaleString())}</p><div class="productivity-actions"><button type="button" data-share-copy="${i}" ${new Date(r.expires_at) <= new Date() ? "disabled" : ""}>复制下载链接</button><button type="button" data-share-renew="${i}">生成新链接 · 7 天</button></div></div>`,
          )
          .join("") || '<div class="productivity-empty"><strong>还没有分享过大文件</strong><p>点击上方按钮，在写信时选择文件、设置有效期，上传后将下载链接插入正文。首次使用需要连接你自己的腾讯云存储；也可把已有网盘链接直接粘贴进邮件。</p></div>';
      host.querySelectorAll("[data-share-copy]").forEach(
        (n) =>
          (n.onclick = () =>
            busy(n, async () => {
              await navigator.clipboard.writeText(
                items[Number(n.dataset.shareCopy)].url,
              );
              if (live(rev)) msg("链接已复制");
            })),
      );
      host.querySelectorAll("[data-share-renew]").forEach(
        (n) =>
          (n.onclick = () =>
            busy(n, async () => {
              const i = Number(n.dataset.shareRenew);
              const result = await api(
                `/api/productivity/shares/${items[i].id}/renew`,
                { accountId: account, ...json({ days: 7 }) },
              );
              if (!live(rev)) return;
              items[i] = { ...items[i], ...result };
              const card = n.closest('.productivity-source-quote');
              card.querySelector('p').textContent='有效至 '+new Date(items[i].expires_at).toLocaleString();
              card.querySelector('[data-share-copy]').disabled=false;
              msg("链接已重新生成，请复制后重新分享；旧邮件中的链接不变");
            })),
      );
    } catch (error) {
      live(rev) && msg(error.message, true);
    }
  }
  async function followups(account = owner()) {
    const
      rev = open(
        "等待回复与跟进",
        `<p class="productivity-hint">写信的“发送安排”中可设置未回复提醒。仅对成功发送的邮件计时；同步到关联回复后取消提醒。未同步的回复无法判断，不会自动发送催办邮件。</p><div data-followup-list></div>`,
        account,
      );
    try {
      const items = await panelRequest(rev, "正在读取跟进记录…", "/api/productivity/followups/list", {
        accountId: account,
      });
      if (!live(rev)) return;
      const host = dialog.querySelector("[data-followup-list]");
      host.innerHTML =
        items
          .map(
            (row, i) =>
              `<div class="productivity-source-quote"><strong>${esc(row.subject || "无主题")}</strong><p>${esc(row.to_addr || "")}</p><small>${esc({ scheduled: row.sent ? "已提交提醒" : "等待回复", replied: "已同步到回复", canceled: "已取消" }[row.state] || row.state)} · ${esc(row.at.replace("T", " "))}</small><div class="productivity-actions"><button type="button" data-followup-open="${i}">查看已发送邮件</button>${row.state === "scheduled" ? `<input type="datetime-local" data-followup-at="${i}" value="${esc(row.at.slice(0, 16))}" aria-label="新的跟进时间"><button type="button" data-followup-save="${i}">调整时间</button><button type="button" data-followup-cancel="${i}">取消提醒</button>` : ""}</div></div>`,
          )
          .join("") ||
        "没有发信跟进记录。请在写信的“发送安排”中设置未回复提醒。";
      host.querySelectorAll("[data-followup-open]").forEach(
        (btn) =>
          (btn.onclick = () =>
            busy(btn, async () => {
              await revealResult(
                {
                  kind: "sent",
                  id: items[Number(btn.dataset.followupOpen)].sent_id,
                },
                account,
              );
              if (live(rev)) dialog.close();
            })),
      );
      for (const action of ["save", "cancel"])
        host.querySelectorAll("[data-followup-" + action + "]").forEach(
          (btn) =>
            (btn.onclick = () =>
              busy(btn, async () => {
                const index = Number(
                  btn.getAttribute("data-followup-" + action),
                );
                await api(
                  "/api/productivity/followups/" + items[index].sent_id,
                  {
                    accountId: account,
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      at: host.querySelector(
                        '[data-followup-at="' + index + '"]',
                      ).value,
                      cancel: action === "cancel",
                    }),
                  },
                );
                if (live(rev)) followups(account);
              })),
        );
    } catch (error) {
      live(rev) && msg(error.message, true);
    }
  }
  async function scheduled() { openTaskCenter(); }
  async function scheduleTime(token, account) {
    const rev = open("调整发送时间", '<label>计划发送时间<input type="datetime-local" data-outbox-time></label><p class="productivity-hint">电脑联网且 MailAI 运行时执行；退出期间无法准时发送。调整时间不会修改邮件内容。</p><div class="productivity-actions"><button type="button" data-save-time class="primary-action">保存时间</button></div>', account);
    try {
      const rows = await panelRequest(rev, "正在读取发送安排…", "/api/mail/outbox", {accountId:account});
      if (!live(rev)) return;
      const row = rows.find(r => r.token === token);
      if (!row || row.status !== 'queued') throw Error('任务已开始发送或已结束，不能修改时间');
      dialog.querySelector('[data-outbox-time]').value = row.due_at?.slice(0,16) || '';
      dialog.querySelector('[data-save-time]').onclick = event => busy(event.currentTarget, async () => {
        await api(`/api/mail/outbox/${encodeURIComponent(token)}/schedule`, {accountId:account, method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({at:dialog.querySelector('[data-outbox-time]').value})});
        if (live(rev)) { dialog.close(); toast('发送时间已修改', 'success'); refreshTaskCenter(); }
      });
    } catch(error) { if (live(rev)) msg(error.message,true); }
  }
  async function calendar(account = owner()) {
    const email = account === owner() && selectedEmailDetail ? selectedEmailDetail : { id: 0, subject: "" };
    const rev = open(
      "会议安排",
      `<label>导入 ICS 日历文件<input id="productivity-calendar-file" type="file" accept=".ics,text/calendar"></label><div id="productivity-invitations"></div><p>核对后创建日历事件：</p><div class="productivity-grid"><label class="wide">标题<input id="productivity-event-title"></label><label>开始时间（本地）<input type="datetime-local" id="productivity-event-start"></label><label>结束时间（本地）<input type="datetime-local" id="productivity-event-end"></label><label class="wide">地点<input id="productivity-event-location"></label></div><div class="productivity-actions">${button("导出日历事件", "export-event", 'class="primary-action"')}</div><p class="productivity-hint">导入文件只预览邀请；可下载原始 ICS 导入系统日历。接受/拒绝需核对并发送日历回复，对方服务可能不自动更新。手动创建的日期由你核对填写。</p>`,
      account,
    );
    dialog.querySelector("#productivity-event-title").value =
      email.subject || "";
    function show(events, fromMail = true) {
      const host = dialog.querySelector("#productivity-invitations");
      host.innerHTML =
        events
          .map(
            (r, i) =>
              `<div class="productivity-source-quote"><strong>${esc(r.title)}</strong><p>${esc(r.dtstart)} ${esc(r.dtstart_tzid || "")} — ${esc(r.dtend || "")} · ${esc(r.location || "")}</p><small>${esc(r.time_note)}</small>${fromMail && r.uid ? `<button data-event-response="${i}" data-response="accepted">接受并起草回复</button> <button data-event-response="${i}" data-response="declined">拒绝并起草回复</button>` : ""}</div>`,
          )
          .join("") ||
        '<p class="productivity-hint">没有 ICS 邀请，可导入文件或手动安排事件。</p>';
      host.querySelectorAll("[data-event-response]").forEach(
        (n) =>
          (n.onclick = () =>
            busy(n, async () => {
              const event = events[Number(n.dataset.eventResponse)];
              const draft = await api(
                `/api/productivity/calendar/${email.id}/response`,
                {
                  accountId: account,
                  ...json({ uid: event.uid, response: n.dataset.response }),
                },
              );
              if (!live(rev)) return;
              await openCompose({
                ...draft,
                body_html: esc(draft.body).replace(/\n/g, "<br>"),
                account_id: account,
              });
              dialog.close();
              toast(draft.notice, "success");
            })),
      );
    }
    try {
      const result = email.id
        ? await panelRequest(rev, "正在读取会议邀请…", `/api/productivity/calendar/${email.id}`, {
            accountId: account,
          })
        : { items: [] };
      if (!live(rev)) return;
      show(result.items);
    } catch (error) {
      live(rev) && msg(error.message, true);
    }
    dialog.querySelector("#productivity-calendar-file").onchange = async (
      event,
    ) => {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 500000) return msg("日历文件不能超过 500 KB", true);
      try {
        const result = await panelRequest(rev, "正在解析日历文件…", "/api/productivity/calendar/import", {
          accountId: account,
          ...json({ text: await file.text() }),
        });
        if (live(rev)) {
          show(result.items, false);
          msg(`已预览 ${result.items.length} 项邀请；时间与时区保留原文件。`);
        }
      } catch (error) {
        live(rev) && msg(error.message, true);
      }
    };
    dialog.querySelector('[data-productivity-action="export-event"]').onclick =
      (n) =>
        busy(n.currentTarget, async () => {
          const data = Object.fromEntries(
            ["title", "start", "end", "location"].map((key) => [
              key,
              dialog.querySelector("#productivity-event-" + key).value,
            ]),
          );
          const response = await fetch("/api/productivity/calendar/export", {
            ...json(data),
            headers: {
              "Content-Type": "application/json",
              "X-MailAI-Account": account,
            },
          });
          if (!response.ok)
            throw Error((await response.json()).detail || "导出失败");
          download(await response.blob(), "meeting.ics", "text/calendar");
          msg("日历文件已导出，请在系统日历中核对后导入");
        });
  }
  async function evidence() {
    const email = selectedEmailDetail;
    if (!email) return;
    const rev = open(
      "跨邮件核对",
      `<p class="productivity-hint">并列核对同一会话的明确日期与金额。不同事项和报价口径可能不同，片段不能代替最终确认。</p><div class="productivity-actions">${button("用 AI 对照日期金额与承诺", "semantic-evidence")}</div><p class="productivity-hint">AI 核对会将最多 12 封关联往来的正文发送给已配置模型，可能产生 API 用量；附件不包含在本次参考中。</p><div data-semantic-evidence></div><div data-evidence></div>`,
    );
    const account = dialogAccount;
    dialog.querySelector(
      '[data-productivity-action="semantic-evidence"]',
    ).onclick = (event) =>
      busy(event.currentTarget, async () => {
        msg("正在对照会话原文…");
        const result = await api(`/api/productivity/evidence/${email.id}/ai`, {
          accountId: account,
          ...json({}),
        });
        if (!live(rev)) return;
        const host = dialog.querySelector("[data-semantic-evidence]");
        host.innerHTML =
          result.items
            .map(
              (item, i) =>
                `<div class="productivity-source-quote"><small>AI 变化候选 · 待核对</small><strong>${esc(item.label)}</strong><p>${esc(item.before)} → ${esc(item.after)}</p><p>原文：${esc(item.before_quote)}</p><small>${esc(item.before_source.sender)} · ${esc(item.before_source.date)}</small><p>新原文：${esc(item.after_quote)}</p><small>${esc(item.after_source.sender)} · ${esc(item.after_source.date)}</small><p>${esc(item.note)}</p>${item.before_source.risky || item.after_source.risky ? '<p class="productivity-error">其中邮件存在风险线索，请先核实来源。</p>' : ""}<div class="productivity-actions"><button type="button" data-semantic-source="${i}:before">查看原来源</button><button type="button" data-semantic-source="${i}:after">查看新来源</button></div></div>`,
            )
            .join("") ||
          "<p>没有得到能在原文定位的变化候选；不能据此判定没有变化。</p>";
        host.querySelectorAll("[data-semantic-source]").forEach(
          (btn) =>
            (btn.onclick = () =>
              busy(btn, async () => {
                const [index, which] = btn.dataset.semanticSource.split(":");
                const source = result.items[Number(index)][which + "_source"];
                await revealResult(
                  { kind: source.source, id: source.id },
                  account,
                );
                if (live(rev)) dialog.close();
              })),
        );
        msg(
          result.scope +
            (result.rejected
              ? " 已过滤 " + result.rejected + " 项无法核验的输出。"
              : "") +
            (result.limited ? " 会话较长，本次参考不完整。" : ""),
        );
      });
    try {
      const result = await api(`/api/productivity/evidence/${email.id}`, {
        accountId: account,
      });
      if (!live(rev)) return;
      dialog.querySelector("[data-evidence]").innerHTML =
        result.items
          .map(
            (item, i) =>
              `<div class="productivity-source-quote"><small>${esc(item.date || "")} · ${item.kind === "date" ? "日期" : "金额"} · 待核对</small><strong>${esc(item.value)}</strong><p>${esc(item.quote)}</p><button type="button" data-evidence-source="${i}">查看来源邮件</button></div>`,
          )
          .join("") ||
        "未提取到明确可对照的日期或金额。没有提示不代表不存在变化。";
      dialog.querySelectorAll("[data-evidence-source]").forEach(
        (n) =>
          (n.onclick = () =>
            busy(n, async () => {
              const row = result.items[Number(n.dataset.evidenceSource)];
              await revealResult({ kind: row.source, id: row.id }, account);
              if (live(rev)) dialog.close();
            })),
      );
      msg(result.scope);
    } catch (error) {
      live(rev) && msg(error.message, true);
    }
  }
  function focusDialog() {
    const email = selectedEmailDetail;
    if (!email) return;
    const rev = open(
      "调整重要程度",
      `<p>这封邮件应放在哪个视图？</p><div class="productivity-actions">${button("重点邮件", "focus")}${button("其他邮件", "other")}${button("恢复自动判断", "auto")}</div><label><span><input type="checkbox" id="productivity-focus-sender"> 同时应用于该发件人的后续邮件</span></label>`,
    );
    const account = dialogAccount;
    dialog.querySelectorAll("[data-productivity-action]").forEach(
      (n) =>
        (n.onclick = () =>
          busy(n, async () => {
            await api(`/api/productivity/focus/${email.id}`, {
              accountId: account,
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                choice:
                  n.dataset.productivityAction === "auto"
                    ? ""
                    : n.dataset.productivityAction,
                sender: dialog.querySelector("#productivity-focus-sender")
                  .checked,
              }),
            });
            if (live(rev)) {
              dialog.close();
              await loadWorkflow();
              toast("重要程度已更新", "success");
            }
          })),
    );
  }
  function decorateReading() {
    // Mail actions, body and attachments share the existing reading layout.
    document.querySelector(".productivity-reading")?.remove();
  }
  function composeTools() {
    const header = document.querySelector(".compose-card>header");
    if (!header) return;
    const tools = document.createElement("span");
    tools.className='productivity-compose-window-actions';
    tools.innerHTML = `${button("最小化", "minimize", 'class="productivity-compose-button"')}${button("展开", "expand", 'class="productivity-compose-button" aria-pressed="false"')}`;
    header.querySelector("#btn-close-compose").before(tools);
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "productivity-resume-compose";
    resume.textContent = "继续写邮件";
    resume.hidden = true;
    document.body.append(resume);
    function restore() {
      const wasMinimized = document.body.classList.contains("productivity-compose-minimized");
      document.body.classList.remove("productivity-compose-minimized");
      document
        .querySelector(".compose-card")
        .classList.remove("productivity-minimized");
      resume.hidden = true;
      if (wasMinimized) window.mailaiMotion.reveal(document.querySelector(".compose-card"));
    }
    resume.onclick = restore;
    tools.onclick = (e) => {
      const node = e.target.closest("[data-productivity-action]");
      if (!node) return;
      if (node.dataset.productivityAction === "minimize") {
        if (draftSession.busy || draftSession.switching) return;
        busy(node, async () => {
          await saveCurrentDraft({ force: true });
          if (!document.body.classList.contains("compose-open")) return;
          document.body.classList.add("productivity-compose-minimized");
          document.querySelector(".compose-card").classList.add("productivity-minimized");
          resume.hidden = false;
        });
      } else {
        const expanded=document.querySelector('.compose-card').classList.toggle('productivity-expanded');
        node.textContent=expanded ? '还原' : '展开';
        node.setAttribute('aria-pressed',String(expanded));
        window.mailaiMotion.reveal(document.querySelector(".compose-card"));
      }
    };
    const toolbar = document.querySelector(".compose-toolbar-actions");
    const tpl = document.createElement("button");
    tpl.type = "button";
    tpl.className = "compose-tool-labeled";
    tpl.textContent = "模板";
    tpl.onclick = templates;
    toolbar.prepend(tpl);
    const phrase = document.createElement("button");
    phrase.type = "button";
    phrase.className = "compose-tool-labeled";
    phrase.textContent = "短语";
    phrase.onpointerdown = captureSnippetRange;
    phrase.onclick = snippets;
    tpl.after(phrase);
    const footer = document.querySelector(".compose-card>footer>div");
    const schedule = document.createElement("button");
    schedule.type = "button";
    schedule.className = "btn-ghost";
    schedule.textContent = "发送安排";
    schedule.id = "productivity-schedule-button";
    footer.prepend(schedule);
    const input = document.createElement("input");
    input.type = "hidden";
    input.id = "compose-send-at";
    footer.append(input);
    const followDays = document.createElement("input");
    followDays.type = "hidden";
    followDays.id = "compose-followup-days";
    followDays.value = "0";
    footer.append(followDays);
    const followAt = document.createElement("input");
    followAt.type = "hidden";
    followAt.id = "compose-followup-at";
    footer.append(followAt);
    const updateSendArrangement = () => {
      schedule.textContent = input.value
        ? "定时发送" +
          (Number(followDays.value) || followAt.value ? " · 跟进" : "")
        : Number(followDays.value) || followAt.value
          ? "发送与跟进"
          : "发送安排";
      schedule.title =
        "定时发送与未回复提醒" +
        (input.value ? " · " + input.value.replace("T", " ") : "");
    };
    schedule.onclick = () => {
      const session = draftSession,
        rev = open(
          "发送安排",
          `<div class="productivity-grid"><label>发送方式<select id="send-arrangement-mode"><option value="now">立即发送</option><option value="scheduled">定时发送</option></select></label><label data-send-time hidden>计划发送时间<input type="datetime-local" id="productivity-send-at"></label><label>未回复时提醒<select id="followup-choice"><option value="0">不提醒</option><option value="1">成功发送后 1 天</option><option value="3">成功发送后 3 天</option><option value="7">成功发送后 7 天</option><option value="custom">指定跟进时间</option></select></label><label data-followup-custom hidden>跟进时间<input type="datetime-local" id="followup-custom-at"></label></div><p class="productivity-hint">保存安排后，仍需点击写信窗口“发送”提交。定时发送和提醒需要电脑开机、联网且 MailAI 运行。跟进只在本机未同步到关联回复时提醒，不自动催办。</p><div class="productivity-actions">${button("保存安排", "save-send-arrangement", 'class="primary-action"')}</div>`,
          composeAccountId,
        );
      const mode = dialog.querySelector("#send-arrangement-mode"),
        at = dialog.querySelector("#productivity-send-at"),
        choice = dialog.querySelector("#followup-choice"),
        follow = dialog.querySelector("#followup-custom-at");
      mode.value = input.value ? "scheduled" : "now";
      at.value = input.value;
      choice.value = followAt.value ? "custom" : followDays.value;
      follow.value = followAt.value;
      const reveal = () => {
        dialog.querySelector("[data-send-time]").hidden =
          mode.value !== "scheduled";
        dialog.querySelector("[data-followup-custom]").hidden =
          choice.value !== "custom";
      };
      mode.onchange = reveal;
      choice.onchange = reveal;
      reveal();
      dialog.querySelector(
        '[data-productivity-action="save-send-arrangement"]',
      ).onclick = () => {
        if (session !== draftSession)
          return msg("写信窗口已变化，请重新安排", true);
        const sendTime = mode.value === "scheduled" ? at.value : "",
          followTime = choice.value === "custom" ? follow.value : "";
        if (
          (sendTime && new Date(sendTime) <= new Date()) ||
          (mode.value === "scheduled" && !sendTime)
        )
          return msg("请选择将来的发送时间", true);
        if (
          choice.value === "custom" &&
          (!followTime ||
            new Date(followTime) <= new Date() ||
            (sendTime && new Date(followTime) <= new Date(sendTime)))
        )
          return msg("跟进时间必须晚于当前时间与发送时间", true);
        input.value = sendTime;
        followDays.value = choice.value === "custom" ? "0" : choice.value;
        followAt.value = followTime;
        updateSendArrangement();
        clearComposePreflight();
        queueDraftSave();
        if (live(rev)) dialog.close();
      };
    };
    window.mailaiProductivityComposeReset = (seed = {}) => {
      restore();
      document.getElementById('productivity-undo-polish')?.setAttribute('hidden','');
      const expand=tools.querySelector('[data-productivity-action=expand]'); expand.textContent='展开'; expand.setAttribute('aria-pressed','false');
      followDays.value = String(seed.followup_days || 0);
      followAt.value = seed.followup_at || "";
      input.value = seed.send_at || "";
      updateSendArrangement();
      document
        .querySelector(".compose-card")
        .classList.remove("productivity-expanded");
      document.getElementById("productivity-compose-checks")?.replaceChildren();
    };
    window.mailaiProductivityComposeClosed = () => {
      restore();
      document.getElementById('productivity-undo-polish')?.setAttribute('hidden','');
      const expand=tools.querySelector('[data-productivity-action=expand]'); expand.textContent='展开'; expand.setAttribute('aria-pressed','false');
      document
        .querySelector(".compose-card")
        .classList.remove("productivity-expanded");
    };
    document
      .getElementById("compose-message")
      .addEventListener("paste", (event) => {
        if (event.shiftKey) {
          const text = event.clipboardData?.getData("text/plain");
          if (text) {
            event.preventDefault();
            document.execCommand("insertText", false, text);
          }
        }
      });
    const polish = document.createElement("button");
    polish.type = "button";
    polish.className = "compose-tool-labeled";
    polish.textContent = "润色选中文字";
    let selection;
    polish.onpointerdown = () => {
      const s = window.getSelection();
      if (s?.rangeCount) {
        const range = s.getRangeAt(0);
        if (
          composeMessageElement().contains(range.commonAncestorContainer) &&
          !range.collapsed
        )
          selection = range.cloneRange();
        else selection = null;
      }
    };
    polish.onclick = () => {
      const range = selection || savedComposeRange;
      if (range && !range.collapsed && composeMessageElement().contains(range.commonAncestorContainer)) polishSelection(range.cloneRange());
      else toast('请先在正文中选中文字','warn');
    };
    toolbar.append(polish);
    const undoPolish=document.createElement('button'); undoPolish.type='button'; undoPolish.id='productivity-undo-polish'; undoPolish.className='compose-tool-labeled'; undoPolish.textContent='撤销润色'; undoPolish.hidden=true;
    undoPolish.onclick=()=>{ undoComposeAiEdit(); if (!draftSession.aiUndo) undoPolish.hidden=true; }; toolbar.append(undoPolish);
    for (const id of ["compose-to", "compose-cc", "compose-bcc"]) {
      const field = document.getElementById(id),
        chips = document.createElement("div");
      chips.className = "productivity-recipient-list";
      field.closest("label").after(chips);
      const render = () => {
        const addresses = recipientEmails(field.value);
        chips.innerHTML = addresses
          .map(
            (address, i) =>
              `<button type="button" data-recipient-index="${i}" class="${getDomain(address) !== getDomain(_systemConfig?.accounts?.find((a) => a.id === composeAccountId)?.user || "") ? "external" : ""}" title="移除 ${esc(address)}">${esc(address)} ×</button>`,
          )
          .join("");
        chips.querySelectorAll("button").forEach(
          (n) =>
            (n.onclick = () => {
              const remaining = splitRecipientTokens(field.value).filter(
                (token) =>
                  !recipientEmails(token).includes(
                    addresses[Number(n.dataset.recipientIndex)],
                  ),
              );
              field.value = remaining.join(", ");
              field.dispatchEvent(new Event("input", { bubbles: true }));
              render();
            }),
        );
      };
      field.addEventListener("change", render);
      field.addEventListener("blur", render);
      new MutationObserver(() => {
        if (!document.body.classList.contains("compose-open"))
          chips.replaceChildren();
      }).observe(document.body, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
  }
  async function popoutCompose(node) {
    const session = draftSession,
      account = composeAccountId;
    if (session.busy || session.switching) return;
    return busy(node, async () => {
      await saveCurrentDraft({ force: true });
      await session.pending;
      if (session !== draftSession || !session.id)
        throw Error("请先填写并保存草稿");
      const native = window.pywebview?.api?.open_compose_window;
      if (native) {
        const result = await native(session.id, account);
        if (!result?.ok)
          throw Error(result?.message || "窗口未打开，草稿仍保留");
      } else {
        const url = new URL(location.href);
        url.search = "";
        url.searchParams.set("compose_draft", session.id);
        url.searchParams.set("compose_account", account);
        const popup = window.open(
          url.href,
          "mailai-compose-" + account + "-" + session.id,
          "popup,width=1050,height=760",
        );
        if (!popup)
          throw Error("浏览器阻止了窗口，请允许弹出窗口后重试；草稿仍保留");
      }
      if (session === draftSession) await closeCompose();
    });
  }
  window.mailaiShowComposeChecks = (checks) => {
    let host = document.getElementById("productivity-compose-checks");
    if (!host) {
      host = document.createElement("div");
      host.id = "productivity-compose-checks";
      host.className = "productivity-hint";
      document.getElementById("compose-ai-preview").append(host);
    }
    host.replaceChildren();
    for (const item of checks) {
      const row = document.createElement("p");
      row.textContent = item.text + " · " + item.note;
      host.append(row);
    }
  };
  async function polishSelection(range) {
    const original = range.toString(),
      account = composeAccountId,
      session = draftSession,
      originalHtml = composeMessageElement().innerHTML;
    const rev = open(
      "润色选中文字",
      `<div class="productivity-polish-columns"><section><h3>选中的原文</h3><div class="productivity-selection-preview" data-original></div></section><section><h3>润色建议</h3><div class="productivity-selection-preview" data-polished>正在生成…</div></section></div><div class="productivity-actions">${button("应用到选中位置", "apply-selection", 'disabled class="primary-action"')}</div><p class="productivity-hint">只将选中文字发送给已配置模型。原文未改变前可应用；不覆盖其他段落、附件、引用和签名。</p>`,
      account,
    );
    dialog.dataset.panel = 'polish';
    dialog.querySelector("[data-original]").textContent = original;
    const preview = dialog.querySelector("[data-polished]");
    preview.setAttribute("role", "status");
    const finish = window.mailaiMotion.pending(preview);
    try {
      const result = await api("/api/mail/compose/assist", {
        accountId: account,
        ...json({
          operation: "polish",
          body_text: original,
          has_signature: true,
        }),
      });
      if (!live(rev)) return;
      if (typeof result.content !== 'string' || !result.content.trim()) throw Error('没有生成可用建议，请重试');
      dialog.querySelector("[data-polished]").textContent = result.content;
      const apply = dialog.querySelector(
        '[data-productivity-action="apply-selection"]',
      );
      apply.disabled = false;
      apply.onclick = () => {
        if (
          session !== draftSession ||
          account !== composeAccountId ||
          !document.body.classList.contains("compose-open") ||
          composeMessageElement().innerHTML !== originalHtml ||
          range.toString() !== original ||
          !composeMessageElement().contains(range.commonAncestorContainer)
        )
          return msg("正文或发件账号已变化，请重新选择后润色", true);
        const body = composeMessageElement(), before = composeAiEditSnapshot();
        dialog.close(); // A showModal dialog makes the editor inert until it closes.
        body.focus({preventScroll:true});
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('insertText',false,result.content)) {
          range.deleteContents(); const node=document.createTextNode(result.content); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
        }
        rememberComposeSelection(); clearComposePreflight();
        rememberComposeAiEdit(before,['body'],'局部润色');
        document.getElementById('productivity-undo-polish').hidden = false;
        body.dispatchEvent(new Event('input',{bubbles:true}));
        queueDraftSave(); refreshComposeAiContext();
        toast('已应用到选中位置，可撤销本次修改','success');
      };
    } catch (error) {
      if (live(rev)) {
        preview.textContent = "未生成建议，请关闭后重新选择文字重试。";
        msg("生成未完成：" + error.message, true);
      }
    } finally {
      finish();
    }
  }
  function palette() {
    const rev = open(
      "快捷操作",
      `<input id="productivity-command-query" placeholder="搜索操作，如 回复、附件、待办…" aria-label="搜索快捷操作"><div id="productivity-commands"></div><p class="productivity-hint">⌘ / Ctrl + K 打开 · J / K 下一封 / 上一封 · R 回复 · / 搜索。输入文字、弹窗和写信时不触发单键快捷操作。</p>`,
    );
    const commands = [
      ["写邮件", () => document.getElementById("btn-compose").click()],
      ["高级搜索", openSearch],
      ["邮件模板", templates],
      ["附件中心", () => document.getElementById("btn-attachments").click()],
      ["待办", () => document.getElementById("btn-todos").click()],
      ["定时发送", scheduled],
      ["通讯录互导", contacts],
      ["同步邮件", () => document.getElementById("btn-poll").click()],
    ];
    const host = dialog.querySelector("#productivity-commands");
    function draw(query = "") {
      host.replaceChildren();
      commands
        .filter(([name]) => name.includes(query))
        .forEach(([name, fn]) => {
          const node = document.createElement("button");
          node.type = "button";
          node.className = "productivity-result";
          node.textContent = name;
          node.onclick = () => {
            if (live(rev)) dialog.close();
            fn();
          };
          host.append(node);
        });
    }
    draw();
    dialog.querySelector("#productivity-command-query").oninput = (e) =>
      draw(e.target.value);
    dialog.querySelector("#productivity-command-query").focus();
  }
  document.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      palette();
      return;
    }
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      document.body.classList.contains("compose-open") ||
      event.target.closest('input,textarea,select,[contenteditable="true"]') ||
      document.querySelector("dialog[open],.modal:not(.hidden)")
    )
      return;
    if (event.key === "/") {
      event.preventDefault();
      document.getElementById("global-search").focus();
    } else if (["j", "k"].includes(event.key)) {
      const rows = [...document.querySelectorAll("#email-list .email-item")];
      const at = rows.findIndex(
        (n) => Number(n.dataset.id) === selectedEmailId,
      );
      const next =
        rows[
          Math.max(
            0,
            Math.min(rows.length - 1, at + (event.key === "j" ? 1 : -1)),
          )
        ];
      if (next) {
        event.preventDefault();
        next.click();
        next.scrollIntoView({ block: "nearest" });
      }
    } else if (event.key === "r") {
      const reply = document.querySelector(
        "#reading-content button[aria-label=回复]",
      );
      reply?.click();
    }
  });
  initControls();
  composeTools();
  document.getElementById('attachment-grid').addEventListener('click',event=>{
    const node=event.target.closest('[data-attachment-compare]'); if (!node) return;
    const file=attachmentItems.find(r=>r.email_id===Number(node.dataset.emailId) && Number(r.index)===Number(node.dataset.attachmentIndex));
    if (file) attachments(attachmentCenterAccountId,file,true);
  });

  const reading = document.getElementById("reading-content");
  new MutationObserver(() => decorateReading()).observe(reading, {
    childList: true,
    subtree: true,
  });
  const accountWatcher = new MutationObserver(() => {
    if (state.account && state.account !== owner()) {
      state.view = "all";
      state.workflow.clear();
      window.mailaiClearWorkflowFilter?.();
      if (
        dialog?.open &&
        dialogAccount !== owner() &&
        !document.body.classList.contains("compose-open")
      )
        dialog.close();
      loadWorkflow();
    }
  });
  accountWatcher.observe(
    document.getElementById("account-mailbox-nav") ||
      document.querySelector(".sidebar"),
    { childList: true, subtree: true },
  );
  window.mailaiOAuthDialog = async () => {
    const rev = open(
      "官方账号登录",
      `<p class="productivity-hint">使用系统浏览器在 Google / Microsoft 官方页面授权。授权令牌保存在系统凭据库，MailAI 不收集你的登录密码。Microsoft 需注册桌面公共客户端；Google 使用桌面应用客户端。</p><div class="productivity-grid"><label>邮箱厂商<select id="productivity-oauth-provider"><option value="google">Google / Gmail</option><option value="microsoft">Microsoft / Outlook / 365</option></select></label><label>预期连接的邮箱<input id="productivity-oauth-user" type="email" autocomplete="email"></label><label class="wide">客户端 ID<input id="productivity-oauth-client" autocomplete="off" maxlength="300"></label><label class="wide" id="productivity-oauth-secret-label">Google 桌面客户端密钥（需要时填写）<input id="productivity-oauth-secret" type="password" autocomplete="new-password" placeholder="保存在系统凭据库；已有配置可留空"></label></div><div class="productivity-actions">${button("保存客户端配置", "oauth-save")}${button("前往官方授权", "oauth-start", 'class="primary-action"')}${button("连接邮箱", "oauth-complete", "disabled")}${button("取消本次登录", "oauth-cancel", "disabled")}</div><p id="productivity-oauth-status" role="status" aria-live="polite"></p><p class="productivity-hint">Microsoft 回调使用 http://localhost（随机端口），Google 使用 http://127.0.0.1（随机端口）。应用需获准使用 IMAP / SMTP 权限，企业账号可能需要管理员许可。</p>`,
    );
    let flow = "",
      pollTimer;
    const provider = dialog.querySelector("#productivity-oauth-provider"),
      client = dialog.querySelector("#productivity-oauth-client"),
      user = dialog.querySelector("#productivity-oauth-user");
    let clients = {};
    function update() {
      client.value = clients[provider.value]?.client_id || "";
      dialog.querySelector("#productivity-oauth-secret-label").hidden =
        provider.value !== "google";
      dialog.querySelector("#productivity-oauth-secret").value = "";
    }
    try {
      clients = await panelRequest(rev, "正在读取登录配置…", "/api/oauth/clients");
      if (!live(rev)) return;
      update();
    } catch (error) {
      msg(error.message, true);
    }
    provider.onchange = update;
    const request = (path, data) => api("/api/oauth/" + path, json(data));
    const cancel = async () => {
      clearTimeout(pollTimer);
      if (flow) await request("cancel", { state: flow }).catch(() => {});
      flow = "";
    };
    dialog.addEventListener("close", cancel, { once: true });
    dialog.querySelector('[data-productivity-action="oauth-save"]').onclick = (
      e,
    ) =>
      busy(e.currentTarget, async () => {
        await request("clients", {
          provider: provider.value,
          client_id: client.value,
          client_secret: dialog.querySelector("#productivity-oauth-secret")
            .value,
        });
        if (live(rev)) {
          dialog.querySelector("#productivity-oauth-secret").value = "";
          clients = await api("/api/oauth/clients");
          msg("客户端配置已安全保存");
        }
      });
    const status = dialog.querySelector("#productivity-oauth-status"),
      complete = dialog.querySelector(
        '[data-productivity-action="oauth-complete"]',
      ),
      stop = dialog.querySelector('[data-productivity-action="oauth-cancel"]');
    const poll = async () => {
      if (!flow || !live(rev)) return;
      try {
        const result = await api(
          "/api/oauth/status?state=" + encodeURIComponent(flow),
        );
        if (!live(rev)) return;
        status.textContent =
          {
            waiting: "等待你在官方页面授权…",
            exchanging: "正在核对授权…",
            ready: "授权已返回，可点击“连接邮箱”。",
            connecting: "正在连接邮箱…",
            complete: "邮箱已连接。",
            expired: "授权已过期，请重新登录。",
            failed: result.message || "授权未完成，请重试。",
            canceled: "登录已取消。",
          }[result.status] || result.message;
        status.toggleAttribute("data-motion-pending", ["waiting", "exchanging", "connecting"].includes(result.status));
        status.setAttribute("aria-busy", String(["waiting", "exchanging", "connecting"].includes(result.status)));
        complete.disabled = result.status !== "ready";
        if (["waiting", "exchanging"].includes(result.status))
          pollTimer = setTimeout(poll, 2000);
      } catch (error) {
        if (live(rev)) {
          status.textContent = "暂时无法读取授权状态，正在重试…";
          pollTimer = setTimeout(poll, 5000);
        }
      }
    };
    dialog.querySelector('[data-productivity-action="oauth-start"]').onclick = (
      e,
    ) =>
      busy(e.currentTarget, async () => {
        await cancel();
        await request("clients", {
          provider: provider.value,
          client_id: client.value,
          client_secret: dialog.querySelector("#productivity-oauth-secret")
            .value,
        });
        const result = await request("start", {
          provider: provider.value,
          user: user.value,
        });
        if (!live(rev)) return;
        flow = result.state;
        stop.disabled = false;
        const link = document.createElement("a");
        link.href = result.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "打开官方授权页面";
        status.replaceChildren(link);
        status.setAttribute("data-motion-pending", "");
        status.setAttribute("aria-busy", "true");
        if (window.pywebview?.api?.open_external_url)
          await window.pywebview.api.open_external_url(result.url);
        else link.click();
        pollTimer = setTimeout(poll, 1000);
      });
    stop.onclick = (e) =>
      busy(e.currentTarget, async () => {
        await cancel();
        if (live(rev)) {
          status.removeAttribute("data-motion-pending");
          status.setAttribute("aria-busy", "false");
          status.textContent = "本次登录已取消";
          complete.disabled = true;
        }
      });
    complete.onclick = (e) =>
      busy(e.currentTarget, async () => {
        const result = await request("complete", { state: flow });
        if (!live(rev)) return;
        dialog.close();
        await loadSystemConfig();
        await loadData();
        toast(
          "邮箱已连接" +
            (result.smtp_warning ? "；" + result.smtp_warning : ""),
          "success",
        );
      });
  };
  const previousReminder = window.mailaiOpenTaskReminder;
  window.mailaiOpenTaskReminder = async (target) => {
    if (target?.sentFollowupId) {
      if (target.accountId !== owner())
        await openAccountMailbox(target.accountId, "sent");
      return followups();
    }
    if (target?.workflowEmailId) {
      await revealResult(
        {
          kind: "email",
          id: target.workflowEmailId,
          account_id: target.accountId,
        },
        target.accountId,
      );
      workflowDialog();
    } else return previousReminder?.(target);
  };
  window.mailaiProductivity = {
    openSearch,
    templates,
    scheduled,
    scheduleTime,
    attachments,
    palette,
  };
  for (const anchorId of ["btn-add-mail", "onboarding-submit"]) {
    const anchor = document.getElementById(anchorId);
    if (!anchor) continue;
    const official = document.createElement("button");
    official.type = "button";
    official.className =
      anchorId === "btn-add-mail" ? "mail-add-entry" : "btn-ghost";
    official.textContent = "使用 Google / Microsoft 官方登录";
    official.onclick = () => window.mailaiOAuthDialog();
    anchor.after(official);
  }
  const detached = new URLSearchParams(location.search),
    detachedId = Number(detached.get("compose_draft")),
    detachedAccount = detached.get("compose_account");
  if (detachedId > 0 && detachedAccount) {
    document.documentElement.classList.add("productivity-detached");
    initialLoad.then(async () => {
      try {
        if (owner() !== detachedAccount)
          await openAccountMailbox(detachedAccount, "drafts");
        const seed = await api("/api/drafts/" + detachedId, {
          accountId: detachedAccount,
        });
        await openCompose({ ...seed, account_id: detachedAccount });
        document
          .querySelector(".compose-card")
          .classList.add("productivity-expanded");
      } catch (error) {
        toast("无法打开草稿：" + error.message, "error");
      }
    });
  }
  setTimeout(loadWorkflow, 1500);
  window.mailaiWorkflowChanged = () => {
    if (window.mailaiEnergy) window.mailaiEnergy.run('workflow', true);
    else if (!document.hidden) loadWorkflow();
  };
  if (window.mailaiEnergy) window.mailaiEnergy.register('workflow', loadWorkflow, 300000,
    () => Boolean(owner()) && !document.body.classList.contains('compose-open') && !document.querySelector('.layout')?.classList.contains('hidden'));
  else setInterval(() => { if (!document.hidden) loadWorkflow(); }, 300000);
})();
