import SwiftUI
import MailAICore
import ContactsUI

struct MailboxesView: View {
    let store: MailStore
    @Binding var unified: Bool
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { unified = true; dismiss() } label: { Label("所有收件箱", systemImage: "tray.2.fill") }
                }
                Section("邮箱") {
                    ForEach(store.accounts) { account in
                        Button {
                            do { try store.selectAccount(account.id); unified = false; store.refresh(); dismiss() }
                            catch { store.error = error.localizedDescription }
                        } label: {
                            HStack { SenderAvatar(name: account.displayName.isEmpty ? account.email : account.displayName); Text(account.email).foregroundStyle(.primary); Spacer(); if store.selectedID == account.id && !unified { Image(systemName: "checkmark") } }
                        }
                    }
                }
                Section("当前邮箱文件夹") {
                    ForEach(store.folders, id: \.name) { folder in
                        Button { do { try store.selectFolder(folder.name); unified = false; dismiss() } catch { store.error = error.localizedDescription } } label: {
                            Label(folder.title, systemImage: folder.symbol)
                        }
                    }
                }
            }.navigationTitle("邮箱与文件夹").toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
struct MovePicker: View {
    let store: MailStore; let items: [MailSummary]
    @Environment(\.dismiss) private var dismiss
    @State private var working = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red) }
                ForEach(store.folders.filter { $0.name != items.first?.folder }, id: \.name) { folder in
                    Button {
                        working = true
                        Task {
                            do { try await store.perform(.move(folder.name), on: items); dismiss() }
                            catch { self.error = "移动未完成，请关闭后刷新核对。为避免重复移动，不会自动重试。" }
                            working = false
                        }
                    } label: { Label(folder.title, systemImage: folder.symbol) }.disabled(working)
                }
            }.navigationTitle("移动 \(items.count) 封邮件")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(working) } }
                .overlay { if working { ProgressView("正在移动…") } }
                .interactiveDismissDisabled(working)
        }
    }
}
struct DraftsView: View {
    let store: MailStore
    @State private var composing = false
    @State private var deleting: MailDraft?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                ForEach(store.drafts.filter { !$0.isEmpty }.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }) { item in
                    Button { do { try store.openDraft(item.id); composing = true } catch { store.error = error.localizedDescription } } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack { Text(item.subject.isEmpty ? "（无主题）" : item.subject).font(.headline); Spacer(); Text(state(item)).font(.caption).foregroundStyle(item.state == .uncertain ? .orange : .secondary) }
                            Text(item.to.isEmpty ? "未填写收件人" : item.to).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                            Text(item.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }.foregroundStyle(.primary).padding(.vertical, 5)
                    }.swipeActions {
                        if item.state != .uncertain && item.state != .submitting {
                            Button("删除", role: .destructive) { deleting = item }
                        }
                    }
                }
                if store.drafts.allSatisfy(\.isEmpty) { ContentUnavailableView("暂无草稿", systemImage: "doc", description: Text("编辑中的邮件会自动保存在这里。")) }
            }.navigationTitle("草稿与发送记录")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
                .sheet(isPresented: $composing) { ComposerView(store: store) }
                .confirmationDialog("删除这封本地草稿或发送记录？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                    Button("删除", role: .destructive) { if let deleting { do { try store.discardDraft(deleting.id) } catch { store.error = error.localizedDescription } }; deleting = nil }
                }
        }
    }
    private func state(_ draft: MailDraft) -> String {
        switch draft.state { case .editing: return "草稿"; case .sent: return draft.sentCopyPending == true ? "待存档" : "已发送"; case .submitting, .uncertain: return "结果待确认" }
    }
}
struct MailSearchView: View {
    let store: MailStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [MailSummary] = []
    @State private var completedQuery = ""
    @State private var total = 0
    @State private var limit = 50
    @State private var task: Task<Void, Never>?
    @State private var working = false
    @State private var error: String?
    private var local: [MailSummary] {
        store.messages.filter { ($0.subject + " " + $0.sender + " " + ($0.preview ?? "") + " " + ($0.recipients ?? []).map(\.email).joined(separator: " ")).localizedCaseInsensitiveContains(query) }
    }
    var body: some View {
        NavigationStack {
            List {
                if !query.isEmpty {
                    Section(completedQuery == query ? "服务器匹配 \(total) 封 · 已显示 \(results.count) 封" : "本机缓存匹配") {
                        ForEach(completedQuery == query ? results : local) { message in
                            NavigationLink { ReaderView(store: store, summary: message) } label: { MailRow(summary: message) }
                        }
                    }
                    if completedQuery != query { Button("搜索服务器整个当前文件夹") { limit = 50; search() }.disabled(working) }
                    if completedQuery == query && results.count < total && limit < 500 { Button("加载更多结果") { limit += 50; search() }.disabled(working) }
                } else { ContentUnavailableView("搜索邮件", systemImage: "magnifyingglass", description: Text("搜索当前文件夹的发件人、主题、收件人和正文。")) }
                if let error { Text(error).foregroundStyle(.red); Button("重试") { search() } }
            }.navigationTitle("搜索")
                .searchable(text: $query, prompt: "搜索当前文件夹").onSubmit(of: .search) { limit = 50; search() }
                .onChange(of: query) { _, _ in task?.cancel(); working = false; error = nil }
                .overlay { if working { ProgressView("正在搜索…").padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) } }
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
                .onDisappear { task?.cancel() }
        }
    }
    private func search() {
        task?.cancel(); let input = query; working = true; error = nil
        task = Task {
            do { let found = try await store.search(input, limit: limit); try Task.checkCancellation(); results = found; total = store.searchTotal; completedQuery = input }
            catch { if !Task.isCancelled { self.error = "服务器搜索失败，已保留本机结果。可重试或缩小关键词。" } }
            if !Task.isCancelled { working = false }
        }
    }
}
struct ContactsView: View {
    let store: MailStore
    @State private var query = ""
    @State private var editing: MailContact?
    @State private var picking = false
    @State private var composing = false
    var body: some View {
        List {
            Section(store.selected?.email ?? "往来联系人") {
                ForEach(store.contacts.filter { query.isEmpty || ($0.email + $0.name + $0.note).localizedCaseInsensitiveContains(query) }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }) { contact in
                    Button { editing = contact } label: {
                        HStack { SenderAvatar(name: contact.title); VStack(alignment: .leading) { Text(contact.title).foregroundStyle(.primary); Text(contact.email).font(.caption).foregroundStyle(.secondary) }; Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
                    }.contextMenu { Button("写邮件") { compose(contact.email) } }
                }
                if store.contacts.isEmpty { ContentUnavailableView("暂无联系人", systemImage: "person.crop.rectangle", description: Text("添加联系人，或从往来邮件中积累。")) }
            }
        }.navigationTitle("通讯录").searchable(text: $query, prompt: "姓名、备注或邮箱")
            .toolbar { ToolbarItem(placement: .topBarTrailing) {
                Menu { Button("新建联系人") { editing = MailContact(email: "") }; Button("从手机联系人选择") { picking = true } } label: { Image(systemName: "plus") }.disabled(store.selectedID == nil)
            } }
            .sheet(item: $editing) { contact in ContactEditor(store: store, contact: contact, compose: compose) }
            .sheet(isPresented: $picking) { PhoneContactPicker { address in editing = MailContact(email: address.email, name: address.name) } }
            .sheet(isPresented: $composing) { ComposerView(store: store) }
    }
    private func compose(_ email: String) {
        do { try store.newDraft(); store.updateDraft { $0.to = email }; composing = true }
        catch { store.error = error.localizedDescription }
    }
}
struct ContactEditor: View {
    let store: MailStore
    @State var contact: MailContact
    let compose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                TextField("邮箱", text: $contact.email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("姓名", text: $contact.name)
                TextField("备注", text: $contact.note)
                if let error { Text(error).foregroundStyle(.red) }
                Button("写邮件") { dismiss(); compose(contact.email) }.disabled(!MailValidation.isAddress(contact.email))
            }.navigationTitle("联系人").toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { do { try store.saveContact(contact); dismiss() } catch { self.error = error.localizedDescription } } }
            }
        }
    }
}
struct PhoneContactPicker: UIViewControllerRepresentable {
    let selected: (MailAddress) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(selected: selected) }
    func makeUIViewController(context: Context) -> CNContactPickerViewController {
        let controller = CNContactPickerViewController(); controller.delegate = context.coordinator
        controller.displayedPropertyKeys = [CNContactEmailAddressesKey]
        controller.predicateForEnablingContact = NSPredicate(format: "emailAddresses.@count > 0")
        controller.predicateForSelectionOfContact = NSPredicate(value: false)
        controller.predicateForSelectionOfProperty = NSPredicate(format: "key == 'emailAddresses'")
        return controller
    }
    func updateUIViewController(_ uiViewController: CNContactPickerViewController, context: Context) {}
    final class Coordinator: NSObject, CNContactPickerDelegate {
        let selected: (MailAddress) -> Void
        init(selected: @escaping (MailAddress) -> Void) { self.selected = selected }
        func contactPicker(_ picker: CNContactPickerViewController, didSelect contactProperty: CNContactProperty) {
            if let email = contactProperty.value as? String { selected(MailAddress(name: CNContactFormatter.string(from: contactProperty.contact, style: .fullName) ?? "", email: email)) }
        }
    }
}
