// 入口：先把 jsdom 环境装好，再动态载入真正的测试体。
// 拆成两个文件是因为 App.jsx 里有 JSX，必须打包成 CJS；而 CJS 不支持顶层 await。
//   npm run check:mount
import { JSDOM } from 'jsdom'
import fs from 'node:fs'
import path from 'node:path'

/* 样本必须显式挑，不能靠 readdirSync 的顺序：
   Windows 的 readdir 不保证顺序，data/ 里多一个 .md（比如那份填空模板）
   就可能被选成样本，于是"加载的是 B，却假装自己是 A"，
   后面的断言全都在拿错内容比对——报出来的错还全是假的。
   顺便：挑不到带这个标记的文件就直接退出，不要带着错样本继续跑。 */
const SAMPLE_MARK = '磁感应强度，T'
const dataDir = path.join(process.cwd(), 'data')
const sampleFile = fs
  .readdirSync(dataDir)
  .filter((f) => f.endsWith('.md'))
  .find((f) => fs.readFileSync(path.join(dataDir, f), 'utf8').includes(SAMPLE_MARK))
if (!sampleFile) {
  console.error(`data/ 里没有含 "${SAMPLE_MARK}" 的样本文件，check:mount 没法跑`)
  process.exit(1)
}
const SAMPLE = fs.readFileSync(path.join(dataDir, sampleFile), 'utf8')

// 告诉 React 这是测试环境，否则它会刷一堆 "not configured to support act" 噪音
global.IS_REACT_ACT_ENVIRONMENT = true

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:5177/',
  pretendToBeVisual: true,
})
const { window } = dom

global.window = window
global.document = window.document
// Node 24 的 globalThis.navigator 是 getter-only，只能 defineProperty 覆盖
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true, writable: true })
global.HTMLElement = window.HTMLElement
global.Element = window.Element
global.Node = window.Node
global.Event = window.Event
global.MouseEvent = window.MouseEvent
global.KeyboardEvent = window.KeyboardEvent
global.getComputedStyle = window.getComputedStyle.bind(window)
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)
global.localStorage = window.localStorage
global.confirm = () => true
global.prompt = () => null
window.TextEncoder = TextEncoder
window.TextDecoder = TextDecoder
// jsdom 没有实现这两个，React 18+ 的并发渲染会用到
if (!window.MessageChannel) {
  const { MessageChannel } = await import('node:worker_threads')
  window.MessageChannel = MessageChannel
  global.MessageChannel = MessageChannel
}

// 假的服务端：内存里放一份示例文件，记录所有请求
let diskText = SAMPLE
const calls = []
global.fetch = async (url, opts = {}) => {
  const u = String(url)
  const method = opts.method || 'GET'
  calls.push({ u, method })
  const json = (obj, code = 200) => ({
    ok: code < 400,
    status: code,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  })
  if (u.startsWith('/api/list')) {
    return json({
      files: [{ name: sampleFile, title: sampleFile.replace(/\.md$/i, ''), mtime: 1, size: diskText.length, nodes: 41 }],
      watch: {},
    })
  }
  if (u.startsWith('/api/watch')) return json({ watch: {} })
  if (u.startsWith('/api/file/') && method === 'GET') {
    return json({ name: sampleFile, text: diskText, mtime: 1 })
  }
  if (u.startsWith('/api/file/') && method === 'PUT') {
    diskText = JSON.parse(opts.body).text
    return json({ ok: true, mtime: Date.now() })
  }
  return json({ error: 'no route ' + u }, 404)
}
window.fetch = global.fetch

// 交给打包好的测试体。这个入口文件会被复制到 .cache/ 下执行（因为 scripts/ 里没有
// package.json 的 type 字段控制不了它），所以必须按"当前文件所在目录"找，不能写死相对路径。
const { run } = await import(new URL('./check-mount-body.cjs', import.meta.url).href)
const { failed, results } = await run({
  window,
  container: document.getElementById('root'),
  getDiskText: () => diskText,
  calls,
})
for (const line of results) console.log(line)
console.log(failed ? `\n有 ${failed} 处问题 ✗` : '\n全部通过 ✓')
process.exit(failed ? 1 : 0)
