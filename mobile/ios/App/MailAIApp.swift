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
                if let store {
                    if store.accounts.isEmpty { WelcomeView(store: store) }
                    else { InboxView(store: store) }
                }
                else { ContentUnavailableView("存储暂不可用", systemImage: "externaldrive.badge.exclamationmark", description: Text(startupError ?? "请重试")) }
            }.tint(MailTheme.blue)
                .preferredColorScheme(appearance == "system" ? nil : (appearance == "dark" ? .dark : .light))
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { BackgroundMail.shared.cancelRunning(); store?.refresh() }
                    else { store?.cancelRefresh(); BackgroundMail.shared.schedule() }
                }
        }
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
                VStack(spacing: 22) {
                    Spacer(minLength: 32)
                    Image(systemName: "envelope.open.fill").font(.system(size: 56)).foregroundStyle(MailTheme.blue)
                    Text("把邮箱，放进口袋").font(.system(.title, design: .default, weight: .bold))
                    Text("连接你的邮箱，开始轻松处理邮件。\n账号与邮件保存在你的设备上。")
                        .foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("添加邮箱", systemImage: "plus") { addingAccount = true }
                        .buttonStyle(MailPrimaryButton()).accessibilityIdentifier("add-account")
                    Spacer(minLength: 24)
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
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
    @State private var showingDrafts = false
    @State private var selecting = false
    @State private var selection = Set<String>()
    @State private var moving: [MailSummary] = []
    @State private var showMove = false
    @State private var filter = "all"
    @State private var grouped = false
    @State private var unified = false
    @State private var unifiedMessages: [LocatedMessage] = []
    @State private var tab = 0
    private var filtered: [MailSummary] {
        store.messages.filter { filter == "unread" ? $0.unread : filter == "flagged" ? $0.isFlagged == true : filter == "attachments" ? $0.hasAttachments == true : true }
    }
    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { mailContent }
                .tabItem { Label("邮件", systemImage: "envelope") }.tag(0)
            NavigationStack { ContactsView(store: store) }
                .tabItem { Label("通讯录", systemImage: "person.crop.rectangle") }.tag(1)
            NavigationStack { SettingsView(store: store, addingAccount: $addingAccount) }
                .tabItem { Label("设置", systemImage: "gearshape") }.tag(2)
        }
        .sheet(isPresented: $addingAccount) { NavigationStack { AccountView(store: store) } }
        .sheet(isPresented: $composing) { ComposerView(store: store) }
        .sheet(isPresented: $showingDrafts) { DraftsView(store: store) }
        .sheet(isPresented: $searching) { MailSearchView(store: store) }
        .sheet(isPresented: $mailboxes) { MailboxesView(store: store, unified: $unified) }
        .sheet(isPresented: $showMove) { MovePicker(store: store, items: moving) }
        .alert("操作提示", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
            Button("知道了") { store.error = nil }
        } message: { Text(store.error ?? "") }
        .task { store.refresh() }
        .onChange(of: unified) { _, value in if value { unifiedMessages = (try? store.cachedInbox()) ?? [] } }
        .onChange(of: store.lastRefresh) { _, _ in if unified { unifiedMessages = (try? store.cachedInbox()) ?? [] } }
    }
    @ViewBuilder private var mailContent: some View {
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
                VStack(spacing: 0) {
                    if !unified {
                        Button { searching = true } label: {
                            HStack(spacing: 8) { Image(systemName: "magnifyingglass"); Text("搜索当前邮箱"); Spacer() }
                                .font(.subheadline).foregroundStyle(MailTheme.secondary).padding(.horizontal, 12).frame(minHeight: 44)
                                .background(MailTheme.canvas, in: RoundedRectangle(cornerRadius: 12))
                        }.accessibilityLabel("搜索邮件").padding(.horizontal, 16).padding(.top, 8)
                        HStack(spacing: 8) {
                            filterChip("全部", value: "all"); filterChip("未读", value: "unread")
                            filterChip("星标", value: "flagged"); filterChip("附件", value: "attachments")
                        }.padding(.horizontal, 16).padding(.vertical, 8)
                    }
                    List {
                        Section {
                            if unified {
                                ForEach(unifiedMessages) { item in
                                    NavigationLink { UnifiedReaderView(store: store, item: item) } label: {
                                        MailRow(summary: item.summary, account: store.accounts.first { $0.id == item.accountID }?.email)
                                    }
                                }
                            } else if grouped {
                                ForEach(MailThread.group(filtered)) { thread in
                                    if thread.messages.count == 1, let message = thread.messages.first {
                                        NavigationLink { ReaderView(store: store, summary: message) } label: { MailRow(summary: message) }
                                    } else {
                                        DisclosureGroup {
                                            ForEach(thread.messages) { message in
                                                NavigationLink { ReaderView(store: store, summary: message) } label: { MailRow(summary: message) }
                                            }
                                        } label: {
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(thread.messages.first?.subject ?? "邮件会话").font(.headline)
                                                Text("\(thread.messages.count) 封 · \(thread.messages.filter(\.unread).count) 封未读").font(.caption).foregroundStyle(.secondary)
                                            }.padding(.vertical, 6)
                                        }
                                    }
                                }
                            } else {
                                ForEach(filtered) { message in
                                    HStack(spacing: 8) {
                                        if selecting {
                                            Button { if selection.contains(message.id) { selection.remove(message.id) } else { selection.insert(message.id) } } label: {
                                                Image(systemName: selection.contains(message.id) ? "checkmark.circle.fill" : "circle").font(.title3)
                                            }.buttonStyle(.plain).accessibilityLabel("选择邮件")
                                            MailRow(summary: message)
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
                                        Button(message.unread ? "标为已读" : "标为未读") { run(.read(message.unread), [message]) }
                                        Button(message.isFlagged == true ? "取消星标" : "添加星标") { run(.flagged(message.isFlagged != true), [message]) }
                                        Button("移动到…") { moving = [message]; showMove = true }
                                    }
                                }
                            }
                            if (unified ? unifiedMessages.isEmpty : filtered.isEmpty) {
                                ContentUnavailableView("暂无邮件", systemImage: "tray", description: Text("下拉刷新，或切换文件夹与筛选条件。"))
                            }
                        }
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
                        }.listRowBackground(Color.clear)
                    }.listStyle(.plain).scrollContentBackground(.hidden).safeAreaPadding(.bottom, selecting ? 0 : 76)
                        .refreshable {
                            if unified { do { try await store.refreshAllInboxes(); unifiedMessages = try store.cachedInbox() } catch { store.error = "部分邮箱同步失败，已保留缓存。" } }
                            else { store.refresh() }
                        }
                }.background(MailTheme.surface)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationTitle(unified ? "所有收件箱" : (store.folders.first { $0.name == store.folder }?.title ?? "MailAI"))
        .toolbar(selecting ? .hidden : .visible, for: .tabBar)
        .toolbar {
            if !store.accounts.isEmpty {
                ToolbarItem(placement: .topBarLeading) {
                    Button { mailboxes = true } label: { SenderAvatar(name: store.selected?.displayName.isEmpty == false ? store.selected!.displayName : (store.selected?.email ?? "M")) }.accessibilityLabel("邮箱与文件夹")
                }
                ToolbarItem(placement: .principal) {
                    Button { mailboxes = true } label: {
                        VStack(spacing: 2) {
                            HStack(spacing: 4) { Text(selecting ? "已选 \(selection.count) 封" : (unified ? "所有收件箱" : (store.folders.first { $0.name == store.folder }?.title ?? "收件箱"))).font(.headline); Image(systemName: "chevron.down").font(.caption2) }
                            if !selecting { Text(unified ? "汇集各邮箱的本机邮件" : (store.selected?.email ?? "")).font(.caption2).foregroundStyle(MailTheme.secondary).lineLimit(1) }
                        }.foregroundStyle(MailTheme.ink)
                    }.accessibilityLabel("切换邮箱与文件夹")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if selecting { Button("完成") { selecting = false; selection = [] } }
                    Menu {
                        Button("草稿与发送记录") { showingDrafts = true }
                        Button("添加邮箱") { addingAccount = true }
                        if !unified {
                            Button(grouped ? "逐封显示" : "按会话显示") { grouped.toggle(); selecting = false; selection = [] }
                            if !grouped { Button(selecting ? "完成选择" : "选择邮件") { selecting.toggle(); selection = [] } }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("更多邮件操作")
                }

            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !store.accounts.isEmpty {
                VStack(spacing: 0) {
                    if store.undoID != nil {
                        HStack { Text(store.undoTitle).font(.subheadline); Spacer(); Button("撤销") { Task { do { try await store.undoLastAction() } catch { store.error = "撤销未完成，请刷新核对。" } } } }
                            .padding(.horizontal).padding(.vertical, 10)
                            .task(id: store.undoID) { do { try await Task.sleep(for: .seconds(8)); store.clearUndo() } catch {} }
                    }
                    if selecting {
                        HStack(spacing: 16) {
                            Button(selection.count == filtered.count ? "取消全选" : "全选") { selection = selection.count == filtered.count ? [] : Set(filtered.map(\.id)) }
                            Spacer()
                            Menu("标记", systemImage: "checkmark.circle") {
                                Button("标为已读") { run(.read(true), chosen) }
                                Button("标为未读") { run(.read(false), chosen) }
                                Button("添加星标") { run(.flagged(true), chosen) }
                            }.disabled(selection.isEmpty)
                            Button("移动", systemImage: "folder") { moving = chosen; showMove = true }.disabled(selection.isEmpty)
                        }.frame(minHeight: 52).padding(.horizontal, 16)
                    }
                }.background(.regularMaterial)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if !selecting && !store.accounts.isEmpty {
                Button { do { try store.newDraft(); composing = true } catch { store.error = error.localizedDescription } } label: {
                    Label("写邮件", systemImage: "square.and.pencil").font(.callout.weight(.semibold)).padding(.horizontal, 18).frame(minHeight: 50)
                }.buttonStyle(.borderedProminent).buttonBorderShape(.roundedRectangle(radius: 18))
                    .accessibilityIdentifier("compose-mail").disabled(store.sending).padding(16)
            }
        }
        .disabled(store.operating)
    }
    private func filterChip(_ title: String, value: String) -> some View {
        Button { filter = value; selection = [] } label: {
            Text(title).font(.subheadline.weight(filter == value ? .semibold : .regular)).frame(maxWidth: .infinity, minHeight: 36)
                .foregroundStyle(filter == value ? MailTheme.blue : MailTheme.secondary)
                .background(filter == value ? MailTheme.blue.opacity(0.12) : MailTheme.canvas, in: RoundedRectangle(cornerRadius: 10))
        }.accessibilityAddTraits(filter == value ? .isSelected : [])
    }
    private var chosen: [MailSummary] { store.messages.filter { selection.contains($0.id) } }
    private func run(_ action: MailAction, _ items: [MailSummary]) {
        Task { do { try await store.perform(action, on: items); selection = []; selecting = false } catch { store.error = "操作未完成，请刷新核对服务器状态后重试。"; store.refresh() } }
    }
    private func moveToRole(_ role: String, _ items: [MailSummary]) {
        let configured = role == "trash" ? store.selected?.trashFolder : store.selected?.archiveFolder
        if let target = configured ?? store.folders.first(where: { $0.role == role || (role == "trash" ? $0.title == "废纸篓" : $0.title == "归档") })?.name { run(.move(target), items) }
        else { moving = items; showMove = true }
    }
}
struct MailRow: View {
    let summary: MailSummary
    var account: String? = nil
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle().fill(summary.unread ? MailTheme.blue : .clear).frame(width: 7, height: 7).padding(.top, 6).accessibilityLabel(summary.unread ? "未读" : "")
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(summary.senderName?.isEmpty == false ? summary.senderName! : summary.sender).font(.subheadline.weight(summary.unread ? .semibold : .regular)).lineLimit(1)
                    Spacer(minLength: 8)
                    if let date = summary.date { Text(Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(.dateTime.month().day())).font(.caption2).foregroundStyle(.secondary) }
                }
                Text(summary.subject.isEmpty ? "（无主题）" : summary.subject).font(.subheadline.weight(summary.unread ? .semibold : .regular)).lineLimit(1)
                if let preview = summary.preview, !preview.isEmpty { Text(preview).font(.subheadline).foregroundStyle(MailTheme.secondary).lineLimit(1) }
                HStack(spacing: 7) {
                    if summary.isFlagged == true { Image(systemName: "star.fill").foregroundStyle(.orange) }
                    if summary.hasAttachments == true { Image(systemName: "paperclip") }
                    if let account { Text(account).lineLimit(1) }
                }.font(.caption2).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 7).foregroundStyle(MailTheme.ink)
    }
}
struct UnifiedReaderView: View {
    let store: MailStore; let item: LocatedMessage
    @State private var ready = false
    var body: some View {
        Group { if ready { ReaderView(store: store, summary: item.summary) } else { ProgressView("打开邮件…") } }
            .task { do { if store.selectedID != item.accountID { try store.selectAccount(item.accountID) }; ready = true } catch { store.error = error.localizedDescription } }
    }
}
