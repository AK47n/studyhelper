/* check-docslice-browser：「图片能当资料」+「只抽这几页」这两条的端到端
 * （真浏览器 + 真本地服务，端口 5241/9281，跑完都收掉）。
 *
 * 为什么值得端到端盯一遍 —— 这两件事的成品落在**磁盘和像素**上，而中间任何一步
 * 出错界面上都照样有模有样：
 *   · 图片那条路走不通的话，表现为"插进去了，但那一页永远是白的"；
 *   · 抽页那条路要是没抽成，表现为"板上还是几百页" —— 用户要等一段时间才发现，
 *     而他已经把那本书传上去了。
 * 所以它盯的是**只有真跑一遍才看得见**的那几件事：
 *   [1] 一张图片插进去 = 一份一页的资料（页面上真的有色 Pixel，不是白纸）；
 *   [2] ★ 一本厚书（25 页，超过问页码的门槛）插进去时会**问他要哪几页**；
 *   [3] 写「2,4」之后，板上这几页就**只有两页**（第 2、第 4 页），且带着那串名字；
 *   [4] ★ Esc = 算了 → 板上没多出任何一份（选错文件来得及回头）；
 *   [5] 全程没有 JS 报错；用户的 data/ 一个字节没动。
 *
 * 夹具：两张自造的图片/PDF（`.资料/zz-slice-*`）和一张 `board-zz-slicecheck.md`，
 * 跑完自删。OUTPUT: npm run check:docslice-browser
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { DATA, withBoard } from './lib/board-check.js'

const ZZ_PIC = path.join(DATA, '.资料', 'zz-slice-pic.png')
const ZZ_PIC_REL = '.资料/zz-slice-pic.png'
const ZZ_BOOK = path.join(DATA, '.资料', 'zz-slice-book.pdf')

/* ── 夹具一：一张纯色 PNG（不用第三方造图：PNG 的字节就这么几种，手拼比加依赖快）
 *    ★ 颜色故意选得很偏（红 200,30,30）：待会儿要在页面那块 canvas 上读像素，
 *      证明"这一页不是一张白纸"。用灰色的话，白纸和灰纸差别太小，读不出来。
 */
let fails = 0

/* PNG 需要的 CRC32（每块数据后面挂四个字节，写错任何一个字节图就加载不出来）。 */
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** 一张 w×h 的纯色 PNG（真彩色、无透明 —— 底色就是传进来的 rgb）。 */
function buildPng(w, h, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // 每通道 8 位
  ihdr[9] = 2 // 颜色类型 2 = 真彩色 RGB
  const rows = []
  for (let y = 0; y < h; y++) {
    const line = Buffer.alloc(1 + w * 3)
    for (let x = 0; x < w; x++) {
      line[1 + x * 3] = rgb[0]
      line[2 + x * 3] = rgb[1]
      line[3 + x * 3] = rgb[2]
    }
    rows.push(line)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ── 夹具二：一本"厚书" 25 页（超过问页码的门槛 SLICE_ASK_MIN=20）──
 *   手写 PDF 字节，仓库里别的自检也是这个路子：不给 node_modules 添负担。
 * ★★ **每一页底色都不一样**（`pageRGB`）：预览那几条断言靠它 ——
 *    光看"缩略图画出来了"证明不了画的是**第几页**；读它那个颜色才知道
 *    "预览画的真是这一页，而「往后挪一页」真的换了一页"。 */
function pageRGB(page) {
  const i = Number(page) - 1
  return [(i * 53 + 40) % 256, (i * 97 + 30) % 256, (i * 29 + 70) % 256]
}
function buildPdf(n) {
  const objs = []
  const firstPage = 4
  const kids = []
  for (let i = 0; i < n; i++) kids.push(`${firstPage + 2 * i} 0 R`)
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let i = 0; i < n; i++) {
    const pno = firstPage + 2 * i
    const cno = pno + 1
    objs[pno] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cno} 0 R >>`
    const rgb = pageRGB(i + 1).map((v) => (v / 255).toFixed(3))
    const stream = `${rgb[0]} ${rgb[1]} ${rgb[2]} rg 30 30 640 440 re f 0.1 0.1 0.1 rg BT /F1 40 Tf 60 400 Td (Book page ${i + 1}) Tj ET`
    objs[cno] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  }
  let out = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out))
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefAt = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'utf8')
}

await withBoard({ tag: 'docslice', port: 5241, cdpPort: 9281 }, async ({ s, ok, bad, open, until, untilFile, untilSaved, after, drift, raw }) => {
  fs.mkdirSync(path.dirname(ZZ_PIC), { recursive: true })
  fs.writeFileSync(ZZ_PIC, buildPng(320, 240, [200, 30, 30]))
  fs.writeFileSync(ZZ_BOOK, buildPdf(25))
  after(() => {
    for (const p of [ZZ_PIC, ZZ_BOOK]) {
      try {
        fs.rmSync(p, { force: true })
      } catch {}
    }
    /* ★ 抽出来的那一份是**上传出来的**（服务端把它收进了 .资料/），
       夹具清单一开始是列不到它的 —— 不扫一遍的话，跑一次自检就在用户那个
       课件目录里留下一本书的碎片（第一次跑就留了一个）。按夹具前缀兜一圈。 */
    try {
      const dir = path.dirname(ZZ_PIC)
      for (const n of fs.readdirSync(dir)) {
        if (n.startsWith('zz-slice-')) fs.rmSync(path.join(dir, n), { force: true })
      }
    } catch {}
  })

  await open()

  const rectOfText = (sel, text) =>
    s.eval(`(() => {
      for (const b of document.querySelectorAll(${JSON.stringify(sel)})) {
        if (b.textContent.includes(${JSON.stringify(text)})) {
          b.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          const r = b.getBoundingClientRect()
          const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
          const at = document.elementFromPoint(cx, cy)
          return { x: cx, y: cy, hit: at ? (at.className || at.tagName) : null, disabled: !!b.disabled }
        }
      }
      return null
    })()`)

  const clickAt = async (p) => {
    if (!p) return false
    await s.mouse(p.x, p.y)
    return true
  }

  /* 选文件那个框：**从浏览器那一侧塞文件进去**（CDP 拦截，不是往页面里造 File 对象）——
     不这么干的话，按钮压根没接线也照样绿。 */
  let chooser = null
  s.onEvent = (m, p) => {
    if (m === 'Page.fileChooserOpened') chooser = p
  }
  await s.send('DOM.enable')
  await s.send('Page.setInterceptFileChooserDialog', { enabled: true })

  /** 走一遍"点工具条那颗 → 真选文件 → 交上去"。返回的 bookmark 用来判断框开没开。 */
  async function pickFile(abs) {
    chooser = null
    const btn = await rectOfText('.bd-tools .bd-t', '插入 PDF')
    if (!btn) return { ok: false, why: '工具条上找不到「📄 插入 PDF/PPT」那颗' }
    await clickAt(btn)
    const asked = await until(async () => chooser || undefined, { timeout: 8000, what: '弹出选文件那个框' })
    if (!asked.ok || !chooser || !chooser.backendNodeId) return { ok: false, why: '点了插入，选文件那个框没开' }
    await s.send('DOM.setFileInputFiles', { files: [abs], backendNodeId: chooser.backendNodeId })
    return { ok: true }
  }

  await open()

  /* ── [1] 一张图片 = 一份一页的资料 ───────────────────────────────────── */
  const r1 = await pickFile(ZZ_PIC)
  if (!r1.ok) bad(r1.why)
  else {
    const saved = await untilFile((d) => (d.docs || []).some((x) => x.path === ZZ_PIC_REL), { timeout: 25000, what: '板上有那份图片资料' })
    if (saved.ok) ok('★ 一张图片插进去 = 一份资料（落盘了）')
    else bad('图片没落成资料（等了 25 秒）')

    const cell = await until(
      async () =>
        (await s.eval(`(() => {
          const pages = document.querySelectorAll('.bd-docpage')
          const lay = document.querySelector('.bd-doclayer')
          if (!lay || !pages.length) return null
          return { docs: Number(lay.dataset.docs || 0), pages: pages.length }
        })()`)) || undefined,
      { timeout: 15000, what: '资料层页面出现在 DOM 里' }
    )
    if (cell.ok && cell.value.pages === 1) ok('这一份**就是一页**（一张图 = 一页，不多不少）')
    else bad('页面数量不对：' + JSON.stringify(cell.value))

    /* ★ 像素证明：那一页不是一张白纸 —— canvas 中心要是那个红色。 */
    const px = await until(
      async () =>
        (await s.eval(`(() => {
          const cv = document.querySelector('.bd-docpage canvas')
          if (!cv || !cv.width) return null
          try {
            const d = cv.getContext('2d').getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data
            return [d[0], d[1], d[2]]
          } catch (e) { return null }
        })()`)) || undefined,
      { timeout: 15000, what: '那一页画出像素来了' }
    )
    const near = px.ok && Math.abs(px.value[0] - 200) < 40 && px.value[1] < 90 && px.value[2] < 90
    if (near) ok('★ 那一页真画出来了（读到 fixture 那个颜色 rgb(' + px.value.join(',') + ')，不是白纸）')
    else bad('图片那一页没画出来：' + JSON.stringify(px.value))
  }

  /* ── [2][3] 一本 25 页的书：要问他要哪几页，抽出来就只有那几页 ─────────── */
  const r2 = await pickFile(ZZ_BOOK)
  if (!r2.ok) bad(r2.why)
  else {
    const asked = await until(async () => (await s.eval(`!!document.querySelector('[data-ask="doc-pages"]')`)) || undefined, {
      timeout: 25000,
      what: '「这本书有 25 页」那个窗浮出来',
    })
    if (asked.ok) ok('★ 够厚的书插进来时**自动问他要哪几页**（正是他那句"为一道题传一本 PDF 太费事"）')
    else bad('厚书插进来没问页码（他照样得传整本）')

    const hintN = await s.eval(`((document.querySelector('.bd-slice-title') || {}).textContent || '').trim()`)
    if (/25/.test(hintN)) ok('窗里写清了这本书有 25 页（他要知道自己选的是哪本）')
    else bad('窗里没写页数：' + hintN)

    /* 打字走真输入法那只 (`Input.insertText`)，"2,4" 里的逗号要真的到输入框里。
       为什么不直接往 DOM 里塞 value：那样验不到"逗号会不会被吃掉"（分段页数全靠它）。 */
    const p = await s.eval(`(() => { const t = document.querySelector('.bd-slice-in'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.left + 24), y: Math.round(r.top + 12) } })()`)
    if (!p) bad('窗里找不到写页码的输入框')
    else {
      await s.mouse(p.x, p.y)
      await s.sleep(120)

      /* ── [2b] 先看见那几页，再决定放不放（2026-09-21：书上的页码和 PDF 的
         页码差一点是常事，得能确认"是不是这一页"）───────────────────────
         ★ 判据用**每一页的底色**：缩略图"画出来了"谁都能做到，
           读它那个颜色才能证明画的是**第几页**。 */
      const thumbPx = (n) =>
        s.eval(`(() => {
          const b = document.querySelector('.bd-slice-thumb[data-thumb-page="${n}"]')
          if (!b) return null
          const cv = b.querySelector('canvas')
          if (!cv || !cv.width) return null
          try {
            const d = cv.getContext('2d').getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data
            return [d[0], d[1], d[2]]
          } catch (e) { return null }
        })()`)
      const isPage = (v, n) => {
        const w = pageRGB(n)
        return !!v && Math.abs(v[0] - w[0]) < 30 && Math.abs(v[1] - w[1]) < 30 && Math.abs(v[2] - w[2]) < 30
      }

      await s.send('Input.insertText', { text: '2' })
      await s.sleep(150)
      const prevOn = await until(async () => (await s.eval(`!!document.querySelector('.bd-slice-prev')`)) || undefined, {
        timeout: 15000,
        what: '预览那一块浮出来',
      })
      if (prevOn.ok) ok('★ 写了页码之后窗里就摆出缩略图（先看见，再决定放不放）')
      else bad('写了页码却看不见那几页 —— 差一页他也发现不了')

      const gotThumb = await until(
        async () => {
          const v = await s.eval(`[...document.querySelectorAll('.bd-slice-thumb')].map((b) => b.getAttribute('data-thumb-page')).join(',')`)
          return v === '1,2,3' ? v : undefined
        },
        { timeout: 20000, what: '缩略图摆出来（含旁边那一页）' }
      )
      if (gotThumb.ok) ok('★ 只挑一页时**旁边那一页**也摆出来（差一页的话，点一下就换过去）')
      else bad('缩略图那几页不对（期望 1,2,3）：' + JSON.stringify(gotThumb.value))

      const px2 = await until(async () => (await thumbPx(2)) || undefined, { timeout: 20000, what: '第 2 页的缩略图画出来' })
      if (isPage(px2.value, 2)) ok('★ 缩略图画的是**那一页**（读到夹具给第 2 页的 rgb(' + px2.value.join(',') + ')）')
      else bad('缩略图的像素不对（期望接近 rgb(' + pageRGB(2).join(',') + ')）：' + JSON.stringify(px2.value))

      /* 「往后挪一页」：偏差常常就差一页，这一下必须把那句话**写回输入框**。 */
      const fwd = await rectOfText('.bd-slice-mini', '▶')
      if (!fwd) bad('预览那排找不到「▶ 往后挪一页」')
      else {
        await clickAt(fwd)
        const shifted = await until(
          async () => {
            const v = await s.eval(`(document.querySelector('.bd-slice-in') || {}).value`)
            return v === '3' ? v : undefined
          },
          { timeout: 8000, what: '挪一页之后输入框变成 3' }
        )
        if (shifted.ok) ok('★ 「往后挪一页」把那句话**写回输入框**（2 → 3：输入框和预览不会各说一套）')
        else bad('挪一页之后输入框没跟着变：' + JSON.stringify(shifted.value))
        const px3 = await until(async () => (await thumbPx(3)) || undefined, { timeout: 20000, what: '挪完之后重画第 3 页' })
        if (isPage(px3.value, 3)) ok('★ 挪完预览跟着换（画的是第 3 页那个颜色，不是还留着第 2 页）')
        else bad('挪完预览还是旧的：' + JSON.stringify(px3.value))

        /* 放大那一层：缩略图上看不清书角印的页码，看得清才叫"确认过"。 */
        const t3 = await s.eval(`(() => { const b = document.querySelector('.bd-slice-thumb[data-thumb-page="3"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 16) } })()`)
        await clickAt(t3)
        const zoomed = await until(
          async () => {
            const v = await s.eval(`(() => { const z = document.querySelector('.bd-slice-zoom'); return z ? Number(z.getAttribute('data-slice-zoom') || 0) : 0 })()`)
            return v > 0 ? v : undefined
          },
          { timeout: 12000, what: '放大那一层打开' }
        )
        if (zoomed.ok && zoomed.value === 3) ok('★ 点缩略图能放大（第 3 页）—— 书角印的页码这下读得清')
        else bad('放大那一层没开（或开的不是这一页）：' + JSON.stringify(zoomed.value))
        const bigW = await until(
          async () => {
            const v = await s.eval(`(() => { const cv = document.querySelector('.bd-slice-zoom canvas'); return cv && cv.width ? cv.width : 0 })()`)
            return v > 600 ? v : undefined
          },
          { timeout: 15000, what: '放大那一层画出大图' }
        )
        if (bigW.ok) ok('放大那一层给的是大图（' + bigW.value + 'px 宽）')
        else bad('放大那一层没画出大图：' + JSON.stringify(bigW.value))

        await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        const zoomGone = await until(
          async () =>
            (await s.eval(`!document.querySelector('.bd-slice-zoom') && !!document.querySelector('[data-ask="doc-pages"]')`)) || undefined,
          { timeout: 8000, what: 'Esc 只收掉放大那一层' }
        )
        if (zoomGone.ok) ok('★ Esc 只收掉放大那一层，**窗还在**（他打的字没被一起扔掉）')
        else bad('Esc 把整个窗也关了 —— "看完了"不该等于"算了不传了"')
      }

      /* 回到老路：擦掉那一个字，再打 "2,4" 走原来那一段断言。
         ⚠ 先点回输入框（刚点过缩略图，焦点不在它身上 —— 退格键漏到板上就变味了）。 */
      await s.mouse(p.x, p.y)
      await s.sleep(120)
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await s.send('Input.insertText', { text: '2,4' })
      await s.sleep(120)
      const typed = await s.eval(`(document.querySelector('.bd-slice-in') || {}).value`)
      if (typed === '2,4') ok('页码打进去了')
      else bad('页码没进去：' + JSON.stringify(typed))

      const go = await rectOfText('.bd-slice-btn', '只放这几页')
      await clickAt(go)
      const cut = await untilFile((d) => (d.docs || []).some((x) => Array.isArray(x.pages) && x.pages.length === 2), {
        timeout: 30000,
        what: '板上出现一份只有两页的资料',
      })
      if (cut.ok) {
        const two = (cut.value.docs || []).find((x) => Array.isArray(x.pages) && x.pages.length === 2)
        ok(`★ 抽出来了：板上那一份只有 ${two.pages.length} 页（原书 25 页）`)
        const name = String(two.path || '')
        if (/第\s*2、4\s*页/.test(name) || /2/.test(name)) ok('文件名字带着抽的那几页：' + name)
        else bad('抽出来的名字没带页码：' + name)
        const whole = (cut.value.docs || []).some((x) => (x.pages || []).length === 25)
        if (!whole) ok('★ 整本 25 页没被端上来（他要的就是这个）')
        else bad('整本也一起上去了 —— 抽页没生效')
      } else bad('抽完之后板上没出现那份两页的资料')

      const pageCount = await s.eval(`document.querySelectorAll('.bd-docpage').length`)
      if (pageCount === 3) ok('画布上一共三页（一张图 + 抽出来的两页）')
      else bad('画布上的页数不对：' + pageCount)
    }
  }

  /* ── [4] Esc = 算了：什么都不该发生 ───────────────────────────────────── */
  const docsBefore = await untilFile(() => true, { what: '读一版当前的板' })
  const beforeCount = ((docsBefore.value || {}).docs || []).length
  const r3 = await pickFile(ZZ_BOOK)
  if (!r3.ok) bad(r3.why)
  else {
    const again = await until(async () => (await s.eval(`!!document.querySelector('[data-ask="doc-pages"]')`)) || undefined, { timeout: 25000, what: '再问一次页码' })
    if (!again.ok) bad('第二次没有再问（这次应该照旧问）')
    else {
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await s.sleep(400)
      const gone = await s.eval(`!document.querySelector('[data-ask="doc-pages"]')`)
      if (gone) ok('Esc 收得掉那个窗')
      else bad('按了 Esc，窗还在')
      await s.sleep(1200)
      const nowCount = ((await untilFile(() => true, { what: '再读一版板' })).value.docs || []).length
      if (nowCount === beforeCount) ok('★ Esc = 算了：板上没多出任何一份（选错文件来得及回头）')
      else bad(`Esc 之后资料从 ${beforeCount} 份变成 ${nowCount} 份`)
    }
  }

  /* ── [5] 页面干净、用户数据没动 ───────────────────────────────────────── */
  const errs = s.errors ? s.errors() : []
  if (!errs.length) ok('页面上没有 JS 报错')
  else bad('页面报错了：' + errs.slice(0, 3).map((e) => String((e && e.message) || e)).join(' / '))

  const moved = drift()
  if (!moved.length) ok('data/ 里原有的东西一个字节都没动')
  else bad('动到了用户的文件：' + moved.join(' / '))
})

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exitCode = fails ? 1 : 0
