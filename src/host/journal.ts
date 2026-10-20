import { open } from 'node:fs/promises';

export async function durableJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
