/**
 * Narrow adapter contracts for Harness 0.2.1-rc.2 and rc.3. These internal members are
 * intentionally version-pinned; the runtime guard rejects other backends.
 */
export type Awaitable<T> = T | Promise<T>;
export type Disposer = () => Awaitable<void>;

export interface SessionHeader {
  id: string;
  parentSession?: string;
  [field: string]: unknown;
}

export interface SessionSnapshot {
  header: SessionHeader;
  revision: unknown;
  eventCount: number;
  sizeBytes?: number;
}

export interface LiveSession {
  id: string;
  seq: number;
  header: SessionHeader;
}

export type EffectDisposer = Disposer & {
  [key: symbol]: { label?: string } | undefined;
};

export interface AgentLifecycle {
  id: string;
  loopCtx?: { fiber?: { _disposables?: Iterable<EffectDisposer> } };
}

export interface Agent extends AgentLifecycle {
  status: string;
  session: LiveSession;
}

export interface WriteHandle {
  close(): Promise<void>;
}

export interface SessionPersistence {
  name: string;
  root: string;
  tracker: { writers: { has(id: string): boolean } };
  coldLogMemo: { delete(id: string): unknown };
  list(): Promise<SessionSnapshot[]>;
  open(id: string, mode: 'write'): Promise<WriteHandle>;
  findLog(id: string): Promise<{ currentPath: string; sourcePath?: string } | undefined>;
}

export interface Workspace {
  id: string;
  record?: unknown;
  sessionIds: string[];
  attachSession(id: string): Promise<unknown>;
  detachSession(id: string): Promise<unknown>;
}

export interface WorkspaceState {
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
  [field: string]: unknown;
}

export interface WorkspaceRegistry {
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
  headers: { delete(id: string): unknown };
  sessionPaths: { delete(id: string): unknown };
  missingSessionPaths: { delete(id: string): unknown };
  invalidSessionPaths: { delete(id: string): unknown };
  list(): Workspace[];
  get(id: string): Workspace | undefined;
  archiveSession(id: string): Promise<unknown>;
  unarchiveSession(id: string): Promise<unknown>;
  pinSession(id: string): Promise<unknown>;
  enqueueOperation<T>(operation: () => Promise<T>): Promise<T>;
  requireState(): WorkspaceState;
  setState(state: WorkspaceState): Promise<unknown>;
}

export interface HostContext {
  sessionPersistence: SessionPersistence;
  workspaceRegistry: WorkspaceRegistry;
  sessionProjectionCache: {
    table: { delete(id: string): Promise<unknown> };
    cachedSnapshot(
      header: SessionHeader,
      fields: string[],
    ): { values?: { title?: { title?: string } } } | undefined;
  };
  sessions: {
    list(): LiveSession[];
    get(id: string): LiveSession | undefined;
    flush(session: LiveSession): Promise<unknown>;
  };
  agents: { get(id: string): Agent | undefined };
  storage: { backend: { get(name: string): StorageBackend } };
  storageDomain: {
    config: { backend: string; routes?: Record<string, string> };
    get(name: string): StorageDomain | undefined;
  };
  get(name: 'schedule'): ScheduleService | undefined;
  get(name: 'attachments'): { root?: string; cacheRoot?: string } | undefined;
  typert: { register(metadata: unknown): unknown };
  invocation?: { peer?: { principal?: { kind?: string } } };
  logger: { warn(message: string): void };
  effect(setup: () => Disposer, label: string): unknown;
  emit(event: 'api-session/removed', id: string): unknown;
  waterfall(
    event: 'workspace/session-activity',
    payload: { sessionId: string },
    fallback: () => Promise<unknown[]>,
  ): Promise<unknown[]>;
}

export interface MovedSession {
  id: string;
  original: string;
  staged: string;
  backupOnly?: boolean;
}

export interface DeletionJournal {
  version: 1;
  status: 'preparing' | 'committed' | 'recovery-required' | 'rolled-back';
  sessionIds: string[];
  previous: {
    archived: string[];
    pinned: string[];
    memberships: { id: string; sessionIds: string[] }[];
  };
  moved: MovedSession[];
  storageBackups?: RecordBackup[];
  stageDirectories?: string[];
  error?: string;
  recovery?: string[];
}

export interface StorageTable {
  get(key: string): unknown;
  entries(): Iterable<[string, unknown]>;
  keys(): Iterable<string>;
  put(key: string, value: unknown): Promise<unknown>;
  update(key: string, update: (value: unknown) => unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface StorageUnit {
  path?: string;
  dir?: string;
  descriptor: { name: string; layout?: string; tables: string[] };
}

export interface StorageDomain {
  unit: StorageUnit;
  table(name: string): StorageTable;
}

export interface StorageBackend {
  root?: string;
}

export interface ScheduleService {
  delete(request: { sessionId: string; id: string }): Promise<{ deleted: boolean }>;
  serialize<T>(work: () => Promise<T>): Promise<T>;
  emitChanged(): void;
  runtime?: { requestDrive(): void };
}

export interface RecordBackup {
  domain: string;
  table: string;
  key: string;
  value: unknown;
  operation?: 'prune-membership';
}
