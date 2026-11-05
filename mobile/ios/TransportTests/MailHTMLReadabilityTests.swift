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

    // UIKit delivers trait changes to WebKit asynchronously. Keep the assertion,
    // but wait for the actual media query before measuring a newly loaded page.
    private func waitForAppearance(_ dark: Bool, in view: WKWebView) async throws {
        for _ in 0..<100 {
            if try await view.evaluateJavaScript("matchMedia('(prefers-color-scheme:dark)').matches") as? Bool == dark { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("WebKit did not adopt the requested appearance")
    }

    func testFixedWidthMailFitsQRCodeAndActionAcrossWidthsAndThemes() async throws {
        let view = SafeMailHTML.makeMailWebView()
        let controller = UIViewController()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene); window.frame = CGRect(x: 0, y: 0, width: 844, height: 852)
        window.rootViewController = controller; window.isHidden = false; controller.view.addSubview(view)
        defer { view.stopLoading(); view.removeFromSuperview(); window.isHidden = true }
        for dark in [false, true] {
            view.overrideUserInterfaceStyle = dark ? .dark : .light
            window.overrideUserInterfaceStyle = dark ? .dark : .light
            for width in [320.0, 700.0, 361.0] {
                view.frame = CGRect(x: 0, y: 0, width: width, height: 600)
                let ready = expectation(description: "Wide mail loaded")
                let delegate = Ready(ready); view.navigationDelegate = delegate
                view.loadHTMLString(MailHTMLDocument.render(DebugPreview.wideHTML, dark: dark), baseURL: nil)
                await fulfillment(of: [ready], timeout: 15)
                try await Task.sleep(for: .milliseconds(150))
                let evaluated = try await view.evaluateJavaScript("""
                JSON.stringify((()=>{
                  const image=document.getElementById('wide-image'),button=document.getElementById('wide-action');
                  const i=image.getBoundingClientRect(),b=button.getBoundingClientRect();
                  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
                  let overlap=false,node;
                  while(node=walker.nextNode()){
                    if(!node.textContent.trim()||node.parentElement.tagName==='SCRIPT')continue;
                    const range=document.createRange();range.selectNodeContents(node);
                    const lines=[...range.getClientRects()].filter(r=>r.width&&r.height);
                    overlap ||= lines.some((r,index)=>index>0&&r.top>lines[index-1].top+1&&r.top<lines[index-1].bottom-.5);
                  }
                  return {width:innerWidth,scroll:document.documentElement.scrollWidth,imageLeft:i.left,imageRight:i.right,
                    imageRatio:i.width/i.height,imageLoaded:image.complete&&image.naturalWidth===180,
                    buttonLeft:b.left,buttonRight:b.right,scale:Number(document.documentElement.dataset.mailaiScale),
                    overlappingTextLines:overlap,
                    height:document.documentElement.scrollHeight,viewports:document.querySelectorAll('meta[name=viewport]').length,
                    senderScriptRan:window.untrustedMailScriptRan===true};
                })())
                """)
                let json = try XCTUnwrap(evaluated as? String)
                let value = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String:Any])
                XCTAssertLessThanOrEqual(try XCTUnwrap(value["scroll"] as? Double), width+1, json)
                for key in ["imageRight", "buttonRight"] { XCTAssertLessThanOrEqual(try XCTUnwrap(value[key] as? Double), width+1, json) }
                for key in ["imageLeft", "buttonLeft"] { XCTAssertGreaterThanOrEqual(try XCTUnwrap(value[key] as? Double), 0, json) }
                XCTAssertEqual(try XCTUnwrap(value["imageRatio"] as? Double), 1, accuracy: 0.01, json)
                XCTAssertEqual(value["imageLoaded"] as? Bool, true, json)
                XCTAssertEqual(value["overlappingTextLines"] as? Bool, false, json)
                XCTAssertEqual(value["viewports"] as? Int, 1)
                XCTAssertEqual(value["senderScriptRan"] as? Bool, false)
                XCTAssertLessThan(try XCTUnwrap(value["scale"] as? Double), 1, json)
                XCTAssertLessThan(try XCTUnwrap(value["height"] as? Double), 1200, json)
                XCTAssertTrue(view.configuration.ignoresViewportScaleLimits)
                XCTAssertFalse(view.configuration.defaultWebpagePreferences.allowsContentJavaScript)
            }
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
        <table><tr><td id="cell" style="color:#000;border:1px solid #777">表格黑字</td><td id="red" style="color:#ff0000">红色重点</td></tr></table>
        <p><a id="link" href="https://example.com">链接</a></p>
        <img id="image" alt="合成图片" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGNkiFv1n4GBgYEJRIAwAB3+AgtOamNiAAAAAElFTkSuQmCC">
        </div><script>window.untrustedMailScriptRan=true;document.body.dataset.untrusted='true'</script>
        """
        let authoredDark = """
        <body bgcolor="#111111" text="white"><p><font id="legacy" color="white">原版深色邮件</font></p>
        <table bgcolor="#111111"><tr><td id="cell" style="color:white">原版浅色表格文字</td><td id="red" style="color:red">红色重点</td></tr></table></body>
        """
        let styled = """
        <style>.authored{background:#fff!important;color:#000!important}.shade{background:#eeeeee}td{border:1px solid #ccc}</style>
        <div class="authored"><p id="legacy" style="-webkit-text-fill-color:black">样式表黑字</p><table class="shade"><tr><td id="cell">灰底表格</td><td id="red" style="color:red">重点</td></tr></table></div>
        """
        let colored = """
        <div style="background:#f6e4cf;color:#482408"><p id="legacy">暖色背景正文</p><table><tr><td id="cell" style="background:rgba(255,255,255,.8)">半透明表格</td><td id="red" style="color:red">重点</td></tr></table></div>
        """
        let gradient = """
        <div style="background:linear-gradient(white,#eee);color:black"><p id="legacy">渐变背景正文</p><table><tr><td id="cell">继承文字</td><td id="red" style="color:red">重点</td></tr></table></div>
        """
        let fixtures = [(html, "rgb(0, 0, 0)", "rgb(255, 255, 255)"),
                        (authoredDark, "rgb(255, 255, 255)", "rgb(17, 17, 17)"),
                        (styled, "rgb(0, 0, 0)", "rgb(255, 255, 255)"),
                        (colored, "rgb(72, 36, 8)", "rgb(246, 228, 207)"),
                        (gradient, "rgb(0, 0, 0)", "rgb(255, 255, 255)")]
        // Reload in both directions, as the representable does when the system
        // changes theme or the reader switches to the sender's original style.
        for (markup, expectedText, expectedBackground) in fixtures {
          for dark in [false, true, false] {
            window.overrideUserInterfaceStyle = dark ? .dark : .light
            view.overrideUserInterfaceStyle = dark ? .dark : .light
            let ready = expectation(description: "HTML loaded")
            let delegate = Ready(ready); view.navigationDelegate = delegate
            view.loadHTMLString(MailHTMLDocument.render(markup, dark: dark), baseURL: nil)
            await fulfillment(of: [ready], timeout: 15)
            try await waitForAppearance(dark, in: view)
            _ = delegate
            let value = try await view.evaluateJavaScript("""
            JSON.stringify((()=>{
              const rgb=s=>(s.match(/[0-9.]+/g)||[]).map(Number);
              const blend=(a,b)=>a.slice(0,3).map((v,i)=>v*(a[3]??1)+b[i]*(1-(a[3]??1)));
              const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
              const bg=e=>{for(let p=e;p;p=p.parentElement){const c=getComputedStyle(p).backgroundColor;if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')return c;}};
              const compositeBackground=e=>e?blend(rgb(getComputedStyle(e).backgroundColor),compositeBackground(e.parentElement)):[255,255,255];
              const ratio=e=>{const s=getComputedStyle(e),background=compositeBackground(e),a=lum(blend(rgb(s.webkitTextFillColor||s.color),background)),b=lum(background);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
              const text=document.getElementById('legacy'),cell=document.getElementById('cell'),red=rgb(getComputedStyle(document.getElementById('red')).color);
              return {background:bg(text),text:getComputedStyle(text).color,cell:getComputedStyle(cell).color,
                root:getComputedStyle(document.documentElement).backgroundColor,textContrast:ratio(text),cellContrast:ratio(cell),
                red,redContrast:ratio(document.getElementById('red')),dark:matchMedia('(prefers-color-scheme:dark)').matches,
                adapted:document.documentElement.dataset.mailaiAppearance==='dark',
                imagePreserved:!document.getElementById('image')||(document.getElementById('image').complete&&document.getElementById('image').naturalWidth===2&&getComputedStyle(document.getElementById('image')).filter==='none'),
                untrustedScriptRan:window.untrustedMailScriptRan===true||document.body.dataset.untrusted==='true'};
            })())
            """)
            let json = try XCTUnwrap(value as? String)
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
            if dark {
                XCTAssertEqual(result["root"] as? String, "rgb(23, 35, 48)", json)
                XCTAssertGreaterThanOrEqual(try XCTUnwrap(result["textContrast"] as? Double), 4.5, json)
                XCTAssertGreaterThanOrEqual(try XCTUnwrap(result["cellContrast"] as? Double), 4.5, json)
                XCTAssertGreaterThanOrEqual(try XCTUnwrap(result["redContrast"] as? Double), 4.5, json)
            } else {
                XCTAssertEqual(result["background"] as? String, expectedBackground, json)
                XCTAssertEqual(result["text"] as? String, expectedText, json)
            }
            let red = try XCTUnwrap(result["red"] as? [Double])
            XCTAssertGreaterThan(red[0], red[1], "Red emphasis must remain red: " + json)
            XCTAssertGreaterThan(red[0], red[2], json)
            XCTAssertEqual(result["dark"] as? Bool, dark, json)
            XCTAssertEqual(result["adapted"] as? Bool, dark)
            XCTAssertEqual(result["imagePreserved"] as? Bool, true)
            XCTAssertEqual(result["untrustedScriptRan"] as? Bool, false)
            XCTAssertFalse(view.configuration.defaultWebpagePreferences.allowsContentJavaScript)
          }
        }
    }
}
