"""Native WKWebView regression: transparent colors alone do not hide its scroller.

Self-contained local HTML uses production settings CSS/JS. No mail, network,
installed app, credentials or system scrollbar preferences are touched.
"""
import json
import time
from pathlib import Path

import AppKit
import Foundation
import WebKit

ROOT = Path(__file__).resolve().parents[1]


def main():
    AppKit.NSApplication.sharedApplication()
    config = WebKit.WKWebViewConfiguration.alloc().init()
    config.setWebsiteDataStore_(WebKit.WKWebsiteDataStore.nonPersistentDataStore())
    view = WebKit.WKWebView.alloc().initWithFrame_configuration_(((0, 0), (1200, 720)), config)
    css = (ROOT / 'app/web/static/settings-polish.css').read_text()
    script = (ROOT / 'app/web/static/settings-scroll.js').read_text()
    html = '''<!doctype html><html data-theme="light"><head><style>
      *{box-sizing:border-box}body{margin:0}
      :root{--desk-canvas:#fff;--desk-surface:#fff;--desk-ink:#222;--desk-muted:#666;--desk-line:#ddd;--desk-selected:#eee;--desk-accent:#347b5d}
      #system-view{height:700px;display:grid;overflow:hidden}
      #system-view>.system-header{grid-column:1/-1}#system-view>.system-tabs{grid-column:1;grid-row:2}
      #system-view>.system-panel{grid-column:2;grid-row:2;min-height:0;overflow:auto}.hidden{display:none!important}
      .fixture-content{height:2400px;background:linear-gradient(#eee,#aaa)}
    </style><style>''' + css + '''</style></head><body><main id="system-view">
      <header class="system-header">Settings fixture</header>
      <nav class="system-tabs"><button data-system-tab="preferences">Preferences</button><button data-system-tab="about">About</button></nav>
      <section id="fixture-panel" class="system-panel"><div class="fixture-content">Scrollable content</div></section>
      <section id="other-panel" class="system-panel hidden"><div class="fixture-content">Another page</div></section>
    </main><script>''' + script + '''</script></body></html>'''
    view.loadHTMLString_baseURL_(html, Foundation.NSURL.URLWithString_('http://settings-scrollbar.test/'))

    def wait(predicate, timeout=5):
        end = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > end:
                raise AssertionError('Native WKWebView scrollbar check timed out')
            Foundation.NSRunLoop.currentRunLoop().runUntilDate_(Foundation.NSDate.dateWithTimeIntervalSinceNow_(.01))

    def evaluate(js):
        result = []
        view.evaluateJavaScript_completionHandler_(js, lambda value, error: result.append((value, error)))
        wait(lambda: bool(result))
        value, error = result[0]
        assert error is None, str(error)
        return value

    def delay(seconds):
        deadline = time.monotonic() + seconds
        wait(lambda: time.monotonic() >= deadline)

    def metrics(panel='fixture-panel'):
        return json.loads(evaluate('''JSON.stringify((()=>{
          const p=document.getElementById(''' + json.dumps(panel) + '''),s=getComputedStyle(p),child=p.firstElementChild.getBoundingClientRect();
          return {visible:p.classList.contains('scrollbar-visible'),width:s.scrollbarWidth||'',display:getComputedStyle(p,'::-webkit-scrollbar').display,
            gutter:p.offsetWidth-p.clientWidth,contentWidth:child.width,left:child.left,
            reserved:parseFloat(s.getPropertyValue('--settings-scrollbar-size'))};
        })())'''))

    def idle(panel='fixture-panel'):
        wait(lambda: not metrics(panel)['visible'])
        state = metrics(panel)
        assert state['width'] == 'none' or state['display'] == 'none', state
        assert state['gutter'] == 0, state
        return state

    wait(lambda: not view.isLoading())
    idle()  # Reject a native thumb even when its computed color is transparent.
    wait(lambda: evaluate("Number.isFinite(parseFloat(getComputedStyle(document.getElementById('fixture-panel')).getPropertyValue('--settings-scrollbar-size')))"))
    before = idle()
    evaluate("document.getElementById('fixture-panel').scrollTop=120")
    wait(lambda: metrics()['visible'])
    active = metrics()
    assert active['width'] == 'thin' or active['display'] == 'block', active
    assert abs(active['contentWidth'] - before['contentWidth']) <= 1, (before, active)
    after = idle()
    assert abs(after['contentWidth'] - before['contentWidth']) <= 1, (before, after)
    # A still pointer at the edge must not pin the native scrollbar.
    evaluate("{const p=document.getElementById('fixture-panel'),r=p.getBoundingClientRect();p.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.right-3,clientY:r.top+80,buttons:0}));}")
    wait(lambda: metrics()['visible'])
    idle()
    # Native chrome can consume pointerup; an unheld move also releases dragging.
    evaluate("{const p=document.getElementById('fixture-panel'),r=p.getBoundingClientRect();p.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,buttons:1,clientX:r.right-3,clientY:r.top+80}));}")
    delay(1.1)
    assert metrics()['visible']
    evaluate("{const p=document.getElementById('fixture-panel'),r=p.getBoundingClientRect();window.dispatchEvent(new PointerEvent('pointermove',{buttons:0,clientX:r.left-20,clientY:r.top+80}));}")
    idle()
    # A page revealed after initialization must measure and reserve its own gutter.
    evaluate("document.querySelector('[data-system-tab=about]').click();document.getElementById('fixture-panel').classList.add('hidden');document.getElementById('other-panel').classList.remove('hidden')")
    wait(lambda: evaluate("Number.isFinite(parseFloat(getComputedStyle(document.getElementById('other-panel')).getPropertyValue('--settings-scrollbar-size')))"))
    idle('other-panel')
    view.setFrame_(((0, 0), (620, 720)))
    delay(.1)
    before = idle('other-panel')
    evaluate("document.getElementById('other-panel').scrollTop=100")
    wait(lambda: metrics('other-panel')['visible'])
    assert abs(metrics('other-panel')['contentWidth'] - before['contentWidth']) <= 1
    idle('other-panel')
    print('PASS native WKWebView: idle native scrollbar removed, stable content width, scroll/edge timeout, drag recovery, deferred panel and resize')


if __name__ == '__main__':
    main()
