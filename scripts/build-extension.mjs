/**
 * Build the browser extension into dist/extension, and zip it for the Chrome
 * Web Store (which serves Chrome, Edge via "Allow extensions from other
 * stores", and Brave).
 *
 *   pnpm build:extension            dist/extension/ and dist/helm-extension-<version>.zip
 *
 * Each entry point is bundled on its own, with no source maps: what ships is
 * what the store reviews, and a map would publish the source a second time
 * for no benefit. Nothing is minified either, for the same reviewer.
 *
 * The version comes from extension/manifest.json, and a store upload must
 * carry a higher one than the last.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'extension');
const out = resolve(root, 'dist/extension');
const manifest = JSON.parse(readFileSync(resolve(source, 'manifest.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ['background', 'popup', 'options', 'offscreen'].map((name) => resolve(source, `src/${name}.ts`)),
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});

cpSync(resolve(source, 'manifest.json'), resolve(out, 'manifest.json'));
cpSync(resolve(source, 'static'), out, { recursive: true });
cpSync(resolve(source, 'icons'), resolve(out, 'icons'), { recursive: true });

const zip = resolve(root, `dist/helm-extension-${manifest.version}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-qr', zip, '.'], { cwd: out, stdio: 'inherit' });
console.log(`extension ${manifest.version}: ${out}\n${zip}`);
