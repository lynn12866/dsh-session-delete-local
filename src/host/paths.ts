import { lstat, realpath, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { errorCode } from '../shared/errors.js';
import { refuse } from './errors.js';

export type PathPlatform = 'win32' | 'posix';

export function pathIdentity(value: string, platform: PathPlatform): string {
  if (platform === 'posix') {
    return path.posix.normalize(value);
  }
  const conventional = value.startsWith('\\\\?\\UNC\\')
    ? `\\\\${value.slice(8)}`
    : value.replace(/^\\\\\?\\/, '');
  return path.win32.normalize(conventional).toLowerCase();
}

export function samePath(left: string, right: string): boolean {
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  return pathIdentity(left, platform) === pathIdentity(right, platform);
}

export function childSegments(
  root: string,
  target: string,
  platform: PathPlatform = process.platform === 'win32' ? 'win32' : 'posix',
): string[] {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const relative = api.relative(root, target);
  const segments = relative.split(api.sep);
  if (!relative || api.isAbsolute(relative) || segments.includes('..')) {
    refuse('unsafe-path', '路径不在受支持的存储目录内。');
  }
  return segments;
}

/** Reject symlinks and Windows junctions at every existing path component. */
export async function checkedPath(root: string, target: string): Promise<void> {
  const absoluteRoot = path.resolve(root);
  const segments = childSegments(absoluteRoot, path.resolve(target));
  let cursor = absoluteRoot;
  for (const component of ['', ...segments]) {
    cursor = component ? path.join(cursor, component) : cursor;
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        refuse('unsafe-path', '存储路径包含符号链接或 Windows junction，已拒绝删除。');
      }
      if (!samePath(await realpath(cursor), cursor)) {
        refuse('unsafe-path', '存储路径经过链接或别名，已拒绝删除。');
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export interface TreeEntry {
  path: string;
  kind: 'file' | 'directory';
  bytes: number;
}

export async function inspectTree(root: string, target: string): Promise<TreeEntry[]> {
  await checkedPath(root, target);
  if (!(await fileExists(target))) {
    return [];
  }
  const stat = await lstat(target);
  if (!stat.isDirectory() && !stat.isFile()) {
    refuse('unsafe-path', '删除目标不是普通文件或目录。');
  }
  const entries: TreeEntry[] = [
    {
      path: target,
      kind: stat.isDirectory() ? 'directory' : 'file',
      bytes: stat.isFile() ? stat.size : 0,
    },
  ];
  if (stat.isDirectory()) {
    for (const name of (await readdir(target)).sort()) {
      entries.push(...(await inspectTree(root, path.join(target, name))));
    }
  }
  return entries;
}

/** Bounded retries for Windows antivirus/sharing delays; never copy across volumes. */
export async function retryBusy<T>(
  operation: () => Promise<T>,
  platform: string = process.platform,
  pause: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        platform !== 'win32' ||
        attempt >= 4 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '')
      ) {
        throw error;
      }
      await pause(100 * (attempt + 1));
    }
  }
}

export async function movePath(source: string, target: string): Promise<void> {
  await retryBusy(() => rename(source, target));
}

export async function purgePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

/** Exact encoding used by the pinned JSONL backend, including non-ASCII IDs. */
export function encodedSessionId(id: string): string {
  if (id === '.') {
    return '~002E';
  }
  if (id === '..') {
    return '~002E~002E';
  }
  let encoded = '';
  for (let index = 0; index < id.length; index++) {
    const character = id[index]!;
    encoded += /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${id.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return encoded;
}

export async function hasSessionDirectory(root: string, id: string): Promise<boolean> {
  if (!(await fileExists(root))) {
    return false;
  }
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !samePath(await realpath(root), path.resolve(root))) {
    refuse('unsafe-path', '会话存储根目录经过链接，无法确认残留。');
  }
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (project.isSymbolicLink()) {
      refuse('unsafe-path', '会话存储包含链接，不能可靠识别孤立缓存。');
    }
    if (
      project.isDirectory() &&
      (await fileExists(path.join(root, project.name, encodedSessionId(id))))
    ) {
      return true;
    }
  }
  return false;
}
