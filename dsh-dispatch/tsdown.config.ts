import { defineConfig } from 'tsdown';

// Client-half bundle: CJS single file; the shell (react / @deepseek-ai client
// packages) stays external and resolves through the loader's require().
export default defineConfig({
  entry: ['src/client/index.tsx'],
  format: ['cjs'],
  outDir: 'dist-client',
  dts: false,
  sourcemap: false,
  minify: false,
  platform: 'browser',
  deps: { neverBundle: [/^react(\/.*)?$/, /^react-dom(\/.*)?$/, /^@deepseek-ai\//] },
});
