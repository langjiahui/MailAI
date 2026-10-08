"""Offline PKCE, loopback state checks, secret storage, refresh and auth integration."""

import sys, tempfile, threading, time, json
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, urlencode
from urllib.request import urlopen
from urllib.error import HTTPError
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import oauth_mail as oauth, system_settings


def main():
    with tempfile.TemporaryDirectory() as root:
        vault = {}
        exchange = []

        def fake_exchange(provider, fields):
            exchange.append((provider, dict(fields)))
            return {
                "access_token": "test-access",
                "refresh_token": "test-refresh",
                "expires_in": 3600,
            }

        def save(key, value):
            vault[key] = value
            return True

        with (
            patch.object(oauth, "USER_DIR", Path(root)),
            patch.object(oauth.credential_store, "save", side_effect=save),
            patch.object(
                oauth.credential_store,
                "load",
                side_effect=lambda key: vault.get(key, ""),
            ),
            patch.object(
                oauth.credential_store,
                "delete",
                side_effect=lambda key: vault.pop(key, None),
            ),
            patch.object(oauth, "_exchange", side_effect=fake_exchange),
        ):
            oauth._tokens.clear()
            oauth._flows.clear()
            oauth.save_client("google", "client-id", "test-secret")
            assert "test-secret" not in (Path(root) / "oauth-clients.json").read_text()
            flow = oauth.begin("google", "me@example.test")
            fields = parse_qs(urlsplit(flow["url"]).query)
            assert (
                fields["code_challenge_method"] == ["S256"]
                and "code_verifier" not in fields
            )
            assert fields["redirect_uri"] == [flow["redirect_uri"]] and fields[
                "access_type"
            ] == ["offline"]
            try:
                urlopen(flow["redirect_uri"] + "?state=wrong&code=untrusted")
                assert False
            except HTTPError as exc:
                assert exc.code == 400
            assert oauth.status(flow["state"])["status"] == "waiting"
            urlopen(
                flow["redirect_uri"]
                + "?"
                + urlencode({"state": flow["state"], "code": "synthetic-code"})
            ).read()
            assert oauth.status(flow["state"]) == {"status": "ready", "message": ""}
            assert (
                exchange[0][1]["code_verifier"]
                and exchange[0][1]["client_secret"] == "test-secret"
            )
            assert "access_token" not in json.dumps(oauth.status(flow["state"]))
            fake_result = {"ok": True, "account_id": "oauth-account"}
            with (
                patch.object(
                    system_settings, "test_mail_connection", return_value={"ok": True}
                ),
                patch.object(system_settings, "login_mail", return_value=fake_result),
                patch.object(system_settings, "public_config", return_value={}),
                patch.object(
                    system_settings, "_account_key", return_value="oauth-account"
                ),
            ):
                assert oauth.complete(flow["state"])["ok"]
                assert oauth.status(flow["state"])["status"] == "complete"
                try:
                    oauth.complete(flow["state"])
                    assert False
                except ValueError:
                    pass
            assert oauth.access_token("oauth-account") == "test-access"
            oauth._tokens["oauth-account"]["expires_at"] = 0
            outputs = []
            threads = [
                threading.Thread(
                    target=lambda: outputs.append(oauth.access_token("oauth-account"))
                )
                for _ in range(8)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            assert (
                outputs == ["test-access"] * 8
                and sum(f["grant_type"] == "refresh_token" for _, f in exchange) == 1
            )
            client = MagicMock()
            oauth.imap_login(
                client, "me@example.test", "unused", values={"oauth_token": "token"}
            )
            client.oauth2_login.assert_called_once_with("me@example.test", "token")
            assert not client.login.called
            smtp = MagicMock()
            oauth.smtp_login(
                smtp, "me@example.test", "unused", values={"oauth_token": "token"}
            )
            args = smtp.auth.call_args[0]
            assert (
                args[0] == "XOAUTH2"
                and args[1]() == "user=me@example.test\x01auth=Bearer token\x01\x01"
            )
            assert args[1](b"challenge") == ""
            oauth.forget("oauth-account")
            assert not oauth.available("oauth-account")
            flow = oauth.begin("google", "me@example.test")
            oauth.cancel(flow["state"])
            assert oauth.status(flow["state"])["status"] == "canceled"
            flow = oauth.begin("google", "me@example.test")
            oauth._flows[flow["state"]]["created"] = time.time() - 601
            assert oauth.status(flow["state"])["status"] == "expired"
            try:
                oauth.save_client("google", "bad id")
                assert False
            except ValueError:
                pass
            # Failure to save rotated tokens must not overwrite the in-memory credential.
            oauth._tokens["x"] = {
                "provider": "google",
                "refresh_token": "old",
                "access_token": "old",
                "expires_at": 0,
            }
            with patch.object(oauth.credential_store, "save", return_value=False):
                try:
                    oauth.access_token("x")
                    assert False
                except ValueError:
                    pass
                assert oauth._tokens["x"]["refresh_token"] == "old"
    print(
        "PASS OAuth: PKCE, state, expiration, cancellation, vault storage, serialized refresh and XOAUTH2"
    )


if __name__ == "__main__":
    main()
