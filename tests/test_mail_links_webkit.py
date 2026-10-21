"""Exercise the production mail renderer in the actual macOS WKWebView engine."""
import json
import time
import sys
from pathlib import Path

import AppKit
import Foundation
import WebKit
from webview.platforms import cocoa
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.mail_navigation import navigation_delegate
from app.desktop import restore_native_context_menu


def main():
    AppKit.NSApplication.sharedApplication()
    config = WebKit.WKWebViewConfiguration.alloc().init()
    host = cocoa.BrowserView.WebKitHost
    restore_native_context_menu(host)
    view = host.alloc().initWithFrame_configuration_(((0, 0), (900, 700)), config)
    # Attach a responder chain without showing or focusing a test window.
    window = AppKit.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
        ((-5000, -5000), (900, 700)), AppKit.NSWindowStyleMaskTitled,
        AppKit.NSBackingStoreBuffered, False,
    )
    window.setReleasedWhenClosed_(False)
    window.setContentView_(view)
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
    static = Path(__file__).resolve().parents[1] / 'app/web/static'
    evaluate('\n'.join((static / name).read_text(encoding='utf-8') for name in
                       ('i18n.js', 'i18n-catalog.js', 'i18n-runtime.js')))
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

    # The production pywebview host must keep the system's text/edit commands,
    # rather than clearing them and leaving only macOS Services.
    menu = AppKit.NSMenu.alloc().init()
    copy_item = menu.addItemWithTitle_action_keyEquivalent_('Copy', 'copy:', 'c')
    select_item = menu.addItemWithTitle_action_keyEquivalent_('Select All', 'selectAll:', 'a')
    assert not cocoa._state['debug']
    view.performSelector_withObject_withObject_('willOpenMenu:withEvent:', menu, None)
    assert menu.numberOfItems() == 2 and menu.itemAtIndex_(0) is copy_item
    assert menu.itemAtIndex_(1) is select_item and cocoa.BrowserView.WebKitHost is host

    selected = evaluate("const mail=document.querySelector('iframe');mail.contentWindow.focus();mail.contentWindow.getSelection().selectAllChildren(mail.contentDocument.querySelector('p'));mail.contentWindow.getSelection().toString()")
    assert selected == '邮件正文'
    window.makeFirstResponder_(view)
    board = AppKit.NSPasteboard.generalPasteboard()
    saved = []
    for original in board.pasteboardItems() or []:
        item = AppKit.NSPasteboardItem.alloc().init()
        for kind in original.types():
            data = original.dataForType_(kind)
            if data is not None:
                item.setData_forType_(data, kind)
        saved.append(item)
    written = None
    try:
        view.copy_(None)
        written = board.changeCount()
        spin_until(lambda: board.stringForType_(AppKit.NSPasteboardTypeString) == selected)
        event = AppKit.NSEvent.keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode_(
            AppKit.NSKeyDown, (0, 0), AppKit.NSCommandKeyMask, 0,
            window.windowNumber(), None, 'c', 'c', False, 8,
        )
        view.keyDown_(event)
        written = board.changeCount()
        assert board.stringForType_(AppKit.NSPasteboardTypeString) == selected
    finally:
        # Restore the user's clipboard unless another app changed it meanwhile.
        if written is not None and board.changeCount() == written:
            board.clearContents()
            if saved:
                board.writeObjects_(saved)
        window.close()
    print('Native WKWebView: links/mailto, selected HTML mail text, native Copy/Cmd+C, context menu retained and scripts blocked')


if __name__ == '__main__':
    main()
