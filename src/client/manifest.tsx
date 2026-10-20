import type * as ReactApi from 'react';
import type { CleanupManifest } from '../shared/contracts.js';
import type { NativePrimitives, Translate } from './contracts.js';

export function createManifestView(
  React: typeof ReactApi,
  { DisclosureRow, IconChevronRightOutlineRegular }: NativePrimitives,
) {
  function PathText({ value }: { value: string }) {
    const chunks = value.match(/[^/\\]{1,24}|[/\\]/gu) ?? [];
    return (
      <code>
        {chunks.map((chunk, index) => (
          <React.Fragment key={index}>
            {chunk}
            <wbr />
          </React.Fragment>
        ))}
      </code>
    );
  }

  return function ManifestView({ manifest, t }: { manifest: CleanupManifest; t: Translate }) {
    const [expanded, setExpanded] = React.useState(false);
    const deletions = manifest.entries.filter((entry) => entry.action !== 'update-record');
    return (
      <DisclosureRow
        icon={<IconChevronRightOutlineRegular size={14} />}
        title={`${t('deletePaths')} (${deletions.length})`}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => setExpanded((value) => !value)}
      >
        {deletions.map((entry) => (
          <p key={entry.path}>
            <PathText value={entry.path} />
            {!entry.exists && (
              <>
                <br />
                <span>{t('ifPresent')}</span>
              </>
            )}
          </p>
        ))}
      </DisclosureRow>
    );
  };
}
