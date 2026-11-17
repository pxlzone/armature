// Bundles the CLI and all its dependencies into one file for the Claude Code plugin, so a
// developer's machine needs only Node: no npm install, no build step.
import path from 'node:path';
import { defineConfig } from 'vite';

const root = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  root,
  logLevel: 'warn',
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: path.join(root, 'src/cli.ts'),
    outDir: path.join(root, 'plugin/dist'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      // Loaded at run time through createRequire, from the vendored copy next to the bundle.
      external: ['@vscode/tree-sitter-wasm'],
      output: {
        format: 'es',
        entryFileNames: 'cli.mjs',
        codeSplitting: false,
        // Some bundled CommonJS packages call require() for Node built-ins.
        banner: "import { createRequire as __armatureRequire } from 'node:module'; const require = __armatureRequire(import.meta.url);",
      },
    },
  },
});
