import SwiftUI
import MailAICore

struct AccountView: View {
    let store: MailStore
    @Environment(\.dismiss) private var dismiss
    @State private var setup = AccountSetup()
    @State private var password = ""
    @State private var advanced = false
    @State private var testing = false
    @State private var error: String?
    @State private var task: Task<Void, Never>?
    @State private var requestID = UUID()
    @FocusState private var focused: Field?
    private enum Field { case email, password }

    private var email: Binding<String> {
        Binding(get: { setup.account.email }, set: { setup.updateEmail($0); error = nil })
    }
    private func field<Value>(_ keyPath: WritableKeyPath<MailAccount, Value>) -> Binding<Value> {
        Binding(get: { setup.account[keyPath: keyPath] }, set: { setup.set(keyPath, $0) })
    }
    private func server<Value>(_ keyPath: WritableKeyPath<MailAccount, Value>) -> Binding<Value> {
        Binding(get: { setup.account[keyPath: keyPath] }, set: { setup.setServer(keyPath, $0) })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("邮箱地址", text: email).keyboardType(.emailAddress).textContentType(.username)
                        .focused($focused, equals: .email).submitLabel(.next)
                        .onSubmit { focused = .password }.accessibilityIdentifier("email")
                    SecureField("密码 / 授权码", text: $password).textContentType(.password)
                        .focused($focused, equals: .password).submitLabel(.go)
                        .onSubmit { if !testing { connect() } }.accessibilityIdentifier("password")
                } header: {
                    Text("登录邮箱")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if setup.manualServers {
                            Label("使用手动服务器配置", systemImage: "slider.horizontal.3")
                        } else if let provider = setup.provider {
                            Label("已识别\(provider.title)，收发设置已自动填好", systemImage: "checkmark.circle")
                                .accessibilityIdentifier("provider-status")
                        } else if AccountSetup.suggestedDomain(email: setup.account.email) != nil {
                            Text("已按邮箱域名填好默认收发设置，添加时会验证；连接失败可在高级设置修改。")
                                .accessibilityIdentifier("provider-status")
                        } else {
                            Text("输入邮箱地址，自动填写收发设置。通常只需账号和密码／授权码。")
                        }
                        if let provider = setup.provider { Text(provider.passwordHint) }
                    }
                }.disabled(testing)

                Section {
                    if let error { Text(error).foregroundStyle(.red).font(.footnote).accessibilityIdentifier("account-error") }
                    Button(action: connect) {
                        HStack {
                            if testing { ProgressView() }
                            Text(testing ? "正在验证并添加…" : "添加邮箱").frame(maxWidth: .infinity)
                        }
                    }.disabled(testing || setup.account.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
                        .accessibilityIdentifier("validate-account")
                    if testing { Button("取消验证", role: .cancel) { cancelValidation() } }
                } footer: {
                    Text("点击添加后才会验证收发连接；成功后凭据保存在本机钥匙串，不发送测试邮件。")
                }

                Section {
                    DisclosureGroup(isExpanded: $advanced) {
                        TextField("发件人显示名称（选填）", text: field(\.displayName))
                        TextField("登录用户名", text: field(\.username)).keyboardType(.emailAddress)
                            .textContentType(.username).accessibilityIdentifier("login-username")
                        Text("收信 · IMAP").font(.subheadline).foregroundStyle(.secondary)
                        TextField("IMAP 服务器", text: server(\.imapHost)).keyboardType(.URL).accessibilityIdentifier("imap-host")
                        LabeledContent("端口") {
                            TextField("993", value: server(\.imapPort), format: .number.grouping(.never))
                                .keyboardType(.numberPad).multilineTextAlignment(.trailing).accessibilityIdentifier("imap-port")
                        }
                        Picker("收信加密", selection: server(\.imapSecurity)) {
                            ForEach(TransportSecurity.allCases) { Text($0.title).tag($0) }
                        }
                        Text("发信 · SMTP").font(.subheadline).foregroundStyle(.secondary)
                        TextField("SMTP 服务器", text: server(\.smtpHost)).keyboardType(.URL).accessibilityIdentifier("smtp-host")
                        LabeledContent("端口") {
                            TextField("465", value: server(\.smtpPort), format: .number.grouping(.never))
                                .keyboardType(.numberPad).multilineTextAlignment(.trailing).accessibilityIdentifier("smtp-port")
                        }
                        Picker("发信加密", selection: server(\.smtpSecurity)) {
                            ForEach(TransportSecurity.allCases) { Text($0.title).tag($0) }
                        }
                        if setup.provider != nil && setup.manualServers {
                            Button("恢复自动服务器设置") { setup.restoreAutomaticServers(); error = nil }
                        }
                        Text("请使用服务商提供的服务器域名。仅支持 TLS 1.2+ 或强制 STARTTLS，并校验服务器证书。")
                            .font(.footnote).foregroundStyle(.secondary)
                    } label: {
                        Text("高级设置（可选）")
                    }.accessibilityIdentifier("advanced-settings")
                }.disabled(testing)
            }
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .navigationTitle("添加邮箱").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { cancelValidation(); dismiss() } } }
            .interactiveDismissDisabled(testing)
            .onDisappear { cancelValidation(); password = "" }
        }
    }

    private func cancelValidation() {
        requestID = UUID(); task?.cancel(); task = nil; testing = false
    }
    private func connect() {
        guard !testing else { return }
        let account: MailAccount
        do {
            guard MailValidation.isAddress(setup.account.email.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                throw MailFailure.invalid("请填写完整的邮箱地址。")
            }
            guard !password.isEmpty else { throw MailFailure.invalid("请填写密码或邮箱授权码。") }
            account = try setup.preparedAccount()
        } catch {
            self.error = error.localizedDescription
            if setup.provider == nil { advanced = true; focused = nil }
            return
        }
        focused = nil; testing = true; error = nil
        let id = UUID(); requestID = id
        let credential = password
        task = Task {
            do {
                try await store.addAccount(account, password: credential)
                guard requestID == id, !Task.isCancelled else { return }
                password = ""; dismiss()
            } catch {
                guard requestID == id, !Task.isCancelled else { return }
                if setup.provider == nil { advanced = true }
                self.error = (error as? MailFailure)?.localizedDescription ??
                    "添加失败，请检查网络及密码／授权码，并确认邮箱已开启 IMAP/SMTP 服务。仍无法连接时，可在高级设置中核对服务器配置。"
            }
            if requestID == id { testing = false; task = nil }
        }
    }
}
