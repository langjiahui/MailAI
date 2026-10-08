"""Native policy: only explicit safe link navigation leaves the application."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.mail_navigation import navigation_action, navigation_delegate
from types import SimpleNamespace
from unittest.mock import patch


def main():
    for target in ('https://example.test/pay?a=1&b=2', 'http://intranet.test/', 'mailto:person@example.test'):
        for child in (True, False):
            assert navigation_action(target, 'http://127.0.0.1:8787/', from_mail_frame=child, user_link=True) == 'open'
            assert navigation_action(target, 'http://127.0.0.1:8787/', from_mail_frame=child, user_link=False) == 'cancel'
    for target in ('file:///tmp/test', 'javascript:alert(1)', 'data:text/html,test', 'mailai-unsafe://test', 'https://', 'https://bad.test:bad'):
        assert navigation_action(target, 'http://127.0.0.1:8787/', from_mail_frame=True, user_link=True) == 'cancel'
    for child in (True, False):
        assert navigation_action('about:srcdoc', 'http://127.0.0.1:8787/', from_mail_frame=child, user_link=False) == 'allow'
        assert navigation_action('http://127.0.0.1:8787/', 'http://127.0.0.1:8787/', from_mail_frame=child, user_link=True) == ('cancel' if child else 'allow')
    # Native Mac HTML directory inputs must open a folder picker. Regular file
    # inputs retain pywebview's own filter handling; cancellation resolves once.
    calls, selections, results = [], ['/导出/旧邮件'], []
    def picker(*args, **kwargs):
        calls.append((args, kwargs)); return selections[:]
    class BaseDelegate:
        def webView_runOpenPanelWithParameters_initiatedByFrame_completionHandler_(self, view, params, frame, handler):
            calls.append('regular'); handler(['regular-file'])
    modules = {
        'objc': SimpleNamespace(super=super),
        'webview': SimpleNamespace(FileDialog=SimpleNamespace(FOLDER='folder')),
        'webview.platforms': SimpleNamespace(cocoa=SimpleNamespace(BrowserView=SimpleNamespace(instances={1:SimpleNamespace(create_file_dialog=picker)}))),
        'Foundation': SimpleNamespace(NSURL=SimpleNamespace(fileURLWithPath_=lambda path:'file:'+path)),
    }
    with patch.dict(sys.modules, modules):
        delegate = navigation_delegate(BaseDelegate, 'http://127.0.0.1:8787/', lambda url:None)()
        choose = delegate.webView_runOpenPanelWithParameters_initiatedByFrame_completionHandler_
        params = SimpleNamespace(allowsDirectories=lambda:True, allowsMultipleSelection=lambda:True)
        choose(None, params, None, results.append)
        assert calls[-1] == (('folder', '', True, '', ()), {'main_thread':True})
        assert results[-1] == ['file:/导出/旧邮件']
        selections.clear(); choose(None, params, None, results.append); assert results[-1] is None
        params.allowsDirectories=lambda:False
        choose(None, params, None, results.append); assert calls[-1]=='regular' and results[-1]==['regular-file']
    print('Native directory picker, cancellation and regular file delegation passed')
    print('Native mail navigation: external links, blocked schemes, passive redirects and account shell passed')


if __name__ == '__main__':
    main()
