import SwiftUI

private struct LicenseEntry: Identifiable {
    let id: Int
    let title: String
    let text: String
    var paragraphs: [String] { text.components(separatedBy: "\n\n").filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }
}
private enum LicenseCatalog {
    static let entries: [LicenseEntry] = {
        guard let url = Bundle.main.url(forResource: "Licenses", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.components(separatedBy: "==================================================").enumerated().compactMap { index, raw in
            let content = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !content.isEmpty else { return nil }
            let title = index == 0 ? "MailAI 与 SwiftMail" : String(content.split(separator: "\n").first ?? "开源项目")
            return LicenseEntry(id: index, title: title, text: content)
        }
    }()
}
struct LicensesView: View {
    var body: some View {
        List {
            Section { Text("感谢开源社区的贡献。选择项目查看完整许可原文。").font(.subheadline).foregroundStyle(MailTheme.secondary) }.listRowBackground(MailTheme.surface)
            Section("许可原文") {
                ForEach(LicenseCatalog.entries) { entry in
                    NavigationLink(entry.title) {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 12) {
                                ForEach(Array(entry.paragraphs.enumerated()), id: \.offset) { _, paragraph in
                                    Text(paragraph).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }.padding(20)
                        }.background(MailTheme.surface).navigationTitle(entry.title).navigationBarTitleDisplayMode(.inline)
                    }.accessibilityIdentifier("license-\(entry.id)")
                }
                if LicenseCatalog.entries.isEmpty { MailNotice(text: "无法读取许可文件，请重新打开应用或更新安装包。", critical: true) }
            }.listRowBackground(MailTheme.surface)
        }.scrollContentBackground(.hidden).background(MailTheme.canvas).navigationTitle("开源许可").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
    }
}
