/* 长文件的编辑区：**只画看得见的那些行**，但两层必须一层不差。
 *
 * 用户报的是"点笔记卡 1、2 秒"（2026-10-01）。根因不是解析慢（5 万行正则只要 21ms），
 * 是**一次渲染 10 万个 DOM 节点**（`.hl-line` 50073 + span 50074）。
 * 修法是分块：看不见的块用「行数 × 行高」的空盒子撑着（浏览器不必排它），
 * 只有看得见的块才逐行画。
 *
 * 这个自检盯的是**修法的底线 —— 两层还得对齐**：
 *   ① 确实分块了（节点数塌下去了，不是"改了个寂寞"）
 *   ② 着色层内容高 == textarea 内容高（着色盖在文字上，不能差）
 *   ③ 滚到底、打字之后仍然对齐（不是只对一开始那一屏有效）
 *   ④ 会折行的那一块被认出来了（认不出就会用行高去算，高度必错）
 *   ⑤ 点「笔记」→ 界面换过去要快（这条是用户报的那个"卡一下"）
 *
 * ⚠ 只在 data/ 里放一份**临时笔记**（zz-srcvirt-note.md），跑完删。
 *   不碰用户任何一个原有文件（withBoard 的 drift() 一直在盯着）。
 *
 * 用法：node scripts/check-srcvirt.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'

const DATA = path.join(import.meta.dirname, '..', 'data')
const NOTE = 'zz-srcvirt-note.md'
const NOTE_PATH = path.join(DATA, NOTE)
const ROWS = 30000
/* 这一行故意超长（会折行）—— 用来验"折行的块被认出来了" */
const LONG_ROW = 5000

function makeNote() {
  const out = []
  for (let i = 0; i < ROWS; i++) {
    if (i === LONG_ROW) out.push('- 公式 | $' + 'x + '.repeat(120) + 'y$ 这一行放不下，一定会折行')
    else if (i % 500 === 0) out.push('# 第 ' + i + ' 节')
    else if (i % 97 === 0) out.push('- 公式 | $E = mc^2$ 和第 ' + i + ' 行')
    else out.push('- 节点 | 第 ' + i + ' 行的内容 [[B]]')
  }
  return out.join('\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fails = await withBoard(
  { tag: 'srcvirt', port: 5242, cdpPort: 9282, settleMs: 3000 },
  async ({ s, ok, bad, after, open }) => {
    fs.writeFileSync(NOTE_PATH, makeNote(), 'utf8')
    after(() => {
      try {
        fs.rmSync(NOTE_PATH)
      } catch {}
    })

    await open({ settle: 1000 }) // 先开夹具板（白板模式），后面再切到笔记

    const appUrl = 'http://127.0.0.1:5242/'
    const goNote = async () => {
      await s.send('Page.navigate', { url: appUrl + '?file=' + encodeURIComponent(NOTE) })
      await sleep(2500)
    }
    await goNote()

    /* 页面里的尺子：着色层内容高 / textarea 内容高 / 块与行的数量 */
    const ruler = `(() => {
      const inner = document.querySelector('.hl-inner')
      const ta = document.querySelector('textarea.raw')
      if (!inner || !ta) return null
      const blks = [...inner.querySelectorAll('.hl-chunk')]
      if (!blks.length) return null
      const cs = getComputedStyle(ta)
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      const wrapBlocks = blks.filter((b) => b.dataset.wrap === '1').length
      const drawn = blks.filter((b) => b.classList.contains('rows')).length
      return {
        hl: blks[blks.length - 1].getBoundingClientRect().bottom - blks[0].getBoundingClientRect().top,
        ta: ta.scrollHeight - pad,
        blocks: blks.length,
        wrapBlocks,
        drawnBlocks: drawn,
        hlLines: document.querySelectorAll('.hl-line').length,
        bodyNodes: document.body.querySelectorAll('*').length,
        rows: ta.value.split('\\n').length,
      }
    })()`

    const m0 = await s.eval(ruler)
    if (!m0) return bad('编辑区的 DOM 没出来（.hl-inner / textarea.raw / .hl-chunk 缺一样）')

    /* ① 分块真的生效了 */
    if (m0.blocks > 10 && m0.hlLines < ROWS / 4) {
      ok(`分块生效：${m0.blocks} 块，只画了 ${m0.hlLines} 行（共 ${m0.rows} 行），body 节点 ${m0.bodyNodes}`)
    } else {
      bad(`没分块（块 ${m0.blocks} / 行 ${m0.hlLines} / 共 ${m0.rows}）—— 长文件还是整篇在画`)
    }

    /* ② 两层内容高必须相等（着色盖在文字上，差一点就看得见）。
       ⚠ 判据留 2.5px 的缝：**每一个块的高度浏览器要取整到 1/64px**，100 多个块
       累积下来就是 1~2px（86 万 px 上的 0.0002%，肉眼没有差别）。
       老那一档（整篇逐行）是 0，因为它没有"块"这一层。 */
    const TOL = 2.5
    const diffOf = (m) => Math.round((m.hl - m.ta) * 100) / 100
    if (Math.abs(diffOf(m0)) <= TOL) ok(`两层内容高一致（差 ${diffOf(m0)}px，容差 ${TOL}）`)
    else bad(`两层内容高差 ${diffOf(m0)}px（着色层 ${Math.round(m0.hl)} vs textarea ${Math.round(m0.ta)}）`)

    /* ④ 会折行的那一块被认出来了 */
    if (m0.wrapBlocks >= 1) ok(`折行的块认出来了：${m0.wrapBlocks} 块走"原文排版"`)
    else bad('一块折行的块都没认出来 —— 折行的高度算不出来，那一块必错')

    /* ③ 滚到底之后：最后一块要画出来，而且两层仍然对齐 */
    await s.eval(`(() => { const sc = document.querySelector('.srcscroll'); sc.scrollTop = sc.scrollHeight; return 1 })()`)
    await sleep(600)
    const m1 = await s.eval(ruler)
    if (Math.abs(diffOf(m1)) <= TOL) ok(`滚到底后两层仍一致（差 ${diffOf(m1)}px）`)
    else bad(`滚到底后两层差 ${diffOf(m1)}px`)
    const lastDrawn = await s.eval(
      `(() => { const ls = document.querySelectorAll('.hl-line'); return ls.length ? Number(ls[ls.length-1].dataset.i) : -1 })()`
    )
    /* 两条一起看：末块**画出来了**，而且**没把别的块也一并画了**（滚一圈就退化成整篇在画） */
    if (lastDrawn >= ROWS - 300 && m1.hlLines < ROWS / 4) {
      ok(`滚到底后末块画出来了（末行 ${lastDrawn}），但依然只画了 ${m1.hlLines} 行`)
    } else {
      bad(`滚到底后不对：末行 ${lastDrawn}（共 ${ROWS}）、画了 ${m1.hlLines} 行 —— 要么视口判定没跟上，要么滚一趟就退化成整篇在画`)
    }

    /* ③ 打字之后：行数 +1，两层仍然对齐 */
    await s.eval(`(() => {
      const ta = document.querySelector('textarea.raw')
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
      return 1
    })()`)
    await s.send('Input.insertText', { text: '\n- 新敲的一行 | 内容' })
    await sleep(800)
    const m2 = await s.eval(ruler)
    if (m2.rows === m0.rows + 1) ok(`打字后行数 ${m0.rows} → ${m2.rows}`)
    else bad(`打字后行数变成 ${m2.rows}（原来是 ${m0.rows}，期望 ${m0.rows + 1}）`)
    if (Math.abs(diffOf(m2)) <= TOL) ok(`打字后两层仍一致（差 ${diffOf(m2)}px）`)
    else bad(`打字后两层差 ${diffOf(m2)}px`)

    /* ⑥ 短文件（真实笔记那一档）必须**完全没变**：不分块、整篇画、两层等高。
       这一档是日常真正在用的，长文件那套不许渗进来。 */
    const SMALL = '大物/电磁感应/8.2 · 笔记.md'
    if (fs.existsSync(path.join(DATA, SMALL))) {
      await s.send('Page.navigate', { url: appUrl + '?file=' + encodeURIComponent(SMALL) })
      await sleep(1200)
      const sm = await s.eval(`(() => {
        const ls = document.querySelectorAll('.hl-line')
        const ta = document.querySelector('textarea.raw')
        if (!ls.length || !ta) return null
        const cs = getComputedStyle(ta)
        const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
        const first = ls[0], last = ls[ls.length - 1]
        return {
          lines: ls.length,
          chunks: document.querySelectorAll('.hl-chunk').length,
          rows: ta.value.split('\\n').length,
          hl: last.getBoundingClientRect().bottom - first.getBoundingClientRect().top,
          ta: ta.scrollHeight - pad,
        }
      })()`)
      if (!sm) bad('短文件那一步没量着（DOM 不全）')
      else {
        const d = Math.round((sm.hl - sm.ta) * 100) / 100
        if (sm.chunks === 0 && sm.lines === sm.rows) ok(`短文件没分块：${sm.lines} 行整篇画（${SMALL}）`)
        else bad(`短文件被分块了（块 ${sm.chunks}、行 ${sm.lines} / 共 ${sm.rows}）—— 那一档必须一个字节都不变`)
        if (Math.abs(d) <= 1) ok(`短文件两层等高（差 ${d}px）`)
        else bad(`短文件两层差 ${d}px`)
      }
    }

    /* ⑤ 点「笔记」→ 界面换过去要快（用户报的那个"卡一下"） */
    await goNote() // 回到笔记（干净起点）—— 导航会清掉页面里的东西，探针得在它**之后**装
    await s.eval(`(() => {
      window.__sw = (label, wantSel) => new Promise((res) => {
        const want = [...document.querySelectorAll('.modes .mode')].find((b) => (b.textContent||'').indexOf(label) >= 0)
        if (!want) return res(-1)
        const t0 = performance.now()
        want.click()
        const tick = () => {
          const on = document.querySelector('.modes .mode.on')
          if (on && (on.textContent||'').indexOf(label) >= 0 && document.querySelector(wantSel)) return res(Math.round(performance.now()-t0))
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      return 1
    })()`)
    await s.eval(`window.__sw('白板', '.bd-stagewrap')`)
    await sleep(1200)
    const ms = await s.eval(`window.__sw('笔记', '.center .topbar')`)
    if (ms >= 0 && ms < 900) ok(`点「笔记」→ 界面换过去 ${ms} ms（原来 1137 ms）`)
    else bad(`点「笔记」→ 界面换过去 ${ms} ms，还是太慢（阈值 900 ms）`)

    return 0
  }
)

process.exitCode = fails ? 1 : 0
