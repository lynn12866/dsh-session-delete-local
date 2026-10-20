import assert from 'node:assert/strict';
import test from 'node:test';
import { childSegments, encodedSessionId, pathIdentity, retryBusy } from '#paths';
import { validId } from '#guards';

test('Windows containment accepts drives and UNC paths and rejects cross-volume escapes', () => {
  assert.deepEqual(
    childSegments('C:\\Users\\Test\\.dsh', 'c:\\users\\test\\.dsh\\storages\\cache.json', 'win32'),
    ['storages', 'cache.json'],
  );
  assert.deepEqual(
    childSegments('\\\\server\\share\\.dsh', '\\\\server\\share\\.dsh\\storages\\id.json', 'win32'),
    ['storages', 'id.json'],
  );
  for (const target of [
    'D:\\other\\id',
    'C:\\Users\\Test\\outside',
    'C:\\Users\\Test\\.dsh-evil\\file',
  ]) {
    assert.throws(() => childSegments('C:\\Users\\Test\\.dsh', target, 'win32'), {
      code: 'unsafe-path',
    });
  }
});

test('Windows namespace and case aliases normalize without changing POSIX case semantics', () => {
  assert.equal(
    pathIdentity('\\\\?\\C:\\Users\\TEST\\.dsh', 'win32'),
    pathIdentity('c:\\users\\test\\.dsh', 'win32'),
  );
  assert.equal(
    pathIdentity('\\\\?\\UNC\\server\\share\\FILE', 'win32'),
    pathIdentity('\\\\server\\share\\file', 'win32'),
  );
  assert.notEqual(pathIdentity('/tmp/Case', 'posix'), pathIdentity('/tmp/case', 'posix'));
  assert.throws(() => childSegments('/tmp/root', '/tmp/root-evil/file', 'posix'), {
    code: 'unsafe-path',
  });
});

test('session identities reject Windows devices, ADS and trailing aliases on every OS', () => {
  for (const id of [
    'CON',
    'nul.txt',
    'COM1',
    'LPT9.log',
    'file:stream',
    'name.',
    'name ',
    'a?b',
    'a|b',
    'a*b',
  ]) {
    assert.throws(() => validId(id), { code: 'invalid-id' });
  }
  assert.equal(validId('session-中文-123'), 'session-中文-123');
});

test('directory encoding matches the version-pinned JSONL backend', () => {
  assert.equal(encodedSessionId('session-123'), 'session-123');
  assert.equal(encodedSessionId('session-中~'), 'session-~4E2D~007E');
  assert.equal(encodedSessionId('..'), '~002E~002E');
});

test('Windows sharing violations retry, while cross-volume and POSIX failures stay failures', async () => {
  let attempts = 0;
  const pauses: number[] = [];
  const result = await retryBusy(
    async () => {
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      }
      return 'moved';
    },
    'win32',
    async (milliseconds) => {
      pauses.push(milliseconds);
    },
  );
  assert.equal(result, 'moved');
  assert.deepEqual(pauses, [100, 200]);
  for (const [platform, code] of [
    ['win32', 'EXDEV'],
    ['linux', 'EBUSY'],
  ]) {
    let failures = 0;
    await assert.rejects(
      () =>
        retryBusy(async () => {
          failures++;
          throw Object.assign(new Error('refused'), { code });
        }, platform),
      { code },
    );
    assert.equal(failures, 1);
  }
});
