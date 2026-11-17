import { defineConfig } from 'vitest/config';

// Several tests build a tree-sitter code index; under parallel load that can pass the 5 s default.
export default defineConfig({ test: { testTimeout: 30000 } });
