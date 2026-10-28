import SwiftUI
import UIKit

private final class PlainPasteTextView: UITextView {
    override func paste(_ sender: Any?) {
        if let text = UIPasteboard.general.string { insertText(text) }
    }
}
struct RichComposerEditor: UIViewRepresentable {
    let text: String
    let html: String?
    let editable: Bool
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
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        view.isEditable = editable
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
