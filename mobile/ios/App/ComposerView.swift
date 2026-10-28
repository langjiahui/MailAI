import SwiftUI
import MailAICore
import UniformTypeIdentifiers
import PhotosUI
import QuickLook

struct ComposerView: View {
    @Bindable var store: MailStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
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
    @State private var assistantFullDraft = ""
    @State private var assistantQuote = ""
    @State private var undoHTML: String?
    @State private var undoDraftID = ""
    @State private var undoText: String?
    @State private var adoptedText: String?
    @State private var error: String?
    @State private var quotedExpanded = false
    @State private var editor = ComposerEditorCommands()
    private var showingResult: Bool { store.draft.state == .sent || store.draft.state == .uncertain }
    private var editable: Bool { store.draft.state == .editing && !store.sending }
    private func field(_ keyPath: WritableKeyPath<MailDraft, String>) -> Binding<String> {
        Binding(get: { store.draft[keyPath: keyPath] }, set: { value in store.updateDraft { $0[keyPath: keyPath] = value } })
    }
    var body: some View {
        NavigationStack {
            Group {
                if showingResult { submissionResult }
                else { editorContent }
            }
            .navigationTitle(store.draft.state == .sent ? "发送完成" : (store.draft.state == .uncertain ? "发送结果待确认" : "写邮件")).navigationBarTitleDisplayMode(.inline)
                .background(MailTheme.surface)
                .safeAreaInset(edge: .bottom, spacing: 0) { if !showingResult { composerTools } }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("关闭") { confirmExit = true }.disabled(store.sending) }
                    ToolbarItem(placement: .confirmationAction) {
                        if !showingResult { Button("发送", systemImage: "paperplane.fill") { do { _ = try store.draft.validateForSending(); confirmSend = true } catch { self.error = error.localizedDescription } }.disabled(!editable || (try? store.draft.validateForSending()) == nil).accessibilityIdentifier("send-mail") }
                    }
                }
                .interactiveDismissDisabled(store.sending || store.draftSaveFailed || !store.draft.isEmpty)
                .confirmationDialog("发送这封邮件？", isPresented: $confirmSend, titleVisibility: .visible) {
                    Button("确认发送") { Task { do { try await store.send() } catch { self.error = error.localizedDescription } } }
                    Button("取消", role: .cancel) {}
                } message: { Text("发件人：\(store.selected?.email ?? "")\n收件人：\(store.draft.to)\n抄送：\(store.draft.cc.isEmpty ? "无" : store.draft.cc)\n密送：\(store.draft.bcc.isEmpty ? "无" : store.draft.bcc)\n\(store.draft.subject)\n附件：\(store.draft.attachments.count) 个") }
                .confirmationDialog("离开写信？", isPresented: $confirmExit, titleVisibility: .visible) {
                    Button("保存并返回") { do { try store.saveDraft(); dismiss() } catch { self.error = error.localizedDescription } }
                    Button(store.draft.state == .editing ? "继续编辑" : "继续查看", role: .cancel) {}
                    if store.draft.state == .editing || store.draft.state == .sent {
                        Button(store.draft.state == .editing ? "放弃草稿" : "删除本机发送记录", role: .destructive) { do { try store.discardDraft(store.draft.id); dismiss() } catch { self.error = error.localizedDescription } }
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
                    guard editable, store.draft.id == assistantDraftID, store.draft.text == assistantFullDraft else { return false }
                    undoText = assistantFullDraft; undoHTML = store.draft.html; undoDraftID = store.draft.id
                    adoptedText = output + assistantQuote
                    store.updateDraft { $0.text = output + assistantQuote; $0.html = nil }; return true
                } }
                .quickLookPreview($previewURL)
                .onDisappear { photoTask?.cancel() }
        }
    }
    private var editorContent: some View {
        ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(spacing: 0) {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) { fieldLabel("发件人"); Text(store.selected?.email ?? "").font(.subheadline).lineLimit(1).fixedSize(); Spacer(minLength: 0) }.frame(minHeight: 48)
                            VStack(alignment: .leading, spacing: 8) { fieldLabel("发件人"); Text(store.selected?.email ?? "").font(.subheadline).textSelection(.enabled) }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                        }
                        Divider()
                        address("收件人", target: "to", binding: field(\.to))
                        if copies || !store.draft.cc.isEmpty || !store.draft.bcc.isEmpty {
                            Divider(); address("抄送", target: "cc", binding: field(\.cc))
                            Divider(); address("密送", target: "bcc", binding: field(\.bcc))
                        }
                        Button(copies ? "收起抄送与密送" : "抄送 / 密送") { copies.toggle() }.font(.caption).frame(maxWidth: .infinity, minHeight: 36, alignment: .trailing)
                        Divider()
                        if dynamicTypeSize.isAccessibilitySize {
                            VStack(alignment: .leading, spacing: 8) { fieldLabel("主题"); subjectField }.padding(.vertical, 12)
                        } else { HStack(spacing: 12) { fieldLabel("主题").frame(width: 56, alignment: .leading); subjectField }.frame(minHeight: 52) }
                        Divider()
                    }.disabled(!editable)
                    if !store.draft.attachments.isEmpty {
                        VStack(spacing: 8) { ForEach(store.draft.attachments) { attachmentRow($0) } }.padding(.vertical, 12)
                    }
                    ZStack(alignment: .topLeading) {
                        if editingText.isEmpty { Text("填写邮件正文").foregroundStyle(.tertiary).padding(.top, 12).padding(.leading, 5).allowsHitTesting(false) }
                        RichComposerEditor(text: editingText, html: editingHTML, editable: editable, commands: editor) { text, html in
                            store.updateDraft { draft in
                                let quote = quotedText ?? ""
                                draft.text = text + quote
                                draft.html = htmlWithQuote(html, quote: quote)
                            }
                        }.frame(minHeight: 320).accessibilityIdentifier("compose-body")
                    }
                    if let quotedText {
                        DisclosureGroup("原邮件 · 点击展开", isExpanded: $quotedExpanded) {
                            Text(quotedText).font(.subheadline).foregroundStyle(MailTheme.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                        }.font(.subheadline).padding(.vertical, 12)
                    }
                    if let undoText, store.draft.id == undoDraftID, store.draft.text == adoptedText {
                        Button("撤回润色") { store.updateDraft { $0.text = undoText; $0.html = undoHTML }; self.undoText = nil; undoHTML = nil; adoptedText = nil }.font(.subheadline).frame(minHeight: 44)
                    }
                    VStack(alignment: .leading, spacing: 8) { status }.padding(.vertical, 16)
                    if let error { MailNotice(text: error, critical: true).padding(.bottom, 12) }
                }.padding(.horizontal, 16)
            }.scrollDismissesKeyboard(.interactively)
    }
    private var submissionResult: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(spacing: 16) {
                    Image(systemName: store.draft.state == .sent ? "checkmark" : "exclamationmark")
                        .font(.system(size: 32, weight: .semibold)).foregroundStyle(store.draft.state == .sent ? MailTheme.blue : .orange)
                        .frame(width: 76, height: 76).background((store.draft.state == .sent ? MailTheme.blue : .orange).opacity(0.10), in: Circle())
                    Text(store.draft.state == .sent ? "服务器已接受邮件" : "发送结果待确认").font(.title2.bold())
                    Text(store.draft.state == .sent ? "邮件已提交给服务器，尚不代表收件人已阅读或已送达对方。" : "尚未收到明确的服务器结果。请先核对收件方或服务器，避免重复发送。")
                        .font(.subheadline).foregroundStyle(MailTheme.secondary).multilineTextAlignment(.center)
                }.frame(maxWidth: .infinity).padding(.top, 24)
                VStack(alignment: .leading, spacing: 12) {
                    resultField("收件人", value: store.draft.to)
                    if !store.draft.cc.isEmpty { resultField("抄送", value: store.draft.cc) }
                    if !store.draft.bcc.isEmpty { resultField("密送", value: store.draft.bcc) }
                    resultField("主题", value: store.draft.subject.isEmpty ? "（无主题）" : store.draft.subject)
                    if let date = store.draft.updatedAt { resultField("时间", value: date.formatted(date: .abbreviated, time: .shortened)) }
                    resultField("附件", value: "\(store.draft.attachments.count) 个 · " + ByteCountFormatter.string(fromByteCount: Int64(store.draft.attachments.reduce(0) { $0 + $1.size }), countStyle: .file))
                }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(MailTheme.canvas, in: RoundedRectangle(cornerRadius: 12))
                DisclosureGroup("查看邮件内容") {
                    Text(store.draft.text).font(.body).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                    ForEach(store.draft.attachments) { item in attachmentRow(item) }
                }.font(.subheadline)
                VStack(alignment: .leading, spacing: 16) { status }
                if let error { MailNotice(text: error, critical: true) }
                Button("返回邮件") { dismiss() }.frame(maxWidth: .infinity, minHeight: 48).buttonStyle(.bordered)
            }.padding(24)
        }
    }
    private func resultField(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) { Text(title).font(.caption).foregroundStyle(MailTheme.secondary); Text(value).font(.subheadline).textSelection(.enabled) }
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
            Text("请先核对收件方或服务器已发送邮件。不会自动重发。服务器已发送无副本也不代表未送达。").font(.footnote)
            Button("已确认未送达，继续编辑") { confirmRetry = true }.buttonStyle(.bordered).frame(maxWidth: .infinity, minHeight: 48)
        case .sent:
            if store.draft.sentCopyPending == true {
                Text("已发送副本待保存；重试存档不会重新发送邮件。").font(.footnote)
                Button("重试保存副本") { Task { do { try await store.retrySentCopy() } catch { self.error = error.localizedDescription } } }.buttonStyle(MailPrimaryButton()).disabled(store.sending)
            }
            Button("写一封新邮件") { do { try store.newDraft() } catch { self.error = error.localizedDescription } }
        }
    }
    private static let quoteHTMLMarker = "<!--MailAI-quoted-original-->"
    private var editingHTML: String? {
        guard quotedText != nil else { return store.draft.html }
        guard let html = store.draft.html, let marker = html.range(of: Self.quoteHTMLMarker) else { return nil }
        return String(html[..<marker.lowerBound]) + "</body></html>"
    }
    private func htmlWithQuote(_ html: String?, quote: String) -> String? {
        guard !quote.isEmpty else { return html }
        guard var html else { return nil }
        let suffix = "</body></html>"
        if html.hasSuffix(suffix) { html.removeLast(suffix.count) }
        let escaped = quote.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\n", with: "<br>")
        return html + Self.quoteHTMLMarker + "<blockquote>" + escaped + "</blockquote>" + suffix
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
        HStack(spacing: 0) {
            Menu {
                Button("选择文件", systemImage: "doc") { importDraftID = store.draft.id; importing = true }
                PhotosPicker(selection: $photo, matching: .images) { Label("从照片选择", systemImage: "photo") }
            } label: { Image(systemName: "paperclip").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("添加附件").frame(maxWidth: .infinity)
            PhotosPicker(selection: $photo, matching: .images) { Image(systemName: "photo").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("照片").frame(maxWidth: .infinity)
            Menu {
                Button("加粗", systemImage: "bold") { editor.format(.bold) }
                Button("斜体", systemImage: "italic") { editor.format(.italic) }
                Button("下划线", systemImage: "underline") { editor.format(.underline) }
            } label: { Text("Aa").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("文字格式").frame(maxWidth: .infinity)
            Button { assistantOriginal = editingText; assistantFullDraft = store.draft.text; assistantQuote = quotedText ?? ""; assistantDraftID = store.draft.id; assistant = true } label: { Group { if dynamicTypeSize.isAccessibilitySize { Image(systemName: "sparkles") } else { Label("小邮", systemImage: "sparkles") } }.frame(minHeight: 44) }.accessibilityLabel("小邮润色").disabled(store.draft.text.isEmpty).frame(maxWidth: .infinity)
            Button { editor.dismissKeyboard() } label: { Image(systemName: "keyboard.chevron.compact.down").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("收起键盘").frame(maxWidth: .infinity)
        }.font(.callout).dynamicTypeSize(...DynamicTypeSize.xxxLarge).padding(.horizontal, 8).background(MailTheme.surface).overlay(alignment: .top) { Divider() }.disabled(!editable)
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
    private func fieldLabel(_ title: String) -> some View { Text(title).font(.subheadline).foregroundStyle(MailTheme.secondary).fixedSize(horizontal: true, vertical: false) }
    private var subjectField: some View { TextField("填写主题", text: field(\.subject), axis: .vertical).accessibilityIdentifier("compose-subject") }
    private func recipientButton(_ title: String, target: String) -> some View {
        Button { editor.dismissKeyboard(); recipientTarget = target; picking = true } label: { Image(systemName: "person.crop.circle.badge.plus").font(.body).frame(width: 44, height: 44) }.accessibilityLabel("选择\(title)")
    }
    @ViewBuilder private func address(_ title: String, target: String, binding: Binding<String>) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                HStack { fieldLabel(title); Spacer(); recipientButton(title, target: target) }
                RecipientEntry(value: binding, identifier: "compose-" + target)
            }.padding(.vertical, 8)
        } else {
            HStack(alignment: .top, spacing: 8) {
                fieldLabel(title).frame(width: 56, alignment: .leading).padding(.top, 14)
                RecipientEntry(value: binding, identifier: "compose-" + target).padding(.vertical, 6)
                recipientButton(title, target: target)
            }.frame(minHeight: 48)
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
    let store: MailStore; let selected: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var phone = false
    @State private var chosen = Set<String>()
    @State private var phoneAddresses: [MailAddress] = []
    private var addresses: [MailAddress] {
        var seen = Set<String>()
        return (phoneAddresses + store.contacts.map { MailAddress(name: $0.name.isEmpty ? $0.title : $0.name, email: $0.email) }).filter { seen.insert($0.email.lowercased()).inserted }
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
                        }.accessibilityIdentifier("recipient-" + address.email).accessibilityValue(chosen.contains(address.email) ? "已选择" : "未选择").listRowBackground(MailTheme.surface)
                    }
                }
            }.listStyle(.plain).scrollContentBackground(.hidden).background(MailTheme.surface)
                .safeAreaInset(edge: .top, spacing: 0) { MailSearchField(text: $query, prompt: "姓名或邮箱").padding(.horizontal, 16).padding(.vertical, 8).background(MailTheme.surface) }
                .navigationTitle("选择联系人").navigationBarTitleDisplayMode(.inline)
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
                    Button { chips.removeAll { $0 == email }; persist() } label: { Image(systemName: "xmark").font(.caption).frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("移除收件人 \(email)")
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
