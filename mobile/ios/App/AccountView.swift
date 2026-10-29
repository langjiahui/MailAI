import SwiftUI
import MailAICore

struct AccountView: View {
    let store: MailStore
    var editingAccount: MailAccount? = nil
    var showServerSettingsOnOpen = false
    var onClose: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var setup = AccountSetup()
    @State private var password = ""
    @State private var advanced = false
    @State private var visiblePassword = false
    @State private var initialized = false
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
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "lock.shield").font(.system(size: 32)).foregroundStyle(MailTheme.blue)
                    Text(editingAccount == nil ? "连接你的邮箱" : "登录与发信偏好").font(.title2.bold())
                    Text("收发设置自动填写，连接成功后即可使用。").font(.subheadline).foregroundStyle(MailTheme.secondary)
                }.padding(.top, 12)
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("邮箱地址").font(.subheadline.weight(.medium))
                        TextField("邮箱地址", text: email).keyboardType(.emailAddress).textContentType(.username)
                            .focused($focused, equals: .email).submitLabel(.next).onSubmit { focused = .password }
                            .accessibilityIdentifier("email").padding(12).frame(minHeight: 48).background(MailTheme.canvas, in: RoundedRectangle(cornerRadius: 12))
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("密码 / 授权码").font(.subheadline.weight(.medium))
                        HStack {
                            Group {
                                if visiblePassword { TextField("密码 / 授权码", text: $password) }
                                else { SecureField("密码 / 授权码", text: $password) }
                            }.textContentType(.password).focused($focused, equals: .password).submitLabel(.go)
                                .onSubmit { if !testing { connect() } }.accessibilityIdentifier("password")
                            Button { visiblePassword.toggle() } label: {
                                Image(systemName: visiblePassword ? "eye.slash" : "eye")
                                    .dynamicTypeSize(.large ... .xxxLarge)
                                    .frame(width: 44, height: 44)
                            }.accessibilityLabel(visiblePassword ? "隐藏密码" : "显示密码")
                        }.padding(.leading, 12).background(MailTheme.canvas, in: RoundedRectangle(cornerRadius: 12))
                    }
                    if setup.manualServers {
                        Label("使用手动服务器配置", systemImage: "slider.horizontal.3").font(.footnote).foregroundStyle(MailTheme.secondary)
                    } else if let provider = setup.provider {
                        Label("已识别\(provider.title)，收发设置已自动填好", systemImage: "checkmark.circle.fill")
                            .font(.footnote).foregroundStyle(MailTheme.blue).accessibilityIdentifier("provider-status")
                    } else if AccountSetup.suggestedDomain(email: setup.account.email) != nil {
                        Label("默认收发设置 · 尚未验证", systemImage: "info.circle").font(.footnote).foregroundStyle(MailTheme.secondary).accessibilityIdentifier("provider-status")
                    }
                    if let provider = setup.provider { Text(provider.passwordHint).font(.footnote).foregroundStyle(MailTheme.secondary) }
                    if editingAccount != nil { Text("不修改密码可留空，保存时验证已有凭据。").font(.footnote).foregroundStyle(MailTheme.secondary) }
                }.disabled(testing)
                if let error { MailNotice(text: error, symbol: "exclamationmark.triangle", critical: true).accessibilityIdentifier("account-error") }
                VStack(spacing: 12) {
                    Button(action: connect) {
                        HStack(spacing: 8) { if testing { ProgressView().tint(.white) }; Text(testing ? "正在验证…" : (editingAccount == nil ? "验证并添加" : "验证并保存")) }
                    }.buttonStyle(MailPrimaryButton())
                        .disabled(testing || setup.account.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (password.isEmpty && editingAccount == nil))
                        .opacity(testing || setup.account.email.isEmpty || (password.isEmpty && editingAccount == nil) ? 0.5 : 1)
                        .accessibilityIdentifier("validate-account")
                    if testing { Button("取消验证", role: .cancel) { cancelValidation() }.frame(minHeight: 44) }
                    Button { focused = nil; advanced = true } label: { HStack { Text("高级设置（可选）"); Spacer(); Image(systemName: "chevron.right") }.font(.subheadline).frame(minHeight: 44) }.disabled(testing)
                }
                if editingAccount != nil {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("发信偏好").font(.headline)
                        labeled("发件人显示名称") { TextField("选填", text: field(\.displayName)) }
                        labeled("发件人签名") { TextField("选填", text: Binding(get: { setup.account.signature ?? "" }, set: { setup.set(\.signature, $0) }), axis: .vertical) }
                        Toggle("保存已发送副本", isOn: Binding(get: { setup.account.shouldSaveSentCopy }, set: { setup.set(\.saveSentCopy, $0) }))
                        labeled("已发送文件夹") { TextField("留空自动识别", text: Binding(get: { setup.account.sentFolder ?? "" }, set: { setup.set(\.sentFolder, $0.isEmpty ? nil : $0) })) }
                        Text("副本存档失败不会重复发送邮件。").font(.footnote).foregroundStyle(MailTheme.secondary)
                    }.disabled(testing)
                }
                Label("凭据仅保存在本机钥匙串，不发送测试邮件。", systemImage: "lock.shield").font(.footnote).foregroundStyle(MailTheme.secondary)
            }.padding(24).frame(maxWidth: 600)
        }.frame(maxWidth: .infinity).background(MailTheme.surface).scrollDismissesKeyboard(.interactively)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .onAppear { if !initialized { if let editingAccount { setup = AccountSetup(account: editingAccount) }; initialized = true; if showServerSettingsOnOpen { advanced = true } } }
            .navigationTitle(editingAccount == nil ? "添加邮箱" : "编辑邮箱").navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true).toolbar(.hidden, for: .tabBar)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消", action: cancelAndClose) } }
            .navigationDestination(isPresented: $advanced) { advancedSettings }
            .interactiveDismissDisabled(testing)
            .onDisappear { if !advanced { focused = nil; cancelValidation(); password = "" } }
    }
    private func labeled<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) { Text(title).font(.subheadline.weight(.medium)); content().padding(12).background(MailTheme.canvas, in: RoundedRectangle(cornerRadius: 12)) }
    }
    private var advancedSettings: some View {
        Form {
            Section("登录") {
                if editingAccount == nil { LabeledContent("显示名称") { TextField("选填", text: field(\.displayName)) } }
                LabeledContent("用户名") { TextField("登录用户名", text: field(\.username)).keyboardType(.emailAddress).accessibilityIdentifier("login-username") }
            }.listRowBackground(MailTheme.surface)
            Section("收信 · IMAP") {
                LabeledContent("服务器") { TextField("IMAP 服务器", text: server(\.imapHost)).keyboardType(.URL).accessibilityIdentifier("imap-host") }
                LabeledContent("端口") { TextField("993", value: server(\.imapPort), format: .number.grouping(.never)).keyboardType(.numberPad).accessibilityIdentifier("imap-port") }
                Picker("加密", selection: server(\.imapSecurity)) { ForEach(TransportSecurity.allCases) { Text($0.title).tag($0) } }
            }.listRowBackground(MailTheme.surface)
            Section("发信 · SMTP") {
                LabeledContent("服务器") { TextField("SMTP 服务器", text: server(\.smtpHost)).keyboardType(.URL).accessibilityIdentifier("smtp-host") }
                LabeledContent("端口") { TextField("465", value: server(\.smtpPort), format: .number.grouping(.never)).keyboardType(.numberPad).accessibilityIdentifier("smtp-port") }
                Picker("加密", selection: server(\.smtpSecurity)) { ForEach(TransportSecurity.allCases) { Text($0.title).tag($0) } }
            }.listRowBackground(MailTheme.surface)
            Section {
                if setup.manualServers { Button("恢复自动服务器设置") { setup.restoreAutomaticServers(); error = nil } }
                Text("使用服务商提供的服务器域名与加密设置。默认地址需要通过连接验证后才能使用。").font(.footnote).foregroundStyle(MailTheme.secondary)
            }.listRowBackground(MailTheme.surface)
        }.textInputAutocapitalization(.never).autocorrectionDisabled().multilineTextAlignment(.trailing)
            .scrollContentBackground(.hidden).background(MailTheme.canvas).navigationTitle("高级设置").navigationBarTitleDisplayMode(.inline)
    }

    private func close() {
        if let onClose { onClose() } else { dismiss() }
    }
    private func cancelAndClose() {
        password = ""
        focused = nil
        cancelValidation()
        close()
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
            guard !password.isEmpty || editingAccount != nil else { throw MailFailure.invalid("请填写密码或邮箱授权码。") }
            account = try setup.preparedAccount()
        } catch {
            self.error = error.localizedDescription
            if setup.provider == nil { focused = nil }
            return
        }
        focused = nil; testing = true; error = nil
        let id = UUID(); requestID = id
        let credential = password
        task = Task {
            do {
                if editingAccount == nil { try await store.addAccount(account, password: credential) }
                else { try await store.updateAccount(account, password: credential.isEmpty ? nil : credential) }
                guard requestID == id, !Task.isCancelled else { return }
                password = ""; close()
            } catch {
                guard requestID == id, !Task.isCancelled else { return }

                self.error = (error as? MailFailure)?.localizedDescription ??
                    "添加失败，请检查网络及密码／授权码，并确认邮箱已开启 IMAP/SMTP 服务。仍无法连接时，可在高级设置中核对服务器配置。"
            }
            if requestID == id { testing = false; task = nil }
        }
    }
}
