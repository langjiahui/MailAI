"""Native navigation boundary for script-disabled HTML mail frames."""
from urllib.parse import urlsplit


def navigation_action(url, app_url, *, from_mail_frame, user_link):
    try:
        target, app = urlsplit(url), urlsplit(app_url)
        if target.scheme == 'about' and target.path in ('blank', 'srcdoc'):
            return 'allow'
        same_origin = (target.scheme, target.hostname, target.port) == (app.scheme, app.hostname, app.port)
        if not from_mail_frame and same_origin:
            return 'allow'
        safe = target.scheme in ('http', 'https') and bool(target.hostname) or target.scheme == 'mailto' and bool(target.path)
        if user_link and safe and not same_origin:
            return 'open'
    except ValueError:
        pass
    return 'cancel'


def navigation_delegate(base_delegate, app_url, opener):
    """Wrap pywebview's delegate while retaining downloads and shell navigation."""
    import objc

    class MailAINavigationDelegate(base_delegate):
        def webView_runOpenPanelWithParameters_initiatedByFrame_completionHandler_(self, webview, param, frame, handler):
            # pywebview 6.2 uses OPEN for every HTML file input. WKWebView's
            # webkitdirectory input needs a folder picker, then expands its URLs.
            if not getattr(param, 'allowsDirectories', lambda: False)():
                return objc.super(MailAINavigationDelegate, self).webView_runOpenPanelWithParameters_initiatedByFrame_completionHandler_(webview, param, frame, handler)
            from webview import FileDialog
            from webview.platforms import cocoa
            from Foundation import NSURL
            browser = next(iter(cocoa.BrowserView.instances.values()))
            files = browser.create_file_dialog(FileDialog.FOLDER, '', param.allowsMultipleSelection(), '', (), main_thread=True)
            handler([NSURL.fileURLWithPath_(path) for path in files] if files else None)

        def webView_decidePolicyForNavigationAction_decisionHandler_(self, webview, action, handler):
            source = action.sourceFrame()
            decision = navigation_action(
                str(action.request().URL().absoluteString()), app_url,
                from_mail_frame=bool(source and not source.isMainFrame()),
                user_link=action.navigationType() == 0,
            )
            if decision == 'allow':
                return objc.super(MailAINavigationDelegate, self).webView_decidePolicyForNavigationAction_decisionHandler_(webview, action, handler)
            # Cancel first, before opening the system browser. Never let the
            # destination replace the mail frame, even if the opener fails.
            handler(0)
            if decision == 'open':
                opener(str(action.request().URL().absoluteString()))

    return MailAINavigationDelegate
