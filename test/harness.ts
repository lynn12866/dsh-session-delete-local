import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { SessionDeletion } from '#core';
import type { HostContext, StorageBackend, StorageDomain } from '../src/host/contracts.ts';
import type { TestContext } from './runtime.ts';
if (!process.env.DSH_RUNTIME) {
  throw new Error(
    'Set DSH_RUNTIME to the 0.2.1-rc.2 runtime directory containing package.json and node_modules.',
  );
}
const runtimeRequire = createRequire(join(resolve(process.env.DSH_RUNTIME), 'package.json'));
const profileRequire = process.env.DSH_TEST_PROFILE
  ? createRequire(join(resolve(process.env.DSH_TEST_PROFILE), 'package.json'))
  : undefined;
const hostEntry = new URL('../dist/host/index.js', import.meta.url).href;
const hostImports = new Map([
  ['@deepseek-ai/dsh-typert-protocol', runtimeRequire.resolve('@deepseek-ai/dsh-typert-protocol')],
  ['zod/v4', (profileRequire ?? runtimeRequire).resolve('zod/v4')],
]);
// Exercise the actual Host module, including resolution in profiles containing
// Zod 3, rather than testing the storage implementation alone.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === hostEntry && hostImports.has(specifier)) {
      return nextResolve(pathToFileURL(hostImports.get(specifier)!).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const load = <Module = Record<string, unknown>>(name: string): Promise<Module> =>
  import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/' + name)).href) as Promise<Module>;
const { Context } = await load<{ Context: new () => TestContext }>('cordis');
const { default: SessionStore } = await load('dsh-session');
const { default: Storage } = await load('dsh-storage');
const JsonStorage = await load<{
  JsonStorageBackend: new (root: string) => StorageBackend & { close(): Promise<void> };
}>('dsh-storage-json');
const Domain = await load('dsh-storage-domain');
const Jsonl = await load('dsh-session-persistence-jsonl');
const { default: Projection } = await load('dsh-session-projection');
const { default: Cache } = await load('dsh-session-projection-cache');
const { default: Workspace } = await load('dsh-workspace');
const { default: Agents } = await load('dsh-agent');
const { default: AgentLoop } = await load('dsh-agent-loop');
const { default: Llm } = await load('dsh-llm');
const { default: Tools } = await load('dsh-tools');
const { default: SystemPrompt } = await load('dsh-system-prompt');
const { default: Typert } = await load('dsh-typert-registry');
const hostModule = new URL('../dist/index.js', import.meta.url).href;
const { default: SessionDeleteService } = (await import(hostModule)) as {
  default: new (ctx: HostContext) => unknown;
};

const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-delete-integration-')));
const cwd = join(base, 'project');
await mkdir(cwd);
await writeFile(join(cwd, 'keep.txt'), 'KEEP');
const ctx = new Context();
const mount = async (plugin: unknown, config?: unknown) => {
  const fiber = ctx.plugin(plugin, config);
  await fiber.await();
  return fiber;
};
await mount(SessionStore);
await mount(Storage);
await mount(JsonStorage, { root: join(base, 'storages') });
const metadataRoot = join(base, 'separate-sidecars');
const sidecars = new JsonStorage.JsonStorageBackend(metadataRoot);
const unregister = ctx.storage.backend.register('sidecars', sidecars);
ctx.provide('storage.backend.sidecars', sidecars);
ctx.effect(
  () => async () => {
    unregister();
    await sidecars.close();
  },
  'test sidecars',
);
await mount(Domain, {
  backend: 'json',
  routes: { session_projcache: 'sidecars', message_feedback: 'sidecars', schedule: 'sidecars' },
});
await mount(Jsonl, {
  root: join(base, 'sessions'),
  compression: process.env.TEST_COMPRESSION ?? 'none',
  listConcurrency: 3,
});
await mount(Projection);
await mount(Cache, { writeEveryEvents: 1, writeIntervalMs: 100 });
await mount(Workspace);
await mount(Agents);
await mount(Llm);
await mount(SystemPrompt, {});
await mount(Tools, {});
await mount(AgentLoop, { agents: [], maxParallelToolCalls: 10 });
await mount(Typert);
await mount(SessionDeleteService);
assert.ok(ctx.typert.local.get('sessionDelete/preview'));
assert.ok(ctx.typert.local.get('sessionDelete/commit'));
const headers = [
  { id: 'delete-root' },
  { id: 'delete-child', parentSession: 'delete-root', origin: 'subagent' },
  { id: 'keep' },
];
for (const item of headers) {
  const handle = await ctx.sessionPersistence.create({
    version: 4,
    createdAt: Date.now(),
    isSeeded: false,
    cwd,
    ...item,
  });
  await handle.flush();
  await handle.close();
}
const workspace = await ctx.workspaceRegistry.create(cwd, 'test');
for (const item of headers) {
  await workspace.attachSession(item.id);
}
await ctx.workspaceRegistry.pinSession('delete-root');
const logic = new SessionDeletion(ctx);
const preview = await logic.preview('delete-root');
assert.equal(preview.count, 2);
const result = await logic.commit(preview.token, 'delete-root');
assert.equal(result.purged, true);
assert.equal(await ctx.sessionPersistence.stat('delete-root'), undefined);
assert.equal(await ctx.sessionPersistence.stat('delete-child'), undefined);
assert.ok(await ctx.sessionPersistence.stat('keep'));
assert.deepEqual(workspace.sessionIds, ['keep']);
assert.deepEqual([...ctx.workspaceRegistry.archivedSessionIds], []);
assert.deepEqual([...ctx.workspaceRegistry.pinnedSessionIds], []);
assert.equal(await readFile(join(cwd, 'keep.txt'), 'utf8'), 'KEEP');
await assert.rejects(() => logic.commit(preview.token, 'delete-root'), { code: 'expired' });
await ctx.agentLoop.create('live-fixture', {}, { cwd });
await workspace.attachSession('live-fixture');
const livePlan = await logic.preview('live-fixture');
const liveResult = await logic.commit(livePlan.token, 'live-fixture');
assert.equal(liveResult.purged, true);
assert.equal(ctx.agents.get('live-fixture'), undefined);
assert.equal(ctx.sessions.get('live-fixture'), undefined);
assert.equal(await ctx.sessionPersistence.stat('live-fixture'), undefined);
assert.deepEqual(workspace.sessionIds, ['keep']);
// A rejected index write must restore the logs and workspace visibility.
const handle = await ctx.sessionPersistence.create({
  version: 4,
  id: 'rollback-fixture',
  createdAt: Date.now(),
  isSeeded: false,
  cwd,
});
await handle.flush();
await handle.close();
await workspace.attachSession('rollback-fixture');
await ctx.workspaceRegistry.pinSession('rollback-fixture');
const cacheTable = ctx.sessionProjectionCache.table;
const originalDelete = cacheTable.delete;
async function seedCache(id: string): Promise<void> {
  const header = (await ctx.sessionPersistence.list()).find((row) => row.header.id === id)!.header;
  await ctx.storageDomain
    .get('session_projcache')!
    .table('sessions')
    .put(id, {
      identity: {
        formatVersion: 4,
        createdAt: header.createdAt,
        cwd,
        isSeeded: false,
        inheritedEventCount: 0,
      },
      rows: {},
    });
}
await seedCache('rollback-fixture');
const rollbackPlan = await logic.preview('rollback-fixture');
cacheTable.delete = async () => {
  throw new Error('injected disk write failure');
};
await assert.rejects(
  () => logic.commit(rollbackPlan.token, 'rollback-fixture'),
  /injected disk write failure/,
);
cacheTable.delete = originalDelete;
assert.ok(await ctx.sessionPersistence.stat('rollback-fixture'));
assert.ok(workspace.sessionIds.includes('rollback-fixture'));
assert.ok(ctx.workspaceRegistry.pinnedSessionIds.includes('rollback-fixture'));
assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes('rollback-fixture'));
// Archived sessions must be deletable without unarchiving them first. Include
// archived and visible descendants, while retaining unrelated archived rows.
for (const item of [
  { id: 'archive-root' },
  { id: 'archive-child', parentSession: 'archive-root', origin: 'subagent' },
  { id: 'visible-child', parentSession: 'archive-root' },
  { id: 'archive-keep' },
  { id: 'archive-rollback' },
]) {
  const log = await ctx.sessionPersistence.create({
    version: 4,
    createdAt: Date.now(),
    isSeeded: false,
    cwd,
    ...item,
  });
  await log.flush();
  await log.close();
  await workspace.attachSession(item.id);
}
for (const id of ['archive-root', 'archive-child', 'archive-keep', 'archive-rollback']) {
  await ctx.workspaceRegistry.archiveSession(id);
}
const archivedPlan = await logic.preview('archive-root');
assert.equal(archivedPlan.archived, true);
assert.equal(archivedPlan.count, 3);
assert.deepEqual(archivedPlan.archivedIds, ['archive-child', 'archive-root']);
const archivedResult = await logic.commit(archivedPlan.token, 'archive-root');
assert.equal(archivedResult.purged, true);
for (const id of ['archive-root', 'archive-child', 'visible-child']) {
  assert.equal(await ctx.sessionPersistence.stat(id), undefined);
  assert.ok(!workspace.sessionIds.includes(id));
  assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(id));
}
assert.ok(await ctx.sessionPersistence.stat('archive-keep'));
assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes('archive-keep'));
await seedCache('archive-rollback');
const archivedRollbackPlan = await logic.preview('archive-rollback');
cacheTable.delete = async () => {
  throw new Error('archived rollback fixture');
};
await assert.rejects(
  () => logic.commit(archivedRollbackPlan.token, 'archive-rollback'),
  /archived rollback fixture/,
);
cacheTable.delete = originalDelete;
assert.ok(await ctx.sessionPersistence.stat('archive-rollback'));
assert.ok(workspace.sessionIds.includes('archive-rollback'));
assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes('archive-rollback'));
assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes('archive-keep'));
// Another writer must prevent removal, with archive visibility rolled back.
const locked = await ctx.sessionPersistence.open('keep', 'write');
const lockedPlan = await logic.preview('keep');
await assert.rejects(() => logic.commit(lockedPlan.token, 'keep'));
assert.ok(await ctx.sessionPersistence.stat('keep'));
assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes('keep'));
await locked.close();
// Metadata cleanup must use the routed backend and preserve unrelated rows.
const metadataId = 'metadata-fixture';
const metadataLog = await ctx.sessionPersistence.create({
  version: 4,
  id: metadataId,
  createdAt: Date.now(),
  isSeeded: false,
  cwd,
});
await metadataLog.flush();
await metadataLog.close();
await workspace.attachSession(metadataId);
await seedCache(metadataId);
const projectionDomain = ctx.storageDomain.get('session_projcache')!;
const cacheRecord = projectionDomain.table('sessions').get(metadataId);
const backupFile = join(
  metadataRoot,
  'session_projcache',
  'sessions',
  `${metadataId}.json.bak.202610201100`,
);
await writeFile(backupFile, 'owned backup bytes');
const legacyCache = join(metadataRoot, 'session_projcache.json');
const legacyFeedback = join(metadataRoot, 'message_feedback.json');
const legacy = (name: string) =>
  JSON.stringify({
    unit: { name, version: name === 'session_projcache' ? 7 : 1 },
    global: null,
    tables: { sessions: { [metadataId]: cacheRecord, keep: cacheRecord } },
    extraField: 'KEEP UNKNOWN FIELDS',
  });
await writeFile(legacyCache, legacy('session_projcache'));
await writeFile(legacyFeedback, legacy('message_feedback'));
const staleMetadataPlan = await logic.preview(metadataId);
const laterBackup = join(
  metadataRoot,
  'session_projcache',
  'sessions',
  `${metadataId}.json.bak.202610201102`,
);
await writeFile(laterBackup, 'new backup requires renewed approval');
await assert.rejects(() => logic.commit(staleMetadataPlan.token, metadataId), { code: 'changed' });
assert.ok(await ctx.sessionPersistence.stat(metadataId));
const metadataPlan = await logic.preview(metadataId);
assert.ok(
  metadataPlan.manifest.entries.some(
    (entry) => entry.path === backupFile && entry.action === 'delete-file',
  ),
);
assert.ok(
  metadataPlan.manifest.entries.some(
    (entry) => entry.path === legacyCache && entry.action === 'update-record',
  ),
);
assert.ok(
  metadataPlan.manifest.entries.some(
    (entry) =>
      entry.path === join(base, 'storages', 'workspace.json') && entry.action === 'update-record',
  ),
);
assert.ok(metadataPlan.manifest.retained.some((entry) => entry.path === cwd));
const metadataResult = await logic.commit(metadataPlan.token, metadataId);
assert.equal(metadataResult.purged, true);
await assert.rejects(() => lstat(backupFile), { code: 'ENOENT' });
assert.equal(projectionDomain.table('sessions').get(metadataId), undefined);
for (const file of [legacyCache, legacyFeedback]) {
  const document = JSON.parse(await readFile(file, 'utf8')) as {
    tables: { sessions: Record<string, unknown> };
    extraField: string;
  };
  assert.equal(document.tables.sessions[metadataId], undefined);
  assert.ok(document.tables.sessions.keep);
  assert.equal(document.extraField, 'KEEP UNKNOWN FIELDS');
}
// A new file after preview cannot be silently added to the approved removal scope.
const changedPlan = await logic.preview('keep');
const keptLog = await ctx.sessionPersistence.findLog('keep');
const extraPath = join(dirname(keptLog!.currentPath), 'late-file.txt');
await writeFile(extraPath, 'KEEP');
await assert.rejects(() => logic.commit(changedPlan.token, 'keep'), { code: 'changed' });
assert.equal(await readFile(extraPath, 'utf8'), 'KEEP');

// A header omitted by list() must never turn its cache into a deletion candidate.
const corruptId = 'corrupt-retained';
await projectionDomain.table('sessions').put(corruptId, cacheRecord);
const corruptDir = join(base, 'sessions', '--retained-project--', corruptId);
await mkdir(corruptDir, { recursive: true });
await writeFile(
  join(
    corruptDir,
    process.env.TEST_COMPRESSION === 'zstd' ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl',
  ),
  'unsupported header',
);

const orphanId = 'orphan-fixture';
await projectionDomain.table('sessions').put(orphanId, cacheRecord);
const orphanBackup = join(
  metadataRoot,
  'session_projcache',
  'sessions',
  `${orphanId}.json.bak.202610201101`,
);
await writeFile(orphanBackup, 'private orphan backup');
const workspaceTable = ctx.storageDomain.get('workspace')!.table('workspaces');
const workspaceValue = workspaceTable.get(workspace.id);
assert.ok(
  workspaceValue &&
    typeof workspaceValue === 'object' &&
    'sessionIds' in workspaceValue &&
    Array.isArray(workspaceValue.sessionIds),
);
const originalWorkspaceSessionIds = workspaceValue.sessionIds;
workspace.record = await workspaceTable.update(workspace.id, () => ({
  ...workspaceValue,
  sessionIds: [...originalWorkspaceSessionIds, orphanId],
}));

const scheduleModule = await load<{
  scheduleDomain: unknown;
  createAtScheduleRecord(
    id: string,
    prompt: string,
    at: string,
    now: number,
    title: string,
  ): unknown;
}>('dsh-schedule');
const scheduleDomain: StorageDomain = await ctx.storageDomain.open(scheduleModule.scheduleDomain);
await scheduleDomain.table('tasks').put('orphan-reminder', {
  sessionId: orphanId,
  status: 'inactive',
  record: scheduleModule.createAtScheduleRecord(
    'orphan-reminder',
    'fixture prompt',
    new Date(Date.now() + 60000).toISOString(),
    Date.now(),
    'Fixture',
  ),
});
for (const file of [legacyCache, legacyFeedback]) {
  const document = JSON.parse(await readFile(file, 'utf8')) as {
    tables: { sessions: Record<string, unknown> };
  };
  document.tables.sessions[orphanId] = cacheRecord;
  await writeFile(file, JSON.stringify(document, null, 2) + '\n');
}
await projectionDomain.table('sessions').put('revived-fixture', cacheRecord);
const beforeRevival = await logic.previewResidue();
assert.ok(beforeRevival.ids.includes('revived-fixture'));
const revivedLog = await ctx.sessionPersistence.create({
  version: 4,
  id: 'revived-fixture',
  createdAt: Date.now(),
  isSeeded: false,
  cwd,
});
await revivedLog.flush();
await revivedLog.close();
await assert.rejects(() => logic.commit(beforeRevival.token, beforeRevival.confirmation), {
  code: 'changed',
});
assert.ok(projectionDomain.table('sessions').get(orphanId));
const residuePlan = await logic.previewResidue();
assert.ok(!residuePlan.ids.includes('revived-fixture'));
assert.ok(residuePlan.ids.includes(orphanId));
assert.ok(!residuePlan.ids.includes(corruptId));
assert.ok(!residuePlan.ids.includes('keep'));
assert.ok(
  residuePlan.manifest.entries.some(
    (entry) =>
      entry.category === 'schedule' && entry.recordKeys.includes('tables.tasks.orphan-reminder'),
  ),
);
const originalUpdate = workspaceTable.update;
workspaceTable.update = async () => {
  throw new Error('injected residue workspace failure');
};
await assert.rejects(
  () => logic.commit(residuePlan.token, residuePlan.confirmation),
  /injected residue workspace failure/,
);
workspaceTable.update = originalUpdate;
assert.ok(projectionDomain.table('sessions').get(orphanId));
assert.ok(scheduleDomain.table('tasks').get('orphan-reminder'));
assert.equal(await readFile(orphanBackup, 'utf8'), 'private orphan backup');
assert.ok(
  (
    JSON.parse(await readFile(legacyFeedback, 'utf8')) as {
      tables: { sessions: Record<string, unknown> };
    }
  ).tables.sessions[orphanId],
);
const residueRetry = await logic.previewResidue();
const residueResult = await logic.commit(residueRetry.token, residueRetry.confirmation);
assert.equal(residueResult.purged, true);
assert.equal(projectionDomain.table('sessions').get(orphanId), undefined);
assert.equal(scheduleDomain.table('tasks').get('orphan-reminder'), undefined);
assert.ok(projectionDomain.table('sessions').get(corruptId));
assert.ok(!JSON.stringify(workspaceTable.get(workspace.id)).includes(orphanId));
assert.ok(await ctx.sessionPersistence.stat('keep'));
console.log(
  'PASS: routed sidecars, absolute manifests, backup removal, legacy row preservation, changed-scope refusal, orphan detection, corrupt-log retention, reminders, residue rollback',
);
console.log(
  'PASS: actual JSONL storage, archived + visible descendants, unrelated archived retention, archived rollback, live lifecycle, locks, pins, token replay, workspace files retained',
  base,
);
await ctx.fiber.dispose();
