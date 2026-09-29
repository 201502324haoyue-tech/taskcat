import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

/**
 * 注意：不使用 node:url / path（避免引入 @types/node 依赖），
 * 别名用 Vite 根相对路径形式（dev / build / vitest 均按项目根解析）。
 */
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    // 沙箱拦截批量删除：不清空 dist，直接覆盖写入（旧哈希文件无害）
    emptyOutDir: false,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
