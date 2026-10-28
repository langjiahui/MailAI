import SwiftUI
import MailAICore
import UniformTypeIdentifiers
import PhotosUI
import QuickLook

struct ComposerView: View {
    @Bindable var store: MailStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSend = false
    @State private var confirmExit = false
    @State private var confirmRetry = false
    @State private var copies = false
    @State private var importing = false
    @State private var photoTask: Task<Void, Never>?
    @State private var importDraftID = ""
    @State private var photo: PhotosPickerItem?
    @State private var previewURL: URL?
    @State private var picking = false
    @State private var recipientTarget = "to"
    @State private var assistant = false
    @State private var assistantOriginal = ""
    @State private var assistantDraftID = ""
    @State private var undoText: String?
    @State private var adoptedText: String?
    @State private var error: String?
    private var editable: Bool { store.draft.state == .editing && !store.sending }
    private func field(_ keyPath: WritableKeyPath<MailDraft, String>) -> Binding<String> {
        Binding(get: { store.draft[keyPath: keyPath] }, set: { value in store.updateDraft { $0[keyPath: keyPath] = value } })
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("发件人", value: store.selected?.email ?? "")
                    address("收件人", target: "to", binding: field(\.to))
                    if copies || !store.draft.cc.isEmpty || !store.draft.bcc.isEmpty {
                        address("抄送", target: "cc", binding: field(\.cc))
                        address("密送", target: "bcc", binding: field(\.bcc))
                    }
                    Button(copies ? "收起抄送与密送" : "添加抄送／密送") { copies.toggle() }.font(.caption)
                    TextField("主题", text: field(\.subject)).accessibilityIdentifier("compose-subject")
                }.disabled(!editable)
                Section("正文") {
                    RichComposerEditor(text: store.draft.text, html: store.draft.html, editable: editable) { text, html in
                        store.updateDraft { $0.text = text; $0.html = html }
                    }.frame(minHeight: 280).accessibilityIdentifier("compose-body")
                    if editable {
                        HStack {
                            Button("小邮润色", systemImage: "sparkles") { assistantOriginal = store.draft.text; assistantDraftID = store.draft.id; assistant = true }.disabled(store.draft.text.isEmpty)
                            Spacer()
                            if let undoText, store.draft.text == adoptedText {
                                Button("撤回润色") { store.updateDraft { $0.text = undoText; $0.html = nil }; self.undoText = nil; adoptedText = nil }
                            }
                        }.font(.subheadline)
                        Text("长按选中文字可使用系统格式菜单，支持加粗、斜体与下划线。").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("附件 \(store.draft.attachments.count)/20") {
                    ForEach(store.draft.attachments) { item in
                        HStack {
                            Button { Task { do { previewURL = try previewFile(name: item.name, data: await store.attachmentData(item)) } catch { self.error = error.localizedDescription } } } label: {
                                Label { VStack(alignment: .leading) { Text(item.name).lineLimit(2); Text(ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)).font(.caption).foregroundStyle(.secondary) } } icon: { Image(systemName: "doc") }
                            }.buttonStyle(.plain)
                            Spacer()
                            if editable { Button { store.updateDraft { $0.attachments.removeAll { $0.id == item.id } } } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.borderless).accessibilityLabel("移除附件 \(item.name)") }
                        }
                    }
                    if editable {
                        HStack {
                            Button("添加文件", systemImage: "paperclip") { importDraftID = store.draft.id; importing = true }
                            Spacer()
                            PhotosPicker(selection: $photo, matching: .images) { Label("照片", systemImage: "photo") }
                        }
                        Text("单个 15 MB、合计 25 MB。附件先保存到本机，发送前会核对完整性。").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section { status }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote).textSelection(.enabled) } }
            }.navigationTitle("写邮件").navigationBarTitleDisplayMode(.inline)
                .scrollContentBackground(.hidden).background(MailTheme.canvas)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("关闭") { confirmExit = true }.disabled(store.sending) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("发送", systemImage: "paperplane.fill") { do { _ = try store.draft.validateForSending(); confirmSend = true } catch { self.error = error.localizedDescription } }.disabled(!editable).accessibilityIdentifier("send-mail")
                    }
                }
                .interactiveDismissDisabled(store.sending || store.draftSaveFailed)
                .confirmationDialog("发送这封邮件？", isPresented: $confirmSend, titleVisibility: .visible) {
                    Button("确认发送") { Task { do { try await store.send() } catch { self.error = error.localizedDescription } } }
                } message: { Text("收件人：\(store.draft.to)\n抄送：\(store.draft.cc.isEmpty ? "无" : store.draft.cc)\n密送：\(store.draft.bcc.isEmpty ? "无" : store.draft.bcc)\n\(store.draft.subject)") }
                .confirmationDialog("离开写信？", isPresented: $confirmExit, titleVisibility: .visible) {
                    Button("保存并返回") { do { try store.saveDraft(); dismiss() } catch { self.error = error.localizedDescription } }
                    Button("继续编辑", role: .cancel) {}
                    if store.draft.state == .editing || store.draft.state == .sent {
                        Button("放弃本地草稿／记录", role: .destructive) { do { try store.discardDraft(store.draft.id); dismiss() } catch { self.error = error.localizedDescription } }
                    }
                }
                .confirmationDialog("仅在确认上一封没有送达后继续，避免重复发送。", isPresented: $confirmRetry, titleVisibility: .visible) {
                    Button("确认未送达，解除发送锁定") { do { try store.resolveUncertain() } catch { self.error = error.localizedDescription } }
                }
                .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                    do { guard store.draft.id == importDraftID, editable else { throw MailFailure.invalid("草稿已改变，文件未添加。") }; for url in try result.get() { try importFile(url) } } catch { self.error = "部分文件未添加：\(error.localizedDescription)" }
                }
                .onChange(of: photo) { _, value in
                    guard let value else { return }
                    let draftID = store.draft.id, accountID = store.selectedID
                    photoTask?.cancel()
                    photoTask = Task {
                        do {
                            if let data = try await value.loadTransferable(type: Data.self) {
                                try Task.checkCancellation()
                                guard store.draft.id == draftID, store.selectedID == accountID, editable else { throw MailFailure.invalid("草稿已改变，照片未添加。") }
                                try store.addAttachment(name: "照片.\(value.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg")", mimeType: value.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg", data: data)
                            }
                        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
                        if !Task.isCancelled { photo = nil }
                    }
                }
                .sheet(isPresented: $picking) { RecipientPicker(store: store) { email in
                    switch recipientTarget { case "cc": store.updateDraft { $0.cc = append(email, to: $0.cc) }; case "bcc": store.updateDraft { $0.bcc = append(email, to: $0.bcc) }; default: store.updateDraft { $0.to = append(email, to: $0.to) } }
                } }
                .sheet(isPresented: $assistant) { AssistantPanel(text: assistantOriginal, composing: true) { output in
                    guard editable, store.draft.id == assistantDraftID, store.draft.text == assistantOriginal else { return false }
                    undoText = assistantOriginal; adoptedText = output; store.updateDraft { $0.text = output; $0.html = nil }; return true
                } }
                .quickLookPreview($previewURL)
                .onDisappear { photoTask?.cancel() }
        }
    }
    @ViewBuilder private var status: some View {
        switch store.draft.state {
        case .editing:
            if store.draftSaveFailed {
                Label("草稿尚未保存，请保留当前页面", systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                Button("重试保存") { do { try store.saveDraft() } catch { self.error = error.localizedDescription } }
            } else { Label("草稿自动保存在本机", systemImage: "checkmark.circle").font(.footnote).foregroundStyle(.secondary) }
        case .submitting: HStack { ProgressView(); Text("正在提交，请等待服务器确认…") }
        case .uncertain:
            Label("发送结果待确认", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            Text("请先核对收件方或服务器已发送邮件。不会自动重发。服务器已发送无副本也不代表未送达。").font(.footnote)
            Button("已确认未送达，继续编辑") { confirmRetry = true }
        case .sent:
            Label("服务器已接受邮件", systemImage: "checkmark.circle.fill").foregroundStyle(MailTheme.blue)
            if store.draft.sentCopyPending == true {
                Text("已发送副本待保存；重试存档不会重新发送邮件。").font(.footnote)
                Button("重试保存副本") { Task { do { try await store.retrySentCopy() } catch { self.error = error.localizedDescription } } }.disabled(store.sending)
            }
            Button("写一封新邮件") { do { try store.newDraft() } catch { self.error = error.localizedDescription } }
        }
    }
    private func address(_ title: String, target: String, binding: Binding<String>) -> some View {
        HStack(alignment: .top) {
            TextField(title, text: binding, axis: .vertical).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("compose-" + target)
            Button { recipientTarget = target; picking = true } label: { Image(systemName: "person.crop.circle.badge.plus") }.buttonStyle(.borderless).accessibilityLabel("选择\(title)")
        }
    }
    private func append(_ email: String, to current: String) -> String {
        let all = [store.draft.to, store.draft.cc, store.draft.bcc].joined(separator: ",").lowercased().split(whereSeparator: { ",;，；".contains($0) }).map { $0.trimmingCharacters(in: .whitespaces) }
        guard !all.contains(email.lowercased()) else { return current }
        return current.isEmpty ? email : current + ", " + email
    }
    private func importFile(_ url: URL) throws {
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        let info = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey, .isRegularFileKey])
        guard info.isRegularFile == true, (info.fileSize ?? Int.max) <= MailAttachment.singleLimit else { throw MailFailure.invalid("文件不可读或超过 15 MB。") }
        try store.addAttachment(name: url.lastPathComponent, mimeType: info.contentType?.preferredMIMEType ?? "application/octet-stream", data: Data(contentsOf: url))
    }
}
struct RecipientPicker: View {
    let store: MailStore; let selected: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var phone = false
    var body: some View {
        NavigationStack {
            List {
                Button("从手机联系人选择") { phone = true }
                ForEach(store.contacts.filter { query.isEmpty || ($0.title + $0.email).localizedCaseInsensitiveContains(query) }) { contact in
                    Button { selected(contact.email); dismiss() } label: { VStack(alignment: .leading) { Text(contact.title); Text(contact.email).font(.caption).foregroundStyle(.secondary) } }
                }
            }.searchable(text: $query, prompt: "搜索往来联系人").navigationTitle("选择联系人")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
                .sheet(isPresented: $phone) { PhoneContactPicker { address in selected(address.email); dismiss() } }
        }
    }
}
