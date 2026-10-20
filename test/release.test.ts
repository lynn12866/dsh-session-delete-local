import assert from 'node:assert/strict';
import { test } from 'node:test';
import { release } from '../scripts/release.ts';

test('release requires fresh npm login and verified identity before publishing', () => {
  const commands: string[][] = [];
  release([], (args) => commands.push([...args]));
  assert.deepEqual(commands, [
    ['login', '--auth-type=web', '--registry=https://registry.npmjs.org/'],
    ['whoami', '--registry=https://registry.npmjs.org/'],
    [
      'publish',
      '--registry=https://registry.npmjs.org/',
      '--access=public',
      '--ignore-scripts=false',
    ],
  ]);
});

test('cancelled or failed npm login never reaches publish', () => {
  const commands: string[][] = [];
  assert.throws(
    () =>
      release([], (args) => {
        commands.push([...args]);
        throw new Error('Login cancelled');
      }),
    /Login cancelled/,
  );
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.[0], 'login');
});

test('failed identity verification prevents publication', () => {
  const commands: string[][] = [];
  assert.throws(
    () =>
      release([], (args) => {
        commands.push([...args]);
        if (args[0] === 'whoami') {
          throw new Error('Authentication failed');
        }
      }),
    /Authentication failed/,
  );
  assert.deepEqual(
    commands.map((args) => args[0]),
    ['login', 'whoami'],
  );
});

test('dry run builds and previews a package without authentication or publication', () => {
  const commands: string[][] = [];
  release(['--dry-run'], (args) => commands.push([...args]));
  assert.deepEqual(commands, [['pack', '--dry-run', '--ignore-scripts=false']]);
});

test('unsupported release arguments are rejected before invoking npm', () => {
  for (const args of [['--registry=other'], ['--dry-run', '--access=private']]) {
    let invoked = false;
    assert.throws(
      () =>
        release(args, () => {
          invoked = true;
        }),
      /Usage:/,
    );
    assert.equal(invoked, false);
  }
});
