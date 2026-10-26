import { lstat, realpath, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DeletePreview, DeleteResult } from '../shared/contracts.js';
import type {
  DeletionJournal,
  HostContext,
  MovedSession,
  SessionPersistence,
  SessionSnapshot,
  WriteHandle,
} from './contracts.js';
import { DeleteError, refuse } from './errors.js';
import { errorCode } from '../shared/errors.js';
import { fingerprint, lifecycleDisposer, selectSessions, validId } from './guards.js';
import { inspectCleanup } from './manifest.js';
import { metadataSessionIds, jsonObject } from './storage-plan.js';
import { StorageTransaction, restoreSelected } from './storage-transaction.js';
import {
  checkedPath,
  fileExists,
  hasSessionDirectory,
  movePath,
  purgePath,
  samePath,
} from './paths.js';
import { durableJson } from './journal.js';

interface DeletePlan {
  mode: 'session' | 'residue';
  ids: string[];
  cleanupSignature: string;
  sessionId: string;
  includeChildren: boolean;
  fingerprint: string;
  expires: number;
}

/** Version-specific adapter; mutates only the active backend and its owning domains. */
export class SessionDeletion {
  private readonly tokens = new Map<string, DeletePlan>();
  private tail: Promise<void> = Promise.resolve();
  private readonly deleting = new Set<string>();

  private readonly ctx: HostContext;

  constructor(ctx: HostContext) {
    this.ctx = ctx;
  }

  async finishPending(): Promise<void> {
    await this.tail;
  }

  checkBackend(): SessionPersistence {
    const persistence = this.ctx.sessionPersistence;
    const workspaces = this.ctx.workspaceRegistry;
    const cache = this.ctx.sessionProjectionCache;
    if (
      persistence.name !== 'session-persistence-jsonl' ||
      typeof persistence.root !== 'string' ||
      typeof persistence.findLog !== 'function' ||
      typeof persistence.tracker?.writers?.has !== 'function' ||
      typeof workspaces.enqueueOperation !== 'function' ||
      !workspaces.headers?.delete ||
      !workspaces.sessionPaths?.delete ||
      !cache.table?.delete
    ) {
      refuse('unsupported', '仅支持 DeepSeek Harness 0.2.1-rc.2 / rc.3 的内置 JSONL 存储。');
    }
    return persistence;
  }

  async snapshots(id: string, includeChildren: boolean): Promise<SessionSnapshot[]> {
    const persistence = this.checkBackend();
    // Include published-but-unmaterialized sessions so children cannot be overlooked.
    const rows = new Map((await persistence.list()).map((s) => [s.header.id, s]));
    for (const s of this.ctx.sessions.list()) {
      if (!rows.has(s.id)) {
        rows.set(s.id, {
          header: s.header,
          revision: `live:${s.seq}`,
          eventCount: s.seq,
          sizeBytes: 0,
        });
      }
    }
    return selectSessions([...rows.values()], id, includeChildren);
  }

  async preview(sessionId: string, includeChildren = true): Promise<DeletePreview> {
    let rows = await this.snapshots(sessionId, includeChildren);
    for (const row of rows) {
      const live = this.ctx.sessions.get(row.header.id);
      if (live) {
        await this.ctx.sessions.flush(live);
      }
    }
    rows = await this.snapshots(sessionId, includeChildren);
    return this.createPreview(
      'session',
      sessionId,
      includeChildren,
      rows.map((row) => row.header.id),
      rows,
    );
  }

  async previewResidue(): Promise<DeletePreview> {
    this.checkBackend();
    const persisted = new Set(
      (await this.ctx.sessionPersistence.list()).map((row) => row.header.id),
    );
    const ids: string[] = [];
    for (const id of await metadataSessionIds(this.ctx)) {
      validId(id);
      if (
        !persisted.has(id) &&
        !this.ctx.sessions.get(id) &&
        !this.ctx.agents.get(id) &&
        !(await hasSessionDirectory(this.ctx.sessionPersistence.root, id))
      ) {
        ids.push(id);
      }
    }
    return this.createPreview('residue', 'cleanup-residue', false, ids, []);
  }

  private async createPreview(
    mode: 'session' | 'residue',
    sessionId: string,
    includeChildren: boolean,
    ids: string[],
    rows: SessionSnapshot[],
  ): Promise<DeletePreview> {
    const busy: string[] = [];
    for (const id of ids) {
      const activity = await this.ctx.waterfall(
        'workspace/session-activity',
        { sessionId: id },
        () => Promise.resolve([]),
      );
      const blocking =
        mode === 'residue'
          ? activity.some((item) => !jsonObject(item) || item.kind !== 'schedule')
          : activity.length > 0;
      if (blocking || this.ctx.agents.get(id)?.status === 'running') {
        busy.push(id);
      }
    }
    const inspection = await inspectCleanup(this.ctx, ids, mode);
    const token = randomUUID();
    const now = Date.now();
    for (const [key, plan] of this.tokens) {
      if (plan.expires < now) {
        this.tokens.delete(key);
      }
    }
    if (this.tokens.size >= 64) {
      const oldest = this.tokens.keys().next().value;
      if (oldest !== undefined) {
        this.tokens.delete(oldest);
      }
    }
    this.tokens.set(token, {
      mode,
      ids,
      sessionId,
      includeChildren,
      fingerprint: fingerprint(rows),
      cleanupSignature: inspection.signature,
      expires: now + 300000,
    });
    const archivedIds = ids.filter((id) =>
      this.ctx.workspaceRegistry.archivedSessionIds.includes(id),
    );
    const header = rows.find((row) => row.header.id === sessionId)?.header;
    return {
      token,
      mode,
      confirmation: sessionId,
      manifest: inspection.manifest,
      sessionId,
      archived: archivedIds.includes(sessionId),
      archivedIds,
      count: ids.length,
      bytes: inspection.manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      ids,
      busy,
      title: header
        ? (this.ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])?.values?.title
            ?.title ?? sessionId)
        : sessionId,
    };
  }

  private async assertResidueStillAbsent(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (
        this.ctx.sessions.get(id) ||
        this.ctx.agents.get(id) ||
        (await hasSessionDirectory(this.ctx.sessionPersistence.root, id)) ||
        (await this.ctx.sessionPersistence.findLog(id))
      ) {
        refuse('changed', '残留对应的会话已存在，已停止清理，请重新检查。');
      }
    }
  }

  commit(token: string, confirmation: string): Promise<DeleteResult> {
    const run = this.tail.then(() => this.remove(token, confirmation));
    this.tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private async remove(token: string, confirmation: string): Promise<DeleteResult> {
    const plan = this.tokens.get(token);
    this.tokens.delete(token);
    if (!plan || plan.expires < Date.now()) {
      refuse('expired', '删除预览已过期，请重新打开删除对话框。');
    }
    if (confirmation !== plan.sessionId) {
      refuse('confirmation', '确认的会话 ID 不匹配。');
    }
    if (!plan.ids.length) {
      refuse('empty-plan', '没有可清理的数据。');
    }
    if (plan.mode === 'residue') {
      await this.assertResidueStillAbsent(plan.ids);
    }
    const rows =
      plan.mode === 'session' ? await this.snapshots(plan.sessionId, plan.includeChildren) : [];
    if (fingerprint(rows) !== plan.fingerprint) {
      refuse('changed', '预览后会话发生变化，请重新预览。');
    }
    if (plan.mode === 'residue') {
      for (const id of plan.ids) {
        const activity = await this.ctx.waterfall(
          'workspace/session-activity',
          { sessionId: id },
          () => Promise.resolve([]),
        );
        if (activity.some((item) => !jsonObject(item) || item.kind !== 'schedule')) {
          refuse('busy', '残留关联的工作仍在运行，请先停止后再清理。');
        }
      }
    }
    for (const row of rows) {
      const id = row.header.id;
      if (
        (
          await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () =>
            Promise.resolve([]),
          )
        ).length ||
        this.ctx.agents.get(id)?.status === 'running'
      ) {
        refuse('busy', '会话或其派生会话仍在运行。请先停止任务，再删除。');
      }
      const agent = this.ctx.agents.get(id);
      if (agent) {
        lifecycleDisposer(agent);
      }
    }
    const persistence = this.checkBackend();
    const workspaces = this.ctx.workspaceRegistry;
    const ids = plan.ids;
    let inspection = await inspectCleanup(this.ctx, ids, plan.mode);
    if (inspection.signature !== plan.cleanupSignature) {
      refuse('changed', '预览后的清理路径或关联记录发生变化，请重新检查。');
    }
    const idSet = new Set(ids);
    // A crash leaves a private recovery journal and staged logs; never auto-purge them.
    const transaction = randomUUID();
    const stageBase = join(dirname(persistence.root), '.session-delete-staging');
    await mkdir(stageBase, { recursive: true, mode: 0o700 });
    if (
      (await lstat(stageBase)).isSymbolicLink() ||
      !samePath(await realpath(stageBase), resolve(stageBase))
    ) {
      refuse('unsafe-path', '暂存目录不是可信的本地目录。');
    }
    const stage = join(stageBase, transaction);
    const previous = {
      archived: [...workspaces.archivedSessionIds],
      pinned: [...workspaces.pinnedSessionIds],
      memberships: workspaces
        .list()
        .map((item) => ({ id: item.id, sessionIds: [...item.sessionIds] })),
    };
    const moved: MovedSession[] = [];
    const handles: WriteHandle[] = [];
    let committed = false;
    let leasesClosed = true;
    await mkdir(stage, { mode: 0o700 });
    const journal: DeletionJournal = {
      version: 1,
      status: 'preparing',
      sessionIds: ids,
      previous,
      moved,
    };
    let storage = new StorageTransaction(this.ctx, inspection.storage, journal, stage, transaction);
    for (const id of ids) {
      this.deleting.add(id);
    }
    try {
      await durableJson(join(stage, 'journal.json'), journal);
      // Archive through the host first: its own gates fence prompts and scheduled wakeups.
      if (plan.mode === 'session') {
        for (const id of ids) {
          await workspaces.archiveSession(id);
        }
      }
      if (
        plan.mode === 'session' &&
        fingerprint(await this.snapshots(plan.sessionId, plan.includeChildren)) !== plan.fingerprint
      ) {
        refuse('changed', '归档期间会话发生变化，请重新预览。');
      }
      for (const id of ids) {
        const agent = this.ctx.agents.get(id);
        if (agent) {
          if (agent.status !== 'idle') {
            refuse('busy', '会话无法安全释放，请停止任务或重启后重试。');
          }
          await this.ctx.sessions.flush(agent.session);
          await lifecycleDisposer(agent)();
        }
        if (this.ctx.sessions.get(id) || this.ctx.agents.get(id)) {
          refuse('live-session', '会话仍被其他组件持有，已拒绝删除。');
        }
      }
      // Reserve every writer (including the kernel lease) before moving any logs.
      if (plan.mode === 'session') {
        for (const id of ids) {
          handles.push(await persistence.open(id, 'write'));
        }
      }
      inspection = await inspectCleanup(this.ctx, ids, plan.mode);
      if (inspection.signature !== plan.cleanupSignature) {
        refuse('changed', '清理路径发生变化，请重新预览。');
      }
      storage = new StorageTransaction(this.ctx, inspection.storage, journal, stage, transaction);
      for (const [index, directory] of inspection.logDirectories.entries()) {
        await checkedPath(persistence.root, directory.path);
        const entry = {
          id: directory.id,
          original: directory.path,
          staged: join(stage, String(index)),
        };
        journal.moved.push(entry);
        await durableJson(join(stage, 'journal.json'), journal);
        await movePath(entry.original, entry.staged);
      }
      await storage.apply();
      if (plan.mode === 'residue') {
        await this.assertResidueStillAbsent(ids);
      }
      await workspaces.enqueueOperation(async () => {
        const state = workspaces.requireState();
        await workspaces.setState({
          ...state,
          archivedSessionIds: state.archivedSessionIds.filter((id) => !idSet.has(id)),
          pinnedSessionIds: state.pinnedSessionIds.filter((id) => !idSet.has(id)),
        });
        for (const id of ids) {
          workspaces.headers.delete(id);
          workspaces.sessionPaths.delete(id);
          workspaces.missingSessionPaths.delete(id);
          workspaces.invalidSessionPaths.delete(id);
          persistence.coldLogMemo.delete(id);
        }
      });
      journal.status = 'committed';
      await durableJson(join(stage, 'journal.json'), journal);
      committed = true;
    } catch (error) {
      if (!committed) {
        const recovery = [];
        for (const entry of [...moved].reverse()) {
          if (entry.backupOnly) {
            continue;
          }
          try {
            await lstat(entry.staged);
            if (await fileExists(entry.original)) {
              throw new Error(`恢复目标已被其他写入占用：${entry.original}`, { cause: error });
            }
            await movePath(entry.staged, entry.original);
          } catch (e) {
            if (errorCode(e) !== 'ENOENT') {
              recovery.push(String(e));
            }
          }
        }
        recovery.push(...(await storage.restoreRecords()));
        try {
          await workspaces.enqueueOperation(async () => {
            const state = workspaces.requireState();
            await workspaces.setState({
              ...state,
              archivedSessionIds: restoreSelected(
                state.archivedSessionIds,
                previous.archived,
                idSet,
              ),
              pinnedSessionIds: restoreSelected(state.pinnedSessionIds, previous.pinned, idSet),
            });
          });
        } catch (restoreError) {
          recovery.push(String(restoreError));
        }
        journal.status = recovery.length ? 'recovery-required' : 'rolled-back';
        journal.error = String(error);
        journal.recovery = recovery;
        await durableJson(join(stage, 'journal.json'), journal).catch(() => {});
        if (recovery.length) {
          throw new DeleteError(
            'recovery-required',
            `删除未完成。请保留恢复目录 ${stage}。${String(error)}`,
          );
        }
      }
      throw error;
    } finally {
      const closed = await Promise.allSettled(handles.map((h) => h.close()));
      for (const id of ids) {
        this.deleting.delete(id);
      }
      if (closed.some((r) => r.status === 'rejected')) {
        leasesClosed = false;
        this.ctx.logger.warn('Session Delete: one or more write leases failed to close.');
      }
    }
    // The logical commit precedes physical purge; a purge failure remains visible.
    for (const id of ids) {
      this.ctx.emit('api-session/removed', id);
    }
    try {
      if (!leasesClosed) {
        refuse('lease-close-failed', '写锁未能完全释放，暂存文件已保留。');
      }
      await storage.purge();
      await purgePath(stage);
    } catch {
      return {
        deleted: ids,
        manifest: inspection.manifest,
        purged: false,
        recoveryPath: stage,
        message: '会话已移除，但暂存文件未清空；请按恢复目录提示处理。',
      };
    }
    return { deleted: ids, manifest: inspection.manifest, purged: true };
  }
}
