"""Native policy: only explicit safe link navigation leaves the application."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.mail_navigation import navigation_action


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
    print('Native mail navigation: external links, blocked schemes, passive redirects and account shell passed')


if __name__ == '__main__':
    main()
