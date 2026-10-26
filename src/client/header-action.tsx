import type * as ReactApi from 'react';
import type { ClientRenderer, NativePrimitives, OverlayProps } from './contracts.js';

interface HeaderTarget {
  container: HTMLElement;
  buttonClass: string;
}

function hasNativeClass(element: Element, suffix: string): boolean {
  return [...element.classList].some((name) => name.endsWith(`_${suffix}`));
}

function findHeaderTarget(): HeaderTarget | null {
  // Harness 0.2.1-rc.2 / rc.3 has no header-action slot. Match its native workspace
  // structure without localized text or a generated CSS hash, and reuse its class.
  for (const header of document.querySelectorAll<HTMLElement>('[class*="_sectionHeader"]')) {
    if (![...header.children].some((child) => hasNativeClass(child, 'sectionLabel'))) {
      continue; // A collapsed sidebar has no workspace title row.
    }
    const container = [...header.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && hasNativeClass(child, 'headerActions'),
    );
    if (!container || hasNativeClass(container, 'headerActionsHidden')) {
      continue;
    }
    for (const button of container.querySelectorAll('button')) {
      if (button.hasAttribute('data-session-delete-cleanup')) {
        continue;
      }
      const buttonClass = [...button.classList].find((name) => name.endsWith('_iconButton'));
      if (buttonClass) {
        // The native action strip is capped at two buttons. Append to its
        // title row so the host layout allocates space without CSS overrides.
        return { container: header, buttonClass };
      }
    }
  }
  return null;
}

export function createHeaderAction(
  React: typeof ReactApi,
  { Tooltip, IconTrashOutlineRegular }: NativePrimitives,
  renderer: ClientRenderer,
  open: () => void,
): ReactApi.ComponentType<OverlayProps> {
  return function HeaderAction({ t }) {
    const [target, setTarget] = React.useState<HeaderTarget | null>(null);
    React.useEffect(() => {
      let frame: number | undefined;
      const update = () => {
        frame = undefined;
        const next = findHeaderTarget();
        setTarget((current) =>
          current?.container === next?.container && current?.buttonClass === next?.buttonClass
            ? current
            : next,
        );
      };
      const observer = new MutationObserver(() => {
        frame ??= window.requestAnimationFrame(update);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      update();
      return () => {
        observer.disconnect();
        if (frame !== undefined) {
          window.cancelAnimationFrame(frame);
        }
      };
    }, []);

    if (!target) {
      return null;
    }
    return renderer.createPortal(
      <Tooltip label={t('orphanAction')} side="bottom" delayMs={500}>
        <button
          type="button"
          className={target.buttonClass}
          aria-label={t('orphanAction')}
          data-session-delete-cleanup=""
          onClick={open}
        >
          <IconTrashOutlineRegular size={16} />
        </button>
      </Tooltip>,
      target.container,
    );
  };
}
