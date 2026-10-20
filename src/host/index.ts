import {
  TypertRemoteService,
  Remote,
  createTypertRemoteInfo,
} from '@deepseek-ai/dsh-typert-protocol';
// Both Zod 3.25 and Zod 4 expose this path. Other plugins can shadow "zod".
import { z } from 'zod/v4';
import type { DeletePreview, DeleteResult, RpcResult } from '../shared/contracts.js';
import type { HostContext } from './contracts.js';
import { SessionDeletion } from './core.js';
import { errorCode, errorMessage } from '../shared/errors.js';

const packageName = 'dsh-session-delete-local';

function codec(name: string, schema: z.ZodType) {
  return {
    mode: 'strict' as const,
    typeSymbol: `${packageName}#${name}`,
    create: () => schema,
    jsonSchema: z.toJSONSchema(schema),
  };
}

function parameter(name: string, schema: z.ZodType) {
  return {
    name,
    wire: name,
    source: 'json' as const,
    codec: codec(name, schema),
    strictCodec: codec(name, schema),
  };
}

const definitions = {
  preview: [
    parameter('sessionId', z.string().min(1).max(512)),
    parameter('includeChildren', z.boolean()),
  ],
  previewResidue: [],
  commit: [
    parameter('token', z.string().uuid()),
    parameter('confirmation', z.string().min(1).max(512)),
  ],
};

const info = createTypertRemoteInfo(
  {
    package: packageName,
    methods: Object.fromEntries(
      Object.entries(definitions).map(([method, parameters]) => [
        `sessionDelete/${method}`,
        {
          service: 'sessionDelete',
          invocation: { kind: 'direct' },
          parameters,
          result: codec('result', z.json()),
        },
      ]),
    ),
  },
  z,
);
const initializers: ((this: unknown) => void)[] = [];

export default class SessionDeleteService extends TypertRemoteService {
  static readonly inject = [
    'typert',
    'storage',
    'storageDomain',
    'sessionPersistence',
    'workspaceRegistry',
    'sessionProjectionCache',
    'sessions',
    'agents',
  ];

  private readonly logic: SessionDeletion;

  constructor(ctx: HostContext) {
    super(ctx, 'sessionDelete');
    for (const initialize of initializers) {
      initialize.call(this);
    }
    this.logic = new SessionDeletion(ctx);
    this.logic.checkBackend();
    ctx.typert.register({
      package: packageName,
      face: 'host',
      schemas: [],
      model: {},
      invocations: info.descriptors,
    });
    ctx.effect(() => () => this.logic.finishPending(), 'session-delete: finish pending operation');
  }

  private async call<T>(operation: () => Promise<T>): Promise<RpcResult<T>> {
    const principal = this.ctx.invocation?.peer?.principal?.kind;
    if (principal && principal !== 'owner') {
      return {
        ok: false,
        error: { code: 'owner-only', message: '只有工作区所有者可以删除会话。' },
      };
    }
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: errorCode(error) ?? 'delete-failed',
          message: errorMessage(error),
        },
      };
    }
  }

  preview(sessionId: string, includeChildren: boolean): Promise<RpcResult<DeletePreview>> {
    return this.call(() => this.logic.preview(sessionId, includeChildren));
  }

  previewResidue(): Promise<RpcResult<DeletePreview>> {
    return this.call(() => this.logic.previewResidue());
  }

  commit(token: string, confirmation: string): Promise<RpcResult<DeleteResult>> {
    return this.call(() => this.logic.commit(token, confirmation));
  }
}

// Use the host decorator API without bundling or replacing its implementation.
for (const name of Object.keys(definitions) as (keyof typeof definitions)[]) {
  Remote(SessionDeleteService.prototype[name], {
    kind: 'method',
    name,
    static: false,
    private: false,
    addInitializer: (initialize) => initializers.push(initialize),
  });
}
