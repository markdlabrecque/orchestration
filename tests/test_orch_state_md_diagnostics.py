"""Read-only retention accounting, using disposable projects and bounded CLI calls."""
import json
import os
from pathlib import Path
import sqlite3
import time

from test_orch import OrchTestCase


class StateMdDiagnosticsTests(OrchTestCase):
    def setUp(self):
        super().setUp()
        self.env['ORCH_HOME'] = self.state_dir
        self.path = Path(self.root, 'STATE.md')
        self.retention = Path(self.root, '.STATE.md.legacy')
        self.init()

    def snapshot(self):
        with sqlite3.connect(self.db_path()) as db:
            records = tuple(db.iterdump())
        files = {}
        for path in [self.path, *sorted(self.retention.glob('*'))]:
            if path.exists():
                stat = path.stat()
                files[str(path.relative_to(self.root))] = (
                    stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns,
                    path.read_bytes())
        return records, self.retention.exists(), files

    def diagnostics(self):
        before = self.snapshot()
        result = self.orch('state-md', 'diagnostics', '--json', timeout=30)
        self.assertEqual(self.snapshot(), before, 'diagnostics must not repair or mutate')
        self.assertEqual(result.returncode, 0,
                         'missing successful diagnostics operation: ' + result.stderr)
        data = json.loads(result.stdout)
        for key in ('retained_inode_count', 'retained_bytes', 'scanned_tail_bytes'):
            self.assertIn(key, data)
            self.assertIs(type(data[key]), int)
            self.assertGreaterEqual(data[key], 0)
        self.assertNotIn('wall_seconds', data, 'timing is evidence, not diagnostic state')
        repeated = self.orch('state-md', 'diagnostics', '--json', timeout=30)
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(repeated.stdout, result.stdout, 'JSON must be deterministic')
        self.assertEqual(self.snapshot(), before)
        return data

    def assert_metrics(self, count, retained, tails):
        data = self.diagnostics()
        self.assertEqual((data['retained_inode_count'], data['retained_bytes'],
                          data['scanned_tail_bytes']), (count, retained, tails))

    def test_missing_retention_is_zero_and_not_created(self):
        self.assertFalse(self.retention.exists())
        self.assert_metrics(0, 0, 0)
        self.assertFalse(self.retention.exists())

    def test_empty_retention_is_zero(self):
        self.retention.mkdir()
        self.assert_metrics(0, 0, 0)

    def test_missing_projection_is_not_rebuilt(self):
        self.path.unlink()
        self.assert_metrics(0, 0, 0)
        self.assertFalse(self.path.exists())

    def test_late_append_is_counted_without_repair_or_acknowledgement(self):
        with self.path.open('ab') as old:
            baseline = self.path.stat().st_size
            self.add('T-1')
            tail = '- late legacy café\n'.encode()
            old.write(tail)
            old.flush()
        self.assert_metrics(1, baseline + len(tail), len(tail))
        self.ok('state-md', 'rebuild')
        legacy_section = self.path.read_text().split('### Retained legacy appends', 1)[1]
        projected_tail = legacy_section.split('```json\n', 1)[1].split('\n```', 1)[0]
        self.assertEqual(projected_tail,
                         json.dumps(tail.decode('utf-8'), ensure_ascii=True))
        self.assertEqual(json.loads(projected_tail).encode('utf-8', 'surrogateescape'),
                         tail)
        # The collector has no cursor: rebuilding does not consume retained tails.
        entries = list(self.retention.iterdir())
        self.assert_metrics(2, sum(p.stat().st_size for p in entries), len(tail))

    def test_current_inode_preparation_counts_bytes_but_not_tail(self):
        self.retention.mkdir()
        stat = self.path.stat()
        os.link(self.path, self.retention / ('%s-%s-%s' %
                                            (stat.st_dev, stat.st_ino, stat.st_size)))
        with self.path.open('ab') as current:
            current.write(b'- current preparation append\n')
        self.assert_metrics(1, self.path.stat().st_size, 0)

    def test_stale_database_projection_is_not_reconciled(self):
        self.add('T-1')
        self.db_exec("UPDATE tickets SET title='committed but unpublished' WHERE id='T-1'")
        self.assertNotIn(b'committed but unpublished', self.path.read_bytes())
        self.assert_metrics(1, sum(p.stat().st_size for p in self.retention.iterdir()), 0)
        self.assertNotIn(b'committed but unpublished', self.path.read_bytes())

    def test_invalid_retention_refuses_without_mutation(self):
        # Match the freshness collector's refusal semantics, not silent undercounting.
        for kind in ('malformed', 'wrong-inode', 'truncated'):
            with self.subTest(kind=kind):
                self.retention.mkdir(exist_ok=True)
                entry = self.retention / 'invalid-name'
                entry.write_bytes(b'abc')
                if kind != 'malformed':
                    stat = entry.stat()
                    name = '%s-%s-%s' % (stat.st_dev,
                                        stat.st_ino + (kind == 'wrong-inode'),
                                        4 if kind == 'truncated' else 3)
                    entry = entry.rename(self.retention / name)
                before = self.snapshot()
                result = self.orch('state-md', 'diagnostics', '--json', timeout=30)
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(result.returncode, 3, result.stderr)
                self.assertNotIn('invalid choice', result.stderr)
                self.assertIn({'malformed': 'unexpected legacy retention entry',
                               'wrong-inode': 'legacy retention inode changed',
                               'truncated': 'legacy retention file truncated'}[kind],
                              result.stdout + result.stderr)
                entry.unlink()

    def test_text_reports_all_metrics(self):
        result = self.orch('state-md', 'diagnostics', timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = result.stdout.lower().replace('_', ' ').replace('-', ' ')
        for label in ('retained inode', 'retained bytes', 'scanned tail bytes'):
            self.assertIn(label, text)

    def test_bounded_growing_history_and_unchanged_publications(self):
        started = time.monotonic()
        count = 16
        retained_bytes = 0
        sizes = []
        for index in range(count):
            retained_bytes += self.path.stat().st_size
            self.add('S-%02d' % index, title='bounded history ' + 'x' * 128)
            sizes.append(self.path.stat().st_size)
        entries = list(self.retention.iterdir())
        self.assertEqual(len(entries), count)
        self.assertEqual(sum(p.stat().st_size for p in entries), retained_bytes)
        self.assertGreater(sizes[-1], sizes[0])
        before = self.snapshot()
        for _ in range(3):
            self.ok('state-md', 'rebuild')
            self.ok('state-md', 'check')
        self.assertEqual(self.snapshot(), before, 'unchanged publications retain nothing')
        # Emit real accounting even on the pre-implementation red run.
        print('STATE_MD_SCALE ' + json.dumps({
            'command': 'python3 -m unittest discover -s tests -p test_orch_state_md_diagnostics.py -v',
            'wall_seconds': round(time.monotonic() - started, 6),
            'publication_count': count, 'unchanged_rebuild_count': 3,
            'document_bytes': self.path.stat().st_size,
            'retained_bytes': retained_bytes, 'scanned_tail_bytes': 0,
            'retained_inode_count': len(entries)}, sort_keys=True), flush=True)
        self.assert_metrics(count, retained_bytes, 0)
