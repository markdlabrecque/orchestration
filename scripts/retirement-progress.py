#!/usr/bin/env python3
"""Durable git identity/progress for the retirement engine, not a second retire path.

The engine calls prepare before adapters, ready after successful teardown, and
finish for git removal. A missing checkout is recoverable only from ready.
Records live in the repository's common git directory, outside the checkout.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile


class IdentityRefusal(RuntimeError):
    """Invalid initial target, rather than a failed teardown operation."""


def git(main, *args, absent=False):
    p = subprocess.run(['git', '-C', main, *args], capture_output=True, text=True,
                       timeout=30)
    if p.returncode and not (absent and p.returncode == 1):
        raise RuntimeError('git %s failed: %s' % (' '.join(args), p.stderr.strip()))
    return p.stdout.strip() if p.returncode == 0 else None


def entries(main):
    result = []
    for block in git(main, 'worktree', 'list', '--porcelain', '-z').split('\0\0'):
        row = {}
        for line in block.split('\0'):
            key, _, value = line.partition(' ')
            row[key] = value
        if 'worktree' in row:
            result.append(row)
    return result


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        fd = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def run(action, main, tid, expected, force=False):
    main = os.path.realpath(main)
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', tid):
        raise RuntimeError('invalid worktree id')
    common = git(main, 'rev-parse', '--git-common-dir')
    journal = os.path.join(os.path.realpath(os.path.join(main, common)),
                           'orch-retirement', tid + '.json')
    rows = entries(main)
    matches = [r for r in rows[1:] if os.path.basename(r['worktree']) == tid]
    if len(matches) > 1:
        raise RuntimeError('ambiguous worktree name %s; use unique directory names' % tid)
    try:
        with open(journal) as f:
            record = json.load(f)
    except FileNotFoundError:
        record = None
    if matches:
        row = matches[0]
        path = os.path.realpath(row['worktree'])
    elif record:
        path = record['path']
        row = None
    else:
        raise IdentityRefusal('no registered worktree or recovery identity for %s' % (expected or tid))
    if path == main or path == os.path.realpath(rows[0]['worktree']):
        raise RuntimeError('refusing to remove main checkout %s' % path)
    if expected and path != os.path.realpath(expected):
        raise RuntimeError('worktree identity mismatch: expected %s, registered %s' % (expected, path))
    if '\n' in path or '\r' in path:
        raise RuntimeError('newline in worktree path is unsupported')
    exists = os.path.lexists(path)
    if exists and (not row or os.path.islink(path)):
        raise IdentityRefusal('unregistered or symlink worktree %s; refusing' % path)
    if record and (record['main'] != main or record['path'] != path):
        raise RuntimeError('saved retirement identity differs for %s' % path)
    if action == 'prepare' and exists:
        branch = row.get('branch', '')
        head = git(path, 'rev-parse', 'HEAD')
        if record and record['stage'] != 'complete' and (record['branch'] != branch or record['head'] != head):
            raise RuntimeError('branch/HEAD changed during retirement of %s; inspect saved identity %s' % (path, journal))
        if record and record['stage'] == 'complete' and record.get('workspace'):
            raise RuntimeError('new checkout at %s while workspace %s still needs closure; recover it first' % (path, record['workspace']))
        if not record or record['stage'] == 'complete':
            record = dict(main=main, path=path, branch=branch, head=head, stage='prepared')
            save(journal, record)
    if not record or (not exists and record['stage'] not in ('ready', 'complete')):
        raise RuntimeError('checkout missing before confirmed adapter teardown: %s; recover adapters manually' % path)
    if action == 'prepare':
        print(path)
        print(record['branch'].removeprefix('refs/heads/'))
        print(record['stage'])
        print(record.get('workspace', ''))
        return
    if action == 'workspace':
        record['workspace'] = os.environ['ORCH_RETIRE_WORKSPACE']
        save(journal, record)
        return
    if action == 'closed':
        record.pop('workspace', None)
        save(journal, record)
        return
    if action == 'ready':
        record['stage'] = 'ready'
        save(journal, record)
        return
    if action != 'finish' or record['stage'] not in ('ready', 'complete'):
        raise RuntimeError('invalid retirement progress for %s' % path)
    branch = record['branch']
    if exists:
        if git(path, 'rev-parse', 'HEAD') != record['head']:
            raise RuntimeError('worktree HEAD changed during retirement: %s' % path)
        dirty = git(path, 'status', '--porcelain', '--untracked-files=all')
        if dirty and not force:
            raise RuntimeError('%s has uncommitted work after teardown; refusing: %s' % (path, dirty))
    if row:
        git(main, 'worktree', 'remove', *(['--force'] if force else []), path)
    remaining = entries(main)
    if os.path.lexists(path) or any(os.path.realpath(r['worktree']) == path for r in remaining):
        raise RuntimeError('worktree removal did not remove %s' % path)
    if branch and git(main, 'show-ref', '--verify', '--quiet', branch, absent=True) is not None:
        # Git's ref lock does not exclude a new worktree HEAD claim. Even an
        # expected-old delete can orphan that checkout. Retain the obligation;
        # no automated deletion, including with the manual checkout force flag.
        record['manual_branch'] = True
        save(journal, record)
        raise RuntimeError(
            'MANUAL branch cleanup pending during retirement: main %s, path %s, branch %s. '
            'Inspect saved identity %s (HEAD %s) and preserve any new commits. '
            'During controlled quiescence, stop all repository writers, inspect `%s`, '
            'and ensure no other worktree owns this branch before manually running `%s`. '
            'Keep the recovery record; resume writers only after removal, then rerun '
            '%s or retire-worktree.sh %s. '
            'Absence must be verified before retrying can complete.'
            % (main, path, branch, journal, record['head'],
               shlex.join(['git', '-C', main, 'worktree', 'list', '--porcelain']),
               shlex.join(['git', '-C', main, 'branch', '-d', '--',
                           branch.removeprefix('refs/heads/')]),
               shlex.join(['orch', 'reconcile', '--project',
                           os.environ.get('ORCH_RETIRE_PROJECT', os.path.dirname(main))]), tid))
    record.pop('manual_branch', None)
    record['stage'] = 'complete'
    save(journal, record)


if __name__ == '__main__':
    try:
        run(*sys.argv[1:5], force='--force' in sys.argv[5:])
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        print('retire-worktree: %s' % e, file=sys.stderr)
        sys.exit(1 if isinstance(e, IdentityRefusal) else 4)
