"""Exercise the production mail renderer in the actual macOS WKWebView engine."""
import json
import time
import sys
from pathlib import Path

import AppKit
import Foundation
import WebKit
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.mail_navigation import navigation_delegate


def main():
    AppKit.NSApplication.sharedApplication()
    config = WebKit.WKWebViewConfiguration.alloc().init()
    view = WebKit.WKWebView.alloc().initWithFrame_configuration_(((0, 0), (900, 700)), config)
    calls = []
    mail_routes = []
    def route_link(target):
        if target.lower().startswith('mailto:'):
            mail_routes.append(target)
            view.evaluateJavaScript_completionHandler_(
                'window.mailaiOpenMailto?.(' + json.dumps(target) + ')', lambda _value, _error: None
            )
        else:
            calls.append(target)
    class BaseDelegate(Foundation.NSObject):
        def webView_decidePolicyForNavigationAction_decisionHandler_(self, webview, action, handler):
            handler(1)
    delegate = navigation_delegate(BaseDelegate, 'http://mailai.test/', route_link).alloc().init()
    view.setNavigationDelegate_(delegate)
    source = (Path(__file__).resolve().parents[1] / 'app/web/static/app.js').read_text()
    functions = source[source.index('function externalLinkUrl('):source.index('\nfunction renderFindings(')]
    view.loadHTMLString_baseURL_('<html><body><div id="rich-email-body"></div></body></html>', Foundation.NSURL.URLWithString_('http://mailai.test/'))

    def spin_until(predicate, timeout=8):
        end = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > end:
                raise AssertionError('WKWebView timed out')
            Foundation.NSRunLoop.currentRunLoop().runUntilDate_(Foundation.NSDate.dateWithTimeIntervalSinceNow_(.01))

    def evaluate(script):
        results = []
        view.evaluateJavaScript_completionHandler_(script, lambda value, error: results.append((value, error)))
        spin_until(lambda: bool(results))
        value, error = results[0]
        assert error is None, str(error)
        return value

    spin_until(lambda: not view.isLoading())
    evaluate("window.calls=[];window.composeCalls=[];window.notices=[];window.toast=(...x)=>notices.push(x);window.normalizeRecipientText=x=>x.replace(/\\s*,\\s*/g,', ');window.esc=x=>x.replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));window.openCompose=x=>composeCalls.push(x);window.pywebview={api:{open_external_url:async u=>{calls.push(u);return {ok:true}}}};" + functions)
    fixtures = [
        ('<a href="https://example.test/pay?a=1&amp;b=2"><span>查看工资条</span></a>', 'a', 'https://example.test/pay?a=1&b=2', 'web'),
        ('<a href="https://example.test/image" target="_blank"><img alt="图片链接" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></a>', 'a', 'https://example.test/image', 'web'),
        ('<map name="m"><area shape="rect" coords="0,0,10,10" href="https://example.test/map"></map>', 'area', 'https://example.test/map', 'web'),
        ('<a href="mailto:person@example.test?cc=copy%40example.test&amp;subject=%E9%A1%B9%E7%9B%AE&amp;body=%E6%82%A8%E5%A5%BD%0A%E8%B0%A2%E8%B0%A2">写邮件</a>', 'a', 'person@example.test', 'mail'),
    ]
    for content, selector, target, kind in fixtures:
        fixture = '<html><head><title>fixture</title></head><body><p>邮件正文</p>' + content + '</body></html>'
        evaluate('mountRichEmailBody({body_html:' + json.dumps(fixture) + '});')
        spin_until(lambda: evaluate("document.querySelector('iframe').contentDocument?.readyState === 'complete' && !!document.querySelector('iframe').contentDocument?.querySelector(" + json.dumps(selector) + ")"))
        before = len(calls) if kind == 'web' else evaluate('composeCalls.length')
        for _ in range(3):
            evaluate("document.querySelector('iframe').contentDocument.querySelector(" + json.dumps(selector) + ").click()")
            before += 1
            if kind == 'web':
                spin_until(lambda: len(calls) == before)
                assert calls[-1] == target
            else:
                spin_until(lambda: evaluate('composeCalls.length') == before)
                assert mail_routes[-1].startswith('mailto:')
                assert evaluate('composeCalls.at(-1).to_addr') == target
                assert evaluate('composeCalls.at(-1).cc_addr') == 'copy@example.test'
                assert evaluate('composeCalls.at(-1).subject') == '项目'
                assert evaluate('composeCalls.at(-1).message_html') == '您好<br>谢谢'
            assert '邮件正文' in evaluate("document.querySelector('iframe').contentDocument.body.innerText")
    # A native cancellation also keeps a mail frame intact when a form attempts
    # to leave it; CSP/sandbox continue blocking email scripts independently.
    evaluate('mountRichEmailBody({body_html:' + json.dumps('<p>邮件正文</p><script>parent.calls.push("unsafe")</script><a href="file:///tmp/mailai-test">bad</a><a id="custom" href="mailai-unsafe://test">custom</a><form action="https://example.test/form"><button>submit</button></form>') + '});')
    spin_until(lambda: evaluate("document.querySelector('iframe').contentDocument?.readyState === 'complete'"))
    before = len(calls)
    evaluate("document.querySelector('iframe').contentDocument.querySelector('a').click()")
    evaluate("document.querySelector('iframe').contentDocument.querySelector('#custom').click()")
    evaluate("document.querySelector('iframe').contentDocument.querySelector('form').submit()")
    end = time.monotonic() + .2
    spin_until(lambda: time.monotonic() > end)
    assert len(calls) == before
    assert '邮件正文' in evaluate("document.querySelector('iframe').contentDocument.body.innerText")
    assert evaluate('calls.length') == 0, 'email scripts must remain disabled'
    print('Native WKWebView: web links open externally, mailto opens MailAI compose, body preserved, scripts blocked')


if __name__ == '__main__':
    main()
