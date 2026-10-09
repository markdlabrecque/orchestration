#!/usr/bin/env python3
"""Validate adapter inventories before using them as proof of absence."""
import json
import os
import sys


def identity(value):
    return (isinstance(value, str) and bool(value.strip())
            and not any(ord(c) < 32 or ord(c) == 127 for c in value))


def path(value):
    return identity(value) and os.path.isabs(value)


def inventory(reply, kind, discovery=False):
    result = reply.get('result') if isinstance(reply, dict) else None
    rows = result.get(kind) if isinstance(result, dict) else None
    if not isinstance(rows, list):
        raise ValueError('invalid %s inventory container' % kind)
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('invalid %s inventory entry' % kind)
        if kind == 'worktrees':
            valid = path(row.get('path'))
            if discovery:
                valid = (valid and 'open_workspace_id' in row
                         and (row['open_workspace_id'] is None
                              or identity(row['open_workspace_id'])))
        elif kind == 'workspaces':
            valid = identity(row.get('workspace_id'))
            if discovery or 'worktree' in row:
                wt = row.get('worktree')
                valid = (valid and isinstance(wt, dict)
                         and path(wt.get('checkout_path')))
        else:
            raise ValueError('unsupported inventory: %s' % kind)
        if not valid:
            raise ValueError('invalid %s identity/path' % kind)
    return rows


if __name__ == '__main__':
    try:
        inventory(json.load(sys.stdin), sys.argv[1], discovery=True)
    except (ValueError, TypeError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
