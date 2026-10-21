import SwiftUI
import MailAICore

struct AccountView: View {
    let store: MailStore
    @Environment(\.dismiss) private var dismiss
    @State private var account = MailAccount()
    @State private var password = ""
    @State private var testing = false
    @State private var error: String?
    @State private var task: Task<Void, Never>?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("邮箱地址", text: $account.email).keyboardType(.emailAddress).accessibilityIdentifier("email")
                    TextField("发件人显示名称（选填）", text: $account.displayName)
                    Button("填入常见邮箱服务器建议") { account.suggestServers() }
                } footer: { Text("建议支持 QQ / Foxmail、163、126、iCloud。其他邮箱请按服务商提供的信息填写；不会自动尝试密码。") }
                Section("登录凭据") {
                    TextField("登录用户名", text: $account.username).keyboardType(.emailAddress)
                    SecureField("密码 / 邮箱授权码", text: $password)
                }
                Section("收信 · IMAP") {
                    TextField("服务器，例如 imap.example.com", text: $account.imapHost).keyboardType(.URL)
                    TextField("端口", value: $account.imapPort, format: .number.grouping(.never)).keyboardType(.numberPad)
                    Picker("加密", selection: $account.imapSecurity) {
                        ForEach(TransportSecurity.allCases) { Text($0.title).tag($0) }
                    }
                }
                Section("发信 · SMTP") {
                    TextField("服务器，例如 smtp.example.com", text: $account.smtpHost).keyboardType(.URL)
                    TextField("端口", value: $account.smtpPort, format: .number.grouping(.never)).keyboardType(.numberPad)
                    Picker("加密", selection: $account.smtpSecurity) {
                        ForEach(TransportSecurity.allCases) { Text($0.title).tag($0) }
                    }
                }
                Section {
                    if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                    Button {
                        testing = true; error = nil
                        task = Task {
                            do { try await store.addAccount(account, password: password); password = ""; dismiss() }
                            catch {
                                if !Task.isCancelled {
                                    self.error = (error as? MailFailure)?.localizedDescription ?? "连接验证失败。请确认服务器、端口、加密方式及邮箱授权码；服务器证书必须有效。"
                                }
                            }
                            testing = false
                        }
                    } label: {
                        HStack { if testing { ProgressView() }; Text(testing ? "正在验证收发连接…" : "验证并保存") }
                    }.disabled(testing).accessibilityIdentifier("validate-account")
                    if testing { Button("取消验证", role: .cancel) { task?.cancel(); testing = false } }
                } footer: {
                    Text("点击后会使用输入的凭据连接这两个服务器，验证 IMAP 和 SMTP 登录，不发送测试邮件。成功后保存到本机钥匙串。支持有效证书的公网和你填写的内网服务器；仅使用 TLS 1.2+ 或强制 STARTTLS，不忽略证书错误。")
                }
            }
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .navigationTitle("添加邮箱").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { task?.cancel(); dismiss() } } }
            .interactiveDismissDisabled(testing)
            .onDisappear { task?.cancel(); password = "" }
        }
    }
}
