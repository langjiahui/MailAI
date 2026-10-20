import SwiftUI
import MailAICore

struct ComposerView: View {
    @Bindable var store: MailStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSend = false
    @State private var confirmReset = false
    @State private var confirmRetry = false
    @State private var error: String?
    private func field(_ keyPath: WritableKeyPath<MailDraft, String>) -> Binding<String> {
        Binding(get: { store.draft[keyPath: keyPath] }, set: { value in store.updateDraft { $0[keyPath: keyPath] = value } })
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("发件人", value: store.selected?.email ?? "")
                    TextField("收件人邮箱，多个地址用逗号分隔", text: field(\.to), axis: .vertical)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("主题", text: field(\.subject))
                }.disabled(store.draft.state != .editing)
                Section("正文") {
                    TextEditor(text: field(\.text)).frame(minHeight: 260).disabled(store.draft.state != .editing)
                }
                Section {
                    switch store.draft.state {
                    case .editing:
                        if store.draftSaveFailed {
                            Label("草稿尚未保存，请保留当前页面", systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                            Button("重试保存") { do { try store.saveDraft() } catch { self.error = "保存失败，请检查设备存储后重试。" } }
                        } else {
                            Label("草稿自动保存在本机", systemImage: "checkmark.circle").font(.footnote).foregroundStyle(.secondary)
                        }
                    case .submitting:
                        HStack { ProgressView(); Text("正在提交邮件，请等待服务器确认…") }
                    case .uncertain:
                        Label("发送结果待确认", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                        Text("服务器可能已收到邮件。请先向收件人确认，或用其他客户端查看已发送邮件，避免重复发送。")
                        Button("已确认未送达，继续编辑") { confirmRetry = true }
                    case .sent:
                        Label("服务器已接受邮件", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        Text("本版不自动保存到服务器已发送文件夹。")
                        Button("写一封新邮件") { confirmReset = true }
                    }
                }.font(.footnote)
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }.navigationTitle("写邮件").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") {
                        do { try store.saveDraft(); dismiss() }
                        catch { self.error = "草稿保存失败，请保留当前页面并重试。" }
                    }.disabled(store.sending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("发送", systemImage: "paperplane.fill") {
                        do { _ = try store.draft.validateForSending(); confirmSend = true }
                        catch { self.error = error.localizedDescription }
                    }.disabled(store.draft.state != .editing || store.sending)
                }
            }
            .interactiveDismissDisabled(store.sending || store.draftSaveFailed)
            .confirmationDialog("发送给 \(store.draft.to)？", isPresented: $confirmSend, titleVisibility: .visible) {
                Button("确认发送") {
                    error = nil
                    Task { do { try await store.send() } catch { self.error = error.localizedDescription } }
                }
            } message: { Text(store.draft.subject.isEmpty ? "（无主题）" : store.draft.subject) }
            .confirmationDialog("清空这封已发送邮件的本地副本，开始新邮件？", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("开始新邮件") { do { try store.newDraft() } catch { self.error = error.localizedDescription } }
            }
            .confirmationDialog("仅在确认上一封没有送达后继续，否则可能重复发送。", isPresented: $confirmRetry, titleVisibility: .visible) {
                Button("确认未送达，解除发送锁定") { do { try store.resolveUncertain() } catch { self.error = error.localizedDescription } }
            }
        }
    }
}
