import SwiftUI
import WebKit
import QuickLook
import MailAICore

struct ReaderView: View {
    let store: MailStore
    let summary: MailSummary
    @State private var ownerID: UUID?
    @State private var adoptedReply = false
    init(store: MailStore, summary: MailSummary) { self.store = store; self.summary = summary; _ownerID = State(initialValue: store.selectedID) }
    @State private var bodyContent: MailBody?
    @State private var error: String?
    @State private var plainText = false
    @State private var details = false
    @State private var composing = false
    @State private var retry = 0
    @State private var externalURL: URL?
    @State private var previewURL: URL?
    @State private var downloading = false
    @State private var assistant = false
    @State private var moving = false
    @State private var readTask: Task<Void, Never>?
    @State private var downloadTask: Task<Void, Never>?
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("mail.readerSize") private var readerSize = 17.0
    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Text(summary.subject).font(.title2.bold()).textSelection(.enabled)
                HStack(alignment: .top, spacing: 12) {
                    SenderAvatar(name: summary.senderName ?? summary.sender)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(summary.sender).font(.subheadline).textSelection(.enabled)
                        if let date = summary.date { Text(date.formatted()).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Button { details.toggle() } label: { Image(systemName: details ? "chevron.up.circle" : "chevron.down.circle") }.accessibilityLabel("邮件详细信息")
                }
                if details {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("发件人：" + summary.sender)
                            Text("收件人：" + (bodyContent?.recipients ?? summary.recipients ?? []).map { $0.name.isEmpty ? $0.email : $0.name + " <" + $0.email + ">" }.joined(separator: "; "))
                            if let cc = bodyContent?.carbonCopies ?? summary.carbonCopies, !cc.isEmpty { Text("抄送：" + cc.map(\.email).joined(separator: "; ")) }
                        }.font(.caption).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(maxHeight: 120)
                }
            }.padding(18).background(MailTheme.surface)
            Divider()
            if let bodyContent {
                if let html = bodyContent.html, !plainText { SafeMailHTML(html: html, externalURL: $externalURL) }
                else {
                    ScrollView { Text(bodyContent.text.isEmpty ? "这封邮件没有纯文本正文，可切换原版查看。" : bodyContent.text)
                        .font(.system(size: readerSize)).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled).padding(18) }
                }
                if let attachments = bodyContent.attachments, !attachments.isEmpty {
                    DisclosureGroup("附件（\(attachments.count)）") {
                        ScrollView {
                            VStack(spacing: 8) {
                                ForEach(attachments) { item in
                                    Button { download(item) } label: {
                                        HStack { Image(systemName: "doc"); Text(item.name).lineLimit(2); Spacer(); Text(ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)).font(.caption).foregroundStyle(.secondary); Image(systemName: "arrow.down.circle") }
                                    }.disabled(downloading)
                                }
                            }
                        }.frame(maxHeight: 150)
                    }.padding().background(MailTheme.canvas)
                }
            } else if let error {
                ContentUnavailableView { Label("暂时无法阅读", systemImage: "wifi.exclamationmark") } description: { Text(error) } actions: { Button("重试") { retry += 1 } }
            } else { Spacer(); ProgressView("加载正文…"); Spacer() }
            if downloading { HStack { ProgressView(); Text("正在下载附件…"); Spacer(); Button("取消") { downloadTask?.cancel(); downloading = false } }.font(.footnote).padding() }
            if bodyContent != nil, let error { Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal) }
        }.background(MailTheme.surface)
        .navigationTitle("邮件").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { assistant = true } label: { Image(systemName: "sparkles") }.accessibilityLabel("小邮助手").disabled(bodyContent == nil)
                Menu {
                    if bodyContent?.html != nil { Button(plainText ? "查看原版" : "查看纯文本") { plainText.toggle() } }
                    Button("移动到…") { moving = true }
                    Button(summary.isFlagged == true ? "取消星标" : "添加星标") { Task { do { try await store.perform(.flagged(summary.isFlagged != true), on: [summary]) } catch { self.error = "标记失败，请刷新核对。" } } }
                } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("更多邮件操作")
            }
            ToolbarItemGroup(placement: .bottomBar) {
                Button("回复", systemImage: "arrowshape.turn.up.left") { compose(.reply) }.disabled(bodyContent == nil || store.sending)
                Spacer()
                Button("回复全部", systemImage: "arrowshape.turn.up.left.2") { compose(.replyAll) }.disabled(bodyContent == nil || store.sending)
                Spacer()
                Menu {
                    Button("转发正文") { compose(.forward) }
                    if bodyContent?.attachments?.isEmpty == false { Button("转发正文与全部附件") { forwardWithAttachments() } }
                } label: { Label("转发", systemImage: "arrowshape.turn.up.right") }.disabled(bodyContent == nil || store.sending || downloading)
            }
        }
        .task(id: retry) { load() }
        .onDisappear { readTask?.cancel(); downloadTask?.cancel() }
        .onChange(of: store.selectedID) { _, id in if id != ownerID { readTask?.cancel(); downloadTask?.cancel(); bodyContent = nil; error = "邮箱已切换，请返回列表重新打开这封邮件。" } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { readTask?.cancel(); downloadTask?.cancel() } }
        .sheet(isPresented: $composing) { ComposerView(store: store) }
        .sheet(isPresented: $moving) { MovePicker(store: store, items: [summary]) }
        .sheet(isPresented: $assistant) {
            AssistantPanel(text: summary.subject + "\n" + (bodyContent?.text ?? "")) { output in
                guard let bodyContent, !store.sending else { return false }
                do { try store.compose(mode: .reply, summary: summary, body: bodyContent); store.updateDraft { $0.text = output; $0.html = nil }; adoptedReply = true; return true }
                catch { self.error = error.localizedDescription; return false }
            }.onDisappear { if adoptedReply { adoptedReply = false; composing = true } }
        }
        .quickLookPreview($previewURL)
        .confirmationDialog("用 Safari 打开外部链接？", isPresented: Binding(get: { externalURL != nil }, set: { if !$0 { externalURL = nil } }), titleVisibility: .visible) {
            if let url = externalURL { Button("打开链接") { openURL(url); externalURL = nil } }
        } message: { Text(externalURL?.host ?? "") }
    }
    private func load() {
        error = nil; readTask?.cancel()
        readTask = Task {
            do { let result = try await store.body(for: summary); try Task.checkCancellation(); guard store.selectedID == ownerID else { throw CancellationError() }; bodyContent = result }
            catch { if !Task.isCancelled { self.error = (error as? MailFailure)?.localizedDescription ?? "请检查网络后重试，已缓存的正文可离线阅读。" } }
        }
    }
    private func compose(_ mode: DraftMode) {
        guard let bodyContent else { return }
        do { try store.compose(mode: mode, summary: summary, body: bodyContent); composing = true }
        catch { error = error.localizedDescription }
    }
    private func download(_ item: MailAttachment) {
        downloading = true; error = nil
        downloadTask = Task {
            do { let data = try await store.attachmentData(item, summary: summary); try Task.checkCancellation(); previewURL = try previewFile(name: item.name, data: data) }
            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            if !Task.isCancelled { downloading = false }
        }
    }
    private func forwardWithAttachments() {
        guard let bodyContent else { return }; downloading = true; error = nil
        downloadTask = Task {
            do {
                let items = bodyContent.attachments ?? []
                guard items.count <= 20 else { throw MailFailure.invalid("附件超过 20 个，可选择仅转发正文并手动添加需要的附件。") }
                var loaded: [(MailAttachment, Data)] = []; var total = 0
                for item in items {
                    let data = try await store.attachmentData(item, summary: summary); try Task.checkCancellation()
                    total += data.count; guard total <= MailAttachment.totalLimit else { throw MailFailure.invalid("附件合计超过 25 MB，请选择转发正文并手动添加附件。") }
                    loaded.append((item, data))
                }
                try store.compose(mode: .forward, summary: summary, body: bodyContent)
                for (item, data) in loaded { try store.addAttachment(name: item.name, mimeType: item.mimeType, data: data) }
                composing = true
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            if !Task.isCancelled { downloading = false }
        }
    }
}
struct SafeMailHTML: UIViewRepresentable {
    let html: String
    @Binding var externalURL: URL?
    func makeCoordinator() -> Coordinator { Coordinator(externalURL: $externalURL) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false; view.backgroundColor = .systemBackground
        // A restrictive CSP precedes all untrusted markup; subsequent CSPs cannot weaken it.
        let csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'"
        view.loadHTMLString("<!doctype html><html><head><meta http-equiv='Content-Security-Policy' content=\"\(csp)\"><meta name='viewport' content='width=device-width, initial-scale=1'><style>:root{color-scheme:light dark}body{font:16px -apple-system;padding:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>\(html)</body></html>", baseURL: nil)
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    final class Coordinator: NSObject, WKNavigationDelegate {
        @Binding var externalURL: URL?
        init(externalURL: Binding<URL?>) { _externalURL = externalURL }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url, url.scheme?.lowercased() == "https", url.host != nil {
                externalURL = url
            }
            let initial = action.navigationType == .other && action.request.url?.absoluteString == "about:blank"
            decisionHandler(initial ? .allow : .cancel)
        }
    }
}
