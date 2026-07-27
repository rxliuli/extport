import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/webext.ts', 'src/react.ts'],
  dts: true,
  // 固定 .mjs/.d.mts 后缀，exports map 不随打包器默认值漂移
  fixedExtension: true,
})
