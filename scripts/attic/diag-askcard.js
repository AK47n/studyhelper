/* diag-askcard：**没有断言**的探针 —— 只为回答一个问题：
 * 「？问这里」在**圈住课件页**和**圈住页面旁边那张讲解卡**这两种情形下，
 *   到底亮不亮、点了说什么。
 *
 * 用户 2026-09-22：「现在问这里功能依旧无法框选ppt与解说卡片」。
 * 要修它，先得知道它现在是什么形状 —— 猜是修不好的。
 *
 * 用法：node scripts/diag-askcard.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard, DATA } from './lib/board-check.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'
import { ASK_BUTTON } from '../src/lib/followup.js'

const FIX_PDF = path.join(DATA, '.资料', 'zz-askdiag.pdf')
const FIX_NAME = '.资料/zz-askdiag.pdf'

/* 两页的夹具 PDF（和 check-followup-browser 同一份手写字节）。 */
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

/* 一份两页资料（0,0,宽 600，页高 450，页距 20）+ 两张"讲解卡"：
   一张**钉住**（课件整理落下来的就是钉住的）、一张不钉 —— 两种都要看。 */
const DOC_W = 600
const CARD_X = DOC_W + 44
function makeBoard() {
  fs.mkdirSync(path.dirname(FIX_PDF), { recursive: true })
  fs.writeFileSync(FIX_PDF, buildPdf(2))
  const b = newBoard('askdiag 夹具（跑完自动删）')
  b.docs = [{ id: 'doczzad1', path: FIX_NAME, title: '诊断课件', x: 0, y: 0, w: DOC_W, pages: [[720, 540], [720, 540]] }]
  /* ⚠ 卡片上带 `ask: { doc, page }` —— 课件整理落下来的讲解卡就是这么写的
     （placeDeckCards 把它在讲第几页写进卡里），圈住它时「？问这里」靠这个认页码。
     最后一张**故意不带**：那是一张自己写的笔记，圈它不该亮。 */
  b.cards = [
    { id: 'czzad_lock', kind: 'note', x: CARD_X, y: 40, w: 400, h: 240, text: '第 1 页 · 讲解（钉住的）', locked: true, ask: { doc: FIX_NAME, page: 1 } },
    { id: 'czzad_free', kind: 'note', x: CARD_X, y: 320, w: 400, h: 240, text: '第 2 页 · 讲解（没钉）', locked: false, ask: { doc: FIX_NAME, page: 2 } },
    { id: 'czzad_plain', kind: 'note', x: CARD_X, y: 600, w: 400, h: 200, text: '手写的笔记（没记页码）', locked: true },
  ]
  return serializeBoardDocument(b)
}

const out = []
const say = (s) => {
  out.push(s)
  console.log(s)
}

await withBoard(
  { tag: 'askdiag', port: 5243, cdpPort: 9283, make: makeBoard, settleMs: 2400 },
  async ({ s, open, after, until }) => {
    after(() => {
      try {
        if (fs.existsSync(FIX_PDF)) fs.rmSync(FIX_PDF, { force: true })
      } catch {}
    })
    await open()

    const rectOf = (sel, attr, val) =>
      s.eval(`(() => {
        const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => !${JSON.stringify(attr)} || x.getAttribute(${JSON.stringify(attr)}) === ${JSON.stringify(val)})
        if (!e) return null
        const r = e.getBoundingClientRect()
        return { left: r.left, top: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
      })()`)

    /* 每试一次都走这一趟：切框选 → 拖框 → 读那颗按钮。 */
    async function probe(label, box) {
      await s.eval(`(() => { const b = document.querySelector('.bd-tools [data-tool="select"]'); if (b) b.click(); return true })()`)
      await s.sleep(220)
      const tool = await s.eval(`(() => { const b = document.querySelector('.bd-tools .bd-t.on'); return b ? b.getAttribute('data-tool') : null })()`)
      const at0 = await s.eval(`(() => { const e = document.elementFromPoint(${Math.round(box.x)}, ${Math.round(box.y)}); return e ? (e.className || e.tagName) : null })()`)
      const win = await s.eval(`({ w: window.innerWidth, h: window.innerHeight })`)
      const hooked = await s.eval(`(() => {
        const h = document.querySelector('.bd-hit')
        if (!h) return false
        window.__pd = 0; window.__pm = 0; window.__pu = 0
        h.addEventListener('pointerdown', () => { window.__pd += 1 }, true)
        h.addEventListener('pointermove', () => { window.__pm += 1 }, true)
        h.addEventListener('pointerup', () => { window.__pu += 1 }, true)
        return true
      })()`)
      await s.drag(Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h), { steps: 8, button: 'left' })
      await s.sleep(300)
      const ev = await s.eval(`({ pd: window.__pd, pm: window.__pm, pu: window.__pu })`)
      say('  收事件层上的指针事件: ' + JSON.stringify(ev) + (hooked ? '' : '（★ 没找到 .bd-hit，钩子没挂上）'))
      const info = await s.eval(`(() => {
        const boxEl = document.querySelector('.bd-inkbox')
        const btn = document.querySelector('.bd-inkacts button[data-tool="askink"]')
        const acts = document.querySelector('.bd-inkacts')
        return {
          inkbox: boxEl ? (() => { const r = boxEl.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } })() : null,
          acts: !!acts,
          btn: btn ? { text: btn.textContent.trim(), disabled: !!btn.disabled, ask: btn.getAttribute('data-ink-ask'), title: btn.title || '' } : null,
        }
      })()`)
      say(`\n── ${label} ──`)
      say('  当前工具: ' + tool + '   起点命中: ' + at0 + '   窗口: ' + JSON.stringify(win))
      say('  拖的框: ' + JSON.stringify(box))
      say('  虚线框: ' + JSON.stringify(info.inkbox) + (info.inkbox ? '' : '（★ 没有 —— 框选没生效）'))
      say('  动作排: ' + (info.acts ? '在' : '★ 不在'))
      if (!info.btn) say('  「？问这里」: ★ 浮层上没有这颗按钮')
      else {
        say(`  「？问这里」: ${info.btn.disabled ? '★ 灰的' : '亮的'}  data-ink-ask=${info.btn.ask}`)
        say('  灰的时候那句话: ' + info.btn.title)
      }
      /* 点一下，看它说什么（提示语是给用户的那句，也是判断"为什么不能问"的线索）。 */
      const before = await s.eval(`!!document.querySelector('.bd-ask')`)
      const btnPt = await s.eval(`(() => { const b = document.querySelector('.bd-inkacts button[data-tool="askink"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
      if (btnPt) {
        await s.mouse(btnPt.x, btnPt.y)
        const msg = await until(
          async () => {
            const t = await s.eval(`(() => { const el = document.querySelector('.toast .toast-msg'); return el ? el.textContent.trim() : '' })()`)
            return t ? t : undefined
          },
          { timeout: 2500, what: '提示语' }
        )
        const after = await s.eval(`(() => { const b = document.querySelector('.bd-ask'); return b ? Number(b.getAttribute('data-ask-page') || 0) : 0 })()`)
        say('  点了之后: 窗=' + (after ? '开了（第 ' + after + ' 页）' : '没开') + '  提示语=' + (msg.ok ? msg.value : '(没看到)'))
        if (after) {
          await s.key('Escape', 'Escape', 27)
          await s.sleep(200)
        }
      }
      /* 清掉选区，免得影响下一次 */
      await s.eval(`(() => { const b = document.querySelector('.bd-tools [data-tool="select"]'); if (b) b.click(); return true })()`)
      await s.key('Escape', 'Escape', 27)
      await s.sleep(200)
    }

    const p1 = await rectOf('.bd-docpage', 'data-doc-page', '1')
    const p2 = await rectOf('.bd-docpage', 'data-doc-page', '2')
    const cLock = await rectOf('.bd-card', 'data-card-id', 'czzad_lock')
    const cFree = await rectOf('.bd-card', 'data-card-id', 'czzad_free')
    const cPlain = await rectOf('.bd-card', 'data-card-id', 'czzad_plain')
    say('第 1 页在屏幕: ' + JSON.stringify(p1))
    say('第 2 页在屏幕: ' + JSON.stringify(p2))
    say('钉住的讲解卡: ' + JSON.stringify(cLock))
    say('没钉的讲解卡: ' + JSON.stringify(cFree))
    say('没记页码的笔记卡: ' + JSON.stringify(cPlain))

    /* ⚠ 圈卡片要从**卡片外面**起手：起手落在卡上就是"拖这张卡"（那是卡片的活），
       框选根本不会发生 —— 真人也是这么圈的，所以探针照真人的样子拖。 */
    const around = (c) => ({ x: c.left - 30, y: c.top - 30, w: c.w * 0.8, h: c.h * 0.7 })
    if (p1) await probe('① 圈住**第 1 页中间**那一块（对照：这一条自检里是亮的）', { x: p1.left + p1.w * 0.2, y: p1.top + p1.h * 0.3, w: p1.w * 0.5, h: p1.h * 0.3 })
    if (cLock) await probe('② 圈住**钉住的讲解卡**（课件整理落下来的就是这种）', around(cLock))
    if (cFree) await probe('③ 圈住**没钉的讲解卡**', around(cFree))
    if (cPlain) await probe('⑤ 圈住**没记页码的笔记卡**（对照：这一条应该还是灰的）', around(cPlain))
    if (p1 && cLock) await probe('④ 圈住**第 1 页 + 右边那张讲解卡**（跨着两边）', { x: p1.left + p1.w * 0.45, y: p1.top + p1.h * 0.2, w: cLock.left - p1.left - p1.w * 0.45 + cLock.w * 0.5, h: p1.h * 0.4 })

    const errs = await s.eval(`(() => { return window.__errs ? window.__errs.length : -1 })()`)
    say('\n（页面报错计数: ' + errs + '，-1 = 没挂这个钩子）')
  }
)

console.log('\n—— 探针结束（没有断言，上面每一行都是实情）——')
