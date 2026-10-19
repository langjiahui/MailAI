"""Automatic routing uses official source health and a bounded CDN sample."""
import copy
from contextlib import contextmanager
import io
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import update_routing as routing, update_mirror as mirror, update_resume as resume


def manifest(version='2.10.0'):
    return {'version':version,'release_url':mirror.GITHUB_RELEASES+'/tag/v'+version,
            'assets':{device:{'url':mirror.GITHUB_RELEASES+'/download/v'+version+'/'+name,'size':100000,'sha256':'a'*64}
                      for device,name in mirror.NAMES.items()}}


class Response(io.BytesIO):
    def __init__(self,size=100000,status=206,content_range='bytes 0-65535/100000',length=65536):
        super().__init__(b'x'*length)
        self.status=status
        self.headers={'Content-Length':str(size if status==200 else length),'Content-Range':content_range}


class RoutingTest(unittest.TestCase):
    def setUp(self):
        # Separate cache keys and wait for the few deliberately blocked workers in cleanup.
        with routing._lock:routing._recent.clear()
        self.patches=[patch.object(routing,'DISCOVERY_TIMEOUT',.18),patch.object(routing,'PROBE_TIMEOUT',.12),patch.object(routing,'SETTLE_SECONDS',.02)]
        for value in self.patches:value.start();self.addCleanup(value.stop)

    def tearDown(self):
        with routing._lock:pending=list(routing._pending.values())
        for attempt in pending:attempt.done.wait(1)

    def test_faster_domestic_or_github_source_is_selected(self):
        for fast in ('atomgit','github'):
            with routing._lock:routing._recent.clear()
            def domestic():
                if fast!='atomgit':threading.Event().wait(.04)
                return manifest()
            def github():
                if fast!='github':threading.Event().wait(.04)
                return manifest()
            with patch.object(mirror,'discover',side_effect=domestic):
                result=routing.discover(github,'2.9.6')
                self.assertEqual(result['assets']['macos-arm64']['preferred_source'],fast)
                self.assertEqual(result['release_url'],mirror.ATOM_RELEASES if fast=='atomgit' else manifest()['release_url'])
            threading.Event().wait(.05)

    def test_newer_verified_release_wins_over_faster_stale_source(self):
        with patch.object(mirror,'discover',return_value=manifest('2.9.5')):
            result=routing.discover(lambda:manifest(),'2.9.6')
        self.assertEqual(result['version'],'2.10.0')
        self.assertEqual(result['assets']['macos-arm64']['preferred_source'],'github')

    def test_blocked_source_does_not_delay_working_source_or_application_exit(self):
        release=threading.Event();finished=threading.Event()
        def blocked():
            release.wait(2);finished.set();raise OSError('offline')
        try:
            with patch.object(mirror,'discover',return_value=manifest()):
                start=time.monotonic();result=routing.discover(blocked,'2.9.6')
            self.assertLess(time.monotonic()-start,.15)
            self.assertEqual(result['version'],'2.10.0')
        finally:release.set();finished.wait(1)
        self.assertTrue(all(thread.daemon for thread in threading.enumerate() if thread.name=='mailai-update-source'))

    def test_invalid_fast_source_never_becomes_download_identity(self):
        invalid=manifest();invalid['assets']['macos-arm64']['sha256']='bad'
        with patch.object(mirror,'discover',return_value=invalid):
            result=routing.discover(lambda:manifest(),'2.9.6')
        self.assertEqual(result['assets']['macos-arm64']['sha256'],'a'*64)
        self.assertEqual(result['assets']['macos-arm64']['preferred_source'],'github')

    def test_unavailable_sources_fail_and_late_newer_result_is_retained(self):
        def offline():raise OSError('offline')
        with patch.object(mirror,'discover',side_effect=offline):
            with self.assertRaises(OSError):routing.discover(offline,'2.9.6')
        release=threading.Event();finished=threading.Event()
        def late():
            release.wait(1);finished.set();return manifest('2.11.0')
        with patch.object(mirror,'discover',return_value=manifest()):
            routing.discover(late,'2.9.6')
            with routing._lock:pending=routing._pending.get('manifest:github')
            release.set();finished.wait(1)
            if pending:pending.done.wait(1)
            result=routing.discover(offline,'2.9.6')
        self.assertEqual(result['version'],'2.11.0')

    def test_cdn_sample_chooses_actual_download_speed_not_metadata_source(self):
        release=threading.Event()
        @contextmanager
        def open_mock(url,**kwargs):
            self.assertEqual(kwargs['headers']['Range'],'bytes=0-65535')
            self.assertNotIn('Authorization',kwargs['headers'])
            if url.startswith(mirror.ATOM_API):release.wait(.08)
            yield Response()
        item={**manifest()['assets']['macos-arm64'],'mirror_url':mirror.attachment('v2.10.0',mirror.NAMES['macos-arm64']),'preferred_source':'atomgit'}
        try:
            with patch.object(routing,'open_public',side_effect=open_mock):
                self.assertEqual(routing.download_source(item),'github')
        finally:release.set();threading.Event().wait(.02)

    def test_probe_rejects_incomplete_or_wrong_range_and_accepts_safe_200(self):
        for response in (Response(content_range='bytes 1-65536/100000'),Response(length=12)):
            @contextmanager
            def open_mock(*args,**kwargs):yield response
            with patch.object(routing,'open_public',side_effect=open_mock):
                with self.assertRaises((OSError,ValueError)):routing._probe('https://example.test/a',100000)
        @contextmanager
        def ignored_range(*args,**kwargs):yield Response(status=200)
        with patch.object(routing,'open_public',side_effect=ignored_range):self.assertTrue(routing._probe('https://example.test/a',100000))

    def test_probe_failure_preserves_metadata_preference(self):
        @contextmanager
        def offline(*args,**kwargs):raise OSError('offline');yield
        item={**manifest()['assets']['macos-arm64'],'mirror_url':mirror.attachment('v2.10.0',mirror.NAMES['macos-arm64']),'preferred_source':'github'}
        with patch.object(routing,'open_public',side_effect=offline):self.assertEqual(routing.download_source(item),'github')

    def test_new_manifest_cannot_set_foreign_mirror_or_release(self):
        for change in ({'release_url':'https://other.example.test'}, {'version':'2.10.0-beta.1'}):
            with self.assertRaises(ValueError):routing._normalize({**manifest(),**change},'atomgit')
        value=manifest();value['assets']['macos-arm64']['url']='https://other.example.test/a.pkg'
        with self.assertRaises(ValueError):routing._normalize(value,'atomgit')


if __name__=='__main__':unittest.main()
