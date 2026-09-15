/* 让 CDP 里那个页面重新导航一次。
 *
 * 为什么需要它：开发服务器（vite）改完模块，已经打开的页面**不一定**换到新代码
 * （HMR 只换它认得的那一块，改的如果是个被 import 的数据模块，父模块未必重建）。
 * 于是你会看到"明明改了代码，页面还是老样子"—— 实测就这么被骗过一次：
 * 样板我加到了 5 张卡，页面里却一直是 4 张。
 *
 * 跑：node scripts/cdp-reload.js [url]
 */
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222'
const APP = process.argv[2] || process.env.APP_URL || 'http://127.0.0.1:5177/'

const list = await (await fetch(CDP + '/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (!page) {
  console.error('没有可用的页面 target')
  process.exit(2)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const send = (method, params = {}) => {
  const i = ++id
  ws.send(JSON.stringify({ id: i, method, params }))
}
send('Page.enable')
send('Page.navigate', { url: APP })
await new Promise((r) => setTimeout(r, 3500))
const title = await new Promise((res) => {
  const i = ++id
  const onMsg = (e) => {
    const m = JSON.parse(e.data)
    if (m.id === i) {
      ws.removeEventListener('message', onMsg)
      res(m.result && m.result.result && m.result.result.value)
    }
  }
  ws.addEventListener('message', onMsg)
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: 'document.title + " | " + (document.querySelector(".bd-file")||{}).textContent', returnByValue: true } }))
})
console.log('  已重新加载：' + title)
ws.close()
process.exit(0)
