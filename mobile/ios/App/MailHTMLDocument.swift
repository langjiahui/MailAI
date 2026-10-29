import Foundation

/// HTML mail is an authored document. Keep its paper light so legacy inline
/// black text and meaningful red emphasis do not depend on the app's theme.
enum MailHTMLDocument {
    static func render(_ html: String, fontSize: Double = 17) -> String {
        let size = fontSize.isFinite && fontSize > 0 ? fontSize : 17
        // This policy precedes untrusted markup; later policies cannot relax it.
        let csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'"
        return """
        <!doctype html><html><head><meta http-equiv='Content-Security-Policy' content="\(csp)"><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='color-scheme' content='light'><style>
        html{color-scheme:only light;background-color:Canvas;color:CanvasText}
        body{font:\(size)px -apple-system;line-height:1.6;margin:0;padding:12px;box-sizing:border-box;overflow-wrap:anywhere}
        img{max-width:100%;height:auto}table{max-width:100%}
        </style></head><body>\(html)</body></html>
        """
    }
}
