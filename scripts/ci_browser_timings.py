"""Refresh scheduling estimates from a successful complete GitHub quality run."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import re

if __package__:
    from . import ci_plan, ci_quality
else:
    import ci_plan, ci_quality


def collect(api, run_id, root=ci_plan.ROOT):
    run = api.get(f'actions/runs/{run_id}')
    if (run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or run.get('path') != ci_quality.WORKFLOW
            or run.get('repository', {}).get('full_name') != api.repository
            or run.get('head_repository', {}).get('full_name') != api.repository
            or run.get('event') not in {'pull_request', 'push', 'workflow_dispatch'}):
        raise ValueError('Timings require a successful same-repository quality run')
    jobs = []
    for page in range(1, 11):
        batch = api.get(f'actions/runs/{run_id}/jobs?per_page=100&page={page}')['jobs']
        jobs.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise ValueError('Too many jobs in timing source')
    observed = {}
    for job in jobs:
        match = re.fullmatch(r'browser-test \(([^,]+), ([^,]*), ([^)]*)\)', job['name'])
        if not match:
            continue
        key = tuple(value.strip() for value in match.groups())
        if key in observed or job.get('conclusion') != 'success':
            raise ValueError('Duplicate or unsuccessful browser timing source')
        seconds = int((datetime.fromisoformat(job['completed_at'].replace('Z', '+00:00'))
                       - datetime.fromisoformat(job['started_at'].replace('Z', '+00:00'))).total_seconds())
        if not 0 < seconds <= 7200:
            raise ValueError('Invalid browser duration')
        observed[key] = seconds
    expected = {ci_plan.matrix_key(row) for row in ci_plan.full_matrix(root)}
    if set(observed) != expected:
        raise ValueError('Timing source must contain the complete browser matrix')
    return {'schema': 1, 'source': {'repository': api.repository, 'run_id': run_id,
            'run_attempt': run['run_attempt'], 'head_sha': run['head_sha']},
            'jobs': [dict(suite=key[0], browser=key[1], shard=key[2], seconds=seconds)
                     for key, seconds in sorted(observed.items())]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--run', required=True, type=int)
    parser.add_argument('--output', type=Path,
                        default=ci_plan.ROOT / '.github/ci/browser-timings.json')
    args = parser.parse_args()
    if args.run <= 0:
        parser.error('--run must be positive')
    data = collect(ci_quality.GitHub(args.repository), args.run)
    args.output.write_text(json.dumps(data, indent=2) + '\n')
    print(f'Recorded {len(data["jobs"])} browser groups from run {args.run}')


if __name__ == '__main__':
    main()
