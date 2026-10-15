"""Native WKWebView: fixed workspace indicators stay in physical coordinates."""
import json
from pathlib import Path
import time

import AppKit
import Foundation
import WebKit

ROOT = Path(__file__).resolve().parents[1]


def main():
    AppKit.NSApplication.sharedApplication()
    config = WebKit.WKWebViewConfiguration.alloc().init()
    config.setWebsiteDataStore_(WebKit.WKWebsiteDataStore.nonPersistentDataStore())
    view = WebKit.WKWebView.alloc().initWithFrame_configuration_(((0, 0), (1280, 800)), config)
    source = (ROOT / 'app/web/static/app.js').read_text()
    start = source.index('const MAIN_SCROLL_SELECTOR =')
    script = source[start:source.index('initMainScrollIndicators();', start) + len('initMainScrollIndicators();')]
    css = (ROOT / 'app/web/static/style.css').read_text()
    view.loadHTMLString_baseURL_('''<!doctype html><style>''' + css + '''</style><style>
      html,body{margin:0;padding:0}body{display:block!important;overflow:hidden!important}
      .reading-pane{display:block!important;position:absolute!important;inset:0!important;width:100%!important;height:100%!important;min-width:0!important;border:0!important;padding:0!important}
      .fixture{height:3000px;width:100%}
    </style><body><section class="reading-pane"><div class="fixture">Local reader fixture</div></section><script>''' + script + '''</script></body>''', Foundation.NSURL.URLWithString_('http://reader-scrollbar.test/'))

    def wait(predicate, timeout=5):
        until = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= until:
                raise AssertionError('Native reader scrollbar timed out')
            Foundation.NSRunLoop.currentRunLoop().runUntilDate_(Foundation.NSDate.dateWithTimeIntervalSinceNow_(.01))

    def evaluate(js):
        result = []
        view.evaluateJavaScript_completionHandler_(js, lambda value, error: result.append((value, error)))
        wait(lambda: bool(result))
        assert result[0][1] is None, str(result[0][1])
        return result[0][0]

    wait(lambda: not view.isLoading())
    for width, height in ((1280, 800), (1440, 900), (1920, 1080)):
        view.setFrame_(((0, 0), (width, height)))
        for zoom in (.9, 1, 1.1, 1.3):
            evaluate(f"document.body.style.zoom={zoom};document.body.style.width='calc(100vw / {zoom})';document.body.style.height='calc(100vh / {zoom})'")
            for fraction in (0, .5, 1):
                state = json.loads(evaluate('''JSON.stringify((()=>{
                  const p=document.querySelector('.reading-pane');p.scrollTop=(p.scrollHeight-p.clientHeight)*''' + str(fraction) + ''';showScrollIndicator(p);
                  const a=p.getBoundingClientRect(),b=scrollIndicators.get(p).getBoundingClientRect(),t=scrollIndicators.get(p).firstElementChild.getBoundingClientRect();
                  return {gap:a.right-b.right,top:b.top-a.top,bottom:a.bottom-b.bottom,width:b.width,thumbTop:t.top,thumbBottom:t.bottom,trackTop:b.top,trackBottom:b.bottom};
                })())'''))
                detail = (width, height, zoom, fraction, state)
                assert abs(state['gap'] - 4) < 1, detail
                assert abs(state['width'] - 5) < .2, detail
                assert abs(state['top'] - 13) < 1 and abs(state['bottom'] - 13) < 1, detail
                assert state['thumbTop'] >= state['trackTop'] - 1 and state['thumbBottom'] <= state['trackBottom'] + 1, detail
                if fraction == 1:
                    assert abs(state['thumbBottom'] - state['trackBottom']) < 2, detail
    wait(lambda: evaluate("!scrollIndicators.get(document.querySelector('.reading-pane')).classList.contains('is-visible')"))
    print('PASS native WKWebView: 1280/1440/1920px, 90–130% zoom, physical scrollbar edge/width/travel and automatic hiding')


if __name__ == '__main__':
    main()
