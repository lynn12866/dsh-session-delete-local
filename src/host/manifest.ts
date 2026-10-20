import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { CleanupManifest, CleanupPath } from '../shared/contracts.js';
import type { HostContext } from './contracts.js';
import { checkedDirectory } from './guards.js';
import { fileExists, inspectTree } from './paths.js';
import { storagePlan } from './storage-plan.js';
import type { StoragePlan } from './storage-plan.js';
import { refuse } from './errors.js';

export interface Inspection {
  manifest: CleanupManifest;
  storage: StoragePlan;
  logDirectories: { id: string; path: string }[];
  signature: string;
}

export async function inspectCleanup(
  ctx: HostContext,
  ids: string[],
  mode: 'session' | 'residue',
): Promise<Inspection> {
  const storage = await storagePlan(ctx, ids);
  const entries: CleanupPath[] = [...storage.entries];
  const logDirectories: Inspection['logDirectories'] = [];
  if (mode === 'session') {
    for (const id of ids) {
      const log = await ctx.sessionPersistence.findLog(id);
      if (!log) {
        refuse('changed', '会话日志已变化，请重新检查。');
      }
      const directory = await checkedDirectory(
        ctx.sessionPersistence.root,
        log.sourcePath ?? log.currentPath,
      );
      logDirectories.push({ id, path: directory });
      const files = await inspectTree(ctx.sessionPersistence.root, directory);
      for (const file of files) {
        entries.push({
          path: file.path,
          action: file.kind === 'file' ? 'delete-file' : 'delete-directory',
          category: 'session-log',
          sessionIds: [id],
          recordKeys: [],
          bytes: file.bytes,
          exists: true,
        });
      }
      for (const possible of [
        log.currentPath,
        ...(process.platform === 'win32' ? [] : [join(directory, 'session.lock')]),
      ]) {
        if (!entries.some((entry) => entry.path === possible)) {
          entries.push({
            path: possible,
            action: 'delete-file',
            category: 'session-log',
            sessionIds: [id],
            recordKeys: [],
            bytes: 0,
            exists: false,
          });
        }
      }
    }
  }
  const recoveryRoot = join(dirname(ctx.sessionPersistence.root), '.session-delete-staging');
  if (
    (await fileExists(recoveryRoot)) &&
    !storage.retained.some((entry) => entry.path === recoveryRoot)
  ) {
    storage.retained.push({ path: recoveryRoot, reason: 'recovery-data' });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const manifest: CleanupManifest = {
    platform: process.platform,
    entries,
    retained: storage.retained,
    limitations: ['shared-attachments', 'external-copies', 'unknown-plugin-data'],
  };
  const signature = createHash('sha256')
    .update(
      JSON.stringify({
        storage: storage.signature,
        logs: entries
          .filter((entry) => entry.category === 'session-log')
          .map((entry) => [entry.path, entry.action]),
      }),
    )
    .digest('hex');
  return { manifest, storage, logDirectories, signature };
}
