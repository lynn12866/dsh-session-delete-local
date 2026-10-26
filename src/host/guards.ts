import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentLifecycle, Disposer, SessionSnapshot } from './contracts.js';
import { refuse } from './errors.js';
import { samePath } from './paths.js';

export function validId(id: unknown): string {
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > 512 ||
    id.includes('/') ||
    /[<>:"|?*]/.test(id) ||
    id.includes('\\') ||
    /[. ]$/.test(id) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) ||
    [...id].some((character) => character.charCodeAt(0) < 32) ||
    id === '.' ||
    id === '..'
  ) {
    refuse('invalid-id', '无效的会话 ID。');
  }
  return id;
}
export function selectSessions(
  snapshots: SessionSnapshot[],
  sessionId: string,
  includeChildren: boolean,
): SessionSnapshot[] {
  validId(sessionId);
  const byId = new Map(snapshots.map((s) => [s.header.id, s]));
  if (!byId.has(sessionId)) {
    refuse('not-found', '会话不存在，或尚未保存。');
  }
  const ids = new Set([sessionId]);
  let changed;
  do {
    changed = false;
    for (const s of snapshots) {
      if (s.header.parentSession && ids.has(s.header.parentSession) && !ids.has(s.header.id)) {
        ids.add(s.header.id);
        changed = true;
      }
    }
  } while (changed);
  if (!includeChildren && ids.size > 1) {
    refuse('has-children', '此会话有派生会话。请勾选一并删除，或先单独处理派生会话。');
  }
  return [...ids].map((id) => byId.get(id)!).sort((a, b) => a.header.id.localeCompare(b.header.id));
}
export function fingerprint(snapshots: SessionSnapshot[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        snapshots.map((s) => [
          Object.fromEntries(
            Object.keys(s.header)
              .sort()
              .map((k) => [k, s.header[k]]),
          ),
          s.revision,
          s.eventCount,
          s.sizeBytes,
        ]),
      ),
    )
    .digest('hex');
}
// 0.2.1-rc.2 / rc.3: dispose the loop's complete lifecycle effect, not merely its
// registration scope. The latter leaves its writer and SessionStore entry live.
export function lifecycleDisposer(agent: AgentLifecycle): Disposer {
  const disposables = agent.loopCtx?.fiber?._disposables;
  const matches = disposables
    ? [...disposables].filter(
        (fn) => fn[Symbol.for('cordis.effect')]?.label === `agentLoop.scope(${agent.id})`,
      )
    : [];
  if (matches.length !== 1) {
    refuse('unsupported-lifecycle', '此会话的生命周期接口不兼容，已拒绝删除。');
  }
  return matches[0]!;
}
// Never accept a caller-supplied filesystem path. All paths come from this backend.
export async function checkedDirectory(root: string, file: string): Promise<string> {
  const base = resolve(root);
  const target = dirname(resolve(file));
  const rel = relative(base, target);
  if (!rel || isAbsolute(rel) || rel.startsWith('..') || rel.split(/[\\/]/).length !== 2) {
    refuse('unsafe-path', '会话存储路径不符合当前版本布局，已拒绝删除。');
  }
  let cursor = base;
  for (const part of ['', ...rel.split(/[\\/]/)]) {
    if (part) {
      cursor = join(cursor, part);
    }
    const st = await lstat(cursor);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      refuse('unsafe-path', '会话存储路径包含符号链接或非目录，已拒绝删除。');
    }
  }
  if (!samePath(await realpath(target), target) || !samePath(await realpath(base), base)) {
    refuse('unsafe-path', '会话存储路径经过符号链接，已拒绝删除。');
  }
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink()) {
    refuse('unsafe-path', '会话日志不是普通文件。');
  }
  return target;
}
