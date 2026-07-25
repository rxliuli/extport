import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  dts: true,
  deps: { neverBundle: ['wxt'] },
  clean: true,
})
