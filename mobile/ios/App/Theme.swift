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
    static func senderColors(_ key: String) -> (Color, Color) {
        let index = key.lowercased().unicodeScalars.reduce(UInt64(0)) { ($0 &* 33) &+ UInt64($1.value) } % 3
        switch index {
        case 1: return (adaptive(0x276C79, 0x9BCFD6), adaptive(0xEAF3F4, 0x233B42))
        case 2: return (adaptive(0x53649A, 0xB3C1EF), adaptive(0xEEF0F8, 0x2D344B))
        default: return (blue, adaptive(0xE8F1FA, 0x20374C))
        }
    }
}
/// Preserve the native Button/Menu gesture while making press feedback visible.
struct MailPressButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat = 14
    var pressedScale: CGFloat = 0.92
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(MailTheme.blue.opacity(configuration.isPressed ? 0.12 : 0), in: RoundedRectangle(cornerRadius: cornerRadius))
            .scaleEffect(configuration.isPressed && !reduceMotion ? pressedScale : 1)
            .opacity(enabled ? 1 : 0.4)
            .animation(.easeOut(duration: reduceMotion ? 0 : 0.14), value: configuration.isPressed)
            .sensoryFeedback(.selection, trigger: configuration.isPressed) { _, pressed in pressed && enabled }
    }
}
struct InboxSenderAvatar: View {
    let name: String
    let address: String
    let unread: Bool
    var body: some View {
        let colors = MailTheme.senderColors(address)
        Text(String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
            .font(.system(size: 17, weight: .semibold, design: .rounded))
            .foregroundStyle(colors.0).frame(width: 40, height: 40)
            .background(colors.1, in: Circle())
            .overlay(alignment: .bottomTrailing) {
                if unread { Circle().fill(MailTheme.blue).frame(width: 8, height: 8).overlay { Circle().stroke(MailTheme.surface, lineWidth: 2) } }
            }
            .accessibilityHidden(true)
    }
}
struct MailSearchField: View {
    @Binding var text: String
    var prompt: String
    var submitted: () -> Void = {}
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(MailTheme.secondary)
            TextField(prompt, text: $text).textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                .onSubmit(submitted).accessibilityIdentifier("mail-search-input")
            if !text.isEmpty { Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(MailTheme.secondary).frame(width: 44, height: 44) }.accessibilityLabel("清空搜索") }
        }.padding(.leading, 12).padding(.trailing, text.isEmpty ? 12 : 0).frame(minHeight: 44).background(MailTheme.canvas, in: RoundedRectangle(cornerRadius: 12))
    }
}
struct SenderAvatar: View {
    let name: String
    var size: CGFloat = 36
    var body: some View {
        Text(String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
            .font(.system(.subheadline, design: .rounded, weight: .semibold)).dynamicTypeSize(...DynamicTypeSize.xxxLarge).foregroundStyle(MailTheme.blue)
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
        Image(systemName: symbol).font(.body).dynamicTypeSize(...DynamicTypeSize.xxxLarge).foregroundStyle(MailTheme.blue)
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
