import SwiftUI
import UIKit
import MailAICore

enum MailTheme {
    static let blue = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(red: 0.38, green: 0.69, blue: 0.96, alpha: 1) : UIColor(red: 0, green: 94/255, blue: 170/255, alpha: 1)
    })
    static let canvas = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(red: 0.035, green: 0.06, blue: 0.095, alpha: 1) : UIColor(red: 0.95, green: 0.97, blue: 0.99, alpha: 1)
    })
    static let surface = Color(uiColor: .secondarySystemGroupedBackground)
}
struct SenderAvatar: View {
    let name: String
    var body: some View {
        Text(String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
            .font(.headline).foregroundStyle(MailTheme.blue)
            .frame(width: 42, height: 42).background(MailTheme.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
            .accessibilityHidden(true)
    }
}
struct AttachmentPreview: Identifiable { let id = UUID(); let url: URL }
@MainActor func previewFile(name: String, data: Data) throws -> URL {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("MailAI-Previews", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let target = folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
    let url = target.appendingPathComponent(MailAttachment.safeName(name))
    try data.write(to: url, options: [.atomic, .completeFileProtection])
    return url
}
