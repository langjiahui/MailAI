import SwiftUI
import MailAICore
import Logging

@main struct MailAIApp: App {
    @State private var store: MailStore?
    @State private var startupError: String?
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("mail.appearance") private var appearance = "system"
    init() {
        LoggingSystem.bootstrap { _ in SwiftLogNoOpLogHandler() }
        BackgroundMail.shared.register()
        #if DEBUG
        if CommandLine.arguments.contains("--ui-storage-error") {
            _startupError = State(initialValue: "无法打开本地存储，请重试。现有数据会保留。")
            return
        }
        if CommandLine.arguments.contains("--ui-fixture") {
            do { _store = State(initialValue: try DebugPreview.store()) } catch { _startupError = State(initialValue: "界面验收数据不可用") }
            return
        }
        #endif
        do { _store = State(initialValue: MailStore(vault: KeychainVault(), files: try MailFiles(), service: NativeMailService())) }
        catch { _startupError = State(initialValue: "无法打开本地存储，请重启应用后重试。") }
    }
    var body: some Scene {
        WindowGroup {
            Group {
                if let store, store.startupReady {
                    if store.accounts.isEmpty { WelcomeView(store: store) }
                    else { InboxView(store: store) }
                }
                else {
                    ContentUnavailableView { Label("存储暂不可用", systemImage: "externaldrive.badge.exclamationmark") } description: { Text(startupError ?? store?.error ?? "请重试，现有数据会保留。") } actions: {
                        Button("重试") { retryStorage() }.buttonStyle(.borderedProminent)
                    }
                }
            }.tint(MailTheme.blue)
                .preferredColorScheme(appearance == "system" ? nil : (appearance == "dark" ? .dark : .light))
                .task { if scenePhase == .active { BackgroundMail.shared.activate() } }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in if store?.startupReady != true { retryStorage() } }
                .onChange(of: store?.accounts) { _, _ in try? BackgroundMail.shared.synchronizeAccounts() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { if let store, !store.startupReady { retryStorage() }; store?.refresh(); BackgroundMail.shared.activate() }
                    else if phase == .inactive { try? BackgroundMail.shared.synchronizeAccounts() }
                    else if phase == .background { store?.cancelRefresh(); BackgroundMail.shared.enterBackground() }
                }
        }
    }
    private func retryStorage() {
        do {
            #if DEBUG
            if CommandLine.arguments.contains("--ui-fixture") { store = try DebugPreview.store(); startupError = nil; return }
            #endif
            store = MailStore(vault: KeychainVault(), files: try MailFiles(), service: NativeMailService()); startupError = nil
        } catch { startupError = "仍无法打开本地存储。请稍后重试，现有数据会保留。" }
    }

}
/// Keep first-run setup independent of inbox navigation and tab selection.
struct WelcomeView: View {
    let store: MailStore
    @State private var addingAccount = false
    var body: some View {
        NavigationStack {
            if addingAccount {
                AccountView(store: store, onClose: { addingAccount = false })
            } else {
                ScrollView {
                    VStack(spacing: 20) {
                        Image(systemName: "envelope.open.fill").font(.system(size: 56)).foregroundStyle(MailTheme.blue)
                        Text("把邮箱，放进口袋").font(.title.bold())
                        Text("连接你的邮箱，开始轻松处理邮件。\n账号与邮件保存在你的设备上。")
                            .foregroundStyle(MailTheme.secondary).multilineTextAlignment(.center)
                    }.padding(24).frame(maxWidth: .infinity).padding(.top, 64)
                }.safeAreaInset(edge: .bottom) {
                    Button("添加邮箱", systemImage: "plus") { addingAccount = true }
                        .buttonStyle(MailPrimaryButton()).accessibilityIdentifier("add-account").padding(24).background(MailTheme.surface)
                }
                    .background(MailTheme.surface).navigationTitle("MailAI").navigationBarTitleDisplayMode(.inline)
            }
        }
        .alert("操作提示", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
            Button("知道了") { store.error = nil }
        } message: { Text(store.error ?? "") }
    }
}

struct InboxView: View {
    @Bindable var store: MailStore
    @State private var addingAccount = false
    @State private var composing = false
    @State private var mailboxes = false
    @State private var searching = false
    @State private var searchHeaderVisible = true
    @State private var showingDrafts = false
    @State private var notificationMessage: MailSummary?
    @State private var notificationTask: Task<Void, Never>?
    @State private var notificationOpening = false
    @State private var notificationGeneration = UUID()
    @State private var actionPanel: MailActionPanelData?
    @State private var selecting = false
    @State private var selection = Set<String>()
    @State private var moveRequest: MailMoveRequest?
    @State private var deleting: MailMoveRequest?
    @State private var destination: InboxDestination?
    @State private var pendingDestination: InboxDestination?
    @State private var filter = "all"
    @State private var grouped = false
    @State private var unified = false
    @State private var unifiedMessages: [LocatedMessage] = []
    private func matches(_ message: MailSummary) -> Bool {
        switch filter { case "unread": return message.unread; case "flagged": return message.isFlagged == true; case "attachments": return message.hasAttachments == true; default: return true }
    }
    private var filtered: [MailSummary] { store.messages.filter(matches) }
    private var threads: [MailThread] { MailThread.group(store.messages).filter { $0.messages.contains(where: matches) } }
    private var mailboxTitle: String { unified ? "所有收件箱" : (store.folders.first { $0.name == store.folder }?.title ?? "收件箱") }
    private var filterTitle: String {
        switch filter { case "unread": return "未读"; case "flagged": return "星标"; case "attachments": return "附件"; default: return "全部邮件" }
    }
    private var unreadCount: Int { unified ? unifiedMessages.filter { $0.summary.unread }.count : store.messages.filter(\.unread).count }
    var body: some View {
        NavigationStack {
            mailContent.navigationDestination(isPresented: Binding(get: { notificationMessage != nil }, set: { if !$0 { notificationMessage = nil } })) { if let notificationMessage { ReaderView(store: store, summary: notificationMessage) } }
                .navigationDestination(item: $destination) { destination in
                switch destination {
                case .contacts: ContactsView(store: store).toolbar(.visible, for: .navigationBar)
                case .settings: SettingsView(store: store, addingAccount: $addingAccount).toolbar(.visible, for: .navigationBar)
                case .notifications: BackgroundSettingsView()
                }
            }
        }
        .disabled(notificationOpening)
        .overlay {
            if notificationOpening {
                VStack(spacing: 14) { ProgressView("正在打开通知邮件…"); Button("取消打开") { notificationTask?.cancel() } }
                    .padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            }
        }
        .onChange(of: BackgroundMail.shared.pendingTarget, initial: true) { _, target in
            guard let target else { return }
            BackgroundMail.shared.pendingTarget = nil
            notificationTask?.cancel(); notificationGeneration = UUID(); let token = notificationGeneration; notificationOpening = true
            notificationTask = Task {
                defer { if notificationGeneration == token { notificationOpening = false } }
                do {
                    guard !store.sending, !store.operating else { throw MailFailure.invalid("请等待当前操作完成。") }
                    try store.saveDraft()
                    let message = try await store.messageForNotification(target)
                    try Task.checkCancellation(); guard notificationGeneration == token else { return }
                    composing = false; addingAccount = false; mailboxes = false; searching = false; showingDrafts = false; destination = nil
                    notificationMessage = message
                    if message == nil { store.error = "邮件可能已移动或删除，已打开对应收件箱供你核对。" }
                }
                catch { if !Task.isCancelled { store.error = "暂时无法打开通知邮件，请保存当前编辑或操作后重试。" } }
            }
        }
        .onChange(of: BackgroundMail.shared.pendingSettings, initial: true) { _, value in if value { BackgroundMail.shared.pendingSettings = false; destination = .notifications } }
        .onChange(of: BackgroundMail.shared.refreshID) { _, _ in if store.folder == "INBOX" && !store.operating { store.refresh() } }
        .sheet(isPresented: $addingAccount) { NavigationStack { AccountView(store: store) } }
        .sheet(isPresented: $composing) { ComposerView(store: store) }
        .sheet(isPresented: $showingDrafts) { DraftsView(store: store) }
        .sheet(isPresented: $searching) { MailSearchView(store: store) }
        .mailActionPanel($actionPanel)
        .sheet(isPresented: $mailboxes, onDismiss: {
            if let pendingDestination { destination = pendingDestination; self.pendingDestination = nil }
        }) { MailboxesView(store: store, unified: $unified) { pendingDestination = $0 } }
        .sheet(item: $moveRequest) { request in MovePicker(store: store, items: request.items, destinationRole: request.destinationRole) }
        .alert("删除选中的邮件？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { request in
            Button("移到废纸篓", role: .destructive) { deleting = nil; moveToRole("trash", request.items) }
            Button("取消", role: .cancel) { deleting = nil }
        } message: { request in Text("将 \(request.items.count) 封邮件移到废纸篓，可在废纸篓中找回。") }
        .alert("操作提示", isPresented: Binding(get: { store.error != nil && destination != nil }, set: { if !$0 { store.error = nil } })) {
            Button("知道了") { store.error = nil }
        } message: { Text(store.error ?? "") }
        .task {
            #if DEBUG
            if CommandLine.arguments.contains("--ui-fixture"), CommandLine.arguments.contains("--ui-save-failure") {
                do { try store.newDraft(); try DebugPreview.makeStorageReadOnly(); composing = true } catch { store.error = error.localizedDescription }
                return
            }
            #endif
            store.refresh()
        }
        .onChange(of: store.selectedID) { _, _ in selection = []; selecting = false; deleting = nil }
        .onChange(of: store.folder) { _, _ in selection = []; selecting = false; deleting = nil }
        .onChange(of: filter) { _, _ in selection = [] }
        .onChange(of: unified) { _, value in if value { unifiedMessages = (try? store.cachedInbox()) ?? [] } }
        .onChange(of: store.lastRefresh) { _, _ in if unified { unifiedMessages = (try? store.cachedInbox()) ?? [] } }
    }
    @ViewBuilder private var mailContent: some View {
        VStack(spacing: 0) {
            if !store.accounts.isEmpty { inboxTopBar }
            Group {
            if store.accounts.isEmpty {
                VStack(spacing: 22) {
                    Spacer()
                    Image(systemName: "envelope.open.fill").font(.system(size: 64)).foregroundStyle(MailTheme.blue)
                    Text("邮件，随身而行").font(.largeTitle.bold())
                    Text("连接你的邮箱，开始轻松处理邮件。\n账号与邮件保存在你的设备上。")
                        .foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("添加邮箱", systemImage: "plus") { addingAccount = true }
                        .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("add-account")
                    Spacer()
                }.padding(24).frame(maxWidth: .infinity).background(MailTheme.canvas)
            } else {
                List {
                    if !unified {
                        inboxControls
                            .onScrollVisibilityChange(threshold: 0.1) { searchHeaderVisible = $0 }
                            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                            .listRowSeparator(.hidden).listRowBackground(MailTheme.surface)
                    }
                    if let error = store.error {
                        HStack(alignment: .top, spacing: 4) {
                            MailNotice(text: error, symbol: "wifi.exclamationmark")
                            Button { store.error = nil } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel("关闭状态提示")
                        }.listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
                            .listRowSeparator(.hidden).listRowBackground(MailTheme.surface)
                    }
                        Section {
                            if unified {
                                ForEach(unifiedMessages) { item in
                                    NavigationLink { UnifiedReaderView(store: store, item: item) } label: {
                                        MailRow(summary: item.summary, account: store.accounts.first { $0.id == item.accountID }?.email)
                                    }.compactMailInboxRow()
                                }
                            } else if grouped {
                                ForEach(threads) { thread in
                                    if thread.messages.count == 1, let message = thread.messages.first {
                                        NavigationLink { ReaderView(store: store, summary: message, thread: thread.messages) } label: { MailRow(summary: message) }.compactMailInboxRow()
                                    } else {
                                        DisclosureGroup {
                                            ForEach(thread.messages) { message in
                                                NavigationLink { ReaderView(store: store, summary: message, thread: thread.messages) } label: { MailRow(summary: message) }.accessibilityIdentifier("thread-message-\(message.uid)").compactMailInboxRow()
                                            }
                                        } label: {
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(thread.messages.first?.subject ?? "邮件会话").font(.headline)
                                                Text("\(thread.messages.count) 封 · \(thread.messages.filter(\.unread).count) 封未读").font(.caption).foregroundStyle(.secondary)
                                            }.padding(.vertical, 6)
                                        }.compactMailInboxRow()
                                    }
                                }
                            } else {
                                ForEach(filtered) { message in
                                    HStack(spacing: 8) {
                                        if selecting {
                                            Button { if selection.contains(message.id) { selection.remove(message.id) } else { selection.insert(message.id) } } label: {
                                                Image(systemName: selection.contains(message.id) ? "checkmark.circle.fill" : "circle").font(.title3).frame(width: 44, height: 44)
                                            }.buttonStyle(.plain).accessibilityLabel("选择邮件")
                                            MailRow(summary: message).contentShape(Rectangle()).onTapGesture { if selection.contains(message.id) { selection.remove(message.id) } else { selection.insert(message.id) } }
                                        } else {
                                            NavigationLink { ReaderView(store: store, summary: message) } label: { MailRow(summary: message) }
                                        }
                                    }
                                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                        Button { run(.read(message.unread), [message]) } label: { Label(message.unread ? "已读" : "未读", systemImage: message.unread ? "envelope.open" : "envelope.badge") }.tint(MailTheme.blue)
                                        Button { run(.flagged(message.isFlagged != true), [message]) } label: { Label("星标", systemImage: "star") }.tint(.orange)
                                    }
                                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                        Button { moveToRole("trash", [message]) } label: { Label("废纸篓", systemImage: "trash") }.tint(.red)
                                        Button { moveToRole("archive", [message]) } label: { Label("归档", systemImage: "archivebox") }.tint(MailTheme.blue)
                                    }
                                    .contextMenu {
                                        Button("选择并批量操作", systemImage: "checkmark.circle") { selecting = true; selection = [message.id] }
                                        Button(message.unread ? "标为已读" : "标为未读") { run(.read(message.unread), [message]) }
                                        Button(message.isFlagged == true ? "取消星标" : "添加星标") { run(.flagged(message.isFlagged != true), [message]) }
                                        Button("移动到…") { moveRequest = MailMoveRequest(items: [message]) }
                                    }
                                    .compactMailInboxRow()
                                    .listRowBackground(selecting && selection.contains(message.id) ? MailTheme.blue.opacity(0.06) : MailTheme.surface)
                                }
                            }
                            if (unified ? unifiedMessages.isEmpty : filtered.isEmpty) {
                                ContentUnavailableView("暂无邮件", systemImage: "tray", description: Text("下拉刷新，或切换文件夹与筛选条件。"))
                            }
                        }.listRowBackground(MailTheme.surface)
                            .listSectionSeparator(.hidden)
                        if !unified && store.messages.count >= 50 {
                            Button("加载更多") { store.refresh(more: true) }.disabled(store.busy)
                        }
                        Section {
                            HStack(spacing: 6) {
                                if store.busy { ProgressView().controlSize(.small) }
                                Text(store.busy ? "正在同步…" : (store.lastRefresh.map { "更新于 " + $0.formatted(date: .omitted, time: .shortened) } ?? "显示本机缓存"))
                                Spacer()
                                Text("\(unified ? unifiedMessages.count : store.messages.count) 封已加载")
                            }.font(.caption).foregroundStyle(.secondary)
                        }.listRowBackground(Color.clear).listRowSeparator(.hidden).listSectionSeparator(.hidden)
                    }.listStyle(.plain).navigationLinkIndicatorVisibility(.hidden).scrollContentBackground(.hidden).background(MailTheme.surface)
                        .refreshable {
                            if unified { do { try await store.refreshAllInboxes(); unifiedMessages = try store.cachedInbox() } catch { store.error = "部分邮箱同步失败，已保留缓存。" + ((error as? MailConnectionFailure)?.localizedDescription ?? "") } }
                            else { store.refresh() }
                        }
            }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationTitle(mailboxTitle)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !store.accounts.isEmpty {
                VStack(spacing: 0) {
                    if store.undoID != nil {
                        HStack { Text(store.undoTitle).font(.subheadline); Spacer(); Button("撤销") { Task { do { try await store.undoLastAction() } catch { store.error = "撤销未完成，请刷新核对。" } } }.frame(minWidth: 44, minHeight: 44) }
                            .padding(.horizontal).padding(.vertical, 10).frame(minHeight: 64)
                            .task(id: store.undoID) { do { try await Task.sleep(for: .seconds(8)); store.clearUndo() } catch {} }
                    }
                    if selecting {
                        HStack(spacing: 16) {
                            Button(selection.count == filtered.count ? "取消全选" : "全选") { selection = selection.count == filtered.count ? [] : Set(filtered.map(\.id)) }
                            Spacer()
                            Button("标记", systemImage: "checkmark.circle") {
                                let items = chosen
                                actionPanel = MailActionPanelData(title: "标记邮件", groups: [[
                                    MailPanelAction(title: "标为已读", symbol: "envelope.open") { run(.read(true), items) },
                                    MailPanelAction(title: "标为未读", symbol: "envelope.badge") { run(.read(false), items) },
                                    MailPanelAction(title: "添加星标", symbol: "star") { run(.flagged(true), items) }
                                ]])
                            }.disabled(selection.isEmpty)
                            Button("移动", systemImage: "folder") { moveRequest = MailMoveRequest(items: chosen) }.disabled(selection.isEmpty)
                            Button("删除", systemImage: "trash", role: .destructive) { deleting = MailMoveRequest(items: chosen) }
                                .disabled(selection.isEmpty || store.folders.first(where: { $0.name == store.folder })?.title == "废纸篓")
                                .accessibilityIdentifier("bulk-delete")
                        }.font(.subheadline).dynamicTypeSize(...DynamicTypeSize.xxxLarge).frame(minHeight: 52).padding(.horizontal, 16)
                    }
                }.background(.regularMaterial)
            }
        }
        .disabled(store.operating)
    }
    // Equal side columns keep the title centered independently of its text and
    // the number of actions. Each action retains a full 44 pt hit target.
    private var inboxTopBar: some View {
        HStack(spacing: 0) {
            accountButton.frame(width: 92, alignment: .leading)
            inboxTitleMenu.frame(maxWidth: .infinity)
            HStack(spacing: 4) {
                if selecting {
                    Button("完成") { selecting = false; selection = [] }
                        .font(.subheadline.weight(.semibold)).frame(width: 92, height: 44)
                } else {
                    if !unified && !searchHeaderVisible { searchButton.transition(.opacity) }
                    composeButton
                }
            }.frame(width: 92, alignment: .trailing)
                .animation(.easeOut(duration: 0.15), value: searchHeaderVisible)
        }
        .padding(.horizontal, 16).padding(.vertical, 4)
        .background(MailTheme.surface)
        .accessibilityElement(children: .contain).accessibilityIdentifier("inbox-top-bar")
    }
    private var inboxTitleMenu: some View {
        Button { showInboxActions() } label: {
            HStack(spacing: 4) {
                Text(selecting ? "已选 \(selection.count) 封" : (filter == "all" || unified ? mailboxTitle : mailboxTitle + " · " + filterTitle))
                    .font(.headline).lineLimit(1).minimumScaleFactor(0.8)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(MailTheme.ink).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(MailPressButtonStyle(pressedScale: 0.98)).accessibilityIdentifier("inbox-title")
        .accessibilityLabel("更多邮件操作")
        .accessibilityValue(mailboxTitle + "，" + (unified ? "全部邮件" : filterTitle) + "，\(unreadCount) 封未读")
    }
    private func topBarIcon(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 21, weight: .regular))
            .foregroundStyle(MailTheme.blue)
            .frame(width: 44, height: 44).contentShape(Rectangle())
    }
    private var accountButton: some View {
        Button { mailboxes = true } label: {
            SenderAvatar(name: store.selected.map { $0.displayName.isEmpty ? $0.email : $0.displayName } ?? "邮", size: 32)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
            .buttonStyle(MailPressButtonStyle()).accessibilityLabel("邮箱与文件夹")
            .accessibilityValue(store.selected?.email ?? "")
            .accessibilityIdentifier("account-avatar")
    }
    private var searchButton: some View {
        Button { searching = true } label: { topBarIcon("magnifyingglass") }
            .buttonStyle(MailPressButtonStyle()).accessibilityLabel("搜索邮件").accessibilityIdentifier("inbox-search-toolbar")
    }
    private var composeButton: some View {
        Button { do { try store.newDraft(); composing = true } catch { store.error = error.localizedDescription } } label: {
            topBarIcon("square.and.pencil")
        }.buttonStyle(MailPressButtonStyle()).accessibilityLabel("写邮件").accessibilityIdentifier("compose-mail").disabled(store.sending)
    }
    private var inboxControls: some View {
        HStack(spacing: 0) {
            Button { searching = true } label: {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").font(.system(size: 16, weight: .regular))
                    Text("搜索邮件").font(.subheadline).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(MailTheme.secondary).padding(.leading, 12).frame(minHeight: 44)
                .contentShape(Rectangle())
            }.buttonStyle(MailPressButtonStyle(cornerRadius: 12, pressedScale: 0.99)).accessibilityLabel("搜索邮件").accessibilityIdentifier("inbox-search-header")
            if filter != "all" {
                Button { filter = "all" } label: {
                    HStack(spacing: 4) { Text(filterTitle); Image(systemName: "xmark").font(.system(size: 10, weight: .medium)) }
                        .font(.caption).lineLimit(1).foregroundStyle(MailTheme.blue)
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background(MailTheme.blue.opacity(0.08), in: Capsule())
                        .frame(minWidth: 44, minHeight: 44)
                }.buttonStyle(.plain).accessibilityLabel("清除筛选：" + filterTitle).accessibilityIdentifier("clear-inbox-filter")
            }
            Button {
                actionPanel = MailActionPanelData(title: "筛选邮件", groups: [[
                    MailPanelAction(title: "全部邮件", symbol: "tray", selected: filter == "all") { filter = "all" },
                    MailPanelAction(title: "未读", symbol: "envelope.badge", selected: filter == "unread") { filter = "unread" },
                    MailPanelAction(title: "星标", symbol: "star", selected: filter == "flagged") { filter = "flagged" },
                    MailPanelAction(title: "附件", symbol: "paperclip", selected: filter == "attachments") { filter = "attachments" }
                ]])
            } label: {
                Image(systemName: "line.3.horizontal.decrease").font(.system(size: 17, weight: .medium))
                    .foregroundStyle(filter == "all" ? MailTheme.secondary : MailTheme.blue).frame(width: 44, height: 44)
            }.buttonStyle(MailPressButtonStyle(cornerRadius: 12)).accessibilityLabel("筛选邮件").accessibilityValue(filterTitle).accessibilityIdentifier("inbox-filter")
        }
        .background(MailTheme.canvas, in: RoundedRectangle(cornerRadius: 12)).disabled(selecting)
    }
    private func showInboxActions() {
        var organization: [MailPanelAction] = []
        if !unified {
            if filter != "all" { organization.append(MailPanelAction(title: "显示全部邮件", symbol: "tray") { filter = "all" }) }
            organization.append(MailPanelAction(title: grouped ? "逐封显示" : "按会话显示", symbol: grouped ? "list.bullet" : "bubble.left.and.bubble.right") { grouped.toggle(); selecting = false; selection = [] })
            if !grouped { organization.append(MailPanelAction(title: selecting ? "完成选择" : "选择邮件", symbol: "checkmark.circle") { selecting.toggle(); selection = [] }) }
        }
        let navigation = [
            MailPanelAction(title: "邮箱与文件夹", symbol: "tray.2") { mailboxes = true },
            MailPanelAction(title: "草稿与发送记录", symbol: "doc.text") { showingDrafts = true },
            MailPanelAction(title: "添加邮箱", symbol: "plus") { addingAccount = true }
        ]
        actionPanel = MailActionPanelData(title: mailboxTitle + "操作", groups: organization.isEmpty ? [navigation] : [navigation, organization])
    }
    private var chosen: [MailSummary] { store.messages.filter { selection.contains($0.id) } }
    private func run(_ action: MailAction, _ items: [MailSummary]) {
        Task { do { try await store.perform(action, on: items); selection = []; selecting = false } catch { store.error = "操作未完成，请刷新核对服务器状态后重试。"; store.refresh() } }
    }
    private func moveToRole(_ role: String, _ items: [MailSummary]) {
        let configured = role == "trash" ? store.selected?.trashFolder : store.selected?.archiveFolder
        if let target = configured ?? store.folders.first(where: { $0.role == role || (role == "trash" ? $0.title == "废纸篓" : $0.title == "归档") })?.name { run(.move(target), items) }
        else { moveRequest = MailMoveRequest(items: items, destinationRole: role == "trash" ? "trash" : nil) }
    }
}
private extension View {
    func compactMailInboxRow() -> some View {
        listRowSeparator(.hidden).listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
    }
}
struct MailRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let summary: MailSummary
    var account: String? = nil
    var keyword = ""
    private var displaySender: String {
        let sender = summary.contactAddresses.first
        return sender?.name.isEmpty == false ? sender!.name : (sender?.email ?? summary.sender)
    }
    private var indicators: some View {
        HStack(spacing: 6) {
            if summary.isFlagged == true { Image(systemName: "star.fill").foregroundStyle(.orange).accessibilityLabel("星标") }
            if summary.hasAttachments == true { Image(systemName: "paperclip").accessibilityLabel("含附件") }
        }.font(.caption2).dynamicTypeSize(...DynamicTypeSize.xxxLarge).foregroundStyle(MailTheme.secondary)
    }
    private func matched(_ value: String) -> Text {
        var text = AttributedString(value)
        if !keyword.isEmpty, let range = text.range(of: keyword, options: [.caseInsensitive, .diacriticInsensitive]) {
            text[range].backgroundColor = MailTheme.blue.opacity(0.12)
            text[range].foregroundColor = MailTheme.blue
        }
        return Text(text)
    }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            InboxSenderAvatar(name: displaySender, address: summary.senderAddress ?? summary.replyAddress, unread: summary.unread).padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                if dynamicTypeSize.isAccessibilitySize {
                    matched(displaySender).font(.headline.weight(summary.unread ? .bold : .semibold))
                    HStack(spacing: 6) {
                        indicators
                        if let date = summary.date { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(MailTheme.secondary) }
                    }
                } else {
                    HStack(alignment: .firstTextBaseline) {
                        matched(displaySender).font(.headline.weight(summary.unread ? .bold : .semibold)).lineLimit(1)
                        Spacer(minLength: 8)
                        indicators.fixedSize()
                        if let date = summary.date { Text(Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(.dateTime.month().day())).font(.caption2).foregroundStyle(.secondary).fixedSize() }
                    }
                }
                matched(summary.subject.isEmpty ? "（无主题）" : summary.subject).font(.subheadline).lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                if let preview = summary.preview, !preview.isEmpty { matched(preview).font(.caption).foregroundStyle(MailTheme.secondary).lineLimit(1) }
                if let account { Text(account).font(.caption2).foregroundStyle(MailTheme.secondary).lineLimit(1) }
            }
        }.padding(.vertical, 12).foregroundStyle(MailTheme.ink)
            .overlay(alignment: .bottom) { Rectangle().fill(MailTheme.separator.opacity(0.5)).frame(height: 0.5).padding(.leading, 52).accessibilityHidden(true) }
            .accessibilityValue(summary.unread ? "未读" : "已读")
    }
}
struct UnifiedReaderView: View {
    let store: MailStore; let item: LocatedMessage
    @State private var ready = false
    var body: some View {
        Group { if ready { ReaderView(store: store, summary: item.summary) } else { ProgressView("打开邮件…") } }
            .toolbar(.visible, for: .navigationBar)
            .task { do { if store.selectedID != item.accountID { try store.selectAccount(item.accountID) }; ready = true } catch { store.error = error.localizedDescription } }
    }
}
