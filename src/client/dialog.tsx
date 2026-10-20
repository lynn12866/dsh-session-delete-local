import type * as ReactApi from 'react';
import type { DeletePreview, DeleteResult } from '../shared/contracts.js';
import { errorMessage } from '../shared/errors.js';
import type { ClientContext, DialogProps, NativePrimitives, Selection } from './contracts.js';
import { createManifestView } from './manifest.js';
import type { DeleteCall } from './rpc.js';

// Reuse the pinned host's confirmation sizing and scrolling classes. These are
// native styles; no plugin CSS or warning-column layout is introduced.
const nativeLayout = {
  className: '_confirmation_cjd8z_1',
  contentClassName: '_confirmationContent_cjd8z_7',
};

export function createDialog(
  React: typeof ReactApi,
  primitives: NativePrimitives,
  ctx: ClientContext,
  call: DeleteCall,
  publish: (selection: Selection | null) => void,
): ReactApi.ComponentType<DialogProps> {
  const { Modal, Button, Checkbox } = primitives;
  const ManifestView = createManifestView(React, primitives);
  return function Dialog({ selected, t }) {
    const [includeChildren, setIncludeChildren] = React.useState(true);
    const [preview, setPreview] = React.useState<DeletePreview | null>(null);
    const [error, setError] = React.useState('');
    const [acknowledged, setAcknowledged] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [completed, setCompleted] = React.useState<DeleteResult | null>(null);
    const [revision, setRevision] = React.useState(0);
    const busyRef = React.useRef(false);
    const residue = selected.mode === 'residue';

    function close(): void {
      if (!busyRef.current) {
        publish(null);
      }
    }

    React.useEffect(() => {
      let current = true;
      setPreview(null);
      setError('');
      setAcknowledged(false);
      const pending = residue
        ? call('previewResidue', {})
        : call('preview', { sessionId: selected.sessionId, includeChildren });
      void pending.then(
        (value) => {
          if (current) {
            setPreview(value);
          }
        },
        (reason: unknown) => {
          if (current) {
            setError(errorMessage(reason));
          }
        },
      );
      return () => {
        current = false;
      };
    }, [selected.sessionId, includeChildren, revision, residue]);

    async function remove(): Promise<void> {
      if (!preview || !acknowledged || busyRef.current) {
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setError('');
      try {
        const result = await call('commit', {
          token: preview.token,
          confirmation: preview.confirmation,
        });
        setCompleted(result);
        const currentId = ctx.uiWorkspace.mainReference?.sessionId;
        if (currentId && result.deleted.includes(currentId)) {
          ctx.uiWorkspace.clearMain();
        }
        if (!result.purged) {
          setError(t('partial') + result.recoveryPath);
        }
        await ctx.sessions.refresh();
      } catch (reason) {
        setError(errorMessage(reason));
        setPreview(null);
        setAcknowledged(false);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    }

    const summary = preview
      ? t(residue ? 'cleanupPreview' : 'preview', {
          count: preview.count,
          size: formatBytes(preview.bytes),
        })
      : t('loading');
    if (completed || preview?.count === 0) {
      return (
        <Modal
          {...nativeLayout}
          open
          title={t(completed ? (residue ? 'cleanupDone' : 'done') : 'cleanupTitle')}
          closeLabel={t('close')}
          onClose={close}
          footer={
            <Button variant="primary" onClick={close}>
              {t('close')}
            </Button>
          }
        >
          <p>
            {completed ? t('completedCount', { count: completed.deleted.length }) : t('noResidue')}
          </p>
          {error && <p role="alert">{error}</p>}
        </Modal>
      );
    }
    const archived = preview?.archived ?? selected.archived;
    const disabled = !preview || !preview.count || busy || preview.busy.length > 0;
    return (
      <Modal
        {...nativeLayout}
        open
        title={t(residue ? 'cleanupTitle' : archived ? 'titleArchived' : 'title')}
        closeLabel={t('close')}
        onClose={close}
        description={
          <>
            {!residue && (
              <>
                <strong>{selected.displayTitle || selected.sessionId}</strong>
                <br />
              </>
            )}
            {!error && summary}
            {preview?.archivedIds.length ? (
              <> {t('archivedCount', { count: preview.archivedIds.length })}</>
            ) : null}
          </>
        }
        footer={
          <>
            <Button variant="outline" className="_modalAction_cjd8z_67" onClick={close}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              className="_confirmAction_cjd8z_71"
              disabled={disabled || !acknowledged}
              onClick={() => void remove()}
            >
              {busy ? t('deleting') : t(residue ? 'cleanupAction' : 'delete')}
            </Button>
          </>
        }
      >
        {!residue && (
          <p>
            <Checkbox
              checked={includeChildren}
              disabled={busy}
              onChange={setIncludeChildren}
              label={t('children')}
            />
          </p>
        )}
        {preview && <ManifestView manifest={preview.manifest} t={t} />}
        {preview && preview.busy.length > 0 && <p role="alert">{t('busy')}</p>}
        {error && (
          <>
            <p role="alert">{error}</p>
            <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
              {t('retry')}
            </Button>
          </>
        )}
        <p>
          <Checkbox
            checked={acknowledged}
            disabled={disabled}
            onChange={setAcknowledged}
            label={t('confirm')}
          />
        </p>
      </Modal>
    );
  };
}

function formatBytes(bytes: number): string {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
