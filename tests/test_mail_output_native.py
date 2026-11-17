"""Exercise native preview scrolling and desktop PDF rendering in isolated processes."""
import importlib.util
from pathlib import Path
import os
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))


def scroll_child():
    import json
    import time
    import AppKit
    import Foundation
    import Quartz
    import WebKit
    from app.mail_output import CSS, CSP

    AppKit.NSApplication.sharedApplication()
    config = WebKit.WKWebViewConfiguration.alloc().init()
    config.setWebsiteDataStore_(WebKit.WKWebsiteDataStore.nonPersistentDataStore())
    view = WebKit.WKWebView.alloc().initWithFrame_configuration_(((0, 0), (1200, 800)), config)
    window = AppKit.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
        ((100, 100), (1200, 800)), AppKit.NSWindowStyleMaskTitled, AppKit.NSBackingStoreBuffered, False)
    window.setTitle_('MailAI local scroll test')
    window.setContentView_(view)
    window.orderFrontRegardless()

    def wait(predicate, timeout=5):
        end = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > end:
                raise AssertionError('Native mail preview scroll check timed out')
            Foundation.NSRunLoop.currentRunLoop().runUntilDate_(Foundation.NSDate.dateWithTimeIntervalSinceNow_(.01))

    def evaluate(js):
        result = []
        view.evaluateJavaScript_completionHandler_(js, lambda value, error: result.append((value, error)))
        wait(lambda: bool(result))
        value, error = result[0]
        assert error is None, str(error)
        return value

    paragraphs = ''.join(f'<p>Long synthetic message line {n}</p>' for n in range(120))
    document = f'<!doctype html><meta http-equiv="Content-Security-Policy" content="{CSP}"><style>{CSS}</style><h1>Scroll fixture</h1>{paragraphs}'
    data = dict(document=document, filename='Synthetic fixture', text='Synthetic message\n' * 200, notes=[])
    stubs = '''const selectedEmailDetail={id:1},selectedEmailAccountId='fixture',MAILAI_UI_COPY={};
      const mailaiT=k=>k,mailaiSystemMessage=x=>x,activeMailAccount=()=>({id:'fixture'});
      const richEmailBasePalette=()=>({ink:'#222',muted:'#666',link:'#333',line:'#ddd'});
      async function api(){return ''' + json.dumps(data) + ''';}'''
    css = (ROOT / 'app/web/static/mail-output.css').read_text()
    script = (ROOT / 'app/web/static/mail-output.js').read_text()
    html = '''<!doctype html><html data-theme="light"><style>
      :root{--desk-surface:white;--desk-ink:#222;--desk-muted:#666}*{box-sizing:border-box}body{margin:0}
      </style><style>''' + css + '</style><body><script>' + stubs + script + '</script>'
    try:
        view.loadHTMLString_baseURL_(html, Foundation.NSURL.URLWithString_('http://mail-output.test/'))
        wait(lambda: not view.isLoading())
        for mode in ('print', 'share'):
            evaluate(f"window.mailaiMailOutput.open('{mode}');void 0")
            wait(lambda: evaluate("!!document.querySelector('#mail-output-preview')?.hasAttribute('data-ready')"))
            # Let AppKit commit the newly loaded iframe's scrolling tree.
            rendered = time.monotonic() + .3
            wait(lambda: time.monotonic() >= rendered)

            def state():
                return json.loads(evaluate('''JSON.stringify((()=>{
                  const frame=document.querySelector('#mail-output-preview'),doc=frame.contentDocument;
                  const track=document.querySelector('#mail-output-preview-host .mail-output-scrollbar');
                  return {top:doc.scrollingElement.scrollTop,width:doc.body.getBoundingClientRect().width,
                    visible:track.classList.contains('output-scrollbar-visible'),opacity:getComputedStyle(track.firstChild).opacity,
                    nativeHidden:frame.contentWindow.getComputedStyle(doc.documentElement).scrollbarWidth==='none'||frame.contentWindow.getComputedStyle(doc.documentElement,'::-webkit-scrollbar').display==='none',
                    footer:document.querySelector('#mail-output-dialog footer').getBoundingClientRect().top};
                })())'''))

            before = state()
            assert before['nativeHidden'] and not before['visible'], before
            # Send an actual AppKit wheel event to WKWebView, without posting
            # global input or touching the installed app or user's mailbox.
            point = window.convertPointToScreen_((600, 400))
            event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitPixel, 1, -480)
            Quartz.CGEventSetLocation(event, (point.x, AppKit.NSScreen.mainScreen().frame().size.height - point.y))
            view.scrollWheel_(AppKit.NSEvent.eventWithCGEvent_(event))
            wait(lambda: state()['top'] > 0 and state()['visible'])
            active = state()
            assert abs(active['width'] - before['width']) <= 1, (before, active)
            assert active['footer'] == before['footer'], (before, active)
            wait(lambda: not state()['visible'] and float(state()['opacity']) == 0)
            idle = state()
            assert idle['nativeHidden'] and abs(idle['width'] - before['width']) <= 1, idle
            evaluate("document.querySelector('[data-output-close]').click()")
            assert evaluate("document.querySelectorAll('.mail-output-scrollbar').length") == 0
        print('PASS native WKWebView: real wheel in print/share, idle hiding, stable width/footer, sandbox and cleanup', flush=True)
    finally:
        window.close()


def child(directory):
    import webview
    from pypdf import PdfReader
    from app.mail_output import CSS, CSP
    from app.desktop_mail_output import render_pdf
    if sys.platform == 'darwin':
        from webview.platforms import cocoa
        from app.mail_navigation import navigation_delegate
        # Match the real shell's global navigation boundary, including its
        # refusal to load file: URLs. Output must not weaken that policy.
        cocoa.BrowserView.BrowserDelegate = navigation_delegate(
            cocoa.BrowserView.BrowserDelegate,'http://127.0.0.1:18795/',lambda url:None)
    host = webview.create_window('MailAI output fixture',html='<p>Synthetic fixture</p>',hidden=True)
    failed = []
    def probe():
        try:
            for rows in (1,160):
                path = Path(directory)/f'output-{rows}.pdf'
                body = '<header class="mail-output-header"><h1>单封邮件打印与分享</h1></header><main class="mail-output-body"><table>'+''.join(
                    f'<tr><td>ROW{n:03d} unique</td><td>分页验证</td></tr>' for n in range(rows))+'</table></main>'
                document = f'<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{CSP}"><style>{CSS}</style></head><body>{body}</body></html>'
                render_pdf(document,path)
                reader = PdfReader(path)
                assert len(reader.pages) == 1 if rows == 1 else len(reader.pages) > 1
                text = '\n'.join(page.extract_text() for page in reader.pages)
                for n in range(rows):
                    assert text.count(f'ROW{n:03d} unique') == 1, (rows,n)
                sizes = [(float(page.mediabox.width), float(page.mediabox.height)) for page in reader.pages]
                assert all(abs(width - 595.28) < 1 and abs(height - 841.89) < 1
                           for width, height in sizes), sizes
                print('PASS native PDF',rows,'rows',len(reader.pages),'pages',flush=True)
        except BaseException as error:
            import traceback
            traceback.print_exc()
            failed.append(error)
        finally:
            host.destroy()
    webview.start(probe,gui='cocoa' if sys.platform=='darwin' else 'edgechromium',debug=False)
    if failed:
        raise SystemExit(1)


def main():
    if sys.platform not in ('darwin','win32') or importlib.util.find_spec('webview') is None:
        print('SKIP native PDF: desktop renderer is not installed on this platform')
        return
    with tempfile.TemporaryDirectory(prefix='mailai-output-test-') as directory:
        if sys.platform == 'darwin':
            subprocess.run([sys.executable, __file__, '--scroll-child'], cwd=ROOT, check=True, timeout=60)
        command=[sys.executable,__file__,'--child',directory]
        process=subprocess.Popen(command,cwd=ROOT,start_new_session=sys.platform!='win32')
        try:
            code=process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            if sys.platform=='win32': process.kill()
            else: os.killpg(process.pid,signal.SIGKILL)
            process.wait()
            raise AssertionError('Native PDF renderer timed out')
        assert code==0, f'Native PDF renderer failed: {code}'


if __name__=='__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--scroll-child':
        scroll_child()
    elif len(sys.argv) > 1 and sys.argv[1] == '--child':
        child(sys.argv[2])
    else:
        main()
