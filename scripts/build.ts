import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [compiler, '--project', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});
// TypeScript does not copy ambient .d.ts inputs into outDir.
await mkdir(new URL('../dist/types/', import.meta.url), { recursive: true });
await copyFile(
  new URL('../src/types/host-runtime.d.ts', import.meta.url),
  new URL('../dist/types/host-runtime.d.ts', import.meta.url),
);
const declarationEntry = new URL('../dist/index.d.ts', import.meta.url);
const declarations = await readFile(declarationEntry, 'utf8');
await writeFile(
  declarationEntry,
  declarations.replace('../src/types/host-runtime.d.ts', './types/host-runtime.d.ts'),
);
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
