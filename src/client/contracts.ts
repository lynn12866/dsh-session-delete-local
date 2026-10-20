import type * as React from 'react';
import type { RpcResult } from '../shared/contracts.js';
import type { MessageKey, Messages } from './locales.js';

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export interface Selection {
  mode?: 'residue';
  sessionId: string;
  displayTitle?: string;
  archived: boolean;
}

export interface MenuItemProps {
  sessionId: string;
  displayTitle?: string;
  useMenuOpenState(): [boolean, React.Dispatch<React.SetStateAction<boolean>>];
  t: Translate;
}

export interface OverlayProps {
  t: Translate;
}

export interface DialogProps extends OverlayProps {
  selected: Selection;
}

export interface ClientRenderer {
  createPortal(children: React.ReactNode, container: Element): React.ReactPortal;
}

export interface NativePrimitives {
  Tooltip: React.ComponentType<{
    label: string;
    side: 'bottom';
    delayMs: number;
    children: React.ReactElement;
  }>;
  MenuItemButton: React.ComponentType<{
    icon: React.ReactNode;
    danger?: boolean;
    separatorBefore?: boolean;
    onSelect(): void;
    children: React.ReactNode;
  }>;
  Modal: React.ComponentType<{
    open: boolean;
    title: string;
    closeLabel: string;
    description?: React.ReactNode;
    className?: string;
    contentClassName?: string;
    footer?: React.ReactNode;
    children?: React.ReactNode;
    onClose(): void;
  }>;
  Button: React.ComponentType<{
    variant: 'outline' | 'primary' | 'ghost';
    className?: string;
    icon?: React.ReactNode;
    title?: string;
    'aria-label'?: string;
    'aria-expanded'?: boolean;
    disabled?: boolean;
    onClick(): void;
    children: React.ReactNode;
  }>;
  Checkbox: React.ComponentType<{
    checked: boolean;
    disabled?: boolean;
    label: string;
    onChange(checked: boolean): void;
  }>;
  DisclosureRow: React.ComponentType<{
    icon: React.ReactNode;
    title: string;
    open: boolean;
    expandable: boolean;
    expandOnRowClick: boolean;
    onToggle(): void;
    children: React.ReactNode;
  }>;
  IconTrashOutlineRegular: React.ComponentType<{ size: number }>;
  IconChevronDownOutlineRegular: React.ComponentType<{ size: number }>;
  IconChevronRightOutlineRegular: React.ComponentType<{ size: number }>;
}

export interface ClientContext {
  effect(setup: () => () => void, label: string): unknown;
  locale: {
    register(namespace: string, locales: { zh: Messages; en: Messages }): () => void;
  };
  slots: {
    inject(name: string, setup: () => unknown): unknown;
    register<Props>(
      options: { name: string; id: string; order: number; locale: string },
      component: React.ComponentType<Props>,
    ): unknown;
  };
  connection: {
    rpc: {
      call<T>(path: '/api', method: string, payload: { args: unknown }): Promise<RpcResult<T>>;
    };
  };
  uiWorkspace: {
    mainReference?: { sessionId?: string };
    clearMain(): void;
  };
  sessions: { refresh(): Promise<unknown> };
  workspaces: {
    list: {
      subscribe(listener: () => void): () => void;
      getSnapshot(): { archivedSessionIds: string[] };
    };
  };
}

export interface ClientPlugin {
  inject: string[];
  apply(ctx: ClientContext): void;
}

export interface ModuleRequire {
  (name: 'react'): typeof React;
  (name: 'react-dom'): ClientRenderer;
  (name: '@deepseek-ai/dsh-client-ui-primitives'): NativePrimitives;
}

declare global {
  interface Window {
    __ModuleLoader__: {
      load(definition: { id: string; factory(require: ModuleRequire): ClientPlugin }): void;
    };
  }
}
