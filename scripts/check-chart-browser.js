/*
 * check-chart-browser：实验图那个窗口在**真浏览器**里跑一遍。
 *
 * check-chart（纯函数）证明了"算得对、排版对"，证明不了下面这几件
 * —— 它们只有真屏幕才答得出来：
 *   ① 「⋯ → 📈 实验图」这条入口**点得到**（菜单弹层是真容易盖住的那一族）；
 *   ② 把数据粘进去，预览里**真的出现了那些点和那条拟合线**（不是一块空白）；
 *   ③ 图下面那行字**真的印着斜率** —— 那是报告上要交的数；
 *   ④ ★ 「打印全部」交出来的那份 HTML 是**完整的一页纸**（有 SVG、有 A4、会弹打印框）
 *      —— 拦下 `window.open` 把它读出来验，而不是点一下看有没有报错；
 *   ⑤ 存盘真的落在 `data/.图表/` 里，而且读回来还是那些点。
 *
 * 用法：node scripts/check-chart-browser.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'

const SET = 'zz-图表自检'

/**
 * 用户 `Downloads/` 里**上一次**跑这个自检留下的残骸。
 *
 * ⚠⚠ 为什么会有这种东西（2026-10-05 踩到，三次跑留了三份）：headless Edge 里
 *   blob 下载**不落盘到 `setDownloadBehavior` 指定的目录**（`Page.` 和 `Browser.`
 *   两个命令都发过、都不生效、都不报错），而是退回浏览器默认目录 = 用户的
 *   `Downloads/`。下到一半被杀就留一个 `<uuid>.tmp`；下完就成了
 *   `zz-图表自检.pdf`。两者都躺在用户的下载文件夹里，用户不会知道那是自检的。
 *
 * 只认三种形状，别的**一律不碰**（用户自己下了一半的东西绝不能删）：
 *   ① `<uuid>.tmp` 且内容是 `%PDF-`（下到一半的残骸）；
 *   ② `zz-*.pdf` 且内容是 `%PDF-`（自检图集用的固定名，见文件头的 `SET`）。
 *
 * @returns {string[]} 跑完该删掉的完整路径
 */
function listStaleDownloads() {
  const dl = path.join(process.env.USERPROFILE || '', 'Downloads')
  let names = []
  try {
    names = fs.readdirSync(dl)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    const isTmp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(n)
    const isOurs = /^zz-.*\.pdf$/i.test(n)
    if (!isTmp && !isOurs) continue
    const p = path.join(dl, n)
    try {
      const fd = fs.openSync(p, 'r')
      const buf = Buffer.alloc(5)
      fs.readSync(fd, buf, 0, 5, 0)
      fs.closeSync(fd)
      if (buf.toString('latin1') === '%PDF-') out.push(p)
    } catch {}
  }
  return out
}

const fails = await withBoard(
  { tag: 'chartcheck', port: 5247, cdpPort: 9287, make: () => serializeBoardDocument(newBoard('自检夹具')) },
  async ({ s, ok, bad, open, until, after }) => {
    /* 图集是**真存到 data/.图表/** 的（要验"存盘"这一条），所以跑完必须自己删掉。
       ⚠ 只认这一个名字 —— 和 withBoard 对夹具板那条"删的是谁的"同一条规矩。 */
    const dir = path.resolve('data/.图表')
    /* ⚠⚠ **开跑前**就要清，不能只靠 `after`（2026-10-05 踩到）：
       `[5c]` 那一段是在图集名还是默认值（「实验图」）的时候存的盘，`after` 只删
       `SET.json`、删不掉它，于是留下一个 `data/.图表/实验图.json`。
       下次跑的时候 `loadNames()` 读它 → **一进窗口左列就已经 2 张图**，
       后面「点『+ 加一张』应该变 2 张」那条就变成 3 张 —— 报的是
       「加了但左列没变两张」，看着像按钮坏了，其实在抱怨上一次留下的垃圾。
       ⚠ 只删**自检自己写的那个名字**（默认图集名 + SET），用户自己存的不碰。
    */
    const JUNK = ['实验图.json', SET + '.json']
    after(() => {
      for (const n of JUNK) {
        try {
          fs.rmSync(path.join(dir, n), { force: true })
        } catch {}
      }
    })
    for (const n of JUNK) {
      try {
        fs.rmSync(path.join(dir, n), { force: true })
      } catch {}
    }

    /* ★ 开跑前先清 Downloads 里的残骸（不是只在跑完清）：
       上次被杀/被杀浏览器留下的 `zz-*.pdf` 和 `<uuid>.tmp` 会一直躺在用户的
       下载文件夹里，用户不会知道那是自检的。跑前清一次，跑完再清一次。 */
    const stale = listStaleDownloads()
    for (const f of stale) {
      try {
        fs.unlinkSync(f)
      } catch {}
    }
    if (stale.length) console.log(`  （清掉 Downloads 里 ${stale.length} 个自检残骸）`)
    after(() => {
      for (const f of listStaleDownloads()) {
        try {
          fs.unlinkSync(f)
        } catch {}
      }
    })

    await open()

    /* ── [1] ⋯ → 📈 实验图 ── */
    const more = await until(async () => {
      const r = await s.eval(`(() => { const b = document.querySelector('[data-tool="more"]'); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height } })()`)
      return r && r.w ? r : null
    }, { what: '⋯ 那颗', timeout: 8000 })
    if (!more.value) {
      bad('没找到「⋯」那颗按钮')
      return
    }
    const mr = more.value
    await s.mouse(Math.round(mr.x + mr.w / 2), Math.round(mr.y + mr.h / 2))
    const item = await until(async () => {
      const r = await s.eval(`(() => { const b = document.querySelector('[data-tool="charts"]'); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height, vis: q.width > 0 } })()`)
      return r && r.vis ? r : null
    }, { what: '实验图那一项', timeout: 4000 })
    if (!item.value) {
      bad('「⋯」点开了，但菜单里没有「📈 实验图」')
      return
    }
    const ir = item.value
    const hit = await s.eval(
      `(() => { const el = document.elementFromPoint(${Math.round(ir.x + ir.w / 2)}, ${Math.round(ir.y + ir.h / 2)}); return !!(el && el.closest('[data-tool="charts"]')) })()`,
    )
    if (!hit) {
      bad('「📈 实验图」那一项点不到（被盖住了）')
      return
    }
    await s.mouse(Math.round(ir.x + ir.w / 2), Math.round(ir.y + ir.h / 2))
    const win = await until(async () => (await s.eval(`document.querySelectorAll('[data-chartbox]').length`)) === 1 ? 1 : 0, { what: '实验图窗口', timeout: 5000 })
    if (!win.ok) {
      bad('点了实验图，窗口没出来')
      return
    }
    ok('「⋯ → 📈 实验图」点得到，窗口开了')

    /* ── [2] 粘数据 → 点上和线都出来 ── */
    const rows = '1.0\t2.05\n2.0\t4.02\n3.0\t5.98\n4.0\t8.01\n5.0\t9.97'
    await s.eval(`(() => {
      const ta = document.querySelector('[data-chart-data]')
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, ${JSON.stringify(rows)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    /* ⚠ 数 `[data-dot]` 不是 `circle` —— 图例里也有一个圈（照他的样张加的），
       混着数就会多一个，然后看着像"多画了个点"。 */
    const drew = await until(async () => {
      const n = await s.eval(`document.querySelectorAll('[data-chart-pic] [data-dot]').length`)
      return n >= 5 ? n : 0
    }, { what: '预览里出现 5 个点', timeout: 5000 })
    if (!drew.ok) {
      bad(`数据粘进去了，预览里一个点都没有（只有 ${drew.value || 0} 个圈）`)
    } else {
      ok(`预览里画出了 ${drew.value} 个数据点`)
    }
    /* ★ 默认画法是**连线**（照他的样张：三张全是"实测点 + 逐点连线"），
       所以要验斜率必须先**点一下「拟合」** —— 顺手把这个切换也验了。 */
    const fitBtn = await s.eval(`(() => { const b = document.querySelector('[data-chart-mode="fit"]'); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 } })()`)
    if (!fitBtn) {
      bad('没有「拟合」那颗按钮')
    } else {
      await s.mouse(Math.round(fitBtn.x), Math.round(fitBtn.y))
      const on = await until(async () => {
        const t = await s.eval(`(() => { const c = document.querySelector('[data-chart-mode="fit"]'); return c ? c.className : '' })()`)
        return /on/.test(t) ? true : 0
      }, { what: '切到拟合', timeout: 4000 })
      if (on.ok) ok('点「拟合」切过去了（默认是连线，照他的样张）')
      else bad('点了「拟合」没切过去')
    }
    const curve = await s.eval(`(() => { const p = document.querySelector('[data-chart-pic] path'); return p ? p.getAttribute('d') : null })()`)
    if (curve && /^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/.test(curve)) ok('拟合线画出来了（一条直的两点路径）')
    else bad(`拟合线没画出来（path = ${curve}）`)

    /* ── [3] 切到拟合之后，图下面那行字：报告上要交的那几个数 ── */
    const num = await until(async () => {
      const t = await s.eval(`(() => { const el = document.querySelector('[data-chart-num]'); return el ? el.textContent : null })()`)
      return t && /斜率/.test(t) ? t : 0
    }, { what: '斜率那一行', timeout: 4000 })
    if (num.ok) {
      /* y ≈ 2x，斜率必须落在 2 附近 —— 这条和 check-chart 里那条是同一个数，
         但这里是**屏幕上真印出来的那一行**，不是算出来的。 */
      const a = Number((num.value.match(/斜率\s*([\d.]+)/) || [])[1])
      if (Math.abs(a - 2) < 0.06) ok(`图下印着「${num.value.trim()}」，斜率和 2 对得上`)
      else bad(`图下印的是「${num.value.trim()}」，斜率该是 2 左右`)
    } else {
      bad('图下面没有印出斜率')
    }

    /* ── [4] ★ 打印：拦下 window.open，把那一页纸读出来验 ── */
    await s.eval(`(() => {
      window.__printed = null
      window.open = () => ({
        document: { write: (h) => { window.__printed = h }, close: () => {} },
      })
    })()`)
    await s.eval(`(() => { const el = document.querySelector('[data-chart-print]'); const q = el.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 } })()`)
    const pr = await s.eval(`(() => { const el = document.querySelector('[data-chart-print]'); const q = el.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 } })()`)
    await s.mouse(Math.round(pr.x), Math.round(pr.y))
    const html = await until(async () => {
      const h = await s.eval(`window.__printed || ''`)
      return h && h.length > 500 ? h : 0
    }, { what: '打印页生成', timeout: 5000 })
    if (!html.ok) {
      bad('点了「打印全部」，但没有生成那一页纸')
    } else {
      const h = html.value
      const cells = (h.match(/class="cell"/g) || []).length
      const svgs = (h.match(/<svg/g) || []).length
      if (cells >= 1 && svgs >= 1 && /A4 portrait/.test(h) && /window.print/.test(h)) {
        ok(`打印页生成了：${cells} 张、A4 竖版、打开就会弹打印框`)
      } else {
        bad(`打印页不完整：cell=${cells} svg=${svgs} A4=${/A4 portrait/.test(h)} print=${/window.print/.test(h)}`)
      }
      if (!/NaN|undefined/.test(h)) ok('打印页里没有 NaN')
      else bad('打印页里有 NaN')
    }

    /* ── [5] 加一张 → 左边那一列变两张 ── */
    await s.eval(`document.querySelector('[data-chart-add]').click()`)
    const two = await until(async () => {
      const n = await s.eval(`document.querySelectorAll('[data-chart-item]').length`)
      return n === 2 ? n : 0
    }, { what: '两张图', timeout: 4000 })
    if (two.ok) ok('「+ 加一张」下去，左列变成两张')
    else bad('加了但左列没变两张')

    /* ── [5b] ★ 新建一张要沿用上一张的画法，左列也要标出每张是哪种 ──
       前面 [2] 已经把第一张切到「拟合」了，所以这里加出来的第二张必须也是「拟合」，
       而且左列每一项都要带一个写法徽标（data-chart-item-mode）—— 几十张里一眼认出哪几张是拟合。 */
    const modes = await s.eval(`(() => {
      const items = [...document.querySelectorAll('[data-chart-item]')]
      return items.map((el) => {
        const m = el.querySelector('[data-chart-item-mode]')
        return m ? m.getAttribute('data-chart-item-mode') : null
      })
    })()`)
    if (!Array.isArray(modes) || modes.length < 2) {
      bad('加出来之后左列读不到画法徽标')
    } else if (modes[0] === 'fit' && modes[1] === 'fit') {
      ok('左列标出了每图的画法（两张都是「拟合」），新图沿用上一张')
    } else {
      bad(`新图没沿用上一张画法：左列标的是 [${modes.join(', ')}]（第一张已是拟合）`)
    }
    /* 再把第二张切成「连线」验证"每张能单独改" —— 第一张仍是拟合，两张就分开了 */
    const lineBtn2 = await s.eval(`(() => {
      const items = [...document.querySelectorAll('[data-chart-item]')]
      items[1].click()
      const b = document.querySelector('[data-chart-mode="line"]')
      if (!b) return null
      const q = b.getBoundingClientRect()
      return { x: q.left + q.width / 2, y: q.top + q.height / 2 }
    })()`)
    if (lineBtn2) {
      await s.mouse(Math.round(lineBtn2.x), Math.round(lineBtn2.y))
      const split = await until(async () => {
        const m = await s.eval(`(() => {
          const items = [...document.querySelectorAll('[data-chart-item]')]
          const a = items[0].querySelector('[data-chart-item-mode]')
          const b = items[1].querySelector('[data-chart-item-mode]')
          return a && b ? a.getAttribute('data-chart-item-mode') + '|' + b.getAttribute('data-chart-item-mode') : null
        })()`)
        return m === 'fit|line' ? true : 0
      }, { what: '两张画法分开', timeout: 4000 })
      if (split.ok) ok('每张能单独改（第一张拟合、第二张连线，两套画法共存）')
      else bad('切换第二张的画法时，第一张被带着一起改了（画法没各自独立）')
    } else {
      bad('切第二张的「连线」按钮没找到')
    }

    /* ── [5c] ★ 一张图画两条曲线（2026-10-05 加）──
       起因：他那�� `两种充电情况下的 P − t 曲线` 上有两条，之前只能画一条。
       这里全程**真点**：点「+ 在这张图上再画一条」→ 往第二个框里填数据 → 起名字 →
       验预览上真的出现两套标记、图例上写着两个名字、拟合数字是两行。 */
    const addExtra = await s.eval(`(() => {
      const items = [...document.querySelectorAll('[data-chart-item]')]
      items[0].click()
      const b = document.querySelector('[data-chart-addextra]')
      if (!b) return null
      const q = b.getBoundingClientRect()
      return { x: q.left + q.width / 2, y: q.top + q.height / 2 }
    })()`)
    if (!addExtra) {
      bad('没有「+ 在这张图上再画一条」那颗按钮')
    } else {
      await s.mouse(Math.round(addExtra.x), Math.round(addExtra.y))
      const got = await until(async () => (await s.eval(`!!document.querySelector('[data-chart-edata="0"]')`)) ? true : 0, {
        what: '第二条曲线的数据框出现',
        timeout: 4000,
      })
      if (!got.ok) {
        bad('点了「再画一条」，但没多出第二个数据框')
      } else {
        ok('「+ 再画一条」点下去，第二个数据框出来了')
        /* 往第二个框里真填数据（用原生 setter，React 才认）。 */
        await s.eval(`(() => {
          const el = document.querySelector('[data-chart-edata="0"]')
          const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          set.call(el, '1.0  1.5\\n2.0  4.2\\n3.0  6.8\\n4.0  8.9')
          el.dispatchEvent(new Event('input', { bubbles: true }))
          const nm = document.querySelector('[data-chart-ename="0"]')
          const set2 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          set2.call(nm, '加 DC-DC')
          nm.dispatchEvent(new Event('input', { bubbles: true }))
          const n0 = document.querySelector('[data-chart-s0name]')
          set2.call(n0, '直接充电')
          n0.dispatchEvent(new Event('input', { bubbles: true }))
          return 1
        })()`)
        const two = await until(async () => {
          const t = await s.eval(`(() => {
            const p = document.querySelector('[data-chart-pic]')
            if (!p) return null
            const dots = p.querySelectorAll('[data-dot]')
            const names = [...p.querySelectorAll('[data-legend]')].map((e) => e.textContent || '')
            return JSON.stringify({ dots: dots.length, circ: p.querySelectorAll('circle[data-dot]').length, rect: p.querySelectorAll('rect[data-dot]').length, hasA: names.join('|').indexOf('直接充电') >= 0, hasB: names.join('|').indexOf('加 DC-DC') >= 0 })
          })()`)
          if (!t) return 0
          const j = JSON.parse(t)
          return j.hasA && j.hasB && j.circ > 0 && j.rect > 0 ? j : 0
        }, { what: '预览里出现两条曲线 + 两套标记 + 两个名字', timeout: 5000 })
        if (!two.ok) {
          const j = two.value || {}
          bad(`第二条没画出来（点 ${j.circ || 0} / 方 ${j.rect || 0}，图例有「直接充电」${j.hasA}、「加 DC-DC」${j.hasB}）`)
        } else {
          const j = two.value
          ok(`两条曲线都在：${j.circ} 个圆点 + ${j.rect} 个方点，图例写着两个名字`)
        }
        /* 左列要标出「几条」—— 几十张里一眼看出哪张是对比图。 */
        const ns = await s.eval(`(() => { const e = document.querySelector('[data-chart-item="0"] [data-chart-item-ns]'); return e ? e.getAttribute('data-chart-item-ns') : null })()`)
        if (ns === '2') ok('左列表里这张标出了「2 条」')
        else bad(`左列表没标出这张有 2 条曲线（读到 ${ns}）`)

        /* 两条都选拟合 → 下面那几行要变两行，而且都带名字。 */
        await s.eval(`(() => { const b = document.querySelector('[data-chart-emode="0-fit"]'); if (b) b.click(); return 1 })()`)
        await s.eval(`(() => { const b = document.querySelector('[data-chart-mode="fit"]'); if (b) b.click(); return 1 })()`)
        const cap = await until(async () => {
          const t = await s.eval(`(() => { const e = document.querySelector('[data-chart-num]'); return e ? e.textContent : '' })()`)
          return t && /斜率/.test(t) && /直接充电/.test(t) && /加 DC-DC/.test(t) ? t : 0
        }, { what: '两条拟合数字都出来', timeout: 5000 })
        if (cap.ok) ok('两条都拟合时，斜率那几行每条一行、且各带名字')
        else bad(`两条都拟合了，可下面只报了一行：${cap.value || '(空)'}`)

        /* ⚠ 盘上文件那两条挪到 [6] 里查 —— 那时候图集名才刚设成 `SET`，
           在这里读会 `ENOENT`（存到了"实验图.json"去了）。
           真正要验的是"存 → 读回来两条曲线还在"，那也在 [6] 里做更顺。 */
      }
    }

    /* ── [6] 存盘：真落到 data/.图表/ 里 ── */
    await s.eval(`(() => { const el = document.querySelector('.ch-name'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(SET)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await s.eval(`document.querySelector('[data-chart-save]').click()`)
    const saved = await until(async () => {
      try {
        const t = fs.readFileSync(path.join(dir, SET + '.json'), 'utf8')
        const j = JSON.parse(t)
        return Array.isArray(j.charts) && j.charts.length ? j.charts.length : 0
      } catch {
        return 0
      }
    }, { what: '图集落盘', timeout: 6000 })
    if (saved.ok) {
      const t = fs.readFileSync(path.join(dir, SET + '.json'), 'utf8')
      const j = JSON.parse(t)
      const first = j.charts[0] || {}
      if (String(first.text || '').includes('2.05')) ok(`存下来了（${saved.value} 张，第一张的原文还在）`)
      else bad('存下来了，但第一张的原文没跟着存（下次打开就没法接着改）')
      /* ★ 多曲线的存盘（[5c] 加的第二条）：`extra` 必须真落盘，
         而且**不能存 `rows`** —— 它是从原文算出来的，两份真相会漂。 */
      if (Array.isArray(first.extra) && first.extra.length === 1 && /DC-DC/.test(first.extra[0].name || '')) {
        ok('盘上存了 extra（第二条曲线的原文和名字在文件里）')
      } else {
        bad(`盘上没存住 extra（读到 ${JSON.stringify(first.extra || null).slice(0, 60)}）—— 重新载入就只剩一条了`)
      }
      if (first.rows === undefined && (!first.extra || first.extra[0].rows === undefined)) {
        ok('盘上没存 rows（它是从原文算出来的，存两份会漂）')
      } else {
        bad('盘上存了 rows —— 改了原文它不会跟着变，两份真相会打架')
      }
    } else {
      bad('点了存盘，data/.图表/ 里没有出现文件')
    }

    /* ── [7] ★ 下载 PDF：真点、真出文件，且落在一个可控的目录里 ──
       ⚠ 必须先把下载目录指到 .cache 里 —— 不然它会存进用户的"下载"文件夹，
       那不是自检该往里扔东西的地方。
       ⚠ 失败时把**服务端到底回没回**一起报出来 —— 只说"目录里没有"分不清
       两件事：①PDF 没生成（前端/服务端的 bug）②生成了但浏览器没落盘（环境）。
       这两种的修法完全不同，不能混成一句"可能被拦了"。 */
    /* ── [7] ★ 下载 PDF：真点按钮，并验服务端真的吐出一份 PDF ──
       ⚠⚠ **别再用「文件落到某个目录」来验**（2026-10-05 踩过，一个坑三条命）：
       ① headless Edge 里 blob-URL 下载**不落盘**，`Page.setDownloadBehavior` 和
          `Browser.setDownloadBehavior` 都发过、都不生效（不报错，就是静默不写）；
       ② 它会退到**浏览器默认目录** = 用户的 `Downloads/` ——
          自检往那儿扔垃圾，用户还找不到地方删；
       ③ 断言只能报"可能被拦了"，分不清是真坏还是环境坏。
       改成：在页面里 `fetch` 同一个接口，验**状态码 + 魔数 + 体积**。
       按钮照样真点（那验的是"点了不报错、状态回到正常"），
       PDF 内容靠 fetch 验 —— 两者合起来覆盖了原来那条断言的全部意义。
       ⚠ 兜底清理见文件开头（`listStaleDownloads`，跑前跑后各清一次）。 */
    const hasDl = await s.eval(`!!document.querySelector('[data-chart-download]')`)
    if (!hasDl) {
      bad('没有「下载 PDF」那颗按钮')
    } else {
      await s.eval(`document.querySelector('[data-chart-download]').click()`)
      const done = await until(async () => {
        const t = await s.eval(`(() => { const el = document.querySelector('[data-chart-download]'); return el ? el.textContent : '' })()`)
        return t && !/出着/.test(t) ? true : 0
      }, { what: 'PDF 出完', timeout: 25000 })
      const errTxt = await s.eval(`(() => { const el = document.querySelector('.ch-err'); return el ? el.textContent : '' })()`)
      if (!done.ok || errTxt) {
        bad(`点了下载但没成功：${errTxt || '超时了'}`)
      } else {
        ok('点了「下载 PDF」，没报错、按钮状态回来了')
      }
      /* 内容另开一次请求验（blob 那条路在 headless 里落不了盘）。
         ⚠ 探针**自己造一份数据**，不去读界面上的图集 —— 那是 React state，
           在外面读不到；而且我们要验的是"接口吐不吐得出 PDF"，
           用什么数据不影响这个结论。数据就用夹具那 5 个点。 */
      const probe = await s.eval(`(async () => {
        const charts = [{ id: 'p1', name: '探针', xLabel: 'x', xUnit: 'V', yLabel: 'y', yUnit: 'mA', mode: 'fit', rows: [[1,2],[2,4],[3,6],[4,8],[5,10]] }]
        try {
          const r = await fetch('/api/charts?as=pdf&name=' + encodeURIComponent('探针'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ charts }),
          })
          const b = await r.arrayBuffer()
          const u = new Uint8Array(b)
          const head = String.fromCharCode(u[0], u[1], u[2], u[3], u[4])
          return JSON.stringify({ status: r.status, type: r.headers.get('Content-Type') || '', bytes: u.length, head })
        } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }) }
      })()`)
      let p = null
      try {
        p = JSON.parse(probe)
      } catch {}
      if (!p || p.err) bad(`PDF 接口没回：${probe}`)
      else if (p.status !== 200) bad(`PDF 接口回了 HTTP ${p.status}`)
      else if (p.head !== '%PDF-') bad(`PDF 接口回的正文开头是 ${p.head}，不是 %PDF-`)
      else if (!(p.bytes > 8000)) bad(`PDF 只有 ${p.bytes} 字节，太小了（该有字体子集）`)
      else ok(`PDF 接口正常：HTTP 200、${p.type}、${(p.bytes / 1024).toFixed(0)} KB、开头 %PDF-`)
    }

    /* ── [8] 拍照读数据那颗按钮在（真的识别要花钱，这里只验入口）── */
    const hasShot = await s.eval(`!!document.querySelector('[data-chart-shot]')`)
    if (hasShot) ok('「📷 拍照 / 选图 → 读出数据」那颗按钮在')
    else bad('没有拍照读数据的入口')
  },
)

process.exitCode = fails ? 1 : 0
