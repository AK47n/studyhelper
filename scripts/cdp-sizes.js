// 多尺寸体检：在不同窗口大小下，编辑区是不是真的可见、可点、可滚。
//   node scripts/cdp-sizes.js
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const CDP_URL = 'http://127.0.0.1:9222'
const SIZES = [
  [1500, 950],
  [1280, 800],
  [1100, 700],
  [1000, 600],
  [1600, 1000],
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  const list = await (await fetch(CDP_URL + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有可调试页面')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id
      pending.set(myId, { res, rej })
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  })
  await new Promise((r, j) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', j)
  })
  return { ws, send }
}

async function main() {
  const { ws, send } = await connect()
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result && r.result.value
  }

  console.log('  窗口尺寸    编辑区可见高  可见宽  在视口内  命中元素        滚轮  点击')
  for (const [w, h] of SIZES) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(400)
    await ev(`(() => { const ta=document.querySelector('textarea.raw'); if(ta) ta.scrollTop=200; return 1 })()`)
    await sleep(120)

    const probe = JSON.parse(
      await ev(`(() => {
        const ta = document.querySelector('textarea.raw')
        if (!ta) return JSON.stringify({ error: '没有 textarea（可能不在编辑视图）' })
        const r = ta.getBoundingClientRect()
        const vh = innerHeight, vw = innerWidth
        // 可见部分
        const visTop = Math.max(0, r.top)
        const visBottom = Math.min(vh, r.bottom)
        const visH = Math.max(0, visBottom - visTop)
        const visW = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left))
        // 在可见区中心做命中测试
        const cx = Math.max(0, r.left) + visW / 2
        const cy = visTop + visH / 2
        const el = document.elementFromPoint(cx, cy)
        return JSON.stringify({
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          visH: Math.round(visH), visW: Math.round(visW),
          inViewport: r.top < vh && r.bottom > 0 && r.top >= 0,
          hit: el ? el.tagName.toLowerCase() + '.' + ((el.className || '').toString().split(' ')[0] || '') : null,
          hitIsTa: el === ta,
          cx: Math.round(cx), cy: Math.round(cy),
          before: ta.scrollTop,
          headerH: Math.round((document.querySelector('.topbar') || {}).getBoundingClientRect ? document.querySelector('.topbar').getBoundingClientRect().height : 0),
          fbarH: Math.round(document.querySelector('.fbar') ? document.querySelector('.fbar').getBoundingClientRect().height : 0),
          footH: Math.round(document.querySelector('.srcfoot') ? document.querySelector('.srcfoot').getBoundingClientRect().height : 0),
        })
      })()`)
    )
    if (probe.error) {
      console.log(`  ${w}x${h}  ✗ ${probe.error}`)
      continue
    }

    // 真滚轮
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: probe.cx, y: probe.cy, deltaX: 0, deltaY: 100, pointerType: 'mouse' })
    await sleep(150)
    const afterWheel = Number(await ev(`document.querySelector('textarea.raw').scrollTop`))

    // 真点击
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.cx, y: probe.cy, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.cx, y: probe.cy, button: 'left', clickCount: 1 })
    await sleep(150)
    const clickOk = await ev(`document.activeElement === document.querySelector('textarea.raw')`)

    const scrollOk = afterWheel > probe.before
    console.log(
      `  ${String(w + 'x' + h).padEnd(11)} ${String(probe.visH).padEnd(13)} ${String(probe.visW).padEnd(7)} ${String(probe.inViewport ? '是' : '否!').padEnd(9)} ${String(probe.hit).padEnd(15)} ${scrollOk ? '✓' : '✗'}     ${clickOk ? '✓' : '✗'}`
    )
    if (!probe.hitIsTa) console.log(`       ⚠ 命中元素不是 textarea，而是 ${probe.hit}`)
    if (probe.visH < 120) console.log(`       ⚠ 编辑区可见高度只有 ${probe.visH}px（顶栏 ${probe.headerH} + 公式条 ${probe.fbarH} + 状态栏 ${probe.footH}）`)
  }

  await send('Emulation.clearDeviceMetricsOverride')
  ws.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
