// 用之前分开截的两张图（着色层 / textarea），直接量出两者第一段文字的纵向偏移。
// 这两张图是在同一次运行、同一个 clip 区域、同一个 scrollTop 下拍的。
//   node scripts/measure-imgs.js
import fs from 'node:fs'
import zlib from 'node:zlib'

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

/** 每行的墨迹像素数（灰度 < 0.5 视为墨） */
function rowProfile(img) {
  const { w, h, ch, data } = img
  const rows = new Array(h).fill(0)
  for (let y = 0; y < h; y++) {
    let n = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch
      const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
      if (l < 0.5) n++
    }
    rows[y] = n
  }
  return rows
}

/** 把行剖面切成"文字行"的区段：[{from,to,center,mass}] */
function bands(rows, minMass = 20) {
  const out = []
  let cur = null
  for (let y = 0; y < rows.length; y++) {
    if (rows[y] > minMass) {
      if (!cur) cur = { from: y, to: y, mass: 0, wsum: 0 }
      cur.to = y
      cur.mass += rows[y]
      cur.wsum += y * rows[y]
    } else if (cur) {
      out.push({ ...cur, center: Math.round((cur.wsum / cur.mass) * 100) / 100 })
      cur = null
    }
  }
  if (cur) out.push({ ...cur, center: Math.round((cur.wsum / cur.mass) * 100) / 100 })
  return out
}

const files = process.argv.slice(2)
if (files.length < 2) {
  console.log('用法: node scripts/measure-imgs.js <图A> <图B>')
  process.exit(1)
}

const imgs = files.map((f) => ({ name: f, img: decodePng(fs.readFileSync(f)) }))
console.log('图片:')
for (const { name, img } of imgs) console.log(`  ${name}  ${img.w}x${img.h}`)

const profs = imgs.map((x) => rowProfile(x.img))
const bandsList = profs.map((p) => bands(p))
for (let i = 0; i < imgs.length; i++) {
  console.log(`\n${imgs[i].name} 的文字行（前 8 段）:`)
  for (const b of bandsList[i].slice(0, 8)) {
    console.log(`  y ${String(b.from).padStart(4)}~${String(b.to).padEnd(4)} 中心 ${String(b.center).padStart(8)}  墨迹 ${b.mass}`)
  }
}

if (bandsList[0].length && bandsList[1].length) {
  console.log('\n=== 配对偏移（图B中心 - 图A中心）===')
  const n = Math.min(bandsList[0].length, bandsList[1].length, 8)
  const diffs = []
  for (let i = 0; i < n; i++) {
    const a = bandsList[0][i]
    const b = bandsList[1][i]
    const d = Math.round((b.center - a.center) * 100) / 100
    diffs.push(d)
    console.log(`  第 ${i + 1} 段: A 中心 ${a.center}  B 中心 ${b.center}  偏移 ${d}px`)
  }
  const avg = diffs.reduce((x, y) => x + y, 0) / diffs.length
  const max = Math.max(...diffs.map(Math.abs))
  const min = Math.min(...diffs.map(Math.abs))
  console.log(`\n  平均偏移 ${Math.round(avg * 100) / 100}px   最小 ${Math.round(min * 100) / 100}px   最大 ${Math.round(max * 100) / 100}px`)
  if (max - min < 1.5 && Math.abs(avg) > 1.5) {
    console.log(`  → 恒定偏移 ${Math.round(avg * 100) / 100}px（整体错位）`)
  } else if (max - min >= 1.5) {
    console.log(`  → 偏移量随行递增/递减（分层错位，说明两层行高不同）`)
  } else {
    console.log('  → 两层对齐')
  }
}
