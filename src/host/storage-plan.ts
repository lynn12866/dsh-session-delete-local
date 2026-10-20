import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { CleanupCategory, CleanupPath, RetainedPath } from '../shared/contracts.js';
import type { HostContext, RecordBackup, StorageDomain } from './contracts.js';
import { refuse } from './errors.js';
import { checkedPath, fileExists } from './paths.js';

export interface OwnedFile {
  path: string;
  root: string;
  category: CleanupCategory;
  sessionId: string;
}

export interface JsonPatch {
  path: string;
  root: string;
  original: string;
  replacement: string;
}

export interface StoragePlan {
  entries: CleanupPath[];
  files: OwnedFile[];
  patches: JsonPatch[];
  records: RecordBackup[];
  retained: RetainedPath[];
  signature: string;
}

const sidecarDomains = ['session_projcache', 'message_feedback', 'schedule'] as const;

export function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rootFor(ctx: HostContext, name: string): string {
  const route = ctx.storageDomain.config.routes?.[name] ?? ctx.storageDomain.config.backend;
  const backend = ctx.storage.backend.get(route);
  if (typeof backend.root !== 'string') {
    refuse(
      'unsupported-storage',
      '仅支持当前版本的 JSON 元数据存储；无法安全展示此后端的文件路径。',
    );
  }
  return resolve(backend.root);
}

function liveDomain(ctx: HostContext, name: string): StorageDomain | undefined {
  const domain = ctx.storageDomain.get(name);
  if (domain && domain.unit.descriptor.name !== name) {
    refuse('unsupported-storage', '存储域身份不匹配。');
  }
  return domain;
}

function unitPath(domain: StorageDomain): string {
  const file = domain.unit.path ?? domain.unit.dir;
  if (typeof file !== 'string') {
    refuse('unsupported-storage', '元数据存储接口不兼容。');
  }
  return resolve(file);
}

async function readUnit(file: string, name: string): Promise<Record<string, unknown> | undefined> {
  if (!(await fileExists(file))) {
    return undefined;
  }
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    !jsonObject(value) ||
    !jsonObject(value.unit) ||
    value.unit.name !== name ||
    !jsonObject(value.tables)
  ) {
    refuse('metadata-format', `无法识别元数据文件，未执行删除：${file}`);
  }
  return value;
}

function tableRows(document: Record<string, unknown>, name: string): Record<string, unknown> {
  const tables = document.tables;
  if (!jsonObject(tables) || !jsonObject(tables[name])) {
    refuse('metadata-format', '元数据表格式不兼容，未执行删除。');
  }
  return tables[name];
}

function matches(name: string, key: string, value: unknown, ids: Set<string>): boolean {
  return name === 'schedule'
    ? jsonObject(value) && typeof value.sessionId === 'string' && ids.has(value.sessionId)
    : ids.has(key);
}

function owner(name: string, key: string, value: unknown): string {
  if (name === 'schedule' && (!jsonObject(value) || typeof value.sessionId !== 'string')) {
    refuse('metadata-format', '提醒记录没有可确认的会话归属，已拒绝清理。');
  }
  return name === 'schedule' && jsonObject(value) && typeof value.sessionId === 'string'
    ? value.sessionId
    : key;
}

async function planLegacyUnit(
  root: string,
  name: string,
  ids: Set<string>,
  plan: StoragePlan,
): Promise<void> {
  const file = join(root, `${name}.json`);
  await checkedPath(root, file);
  const original = await readUnit(file, name);
  if (!original) {
    return;
  }
  const table = name === 'schedule' ? 'tasks' : 'sessions';
  const rows = tableRows(original, table);
  const selected = Object.entries(rows).filter(([key, value]) => matches(name, key, value, ids));
  if (!selected.length) {
    return;
  }
  const updated = structuredClone(original);
  const targetRows = tableRows(updated, table);
  for (const [key] of selected) {
    delete targetRows[key];
  }
  plan.patches.push({
    path: file,
    root,
    original: await readFile(file, 'utf8'),
    replacement: JSON.stringify(updated, null, 2) + '\n',
  });
  plan.entries.push({
    path: file,
    action: 'update-record',
    category:
      name === 'session_projcache'
        ? 'legacy-cache'
        : name === 'schedule'
          ? 'schedule'
          : 'legacy-feedback',
    sessionIds: [...new Set(selected.map(([key, value]) => owner(name, key, value)))],
    recordKeys: selected.map(([key]) => `tables.${table}.${key}`),
    bytes: 0,
    exists: true,
  });
}

async function planPerRecord(
  root: string,
  dir: string,
  name: string,
  ids: Set<string>,
  plan: StoragePlan,
): Promise<void> {
  const tableDir = join(dir, 'sessions');
  await checkedPath(root, tableDir);
  const names = (await fileExists(tableDir)) ? await readdir(tableDir) : [];
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      continue; // The pinned JSON backend cannot own a record file with this key.
    }
    const primary = `${id}.json`;
    const selected = names.filter(
      (name) =>
        name === primary ||
        (name.startsWith(`${primary}.bak.`) && /^\d{12}$/.test(name.slice(primary.length + 5))),
    );
    // Always disclose the canonical checkpoint path, including a final disposal write.
    if (!selected.includes(primary)) {
      selected.push(primary);
    }
    for (const filename of selected.sort()) {
      const file = join(tableDir, filename);
      await checkedPath(root, file);
      const exists = await fileExists(file);
      const stat = exists ? await lstat(file) : undefined;
      if (stat && !stat.isFile()) {
        refuse('unsafe-path', `会话元数据不是普通文件：${file}`);
      }
      const category =
        name === 'message_feedback'
          ? 'legacy-feedback'
          : filename === primary
            ? 'projection-cache'
            : 'cache-backup';
      plan.files.push({ path: file, root, category, sessionId: id });
      plan.entries.push({
        path: file,
        action: 'delete-file',
        category,
        sessionIds: [id],
        recordKeys: [],
        bytes: stat?.size ?? 0,
        exists,
      });
    }
  }
}

export async function storagePlan(ctx: HostContext, selected: string[]): Promise<StoragePlan> {
  const ids = new Set(selected);
  const plan: StoragePlan = {
    entries: [],
    files: [],
    patches: [],
    records: [],
    retained: [],
    signature: '',
  };
  for (const name of sidecarDomains) {
    const root = rootFor(ctx, name);
    const domain = liveDomain(ctx, name);
    if (domain) {
      const table = name === 'schedule' ? 'tasks' : 'sessions';
      const rows = [...domain.table(table).entries()].filter(([key, value]) =>
        matches(name, key, value, ids),
      );
      for (const [key, value] of rows) {
        plan.records.push({ domain: name, table, key, value: structuredClone(value) });
      }
      const location = unitPath(domain);
      await checkedPath(root, location);
      if (domain.unit.dir) {
        assertRecordDirectory(location, name);
        if (name === 'schedule') {
          refuse('unsupported-storage', '提醒存储布局不兼容。');
        }
        await planPerRecord(root, location, name, ids, plan);
        await planLegacyUnit(root, name, ids, plan);
      } else if (rows.length) {
        plan.entries.push({
          path: location,
          action: 'update-record',
          category: name === 'schedule' ? 'schedule' : 'legacy-feedback',
          sessionIds: [...new Set(rows.map(([key, value]) => owner(name, key, value)))],
          recordKeys: rows.map(([key]) => `tables.${table}.${key}`),
          bytes: 0,
          exists: true,
        });
      }
    } else {
      if (name !== 'schedule') {
        const dir = join(root, name);
        if (await fileExists(dir)) {
          await planPerRecord(root, dir, name, ids, plan);
        }
      }
      await planLegacyUnit(root, name, ids, plan);
    }
  }
  const workspace = liveDomain(ctx, 'workspace');
  if (!workspace || !workspace.unit.path) {
    refuse('unsupported-storage', '工作区元数据布局不兼容，已拒绝删除。');
  }
  const workspaceFile = unitPath(workspace);
  await checkedPath(rootFor(ctx, 'workspace'), workspaceFile);
  const membershipKeys: string[] = [];
  for (const [key, value] of workspace.table('workspaces').entries()) {
    if (
      jsonObject(value) &&
      Array.isArray(value.sessionIds) &&
      value.sessionIds.some((id) => typeof id === 'string' && ids.has(id))
    ) {
      membershipKeys.push(`tables.workspaces.${key}.sessionIds`);
      plan.records.push({
        domain: 'workspace',
        table: 'workspaces',
        key,
        value: structuredClone(value),
        operation: 'prune-membership',
      });
    }
  }
  if (selected.length) {
    plan.entries.push({
      path: workspaceFile,
      action: 'update-record',
      category: 'workspace-reference',
      sessionIds: selected,
      recordKeys: [...membershipKeys, 'global.archivedSessionIds', 'global.pinnedSessionIds'],
      bytes: 0,
      exists: true,
    });
  }
  const attachments = ctx.get('attachments');
  for (const root of new Set(sidecarDomains.map((name) => rootFor(ctx, name)))) {
    plan.retained.push({ path: root, reason: 'outside-scope' });
    const recovery = join(root, '.session-delete-staging');
    if (await fileExists(recovery)) {
      plan.retained.push({ path: recovery, reason: 'recovery-data' });
    }
  }
  if (attachments?.root) {
    plan.retained.push({ path: attachments.root, reason: 'shared-attachments' });
  }
  if (attachments?.cacheRoot) {
    plan.retained.push({ path: attachments.cacheRoot, reason: 'shared-attachments' });
  }
  for (const record of plan.records.filter((record) => record.domain === 'workspace')) {
    if (jsonObject(record.value) && typeof record.value.path === 'string') {
      plan.retained.push({ path: record.value.path, reason: 'workspace-files' });
    }
  }
  plan.entries.sort((left, right) => left.path.localeCompare(right.path));
  // Projection rows may legitimately advance during the final Agent disposal.
  plan.signature = createHash('sha256')
    .update(
      JSON.stringify({
        files: plan.files.map((file) => file.path).sort(),
        patches: plan.patches.map((patch) => [patch.path, patch.original]),
        records: plan.records.filter((record) => record.domain !== 'session_projcache'),
        entries: plan.entries.filter((entry) => entry.action === 'update-record'),
      }),
    )
    .digest('hex');
  return plan;
}

export async function metadataSessionIds(ctx: HostContext): Promise<string[]> {
  const ids = new Set<string>();
  for (const name of sidecarDomains) {
    const root = rootFor(ctx, name);
    const domain = liveDomain(ctx, name);
    if (domain) {
      for (const [key, value] of domain
        .table(name === 'schedule' ? 'tasks' : 'sessions')
        .entries()) {
        ids.add(owner(name, key, value));
      }
    }
    await checkedPath(root, join(root, `${name}.json`));
    const legacy = await readUnit(join(root, `${name}.json`), name);
    if (legacy) {
      for (const [key, value] of Object.entries(
        tableRows(legacy, name === 'schedule' ? 'tasks' : 'sessions'),
      )) {
        ids.add(owner(name, key, value));
      }
    }
    if (name !== 'schedule') {
      const dir = join(root, name, 'sessions');
      await checkedPath(root, dir);
      if (await fileExists(dir)) {
        for (const file of await readdir(dir)) {
          const match = /^([a-zA-Z0-9_-]+)\.json(?:\.bak\.\d{12})?$/.exec(file);
          if (match) {
            ids.add(match[1]!);
          }
        }
      }
    }
  }
  for (const id of [
    ...ctx.workspaceRegistry.archivedSessionIds,
    ...ctx.workspaceRegistry.pinnedSessionIds,
  ]) {
    ids.add(id);
  }
  const workspace = liveDomain(ctx, 'workspace');
  if (workspace) {
    for (const [, value] of workspace.table('workspaces').entries()) {
      if (jsonObject(value) && Array.isArray(value.sessionIds)) {
        for (const id of value.sessionIds) {
          if (typeof id === 'string') {
            ids.add(id);
          }
        }
      }
    }
  }
  return [...ids].sort();
}

export function artifactStageRoot(root: string, transaction: string): string {
  return join(root, '.session-delete-staging', transaction);
}

export function assertRecordDirectory(dir: string, name: string): void {
  if (basename(dir) !== name || dirname(dir) === dir) {
    refuse('unsupported-storage', '元数据目录与存储域身份不匹配。');
  }
}
