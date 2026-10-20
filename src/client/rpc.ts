import type { DeleteMethods, RpcResult } from '../shared/contracts.js';
import type { ClientContext } from './contracts.js';

export type DeleteCall = <Method extends keyof DeleteMethods>(
  method: Method,
  args: DeleteMethods[Method]['args'],
) => Promise<DeleteMethods[Method]['result']>;

export function createDeleteCall(ctx: ClientContext): DeleteCall {
  return async (method, args) => {
    const transport = await ctx.connection.rpc.call<
      RpcResult<DeleteMethods[typeof method]['result']>
    >('/api', `sessionDelete/${method}`, { args });
    if (!transport.ok) {
      throw new Error(transport.error.message);
    }
    if (!transport.value.ok) {
      throw new Error(transport.value.error.message);
    }
    return transport.value.value;
  };
}
