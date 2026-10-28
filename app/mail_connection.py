"""Classify persisted IMAP failures without treating all errors as bad passwords."""
import ssl


def identify(client):
    """RFC 2971 identity, after authentication; required by NetEase for SELECT.

    https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2eda07326646e6eb0
    """
    capability = getattr(client, 'has_capability', None)
    if not callable(capability) or not capability('ID'):
        return
    identity = {'name': 'MailAI', 'vendor': 'MailAI'}
    from .paths import APP_DIR
    try:
        identity['version'] = (APP_DIR / 'VERSION').read_text().strip()
    except OSError:
        pass
    client.id_(identity)


def issue_kind(error):
    text = str(error or '').casefold()
    if isinstance(error, ssl.SSLCertVerificationError) or any(word in text for word in
            ('certificate_verify_failed', 'certificate verify failed', '证书验证')):
        return 'certificate'
    if type(error).__name__ == 'LoginError' or any(word in text for word in ('authenticationfailed', 'authentication failed',
            'invalid credentials', 'login failed', 'loginerror', 'invalid password',
            'authorization failed', 'authenticate failed', '重新授权', '授权已失效',
            '登录已失效', '登录失败', '认证失败', '密码错误', '授权码错误')):
        return 'credentials'
    if isinstance(error, (OSError, TimeoutError, EOFError)) or any(word in text for word in
            ('timed out', 'timeout', 'connection', 'network', 'eof', 'socket',
             '连接中断', '连接失败', '无法连接', '网络', '超时', '远程主机')):
        return 'connection'
    return 'unknown'
