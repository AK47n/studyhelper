import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  /* 为什么把"清空产物目录"这一步关掉（2026-09-17）：
     这台机器上给 node 装了一层闸 —— **一次删超过 50 个文件就先拦下来问一句**
     （safe-delete 的 BULK_CONFIRM），而 `dist/assets` 里正好躺着 62 个字体文件。
     症状是 `npm run build` 每次都红，报出来的话却像磁盘问题：
     `[vite:prepare-out-dir] [safe-delete][SAFE_DELETE_BULK_CONFIRM] {"count":62,...}`。
     关掉之后 Vite 直接往目录里覆盖写：带 hash 的旧产物会留下来，但 index.html
     引的永远是刚出的那一个，不影响运行（要彻底干净就自己删 dist/）。 */
  build: { emptyOutDir: false },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5178',
      '/data': 'http://127.0.0.1:5178',
    },
  },
})
