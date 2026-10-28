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
    @State private var quotedExpanded = false
    @State private var editor = ComposerEditorCommands()
    private var editable: Bool { store.draft.state == .editing && !store.sending }
    private func field(_ keyPath: WritableKeyPath<MailDraft, String>) -> Binding<String> {
        Binding(get: { store.draft[keyPath: keyPath] }, set: { value in store.updateDraft { $0[keyPath: keyPath] = value } })
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(spacing: 0) {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text("发件人").font(.subheadline).foregroundStyle(MailTheme.secondary).frame(width: 56, alignment: .leading)
                            Text(store.selected?.email ?? "").font(.subheadline).textSelection(.enabled); Spacer(minLength: 0)
                        }.frame(minHeight: 48)
                        Divider()
                        address("收件人", target: "to", binding: field(\.to))
                        if copies || !store.draft.cc.isEmpty || !store.draft.bcc.isEmpty {
                            Divider(); address("抄送", target: "cc", binding: field(\.cc))
                            Divider(); address("密送", target: "bcc", binding: field(\.bcc))
                        }
                        Button(copies ? "收起抄送与密送" : "抄送 / 密送") { copies.toggle() }.font(.caption).frame(maxWidth: .infinity, minHeight: 36, alignment: .trailing)
                        Divider()
                        HStack(spacing: 12) {
                            Text("主题").font(.subheadline).foregroundStyle(MailTheme.secondary).frame(width: 56, alignment: .leading)
                            TextField("填写主题", text: field(\.subject), axis: .vertical).accessibilityIdentifier("compose-subject")
                        }.frame(minHeight: 52)
                        Divider()
                    }.disabled(!editable)
                    if !store.draft.attachments.isEmpty {
                        VStack(spacing: 8) { ForEach(store.draft.attachments) { attachmentRow($0) } }.padding(.vertical, 12)
                    }
                    ZStack(alignment: .topLeading) {
                        if editingText.isEmpty { Text("填写邮件正文").foregroundStyle(.tertiary).padding(.top, 12).padding(.leading, 5).allowsHitTesting(false) }
                        RichComposerEditor(text: editingText, html: quotedText == nil ? store.draft.html : nil, editable: editable, commands: editor) { text, html in
                            store.updateDraft { draft in
                                let quote = quotedText ?? ""
                                draft.text = text + quote
                                draft.html = quote.isEmpty ? html : nil
                            }
                        }.frame(minHeight: 320).accessibilityIdentifier("compose-body")
                    }
                    if let quotedText {
                        DisclosureGroup("原邮件 · 点击展开", isExpanded: $quotedExpanded) {
                            Text(quotedText).font(.subheadline).foregroundStyle(MailTheme.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                        }.font(.subheadline).padding(.vertical, 12)
                    }
                    if let undoText, store.draft.text == adoptedText {
                        Button("撤回润色") { store.updateDraft { $0.text = undoText; $0.html = nil }; self.undoText = nil; adoptedText = nil }.font(.subheadline).frame(minHeight: 44)
                    }
                    VStack(alignment: .leading, spacing: 8) { status }.padding(.vertical, 16)
                    if let error { MailNotice(text: error).padding(.bottom, 12) }
                }.padding(.horizontal, 16)
            }.scrollDismissesKeyboard(.interactively)
            .navigationTitle("写邮件").navigationBarTitleDisplayMode(.inline)
                .background(MailTheme.surface)
                .safeAreaInset(edge: .bottom, spacing: 0) { composerTools }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("关闭") { confirmExit = true }.disabled(store.sending) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("发送", systemImage: "paperplane.fill") { do { _ = try store.draft.validateForSending(); confirmSend = true } catch { self.error = error.localizedDescription } }.disabled(!editable || (try? store.draft.validateForSending()) == nil).accessibilityIdentifier("send-mail")
                    }
                }
                .interactiveDismissDisabled(store.sending || store.draftSaveFailed || !store.draft.isEmpty)
                .confirmationDialog("发送这封邮件？", isPresented: $confirmSend, titleVisibility: .visible) {
                    Button("确认发送") { Task { do { try await store.send() } catch { self.error = error.localizedDescription } } }
                } message: { Text("收件人：\(store.draft.to)\n抄送：\(store.draft.cc.isEmpty ? "无" : store.draft.cc)\n密送：\(store.draft.bcc.isEmpty ? "无" : store.draft.bcc)\n\(store.draft.subject)\n附件：\(store.draft.attachments.count) 个") }
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
                .sheet(isPresented: $picking) { RecipientPicker(store: store) { emails in
                    for email in emails { switch recipientTarget { case "cc": store.updateDraft { $0.cc = append(email, to: $0.cc) }; case "bcc": store.updateDraft { $0.bcc = append(email, to: $0.bcc) }; default: store.updateDraft { $0.to = append(email, to: $0.to) } } }
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
    private var quotedText: String? {
        guard store.draft.inReplyTo != nil || store.draft.subject.lowercased().hasPrefix("fwd:") else { return nil }
        guard let range = store.draft.text.range(of: "\n\n—— 原邮件 ——\n") else { return nil }
        return String(store.draft.text[range.lowerBound...])
    }
    private var editingText: String {
        guard let quote = quotedText else { return store.draft.text }
        return String(store.draft.text.dropLast(quote.count))
    }
    private var composerTools: some View {
        HStack(spacing: 20) {
            Button { importDraftID = store.draft.id; importing = true } label: { Image(systemName: "paperclip").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("添加文件")
            PhotosPicker(selection: $photo, matching: .images) { Image(systemName: "photo").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("照片")
            Menu {
                Button("加粗", systemImage: "bold") { editor.format(.bold) }
                Button("斜体", systemImage: "italic") { editor.format(.italic) }
                Button("下划线", systemImage: "underline") { editor.format(.underline) }
            } label: { Text("Aa").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("文字格式")
            Button { assistantOriginal = store.draft.text; assistantDraftID = store.draft.id; assistant = true } label: { Label("小邮", systemImage: "sparkles").frame(minHeight: 44) }.disabled(store.draft.text.isEmpty)
            Spacer(minLength: 0)
            Button { editor.dismissKeyboard() } label: { Image(systemName: "keyboard.chevron.compact.down").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("收起键盘")
        }.font(.callout).padding(.horizontal, 8).background(MailTheme.surface).overlay(alignment: .top) { Divider() }.disabled(!editable)
    }
    private func attachmentRow(_ item: MailAttachment) -> some View {
        HStack(spacing: 12) {
            Button { Task { do { previewURL = try previewFile(name: item.name, data: await store.attachmentData(item)) } catch { self.error = error.localizedDescription } } } label: {
                Label { VStack(alignment: .leading, spacing: 3) { Text(item.name).lineLimit(1); Text(ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)).font(.caption).foregroundStyle(MailTheme.secondary) } } icon: { Image(systemName: "doc.text").font(.title3) }
            }.buttonStyle(.plain)
            Spacer()
            if editable { Button { store.updateDraft { $0.attachments.removeAll { $0.id == item.id } } } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel("移除附件 \(item.name)") }
        }.padding(.leading, 12).background(MailTheme.canvas, in: RoundedRectangle(cornerRadius: 10))
    }
    private func address(_ title: String, target: String, binding: Binding<String>) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(title).font(.subheadline).foregroundStyle(MailTheme.secondary).frame(width: 56, alignment: .leading).padding(.top, 14)
            RecipientEntry(value: binding, identifier: "compose-" + target).padding(.vertical, 6)
            Button { editor.dismissKeyboard(); recipientTarget = target; picking = true } label: { Image(systemName: "person.crop.circle.badge.plus").frame(width: 44, height: 44) }.accessibilityLabel("选择\(title)")
        }.frame(minHeight: 48)
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
    let store: MailStore; let selected: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var phone = false
    @State private var chosen = Set<String>()
    @State private var phoneAddresses: [MailAddress] = []
    private var addresses: [MailAddress] {
        var seen = Set<String>()
        return (phoneAddresses + store.contacts.map { MailAddress(name: $0.title, email: $0.email) }).filter { seen.insert($0.email.lowercased()).inserted }
    }
    var body: some View {
        NavigationStack {
            List {
                Button("从手机联系人选择", systemImage: "person.crop.circle") { phone = true }
                Section("最近联系人") {
                    ForEach(addresses.filter { query.isEmpty || ($0.name + $0.email).localizedCaseInsensitiveContains(query) }, id: \.email) { address in
                        Button { if chosen.contains(address.email) { chosen.remove(address.email) } else { chosen.insert(address.email) } } label: {
                            HStack(spacing: 12) {
                                SenderAvatar(name: address.name.isEmpty ? address.email : address.name)
                                VStack(alignment: .leading, spacing: 4) { Text(address.name.isEmpty ? address.email : address.name).foregroundStyle(MailTheme.ink); Text(address.email).font(.caption).foregroundStyle(MailTheme.secondary) }
                                Spacer(); Image(systemName: chosen.contains(address.email) ? "checkmark.circle.fill" : "circle").font(.title3)
                            }.frame(minHeight: 48)
                        }.accessibilityValue(chosen.contains(address.email) ? "已选择" : "未选择")
                    }
                }
            }.listStyle(.plain).searchable(text: $query, prompt: "姓名或邮箱").navigationTitle("选择联系人").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("完成（\(chosen.count)）") { selected(addresses.filter { chosen.contains($0.email) }.map(\.email)); dismiss() }.disabled(chosen.isEmpty) }
                }
                .sheet(isPresented: $phone) { PhoneContactPicker { address in phoneAddresses.append(address); chosen.insert(address.email); phone = false } }
        }
    }
}
/// Every keystroke remains in the draft. Chips commit only on submit, separator or focus loss.
struct RecipientEntry: View {
    @Binding var value: String
    let identifier: String
    @State private var chips: [String] = []
    @State private var input = ""
    @FocusState private var focused: Bool
    private var serialized: String { (chips + (input.isEmpty ? [] : [input])).joined(separator: ", ") }
    var body: some View {
        RecipientFlow(spacing: 6) {
            ForEach(chips, id: \.self) { email in
                HStack(spacing: 4) {
                    Text(email).lineLimit(1).truncationMode(.middle)
                    Button { chips.removeAll { $0 == email }; persist() } label: { Image(systemName: "xmark").font(.caption).frame(minWidth: 28, minHeight: 36) }.accessibilityLabel("移除收件人 \(email)")
                }.font(.subheadline).padding(.leading, 8).foregroundStyle(MailTheme.blue).background(MailTheme.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
            }
            TextField(chips.isEmpty ? "填写邮箱" : "添加", text: $input).font(.subheadline).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused).submitLabel(.done)
                .frame(minWidth: 90, minHeight: 36).accessibilityIdentifier(identifier + "-input")
                .onSubmit { commit() }
                .onChange(of: input) { _, newValue in if newValue.last.map({ ",;，；".contains($0) }) == true { commit() } else { persist() } }
                .onChange(of: focused) { _, active in if !active { commit() } }
        }.accessibilityElement(children: .contain).accessibilityIdentifier(identifier).accessibilityValue(value)
            .onAppear { load() }.onChange(of: value) { _, newValue in if newValue != serialized { load() } }
    }
    private func persist() { if value != serialized { value = serialized } }
    private func load() {
        let parts = value.split(whereSeparator: { ",;，；".contains($0) }).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        chips = []; var remaining: [String] = []
        for part in parts { if MailValidation.isAddress(part) { if !chips.contains(part) { chips.append(part) } } else { remaining.append(part) } }
        input = remaining.joined(separator: ", ")
    }
    private func commit() {
        let parts = input.split(whereSeparator: { ",;，；".contains($0) }).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        var remaining: [String] = []
        for part in parts { if MailValidation.isAddress(part) { if !chips.contains(where: { $0.lowercased() == part.lowercased() }) { chips.append(part) } } else { remaining.append(part) } }
        input = remaining.joined(separator: ", "); persist()
    }
}
struct RecipientFlow: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize { arrange(width: proposal.width ?? 260, subviews: subviews).size }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let layout = arrange(width: bounds.width, subviews: subviews)
        for (index, point) in layout.positions.enumerated() { subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: ProposedViewSize(width: min(subviews[index].sizeThatFits(.unspecified).width, bounds.width), height: nil)) }
    }
    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let width = max(1, width); var x: CGFloat = 0; var y: CGFloat = 0; var height: CGFloat = 0; var positions: [CGPoint] = []
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
            let itemWidth = min(size.width, width)
            if x > 0 && x + itemWidth > width { y += height + spacing; x = 0; height = 0 }
            positions.append(CGPoint(x: x, y: y)); x += itemWidth + spacing; height = max(height, size.height)
        }
        return (CGSize(width: width, height: y + height), positions)
    }
}
