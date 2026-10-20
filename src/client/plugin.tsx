import type * as ReactApi from 'react';
import type {
  ClientPlugin,
  ClientRenderer,
  MenuItemProps,
  NativePrimitives,
  OverlayProps,
  Selection,
} from './contracts.js';
import { createDialog } from './dialog.js';
import { createHeaderAction } from './header-action.js';
import { en, zh } from './locales.js';
import { createDeleteCall } from './rpc.js';

const namespace = 'session-delete-local';

export function createClientPlugin(
  React: typeof ReactApi,
  primitives: NativePrimitives,
  renderer: ClientRenderer,
): ClientPlugin {
  const { MenuItemButton, IconTrashOutlineRegular } = primitives;

  return {
    inject: ['slots', 'connection', 'locale', 'uiWorkspace', 'sessions', 'workspaces'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'session-delete: locale');
      let request: Selection | null = null;
      let active = true;
      const subscribers = new Set<() => void>();
      const subscribe = (listener: () => void): (() => void) => {
        subscribers.add(listener);
        return () => {
          subscribers.delete(listener);
        };
      };
      const publish = (value: Selection | null): void => {
        if (!active) {
          return;
        }
        request = value;
        for (const listener of subscribers) {
          listener();
        }
      };
      const subscribeWorkspaces = (listener: () => void) => ctx.workspaces.list.subscribe(listener);
      const workspaceSnapshot = () => ctx.workspaces.list.getSnapshot();

      ctx.effect(
        () => () => {
          active = false;
          subscribers.clear();
          request = null;
        },
        'session-delete: dialog',
      );

      const call = createDeleteCall(ctx);
      const Dialog = createDialog(React, primitives, ctx, call, publish);
      const HeaderAction = createHeaderAction(React, primitives, renderer, () =>
        publish({ mode: 'residue', sessionId: 'cleanup-residue', archived: false }),
      );

      function MenuItem({ sessionId, displayTitle, useMenuOpenState, t }: MenuItemProps) {
        const [, setMenuOpen] = useMenuOpenState();
        const archived = React.useSyncExternalStore(
          subscribeWorkspaces,
          workspaceSnapshot,
        ).archivedSessionIds.includes(sessionId);

        return (
          <MenuItemButton
            icon={<IconTrashOutlineRegular size={16} />}
            danger
            separatorBefore
            onSelect={() => {
              setMenuOpen(false);
              publish({ sessionId, displayTitle, archived });
            }}
          >
            {t(archived ? 'actionArchived' : 'action')}
          </MenuItemButton>
        );
      }

      function Overlay({ t }: OverlayProps) {
        const selected = React.useSyncExternalStore(subscribe, () => request);
        return (
          <>
            <HeaderAction t={t} />
            {selected && <Dialog key={selected.sessionId} selected={selected} t={t} />}
          </>
        );
      }

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-delete-local',
            order: 500,
            locale: namespace,
          },
          MenuItem,
        ),
      );
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'session-delete-local-dialog',
            order: 500,
            locale: namespace,
          },
          Overlay,
        ),
      );
    },
  };
}
