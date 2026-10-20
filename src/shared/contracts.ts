export type CleanupCategory =
  | 'session-log'
  | 'projection-cache'
  | 'cache-backup'
  | 'legacy-feedback'
  | 'legacy-cache'
  | 'workspace-reference'
  | 'schedule';

export interface CleanupPath {
  path: string;
  action: 'delete-file' | 'delete-directory' | 'update-record';
  category: CleanupCategory;
  sessionIds: string[];
  recordKeys: string[];
  bytes: number;
  exists: boolean;
}

export interface RetainedPath {
  path: string;
  reason: 'shared-attachments' | 'workspace-files' | 'recovery-data' | 'outside-scope';
}

export interface CleanupManifest {
  platform: string;
  entries: CleanupPath[];
  retained: RetainedPath[];
  limitations: string[];
}

export interface DeletePreview {
  token: string;
  mode: 'session' | 'residue';
  confirmation: string;
  manifest: CleanupManifest;
  sessionId: string;
  archived: boolean;
  archivedIds: string[];
  count: number;
  bytes: number;
  ids: string[];
  busy: string[];
  title: string;
}

export type DeleteResult =
  | { deleted: string[]; purged: true; manifest: CleanupManifest }
  | {
      deleted: string[];
      manifest: CleanupManifest;
      purged: false;
      recoveryPath: string;
      message: string;
    };

export type RpcResult<T> =
  { ok: true; value: T } | { ok: false; error: { code?: string; message: string } };

export interface DeleteMethods {
  preview: {
    args: { sessionId: string; includeChildren: boolean };
    result: DeletePreview;
  };
  previewResidue: { args: Record<string, never>; result: DeletePreview };
  commit: {
    args: { token: string; confirmation: string };
    result: DeleteResult;
  };
}
