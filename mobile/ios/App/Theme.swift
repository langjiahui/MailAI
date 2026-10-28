import SwiftUI
import UIKit
import MailAICore

enum MailTheme {
    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 255)/255, green: CGFloat((hex >> 8) & 255)/255, blue: CGFloat(hex & 255)/255, alpha: 1)
        })
    }
    static let blue = adaptive(0x005EAA, 0x72B8F5)
    static let canvas = adaptive(0xF6F8FA, 0x101923)
    static let surface = adaptive(0xFFFFFF, 0x172330)
    static let ink = adaptive(0x142334, 0xEAF1F8)
    static let secondary = adaptive(0x667585, 0xA0B0C0)
    static let separator = adaptive(0xE6ECF2, 0x2A3948)
}
struct SenderAvatar: View {
    let name: String
    var size: CGFloat = 36
    var body: some View {
        Text(String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
            .font(.system(.subheadline, design: .rounded, weight: .semibold)).foregroundStyle(MailTheme.blue)
            .frame(width: size, height: size).background(MailTheme.blue.opacity(0.10), in: Circle())
            .accessibilityHidden(true)
    }
}
struct MailNotice: View {
    let text: String
    var symbol = "exclamationmark.circle"
    var critical = false
    var body: some View {
        Label(text, systemImage: symbol).font(.footnote).foregroundStyle(critical ? Color.red : MailTheme.secondary)
            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background((critical ? Color.red : MailTheme.blue).opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .combine)
    }
}
struct SettingsIcon: View {
    let symbol: String
    var body: some View {
        Image(systemName: symbol).font(.body).foregroundStyle(MailTheme.blue)
            .frame(width: 32, height: 32).background(MailTheme.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityHidden(true)
    }
}
struct MailPrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(.white).background(Color(red: 0, green: 94/255, blue: 170/255).opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 12))
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
