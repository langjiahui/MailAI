import XCTest
import UIKit
import WebKit
@testable import MailAI

@MainActor final class MailHTMLReadabilityTests: XCTestCase {
    private final class Ready: NSObject, WKNavigationDelegate {
        let finished: XCTestExpectation
        init(_ finished: XCTestExpectation) { self.finished = finished }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished.fulfill() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            XCTFail(error.localizedDescription); finished.fulfill()
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            XCTFail(error.localizedDescription); finished.fulfill()
        }
    }

    func testLegacyTextAndTableRemainReadableAcrossAppThemes() async throws {
        let view = SafeMailHTML.makeMailWebView()
        let controller = UIViewController()
        let window: UIWindow
        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene { window = UIWindow(windowScene: scene) }
        else { window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852)) }
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = controller; window.isHidden = false
        view.frame = CGRect(x: 16, y: 100, width: 361, height: 500)
        controller.view.addSubview(view)
        defer { view.stopLoading(); view.removeFromSuperview(); window.isHidden = true }
        XCTAssertFalse(view.configuration.defaultWebpagePreferences.allowsContentJavaScript)
        let html = """
        <div style="color:#000000"><p><font id="legacy" color="black">企业正文黑字</font></p>
        <table><tr><td id="cell" style="color:#000">表格黑字</td><td id="red" style="color:#ff0000">红色重点</td></tr></table></div>
        <script>window.untrustedMailScriptRan=true</script>
        """
        let authoredDark = """
        <body bgcolor="#111111" text="white"><p><font id="legacy" color="white">原版深色邮件</font></p>
        <table bgcolor="#111111"><tr><td id="cell"><font color="white">原版浅色表格文字</font></td><td id="red" style="color:red">红色重点</td></tr></table></body>
        """
        for (markup, expectedText, expectedBackground) in [
            (html, "rgb(0, 0, 0)", "rgb(255, 255, 255)"),
            (authoredDark, "rgb(255, 255, 255)", "rgb(17, 17, 17)")
        ] {
          let ready = expectation(description: "HTML loaded")
          let delegate = Ready(ready); view.navigationDelegate = delegate
          defer { view.navigationDelegate = nil; _ = delegate }
          view.loadHTMLString(MailHTMLDocument.render(markup), baseURL: nil)
          await fulfillment(of: [ready], timeout: 15)
          for style in [UIUserInterfaceStyle.dark, .light, .dark] {
            window.overrideUserInterfaceStyle = style
            controller.view.layoutIfNeeded()
            let value = try await view.evaluateJavaScript("""
            JSON.stringify({background:(()=>{for(let e=document.getElementById('legacy');e;e=e.parentElement){const c=getComputedStyle(e).backgroundColor;if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')return c;}})(),
              text:getComputedStyle(document.getElementById('legacy')).color,
              cell:getComputedStyle(document.getElementById('cell')).color,
              red:getComputedStyle(document.getElementById('red')).color,
              dark:matchMedia('(prefers-color-scheme:dark)').matches,
              untrustedScriptRan:window.untrustedMailScriptRan===true})
            """)
            let json = try XCTUnwrap(value as? String)
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
            XCTAssertEqual(result["background"] as? String, expectedBackground)
            XCTAssertEqual(result["text"] as? String, expectedText)
            XCTAssertEqual(result["cell"] as? String, expectedText)
            XCTAssertEqual(result["red"] as? String, "rgb(255, 0, 0)")
            XCTAssertEqual(result["dark"] as? Bool, false)
            XCTAssertEqual(result["untrustedScriptRan"] as? Bool, false)
          }
        }
    }
}
