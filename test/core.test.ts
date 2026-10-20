import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validId, selectSessions, fingerprint, checkedDirectory, lifecycleDisposer } from '#guards';
import type { EffectDisposer, SessionSnapshot } from '../src/host/contracts.ts';

const snap = (id: string, parentSession?: string): SessionSnapshot => ({
  header: { id, ...(parentSession ? { parentSession } : {}), createdAt: 1 },
  revision: 'r1',
  eventCount: 1,
  sizeBytes: 10,
});
test('reject invalid IDs and filesystem traversal', () => {
  for (const id of ['', '..', '../foo', 'foo/bar', 'foo\\bar', 'x\0y', 'a'.repeat(513), null]) {
    assert.throws(() => validId(id), { code: 'invalid-id' });
  }
  assert.equal(validId('session-中文-123'), 'session-中文-123');
});
test('derive the complete subtree while retaining unrelated sessions', () => {
  const rows = [snap('root'), snap('child', 'root'), snap('grandchild', 'child'), snap('keep')];
  assert.deepEqual(
    selectSessions(rows, 'root', true).map((s) => s.header.id),
    ['child', 'grandchild', 'root'],
  );
  assert.throws(() => selectSessions(rows, 'root', false), { code: 'has-children' });
  assert.deepEqual(
    selectSessions(rows, 'child', true).map((s) => s.header.id),
    ['child', 'grandchild'],
  );
  assert.throws(() => selectSessions(rows, 'missing', true), { code: 'not-found' });
});
test('lineage cycles terminate', () => {
  assert.equal(selectSessions([snap('a', 'b'), snap('b', 'a')], 'a', true).length, 2);
});
test('fingerprint ignores object key order but detects a changed durable revision', () => {
  const a = snap('a');
  const b = { ...a, header: { createdAt: 1, id: 'a' } };
  assert.equal(fingerprint([a]), fingerprint([b]));
  assert.notEqual(fingerprint([a]), fingerprint([{ ...a, revision: 'r2' }]));
});
test('filesystem guard rejects symlinks, sibling roots, and the root itself', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'dsh-delete-path-')));
  try {
    const root = join(temp, 'sessions');
    const dir = join(root, 'project', 'id');
    await mkdir(dir, { recursive: true });
    const log = join(dir, 'session.v4.jsonl');
    await writeFile(log, '{}');
    assert.equal(await checkedDirectory(root, log), dir);
    await assert.rejects(() => checkedDirectory(root, join(temp, 'other', 'id', 'file')), {
      code: 'unsafe-path',
    });
    await assert.rejects(() => checkedDirectory(root, join(root, 'file')), { code: 'unsafe-path' });
    await symlink(
      dir,
      join(root, 'project', 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      () => checkedDirectory(root, join(root, 'project', 'link', 'session.v4.jsonl')),
      { code: 'unsafe-path' },
    );
  } finally {
    await rm(temp, { recursive: true });
  }
});
test('an unknown or ambiguous live lifecycle is refused', () => {
  assert.throws(() => lifecycleDisposer({ id: 'a' }), { code: 'unsupported-lifecycle' });
  const dispose: EffectDisposer = Object.assign(() => {}, {
    [Symbol.for('cordis.effect')]: { label: 'agentLoop.scope(a)' },
  });
  assert.equal(
    lifecycleDisposer({ id: 'a', loopCtx: { fiber: { _disposables: [dispose] } } }),
    dispose,
  );
  assert.throws(
    () => lifecycleDisposer({ id: 'a', loopCtx: { fiber: { _disposables: [dispose, dispose] } } }),
    { code: 'unsupported-lifecycle' },
  );
});
