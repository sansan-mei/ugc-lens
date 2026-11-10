import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// 图形界面前端：构建为静态文件放到包根目录 ui/，由 src/ui/server.ts 提供。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('../ui', import.meta.url)),
    emptyOutDir: true,
    // 页面内容安全策略不允许内联脚本，模块预加载 polyfill 会生成内联代码
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 1200,
  },
})
