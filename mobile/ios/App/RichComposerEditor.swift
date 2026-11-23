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
        applyContent(to: view)
        view.isEditable = editable
        view.isScrollEnabled = false
        view.textContainerInset = UIEdgeInsets(top: 12, left: 0, bottom: 12, right: 0)
        commands?.view = view
        commands?.changed = { [weak view, weak coordinator = context.coordinator] in if let view { coordinator?.textViewDidChange(view) } }
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        view.isEditable = editable
        commands?.view = view
        context.coordinator.changed = changed
        if view.text != text { applyContent(to: view) }
    }
    private func applyContent(to view: UITextView) {
        view.attributedText = ComposerAttributedText.restore(text: text, html: html)
        view.textColor = .label
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let height = uiView.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height
        uiView.isScrollEnabled = height > 20000
        return CGSize(width: width, height: max(320, min(20000, height)))
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

// Draft formatting is produced by this editor. Restore only that small markup
// vocabulary, without starting a WebKit HTML importer inside a SwiftUI update.
@MainActor enum ComposerAttributedText {
    static func restore(text: String, html: String?) -> NSAttributedString {
        let font = UIFont.preferredFont(forTextStyle: .body)
        let plain = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: UIColor.label])
        guard let html, html.utf8.count <= 4_000_000,
              html.range(of: "<!DOCTYPE", options: .caseInsensitive) == nil,
              html.range(of: "<!ENTITY", options: .caseInsensitive) == nil else { return plain }
        let xml = html.replacingOccurrences(of: "<br\\s*/?>", with: "<br/>", options: [.regularExpression, .caseInsensitive])
        guard let data = xml.data(using: .utf8) else { return plain }
        let decoder = ComposerMarkupDecoder()
        let parser = XMLParser(data: data); parser.delegate = decoder; parser.shouldResolveExternalEntities = false
        guard parser.parse(), !decoder.invalid, decoder.runs.map(\.text).joined() == text else { return plain }
        let result = NSMutableAttributedString(string: "")
        for run in decoder.runs {
            var traits: UIFontDescriptor.SymbolicTraits = []
            if run.bold { traits.insert(.traitBold) }; if run.italic { traits.insert(.traitItalic) }
            let descriptor = font.fontDescriptor.withSymbolicTraits(traits) ?? font.fontDescriptor
            var attributes: [NSAttributedString.Key: Any] = [.font: UIFont(descriptor: descriptor, size: font.pointSize), .foregroundColor: UIColor.label]
            if run.underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
            result.append(NSAttributedString(string: run.text, attributes: attributes))
        }
        return result
    }
}
private final class ComposerMarkupDecoder: NSObject, XMLParserDelegate {
    struct Run { let text: String; let bold: Bool; let italic: Bool; let underline: Bool }
    var runs: [Run] = []
    var invalid = false
    private var bold = 0, italic = 0, underline = 0
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        guard attributes.isEmpty else { invalid = true; parser.abortParsing(); return }
        switch name.lowercased() {
        case "html", "body": break
        case "strong": bold += 1
        case "em": italic += 1
        case "u": underline += 1
        case "br": append("\n")
        default: invalid = true; parser.abortParsing()
        }
    }
    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        switch name.lowercased() { case "strong": bold -= 1; case "em": italic -= 1; case "u": underline -= 1; default: break }
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) { append(string) }
    func parser(_ parser: XMLParser, resolveExternalEntityName name: String, systemID: String?) -> Data? { invalid = true; return nil }
    private func append(_ text: String) { runs.append(Run(text: text, bold: bold > 0, italic: italic > 0, underline: underline > 0)) }
}
