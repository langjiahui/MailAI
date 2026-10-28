import SwiftUI
import MailAICore

struct SettingsView: View {
    let store: MailStore
    @Binding var addingAccount: Bool
    var body: some View {
        List {
            Section("邮箱账号") {
                ForEach(store.accounts) { account in
                    NavigationLink { AccountDetailView(store: store, accountID: account.id) } label: {
                        HStack(spacing: 12) {
                            SenderAvatar(name: account.displayName.isEmpty ? account.email : account.displayName, size: 42)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(account.displayName.isEmpty ? account.email : account.displayName).font(.body.weight(.medium))
                                Text(account.email).font(.caption).foregroundStyle(MailTheme.secondary)
                            }
                        }.padding(.vertical, 4)
                    }
                }
                Button("添加邮箱", systemImage: "plus.circle") { addingAccount = true }.frame(minHeight: 44)
            }.listRowBackground(MailTheme.surface)
            Section("偏好设置") {
                NavigationLink { AppearanceSettingsView() } label: { settingsRow("外观与阅读", symbol: "circle.lefthalf.filled", detail: "宝武蓝 · 蓝白") }.accessibilityIdentifier("appearance-settings")
                NavigationLink { AssistantSettingsView() } label: { settingsRow("小邮与模型服务", symbol: "sparkles") }
                NavigationLink { BackgroundSettingsView() } label: { settingsRow("后台收信与通知", symbol: "bell") }
            }.listRowBackground(MailTheme.surface)
            Section {
                NavigationLink { AboutView() } label: { settingsRow("关于 MailAI", symbol: "info.circle") }
            }.listRowBackground(MailTheme.surface)
        }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(MailTheme.canvas)
            .navigationTitle("设置").navigationBarTitleDisplayMode(.inline)
    }
    private func settingsRow(_ title: String, symbol: String, detail: String? = nil) -> some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: symbol)
            VStack(alignment: .leading, spacing: 3) { Text(title); if let detail { Text(detail).font(.caption).foregroundStyle(MailTheme.secondary) } }
        }.padding(.vertical, 3)
    }
}
struct AccountDetailView: View {
    let store: MailStore
    let accountID: UUID
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRemoval = false
    @State private var error: String?
    private var account: MailAccount? { store.accounts.first { $0.id == accountID } }
    var body: some View {
        List {
            if let account {
                Section("邮箱账号") {
                    LabeledContent("邮箱类型", value: "IMAP").accessibilityElement(children: .ignore).accessibilityLabel("邮箱类型").accessibilityValue("IMAP").accessibilityIdentifier("account-protocol")
                    LabeledContent("邮箱地址", value: account.email).textSelection(.enabled)
                    NavigationLink { AccountView(store: store, editingAccount: account) } label: { accountRow("显示名称", value: account.displayName.isEmpty ? "未设置" : account.displayName) }
                    NavigationLink("修改密码 / 授权码") { AccountView(store: store, editingAccount: account) }
                }.listRowBackground(MailTheme.surface)
                Section("服务器设置") {
                    NavigationLink { AccountView(store: store, editingAccount: account, showServerSettingsOnOpen: true) } label: { accountRow("收信服务器", value: account.imapHost) }
                    NavigationLink { AccountView(store: store, editingAccount: account, showServerSettingsOnOpen: true) } label: { accountRow("发信服务器", value: account.smtpHost) }
                }.listRowBackground(MailTheme.surface)
                Section("邮件设置") {
                    NavigationLink { AccountView(store: store, editingAccount: account) } label: { accountRow("邮件签名", value: account.signature?.isEmpty == false ? account.signature! : "未设置") }
                    NavigationLink { AccountView(store: store, editingAccount: account) } label: { accountRow("保存已发送副本", value: account.shouldSaveSentCopy ? "已开启" : "已关闭") }
                    NavigationLink { AccountView(store: store, editingAccount: account) } label: { accountRow("已发送文件夹", value: account.sentFolder?.isEmpty == false ? account.sentFolder! : "自动识别") }
                }.listRowBackground(MailTheme.surface)
                Section {
                    Button("移除此邮箱", role: .destructive) { confirmRemoval = true }.disabled(store.sending || store.operating)
                }.listRowBackground(MailTheme.surface)
                if let error { MailNotice(text: error, critical: true) }
            }
        }.scrollContentBackground(.hidden).background(MailTheme.canvas).navigationTitle("邮箱设置").navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .tabBar)
            .alert("移除 \(account?.email ?? "此邮箱")？", isPresented: $confirmRemoval) {
                Button("移除此邮箱", role: .destructive) { do { try store.removeAccount(accountID); dismiss() } catch { self.error = error.localizedDescription } }
                Button("取消", role: .cancel) {}
            } message: { Text("会删除此设备上的账号、邮件缓存、附件与草稿。服务器邮件会保留。") }
    }
    private func accountRow(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) { Text(title); Text(value).font(.subheadline).foregroundStyle(MailTheme.secondary).lineLimit(2) }.padding(.vertical, 3)
    }

}
struct AppearanceSettingsView: View {
    @AppStorage("mail.appearance") private var appearance = "system"
    @AppStorage("mail.readerSize") private var readerSize = 17.0
    @ScaledMetric(relativeTo: .body) private var scaledBody = 17.0
    var body: some View {
        Form {
            Section("显示模式") {
                Picker("显示模式", selection: $appearance) { Text("跟随系统").tag("system"); Text("浅色").tag("light"); Text("深色").tag("dark") }.pickerStyle(.inline).labelsHidden()
            }.listRowBackground(MailTheme.surface)
            Section("主题") {
                HStack { Circle().fill(MailTheme.blue).frame(width: 24, height: 24); Text("宝武蓝 · 蓝白"); Spacer(); Image(systemName: "checkmark").foregroundStyle(MailTheme.blue) }
                    .accessibilityElement(children: .ignore).accessibilityLabel("主题").accessibilityValue("宝武蓝 · 蓝白").accessibilityIdentifier("theme-setting")
                VStack(alignment: .leading, spacing: 8) {
                    Text("项目资料与本周安排").font(.headline)
                    Text("颜色随系统切换，阅读保持清晰。留出空间，专注每一封邮件。")
                        .font(.system(size: readerSize * scaledBody / 17)).lineSpacing(5)
                }.padding(.vertical, 8)
            }.listRowBackground(MailTheme.surface)
            Section {
                LabeledContent("字号", value: "\(Int(readerSize)) pt")
                Slider(value: $readerSize, in: 14...26, step: 1).accessibilityLabel("正文字号")
            } header: { Text("邮件正文字号") } footer: { Text("界面文字跟随系统动态字号；此项调整邮件正文。") }.listRowBackground(MailTheme.surface)
        }.scrollContentBackground(.hidden).background(MailTheme.canvas).navigationTitle("外观与阅读").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
    }
}
struct AboutView: View {
    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    Image(systemName: "envelope.open.fill").font(.system(size: 40)).foregroundStyle(MailTheme.blue).padding(16).background(MailTheme.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 20))
                    Text("MailAI").font(.title2.bold())
                    Text("把邮箱，放进口袋").foregroundStyle(MailTheme.secondary)
                }.frame(maxWidth: .infinity).padding(.vertical, 16)
                LabeledContent("版本", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0")
                LabeledContent("构建", value: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
            }.listRowBackground(MailTheme.surface)
            Section {
                NavigationLink("隐私与数据") { PrivacyView() }
                NavigationLink("开源许可") { LicensesView() }
            }.listRowBackground(MailTheme.surface)
        }.scrollContentBackground(.hidden).background(MailTheme.canvas).navigationTitle("关于 MailAI").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
    }

}
struct PrivacyView: View {
    var body: some View {
        List {
            Section("保存在你的设备") { Text("邮箱密码与模型密钥保存在本机钥匙串。邮件、附件缓存和草稿保存在此设备。移除邮箱会清除此邮箱的本机数据，服务器邮件保留。") }.listRowBackground(MailTheme.surface)
            Section("由你决定何时使用小邮") { Text("只有主动调用并确认范围后，选定文字才发送给你配置的模型服务。不自动整箱上传，不上传附件，不在后台自动分析。") }.listRowBackground(MailTheme.surface)
            Section("安全阅读") { Text("邮件正文不加载远程图片或脚本，外部 HTTPS 链接确认后用 Safari 打开。收发连接验证服务器证书。") }.listRowBackground(MailTheme.surface)
            Section("搜索与同步") { Text("搜索先匹配当前账号和文件夹的本机缓存，再由你继续搜索服务器当前文件夹。后台刷新由 iOS 调度，不能保证即时提醒。") }.listRowBackground(MailTheme.surface)
        }.scrollContentBackground(.hidden).background(MailTheme.canvas).navigationTitle("隐私与数据").navigationBarTitleDisplayMode(.inline)
    }
}
