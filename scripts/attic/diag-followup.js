/* diag-followup：**框选追问**那几个坐标为什么对不上。
 *
 * 这不是自检（没有断言），是一个**探针**：把"框住的笔迹包围盒 / 资料页矩形 / 视图 /
 * 存进文件的形状"几份真实数字打出来 —— 这类"两边说法不一样"的事只有把真数字摆出来
 * 才分得清是哪一边的错。
 *
 * ── 它是为什么留下来的（2026-09-22）─────────────────────────────────────
 * check-followup-browser 里画了一笔、框住了、`.bd-inkbox` 也出来了，可是
 * `data-ink-ask` 报 0（「？问这里」永远是灰的）—— 而同一套几何在 node 的
 * check-askfollow 里**全绿**。就是靠这个探针打出的
 *   `{"fresh":{"why":"null","in":"{\"x1\":null,\"y1\":null}"}}`
 * 一眼看出：`strokesBBox` 交回来的是 `{x0,y0,x1,y1}`，而 Board 里按 `{x,y,w,h}` 读了。
 * ⚠ 它**不依赖应用里的任何调试钩子**（第一版靠 `window.__fuAsk`，那个钩子已经删了）——
 *   它只用页面上真实存在的东西（DOM 尺寸 + `/api/file` 读回来的盘上那一版）。
 *   所以以后再加坐标类功能时，这个探针照样能用。
 *
 * 用法：node scripts/diag-followup.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard, DATA } from './lib/board-check.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'

const FIX_PDF = path.join(DATA, '.资料', 'zz-fu-diag.pdf')
const FIX_NAME = '.资料/zz-fu-diag.pdf'
const DOC_W = 600

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
    objs[pno] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 540] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cno} 0 R >>`
    const stream = `0.9 0.9 0.9 rg 40 40 640 460 re f 0.15 0.15 0.15 rg 60 60 120 90 re f BT /F1 48 Tf 300 250 Td (P${i + 1}) Tj ET`
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

const fails = await withBoard(
  { tag: 'fudiag', port: 5238, cdpPort: 9278, make: () => serializeBoardDocument(makeBoard()), settleMs: 2600 },
  async ({ s, ok, bad, open, after }) => {
    after(() => {
      try {
        fs.rmSync(FIX_PDF, { force: true })
      } catch {}
    })
    await open()

    const dump = async (label) => {
      const v = await s.eval(`(() => {
        const q = (x) => document.querySelector(x)
        const wr = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
        const pages = [...document.querySelectorAll('.bd-docpage')].map((e) => ({ page: e.getAttribute('data-doc-page'), rect: wr(e) }))
        const canvas = q('canvas.bd-ink')
        return {
          strokes: canvas ? canvas.getAttribute('data-strokes') : null,
          inkbox: q('.bd-inkbox') ? wr(q('.bd-inkbox')) : null,
          inkask: q('.bd-inkask') ? q('.bd-inkask').getAttribute('data-ink-ask') : null,
          pages,
          docBars: [...document.querySelectorAll('.bd-docbar')].length,
        }
      })()`)
      const dbg = await s.eval(`(() => {
        const box = document.querySelector('.bd-inkbox')
        const mark = document.querySelector('.bd-askmark')
        const r = (e) => { if (!e) return null; const q = e.getBoundingClientRect(); return [Math.round(q.left), Math.round(q.top), Math.round(q.width), Math.round(q.height)] }
        return JSON.stringify({ inkbox: r(box), askmark: r(mark) })
      })()`)
      console.log('  ── ' + label + ' ──')
      console.log('     ' + JSON.stringify(v))
      console.log('     框：' + dbg)
      return v
    }

    await dump('打开之后（还没画）')

    const pageRect = await s.eval(`(() => {
      const e = [...document.querySelectorAll('.bd-docpage')].find((x) => x.getAttribute('data-doc-page') === '2')
      if (!e) return null
      const r = e.getBoundingClientRect()
      return { left: r.left, top: r.top, w: r.width, h: r.height }
    })()`)
    if (!pageRect) {
      bad('第 2 页没出现 —— 夹具课件没铺上，后面的探针没有意义')
      return
    }
    console.log(`  第 2 页屏幕矩形：left=${Math.round(pageRect.left)} top=${Math.round(pageRect.top)} w=${Math.round(pageRect.w)} h=${Math.round(pageRect.h)}`)
    console.log(`  ⇒ 若 stage 左上角在 (${Math.round(pageRect.left)},${Math.round(pageRect.top - pageRect.h - 20 * (pageRect.w / DOC_W))}) 一带，`)
    console.log(`     那么视图 s = ${pageRect.w} / ${DOC_W} = ${(pageRect.w / DOC_W).toFixed(3)}`)

    /* 在第 2 页中间画一笔（和自检里同一套坐标算法）。 */
    const lineY = Math.round(pageRect.top + pageRect.h * 0.35)
    await s.drag(Math.round(pageRect.left + pageRect.w * 0.3), lineY, Math.round(pageRect.w * 0.28), 8, { steps: 10, button: 'left' })
    await s.sleep(400)
    await dump('画完一笔')

    /* 切框选，框住它。 */
    await s.eval(`(() => { const b = document.querySelector('.bd-tools [data-tool="select"]'); if (b) b.click(); return true })()`)
    await s.sleep(200)
    await s.drag(
      Math.round(pageRect.left + pageRect.w * 0.2),
      Math.round(pageRect.top + pageRect.h * 0.25),
      Math.round(pageRect.w * 0.45),
      Math.round(pageRect.h * 0.25),
      { steps: 8, button: 'left' }
    )
    await s.sleep(400)
    await dump('框选之后')

    /* ★ 再往前一步：点「？问这里」，看那一圈高亮落在哪儿（这是坐标那一族的终检）。 */
    const askAt = await s.eval(`(() => {
      const b = document.querySelector('.bd-inkask')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: !!b.disabled, page: b.getAttribute('data-ink-ask') }
    })()`)
    console.log('  ── 浮层上那颗「？问这里」 ──')
    console.log('     ' + JSON.stringify(askAt))
    if (askAt && !askAt.disabled) {
      await s.mouse(askAt.x, askAt.y)
      await s.sleep(900)
      await dump('开窗之后（高亮应当和框选包围框重合）')
    }

    /* ★ 关键那一问：**板上的资料**（前端这一侧读到的）长什么样。 */
    const saved = await s.eval(`(async () => {
      const file = new URLSearchParams(location.search).get('file') || ''
      const r = await fetch('/api/file?path=' + encodeURIComponent(file))
      const d = await r.json().catch(() => null)
      if (!d) return { err: '读不到 ' + file }
      let b = null
      try { b = typeof d.content === 'string' ? JSON.parse(d.content) : d } catch (e) { return { err: String(e) } }
      return {
        docs: b.docs,
        strokes: (b.strokes || []).map((s) => ({ id: s.id, n: (s.points || []).length, head: (s.points || []).slice(0, 6), w: s.width, tool: s.tool })),
      }
    })()`)
    console.log('  ── 盘上那一版里有什么 ──')
    console.log('     docs: ' + JSON.stringify(saved.docs))
    console.log('     笔迹: ' + JSON.stringify(saved.strokes))

    const errs = s.errors()
    console.log('  页面报错：' + (errs.length ? errs.join(' | ') : '（无）'))
    ok('探针跑完了（上面那些数字就是全部结论）')
  }
)

function makeBoard() {
  const b = newBoard('followup 探针夹具（跑完自动删除）')
  b.docs = [{ id: 'doczzfudiag', path: FIX_NAME, title: '探针课件', x: 0, y: 0, w: DOC_W, pages: [[720, 540], [720, 540]] }]
  return b
}

fs.writeFileSync(FIX_PDF, buildPdf(2))
process.exitCode = fails ? 1 : 0
