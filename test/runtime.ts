import type {
  Agent,
  HostContext,
  SessionHeader,
  SessionPersistence,
  Workspace,
  WorkspaceRegistry,
  WriteHandle,
  StorageBackend,
  StorageDomain,
} from '../src/host/contracts.ts';

/** Extra runtime APIs used only by the isolated Harness integration fixtures. */
interface FixtureWriteHandle extends WriteHandle {
  flush(): Promise<unknown>;
}

export interface TestContext extends HostContext {
  provide(name: string, value: unknown): unknown;
  storage: HostContext['storage'] & {
    backend: HostContext['storage']['backend'] & {
      register(name: string, backend: StorageBackend): () => void;
    };
  };
  storageDomain: HostContext['storageDomain'] & { open(spec: unknown): Promise<StorageDomain> };
  plugin(plugin: unknown, config?: unknown): { await(): Promise<unknown> };
  fiber: { dispose(): Promise<unknown> };
  sessionPersistence: SessionPersistence & {
    create(header: SessionHeader): Promise<FixtureWriteHandle>;
    stat(id: string): Promise<unknown>;
  };
  workspaceRegistry: WorkspaceRegistry & {
    create(cwd: string, title: string): Promise<Workspace>;
  };
  agentLoop: {
    create(id: string, config: object, options: { cwd: string }): Promise<Agent>;
  };
  typert: HostContext['typert'] & { local: { get(method: string): unknown } };
}
