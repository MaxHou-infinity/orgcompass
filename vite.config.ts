/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// 单一版本来源：注入 package.json 的 version，所有 UI 显示统一用 __APP_VERSION__
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // v2.3.1（T-07）：v2.3.0 之前完全没有 test 配置块 —— 无覆盖率度量、无门槛、无统一 setup。
  // 门槛按「当前实测值向下取整」设定，作用是防止覆盖率回流（不是追求数字好看）。
  test: {
    // 默认 node 环境；需要 DOM 的用例用文件头 `// @vitest-environment jsdom` 声明
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/vite-env.d.ts', 'src/main.tsx'],
      // 实测（v2.3.1）：statements 69.95 / branches 60.76 / functions 60.12 / lines 71.73
      thresholds: {
        statements: 68,
        branches: 58,
        functions: 58,
        lines: 70,
      },
    },
  },
})
