/* 资料（PDF/PPT 铺上画布）的真浏览器自检。盯住五条用户真正在意的：
 *   ① 板文件里写了 docs，打开后页面上真的有那一层（data-docs / data-doc-page）；
 *   ② 页面**真的渲染出来了**（像素证明：资料页里那块深灰矩形要在屏幕上读得到）；
 *   ③ ★ **笔能写在资料上**（这是整个功能的立身之本）：用笔划一道，
 *      墨迹层多了一笔 —— 注释不需要任何新机制，因为它本来就存世界坐标；
 *   ④ 拖把手条 = 整份资料挪位置（落进文件），✕ = 移掉（文件里 docs 空了，
 *      而写过的注释还留在板上）；
 *   ⑤ 重开板，资料还在（pages 尺寸表从文件里读回来，不需要重新解析 PDF）。
 *
 * 它自己起服务（5225）和 headless Edge（9265），跑完都收掉；
 * 全程只碰自己造的夹具板 board-zz-doccheck.md 和夹具 PDF .资料/zz-doc-smoke.pdf，
 * 用户的板一个字节都不动（.cache/lost-found 守卫照常盯着）。
 *
 * 用法：node scripts/check-doc.js   （或 npm run check:doc）
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard, DATA } from './lib/board-check.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'
import { buildMultipart } from '../src/lib/multipart.js'

/* ── 造一份最小的真 PDF（两页，每页一块深灰矩形 + 一个大页码）──
 * 手写 PDF 字节，不引第三方：这个仓库的自检不给 node_modules 添负担。
 * xref 偏移按字节算准 —— pdf.js 对烂 xref 也能救，但没必要赌。 */
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
    objs[pno] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cno} 0 R >>`
    const stream = `0.25 0.25 0.25 rg 90 120 415 600 re f BT /F1 96 Tf 1 1 1 rg 120 640 Td (P${i + 1}) Tj ET`
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

const FIX_PDF = path.join(DATA, '.资料', 'zz-doc-smoke.pdf')

/* 夹具板：一份两页的资料摆在 (0,0)，宽 720。 */
function makeBoard() {
  const b = newBoard('doc 自检夹具（跑完自动删除）')
  b.docs = [
    { id: 'doczzsmoke1', path: '.资料/zz-doc-smoke.pdf', title: '冒烟课件', x: 0, y: 0, w: 720, pages: [[595, 842], [595, 842]] },
  ]
  return serializeBoardDocument(b)
}

const fails = await withBoard(
  { tag: 'doccheck', port: 5231, cdpPort: 9271, make: makeBoard },
  async ({ s, ok, bad, open, until, untilFile, untilSaved, after }) => {
    /* 夹具 PDF：放进去（守卫不看点开头目录，所以要自己登记收尾删除）。 */
    fs.mkdirSync(path.dirname(FIX_PDF), { recursive: true })
    fs.writeFileSync(FIX_PDF, buildPdf(2))
    after(() => {
      try {
        fs.rmSync(FIX_PDF, { force: true })
      } catch {}
    })

    await open()

    /* 页面上的资料读数 */
    const PROBE = `(() => {
      const layer = document.querySelector('.bd-doclayer')
      const pages = [...document.querySelectorAll('.bd-docpage')]
      return {
        layer: !!layer,
        docsAttr: layer ? layer.dataset.docs : null,
        pages: pages.map((p) => ({
          n: p.dataset.docPage,
          path: p.dataset.docPath,
          hasCanvas: !!p.querySelector('canvas'),
          w: Math.round(p.getBoundingClientRect().width),
          h: Math.round(p.getBoundingClientRect().height),
          left: Math.round(p.getBoundingClientRect().left),
          top: Math.round(p.getBoundingClientRect().top),
        })),
        bar: (() => { const b = document.querySelector('.bd-docbar'); return b ? { id: b.dataset.docBar, at: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) } })() } : null }),
        insertBtn: !![...document.querySelectorAll('.bd-tools .bd-t')].find((x) => x.textContent.includes('PDF/PPT')),
      }
    })()`

    console.log('\n[1] 打开板：资料层挂上了，两页都摆出来了')
    {
      const st = await until(async () => {
        const p = await s.eval(PROBE)
        return p.layer && Number(p.docsAttr) === 1 ? p : undefined
      }, { timeout: 10000, what: '.bd-doclayer 出现' })
      if (!st.ok) {
        /* 失败时把现场 dump 出来：eval 有没有抛、最小探针读到什么 —— 别只报一句"没挂上"。 */
        let dump = null
        try {
          dump = await s.eval(`(() => ({
            layer: !!document.querySelector('.bd-doclayer'),
            docsAttr: (document.querySelector('.bd-doclayer') || {}).dataset ? document.querySelector('.bd-doclayer').dataset.docs : null,
            world: !!document.querySelector('.bd-docworld'),
            pages: document.querySelectorAll('.bd-docpage').length,
            save: (document.querySelector('.bd-save') || {}).textContent || '',
            rect: (() => { const r = document.querySelector('.bd-doclayer'); if (!r) return null; const b = r.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] })(),
          }))()`)
          /* 顺手把 PROBE 自己跑一遍 —— 它要是有语法错误，until 会静默吞 10 秒。 */
          try {
            const p2 = await s.eval(PROBE)
            dump.probeOk = !!p2
            dump.probeLayer = p2 && p2.layer
            dump.probeDocsAttr = p2 && p2.docsAttr
          } catch (e2) {
            dump.probeError = String((e2 && e2.message) || e2).slice(0, 300)
          }
        } catch (e) {
          dump = 'eval 抛了：' + String(e && e.message ? e.message : e)
        }
        console.log('  （现场：' + JSON.stringify(dump) + '）')
        console.log('  （页面报错：' + (s.errors().length ? s.errors().join(' ｜ ') : '无') + '）')
        bad('资料层没挂上（找不到 .bd-doclayer / data-docs != 1）')
        return
      }
      const p = st.value
      ok('资料层挂上了（data-docs=1）')
      if (p.pages.length === 2 && p.pages[0].n === '1' && p.pages[1].n === '2') ok('两页都摆出来了（页序 1、2）')
      else bad('页面数量/页序不对：' + JSON.stringify(p.pages.map((x) => x.n)))
      if (p.pages[0].w > 100 && p.pages[0].h > 100) ok(`第一页在屏幕上有真实的占位（${p.pages[0].w}×${p.pages[0].h}px）`)
      else bad('第一页占位是 ' + JSON.stringify(p.pages[0]) + '（世界坐标没映射到屏幕？）')
      if (p.pages[1].top >= p.pages[0].top + p.pages[0].h - 2) ok('第二页在第一页**下面**（竖排长卷）')
      else bad('第二页不在第一页下面：' + JSON.stringify(p.pages.map((x) => x.top)))
      const wbar = await until(async () => {
        const b = await s.eval(`(() => { const el = document.querySelector('.bd-docbar'); return el ? { id: el.dataset.docBar, worldKids: [...(document.querySelector('.bd-world') || { children: [] }).children].map((c) => c.className || c.tagName).slice(0, 8) } : null })()`)
        return b
      }, { timeout: 12000, what: '把手条出现' })
      if (wbar.ok) ok(`把手条在（等了 ${wbar.waited}ms；.bd-world 里是 ${JSON.stringify(wbar.value.worldKids)}）`)
      else bad('找不到把手条 .bd-docbar（等了 ' + wbar.waited + 'ms）')
      if (p.insertBtn) ok('工具条上有「插入 PDF/PPT」')
      else bad('工具条上没有插入按钮')
    }

    console.log('\n[2] 像素证明：页面真的渲染出来了（pdf.js 真的画了）')
    {
      const painted = await until(async () => {
        return await s.eval(`(() => {
          const cv = document.querySelector('.bd-docpage canvas')
          if (!cv || !cv.width) return null
          const ctx = cv.getContext('2d')
          const d = ctx.getImageData(Math.round(cv.width / 2) - 4, Math.round(cv.height / 2) - 4, 8, 8).data
          let min = 999
          for (let i = 0; i < d.length; i += 4) { const lum = (d[i] + d[i + 1] + d[i + 2]) / 3; if (lum < min) min = lum }
          return min < 200 ? min : undefined
        })()`)
      }, { timeout: 15000, what: '页面 canvas 里有深灰像素' })
      if (!painted.ok) {
        bad('页面 canvas 一直没画出深灰像素 —— pdf.js 没渲染')
        return
      }
      ok(`页面 canvas 画出来了（中心最暗 ${painted.value}）`)
      const shot = await s.send('Page.captureScreenshot', { format: 'png' })
      const px = await s.eval(`(async () => {
        const img = new Image()
        img.src = 'data:image/png;base64,' + ${JSON.stringify(shot.data)}
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width; cv.height = img.height
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const pg = document.querySelector('.bd-docpage')
        if (!pg) return null
        const r = pg.getBoundingClientRect()
        const dpr = img.width / window.innerWidth
        const bx = Math.round((r.left + r.width * 0.5) * dpr)
        const by = Math.round((r.top + r.height * 0.5) * dpr)
        const d = ctx.getImageData(bx - 8, by - 8, 16, 16).data
        let min = 999, max = -1
        for (let i = 0; i < d.length; i += 4) {
          const lum = (d[i] + d[i + 1] + d[i + 2]) / 3
          if (lum < min) min = lum
          if (lum > max) max = lum
        }
        return { min: Math.round(min), max: Math.round(max) }
      })()`)
      if (px && px.min <= 120) ok(`屏幕上页面中心读到了深灰（${px.min}~${px.max}）—— 真的上屏了`)
      else bad('页面中心一片白（' + JSON.stringify(px) + '）—— 画了 canvas 但没上屏（层叠/变换有问题）')
    }

    console.log('\n[3] ★ 笔能写在资料上（注释不需要新机制）')
    {
      const spot = await s.eval(`(() => {
        const pg = document.querySelector('.bd-docpage')
        const hit = document.querySelector('.bd-hit')
        if (!pg) return null
        const r = pg.getBoundingClientRect()
        const x = Math.round(r.left + r.width * 0.3)
        const y = Math.round(r.top + r.height * 0.85)
        /* 落点必须真穿到收事件层（页面不吃指针就是这句话的证明） */
        return { x, y, hitsHit: document.elementFromPoint(x, y) === hit }
      })()`)
      if (!spot) bad('找不到页面来落笔')
      else {
        if (spot.hitsHit) ok('页面上的落点穿到了收事件层（页面不挡笔）')
        else bad('页面挡住了落点（elementFromPoint 不是 .bd-hit）—— 笔会写不上去')
        await s.penStroke({ x: spot.x, y: spot.y }, { x: spot.x + 120, y: spot.y - 40 })
        const w = await until(async () => {
          const n = await s.eval(`(document.querySelector('canvas.bd-ink') || { dataset: {} }).dataset.strokes || '0'`)
          return n !== '0' ? n : undefined
        }, { what: '墨迹层多了一笔' })
        if (w.ok) ok(`在资料页上写出了一笔（墨迹层 strokes=${w.value}）`)
        else bad('在资料上落笔没有留下墨迹 —— 注释画不上去')
      }
    }

    console.log('\n[4] 拖把手条 = 整份资料挪位置（会落进文件）；✕ = 移掉')
    {
      let lastBar = null
      /* fitView 的已知行为：长卷装不下（缩放下限 0.55），第一页顶部会顶出视口上方，
         把手条（悬在第一页顶上）跟着在屏幕外。先中键往下平移，把 bar 拉进视口。 */
      await s.drag(720, 450, 0, 420, { button: 'middle', steps: 6 })
      const barReady = await until(async () => {
        const t = await s.eval(`(() => {
          const el = document.querySelector('.bd-docbar-t')
          if (!el) return null
          const r = el.getBoundingClientRect()
          const cx = Math.round(r.left + r.width / 2)
          const cy = Math.round(r.top + r.height / 2)
          return { x: cx, y: cy, hit: (document.elementFromPoint(cx, cy) || {}).className, cx, cy }
        })()`)
        if (t && t.y != null) lastBar = t
        /* 命中的是按钮**里面**的 span（名字/页数）也算 —— 事件会冒泡到按钮上。 */
        return t && String(t.hit || '').startsWith('bd-docbar') && t.y >= 40 ? t : undefined
      }, { timeout: 6000, what: '把手条进视口且点得到' })
      if (!barReady.ok) {
        bad('把手条拖不进视口（平移没生效？）—— 平移后 bar 在 ' + JSON.stringify(lastBar))
        return
      }
      ok(`把手条在视口内、elementFromPoint 命中它自己（${barReady.value.x},${barReady.value.y}）`)
      await s.drag(barReady.value.x, barReady.value.y, 60, 40, { button: 'left' })
      const w = await untilFile((d) => d.docs && d.docs[0] && (d.docs[0].x > 30 || d.docs[0].y > 20), { timeout: 8000, what: '资料坐标挪进了文件' })
      if (w.ok) ok(`拖动落进了文件（x=${w.value.docs[0].x}, y=${w.value.docs[0].y}）`)
      else bad('拖了把手条，文件里的 x/y 没动 —— 拖动没接上')
      const x = await s.eval(`(() => {
        const b = document.querySelector('.bd-docbar-x')
        if (!b) return null
        const r = b.getBoundingClientRect()
        const cx = Math.round(r.left + r.width / 2)
        const cy = Math.round(r.top + r.height / 2)
        const hit = (document.elementFromPoint(cx, cy) || {}).className || ''
        return { x: cx, y: cy, ok: hit.includes('bd-docbar-x') || hit === 'bd-docbar' }
      })()`)
      if (!x || !x.ok) bad('移除按钮 ✕ 不在视口内 / 点不到（elementFromPoint ≠ 自己）')
      else {
        /* 先等上一步的存盘落地，再点 —— 别让"正在写盘"和"移除"挤在一起。 */
        await untilSaved()
        await s.mouse(x.x, x.y)
        const w2 = await untilFile((d) => !d.docs || d.docs.length === 0, { timeout: 8000, what: 'docs 从文件里清空' })
        if (w2.ok) ok('✕ 把资料移掉了（文件里 docs 空了）')
        else bad('点了 ✕，文件里 docs 还在 —— 移除没生效')
        const kept = await until(async () => {
          const n = await s.eval(`(document.querySelector('canvas.bd-ink') || { dataset: {} }).dataset.strokes || '0'`)
          return n !== '0' ? n : undefined
        }, { timeout: 2500 })
        if (kept.ok) ok(`资料移掉了，写过的注释还在（strokes=${kept.value}）—— 那才是"移掉资料"的正确语义`)
        else bad('资料移掉之后，刚才写的那笔也没了 —— 删多了')
      }
    }

    console.log('\n[5] 重开板：pages 尺寸表从文件里读回来（不用重新解析 PDF）')
    {
      /* [4] 末尾 docs 已经被移空了 —— 把夹具内容重新写回盘，再整页重开一次。 */
      const put = await s.eval(`fetch('/api/file/' + encodeURIComponent(${JSON.stringify('board-zz-doccheck.md')}), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ${JSON.stringify(makeBoard())} }) }).then(r => r.json())`)
      if (!put || !put.ok) bad('夹具写不回去（PUT /api/file 失败）—— 重开这条没验成')
      await open({ settle: 2600 })
      const p = await until(async () => {
        const st = await s.eval(PROBE)
        return st.layer && st.pages.length === 2 ? st : undefined
      }, { what: '重开后资料层回来' })
      if (!p.ok) bad('重开后资料层没回来（pages 没从文件恢复？）')
      else {
        ok('重开后资料层回来了（两页）')
        const cv = await s.eval(`!!document.querySelector('.bd-docpage canvas')`)
        if (cv) ok('页面重新交给 pdf.js 渲染（懒渲染照常工作）')
        else bad('重开后页面上连 canvas 都没有')
      }
    }

    console.log('\n[6] 上传接口：POST /api/doc/upload 落盘 + GET /api/doc/file 原样下发')
    {
      const app = `http://127.0.0.1:5231`
      const pdf = buildPdf(1)
      const mp = buildMultipart([{ name: 'file', filename: 'zz-doc-upload.pdf', type: 'application/pdf', data: pdf }])
      const up = await fetch(app + '/api/doc/upload', { method: 'POST', headers: { 'Content-Type': mp.contentType }, body: mp.body }).then((r) => r.json())
      const UP_PDF = path.join(DATA, '.资料', 'zz-doc-upload.pdf')
      after(() => {
        try {
          fs.rmSync(UP_PDF, { force: true })
        } catch {}
      })
      if (up && up.ok && up.path === '.资料/zz-doc-upload.pdf') ok(`上传落盘成功（${up.path}）`)
      else bad('上传接口没回 ok：' + JSON.stringify(up))
      if (fs.existsSync(UP_PDF) && fs.readFileSync(UP_PDF).equals(pdf)) ok('盘上那份和发出去的字节一致')
      else bad('落盘的 PDF 和上传的不一致')
      /* 下发：整份文件原样回来（pdf.js 就靠这个地址拉文件）。 */
      const down = await fetch(app + '/api/doc/file/' + encodeURIComponent('.资料/zz-doc-upload.pdf'))
      const buf = Buffer.from(await down.arrayBuffer())
      if (down.status === 200 && buf.equals(pdf)) ok('GET 下发原样（200，' + buf.length + ' 字节）')
      else bad('下发不对（status=' + down.status + '，' + buf.length + ' 字节）')
      /* 穿越必须拒：路径里塞 .. 不该读到 data/ 外面的东西。 */
      const evil = await fetch(app + '/api/doc/file/' + encodeURIComponent('../package.json'))
      if (evil.status === 400 || evil.status === 404) ok('路径穿越被拒（../ → ' + evil.status + '）')
      else bad('路径穿越居然通了（../ → ' + evil.status + '）—— 这是安全问题')
      /* 拒不认的格式。 */
      const bad2 = buildMultipart([{ name: 'file', filename: 'x.exe', type: 'application/octet-stream', data: Buffer.from('MZ') }])
      const rej = await fetch(app + '/api/doc/upload', { method: 'POST', headers: { 'Content-Type': bad2.contentType }, body: bad2.body }).then((r) => r.json())
      if (rej && rej.error && /PDF|PPT/i.test(rej.error)) ok('非 PDF/PPT 被拒（' + rej.error + '）')
      else bad('x.exe 没被拒：' + JSON.stringify(rej))
    }

    console.log('\n[7] 整个流程跑下来，页面里没有 JS 报错')
    const errs = s.errors()
    if (!errs.length) ok('没有报错')
    else bad(`页面里有 ${errs.length} 条报错：` + errs.slice(0, 3).join(' ｜ '))
  }
)

process.exitCode = fails ? 1 : 0
