/**
 * Bundle the background worker for the production image.
 *
 * The worker could simply be run with `tsx` in production — it is a
 * long-running process, so start-up transpile cost is irrelevant. It is
 * bundled instead because the alternative means shipping the TypeScript
 * toolchain and the project's source tree into the image that holds decrypted
 * client credentials, and this codebase has consistently argued the other way
 * about dependency surface.
 *
 * One file, one runtime dependency tree, nothing to transpile at start-up.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [resolve(root, 'src/workers/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: resolve(root, 'dist/worker.mjs'),
  sourcemap: true,
  // postgres.js resolves its own protocol modules at runtime and does not
  // survive bundling; bullmq pulls in optional native bindings. Both stay
  // external and are installed in the image as real dependencies.
  external: ['postgres', 'bullmq'],
  // esbuild does not read tsconfig `paths` for aliases used across the tree,
  // so they are declared here. Keep in step with tsconfig.json.
  alias: {
    '@': resolve(root, 'src'),
    '@db': resolve(root, 'db'),
  },
  banner: {
    // The bundle is ESM but pulls in CJS dependencies that expect `require`.
    js: [
      "import { createRequire as __helmCreateRequire } from 'node:module';",
      'const require = __helmCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
