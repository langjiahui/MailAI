import SwiftUI
import MailAICore
import Logging

@main struct MailAIApp: App {
    @State private var store: MailStore?
    @State private var startupError: String?
    @Environment(\.scenePhase) private var scenePhase
    init() {
        LoggingSystem.bootstrap { _ in SwiftLogNoOpLogHandler() }
        do {
            _store = State(initialValue: MailStore(vault: KeychainVault(), files: try MailFiles(), service: NativeMailService()))
        } catch { _startupError = State(initialValue: "无法打开本地存储，请重启应用后重试。") }
    }
    var body: some Scene {
        WindowGroup {
            Group {
                if let store { InboxView(store: store) }
                else { ContentUnavailableView("存储暂不可用", systemImage: "externaldrive.badge.exclamationmark", description: Text(startupError ?? "请重试")) }
            }
            .tint(Color(red: 0.02, green: 0.47, blue: 0.46))
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { store?.refresh() }
                else { store?.cancelRefresh() }
            }
        }
    }
}

struct InboxView: View {
    @Bindable var store: MailStore
    @State private var addingAccount = false
    @State private var composing = false
    @State private var settings = false
    @State private var query = ""
    @State private var unreadOnly = false
    private var filtered: [MailSummary] {
        store.messages.filter { (!unreadOnly || $0.unread) &&
            (query.isEmpty || ($0.subject + " " + $0.sender).localizedCaseInsensitiveContains(query)) }
    }
    var body: some View {
        NavigationStack {
            Group {
                if store.accounts.isEmpty {
                    VStack(spacing: 24) {
                        Spacer()
                        Image(systemName: "envelope.badge.shield.half.filled").font(.system(size: 64)).foregroundStyle(.tint)
                        VStack(spacing: 10) {
                            Text("邮件，随身而行").font(.largeTitle.bold())
                            Text("在 iPhone 上独立收发邮件\n账号与邮件留在你的设备上")
                                .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }
                        Button("添加邮箱", systemImage: "plus") { addingAccount = true }
                            .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("add-account")
                        Text("支持 IMAP / SMTP · TLS 加密连接").font(.footnote).foregroundStyle(.secondary)
                        Spacer()
                        Text("MailAI · iOS 1.0.0").font(.caption).foregroundStyle(.tertiary).padding(.bottom, 24)
                    }.padding(24)
                } else {
                    List {
                        Section {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(store.selected?.email ?? "").font(.subheadline).foregroundStyle(.secondary)
                                HStack {
                                    Label(store.busy ? "正在收信…" : "\(store.messages.count) 封缓存邮件", systemImage: store.busy ? "arrow.triangle.2.circlepath" : "tray")
                                    Spacer()
                                    Toggle("未读", isOn: $unreadOnly).toggleStyle(.button).font(.caption)
                                }
                                if let date = store.lastRefresh {
                                    Text("最近刷新 \(date.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.tertiary)
                                } else { Text("可离线阅读已缓存的邮件").font(.caption).foregroundStyle(.tertiary) }
                            }.padding(.vertical, 4)
                        }
                        Section {
                            ForEach(filtered) { message in
                                NavigationLink {
                                    ReaderView(store: store, summary: message)
                                } label: {
                                    HStack(alignment: .top, spacing: 10) {
                                        Circle().fill(message.unread ? Color.accentColor : .clear).frame(width: 7, height: 7).padding(.top, 7)
                                        VStack(alignment: .leading, spacing: 7) {
                                            HStack(alignment: .firstTextBaseline) {
                                                Text(message.sender).font(.subheadline.weight(message.unread ? .semibold : .regular)).lineLimit(1)
                                                Spacer()
                                                if let date = message.date { Text(date, format: .dateTime.month().day()).font(.caption2).foregroundStyle(.secondary) }
                                            }
                                            Text(message.subject).font(.body).lineLimit(2)
                                        }
                                    }.padding(.vertical, 7)
                                }
                            }
                            if filtered.isEmpty {
                                ContentUnavailableView(query.isEmpty ? "暂无邮件" : "没有匹配的缓存邮件", systemImage: "tray",
                                    description: Text("下拉刷新收信；搜索范围为当前文件夹已加载的邮件。"))
                            }
                            if store.messages.count >= 50 {
                                Button("加载更多（最多 500 封）") { store.refresh(more: true) }.disabled(store.busy)
                            }
                        }
                    }.refreshable { store.refresh() }
                    .searchable(text: $query, prompt: "搜索已加载邮件的主题、发件人")
                }
            }
            .navigationTitle(store.accounts.isEmpty ? "MailAI" : (store.folder.uppercased() == "INBOX" ? "收件箱" : store.folder))
            .toolbar {
                if !store.accounts.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        Menu {
                            Section("邮箱") {
                                ForEach(store.accounts) { account in
                                    Button(account.email) { perform { try store.selectAccount(account.id); store.refresh() } }
                                }
                            }
                            Section("文件夹") {
                                ForEach(store.folders) { folder in Button(folder.title) { perform { try store.selectFolder(folder.name) } } }
                            }
                        } label: { Image(systemName: "line.3.horizontal.decrease") }.disabled(store.sending)
                    }
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button("设置", systemImage: "gearshape") { settings = true }.disabled(store.sending)
                        Button("写信", systemImage: "square.and.pencil") { composing = true }
                    }
                }
            }
            .sheet(isPresented: $addingAccount) { AccountView(store: store) }
            .sheet(isPresented: $composing) { ComposerView(store: store) }
            .sheet(isPresented: $settings) { SettingsView(store: store, addingAccount: $addingAccount) }
            .alert("操作提示", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
                Button("知道了") { store.error = nil }
            } message: { Text(store.error ?? "") }
            .task { store.refresh() }
        }
    }
    private func perform(_ action: () throws -> Void) { do { try action() } catch { store.error = error.localizedDescription } }
}

struct SettingsView: View {
    @Bindable var store: MailStore
    @Binding var addingAccount: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRemoval = false
    var body: some View {
        NavigationStack {
            Form {
                Section("当前邮箱") {
                    Text(store.selected?.email ?? "")
                    Button("添加另一个邮箱") { dismiss(); Task { try? await Task.sleep(for: .milliseconds(350)); addingAccount = true } }
                    Button("移除当前邮箱", role: .destructive) { confirmRemoval = true }
                }
                Section("首版使用范围") {
                    Text("手机独立连接邮箱，支持多个账号、真实文件夹、缓存阅读、纯文本写信和回复。")
                    Text("每个账号保留一封本地草稿。首版不含附件操作、小邮、通讯录、定时后台收信和推送；打开应用或手动刷新时收信。")
                    Text("邮件正文不加载外部图片或脚本。发送成功代表 SMTP 服务器接受，不保证送达；本版不自动写入服务器已发送文件夹。")
                }.font(.footnote).foregroundStyle(.secondary)
                Section("版本") {
                    LabeledContent("MailAI iOS", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0")
                    LabeledContent("构建", value: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
                    NavigationLink("开源许可") { ScrollView { Text((try? String(contentsOf: Bundle.main.url(forResource: "Licenses", withExtension: "txt")!, encoding: .utf8)) ?? "MailAI — Apache 2.0\nSwiftMail — BSD 2-Clause\nSwiftNIO / SwiftNIOSSL — Apache 2.0").font(.caption).textSelection(.enabled).padding() }.navigationTitle("开源许可") }
                }
            }.navigationTitle("账号与设置").toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .confirmationDialog("移除账号及这台设备上的邮件缓存、草稿？服务器邮件会保留。", isPresented: $confirmRemoval, titleVisibility: .visible) {
                Button("移除账号", role: .destructive) {
                    do { try store.removeSelectedAccount(); dismiss() } catch { store.error = error.localizedDescription }
                }
            }
        }
    }
}
