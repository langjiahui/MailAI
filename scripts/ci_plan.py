"""Select development checks; release evidence always requires the complete plan."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CHECKS = ('native-notifications-windows', 'native-scrollbar-macos', 'release-gate',
          'browser-test', 'mail-import-windows', 'secret-scan')

# Small, explicit impact rules. Unknown production/test/build files use full checks.
AREAS = {
    'todo': (['app/web/static/todo-', 'app/web/static/task-planner.',
              'app/web/routes/todos.py', 'app/db/todos.py', 'app/todo_grouping.py',
              'app/task_planner.py', 'app/task_notifications.py'],
             ['todos', 'task-workspace', 'dates-motion', 'interaction', 'responsive-dialogs']),
    'search': (['app/web/static/assistant-search.', 'app/web/static/mail-filter-panel.',
                'app/web/static/mail-list-view.', 'app/search_query.py', 'app/mail_search.py'],
               ['search', 'assistant-search', 'mail-appearance', 'interaction', 'responsive-dialogs']),
    'compose': (['app/web/static/compose-', 'app/web/static/attachment-',
                 'app/web/routes/compose.py'],
                ['compose-library', 'interaction', 'responsive-dialogs']),
    'settings': (['app/web/static/settings-', 'app/web/static/home-dialog-polish.css',
                  'app/web/static/control-theme.css', 'app/web/static/correspondence-polish.css'],
                 ['mail-updates', 'mail-appearance', 'growth-themes', 'responsive-settings',
                  'responsive-dialogs', 'interaction']),
    'companion': (['app/web/static/companion-', 'app/web/static/companion.'],
                  ['growth-journal', 'growth-outfits', 'growth-themes', 'growth-gifts',
                   'xiaoyou-anatomy', 'xiaoyou-wardrobe', 'xiaoyou-life', 'xiaoyou-rest',
                   'interaction', 'responsive-dialogs']),
    'cleanup': (['app/automatic_server_cleanup.py', 'app/server_cleanup.py',
                 'app/web/static/server-cleanup.', 'app/web/static/maintenance-layout.css'],
                ['server-cleanup', 'responsive-settings', 'responsive-dialogs']),
}


def full_matrix(root=ROOT):
    jobs = json.loads((root / '.github/ci/browser-jobs.json').read_text())
    result = []
    for matrix in jobs.values():
        result.extend({'suite': suite, 'browser': '', 'shard': ''}
                      for suite in matrix.get('suite', []))
        result.extend({'suite': row['suite'], 'browser': row.get('browser', ''),
                       'shard': row.get('shard', '')} for row in matrix.get('include', []))
    for suite in ['interaction', 'assistant-workspace']:
        result.extend({'suite': suite, 'browser': browser, 'shard': ''}
                      for browser in ['chromium', 'webkit'])
    identities = [(r['suite'], r['browser'], r['shard']) for r in result]
    if len(set(identities)) != len(identities):
        raise ValueError('Duplicate browser matrix entry')
    suites = json.loads((root / '.github/ci/browser-suites.json').read_text())
    if {r['suite'] for r in result} != set(suites):
        raise ValueError('The full matrix does not schedule every browser suite')
    return result


def browser_image(root=ROOT):
    config = json.loads((root / '.github/ci/browser-image.json').read_text())
    lock = json.loads((root / 'package-lock.json').read_text())
    version = lock['packages']['node_modules/playwright']['version']
    if config['playwright'] != version or not re.fullmatch(
            r'mcr\.microsoft\.com/playwright@sha256:[a-f0-9]{64}', config['image']):
        raise ValueError('Pinned browser image must match package-lock.json')
    return config


def changed_files(base, root=ROOT):
    if not re.fullmatch(r'[a-f0-9]{40}', base):
        raise ValueError('The comparison base must be an immutable commit SHA')
    raw = subprocess.check_output(['git', 'diff', '--name-only', '--no-renames', '-z',
                                   base, 'HEAD', '--'], cwd=root)
    return [p.decode('utf-8') for p in raw.split(b'\0') if p]


def select(paths, *, force_full=False, root=ROOT):
    matrix = full_matrix(root)
    checks = {name: name in {'release-gate', 'secret-scan'} for name in CHECKS}
    selected, reasons = set(), []
    full = force_full
    suites = json.loads((root / '.github/ci/browser-suites.json').read_text())
    by_test = {}
    for suite, phases in suites.items():
        for phase in phases:
            for test in phase['tests']:
                by_test.setdefault(test['file'], set()).add(suite)
    paths = sorted(set(paths))
    for path in paths:
        if path.startswith('/') or '..' in Path(path).parts or '\n' in path:
            raise ValueError('Invalid changed path')
        if path == 'VERSION':
            full = True; reasons.append('Release version changed'); continue
        if path.startswith(('app/security/', 'app/credential', 'app/macos_credential', 'app/macos_keychain')):
            full = True; reasons.append('Security or credential boundary changed'); continue
        if path.startswith(('.github/', 'scripts/', 'frontend/')) or path in {
                'package.json', 'package-lock.json'} or path.startswith('requirements'):
            full = True; reasons.append('Build, dependency or CI configuration changed'); continue
        if path.startswith('mobile/'):
            reasons.append('Mobile code is checked by its own platform workflow'); continue
        if path.endswith('.md') or path in {'LICENSE', 'NOTICE', '.gitignore'}:
            continue
        if path in {'app/web/static/bundle.js', 'app/web/static/index.html'}:
            # Generated shell changes are only attributable when a source changed too.
            if not any(p.startswith('app/web/static/') and p not in {
                    'app/web/static/bundle.js', 'app/web/static/index.html'} for p in paths):
                full = True; reasons.append('Unattributed generated frontend change')
            continue
        if path in by_test:
            selected.update(by_test[path]); continue
        matches = [name for name, (prefixes, _) in AREAS.items()
                   if any(path == prefix or (prefix.endswith(('/', '-', '.')) and path.startswith(prefix))
                          for prefix in prefixes)]
        if matches:
            for name in matches:
                selected.update(AREAS[name][1]); reasons.append('Affected area: ' + name)
            continue
        if path.startswith(('app/macos_', 'native/macos/')):
            checks['native-scrollbar-macos'] = True
            selected.update(['startup', 'workspace']); continue
        if path.startswith(('app/windows_', 'native/windows/')):
            checks['native-notifications-windows'] = True
            selected.add('startup'); continue
        full = True; reasons.append('Unmapped change: ' + path)
    if full:
        checks = {name: True for name in CHECKS}
        chosen = matrix
    else:
        chosen = [row for row in matrix if row['suite'] in selected]
        checks['browser-test'] = bool(chosen)
    fingerprint = hashlib.sha256(json.dumps(matrix, sort_keys=True).encode()).hexdigest()
    return {'mode': 'full' if full else 'quick', 'checks': checks,
            'matrix': chosen, 'coverage': fingerprint,
            'reasons': sorted(set(reasons)), 'paths': paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, help='Immutable comparison commit SHA')
    parser.add_argument('--full', action='store_true')
    args = parser.parse_args()
    print(json.dumps(select(changed_files(args.base), force_full=args.full), indent=2))


if __name__ == '__main__':
    main()
