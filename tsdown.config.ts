import { defineConfig } from 'tsdown'

/** Host plugin and standalone stdio MCP server. */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    mcp: 'lib/types/mcp.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
