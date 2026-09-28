import { build } from 'esbuild';

await build({
  entryPoints: ['setup/src/index.ts'],
  outfile: 'setup/dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: false,
  sourcemap: false,
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
