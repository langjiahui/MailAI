"""Run one browser group with isolated fixtures and bounded process cleanup."""
import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SUITES = ROOT / '.github/ci/browser-suites.json'
ALIASES = ROOT / '.github/ci/browser-aliases.json'


def stop(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if process.poll() is None:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    # The leader may exit on TERM while a browser or fixture child survives.
    # Always clear the group, even when the leader has already been reaped.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def start_fixture(spec, env, stack, log_dir, phase):
    port = spec['port']
    path = log_dir / f'fixture-{phase}-{port}.log'
    stream = stack.enter_context(path.open('w'))
    process = subprocess.Popen([sys.executable, 'tests/workspace_preview.py'], cwd=ROOT,
        env={**env, **spec['env'], 'MAILAI_FIXTURE_PORT': str(port)},
        stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
    stack.callback(stop, process)
    for _ in range(300):
        if process.poll() is not None:
            raise RuntimeError(f'Fixture exited: {path.read_text()}')
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(.1)
    raise TimeoutError(f'Fixture failed to start: {path.read_text()}')


def run(suite, browser='', shard=''):
    suites = json.loads(SUITES.read_text())
    aliases = json.loads(ALIASES.read_text())
    phases = [phase for name in aliases.get(suite, [suite]) for phase in suites[name]]
    env = {**os.environ, 'MAILAI_FIXTURE_PYTHON': sys.executable}
    if browser:
        env['MAILAI_BROWSER'] = browser
    if shard:
        env['MAILAI_CI_SHARD'] = shard
    log_dir = ROOT / 'build/ci' / (suite + ('-' + browser if browser else '') + ('-' + shard.replace('/', '-') if shard else ''))
    log_dir.mkdir(parents=True, exist_ok=True)
    # Several tests emit screenshots directly into these existing locations.
    (ROOT / 'output/xiaoyou-evolution').mkdir(parents=True, exist_ok=True)
    times = []
    try:
        for index, phase in enumerate(phases):
            with ExitStack() as stack:
                for fixture in phase['fixtures']:
                    start_fixture(fixture, env, stack, log_dir, index)
                for spec in phase['tests']:
                    path = ROOT / spec['file']
                    if path.parent != ROOT / 'tests' or path.suffix != '.cjs' or not path.is_file():
                        raise ValueError('Invalid browser test path')
                    command = ['node', str(path), *[sys.executable if arg == '{python}' else arg for arg in spec.get('args', [])]]
                    started = time.monotonic()
                    print('::group::' + spec['file'] + ' ' + json.dumps(spec.get('env', {})), flush=True)
                    process = subprocess.Popen(command, cwd=ROOT, env={**env, **spec.get('env', {})}, start_new_session=True)
                    try:
                        code = process.wait(timeout=600)
                        if code:
                            raise subprocess.CalledProcessError(code, command)
                    finally:
                        stop(process)
                        times.append({'file': spec['file'], 'env': spec.get('env', {}),
                                      'seconds': round(time.monotonic() - started, 2), 'exit': process.returncode})
                        print('::endgroup::', flush=True)
    finally:
        (log_dir / 'timings.json').write_text(json.dumps(times, indent=2) + '\n')
        if os.getenv('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
                stream.write(f'### {suite} {browser} {shard}\n\n| Test | Seconds | Exit |\n| --- | ---: | ---: |\n')
                for row in times:
                    stream.write(f'| {row["file"]} | {row["seconds"]} | {row["exit"]} |\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('suite', choices=[*json.loads(SUITES.read_text()), *json.loads(ALIASES.read_text())])
    parser.add_argument('--browser', choices=['', 'chromium', 'webkit'], default='')
    parser.add_argument('--shard', default='')
    args = parser.parse_args()
    def cancel(_signum, _frame):
        raise SystemExit(130)
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    run(args.suite, args.browser, args.shard)


if __name__ == '__main__':
    main()
