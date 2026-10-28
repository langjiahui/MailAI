import SwiftUI
import WebKit
import QuickLook
import MailAICore

struct ReaderView: View {
    let store: MailStore
    let summary: MailSummary
    @State private var ownerID: UUID?
    @State private var adoptedReply = false
    @State private var localFlag: Bool?
    init(store: MailStore, summary: MailSummary) { self.store = store; self.summary = summary; _ownerID = State(initialValue: store.selectedID) }
    @State private var bodyContent: MailBody?
    @State private var error: String?
    @State private var plainText = false
    @State private var details = false
    @State private var htmlHeight: CGFloat = 260
    @State private var attachmentsExpanded = true
    @State private var composing = false
    @State private var retry = 0
    @State private var externalURL: URL?
    @State private var previewURL: URL?
    @State private var downloading = false
    @State private var assistant = false
    @State private var moving = false
    @State private var readTask: Task<Void, Never>?
    @State private var downloadTask: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("mail.readerSize") private var readerSize = 17.0
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(summary.subject.isEmpty ? "（无主题）" : summary.subject).font(.system(.title2, design: .default, weight: .bold)).textSelection(.enabled)
                HStack(alignment: .top, spacing: 12) {
                    SenderAvatar(name: summary.senderName ?? summary.sender, size: 40)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(summary.senderName?.isEmpty == false ? summary.senderName! : summary.sender).font(.subheadline.weight(.semibold)).textSelection(.enabled)
                        Button { details.toggle() } label: { HStack(spacing: 4) { Text("发送至 " + (bodyContent?.recipients ?? summary.recipients ?? []).map { $0.name.isEmpty ? $0.email : $0.name }.joined(separator: "、")).lineLimit(details ? nil : 1); Image(systemName: details ? "chevron.up" : "chevron.down").font(.caption2) }.font(.caption).foregroundStyle(MailTheme.secondary).frame(minHeight: 32) }.accessibilityLabel("邮件详细信息")
                    }
                    Spacer(minLength: 4)
                    if let date = summary.date { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(MailTheme.secondary).multilineTextAlignment(.trailing) }
                }
                if details {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("发件人：" + summary.sender)
                        Text("收件人：" + (bodyContent?.recipients ?? summary.recipients ?? []).map { $0.name.isEmpty ? $0.email : $0.name + " <" + $0.email + ">" }.joined(separator: "; "))
                        if let cc = bodyContent?.carbonCopies ?? summary.carbonCopies, !cc.isEmpty { Text("抄送：" + cc.map(\.email).joined(separator: "; ")) }
                    }.font(.footnote).foregroundStyle(MailTheme.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
                Button { assistant = true } label: { HStack { Label("小邮 · 提炼要点", systemImage: "sparkles"); Spacer(); Image(systemName: "chevron.right").font(.caption) }.font(.subheadline).padding(12).frame(minHeight: 48).background(MailTheme.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 12)) }.disabled(bodyContent == nil).accessibilityLabel("小邮助手")
                if let bodyContent {
                    if let html = bodyContent.html, !plainText {
                        SafeMailHTML(html: html, externalURL: $externalURL, fontSize: readerSize, contentHeight: $htmlHeight).frame(height: htmlHeight)
                    } else {
                        Text(bodyContent.text.isEmpty ? "这封邮件没有纯文本正文，可切换原版查看。" : bodyContent.text)
                            .font(.system(size: readerSize, relativeTo: .body)).lineSpacing(6).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }
                    if let attachments = bodyContent.attachments, !attachments.isEmpty {
                        DisclosureGroup("附件（\(attachments.count)）", isExpanded: $attachmentsExpanded) {
                            VStack(spacing: 8) {
                                ForEach(attachments) { item in
                                    Button { download(item) } label: {
                                        HStack(spacing: 12) {
                                            Image(systemName: "doc.text").font(.title3)
                                            VStack(alignment: .leading, spacing: 4) { Text(item.name).font(.subheadline).foregroundStyle(MailTheme.ink).lineLimit(2); Text(ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)).font(.caption).foregroundStyle(MailTheme.secondary) }
                                            Spacer(); Image(systemName: "arrow.down.circle")
                                        }.padding(12).frame(minHeight: 56).background(MailTheme.canvas, in: RoundedRectangle(cornerRadius: 12))
                                    }.disabled(downloading)
                                }
                            }.padding(.top, 12)
                        }.font(.subheadline).padding(.top, 8)
                    }
                    if bodyContent.attachments == nil { MailNotice(text: "附件信息等待联网更新，已缓存正文仍可阅读。", symbol: "wifi.slash") }
                } else if let error {
                    ContentUnavailableView { Label("暂时无法阅读", systemImage: "wifi.exclamationmark") } description: { Text(error) } actions: { Button("重试") { retry += 1 } }
                } else { ProgressView("加载正文…").frame(maxWidth: .infinity, minHeight: 220) }
                if downloading { HStack { ProgressView(); Text("正在下载附件…"); Spacer(); Button("取消") { downloadTask?.cancel(); downloading = false } }.font(.footnote) }
                if bodyContent != nil, let error { MailNotice(text: error) }
            }.padding(16)
        }.background(MailTheme.surface)
        .navigationTitle("邮件").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { archive() } label: { Image(systemName: "archivebox") }.accessibilityLabel("归档邮件").disabled(store.operating || store.selectedID != ownerID)
                Menu {
                    if bodyContent?.html != nil { Button(plainText ? "查看原版" : "查看纯文本") { plainText.toggle() } }
                    Button("移动到…") { moving = true }
                    Button(currentFlag ? "取消星标" : "添加星标") {
                        let next = !currentFlag
                        Task { do { try await store.perform(.flagged(next), on: [summary]); localFlag = next } catch { self.error = "标记失败，请刷新核对。" } }
                    }
                } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("更多邮件操作")
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 10) {
                Button { compose(.reply) } label: { Label("回复", systemImage: "arrowshape.turn.up.left").frame(maxWidth: .infinity, minHeight: 44) }
                    .disabled(bodyContent == nil || store.sending)
                Button { compose(.replyAll) } label: { Label("回复全部", systemImage: "arrowshape.turn.up.left.2").frame(maxWidth: .infinity, minHeight: 44) }
                    .disabled(bodyContent == nil || store.sending)
                Menu {
                    Button("转发正文") { compose(.forward) }
                    if bodyContent?.attachments?.isEmpty == false { Button("转发正文与全部附件") { forwardWithAttachments() } }
                } label: { Label("转发", systemImage: "arrowshape.turn.up.right").frame(maxWidth: .infinity, minHeight: 44) }
                    .disabled(bodyContent == nil || store.sending || downloading)
            }.font(.callout).buttonStyle(.borderless).padding(.horizontal, 12).padding(.vertical, 8).background(MailTheme.surface).overlay(alignment: .top) { Divider() }
        }
        .task(id: retry) { load() }
        .onDisappear { readTask?.cancel(); downloadTask?.cancel() }
        .onChange(of: store.selectedID) { _, id in if id != ownerID { readTask?.cancel(); downloadTask?.cancel(); bodyContent = nil; error = "邮箱已切换，请返回列表重新打开这封邮件。" } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { readTask?.cancel(); downloadTask?.cancel(); downloading = false } else if bodyContent == nil { load() } }
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
    private func archive() {
        guard store.selectedID == ownerID else { return }
        guard let target = store.selected?.archiveFolder ?? store.folders.first(where: { $0.role == "archive" || $0.title == "归档" })?.name else { moving = true; return }
        Task { do { try await store.perform(.move(target), on: [summary]); dismiss() } catch { self.error = "归档未完成，请刷新核对服务器状态。" } }
    }
    private var currentFlag: Bool { localFlag ?? store.messages.first(where: { $0.id == summary.id })?.isFlagged ?? summary.isFlagged ?? false }
    private func load() {
        error = nil; readTask?.cancel()
        readTask = Task {
            do {
                let result = try await store.body(for: summary); try Task.checkCancellation()
                guard store.selectedID == ownerID else { throw CancellationError() }
                bodyContent = result
                if result.attachments == nil {
                    if let upgraded = try? await store.body(for: summary, refreshMetadata: true) {
                        try Task.checkCancellation(); guard store.selectedID == ownerID else { throw CancellationError() }
                        bodyContent = upgraded
                    }
                } else { try? await store.markReadIfNeeded(summary) }
            }
            catch { if !Task.isCancelled { self.error = (error as? MailFailure)?.localizedDescription ?? "请检查网络后重试，已缓存的正文可离线阅读。" } }
        }
    }
    private func compose(_ mode: DraftMode) {
        guard let bodyContent else { return }
        do { try store.compose(mode: mode, summary: summary, body: bodyContent); composing = true }
        catch { self.error = error.localizedDescription }
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
    var fontSize: Double = 17
    @Binding var contentHeight: CGFloat
    func makeCoordinator() -> Coordinator { Coordinator(externalURL: $externalURL, height: $contentHeight) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false; view.backgroundColor = .systemBackground
        context.coordinator.observation = view.scrollView.observe(\.contentSize, options: [.new]) { scroll, _ in
            let height = min(30000, max(200, scroll.contentSize.height))
            DispatchQueue.main.async { if abs(context.coordinator.height.wrappedValue - height) > 1 { context.coordinator.height.wrappedValue = height }; scroll.isScrollEnabled = scroll.contentSize.height > 30000 }
        }
        load(view, coordinator: context.coordinator)
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        if context.coordinator.loadedHTML != html || context.coordinator.fontSize != fontSize { load(view, coordinator: context.coordinator) }
    }
    private func load(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.loadedHTML = html; coordinator.fontSize = fontSize
        // A restrictive CSP precedes all untrusted markup; subsequent CSPs cannot weaken it.
        let csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'"
        view.loadHTMLString("<!doctype html><html><head><meta http-equiv='Content-Security-Policy' content=\"\(csp)\"><meta name='viewport' content='width=device-width, initial-scale=1'><style>:root{color-scheme:light dark}body{font:\(fontSize)px -apple-system;line-height:1.6;margin:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>\(html)</body></html>", baseURL: nil)
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        @Binding var externalURL: URL?
        let height: Binding<CGFloat>
        var observation: NSKeyValueObservation?
        var loadedHTML = ""
        var fontSize: Double = 0
        init(externalURL: Binding<URL?>, height: Binding<CGFloat>) { _externalURL = externalURL; self.height = height }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url, url.scheme?.lowercased() == "https", url.host != nil {
                externalURL = url
            }
            let initial = action.navigationType == .other && action.request.url?.absoluteString == "about:blank"
            decisionHandler(initial ? .allow : .cancel)
        }
    }
}
