import { copyFile, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DeletionJournal, HostContext } from './contracts.js';
import type { JsonPatch, StoragePlan } from './storage-plan.js';
import { artifactStageRoot, jsonObject } from './storage-plan.js';
import { checkedPath, fileExists, movePath, purgePath } from './paths.js';
import { durableJson } from './journal.js';
import { refuse } from './errors.js';

export async function atomicText(file: string, text: string): Promise<void> {
  const temporary = join(dirname(file), `.${randomUUID()}.session-delete.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await movePath(temporary, file);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Owns rollback of storage records and same-volume file stages. */
export class StorageTransaction {
  private readonly removed = new Set<string>();
  private readonly patched: JsonPatch[] = [];
  private readonly stages = new Set<string>();

  private readonly ctx: HostContext;
  private readonly plan: StoragePlan;
  private readonly journal: DeletionJournal;
  private readonly central: string;
  private readonly transaction: string;

  constructor(
    ctx: HostContext,
    plan: StoragePlan,
    journal: DeletionJournal,
    central: string,
    transaction: string,
  ) {
    this.ctx = ctx;
    this.plan = plan;
    this.journal = journal;
    this.central = central;
    this.transaction = transaction;
  }

  private async stage(root: string): Promise<string> {
    const directory = artifactStageRoot(root, this.transaction);
    await checkedPath(root, directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.stages.add(directory);
    this.journal.stageDirectories = [...this.stages];
    return directory;
  }

  async apply(): Promise<void> {
    this.journal.storageBackups = this.plan.records;
    await durableJson(join(this.central, 'journal.json'), this.journal);
    for (const file of this.plan.files) {
      await checkedPath(file.root, file.path);
      if (!(await fileExists(file.path))) {
        continue;
      }
      const stage = await this.stage(file.root);
      const staged = join(stage, String(this.journal.moved.length));
      this.journal.moved.push({ id: file.sessionId, original: file.path, staged });
      await durableJson(join(this.central, 'journal.json'), this.journal);
      await movePath(file.path, staged);
    }
    for (const patch of this.plan.patches) {
      await checkedPath(patch.root, patch.path);
      if ((await readFile(patch.path, 'utf8')) !== patch.original) {
        refuse('changed', `预览后共享元数据发生变化，请重新检查：${patch.path}`);
      }
      const stage = await this.stage(patch.root);
      const staged = join(stage, `shared-${this.patched.length}`);
      await copyFile(patch.path, staged);
      const handle = await open(staged, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.journal.moved.push({
        id: 'shared-metadata',
        original: patch.path,
        staged,
        backupOnly: true,
      });
      await durableJson(join(this.central, 'journal.json'), this.journal);
      this.patched.push(patch);
      await atomicText(patch.path, patch.replacement);
    }
    for (const record of this.plan.records) {
      if (record.operation === 'prune-membership') {
        const ids = new Set(this.plan.entries.flatMap((entry) => entry.sessionIds));
        const updated = await this.ctx.storageDomain
          .get('workspace')!
          .table('workspaces')
          .update(record.key, (current) => {
            if (!jsonObject(current) || !Array.isArray(current.sessionIds)) {
              refuse('metadata-format', '工作区记录格式不兼容。');
            }
            return {
              ...current,
              sessionIds: current.sessionIds.filter((id) => !ids.has(String(id))),
              updatedAt: new Date().toISOString(),
            };
          });
        const entity = this.ctx.workspaceRegistry.get(record.key);
        if (entity) {
          entity.record = updated;
        }
        this.removed.add(`${record.domain}/${record.table}/${record.key}`);
        continue;
      }
      const schedule = record.domain === 'schedule' ? this.ctx.get('schedule') : undefined;
      const table = this.ctx.storageDomain.get(record.domain)!.table(record.table);
      const remove = async () => {
        if (
          record.domain === 'schedule' &&
          JSON.stringify(table.get(record.key)) !== JSON.stringify(record.value)
        ) {
          refuse('changed', '提醒记录发生变化，请重新预览。');
        }
        return await table.delete(record.key);
      };
      const result = schedule ? await schedule.serialize(remove) : await remove();
      if (result !== false) {
        this.removed.add(`${record.domain}/${record.table}/${record.key}`);
        schedule?.emitChanged();
        schedule?.runtime?.requestDrive();
      }
    }
  }

  async restoreRecords(): Promise<string[]> {
    const errors: string[] = [];
    for (const record of this.plan.records) {
      if (!this.removed.has(`${record.domain}/${record.table}/${record.key}`)) {
        continue;
      }
      try {
        if (record.operation === 'prune-membership') {
          const ids = new Set(this.plan.entries.flatMap((entry) => entry.sessionIds));
          const original = record.value;
          const restored = await this.ctx.storageDomain
            .get('workspace')!
            .table('workspaces')
            .update(record.key, (current) => {
              if (
                !jsonObject(current) ||
                !jsonObject(original) ||
                !Array.isArray(current.sessionIds) ||
                !Array.isArray(original.sessionIds)
              ) {
                refuse('metadata-format', '工作区恢复记录格式不兼容。');
              }
              return {
                ...current,
                sessionIds: restoreSelected(
                  current.sessionIds.map(String),
                  original.sessionIds.map(String),
                  ids,
                ),
              };
            });
          const entity = this.ctx.workspaceRegistry.get(record.key);
          if (entity) {
            entity.record = restored;
          }
          continue;
        }
        const restore = async () => {
          await this.ctx.storageDomain
            .get(record.domain)!
            .table(record.table)
            .put(record.key, record.value);
        };
        const schedule = record.domain === 'schedule' ? this.ctx.get('schedule') : undefined;
        if (schedule) {
          await schedule.serialize(restore);
          schedule.emitChanged();
          schedule.runtime?.requestDrive();
        } else {
          await restore();
        }
      } catch (error) {
        errors.push(String(error));
      }
    }
    for (const patch of this.patched.reverse()) {
      try {
        const current = await readFile(patch.path, 'utf8');
        if (current !== patch.replacement && current !== patch.original) {
          throw new Error(`共享文件被其他写入修改，保留恢复备份：${patch.path}`);
        }
        await atomicText(patch.path, patch.original);
      } catch (error) {
        errors.push(String(error));
      }
    }
    return errors;
  }

  async purge(): Promise<void> {
    for (const directory of this.stages) {
      await purgePath(directory);
    }
  }
}

/** Restore selected identities while preserving unrelated concurrent edits. */
export function restoreSelected(
  current: string[],
  previous: string[],
  selected: Set<string>,
): string[] {
  const restored = current.filter((id) => !selected.has(id));
  for (const [index, id] of previous.entries()) {
    if (!selected.has(id)) {
      continue;
    }
    const following = previous.slice(index + 1).find((candidate) => restored.includes(candidate));
    if (following) {
      restored.splice(restored.indexOf(following), 0, id);
    } else {
      restored.push(id);
    }
  }
  return restored;
}
