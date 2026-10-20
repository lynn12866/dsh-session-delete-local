import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [compiler, '--project', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});
await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  minify: false,
  sourcemap: 'external',
  legalComments: 'none',
});
