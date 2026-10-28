import SwiftUI
import MailAICore

struct SettingsView: View {
    let store: MailStore
    @Binding var addingAccount: Bool
    @AppStorage("mail.appearance") private var appearance = "system"
    @AppStorage("mail.readerSize") private var readerSize = 17.0
    @State private var confirmRemoval = false
    var body: some View {
        Form {
            Section("邮箱账号") {
                ForEach(store.accounts) { account in
                    NavigationLink { AccountView(store: store, editingAccount: account) } label: {
                        HStack { SenderAvatar(name: account.email); VStack(alignment: .leading) { Text(account.displayName.isEmpty ? account.email : account.displayName); if !account.displayName.isEmpty { Text(account.email).font(.caption).foregroundStyle(.secondary) } } }
                    }
                }
                Button("添加邮箱", systemImage: "plus") { addingAccount = true }
                if let account = store.selected {
                    Button("移除 \(account.email)", role: .destructive) { confirmRemoval = true }.disabled(store.sending)
                }
            }
            Section("外观与阅读") {
                Picker("显示模式", selection: $appearance) { Text("跟随系统").tag("system"); Text("浅色").tag("light"); Text("深色").tag("dark") }
                LabeledContent("主题", value: "宝武蓝 · 蓝白")
                VStack(alignment: .leading) { Text("正文字号 \(Int(readerSize))"); Slider(value: $readerSize, in: 14...26, step: 1).accessibilityLabel("正文字号") }
            }
            Section("小邮与同步") {
                NavigationLink("小邮与模型服务") { AssistantSettingsView() }
                NavigationLink("后台收信与通知") { BackgroundSettingsView() }
                NavigationLink("草稿与发送记录") { DraftsView(store: store) }
            }
            Section("隐私与使用说明") {
                Text("邮箱密码与模型密钥保存在本机钥匙串。邮件和附件缓存保存在此设备；小邮仅在你主动调用时将选定文字发往所配置的模型服务。")
                Text("邮件正文默认不加载远程图片或脚本。搜索先展示缓存，服务器搜索覆盖整个当前文件夹；列表数量表示已加载数量。")
                Text("后台刷新由 iOS 调度，不能保证即时提醒。当前版本不提供 APNs 服务端推送或 Google/Microsoft 网页授权登录。")
            }.font(.footnote).foregroundStyle(.secondary)
            Section("关于") {
                LabeledContent("MailAI iOS", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0")
                LabeledContent("构建", value: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
                NavigationLink("开源许可") { ScrollView { Text(licenseText).font(.caption).textSelection(.enabled).padding() }.navigationTitle("开源许可") }
            }
        }.navigationTitle("设置").scrollContentBackground(.hidden).background(MailTheme.canvas)
            .confirmationDialog("移除此账号及本机邮件、附件和草稿？服务器邮件会保留。", isPresented: $confirmRemoval, titleVisibility: .visible) {
                Button("移除当前邮箱", role: .destructive) { do { try store.removeSelectedAccount() } catch { store.error = error.localizedDescription } }
            }
    }
    private var licenseText: String {
        guard let url = Bundle.main.url(forResource: "Licenses", withExtension: "txt"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "无法读取许可文件。" }
        return text
    }
}
