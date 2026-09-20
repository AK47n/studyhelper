/* check:mount 的打包器（2026-09-19 起，替代原来那条裸 esbuild 命令）。
 *
 * 为什么不再是一条命令：App → Board → doc-pages.js 里有
 *   import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
 * `?url` 是 **vite 专属**写法（构建期把文件变成一个 URL 字符串），
 * 裸 esbuild 不认 —— 资料功能（PDF/PPT 铺画布）合入那天起，
 * `check:mount` 的打包就一直是红的（而 check:browser-all 那串里没有它，
 * 所以一直没人看见）。本脚本用 esbuild 的 JS API 挂一个 stub 插件：
 * 把那个导入解析到一个哑串。只影响 node/jsdom 里的挂载测试；
 * 浏览器侧照走 vite，一点不变。
 *
 * 顺带把 check-mount.js 复制成 .cache/check-mount-entry.mjs
 * （它 `import './check-mount-body.cjs'` 是相对自身的，复制过去才指得到产物）。
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const stubPdfWorkerUrl = {
  name: 'stub-pdf-worker-url',
  setup(build) {
    build.onResolve({ filter: /pdf\.worker.*\?url/ }, (a) => ({ path: a.path, namespace: 'pdfstub' }))
    build.onLoad({ filter: /.*/, namespace: 'pdfstub' }, () => ({
      contents: 'module.exports = "data:application/pdf,"',
      loader: 'js',
    }))
  },
}

await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'check-mount-body.jsx')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(root, '.cache', 'check-mount-body.cjs'),
  external: ['katex', 'react', 'react-dom'],
  logLevel: 'error',
  plugins: [stubPdfWorkerUrl],
})

fs.copyFileSync(
  path.join(root, 'scripts', 'check-mount.js'),
  path.join(root, '.cache', 'check-mount-entry.mjs')
)
console.log('check-mount 打包好了（.cache/check-mount-body.cjs）')
