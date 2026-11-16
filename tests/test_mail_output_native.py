"""Exercise real desktop PDF rendering in an isolated GUI process when available."""
import importlib.util
from pathlib import Path
import os
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))


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
    child(sys.argv[2]) if len(sys.argv)>1 and sys.argv[1]=='--child' else main()
