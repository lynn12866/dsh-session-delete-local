/** Runtime-only import supplied by Harness, never bundled into the plugin. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Ambient declarations need an inline type import.
  type HostContext = import('../host/contracts.js').HostContext;

  export class TypertRemoteService {
    protected readonly ctx: HostContext;
    constructor(ctx: HostContext, name: string);
  }

  export function createTypertRemoteInfo(
    metadata: unknown,
    schemaProvider: unknown,
  ): { descriptors: unknown };

  export function Remote<T extends (...args: never[]) => unknown>(
    method: T,
    context: {
      kind: 'method';
      name: string;
      static: false;
      private: false;
      addInitializer(initializer: (this: unknown) => void): void;
    },
  ): void;
}
