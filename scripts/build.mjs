// Bundles the Lambda handler, the CLI and the web app with esbuild.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src/backend/handler.ts')],
  outfile: join(dist, 'backend/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['@aws-sdk/*'],
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'warning',
});

await build({
  entryPoints: [join(root, 'src/cli/main.ts')],
  outfile: join(dist, 'cli/mcpwiki.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'warning',
});

const web = await build({
  entryPoints: [join(root, 'src/web/app.ts')],
  outdir: join(dist, 'web/assets'),
  entryNames: 'app-[hash]',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  minify: true,
  legalComments: 'linked',
  metafile: true,
  logLevel: 'warning',
});
const js = Object.keys(web.metafile.outputs).find((f) => f.endsWith('.js')).split('/').pop();
const css = readFileSync(join(root, 'src/web/styles.css'));
const cssName = `styles-${createHash('sha256').update(css).digest('hex').slice(0, 8)}.css`;
writeFileSync(join(dist, 'web/assets', cssName), css);
copyFileSync(join(root, 'src/web/favicon.svg'), join(dist, 'web/assets/favicon.svg'));
mkdirSync(join(dist, 'web/root'), { recursive: true });
writeFileSync(
  join(dist, 'web/root/index.html'),
  readFileSync(join(root, 'src/web/index.html'), 'utf8').replace('__JS__', js).replace('__CSS__', cssName),
);
console.log(`built dist/backend, dist/cli/mcpwiki.mjs, dist/web (${js}, ${cssName})`);
