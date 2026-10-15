"""Native attachment opening uses account-scoped bytes and safe OS associations."""
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import desktop_attachments as files
from app.account_context import current
from app.desktop import DesktopApi, DesktopRuntime


def main():
    att = {'name': '季度报告.docx', 'payload': b'original document', 'content_type': 'application/octet-stream'}
    paths = []

    def launched(command, **kwargs):
        target = Path(command[-1])
        assert target.read_bytes() == att['payload']
        assert target.name == att['name']
        assert target.stat().st_mode & 0o777 == 0o600
        assert kwargs['check'] and kwargs['timeout'] == 15
        paths.append(target)

    try:
        with patch.object(files.sys, 'platform', 'darwin'), patch.object(files.subprocess, 'run', side_effect=launched) as run:
            assert files.open_attachment_copy(att)['ok']
            assert run.call_args.args[0][0] == '/usr/bin/open'
            assert files.open_attachment_copy(att)['ok']
            assert paths[0] != paths[1] and paths[0].exists(), 'Copies must not overwrite files open in another app'
        with patch.object(files.sys, 'platform', 'linux'), patch.object(files.subprocess, 'run', side_effect=launched) as run:
            assert files.open_attachment_copy(att)['ok']
            assert run.call_args.args[0][0] == 'xdg-open'
        with patch.object(files.sys, 'platform', 'win32'), patch.object(files.os, 'startfile', create=True) as start:
            assert files.open_attachment_copy(att)['ok']
            assert Path(start.call_args.args[0]).read_bytes() == att['payload']
        with patch.object(files.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'open')):
            try:
                files.open_attachment_copy(att)
                raise AssertionError('Missing application must be reported')
            except ValueError as error:
                assert '支持此格式的应用' in str(error)
        for name, payload in [('run.exe', b'MZ'), ('run.command', b'echo bad'), ('fake.pdf', b'MZhidden'), ('macro.docm', b'office'), ('unknown', b'data')]:
            with patch.object(files.subprocess, 'run') as run:
                try:
                    files.open_attachment_copy({'name': name, 'payload': payload})
                    raise AssertionError(name)
                except ValueError:
                    run.assert_not_called()
        with patch.object(files.subprocess, 'run') as run:
            assert files.open_attachment_copy({'name': '../../报告.txt', 'payload': b'text'})['ok']
            target = Path(run.call_args.args[0][-1])
            assert target.resolve().is_relative_to(Path(files._storage.name).resolve())
            assert len(target.relative_to(files._storage.name).parts) == 2

        account = {'ACCOUNT_ID': 'original-account'}
        with patch('app.account_context.snapshot', return_value=account) as snapshot, patch('app.db.get_sent_attachment') as sent:
            def read(record_id, index, draft=False):
                assert current.get() == account
                assert (record_id, index) == (7, 2)
                return att
            sent.side_effect = read
            for source in ('sent', 'draft'):
                assert files.load_attachment(7, 2, 'original-account', source) == att
                assert sent.call_args.kwargs['draft'] == (source == 'draft')
            snapshot.assert_called_with('original-account')
            assert current.get() is None
        with patch('app.db.get_email', return_value={'raw_path': 'original.eml'}), patch('app.parser.extract_attachment', return_value=att) as extract:
            assert files.load_attachment(7, 2) == att
            extract.assert_called_once_with('original.eml', 2)
        with patch.object(files, 'load_attachment', return_value=att) as load, patch.object(files, 'open_attachment_copy', return_value={'ok': True}) as opener:
            assert DesktopApi(DesktopRuntime()).open_attachment(7, 2, 'account', 'draft')['ok']
            load.assert_called_once_with(7, 2, 'account', 'draft')
            opener.assert_called_once_with(att)
        for record, index, source in [(0, 0, 'email'), (1, -1, 'email'), (1, 0, 'unknown')]:
            try:
                files.load_attachment(record, index, source=source)
                raise AssertionError('Invalid reference was accepted')
            except ValueError:
                pass
        print('PASS native macOS/Windows/Linux opening, independent private copies, failure reporting, file validation and account-scoped sources')
    finally:
        if files._storage:
            files._storage.cleanup()
            files._storage = None


if __name__ == '__main__':
    main()
