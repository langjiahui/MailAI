import SwiftUI
import WebKit
import MailAICore

struct ReaderView: View {
    let store: MailStore
    let summary: MailSummary
    @State private var bodyContent: MailBody?
    @State private var error: String?
    @State private var plainText = false
    @State private var composing = false
    @State private var confirmReplace = false
    @State private var retry = 0
    @State private var externalURL: URL?
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var readTask: Task<Void, Never>?
    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Text(summary.subject).font(.title2.bold()).textSelection(.enabled)
                Text(summary.sender).font(.subheadline).textSelection(.enabled)
                if let date = summary.date { Text(date.formatted()).font(.caption).foregroundStyle(.secondary) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding()
            Divider()
            if let bodyContent {
                if let html = bodyContent.html, !plainText { SafeMailHTML(html: html, externalURL: $externalURL) }
                else {
                    ScrollView { Text(bodyContent.text.isEmpty ? "这封邮件没有纯文本正文。可切换原版查看 HTML 正文。" : bodyContent.text)
                        .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled).padding() }
                }
            } else if let error {
                ContentUnavailableView { Label("暂时无法阅读", systemImage: "wifi.exclamationmark") }
                    description: { Text(error) } actions: { Button("重试") { retry += 1 } }
            } else { Spacer(); ProgressView("加载正文…"); Spacer() }
        }
        .navigationTitle("邮件").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if bodyContent?.html != nil { Button(plainText ? "原版" : "纯文本") { plainText.toggle() } }
                Button("回复", systemImage: "arrowshape.turn.up.left") {
                    if !store.draft.isEmpty && store.draft.state != .sent { confirmReplace = true }
                    else { startReply() }
                }.disabled(store.sending || !MailValidation.isAddress(summary.replyAddress))
            }
        }
        .task(id: retry) { load() }
        .onDisappear { readTask?.cancel() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { readTask?.cancel() } }
        .sheet(isPresented: $composing) { ComposerView(store: store) }
        .confirmationDialog("保留当前草稿，还是用这封邮件的新回复替换它？", isPresented: $confirmReplace, titleVisibility: .visible) {
            Button("打开已有草稿") { composing = true }
            if store.draft.state == .editing { Button("替换为新回复", role: .destructive) { startReply() } }
        }
        .confirmationDialog("用 Safari 打开外部链接？", isPresented: Binding(get: { externalURL != nil }, set: { if !$0 { externalURL = nil } }), titleVisibility: .visible) {
            if let url = externalURL { Button("打开链接") { openURL(url); externalURL = nil } }
        } message: { Text(externalURL?.host ?? "") }
    }
    private func load() {
        error = nil
        readTask?.cancel()
        readTask = Task {
            do { let result = try await store.body(for: summary); try Task.checkCancellation(); bodyContent = result }
            catch { if !Task.isCancelled { self.error = (error as? MailFailure)?.localizedDescription ?? "请检查网络后重试。已缓存的邮件可离线阅读。" } }
        }
    }
    private func startReply() {
        do { try store.newDraft(replyingTo: summary); composing = true } catch { store.error = error.localizedDescription }
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
