// 直接量光标竖条的像素高度：用 CDP 截图 + Node 里解析 PNG。
// 为了在无头浏览器里让光标稳定可见，用 CSS 动画把原生光标隐藏，改画一条
// 同位置同高度的参考竖条是不行的（那不是真光标）。
// 所以改用另一个办法：让 textarea 的 caret-color 变成亮色，
// 然后在一次请求里连拍多帧，挑出光标那一帧（洋红像素最多）。
//
//   PowerShell: node scripts/caret-shot.js
import fs from 'node:fs'
import zlib from 'node:zlib'

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

/* ---------- 最小 PNG 解码（只处理 8bit RGBA / RGB，非隔行） ---------- */
function decodePng(buf) {
  let pos = 8
  let w = 0
  let h = 0
  let bitDepth = 8
  let colorType = 6
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit PNG，实际 ' + bitDepth)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null
  if (!channels) throw new Error('只支持 RGBA/RGB PNG，colorType=' + colorType)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const out = Buffer.alloc(h * stride)
  let rp = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      switch (filter) {
        case 0: break
        case 1: v = (v + a) & 0xff; break
        case 2: v = (v + b) & 0xff; break
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          v = (v + pr) & 0xff
          break
        }
        default: throw new Error('未知 filter ' + filter)
      }
      cur[x] = v
    }
  }
  return { w, h, channels, data: out }
}

/** 在一张图里找洋红（#ff00ff 附近）像素的包围盒 */
function findMagenta(img) {
  const { w, h, channels, data } = img
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      if (r > 180 && b > 180 && g < 90) {
        count++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  return count ? { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1, count } : { count: 0 }
}

async function main() {
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
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text)
    return r.result && r.result.value
  }

  // 造一个测试台：白底、可见字形、洋红光标。三种字号各一行。
  const geo = await ev(`
  (function(){
    var src = document.querySelector('textarea.raw')
    var cs = getComputedStyle(src)
    var old = document.getElementById('caret-lab')
    if (old) old.remove()
    var panel = document.createElement('div')
    panel.id = 'caret-lab'
    panel.style.cssText = 'position:fixed;left:0;top:0;width:520px;height:260px;z-index:99999;background:#ffffff;font-family:' + cs.fontFamily
    var out = []
    var levels = [['body',1],['lv2',1.28],['lv1',1.5]]
    levels.forEach(function(pair, idx){
      var name = pair[0], mult = pair[1]
      var ta = document.createElement('textarea')
      ta.id = 'lab-' + name
      ta.style.cssText = [
        'position:absolute','left:10px','top:' + (10 + idx*80) + 'px','width:480px','height:70px',
        'box-sizing:border-box','padding:6px 8px','border:1px solid #cccccc','outline:none','resize:none','overflow:hidden',
        'font-family:' + cs.fontFamily,
        'font-size:' + (parseFloat(cs.fontSize)*mult) + 'px',
        'line-height:' + cs.lineHeight,
        'background:#ffffff','color:#000000','caret-color:#ff00ff','white-space:pre'
      ].join(';')
      ta.value = '中文Ag'
      panel.appendChild(ta)
    })
    // 先挂到文档，再量位置（否则宽高都是 0）
    document.body.appendChild(panel)
    levels.forEach(function(pair, idx){
      var name = pair[0], mult = pair[1]
      var ta = document.getElementById('lab-' + name)
      var r = ta.getBoundingClientRect()
      out.push({ name: name, mult: mult, fontSize: parseFloat(cs.fontSize)*mult, x: r.left, y: r.top, w: r.width, h: r.height, padTop: 6 })
    })
    var first = document.getElementById('lab-body')
    first.focus()
    first.setSelectionRange(2,2)
    return out
  })()`)

  console.log('测试台：')
  for (const g of geo) console.log(`  ${g.name.padEnd(6)} 字号 ${Math.round(g.fontSize * 100) / 100}px  位置 (${Math.round(g.x)},${Math.round(g.y)})`)

  // 每次只聚焦一个 textarea，连拍多帧找出光标可见的那一帧
  const results = []
  for (const g of geo) {
    let best = null
    for (let attempt = 0; attempt < 12; attempt++) {
      await ev(`(function(){ var t=document.getElementById('lab-${g.name}'); t.focus(); t.setSelectionRange(2,2); return 1 })()`)
      await new Promise((r) => setTimeout(r, 90))
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: g.x, y: g.y, width: g.w, height: g.h, scale: 1 },
      })
      const img = decodePng(Buffer.from(shot.data, 'base64'))
      const m = findMagenta(img)
      if (m.count > 0 && (!best || m.count > best.count)) best = m
      if (best && best.h > 4) break
    }
    const cs2 = await ev(`(function(){ var t=document.getElementById('lab-${g.name}'); var r=t.getBoundingClientRect(); return { padTop: parseFloat(getComputedStyle(t).paddingTop), lh: parseFloat(getComputedStyle(t).lineHeight), fs: parseFloat(getComputedStyle(t).fontSize) } })()`)
    const caretTopInBox = best ? best.minY - cs2.padTop : null
    results.push({ ...g, ...cs2, caret: best, caretTopInBox })
  }

  console.log('')
  console.log('  层级    字号      行高      光标高   光标顶(相对内容盒)   行盒高')
  for (const r of results) {
    if (!r.caret || !r.caret.count) {
      console.log(`  ${r.name.padEnd(7)} ${String(Math.round(r.fs * 100) / 100).padEnd(9)} ${String(Math.round(r.lh * 100) / 100).padEnd(9)} 没抓到光标`)
      continue
    }
    console.log(
      `  ${r.name.padEnd(7)} ${String(Math.round(r.fs * 100) / 100).padEnd(9)} ${String(Math.round(r.lh * 100) / 100).padEnd(9)} ${String(r.caret.h).padEnd(8)} ${String(r.caretTopInBox).padEnd(20)} ${Math.round(r.lh * 100) / 100}`
    )
  }

  await ev(`(function(){ var p=document.getElementById('caret-lab'); if(p) p.remove(); return 1 })()`)
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
