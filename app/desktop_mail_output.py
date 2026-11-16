"""Print and export inert mail documents using the installed desktop renderer."""
from __future__ import annotations

from pathlib import Path
import secrets
import sys
import tempfile
import threading
import time

_render_lock = threading.Lock()


def render_pdf(document: str, target: Path) -> None:
    """Use a dedicated document window, never the mailbox's live WebView."""
    if sys.platform not in ('darwin', 'win32'):
        from .browser_mail_pdf import render_pdf as browser_pdf
        target.write_bytes(browser_pdf(document))
        target.chmod(0o600)
        return

    import webview
    with _render_lock:
        source = target.with_suffix('.html')
        source.write_text(document, encoding='utf-8')
        source.chmod(0o600)
        window = None
        try:
            # A local file avoids WebView2's NavigateToString size limit. The
            # document has no scripts, external images, fonts or file URLs.
            location = {'html':document} if sys.platform == 'darwin' else {'url':source.as_uri()}
            # The macOS shell intentionally rejects file: navigation globally;
            # load inert HTML into about:blank there. Windows uses a local file
            # to avoid NavigateToString's size limit.
            window = webview.create_window('MailAI', **location, hidden=True,
                                           width=674, height=1100, js_api=None)
            if not window.events.loaded.wait(30):
                raise ValueError('邮件排版加载超时，请重试。')
            done, failures = threading.Event(), []
            slices = []
            abandoned = threading.Event()
            if sys.platform == 'darwin':
                import json
                from PyObjCTools import AppHelper
                from WebKit import WKPDFConfiguration
                def export():
                    from webview.platforms.cocoa import BrowserView
                    view = BrowserView.instances[window.uid].webview
                    def layout_ready(value, error):
                        if abandoned.is_set():
                            return
                        try:
                            if error:
                                raise ValueError(str(error))
                            layout = json.loads(str(value))
                            width, height = layout['width'], layout['height']
                            page_height = width * (841.89 - 90.7) / (595.28 - 90.7)
                            bounds, top = [], 0
                            while top < height:
                                bottom = min(top + page_height, height)
                                crossing = [a for a,b in layout['spans'] if a < bottom-.5 and b > bottom+.5 and b-a < page_height*.9]
                                if bottom < height and crossing and min(crossing) > top + page_height*.6:
                                    bottom = min(crossing)
                                bounds.append((top,bottom))
                                top = bottom
                                if len(bounds) > 500:
                                    raise ValueError('邮件正文过大，请导出原始邮件。')
                            def capture(index):
                                if abandoned.is_set():
                                    return
                                start,end = bounds[index]
                                configuration = WKPDFConfiguration.alloc().init()
                                configuration.setRect_(((0,start),(width,end-start)))
                                def captured(data, error):
                                    if abandoned.is_set():
                                        return
                                    try:
                                        if error or data is None:
                                            raise ValueError(str(error))
                                        slices.append(bytes(data))
                                        if sum(map(len,slices)) > 64*1024*1024:
                                            raise ValueError('邮件正文过大，请导出原始邮件。')
                                        if index+1 < len(bounds):
                                            capture(index+1)
                                        else:
                                            done.set()
                                    except Exception as failure:
                                        failures.append(failure)
                                        done.set()
                                view.createPDFWithConfiguration_completionHandler_(configuration, captured)
                            capture(0)
                        except Exception as failure:
                            failures.append(failure)
                            done.set()
                    # Native createPDF captures a region of the document. Choose
                    # boundaries between text lines and ordinary table rows,
                    # rather than relying on WKWebView's silent print loop.
                    script = """(() => {
                      document.body.style.padding='0';
                      const width=document.documentElement.clientWidth;
                      const height=Math.ceil(Math.max(1,document.body.getBoundingClientRect().bottom+scrollY));
                      const spans=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
                      let node,count=0;
                      while((node=walker.nextNode()) && count++<100000){
                        if(!node.textContent.trim() || node.parentElement.closest('style,script'))continue;
                        const range=document.createRange();range.selectNodeContents(node);
                        for(const rect of range.getClientRects())if(rect.height>0)spans.push([rect.top+scrollY,rect.bottom+scrollY]);
                      }
                      for(const el of document.querySelectorAll('tr,img')){const r=el.getBoundingClientRect();if(r.height>0)spans.push([r.top+scrollY,r.bottom+scrollY]);}
                      return JSON.stringify({width,height,spans});
                    })()"""
                    try:
                        view.evaluateJavaScript_completionHandler_(script, layout_ready)
                    except Exception as failure:
                        failures.append(failure)
                        done.set()
                AppHelper.callAfter(export)
            elif sys.platform == 'win32':
                from .windows_appearance import on_ui_thread
                from Microsoft.Web.WebView2.Core import CoreWebView2PrintMediaSize
                from System import Action, Boolean
                from System.Threading.Tasks import Task
                def export():
                    try:
                        core = window.native.webview.CoreWebView2
                        settings = core.Environment.CreatePrintSettings()
                        settings.ShouldPrintBackgrounds = True
                        settings.ShouldPrintHeaderAndFooter = False
                        settings.MediaSize = CoreWebView2PrintMediaSize.Custom
                        settings.PageWidth, settings.PageHeight = 210 / 25.4, 297 / 25.4
                        settings.MarginTop = settings.MarginBottom = 0.6299
                        settings.MarginLeft = settings.MarginRight = 0.6299
                        def finished(task):
                            try:
                                if not task.GetAwaiter().GetResult():
                                    raise ValueError('PDF 生成未完成，请重试。')
                            except Exception as error:
                                failures.append(error)
                            finally:
                                done.set()
                        core.PrintToPdfAsync(str(target), settings).ContinueWith(Action[Task[Boolean]](finished))
                    except Exception as error:
                        failures.append(error)
                        done.set()
                on_ui_thread(window.native, export)
            if not done.wait(60):
                abandoned.set()
                raise ValueError('PDF 生成超时，请重试。')
            if failures:
                raise ValueError('PDF 生成未完成，请重试。') from failures[0]
            if slices:
                _assemble_pdf(slices, target)
            if not target.is_file() or not target.read_bytes().startswith(b'%PDF-'):
                raise ValueError('PDF 文件未生成，请重试。')
            target.chmod(0o600)
        finally:
            if window is not None:
                window.destroy()
            source.unlink(missing_ok=True)


def _assemble_pdf(slices, target):
    """Fit vector WebKit regions onto A4 pages with consistent physical margins."""
    import io
    from pypdf import PdfReader, PdfWriter, Transformation, PageObject
    writer = PdfWriter()
    for data in slices:
        source = PdfReader(io.BytesIO(data)).pages[0]
        scale = (595.28 - 90.7) / float(source.mediabox.width)
        page = PageObject.create_blank_page(width=595.28, height=841.89)
        page.merge_transformed_page(source, Transformation().scale(scale).translate(
            tx=45.35, ty=841.89-45.35-float(source.mediabox.height)*scale))
        writer.add_page(page)
    with target.open('wb') as output:
        writer.write(output)


class MailOutputStore:
    """Short-lived capabilities bind all later actions to the captured account."""
    def __init__(self, runtime):
        self.runtime = runtime
        self.storage = tempfile.TemporaryDirectory(prefix='mailai-output-')
        self.outputs = {}
        self.lock = threading.RLock()

    def prepare(self, email_id, account_id, language='zh-CN', source='email'):
        from .account_context import snapshot, use
        from .mail_output import snapshot as output_snapshot, original
        if not account_id:
            raise ValueError('请先选择邮箱账号。')
        with use(snapshot(str(account_id))):
            data = output_snapshot(int(email_id), language, source)
            try:
                raw = original(int(email_id), source)[0] if data['has_raw'] else None
                identity = self._identity(raw) if raw else None
            except OSError:
                raw, identity = None, None
                data['has_raw'] = False
        token = secrets.token_urlsafe(24)
        with self.lock:
            self._expire()
            if len(self.outputs) >= 8:
                raise ValueError('已打开多个邮件输出窗口，请关闭后重试。')
            self.outputs[token] = dict(data=data, created=time.monotonic(), raw=raw, identity=identity, pdf=None)
        return {**data, 'token':token, 'native_pdf':True, 'native_share':sys.platform == 'darwin'}

    def _expire(self):
        for token, item in list(self.outputs.items()):
            if time.monotonic() - item['created'] > 1800:
                self.release(token)

    @staticmethod
    def _identity(path):
        stat = path.stat()
        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns

    def get(self, token):
        self._expire()
        if token not in self.outputs:
            raise ValueError('邮件输出已过期，请重新打开。')
        return self.outputs[token]

    def pdf(self, token):
        # Bridge calls run on workers. Serialize preparation/save/share for a
        # capability so closing the dialog cannot delete an in-flight file.
        with self.lock:
            item = self.get(token)
            if item['pdf'] is None:
                target = Path(self.storage.name) / (token + '.pdf')
                render_pdf(item['data']['document'], target)
                item['pdf'] = target
            return item['pdf']

    def file(self, token, kind):
        if kind == 'pdf':
            return self.pdf(token), self.get(token)['data']['filename'] + '.pdf'
        if kind != 'eml':
            raise ValueError('不支持的导出格式。')
        item = self.get(token)
        path, identity = item['raw'], item['identity']
        if path is None or not path.is_file() or self._identity(path) != identity:
            raise ValueError('原始邮件不可用或已变化，请重新打开邮件。')
        return path, item['data']['filename'] + '.eml'

    def save(self, token, kind):
        import os
        import shutil
        from webview import FileDialog
        with self.lock:
            source, name = self.file(token, kind)
            selected = self.runtime.window.create_file_dialog(FileDialog.SAVE, save_filename=name)
            if not selected:
                return {'ok':False, 'canceled':True}
            target = Path(selected[0] if isinstance(selected, (tuple,list)) else selected)
            # A distinct sibling prevents collisions and leaves existing files
            # intact if copying fails. The native dialog handles overwrite UI.
            fd, pending = tempfile.mkstemp(prefix='.mailai-', dir=target.parent)
            try:
                with os.fdopen(fd, 'wb') as output, source.open('rb') as incoming:
                    shutil.copyfileobj(incoming, output)
                os.replace(pending, target)
            finally:
                Path(pending).unlink(missing_ok=True)
            return {'ok':True, 'filename':target.name}

    def share(self, token, kind):
        if sys.platform != 'darwin':
            return {'ok':False, 'unsupported':True}
        from PyObjCTools import AppHelper
        from Foundation import NSURL
        from AppKit import NSSharingServicePicker
        with self.lock:
            source, name = self.file(token, kind)
            # A named private copy lets recipients see the subject, not a token.
            directory = Path(self.storage.name) / token
            directory.mkdir(mode=0o700, exist_ok=True)
            shared = directory / name
            import shutil
            shutil.copyfile(source, shared)
            shared.chmod(0o600)
            def present():
                view = self.runtime.window.native.contentView()
                picker = NSSharingServicePicker.alloc().initWithItems_([NSURL.fileURLWithPath_(str(shared))])
                # Retain the picker until another share or process exit. Files
                # are retained independently until exit for deferred consumers.
                self._picker = picker
                picker.showRelativeToRect_ofView_preferredEdge_(((0,0),(1,1)), view, 1)
            AppHelper.callAfter(present)
        return {'ok':True}

    def print_document(self, token):
        if sys.platform == 'darwin':
            from PyObjCTools import AppHelper
            from Foundation import NSData
            from Quartz import PDFDocument, kPDFPrintPageScaleDownToFit
            from AppKit import NSPrintInfo
            with self.lock:
                data = self.pdf(token).read_bytes()
            def present():
                document = PDFDocument.alloc().initWithData_(NSData.dataWithBytes_length_(data,len(data)))
                operation = document.printOperationForPrintInfo_scalingMode_autoRotate_(
                    NSPrintInfo.sharedPrintInfo().copy(), kPDFPrintPageScaleDownToFit, True)
                self._printing = document, operation
                operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo_(
                    self.runtime.window.native, None, None, None)
            AppHelper.callAfter(present)
            return {'ok':True}
        import webview
        with self.lock:
            item = self.get(token)
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', suffix='.html',
                                             dir=self.storage.name, delete=False) as output:
                source = Path(output.name)
                output.write(item['data']['document'])
            window = None
            try:
                window = webview.create_window(item['data']['filename'], url=source.as_uri(),
                                               width=850, height=1000, js_api=None)
                def closed():
                    source.unlink(missing_ok=True)
                window.events.closed += closed
                if not window.events.loaded.wait(30):
                    raise ValueError('邮件排版加载超时，请重试。')
                window.evaluate_js('window.print()')
            except Exception:
                if window is not None:
                    window.destroy()
                source.unlink(missing_ok=True)
                raise
        return {'ok':True}

    def release(self, token):
        with self.lock:
            item = self.outputs.pop(token, None)
            if item and item['pdf']:
                item['pdf'].unlink(missing_ok=True)
