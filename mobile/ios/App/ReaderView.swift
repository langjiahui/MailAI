import SwiftUI
import WebKit
import QuickLook
import MailAICore

struct ReaderView: View {
    let store: MailStore
    @State private var summary: MailSummary
    let thread: [MailSummary]
    @State private var ownerID: UUID?
    @State private var adoptedReply = false
    @State private var localFlag: Bool?
    init(store: MailStore, summary: MailSummary, thread: [MailSummary] = []) {
        self.store = store; _summary = State(initialValue: summary); self.thread = thread
        _ownerID = State(initialValue: store.selectedID)
    }
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
    @State private var downloadingID: String?
    @State private var assistant = false
    @State private var moving = false
    @State private var readTask: Task<Void, Never>?
    @State private var downloadTask: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage("mail.readerSize") private var readerSize = 17.0
    @ScaledMetric(relativeTo: .body) private var scaledBody = 17.0
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text((thread.first ?? summary).subject.isEmpty ? "（无主题）" : (thread.first ?? summary).subject).font(.title2.bold()).textSelection(.enabled)
                if thread.count > 1 {
                    ForEach(thread.sorted { ($0.date ?? .distantPast) < ($1.date ?? .distantPast) }) { item in
                        if item.id == summary.id { messageHeader; messageContents }
                        else { collapsedMessage(item) }
                    }
                } else { messageHeader; messageContents }
            }.padding(16)
        }.background(MailTheme.surface)
        .navigationTitle("邮件").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { moveToRole("trash") } label: { Image(systemName: "trash") }.accessibilityLabel("移到废纸篓").disabled(store.operating || store.selectedID != ownerID)
                Button { moveToRole("archive") } label: { Image(systemName: "archivebox") }.accessibilityLabel("归档邮件").disabled(store.operating || store.selectedID != ownerID)
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
                Button { compose(.reply) } label: { replyActionLabel("回复", symbol: "arrowshape.turn.up.left").frame(maxWidth: .infinity, minHeight: 44) }
                    .disabled(bodyContent == nil || store.sending)
                Button { compose(.replyAll) } label: { replyActionLabel("回复全部", symbol: "arrowshape.turn.up.left.2").frame(maxWidth: .infinity, minHeight: 44) }
                    .disabled(bodyContent == nil || store.sending)
                Menu {
                    Button("转发正文") { compose(.forward) }
                    if bodyContent?.attachments?.isEmpty == false { Button("转发正文与全部附件") { forwardWithAttachments() } }
                } label: { replyActionLabel("转发", symbol: "arrowshape.turn.up.right").frame(maxWidth: .infinity, minHeight: 44) }
                    .disabled(bodyContent == nil || store.sending || downloading)
            }.font(.callout).buttonStyle(.borderless).padding(.horizontal, 12).padding(.vertical, 8).background(MailTheme.surface).overlay(alignment: .top) { Divider() }
        }
        .task(id: retry) { load() }
        .onDisappear { readTask?.cancel(); downloadTask?.cancel() }
        .onChange(of: summary.id) { _, _ in
            readTask?.cancel(); downloadTask?.cancel(); downloading = false; downloadingID = nil
            bodyContent = nil; error = nil; details = false; htmlHeight = 260; localFlag = nil; load()
        }
        .onChange(of: store.selectedID) { _, id in if id != ownerID { readTask?.cancel(); downloadTask?.cancel(); bodyContent = nil; error = "邮箱已切换，请返回列表重新打开这封邮件。" } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { readTask?.cancel(); downloadTask?.cancel(); downloading = false; downloadingID = nil } else if bodyContent == nil { load() } }
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
        .alert("用 Safari 打开外部链接？", isPresented: Binding(get: { externalURL != nil }, set: { if !$0 { externalURL = nil } })) {
            if let url = externalURL { Button("打开链接") { openURL(url); externalURL = nil } }
            Button("取消", role: .cancel) { externalURL = nil }
        } message: { Text(externalURL?.host ?? "") }
    }
    @ViewBuilder private func replyActionLabel(_ title: String, symbol: String) -> some View {
        if dynamicTypeSize.isAccessibilitySize { Image(systemName: symbol).font(.title3).dynamicTypeSize(...DynamicTypeSize.xxxLarge).accessibilityLabel(title) }
        else { Label(title, systemImage: symbol) }
    }
    private var messageHeader: some View {
        VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top, spacing: 12) {
                    SenderAvatar(name: summary.senderName ?? summary.sender, size: 40)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(summary.senderName?.isEmpty == false ? summary.senderName! : summary.sender).font(.subheadline.weight(.semibold)).textSelection(.enabled)
                        if dynamicTypeSize.isAccessibilitySize, let date = summary.date { Text(date.formatted()).font(.caption2).foregroundStyle(MailTheme.secondary) }
                        Button { details.toggle() } label: { HStack(spacing: 4) { Text("发送至 " + (bodyContent?.recipients ?? summary.recipients ?? []).map { $0.name.isEmpty ? $0.email : $0.name }.joined(separator: "、")).lineLimit(2).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true); Image(systemName: "chevron.down").rotationEffect(.degrees(details ? 180 : 0)).font(.caption2) }.font(.caption).foregroundStyle(MailTheme.secondary).frame(minHeight: 44, alignment: .leading) }.buttonStyle(.plain).accessibilityLabel("邮件详细信息")
                    }
                    Spacer(minLength: 4)
                    if !dynamicTypeSize.isAccessibilitySize, let date = summary.date { Text(date.formatted(date: .omitted, time: .shortened)).font(.caption2).foregroundStyle(MailTheme.secondary).fixedSize().accessibilityLabel(date.formatted()) }
                }
                if details {
                    VStack(alignment: .leading, spacing: 8) {
                        if let date = summary.date { Text("时间：" + date.formatted()) }
                        Text("发件人：" + summary.sender)
                        Text("收件人：" + (bodyContent?.recipients ?? summary.recipients ?? []).map { $0.name.isEmpty ? $0.email : $0.name + " <" + $0.email + ">" }.joined(separator: "; "))
                        if let cc = bodyContent?.carbonCopies ?? summary.carbonCopies, !cc.isEmpty { Text("抄送：" + cc.map(\.email).joined(separator: "; ")) }
                    }.font(.footnote).foregroundStyle(MailTheme.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
                Button { assistant = true } label: { HStack { Label("小邮 · 提炼要点", systemImage: "sparkles"); Spacer(); Image(systemName: "chevron.right").font(.caption) }.font(.subheadline).padding(12).frame(minHeight: 48).background(MailTheme.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 12)) }.disabled(bodyContent == nil).accessibilityLabel("小邮助手")
        }
    }
    @ViewBuilder private var messageContents: some View {
                if let bodyContent {
                    if let html = bodyContent.html, !plainText {
                        SafeMailHTML(html: html, externalURL: $externalURL, fontSize: readerSize * scaledBody / 17, contentHeight: $htmlHeight).frame(height: htmlHeight)
                    } else {
                        Text(bodyContent.text.isEmpty ? "这封邮件没有纯文本正文，可切换原版查看。" : bodyContent.text)
                            .font(.system(size: readerSize * scaledBody / 17)).lineSpacing(6).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }
                    if let attachments = bodyContent.attachments, !attachments.isEmpty {
                        DisclosureGroup("附件（\(attachments.count)）", isExpanded: $attachmentsExpanded) {
                            VStack(spacing: 8) {
                                ForEach(attachments) { item in
                                    Button { download(item) } label: {
                                        HStack(spacing: 12) {
                                            Image(systemName: "doc.text").font(.title3)
                                            VStack(alignment: .leading, spacing: 4) { Text(item.name).font(.subheadline).foregroundStyle(MailTheme.ink).lineLimit(2); Text(ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)).font(.caption).foregroundStyle(MailTheme.secondary) }
                                            Spacer(); if downloadingID == item.id { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.down.circle") }
                                        }.padding(12).frame(minHeight: 56).background(MailTheme.canvas, in: RoundedRectangle(cornerRadius: 12))
                                    }.disabled(downloading)
                                    if downloadingID == item.id { Button("取消下载") { downloadTask?.cancel(); downloading = false; downloadingID = nil }.font(.footnote).frame(minHeight: 44) }
                                }
                            }.padding(.top, 12)
                        }.font(.subheadline).padding(.top, 8)
                    }
                    if bodyContent.attachments == nil { MailNotice(text: "附件信息等待联网更新，已缓存正文仍可阅读。", symbol: "wifi.slash") }
                } else if let error {
                    ContentUnavailableView { Label("暂时无法阅读", systemImage: "wifi.exclamationmark") } description: { Text(error) } actions: { Button("重试") { retry += 1 } }
                } else { ProgressView("加载正文…").frame(maxWidth: .infinity, minHeight: 220) }
                if downloading && downloadingID == nil { HStack { ProgressView(); Text("正在下载附件…"); Spacer(); Button("取消") { downloadTask?.cancel(); downloading = false } }.font(.footnote) }
                if bodyContent != nil, let error { MailNotice(text: error, critical: true) }
    }
    private func collapsedMessage(_ item: MailSummary) -> some View {
        Button { summary = item } label: {
            HStack(alignment: .top, spacing: 12) {
                SenderAvatar(name: item.senderName ?? item.sender, size: 40)
                VStack(alignment: .leading, spacing: 5) {
                    HStack { Text(item.senderName ?? item.sender).font(.subheadline.weight(.semibold)).foregroundStyle(MailTheme.ink); Spacer(); if let date = item.date { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(MailTheme.secondary) } }
                    Text(item.preview ?? item.subject).font(.subheadline).foregroundStyle(MailTheme.secondary).lineLimit(1)
                }
                Image(systemName: "chevron.down").font(.caption).padding(.top, 4)
            }.padding(.vertical, 12).frame(minHeight: 64).overlay(alignment: .bottom) { Divider() }
        }.buttonStyle(.plain).accessibilityLabel("展开会话邮件：" + (item.senderName ?? item.sender))
    }
    private func moveToRole(_ role: String) {
        guard store.selectedID == ownerID else { return }
        let configured = role == "trash" ? store.selected?.trashFolder : store.selected?.archiveFolder
        guard let target = configured ?? store.folders.first(where: { $0.role == role || $0.title == (role == "trash" ? "废纸篓" : "归档") })?.name else { moving = true; return }
        Task { do { try await store.perform(.move(target), on: [summary]); dismiss() } catch { self.error = "操作未完成，请刷新核对服务器状态。" } }
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
        downloading = true; downloadingID = item.id; error = nil
        downloadTask = Task {
            do { let data = try await store.attachmentData(item, summary: summary); try Task.checkCancellation(); previewURL = try previewFile(name: item.name, data: data) }
            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            if !Task.isCancelled { downloading = false; downloadingID = nil }
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
        context.coordinator.observation = view.scrollView.observe(\.contentSize, options: [.new]) { [weak coordinator = context.coordinator] scroll, _ in
            let height = min(30000, max(200, scroll.contentSize.height))
            DispatchQueue.main.async { [weak coordinator, weak scroll] in
                guard let coordinator, let scroll else { return }
                if abs(coordinator.height.wrappedValue - height) > 1 { coordinator.height.wrappedValue = height }
                scroll.isScrollEnabled = scroll.contentSize.height > 30000
            }
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
