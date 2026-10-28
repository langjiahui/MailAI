import SwiftUI
import UIKit

private final class PlainPasteTextView: UITextView {
    override func paste(_ sender: Any?) {
        if let text = UIPasteboard.general.string { insertText(text) }
    }
}
@MainActor final class ComposerEditorCommands {
    enum Format { case bold, italic, underline }
    weak var view: UITextView?
    var changed: (() -> Void)?
    func dismissKeyboard() { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
    func format(_ format: Format) {
        guard let view, view.isEditable else { return }
        view.becomeFirstResponder()
        let range = view.selectedRange
        let attributes = range.length > 0 && range.location < view.textStorage.length ? view.textStorage.attributes(at: range.location, effectiveRange: nil) : view.typingAttributes
        var next = attributes
        if format == .underline {
            let active = (attributes[.underlineStyle] as? NSNumber)?.intValue ?? 0
            next[.underlineStyle] = active == 0 ? NSUnderlineStyle.single.rawValue : 0
        } else {
            let font = attributes[.font] as? UIFont ?? .preferredFont(forTextStyle: .body)
            var traits = font.fontDescriptor.symbolicTraits
            let trait: UIFontDescriptor.SymbolicTraits = format == .bold ? .traitBold : .traitItalic
            if traits.contains(trait) { traits.remove(trait) } else { traits.insert(trait) }
            if let descriptor = font.fontDescriptor.withSymbolicTraits(traits) { next[.font] = UIFont(descriptor: descriptor, size: font.pointSize) }
        }
        if range.length > 0 { view.textStorage.addAttributes(next, range: range); view.selectedRange = range; changed?() }
        view.typingAttributes = next
    }
}
struct RichComposerEditor: UIViewRepresentable {
    let text: String
    let html: String?
    let editable: Bool
    var commands: ComposerEditorCommands? = nil
    let changed: (String, String?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(changed: changed) }
    func makeUIView(context: Context) -> UITextView {
        let view = PlainPasteTextView(); view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body); view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear; view.textColor = .label; view.tintColor = UIColor(MailTheme.blue); view.allowsEditingTextAttributes = true
        view.accessibilityIdentifier = "compose-body-editor"
        if let html, let data = html.data(using: .utf8), let attributed = try? NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.html], documentAttributes: nil) { view.attributedText = attributed }
        else { view.text = text }
        view.isEditable = editable
        view.textContainerInset = UIEdgeInsets(top: 12, left: 0, bottom: 12, right: 0)
        commands?.view = view
        commands?.changed = { [weak view, weak coordinator = context.coordinator] in if let view { coordinator?.textViewDidChange(view) } }
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        view.isEditable = editable
        commands?.view = view
        context.coordinator.changed = changed
        if view.text != text { view.text = text; view.font = .preferredFont(forTextStyle: .body); view.textColor = .label }
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var changed: (String, String?) -> Void
        init(changed: @escaping (String, String?) -> Void) { self.changed = changed }
        func textViewDidChange(_ textView: UITextView) {
            let attributed = textView.attributedText ?? NSAttributedString(string: textView.text ?? "")
            var output = "<html><body>"
            attributed.enumerateAttributes(in: NSRange(location: 0, length: attributed.length)) { attributes, range, _ in
                var fragment = attributed.attributedSubstring(from: range).string.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\n", with: "<br>")
                let traits = (attributes[.font] as? UIFont)?.fontDescriptor.symbolicTraits ?? []
                if traits.contains(.traitBold) { fragment = "<strong>" + fragment + "</strong>" }
                if traits.contains(.traitItalic) { fragment = "<em>" + fragment + "</em>" }
                if (attributes[.underlineStyle] as? NSNumber)?.intValue ?? 0 != 0 { fragment = "<u>" + fragment + "</u>" }
                output += fragment
            }
            output += "</body></html>"
            changed(textView.text ?? "", output)
        }
    }
}
