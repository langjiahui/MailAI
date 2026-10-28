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
            }
            Section("偏好设置") {
                NavigationLink { AppearanceSettingsView() } label: { settingsRow("外观与阅读", symbol: "circle.lefthalf.filled", detail: "宝武蓝 · 蓝白") }.accessibilityIdentifier("appearance-settings")
                NavigationLink { AssistantSettingsView() } label: { settingsRow("小邮与模型服务", symbol: "sparkles") }
                NavigationLink { BackgroundSettingsView() } label: { settingsRow("后台收信与通知", symbol: "bell") }
            }
            Section {
                NavigationLink { AboutView() } label: { settingsRow("关于 MailAI", symbol: "info.circle") }
            }
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
                Section {
                    VStack(spacing: 8) {
                        SenderAvatar(name: account.displayName.isEmpty ? account.email : account.displayName, size: 56)
                        Text(account.displayName.isEmpty ? "邮箱账号" : account.displayName).font(.title3.weight(.semibold))
                        Text(account.email).font(.subheadline).foregroundStyle(MailTheme.secondary).textSelection(.enabled)
                    }.frame(maxWidth: .infinity).padding(.vertical, 12)
                }
                Section {
                    NavigationLink("登录、服务器与发信偏好") { AccountView(store: store, editingAccount: account) }
                } footer: { Text("密码保持为空时沿用已保存凭据。修改后会重新验证连接。") }
                Section {
                    Button("移除此邮箱", role: .destructive) { confirmRemoval = true }.disabled(store.sending || store.operating)
                }
                if let error { MailNotice(text: error) }
            }
        }.scrollContentBackground(.hidden).background(MailTheme.canvas).navigationTitle("邮箱设置").navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .tabBar)
            .confirmationDialog("移除 \(account?.email ?? "此邮箱")？", isPresented: $confirmRemoval, titleVisibility: .visible) {
                Button("移除此邮箱", role: .destructive) { do { try store.removeAccount(accountID); dismiss() } catch { self.error = error.localizedDescription } }
            } message: { Text("会删除此设备上的账号、邮件缓存、附件与草稿。服务器邮件会保留。") }
    }
}
struct AppearanceSettingsView: View {
    @AppStorage("mail.appearance") private var appearance = "system"
    @AppStorage("mail.readerSize") private var readerSize = 17.0
    var body: some View {
        Form {
            Section("显示模式") {
                Picker("显示模式", selection: $appearance) { Text("跟随系统").tag("system"); Text("浅色").tag("light"); Text("深色").tag("dark") }.pickerStyle(.inline).labelsHidden()
            }
            Section("主题") {
                HStack { Circle().fill(MailTheme.blue).frame(width: 24, height: 24); Text("宝武蓝 · 蓝白"); Spacer(); Image(systemName: "checkmark").foregroundStyle(MailTheme.blue) }
                    .accessibilityElement(children: .ignore).accessibilityLabel("主题").accessibilityValue("宝武蓝 · 蓝白").accessibilityIdentifier("theme-setting")
                VStack(alignment: .leading, spacing: 8) {
                    Text("项目资料与本周安排").font(.headline)
                    Text("颜色随系统切换，阅读保持清晰。留出空间，专注每一封邮件。")
                        .font(.system(size: readerSize, relativeTo: .body)).lineSpacing(5)
                }.padding(.vertical, 8)
            }
            Section("邮件正文字号") {
                LabeledContent("字号", value: "\(Int(readerSize)) pt")
                Slider(value: $readerSize, in: 14...26, step: 1).accessibilityLabel("正文字号")
            } footer: { Text("界面文字跟随系统动态字号；此项调整邮件正文。") }
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
            }
            Section {
                NavigationLink("隐私与数据") { PrivacyView() }
                NavigationLink("开源许可") { ScrollView { Text(licenseText).font(.footnote).textSelection(.enabled).padding(16) }.navigationTitle("开源许可").navigationBarTitleDisplayMode(.inline) }
            }
        }.scrollContentBackground(.hidden).background(MailTheme.canvas).navigationTitle("关于 MailAI").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
    }
    private var licenseText: String {
        guard let url = Bundle.main.url(forResource: "Licenses", withExtension: "txt"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "无法读取许可文件。" }; return text
    }
}
struct PrivacyView: View {
    var body: some View {
        List {
            Section("保存在你的设备") { Text("邮箱密码与模型密钥保存在本机钥匙串。邮件、附件缓存和草稿保存在此设备。移除邮箱会清除此邮箱的本机数据，服务器邮件保留。") }
            Section("由你决定何时使用小邮") { Text("只有主动调用并确认范围后，选定文字才发送给你配置的模型服务。不自动整箱上传，不上传附件，不在后台自动分析。") }
            Section("安全阅读") { Text("邮件正文不加载远程图片或脚本，外部 HTTPS 链接确认后用 Safari 打开。收发连接验证服务器证书。") }
            Section("搜索与同步") { Text("搜索先匹配当前账号和文件夹的本机缓存，再由你继续搜索服务器当前文件夹。后台刷新由 iOS 调度，不能保证即时提醒。") }
        }.scrollContentBackground(.hidden).background(MailTheme.canvas).navigationTitle("隐私与数据").navigationBarTitleDisplayMode(.inline)
    }
}
