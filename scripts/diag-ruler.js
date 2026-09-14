// 在诊断模式下，放大某一行，量出蓝字和红字的纵向中心距离。
//   node scripts/diag-ruler.js
import fs from 'node:fs'
import zlib from 'node:zlib'

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bd = 8, ct = 6
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const d = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9] }
    else if (type === 'IDAT') idat.push(d)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : null
  if (bd !== 8 || !ch) throw new Error('需要 8bit RGB/RGBA')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  let rp = 0
  for (let y = 0; y < h; y++) {
    const f = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= ch ? prev[x - ch] : 0
      let v = line[x]
      if (f === 1) v = (v + a) & 255
      else if (f === 2) v = (v + b) & 255
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      cur[x] = v
    }
  }
  return { w, h, ch, data: out }
}

async function main() {
  const list = await (await fetch(CDP_URL + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
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

  // 打开诊断，失焦（不滚动），这样状态最干净
  await ev(`
  (function(){
    var ta = document.querySelector('textarea.raw')
    ta.scrollTop = 0
    ta.blur()
    ta.dispatchEvent(new Event('scroll', { bubbles: true }))
    var box = document.querySelector('.srcscroll')
    if (box.className.indexOf('diag') < 0) {
      var b = [].slice.call(document.querySelectorAll('.top-actions button')).filter(function(x){return x.textContent.indexOf('诊断')>=0})[0]
      if (b) b.click()
    }
    return 1
  })()`)
  await new Promise((r) => setTimeout(r, 600))

  const st = await ev(`(function(){
    var ta = document.querySelector('textarea.raw')
    var r = ta.getBoundingClientRect()
    return {
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.min(260, Math.round(r.height)) },
      scrollTop: ta.scrollTop,
      cls: document.querySelector('.srcscroll').className,
    }
  })()`)
  console.log(`状态: ${st.cls}  scrollTop=${st.scrollTop}`)

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: st.box.x, y: st.box.y, width: st.box.w, height: st.box.h, scale: 2 },
  })
  const buf = Buffer.from(shot.data, 'base64')
  fs.writeFileSync('.cache/diag-ruler.png', buf)
  const img = decodePng(buf)

  // 逐行统计蓝/红/紫像素，找出每个色块的纵向范围
  const rows = []
  for (let y = 0; y < img.h; y++) {
    let blue = 0, red = 0, purple = 0
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * img.ch
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2]
      const isBlue = b > 140 && r < 130 && g > 100 && g < 200
      const isRed = r > 140 && b < 130 && g < 130
      const isPurple = r > 110 && b > 140 && g < 120
      if (isPurple) purple++
      else if (isBlue) blue++
      else if (isRed) red++
    }
    rows.push({ y, blue, red, purple })
  }
  const nz = rows.filter((r) => r.blue + r.red + r.purple > 3)
  console.log(`\n有墨迹的纵向范围: y ${nz.length ? nz[0].y : '-'} ~ ${nz.length ? nz[nz.length - 1].y : '-'}（图高 ${img.h}，放大 2 倍，所以实际像素要除以 2）`)

  // 找蓝、红各自的纵向聚类中心
  const cluster = (key) => {
    const out = []
    let cur = null
    for (const r of rows) {
      if (r[key] > 3) {
        if (!cur) cur = { from: r.y, to: r.y, sum: 0, wsum: 0 }
        cur.to = r.y
        cur.sum += r[key]
        cur.wsum += r.y * r[key]
      } else if (cur) {
        out.push({ from: cur.from, to: cur.to, center: Math.round((cur.wsum / cur.sum) * 10) / 10, mass: cur.sum })
        cur = null
      }
    }
    if (cur) out.push({ from: cur.from, to: cur.to, center: Math.round((cur.wsum / cur.sum) * 10) / 10, mass: cur.sum })
    return out.filter((c) => c.mass > 30)
  }

  const blueC = cluster('blue')
  const redC = cluster('red')
  console.log(`\n蓝字（着色层）纵向聚类 ${blueC.length} 段:`)
  for (const c of blueC.slice(0, 8)) console.log(`  y ${c.from}~${c.to}  中心 ${c.center}  质量 ${c.mass}`)
  console.log(`\n红字（编辑框）纵向聚类 ${redC.length} 段:`)
  for (const c of redC.slice(0, 8)) console.log(`  y ${c.from}~${c.to}  中心 ${c.center}  质量 ${c.mass}`)

  // 配对最近的蓝红中心，算偏移
  console.log('\n配对后的偏移（红 - 蓝，单位=图上的像素，除以 2 得到 CSS 像素）:')
  const diffs = []
  for (const b of blueC) {
    let best = null
    for (const r of redC) {
      const d = r.center - b.center
      if (best === null || Math.abs(d) < Math.abs(best)) best = d
    }
    if (best !== null) {
      diffs.push(best)
      console.log(`  蓝中心 ${b.center} ↔ 最近红中心偏移 ${Math.round(best * 10) / 10}  → CSS 像素 ${Math.round((best / 2) * 100) / 100}`)
    }
  }
  if (diffs.length) {
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length
    console.log(`\n  平均偏移 ${Math.round(avg * 10) / 10} 图上像素 = ${Math.round((avg / 2) * 100) / 100} CSS 像素`)
  }
  console.log('\n  截图 .cache/diag-ruler.png')

  // 关掉诊断
  await ev(`(function(){
    var b=[].slice.call(document.querySelectorAll('.top-actions button')).filter(function(x){return x.textContent.indexOf('诊断')>=0})[0]
    if (b) b.click(); return 1 })()`)
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
