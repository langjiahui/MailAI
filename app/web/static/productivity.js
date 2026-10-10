/* Local productivity: explicit account ownership, stale-response guards, recoverable edits. */
(() => {
  const labels = {
    get unhandled() { return mailaiText("未处理"); },
    get reply() { return mailaiText("待回复"); },
    get waiting() { return mailaiText("等待对方"); },
    get later() { return mailaiText("稍后处理"); },
    get done() { return mailaiText("已处理"); },
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
      toast(mailaiText("显示偏好未保存，请稍后重试"), "warn");
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
    `<button type="button" data-productivity-action="${action}" ${extra}>${mailaiLabelHTML(text)}</button>`;
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
      if (live(rev)) msg(mailaiSystemMessage(error.message), true);
      toast(mailaiSystemMessage(error.message), "error");
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
      ?.setAttribute("aria-expanded", String(title === mailaiText("高级搜索")));
    dialogAccount = account;
    if (!dialog.open) returnFocus = document.activeElement;
    dialog.classList.remove("productivity-search-results-ready");
    dialog.dataset.panel = "";
    dialog.innerHTML = `<header><h2 id="productivity-title">${mailaiLabelHTML(title)}</h2><button type="button" data-close-productivity aria-label="关闭${esc(title)}" data-i18n-aria="ui.3f92dbe70cb4">✕</button></header><div class="productivity-body"><p class="productivity-hint" data-account-label></p>${body}<p data-message role="status" aria-live="polite"></p></div>`;
    const accountRow = _systemConfig?.accounts?.find((a) => a.id === account);
    mailaiBindUI(dialog.querySelector("[data-account-label]"), "textContent", () => (mailaiTemplate`${accountRow?.user || mailaiText("当前邮箱")} · 数据保存在本机`));
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
        (state.view === "focus" ? mailaiText("重点邮件") : labels[state.view]);
  window.mailaiProductivityTags = (e) =>
    `${e.handle_state && e.handle_state !== "unhandled" ? `<span class="tag productivity-workflow-tag">${esc(labels[e.handle_state])}${e.snoozed_until ? " · " + esc(new Date(e.snoozed_until).toLocaleString(currentI18nLanguage(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })) : ""}</span>` : ""}${e._conversationCount > 1 ? `<span class="tag"><span data-i18n="ui.fe45d0bffff4">${e._conversationCount} 封往来</span></span>` : ""}`;
  function initControls() {
    // Each tool lives in its own panel; the mailbox list has one filter trigger.
    const entry = (host, label, action) => {
      if (!host) return;
      const node = document.createElement("button");
      node.type = "button";
      node.className = "productivity-panel-entry";
      const source = mailaiCopySource(label);
      mailaiBindUI(node, "textContent", () => mailaiText(source));
      node.onclick = action;
      host.append(node);
    };
    entry(document.querySelector(".contact-center-tools"), mailaiText("导入 / 导出"), () => contacts(contactAccountId()));
    entry(document.querySelector(".attachment-center-tools"), mailaiText("查找文件内容"), () => attachments(attachmentCenterAccountId));
    entry(document.querySelector(".attachment-center-tools"), mailaiText("已分享文件"), () => shares(attachmentCenterAccountId));
    entry(document.querySelector(".task-account-picker"), mailaiText("发信跟进"), () => followups(taskCenterScope()));
    entry(document.querySelector(".todo-center-tools"), mailaiText("日历文件"), () => calendar(todoCenterAccountId));
    const filter = document.getElementById("btn-filter-panel");
    document.querySelector(".list-sort").prepend(filter);
    const task = document.getElementById("btn-task-center");
    task.className = "nav-action productivity-outbox-entry";
    task.removeAttribute("data-i18n");
    task.innerHTML = "<svg class=\"nav-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 14v5h16v-5\"/><path class=\"task-activity-arrow\" d=\"M12 14V4m-4 4 4-4 4 4\"/></svg><span><span data-i18n=\"ui.02d55e8b9e34\">发件箱</span></span><i data-task-count hidden></i>";
    mailaiBindUI(task, "@aria-label", () => (mailaiText("任务与发件箱")));
    mailaiBindUI(task, "title", () => (mailaiText("任务与发件箱")));
    document.querySelector(".nav-system-cluster").prepend(task);
    const workflow = document.createElement('label');
    workflow.className = 'filter-select-row';
    workflow.innerHTML = "<span><b><span data-i18n=\"ui.932ea885da06\">邮件范围</span></b><small><span data-i18n=\"ui.a934c3c3dadb\">按重要程度或处理标记筛选</span></small></span><select id=\"productivity-workflow-filter\"><option value=\"all\" data-i18n=\"ui.fe595850aebb\">全部邮件</option><option value=\"focus\" data-i18n=\"ui.17cf368141bb\">重点邮件</option><option value=\"reply\" data-i18n=\"ui.e54bd4a29208\">待回复</option><option value=\"waiting\" data-i18n=\"ui.cb6833fbc011\">等待对方</option><option value=\"later\" data-i18n=\"ui.bf639a51feec\">稍后处理</option><option value=\"done\" data-i18n=\"ui.59f6c8369293\">已处理</option></select>";
    document.querySelector('.filter-form').prepend(workflow);
    const select = workflow.querySelector('select');
    select.onchange = () => { state.navigation = mailboxNavigationRevision; state.view = select.value; clearMailSelection(); refresh(); window.mailaiWorkflowChanged?.(); };
    window.mailaiWorkflowFilterLabel = () => !specialMailbox && state.view !== 'all' ? state.view === 'focus' ? mailaiText('重点邮件') : labels[state.view] : '';
    window.mailaiClearWorkflowFilter = () => { state.view = 'all'; select.value = 'all'; };
    document.getElementById('btn-reset-filter').addEventListener('click', window.mailaiClearWorkflowFilter);
    const searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.className = "search-filter-button";
    searchBtn.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h6m4 0h4M3 10h2m4 0h8M3 15h8m4 0h2"/><circle cx="11" cy="5" r="2"/><circle cx="7" cy="10" r="2"/><circle cx="13" cy="15" r="2"/></svg>';
    mailaiBindUI(searchBtn, "title", () => (mailaiText("高级搜索")));
    searchBtn.setAttribute("aria-haspopup", "dialog");
    searchBtn.setAttribute("aria-controls", "productivity-dialog");
    searchBtn.setAttribute("aria-expanded", "false");
    mailaiBindUI(searchBtn, "@aria-label", () => (mailaiText("高级搜索与保存搜索")));
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
      close.className = "productivity-filter-collapse";
      mailaiBindUI(close, "textContent", () => (mailaiText("收起")));
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
      mailaiText("高级搜索"),
      `<form id="productivity-search-form"><div class="productivity-grid"><label class="wide"><span data-i18n="ui.039eff12b871">关键词或搜索条件</span><input data-criterion="query" placeholder="例如 from:person@example.com filename:pdf" data-i18n-placeholder="ui.bf8c2c84371f"></label><label><span data-i18n="ui.bae32961a3b5">发件人</span><input data-criterion="sender"></label><label><span data-i18n="ui.7a6d6cee582d">收件人 / 抄送</span><input data-criterion="recipient"></label><label><span data-i18n="ui.788db1cfec2a">主题</span><input data-criterion="subject"></label><label><span data-i18n="ui.d10109f8116b">附件名称或类型</span><input data-criterion="filename" placeholder="例如 合同.pdf 或 .xlsx" data-i18n-placeholder="ui.d68c94f0a221"></label><label><span data-i18n="ui.760506491eef">开始日期</span><input type="date" data-criterion="after"></label><label><span data-i18n="ui.895cd52fbbb6">结束日期</span><input type="date" data-criterion="before"></label><label><span data-i18n="ui.932ea885da06">邮件范围</span><select data-criterion="mailbox"><option value="all" data-i18n="ui.f93ecd2cd5cb">全部正常邮件（含发件、草稿）</option><option value="inbox" data-i18n="ui.63a5e7b73911">收件箱</option><option value="sent" data-i18n="ui.60823aaec73b">已发送</option><option value="drafts" data-i18n="ui.2a2fd29bd27a">草稿</option><option value="trash" data-i18n="ui.077a6d37719a">已删除</option><option value="quarantine" data-i18n="ui.699ef8314304">隔离区</option><option value="spam" data-i18n="ui.73c996531fe0">垃圾邮件</option></select></label><label><span data-i18n="ui.04229dd66789">AI 分类</span><input data-criterion="category" placeholder="例如 订阅推送、项目工作" data-i18n-placeholder="ui.6b2603525721"></label><label><span data-i18n="ui.d5e74de3449e">处理状态</span><select data-criterion="state"><option value="" data-i18n="ui.f203d577d142">不限</option>${Object.entries(
        labels,
      )
        .map(([k, v]) => `<option value="${k}" data-i18n="${mailaiUICopyKeys.get(mailaiCopySource(v))}">${v}</option>`)
        .join(
          "",
        )}<option value="due" data-i18n="ui.dcaf2b13ca8f">等待反馈已到期</option><option value="focus" data-i18n="ui.17cf368141bb">重点邮件</option></select></label><label><span><input type="checkbox" data-criterion="has_attachment"> <span data-i18n="ui.184ea93ac496">有附件</span></span></label><label><span><input type="checkbox" data-criterion="unread"> <span data-i18n="ui.975b35e1ec59">仅未读</span></span></label></div><label><input type="checkbox" id="productivity-all-accounts"> <span data-i18n="ui.8d1630336cbf">搜索所有可见账号</span></label><div class="productivity-actions"><button type="submit" class="primary-action"><span data-i18n="ui.44ce7ae909bb">搜索</span></button>${button(mailaiText("保存本次条件"), "save-search")}<select id="productivity-saved-search" aria-label="使用已保存的搜索" data-i18n-aria="ui.a232f99a42c5"><option value="" data-i18n="ui.72f9e5e9ebfc">已保存的搜索…</option></select></div></form><p class="productivity-hint"><span data-i18n="ui.ed3046209eaf">所有条件同时满足；仅搜索本地已同步数据。搜索结果不会调用 AI。附件内容请到“附件中心 → 文字与版本”搜索。</span></p><div class="productivity-actions"><button type="button" data-search-expand hidden><span data-i18n="ui.c17b24161af0">展开搜索条件</span></button></div><div id="productivity-search-results" aria-live="polite"></div>`,
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
        msg(mailaiText("正在搜索…"));
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
          mailaiBindUI(expand, "textContent", () => (collapsed ? mailaiText("展开搜索条件") : mailaiText("收起搜索条件")));
        };
        const host = dialog.querySelector("#productivity-search-results");
        host.querySelector("[data-more-search]")?.remove();
        if (!append) host.replaceChildren();
        for (const row of result.items) {
          const node = document.createElement("button");
          node.type = "button";
          node.className = "productivity-result";
          node.innerHTML = `<strong>${esc(row.subject || mailaiText("无主题"))}</strong><small>${esc(row.account_user || "")} ${esc({ get email() { return mailaiText("邮件"); }, get sent() { return mailaiText("已发送"); }, get draft() { return mailaiText("草稿"); } }[row.kind])} · ${esc(row.from_addr || row.to_addr || "")} · ${esc(row.date ? new Date(row.date).toLocaleString(currentI18nLanguage()) : "")}</small><small>${esc(row.preview || "")}</small>`;
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
          mailaiBindUI(more, "textContent", () => (mailaiText("继续显示")));
          more.onclick = () => run(true);
          host.append(more);
        }
        if (!offset)
          mailaiBindUI(host, "textContent", () => (mailaiText("没有匹配结果，可减少条件或扩大时间范围。")));
        msg(
          result.scope +
            (result.failed_accounts?.length
              ? mailaiText("；部分账号未读取，请切换对应账号检查")
              : "") +
            mailaiTemplate` · 已显示 ${offset} 项`,
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
          live(rev) && msg(mailaiText("已保存搜索暂时无法读取：") + mailaiSystemMessage(error.message), true),
      );
    dialog.querySelector('[data-productivity-action="save-search"]').onclick = (
      event,
    ) =>
      busy(event.currentTarget, async () => {
        const name = await mailaiAsk({
          get title() { return mailaiText("保存搜索条件"); },
          get label() { return mailaiText("名称"); },
          get value() { return mailaiText("常用搜索"); },
        });
        if (!name || !live(rev)) return;
        const criteria = getCriteria();
        const result = await api("/api/productivity/searches", {
          accountId: account,
          ...json({ name, criteria }),
        });
        if (live(rev)) {
          msg(mailaiText("搜索条件已保存"));
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
      mailaiText("常用短语"),
      `<div class="productivity-grid"><label><span data-i18n="ui.f32a0f8a5096">已有短语</span><select data-snippet-select><option value="" data-i18n="ui.99e58db8e677">新建短语</option></select></label><label><span data-i18n="ui.d44e9b3d3b31">名称</span><input data-snippet-name maxlength="80"></label><label class="wide"><span data-i18n="ui.7a688306423b">内容</span><textarea data-snippet-body rows="7" maxlength="5000"></textarea></label></div><div class="productivity-actions">${button(mailaiText("保存短语"), "snippet-save", 'class="primary-action"')}${button(mailaiText("插入正文光标位置"), "snippet-insert", writing ? "" : "disabled")}${button(mailaiText("删除短语"), "snippet-delete")}</div><p class="productivity-hint"><span data-i18n="ui.08c107470599">仅插入文字，保留正文其他部分、签名和引用。选中一段文字时替换该段；未指定光标时插入正文末尾。</span></p>`,
      account,
    );
    let items = [];
    try {
      items = await panelRequest(rev, mailaiText("正在读取常用短语…"), "/api/productivity/snippets", { accountId: account });
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
          if (!body.value.trim()) throw Error(mailaiText("请先填写或选择短语"));
          if (
            session !== draftSession ||
            account !== composeAccountId ||
            !document.body.classList.contains("compose-open")
          )
            throw Error(mailaiText("写信窗口或发件账号已变化，请重新打开短语"));
          const text = body.value,
            target = composeMessageElement();
          let insertion = range;
          if (insertion && !target.contains(insertion.commonAncestorContainer))
            throw Error(mailaiText("正文位置已变化，请重新选择插入位置"));
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
          if (!select.value) throw Error(mailaiText("请选择短语"));
          if (
            !(await mailaiAsk({
              get title() { return mailaiText("删除这条短语？"); },
              get message() { return mailaiText("已插入邮件的文字会保留。"); },
              get confirmText() { return mailaiText("删除"); },
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
      live(rev) && msg(mailaiSystemMessage(error.message), true);
    }
  }
  async function templates() {
    const account = document.body.classList.contains("compose-open")
      ? composeAccountId
      : owner();
    const rev = open(
      mailaiText("邮件模板"),
      `<div class="productivity-grid"><label><span data-i18n="ui.a3623cdcb7e1">选择模板</span><select id="productivity-template"><option value="" data-i18n="ui.55da24dbf2b7">新建模板</option></select></label><label><span data-i18n="ui.f7816a356dbc">模板名称</span><input id="productivity-template-name" maxlength="80"></label><label class="wide"><span data-i18n="ui.788db1cfec2a">主题</span><input id="productivity-template-subject" maxlength="300"></label><label class="wide"><span data-i18n="ui.d661c3d96d53">正文</span><textarea id="productivity-template-body" rows="8"></textarea></label></div><div class="productivity-actions">${button(mailaiText("保存模板"), "save-template", 'class="primary-action"')}${button(mailaiText("使用模板"), "use-template")}${button(mailaiText("保存当前正文为模板"), "current-template")}${button(mailaiText("删除模板"), "delete-template")}</div><p class="productivity-hint"><span data-i18n="ui.849e5e868e06">模板只包含主题和正文，不保存收件人、附件和签名；使用前可继续修改。</span></p>`,
      account,
    );
    let items = [];
    try {
      items = await panelRequest(rev, mailaiText("正在读取邮件模板…"), "/api/productivity/templates", { accountId: account });
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
          get name() { return mailaiText("常用邮件"); },
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
          if (!body.trim()) throw Error(mailaiText("模板正文不能为空"));
          if (document.body.classList.contains("compose-open")) {
            if (composeAccountId !== account)
              throw Error(mailaiText("发件账号已变化，请重新打开模板"));
            if (
              composeMessageText() &&
              !(await mailaiAsk({
                get title() { return mailaiText("使用模板替换正文？"); },
                get message() { return mailaiText("主题和正文会替换，签名、附件和引用保留。"); },
                get confirmText() { return mailaiText("使用模板"); },
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
          if (!select.value) throw Error(mailaiText("请选择要删除的模板"));
          if (
            !(await mailaiAsk({
              get title() { return mailaiText("删除这个模板？"); },
              get message() { return mailaiText("不会删除已经使用模板写好的邮件。"); },
              get confirmText() { return mailaiText("删除模板"); },
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
      live(rev) && msg(mailaiSystemMessage(error.message), true);
    }
  }
  function workflowDialog() {
    const email = selectedEmailDetail;
    if (!email) return toast(mailaiText("请先选择一封收件邮件"), "warn");
    const account = owner();
    const rev = open(
      mailaiText("安排邮件处理"),
      `<div class="productivity-grid"><label><span data-i18n="ui.d5e74de3449e">处理状态</span><select id="productivity-state">${Object.entries(
        labels,
      )
        .map(([k, v]) => `<option value="${k}" data-i18n="${mailaiUICopyKeys.get(mailaiCopySource(v))}">${v}</option>`)
        .join(
          "",
        )}</select></label><label id="productivity-at-label"><span data-i18n="ui.d5d50f64d2e5">重新出现 / 跟进时间</span><input id="productivity-at" type="datetime-local"></label></div><div class="productivity-actions">${button(mailaiText("明天上午 9 点"), "tomorrow")}${button(mailaiText("下周一上午 9 点"), "next-week")}${button(mailaiText("保存安排"), "save-workflow", 'class="primary-action"')}</div><p class="productivity-hint"><span data-i18n="ui.9f0109d009c7">“稍后处理”到点恢复为未处理。“等待对方”可安排到期跟进；收到直接回复后解除等待。不移动服务器邮件，也不会自动发送催办。</span></p>`,
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
                toast(mailaiText("处理安排已保存"), "success");
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
    const rev = open(mailaiText("通讯录导入与导出"), `<div class="productivity-tabs" role="tablist" aria-label="通讯录操作" data-i18n-aria="ui.0804ad5e9332"><button role="tab" aria-selected="true" aria-controls="contact-import-panel" id="contact-import-tab"><span data-i18n="ui.aef933c95b79">导入联系人</span></button><button role="tab" aria-selected="false" aria-controls="contact-export-panel" id="contact-export-tab"><span data-i18n="ui.5470c147426c">导出联系人</span></button></div>
      <section id="contact-import-panel" role="tabpanel" aria-labelledby="contact-import-tab"><p class="productivity-lead"><span data-i18n="ui.f7fae66168bb">从其他邮箱迁移联系人</span></p><p class="productivity-hint"><span data-i18n="ui.7e75cf3d2d8b">选择 CSV 或 vCard 文件，先核对名单，再确认导入。</span></p><label class="productivity-file-picker"><input id="productivity-contact-file" type="file" accept=".csv,.vcf,text/csv,text/vcard"><strong><span data-i18n="ui.8016b845abb9">选择通讯录文件</span></strong><span data-file-name><span data-i18n="ui.479a650926da">支持 .csv、.vcf · 最大 2 MB</span></span></label><label class="productivity-check-row"><input id="productivity-overwrite" type="checkbox"><span><span data-i18n="ui.2d99b5103742">更新重复联系人的资料</span><small><span data-i18n="ui.e7a1b1b8fe44">默认保留已有资料；勾选后更新姓名、公司和分组。</span></small></span></label><div id="productivity-contact-preview"></div><div class="productivity-actions productivity-dialog-footer">${button(mailaiText("预览名单"), "preview-contacts", 'disabled')}${button(mailaiText("确认导入"), "import-contacts", 'disabled class="primary-action"')}</div><details class="productivity-help"><summary><span data-i18n="ui.c11331fc6484">CSV 格式与导入范围</span></summary><p><span data-i18n="ui.e9374c71a1b6">列名可用“邮箱、姓名、公司、分组”，或 email、name、company、group_name。每次最多 2000 人。导入只保存联系人，不会发送邮件。</span></p></details></section>
      <section id="contact-export-panel" role="tabpanel" aria-labelledby="contact-export-tab" hidden><p class="productivity-lead"><span data-i18n="ui.2176b52f524d">导出当前邮箱的联系人</span></p><p class="productivity-hint"><span data-i18n="ui.c1ef262fb7e4">下载到电脑后，可导入其他邮箱或保留备份。</span></p><div class="productivity-choice-cards"><button type="button" data-productivity-action="export-csv"><strong><span data-i18n="ui.b03159187c77">CSV 表格</span></strong><span><span data-i18n="ui.6c59b955165c">适合 Excel 和多数邮箱通讯录</span></span><small><span data-i18n="ui.055d92a5c2b1">下载 .csv</span></small></button><button type="button" data-productivity-action="export-vcard"><strong><span data-i18n="ui.9204269040bc">vCard 通讯录</span></strong><span><span data-i18n="ui.462a85b768a7">适合系统通讯录及支持 vCard 的邮箱</span></span><small><span data-i18n="ui.5983badacad1">下载 .vcf</span></small></button></div></section>`, accountId);
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
      mailaiBindUI(dialog.querySelector('[data-file-name]'), "textContent", () => (file ? file.name : mailaiText('支持 .csv、.vcf · 最大 2 MB')));
      if (!file) return;
      if (file.size > 2*1024*1024) return msg(mailaiText('文件超过 2 MB，请拆分后导入'), true);
      try { const value = await file.text(); if (!live(rev) || epoch !== fileRevision) return; text = value; format = file.name.toLowerCase().endsWith('.vcf') ? 'vcard' : 'csv'; preview.disabled = !text; } catch(error) { if (live(rev)) msg(mailaiText('文件读取失败，请重新选择'),true); }
    };
    dialog.querySelector('#productivity-overwrite').onchange = reset;
    for (const node of [preview,apply]) node.onclick = () => busy(node, async () => {
      if (!text) throw Error(mailaiText('请先选择通讯录文件'));
      const epoch = fileRevision;
      const result = await api('/api/productivity/contacts/import',{accountId:account,...json({text,format,apply:node === apply,overwrite:dialog.querySelector('#productivity-overwrite').checked})});
      if (!live(rev) || epoch !== fileRevision) return;
      dialog.querySelector('#productivity-contact-preview').innerHTML = `<div class="productivity-preview-summary"><strong><span data-i18n="ui.dfb980886814">${result.applied ? mailaiText('已导入') : mailaiText('可导入')} ${result.accepted} 人</span></strong><span><span data-i18n="ui.f1cb16c37baa">保留已有 ${result.skipped} 人 · 无效记录 ${result.invalid_rows.length} 条</span></span></div>` + (result.preview.length ? `<table class="productivity-contact-table"><thead><tr><th><span data-i18n="ui.50b5b1d2abef">姓名</span></th><th><span data-i18n="ui.73075237fd0f">邮箱</span></th></tr></thead><tbody>${result.preview.map(r=>`<tr><td>${esc(r.name || '—')}</td><td>${esc(r.email)}</td></tr>`).join('')}</tbody></table>` : '') + (result.accepted > 20 ? "<p class=\"productivity-hint\"><span data-i18n=\"ui.d7d64489995f\">预览显示前 20 人；确认后导入全部有效记录。</span></p>" : '');
      canImport = !result.applied && Boolean(result.accepted); imported = result.applied; apply.disabled = !canImport;
      if (result.applied) { preview.disabled = true; msg(mailaiText('导入完成，可关闭此窗口查看通讯录。')); if (contactAccountId() === account) await loadContactCenter(); }
    }).finally(()=>{ if (live(rev)) { apply.disabled = !canImport; preview.disabled = !text || imported; } });
    for (const node of dialog.querySelectorAll('[data-productivity-action^="export-"]')) node.onclick = () => busy(node, async () => {
      const kind = node.dataset.productivityAction.slice(7);
      const response = await fetch('/api/productivity/contacts/export?format='+kind,{headers:{'X-MailAI-Account':account},signal:AbortSignal.timeout(20000)});
      if (!response.ok) throw Error((await response.json()).detail || mailaiText('导出未完成'));
      download(await response.blob(),'contacts.'+(kind === 'csv' ? 'csv' : 'vcf'),'text/plain');
      if (live(rev)) msg(mailaiText('通讯录已下载到电脑'));
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
  const attachmentRef = file => `${file.email_id}:${Number(file.index ?? file.attachment_index)}`;
  const searchableAttachment = file => /\.(pdf|docx|xlsx|xls|pptx|txt|csv|md)$/i.test(file.name || '') && Number(file.size || 0) <= 10 * 1024 * 1024;
  const attachmentUiIcon = kind => {
    const paths = {
      search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
      preview:'<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
      mail:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>',
      files:'<path d="M9 3h8l4 4v12H9zM17 3v5h4M5 7H3v14h13v-2"/>',
      arrow:'<path d="m9 5 7 7-7 7"/>',
    };
    return `<svg class="attachment-ui-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[kind] || paths.search}</svg>`;
  };
  function attachmentFileHeading(file, badge='') {
    const ext=(file.name || '').split('.').pop().slice(0,5).toUpperCase();
    return `<div class="attachment-hit-heading"><span class="attachment-content-file-icon" aria-hidden="true">${attachmentUiIcon('files')}<small>${esc(ext)}</small></span><div class="attachment-hit-title"><strong>${esc(file.name)}</strong><span>${esc(file.subject || mailaiText('无主题'))}</span></div>${badge}</div>`;
  }
  function attachmentLinks(file, accountId) {
    return `<div class="productivity-actions attachment-file-links"><a class="attachment-preview-link" href="${esc(mailboxResourceUrl(`/api/emails/${Number(file.email_id)}/attachments/${Number(file.index ?? file.attachment_index)}`,accountId))}" download="${esc(file.name)}">${attachmentUiIcon('preview')}<span><span data-i18n="ui.d1cd84df295b">预览原文件</span></span></a><button type="button" data-file-source-email="${Number(file.email_id)}">${attachmentUiIcon('mail')}<span><span data-i18n="ui.afa0010e45c4">查看来源邮件</span></span></button></div>`;
  }
  function bindAttachmentSources(host, accountId) {
    host.addEventListener('click', async event => {
      const node = event.target.closest('[data-file-source-email]');
      if (!node) return;
      const id = Number(node.dataset.fileSourceEmail);
      dialog.close(); closeAttachmentCenter();
      try {
        if (accountId !== owner()) await openAccountMailbox(accountId,'inbox');
        await revealEmailFromSource(id);
      } catch(error) { toast(mailaiText('来源邮件打开失败：')+mailaiSystemMessage(error.message),'error'); }
    });
  }
  function attachmentActions(accountId, file) {
    open(mailaiText('附件操作'), `<div class="attachment-selected-file">${attachmentFileHeading(file)}<p class="attachment-hit-meta">${esc(fmtDate(file.date))}${file.from_addr?' · '+esc(file.from_addr):''}</p>${attachmentLinks(file,accountId)}</div><div class="attachment-action-list"><button type="button" data-file-find><span class="attachment-action-symbol">${attachmentUiIcon('search')}</span><span><strong><span data-i18n="ui.08a51a188bc7">搜索文件内容</span></strong><small><span data-i18n="ui.941e61049cd3">输入关键词，定位这份附件里的文字</span></small></span>${attachmentUiIcon('arrow')}</button><button type="button" data-file-check><span class="attachment-action-symbol">${attachmentUiIcon('files')}</span><span><strong><span data-i18n="ui.ecdca7b5264f">核对同名附件</span></strong><small><span data-i18n="ui.6441ef459cbe">查看来源，按需比较两份文件的文字</span></small></span>${attachmentUiIcon('arrow')}</button></div>`,accountId);
    dialog.dataset.panel='attachment-actions';
    bindAttachmentSources(dialog.querySelector('.productivity-body'),accountId);
    dialog.querySelector('[data-file-find]').onclick=()=>attachments(accountId,file);
    dialog.querySelector('[data-file-check]').onclick=()=>compareAttachmentCandidates(accountId,file);
  }
  async function attachments(accountId = owner(), seed = null) {
    const rev = open(mailaiText('搜索附件内容'), `<div class="attachment-search-intro"><h3><span data-i18n="ui.c4a8db295bff">凭内容，找到那份附件</span></h3><p><span data-i18n="ui.8396ce912159">输入关键词，直接查看文件里的匹配片段。</span></p><span class="attachment-local-badge"><i aria-hidden="true"></i><span data-i18n="ui.223744415c96">本机搜索 · 不上传 AI</span></span></div><form data-file-search><div class="productivity-search-line attachment-query-bar"><span class="attachment-query-input">${attachmentUiIcon('search')}<input data-file-query maxlength="200" aria-label="文件内容关键词" placeholder="搜索合同编号、项目名称或一段文字" required data-i18n-placeholder="ui.fafe4c89f048" data-i18n-aria="ui.261b9d1ff7ce"></span><button type="submit" class="primary-action" disabled><span data-i18n="ui.cfda3c271079">搜索附件</span></button></div><div class="attachment-search-controls"><label><span data-i18n="ui.4e65d015121f">搜索范围</span><select data-file-scope><option value="all" data-i18n="ui.4f99ac956545">当前邮箱的附件</option><option value="one" data-i18n="ui.0254598078f5">指定一份附件</option></select></label><label data-file-picker hidden><span data-i18n="ui.8d29fb0c5772">选择附件</span><select data-file-choice aria-label="选择邮件附件" data-i18n-aria="ui.27bc8c96e6c0"><option data-i18n="ui.5a2c0bbe70ca" value="正在读取附件…">正在读取附件…</option></select></label></div></form><p class="productivity-hint attachment-scope-hint" data-file-source></p><div class="attachment-search-progress" data-file-progress hidden><div><strong data-file-status role="status" aria-live="polite"></strong><button type="button" data-file-stop><span data-i18n="ui.502494276bd9">停止搜索</span></button></div><progress data-file-meter aria-label="附件搜索进度" max="1" value="0" data-i18n-aria="ui.2c97d687e642"></progress><p class="productivity-hint" data-file-current></p></div><div class="attachment-result-heading" data-file-result-heading hidden><h3><span data-i18n="ui.fbbaa5b431b6">匹配附件</span></h3><span data-file-hitcount></span></div><div data-file-results aria-live="polite"></div><div data-file-unread></div><details class="productivity-help attachment-search-help"><summary><span data-i18n="ui.cca888cce2e8">支持的文件与搜索范围</span></summary><p><span data-i18n="ui.2b6d3320e661">支持 PDF、Word（DOCX）、Excel（XLS/XLSX）、PowerPoint（PPTX）、TXT、CSV、MD，每份附件最大 10 MB。图片和扫描件暂不支持文字识别。较长文件只搜索已提取的部分，结果会标注读取范围。成功提取的文字会缓存在本机，加快后续搜索；附件内容变化后会重新读取。</span></p></details>`,accountId);
    dialog.dataset.panel='attachments';
    const currentDialog=dialog, choice=dialog.querySelector('[data-file-choice]'), scope=dialog.querySelector('[data-file-scope]'), queryInput=dialog.querySelector('[data-file-query]'), submit=dialog.querySelector('[type=submit]'), results=dialog.querySelector('[data-file-results]'), unread=dialog.querySelector('[data-file-unread]');
    const searchEmpty=()=>`<div class="attachment-search-empty"><span>${attachmentUiIcon('search')}</span><strong><span data-i18n="ui.8a18aa905cba">不记得文件名？试试文件里的文字</span></strong><p><span data-i18n="ui.a600c40446ad">例如合同编号、项目名称、客户名称。搜索结果可直接预览，并定位到来源邮件。</span></p><div class="attachment-example-queries"><button type="button" data-file-example="合同编号"><span data-i18n="ui.38f08532f33d">合同编号</span></button><button type="button" data-file-example="交货日期"><span data-i18n="ui.baa39a8e6fc5">交货日期</span></button><button type="button" data-file-example="报销金额"><span data-i18n="ui.7770e45daf1a">报销金额</span></button></div></div>`;
    results.innerHTML=searchEmpty();
    results.addEventListener('click',event=>{
      const node=event.target.closest('[data-file-example]');
      if (!node || queryInput.disabled) return;
      queryInput.value=node.dataset.fileExample; queryInput.dispatchEvent(new Event('input')); queryInput.focus();
    });
    let files=[], initialOffset=0, hasMore=false, searchRevision=0, run=null;
    const controller=new AbortController();
    const closeSearch=()=>{ ++searchRevision; controller.abort(); };
    currentDialog.addEventListener('close',closeSearch,{once:true});
    bindAttachmentSources(results,accountId); bindAttachmentSources(unread,accountId);
    const active=epoch=>live(rev) && epoch===searchRevision;
    const updateScope=()=>{
      dialog.querySelector('[data-file-picker]').hidden=scope.value!=='one';
      const file=files[Number(choice.value)];
      mailaiBindUI(dialog.querySelector('[data-file-source]'), "textContent", () => (scope.value==='one' && file ? fmtDate(file.date)+' · '+(file.subject || mailaiText('无主题')) : mailaiText('按邮件时间从近到远搜索；图片及不支持的格式会跳过。')));
    };
    const reset=()=>{ ++searchRevision; run=null; results.innerHTML=searchEmpty(); unread.replaceChildren(); dialog.querySelector('[data-file-progress]').hidden=true; dialog.querySelector('[data-file-result-heading]').hidden=true; mailaiBindUI(submit, "textContent", () => (mailaiText('搜索附件'))); msg(''); };
    scope.onchange=()=>{reset();updateScope();}; choice.onchange=()=>{reset();updateScope();}; queryInput.oninput=reset;
    dialog.querySelector('[data-file-stop]').onclick=event=>{
      if (!run) return; run.stop=true; event.currentTarget.disabled=true;
      mailaiBindUI(dialog.querySelector('[data-file-status]'), "textContent", () => (mailaiText('正在停止，当前文件读取结束后保留结果…')));
    };
    const highlighted=(value,query)=>{
      const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
      let out='',offset=0;
      for (const match of value.matchAll(pattern)) { out+=esc(value.slice(offset,match.index))+'<mark>'+esc(match[0])+'</mark>'; offset=match.index+match[0].length; }
      return out+esc(value.slice(offset));
    };
    const paintProgress=(finished=false)=>{
      const node=dialog.querySelector('[data-file-status]'), meter=dialog.querySelector('[data-file-meter]');
      meter.max=Math.max(1,run.queue.length); meter.value=run.next;
      dialog.querySelector('[data-file-progress]').dataset.state=finished?(run.stop?'paused':'completed'):'running';
      dialog.querySelector('[data-file-result-heading]').hidden=!run.matches;
      mailaiBindUI(dialog.querySelector('[data-file-hitcount]'), "textContent", () => (mailaiTemplate`${run.matches} 份文件`));
      mailaiBindUI(node, "textContent", () => (mailaiTemplate`${finished ? (run.stop ? mailaiText('已停止') : mailaiText('搜索结束')) : mailaiText('正在搜索')} · 已检查 ${run.next}/${run.queue.length}${run.more?' +':''} 个附件 · 命中 ${run.matches} 份`));
    };
    dialog.querySelector('[data-file-search]').onsubmit=async event=>{
      event.preventDefault(); if (submit.disabled) return;
      const query=queryInput.value.trim(); if (!query) return msg(mailaiText('请输入要查找的文字'),true);
      if (!run || run.query!==query) {
        results.replaceChildren(); unread.replaceChildren();
        run={query, queue:scope.value==='one'?[files[Number(choice.value)]]:files.slice(0,initialOffset), next:0, more:scope.value==='all' && hasMore, offset:initialOffset, matches:0, skipped:0, partial:0, failures:[],stop:false};
      }
      results.querySelector('.productivity-empty')?.remove(); unread.replaceChildren();
      const epoch=++searchRevision, stop=dialog.querySelector('[data-file-stop]'); run.stop=false;
      submit.disabled=true; mailaiBindUI(submit, "textContent", () => (mailaiText('正在搜索…'))); submit.setAttribute('aria-busy','true'); submit.classList.add('motion-working'); queryInput.disabled=true; scope.disabled=true; choice.disabled=true; stop.hidden=false; stop.disabled=false;
      dialog.querySelector('[data-file-progress]').hidden=false; results.setAttribute('aria-busy','true'); paintProgress();
      let failedListing=false;
      try {
        while (active(epoch) && !run.stop) {
          if (run.next>=run.queue.length) {
            if (!run.more) break;
            mailaiBindUI(dialog.querySelector('[data-file-current]'), "textContent", () => (mailaiText('正在读取下一批附件…')));
            const batch=await api(`/api/attachments?limit=301&offset=${run.offset}`,{accountId,signal:controller.signal});
            if (!active(epoch)) return;
            run.more=batch.length>300; const next=batch.slice(0,300); run.offset+=next.length; const seen=new Set(run.queue.map(attachmentRef)); run.queue.push(...next.filter(file=>!seen.has(attachmentRef(file)))); paintProgress();
            if (!next.length) break;
            if (run.stop) break;
            if (run.next>=run.queue.length) continue;
          }
          const file=run.queue[run.next];
          mailaiBindUI(dialog.querySelector('[data-file-current]'), "textContent", () => (mailaiText('当前文件：')+file.name));
          if (!searchableAttachment(file)) {run.skipped++;run.next++;paintProgress();continue;}
          try {
            const result=await api(`/api/productivity/attachments/${file.email_id}/${file.index}/search`,{accountId,signal:controller.signal,...json({query})});
            if (!active(epoch)) return;
            if (result.limited) run.partial++;
            if (result.excerpts.length) {
              run.matches++;
              const card=document.createElement('article'); card.className='attachment-content-hit';
              const quotes=result.excerpts.map(value=>`<blockquote class="productivity-source-quote">${highlighted(value,query)}</blockquote>`);
              card.innerHTML=`${attachmentFileHeading(file,`<span class="attachment-match-badge"><span data-i18n="ui.4cec48854797">${result.excerpts.length}${result.more?' +':''} 处匹配</span></span>`)}<p class="attachment-hit-meta">${esc(fmtDate(file.date))}${file.from_addr?' · '+esc(file.from_addr):''}</p><div class="attachment-hit-excerpts">${quotes.slice(0,2).join('')}${quotes.length>2?`<details class="attachment-more-excerpts"><summary><span data-i18n="ui.d591673bcb55">展开另外 ${quotes.length-2} 处匹配</span></summary>${quotes.slice(2).join('')}</details>`:''}</div><div class="attachment-hit-footer">${attachmentLinks(file,accountId)}<details class="productivity-help attachment-read-scope"><summary>${result.limited?mailaiText('读取范围受限'):mailaiText('读取范围')}</summary><p>${esc(result.note)}</p></details></div>`;
              results.append(card); window.mailaiMotion.reveal(card);
            }
          } catch(error) {
            if (!active(epoch)) return;
            run.failures.push({file,error:error.message});
          }
          run.next++; paintProgress();
        }
      } catch(error) {
        if (!active(epoch)) return;
        failedListing=true; run.stop=true; msg(mailaiText('下一批附件读取失败，已有结果已保留：')+mailaiSystemMessage(error.message),true);
      } finally {
        if (active(epoch)) {
          results.removeAttribute('aria-busy'); paintProgress(true); stop.hidden=true;
          mailaiBindUI(dialog.querySelector('[data-file-current]'), "textContent", () => ([run.skipped?mailaiTemplate`跳过 ${run.skipped} 份（格式不支持或超过 10 MB）`:'',run.failures.length?mailaiTemplate`未读取 ${run.failures.length} 份`:'',run.partial?mailaiTemplate`读取范围受限 ${run.partial} 份`:''].filter(Boolean).join(' · ')));
          unread.innerHTML=run.failures.length ? `<details class="productivity-help"><summary><span data-i18n="ui.391b2df28fbb">${run.failures.length} 份附件未能搜索，查看原因</span></summary>${run.failures.map(({file,error})=>`<article class="attachment-content-hit"><strong>${esc(file.name)}</strong><p>${esc(error)}</p>${attachmentLinks(file,accountId)}</article>`).join('')}</details>`:'';
          const unfinished=run.next<run.queue.length || run.more;
          if (!run.matches) results.innerHTML=`<div class="productivity-empty"><strong>${unfinished?mailaiText('已检查的附件中暂无匹配'):mailaiText('已读取的文字中没有找到匹配')}</strong><p>${unfinished?mailaiText('可以继续搜索剩余附件。'):mailaiText('可尝试更短的关键词；未读取或截断的内容不在本次结果中。')}</p></div>`;
          if (!failedListing) msg(unfinished?mailaiText('搜索已停止，点击继续可保留已有结果并搜索剩余附件。'):mailaiText('搜索结束。结果覆盖本次成功读取的文字；图片、未读取和截断内容未搜索。'));
          submit.removeAttribute('aria-busy'); submit.classList.remove('motion-working'); mailaiBindUI(submit, "textContent", () => (unfinished?mailaiText('继续搜索'):mailaiText('重新搜索')));
          if (!unfinished) run=null;
          submit.disabled=false; queryInput.disabled=false; scope.disabled=false; choice.disabled=!files.length;
        }
      }
    };
    try {
      const rows=await api('/api/attachments?limit=301',{accountId,signal:controller.signal});
      if (!live(rev)) return;
      hasMore=rows.length>300; files=rows.slice(0,300); initialOffset=files.length;
      if (seed && !files.some(file=>attachmentRef(file)===attachmentRef(seed))) {
        // Keep a selected historical file available without changing pagination.
        files.push(seed);
      }
      choice.innerHTML=files.length ? files.map((file,i)=>`<option value="${i}">${esc(file.name)} · ${esc(fmtDate(file.date))}</option>`).join(''):"<option data-i18n=\"ui.c51105fd1a93\" value=\"没有附件\">没有附件</option>";
      if (seed) {scope.value='one';choice.value=String(files.findIndex(file=>attachmentRef(file)===attachmentRef(seed)));}
      submit.disabled=!files.length; choice.disabled=!files.length; updateScope();
      if (!files.length) msg(mailaiText('当前邮箱还没有本地附件，请先同步邮件。'));
    } catch(error) {if(live(rev)) msg(mailaiText('附件列表读取失败，请关闭后重试：')+mailaiSystemMessage(error.message),true);}
  }
  async function compareAttachmentCandidates(accountId,file) {
    const rev=open(mailaiText('核对同名附件'),`<p class="productivity-lead">${esc(file.name)}</p><p class="productivity-hint"><span data-i18n="ui.74e3b3b1b04e">下面是同名文件候选，不一定属于同一材料。请根据来源邮件核对，再选择两份查看文字差异。</span></p><div data-file-versions aria-live="polite"><span data-i18n="ui.0bc74213dba1">正在查找同名附件…</span></div>`,accountId);
    dialog.dataset.panel='attachment-compare';
    const host=dialog.querySelector('[data-file-versions]'), finish=window.mailaiMotion.pending(host);
    bindAttachmentSources(host,accountId);
    try {
      const result=await api('/api/productivity/attachments/versions?name='+encodeURIComponent(file.name),{accountId});
      if (!live(rev)) return;
      const items=result.items.map(item=>({...item,index:Number(item.attachment_index),name:file.name}));
      if (items.length<2) {host.innerHTML=`<div class="productivity-empty"><strong><span data-i18n="ui.8a9ad8f9ddcf">没有其他同名附件</span></strong><p><span data-i18n="ui.50c0585d008b">可以预览原文件，或返回附件中心查找其他文件。</span></p></div>${attachmentLinks(file,accountId)}`;return;}
      const options=items.map((item,i)=>`<option value="${i}">${esc(fmtDate(item.date))} · ${esc(item.subject || mailaiText('无主题'))}</option>`).join('');
      host.innerHTML=`<div class="productivity-grid"><label><span data-i18n="ui.9ac6d364aa41">文件 A</span><select data-compare-before>${options}</select><span data-compare-source-a></span></label><label><span data-i18n="ui.aba8f0d0e319">文件 B</span><select data-compare-after>${options}</select><span data-compare-source-b></span></label></div><label class="productivity-check-row"><input type="checkbox" data-compare-confirm><span><span data-i18n="ui.89708cbd8fc2">我已核对来源，这两份文件属于同一材料</span><small><span data-i18n="ui.f30dcd2ace31">不同月份的报表或不同项目的同名附件，差异通常不代表修订。</span></small></span></label><button type="button" data-compare-run class="primary-action" disabled><span data-i18n="ui.491269b3ec34">查看文字差异</span></button><p class="productivity-hint"><span data-i18n="ui.0b8d69225e8d">仅比较可提取的文字。不会判断哪份有效，也不汇总金额；Excel 不重算公式。</span></p><div data-compare-summary role="status"></div><div class="productivity-diff" data-compare-output hidden></div><details class="productivity-help" data-compare-notes hidden><summary><span data-i18n="ui.bdbace2402dc">查看两份文件的读取范围</span></summary><div></div></details>`;
      const before=host.querySelector('[data-compare-before]'), after=host.querySelector('[data-compare-after]'), confirm=host.querySelector('[data-compare-confirm]'), button=host.querySelector('[data-compare-run]');
      const current=items.findIndex(item=>attachmentRef(item)===attachmentRef(file));
      before.value=String(current<0?0:current); after.value=String(before.value==='0'?1:0);
      let epoch=0, working=false;
      const update=()=>{++epoch;confirm.checked=false;host.querySelector('[data-compare-summary]').replaceChildren();host.querySelector('[data-compare-output]').hidden=true;host.querySelector('[data-compare-notes]').hidden=true;msg('');
        host.querySelector('[data-compare-source-a]').innerHTML=attachmentLinks(items[Number(before.value)],accountId);
        host.querySelector('[data-compare-source-b]').innerHTML=attachmentLinks(items[Number(after.value)],accountId);
        button.disabled=true;
      };
      before.onchange=update;after.onchange=update;confirm.onchange=()=>{button.disabled=working || !confirm.checked || before.value===after.value;};update();
      button.onclick=async()=>{
        if (button.disabled) return;
        const requestEpoch=epoch; working=true;button.disabled=true;mailaiBindUI(button, "textContent", () => (mailaiText('正在读取并比较…')));button.setAttribute('aria-busy','true');
        try {
          const data=await api('/api/productivity/attachments/compare',{accountId,...json({items:[items[Number(before.value)],items[Number(after.value)]].map(item=>({email_id:item.email_id,index:item.index}))})});
          if (!live(rev) || requestEpoch!==epoch) return;
          const title=data.identical?mailaiText('两份文件的内容完全相同'):data.text_equal?(data.limited?mailaiText('已读取的部分文字相同，未读取内容尚未核对'):mailaiText('可提取的文字相同，格式和图片尚未核对')):mailaiTemplate`${data.limited?mailaiText('部分文字'):mailaiText('文字')}有差异${data.diff_truncated?mailaiText('（仅显示前 200 行）'):''}`;
          host.querySelector('[data-compare-summary]').innerHTML=`<div class="attachment-comparison-summary" data-state="${data.identical?'identical':data.limited?'partial':'text'}"><span class="attachment-comparison-kicker">${data.identical?mailaiText('完整文件核对'):mailaiText('文字核对结果')}</span><strong>${esc(title)}</strong><p>${data.identical?mailaiText('文件字节一致，无需重复下载。'):esc(data.scope)}</p></div>`;
          const output=host.querySelector('[data-compare-output]');output.hidden=!data.diff;
          output.innerHTML=(data.diff || '').split('\n').filter(line=>!line.startsWith('---')&&!line.startsWith('+++')&&!line.startsWith('@@')).map(line=>`<div class="${line.startsWith('+')?'added':line.startsWith('-')?'removed':'context'}"><small>${line.startsWith('+')?mailaiText('文件 B'):line.startsWith('-')?mailaiText('文件 A'):mailaiText('相同')}</small><span>${esc(line.slice(1))}</span></div>`).join('');
          const notes=host.querySelector('[data-compare-notes]');notes.hidden=false;notes.querySelector('div').innerHTML=data.notes.map((note,i)=>`<p><strong><span data-i18n="ui.e9b5058c6501">文件 ${i?'B':'A'}</span></strong>：${esc(note)}</p>`).join('');
          window.mailaiMotion.reveal(host.querySelector('[data-compare-summary]'));
        } catch(error) {if(live(rev) && requestEpoch===epoch) msg(mailaiText('比较未完成：')+mailaiSystemMessage(error.message),true);}
        finally {working=false;if(button.isConnected){button.removeAttribute('aria-busy');mailaiBindUI(button, "textContent", () => (mailaiText('查看文字差异')));button.disabled=!confirm.checked || before.value===after.value;}}
      };
    } catch(error) {if(live(rev)) mailaiBindUI(host, "textContent", () => (mailaiText('同名附件读取失败：')+mailaiSystemMessage(error.message)));}
    finally {finish();}
  }
  async function shares(accountId = owner()) {
    const rev = open(
      mailaiText("已分享文件"),
      `<p class="productivity-lead"><span data-i18n="ui.e1dca25800f9">管理邮件里的大文件下载链接</span></p><p class="productivity-hint"><span data-i18n="ui.cfc2ef87342c">大文件上传到你配置的腾讯云存储，再把下载链接插入邮件。这里只显示已上传文件，普通邮件附件不会自动出现在这里。</span></p><div class="productivity-actions">${button(mailaiText("写邮件并添加大文件"), "new-share")}</div><div data-share-links></div><details class="productivity-help"><summary><span data-i18n="ui.3b3f784aab6a">链接到期后会怎样？</span></summary><p><span data-i18n="ui.a1a70a4996cb">收件人将无法使用已到期的链接。重新生成后，需要把新链接发给收件人；旧邮件不会自动更新。上传的文件仍在你的存储桶内。</span></p></details>`,
      accountId,
    );
    dialog.dataset.panel = 'shares';
    const account = dialogAccount;
    dialog.querySelector('[data-productivity-action="new-share"]').onclick = event => busy(event.currentTarget,async()=>{ dialog.close(); closeAttachmentCenter(); const opened=await openCompose({account_id:account}); if (opened !== false && composeAccountId === account) await openShareLinkDialog(); });
    try {
      const items = await panelRequest(rev, mailaiText("正在读取分享链接…"), "/api/productivity/shares/list", {
        accountId: account,
      });
      if (!live(rev)) return;
      const host = dialog.querySelector("[data-share-links]");
      host.innerHTML =
        items
          .map(
            (r, i) =>
              `<div class="productivity-source-quote"><strong>${esc(r.name)}</strong><p>${new Date(r.expires_at) <= new Date() ? mailaiText("已过期") : mailaiText("有效至")} ${esc(new Date(r.expires_at).toLocaleString(currentI18nLanguage()))}</p><div class="productivity-actions"><button type="button" data-share-copy="${i}" ${new Date(r.expires_at) <= new Date() ? "disabled" : ""}><span data-i18n="ui.b525d731a0db">复制下载链接</span></button><button type="button" data-share-renew="${i}"><span data-i18n="ui.6f086b9c567d">生成新链接 · 7 天</span></button></div></div>`,
          )
          .join("") || "<div class=\"productivity-empty\"><strong><span data-i18n=\"ui.84c0b545d3df\">还没有分享过大文件</span></strong><p><span data-i18n=\"ui.23d319d141ab\">点击上方按钮，在写信时选择文件、设置有效期，上传后将下载链接插入正文。首次使用需要连接你自己的腾讯云存储；也可把已有网盘链接直接粘贴进邮件。</span></p></div>";
      host.querySelectorAll("[data-share-copy]").forEach(
        (n) =>
          (n.onclick = () =>
            busy(n, async () => {
              await navigator.clipboard.writeText(
                items[Number(n.dataset.shareCopy)].url,
              );
              if (live(rev)) msg(mailaiText("链接已复制"));
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
              mailaiBindUI(card.querySelector('p'), "textContent", () => (mailaiText('有效至 ')+new Date(items[i].expires_at).toLocaleString(currentI18nLanguage())));
              card.querySelector('[data-share-copy]').disabled=false;
              msg(mailaiText("链接已重新生成，请复制后重新分享；旧邮件中的链接不变"));
            })),
      );
    } catch (error) {
      live(rev) && msg(mailaiSystemMessage(error.message), true);
    }
  }
  async function followups(account = owner()) {
    const
      rev = open(
        mailaiText("等待回复与跟进"),
        `<p class="productivity-hint"><span data-i18n="ui.bcd020da6793">写信的“发送安排”中可设置未回复提醒。仅对成功发送的邮件计时；同步到关联回复后取消提醒。未同步的回复无法判断，不会自动发送催办邮件。</span></p><div data-followup-list></div>`,
        account,
      );
    try {
      const items = await panelRequest(rev, mailaiText("正在读取跟进记录…"), "/api/productivity/followups/list", {
        accountId: account,
      });
      if (!live(rev)) return;
      const host = dialog.querySelector("[data-followup-list]");
      host.innerHTML =
        items
          .map(
            (row, i) =>
              `<div class="productivity-source-quote"><strong>${esc(row.subject || mailaiText("无主题"))}</strong><p>${esc(row.to_addr || "")}</p><small>${esc({ scheduled: row.sent ? mailaiText("已提交提醒") : mailaiText("等待回复"), get replied() { return mailaiText("已同步到回复"); }, get canceled() { return mailaiText("已取消"); } }[row.state] || row.state)} · ${esc(row.at.replace("T", " "))}</small><div class="productivity-actions"><button type="button" data-followup-open="${i}"><span data-i18n="ui.c259135be1d3">查看已发送邮件</span></button>${row.state === "scheduled" ? `<input type="datetime-local" data-followup-at="${i}" value="${esc(row.at.slice(0, 16))}" aria-label="新的跟进时间" data-i18n-aria="ui.6da097eb22f3"><button type="button" data-followup-save="${i}"><span data-i18n="ui.fd094431c8ca">调整时间</span></button><button type="button" data-followup-cancel="${i}"><span data-i18n="ui.f3b07169f705">取消提醒</span></button>` : ""}</div></div>`,
          )
          .join("") ||
        mailaiText("没有发信跟进记录。请在写信的“发送安排”中设置未回复提醒。");
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
      live(rev) && msg(mailaiSystemMessage(error.message), true);
    }
  }
  async function scheduled() { openTaskCenter(); }
  async function scheduleTime(token, account) {
    const rev = open(mailaiText("调整发送时间"), "<label><span data-i18n=\"ui.4e12454a1dd1\">计划发送时间</span><input type=\"datetime-local\" data-outbox-time></label><p class=\"productivity-hint\"><span data-i18n=\"ui.15c8e0a5b893\">电脑联网且 MailAI 运行时执行；退出期间无法准时发送。调整时间不会修改邮件内容。</span></p><div class=\"productivity-actions\"><button type=\"button\" data-save-time class=\"primary-action\"><span data-i18n=\"ui.f0f609f1e296\">保存时间</span></button></div>", account);
    try {
      const rows = await panelRequest(rev, mailaiText("正在读取发送安排…"), "/api/mail/outbox", {accountId:account});
      if (!live(rev)) return;
      const row = rows.find(r => r.token === token);
      if (!row || row.status !== 'queued') throw Error(mailaiText('任务已开始发送或已结束，不能修改时间'));
      dialog.querySelector('[data-outbox-time]').value = row.due_at?.slice(0,16) || '';
      dialog.querySelector('[data-save-time]').onclick = event => busy(event.currentTarget, async () => {
        await api(`/api/mail/outbox/${encodeURIComponent(token)}/schedule`, {accountId:account, method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({at:dialog.querySelector('[data-outbox-time]').value})});
        if (live(rev)) { dialog.close(); toast(mailaiText('发送时间已修改'), 'success'); refreshTaskCenter(); }
      });
    } catch(error) { if (live(rev)) msg(mailaiSystemMessage(error.message),true); }
  }
  async function calendar(account = owner()) {
    const email = account === owner() && selectedEmailDetail ? selectedEmailDetail : { id: 0, subject: "" };
    const rev = open(
      mailaiText("会议安排"),
      `<label><span data-i18n="ui.961ddaf780e3">导入 ICS 日历文件</span><input id="productivity-calendar-file" type="file" accept=".ics,text/calendar"></label><div id="productivity-invitations"></div><p><span data-i18n="ui.5c56bfb6da4b">核对后创建日历事件：</span></p><div class="productivity-grid"><label class="wide"><span data-i18n="ui.c3405f8c7d9d">标题</span><input id="productivity-event-title"></label><label><span data-i18n="ui.1b1b03a8147d">开始时间（本地）</span><input type="datetime-local" id="productivity-event-start"></label><label><span data-i18n="ui.7a5c755878e3">结束时间（本地）</span><input type="datetime-local" id="productivity-event-end"></label><label class="wide"><span data-i18n="ui.253ac66fb8e1">地点</span><input id="productivity-event-location"></label></div><div class="productivity-actions">${button(mailaiText("导出日历事件"), "export-event", 'class="primary-action"')}</div><p class="productivity-hint"><span data-i18n="ui.21e07454f9db">导入文件只预览邀请；可下载原始 ICS 导入系统日历。接受/拒绝需核对并发送日历回复，对方服务可能不自动更新。手动创建的日期由你核对填写。</span></p>`,
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
              `<div class="productivity-source-quote"><strong>${esc(r.title)}</strong><p>${esc(r.dtstart)} ${esc(r.dtstart_tzid || "")} — ${esc(r.dtend || "")} · ${esc(r.location || "")}</p><small>${esc(r.time_note)}</small>${fromMail && r.uid ? `<button data-event-response="${i}" data-response="accepted"><span data-i18n="ui.2825997ff294">接受并起草回复</span></button> <button data-event-response="${i}" data-response="declined"><span data-i18n="ui.724c0db4409a">拒绝并起草回复</span></button>` : ""}</div>`,
          )
          .join("") ||
        "<p class=\"productivity-hint\"><span data-i18n=\"ui.202d91087108\">没有 ICS 邀请，可导入文件或手动安排事件。</span></p>";
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
        ? await panelRequest(rev, mailaiText("正在读取会议邀请…"), `/api/productivity/calendar/${email.id}`, {
            accountId: account,
          })
        : { items: [] };
      if (!live(rev)) return;
      show(result.items);
    } catch (error) {
      live(rev) && msg(mailaiSystemMessage(error.message), true);
    }
    dialog.querySelector("#productivity-calendar-file").onchange = async (
      event,
    ) => {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 500000) return msg(mailaiText("日历文件不能超过 500 KB"), true);
      try {
        const result = await panelRequest(rev, mailaiText("正在解析日历文件…"), "/api/productivity/calendar/import", {
          accountId: account,
          ...json({ text: await file.text() }),
        });
        if (live(rev)) {
          show(result.items, false);
          msg(mailaiTemplate`已预览 ${result.items.length} 项邀请；时间与时区保留原文件。`);
        }
      } catch (error) {
        live(rev) && msg(mailaiSystemMessage(error.message), true);
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
            throw Error((await response.json()).detail || mailaiText("导出失败"));
          download(await response.blob(), "meeting.ics", "text/calendar");
          msg(mailaiText("日历文件已导出，请在系统日历中核对后导入"));
        });
  }
  async function evidence() {
    const email = selectedEmailDetail;
    if (!email) return;
    const rev = open(
      mailaiText("跨邮件核对"),
      `<p class="productivity-hint"><span data-i18n="ui.e24dc0e8d944">并列核对同一会话的明确日期与金额。不同事项和报价口径可能不同，片段不能代替最终确认。</span></p><div class="productivity-actions">${button(mailaiText("用 AI 对照日期金额与承诺"), "semantic-evidence")}</div><p class="productivity-hint"><span data-i18n="ui.675b05844efa">AI 核对会将最多 12 封关联往来的正文发送给已配置模型，可能产生 API 用量；附件不包含在本次参考中。</span></p><div data-semantic-evidence></div><div data-evidence></div>`,
    );
    const account = dialogAccount;
    dialog.querySelector(
      '[data-productivity-action="semantic-evidence"]',
    ).onclick = (event) =>
      busy(event.currentTarget, async () => {
        msg(mailaiText("正在对照会话原文…"));
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
                `<div class="productivity-source-quote"><small><span data-i18n="ui.a5d301efb09c">AI 变化候选 · 待核对</span></small><strong>${esc(item.label)}</strong><p>${esc(item.before)} → ${esc(item.after)}</p><p><span data-i18n="ui.b16f75061304">原文：${esc(item.before_quote)}</span></p><small>${esc(item.before_source.sender)} · ${esc(item.before_source.date)}</small><p><span data-i18n="ui.1dc8a50a18d6">新原文：${esc(item.after_quote)}</span></p><small>${esc(item.after_source.sender)} · ${esc(item.after_source.date)}</small><p>${esc(item.note)}</p>${item.before_source.risky || item.after_source.risky ? "<p class=\"productivity-error\"><span data-i18n=\"ui.5e5437735a6b\">其中邮件存在风险线索，请先核实来源。</span></p>" : ""}<div class="productivity-actions"><button type="button" data-semantic-source="${i}:before"><span data-i18n="ui.529d780dc923">查看原来源</span></button><button type="button" data-semantic-source="${i}:after"><span data-i18n="ui.da70a5b7c79a">查看新来源</span></button></div></div>`,
            )
            .join("") ||
          "<p><span data-i18n=\"ui.ac54a02394fe\">没有得到能在原文定位的变化候选；不能据此判定没有变化。</span></p>";
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
              ? mailaiText(" 已过滤 ") + result.rejected + mailaiText(" 项无法核验的输出。")
              : "") +
            (result.limited ? mailaiText(" 会话较长，本次参考不完整。") : ""),
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
              `<div class="productivity-source-quote"><small><span data-i18n="ui.69db9adc92f4">${esc(item.date || "")} · ${item.kind === "date" ? mailaiText("日期") : mailaiText("金额")} · 待核对</span></small><strong>${esc(item.value)}</strong><p>${esc(item.quote)}</p><button type="button" data-evidence-source="${i}"><span data-i18n="ui.afa0010e45c4">查看来源邮件</span></button></div>`,
          )
          .join("") ||
        mailaiText("未提取到明确可对照的日期或金额。没有提示不代表不存在变化。");
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
      live(rev) && msg(mailaiSystemMessage(error.message), true);
    }
  }
  function focusDialog() {
    const email = selectedEmailDetail;
    if (!email) return;
    const rev = open(
      mailaiText("调整重要程度"),
      `<p><span data-i18n="ui.396c6be93bc6">这封邮件应放在哪个视图？</span></p><div class="productivity-actions">${button(mailaiText("重点邮件"), "focus")}${button(mailaiText("其他邮件"), "other")}${button(mailaiText("恢复自动判断"), "auto")}</div><label><span><input type="checkbox" id="productivity-focus-sender"> <span data-i18n="ui.195522d4d65e">同时应用于该发件人的后续邮件</span></span></label>`,
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
              toast(mailaiText("重要程度已更新"), "success");
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
    tools.innerHTML = `${button(mailaiText("最小化"), "minimize", 'class="productivity-compose-button"')}${button(mailaiText("展开"), "expand", 'class="productivity-compose-button" aria-pressed="false"')}`;
    header.querySelector("#btn-close-compose").before(tools);
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "productivity-resume-compose";
    mailaiBindUI(resume, "textContent", () => (mailaiText("继续写邮件")));
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
        mailaiBindUI(node, "textContent", () => (expanded ? mailaiText('还原') : mailaiText('展开')));
        node.setAttribute('aria-pressed',String(expanded));
        window.mailaiMotion.reveal(document.querySelector(".compose-card"));
      }
    };
    const toolbar = document.querySelector(".compose-toolbar-actions");
    const tpl = document.createElement("button");
    tpl.type = "button";
    tpl.className = "compose-tool-labeled";
    mailaiBindUI(tpl, "textContent", () => (mailaiText("模板")));
    tpl.onclick = templates;
    toolbar.prepend(tpl);
    const phrase = document.createElement("button");
    phrase.type = "button";
    phrase.className = "compose-tool-labeled";
    mailaiBindUI(phrase, "textContent", () => (mailaiText("短语")));
    phrase.onpointerdown = captureSnippetRange;
    phrase.onclick = snippets;
    tpl.after(phrase);
    const footer = document.querySelector(".compose-card>footer>div");
    const schedule = document.createElement("button");
    schedule.type = "button";
    schedule.className = "btn-ghost";
    mailaiBindUI(schedule, "textContent", () => (mailaiText("发送安排")));
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
      mailaiBindUI(schedule, "textContent", () => (input.value
        ? mailaiText("定时发送") +
          (Number(followDays.value) || followAt.value ? mailaiText(" · 跟进") : "")
        : Number(followDays.value) || followAt.value
          ? mailaiText("发送与跟进")
          : mailaiText("发送安排")));
      mailaiBindUI(schedule, "title", () => (mailaiText("定时发送与未回复提醒") +
        (input.value ? " · " + input.value.replace("T", " ") : "")));
    };
    schedule.onclick = () => {
      const session = draftSession,
        rev = open(
          mailaiText("发送安排"),
          `<div class="productivity-grid"><label><span data-i18n="ui.2a4d6dbccfa9">发送方式</span><select id="send-arrangement-mode"><option value="now" data-i18n="ui.5683dc19bd55">立即发送</option><option value="scheduled" data-i18n="ui.33e4b16591ac">定时发送</option></select></label><label data-send-time hidden><span data-i18n="ui.4e12454a1dd1">计划发送时间</span><input type="datetime-local" id="productivity-send-at"></label><label><span data-i18n="ui.6083893c9f74">未回复时提醒</span><select id="followup-choice"><option value="0" data-i18n="ui.0f207fc4c5e1">不提醒</option><option value="1" data-i18n="ui.b5cb6341c12e">成功发送后 1 天</option><option value="3" data-i18n="ui.6ac0268471f6">成功发送后 3 天</option><option value="7" data-i18n="ui.866887715c00">成功发送后 7 天</option><option value="custom" data-i18n="ui.e39b120b61c5">指定跟进时间</option></select></label><label data-followup-custom hidden><span data-i18n="ui.fb592eec3572">跟进时间</span><input type="datetime-local" id="followup-custom-at"></label></div><p class="productivity-hint"><span data-i18n="ui.1739e5c4b141">保存安排后，仍需点击写信窗口“发送”提交。定时发送和提醒需要电脑开机、联网且 MailAI 运行。跟进只在本机未同步到关联回复时提醒，不自动催办。</span></p><div class="productivity-actions">${button(mailaiText("保存安排"), "save-send-arrangement", 'class="primary-action"')}</div>`,
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
          return msg(mailaiText("写信窗口已变化，请重新安排"), true);
        const sendTime = mode.value === "scheduled" ? at.value : "",
          followTime = choice.value === "custom" ? follow.value : "";
        if (
          (sendTime && new Date(sendTime) <= new Date()) ||
          (mode.value === "scheduled" && !sendTime)
        )
          return msg(mailaiText("请选择将来的发送时间"), true);
        if (
          choice.value === "custom" &&
          (!followTime ||
            new Date(followTime) <= new Date() ||
            (sendTime && new Date(followTime) <= new Date(sendTime)))
        )
          return msg(mailaiText("跟进时间必须晚于当前时间与发送时间"), true);
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
      const expand=tools.querySelector('[data-productivity-action=expand]'); mailaiBindUI(expand, "textContent", () => (mailaiText('展开'))); expand.setAttribute('aria-pressed','false');
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
      const expand=tools.querySelector('[data-productivity-action=expand]'); mailaiBindUI(expand, "textContent", () => (mailaiText('展开'))); expand.setAttribute('aria-pressed','false');
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
    mailaiBindUI(polish, "textContent", () => (mailaiText("润色选中文字")));
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
      else toast(mailaiText('请先在正文中选中文字'),'warn');
    };
    toolbar.append(polish);
    const undoPolish=document.createElement('button'); undoPolish.type='button'; undoPolish.id='productivity-undo-polish'; undoPolish.className='compose-tool-labeled'; mailaiBindUI(undoPolish, "textContent", () => (mailaiText('撤销润色'))); undoPolish.hidden=true;
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
              `<button type="button" data-recipient-index="${i}" class="${getDomain(address) !== getDomain(_systemConfig?.accounts?.find((a) => a.id === composeAccountId)?.user || "") ? "external" : ""}" title="移除 ${esc(address)}" data-i18n-title="ui.761b55d45ed0">${esc(address)} ×</button>`,
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
        throw Error(mailaiText("请先填写并保存草稿"));
      const native = window.pywebview?.api?.open_compose_window;
      if (native) {
        const result = await native(session.id, account);
        if (!result?.ok)
          throw Error(result?.message || mailaiText("窗口未打开，草稿仍保留"));
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
          throw Error(mailaiText("浏览器阻止了窗口，请允许弹出窗口后重试；草稿仍保留"));
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
      mailaiText("润色选中文字"),
      `<div class="productivity-polish-columns"><section><h3><span data-i18n="ui.bc7d83a76fdd">选中的原文</span></h3><div class="productivity-selection-preview" data-original></div></section><section><h3><span data-i18n="ui.25fadc93aa20">润色建议</span></h3><div class="productivity-selection-preview" data-polished><span data-i18n="ui.a8b8730c9611">正在生成…</span></div></section></div><div class="productivity-actions">${button(mailaiText("应用到选中位置"), "apply-selection", 'disabled class="primary-action"')}</div><p class="productivity-hint"><span data-i18n="ui.43932ad4e13c">只将选中文字发送给已配置模型。原文未改变前可应用；不覆盖其他段落、附件、引用和签名。</span></p>`,
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
      if (typeof result.content !== 'string' || !result.content.trim()) throw Error(mailaiText('没有生成可用建议，请重试'));
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
          return msg(mailaiText("正文或发件账号已变化，请重新选择后润色"), true);
        const body = composeMessageElement(), before = composeAiEditSnapshot();
        dialog.close(); // A showModal dialog makes the editor inert until it closes.
        body.focus({preventScroll:true});
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('insertText',false,result.content)) {
          range.deleteContents(); const node=document.createTextNode(result.content); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
        }
        rememberComposeSelection(); clearComposePreflight();
        rememberComposeAiEdit(before,['body'],mailaiText('局部润色'));
        document.getElementById('productivity-undo-polish').hidden = false;
        body.dispatchEvent(new Event('input',{bubbles:true}));
        queueDraftSave(); refreshComposeAiContext();
        toast(mailaiText('已应用到选中位置，可撤销本次修改'),'success');
      };
    } catch (error) {
      if (live(rev)) {
        mailaiBindUI(preview, "textContent", () => (mailaiText("未生成建议，请关闭后重新选择文字重试。")));
        msg(mailaiText("生成未完成：") + mailaiSystemMessage(error.message), true);
      }
    } finally {
      finish();
    }
  }
  function palette() {
    const rev = open(
      mailaiText("快捷操作"),
      `<input id="productivity-command-query" placeholder="搜索操作，如 回复、附件、待办…" aria-label="搜索快捷操作" data-i18n-placeholder="ui.aa7c8eb8c806" data-i18n-aria="ui.717bfece6fe9"><div id="productivity-commands"></div><p class="productivity-hint"><span data-i18n="ui.f312768aaa2b">⌘ / Ctrl + K 打开 · J / K 下一封 / 上一封 · R 回复 · / 搜索。输入文字、弹窗和写信时不触发单键快捷操作。</span></p>`,
    );
    const commands = [
      [mailaiText("写邮件"), () => document.getElementById("btn-compose").click()],
      [mailaiText("高级搜索"), openSearch],
      [mailaiText("邮件模板"), templates],
      [mailaiText("附件中心"), () => document.getElementById("btn-attachments").click()],
      [mailaiText("待办"), () => document.getElementById("btn-todos").click()],
      [mailaiText("定时发送"), scheduled],
      [mailaiText("通讯录互导"), contacts],
      [mailaiText("同步邮件"), () => document.getElementById("btn-poll").click()],
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
        '#reading-content [data-mail-action="reply"]',
      );
      reply?.click();
    }
  });
  initControls();
  composeTools();
  document.getElementById('attachment-grid').addEventListener('click',event=>{
    const node=event.target.closest('[data-attachment-tools]'); if (!node) return;
    const file=attachmentItems.find(r=>r.email_id===Number(node.dataset.emailId) && Number(r.index)===Number(node.dataset.attachmentIndex));
    if (file) attachmentActions(attachmentCenterAccountId,file);
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
  window.mailaiOAuthDialog = () => window.mailaiMailLogin?.open();
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
        toast(mailaiText("无法打开草稿：") + mailaiSystemMessage(error.message), "error");
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
