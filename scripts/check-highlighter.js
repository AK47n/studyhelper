/* 荧光笔均匀度的体检：在真 canvas 上量"深浅差多少"。
 *
 * 为什么非要单独量：荧光笔"不均匀"是**像素级**的现象 ——
 * 存储层的测试（check-board.js 的 [2b]）只能保证 pressure/颜色/宽度对，
 * 保证不了"画出来是一道颜色均匀的带子"。
 * 而半透明 + 逐段 stroke 的叠加，只有真的画出来才看得见。
 *
 * 判据：画一道**弯折**的荧光笔（弯折处最容易暴露问题），
 * 然后沿着笔迹量几十个点的 RGB —— 标准差必须很小。
 * 同时用"旧的逐段画法"画同样的点做对照，让差值有说服力。
 *
 * 跑：node scripts/check-highlighter.js
 *
 * ★ 画那一道用的是**应用自己的** `paintHighlight`（从 src/lib/ink.js import 进来的真函数，
 *   连同它的两个透明度常量一起送进页面），不是照抄一份 —— 抄一份的结果是
 *   "自检断言自己的复制品"：应用改了画法或 alpha，那份自检照样绿（README 第 38 条）。
 *   ⚠ 结构上的护栏在文件末尾：静态读一遍 ink.js，确认 `drawStroke` 那条路**真的还调它**。
 *   对照用的"旧法"（逐段描、圆头叠加）是**故意**留的复制品 —— 它是历史算法，不是应用规则。
 *
 * 胶水（起服务 + 起浏览器 + CDP 会话 + 夹具板 + 用户数据守卫）都在
 * scripts/lib/board-check.js 的 withBoard 里 —— 这一节**用不到白板上的内容**
 * （它自己在页面里造两块 canvas 对照着画），夹具板只是为了"别打开用户那张板"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'
import { paintHighlight, HL_ALPHA, HL_ALPHA_LIVE } from '../src/lib/ink.js'
import { HL_COLOR, HL_WIDTH } from '../src/lib/board.js'

const fails = await withBoard({ tag: 'hlcheck', port: 5207, cdpPort: 9237, window: '1200,800' }, async ({ s, ok, bad }) => {
/* ── 下面整段原来是顶层代码，现在挪进 withBoard 的回调里；
      缩进没动 —— 几百行一起缩一遍只是假 diff，review 的时候反而看不清改了什么。 */

/* 在页面里跑一段测量脚本。
   新版：**应用自己的** `paintHighlight`（连同它的常量一起送进去）
   旧版：照抄早先的实现（逐段 stroke + 圆头 + alpha 0.32）做对照 */
const result = await s.eval(`(async () => {
  /* ★ 应用的真身：函数体是 ink.js 那一份，名字（HL_ALPHA / HL_ALPHA_LIVE）也在这一行备好 ——
     paintHighlight 只依赖这两个常量。它哪天多依赖一样东西，这里会当场炸（不是静默变假绿）。 */
  const HL_ALPHA = ${HL_ALPHA}
  const HL_ALPHA_LIVE = ${HL_ALPHA_LIVE}
  const paintHighlight = ${paintHighlight.toString()}

  const PTS = []
  for (let i = 0; i <= 40; i++) {
    // 刻意带弯折和抖动：直线看不出段间重叠，弯的地方才暴露
    PTS.push({ x: 40 + i * 16, y: 100 + Math.sin(i / 3) * 26 + (i % 2 ? 3 : -3), p: 0.5 })
  }

  const mk = () => {
    const cv = document.createElement('canvas')
    cv.width = 760; cv.height = 220
    const ctx = cv.getContext('2d')
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = ${JSON.stringify(HL_COLOR)}
    return { cv, ctx }
  }

  // ── 新版：调**应用那个**函数（一条路径一次描完）──
  const a = mk()
  paintHighlight(a.ctx, PTS, { width: ${HL_WIDTH} })

  // ── 旧版：逐段 beginPath + stroke（半透明圆头互相叠加）—— 故意留的复制品，历史算法 ──
  const b = mk()
  b.ctx.globalAlpha = 0.32
  for (let i = 0; i + 1 < PTS.length; i++) {
    b.ctx.lineWidth = ${HL_WIDTH}
    b.ctx.beginPath()
    b.ctx.moveTo(PTS[i].x, PTS[i].y)
    b.ctx.lineTo(PTS[i + 1].x, PTS[i + 1].y)
    b.ctx.stroke()
  }
  b.ctx.globalAlpha = 1

  /* 量法：**只统计笔迹中心列**，不要整张图。
     第一版把整张图里所有"看起来黄"的像素都算进去了，于是把
     抗锯齿的边缘像素也统计进来 —— 那些像素本来就会浅一点，
     给出一条永远降不下去的"底色方差"（实测新法 3.3，看起来像"还是不均匀"）。
     正确做法：对每一列 x，取该列里最深的那个像素（就是笔迹中心），
     只比较这些中心值 —— 这才是"带子本身颜色均不均匀"。 */
  const sample = (ctx) => {
    const d = ctx.getImageData(0, 0, 760, 220).data
    const vals = []
    for (let x = 20; x < 740; x++) {
      let best = 255
      for (let y = 20; y < 200; y++) {
        const o = (y * 760 + x) * 4
        const r = d[o], bl = d[o + 2]
        if (r > 200 && r - bl > 40) best = Math.min(best, bl) // 该列最深的黄
      }
      if (best < 255) vals.push(best)
    }
    return vals
  }

  const stats = (vals) => {
    if (!vals.length) return { n: 0 }
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length)
    return { n: vals.length, mean: Math.round(mean * 10) / 10, sd: Math.round(sd * 10) / 10, min: Math.min(...vals), max: Math.max(...vals) }
  }

  const va = sample(a.ctx)
  const vb = sample(b.ctx)
  return { fresh: stats(va), old: stats(vb) }
})()`)

console.log('\n  荧光笔均匀度（蓝通道越低 = 颜色越深；只取每列最深的像素 = 笔迹中心）')
console.log('  ─────────────────────────────────────────────')
console.log(`  现在（一条路径一次描） 采样 ${result.fresh.n} 列  均值 ${result.fresh.mean}  标准差 ${result.fresh.sd}  范围 ${result.fresh.min}~${result.fresh.max}`)
console.log(`  旧法（逐段描，圆头叠加） 采样 ${result.old.n} 列  均值 ${result.old.mean}  标准差 ${result.old.sd}  范围 ${result.old.min}~${result.old.max}`)
console.log('  ─────────────────────────────────────────────')

if (result.fresh.n < 300) {
  bad(`采样列太少（${result.fresh.n}）—— 没画出荧光笔，测量无效`)
} else if (result.fresh.sd <= 1.5) {
  ok(`带子颜色是均匀的：标准差 ${result.fresh.sd}（阈值 1.5）`)
} else {
  bad(`颜色还是不均匀：标准差 ${result.fresh.sd}，范围 ${result.fresh.min}~${result.fresh.max}`)
}

// 新版必须**比旧法明显更均匀**，否则说明这个改动没解决真问题
if (result.old.sd > result.fresh.sd * 1.5) {
  ok(`对比：旧法标准差 ${result.old.sd}，是现在的 ${(result.old.sd / Math.max(0.01, result.fresh.sd)).toFixed(1)} 倍 —— 确实修掉了叠加变深`)
} else {
  bad(`新旧差别不明显（旧 ${result.old.sd} vs 新 ${result.fresh.sd}）—— 这条测量可能没测到真东西`)
}

/* ★ 结构护栏：上面画的是**应用那个函数**，前提是应用那条路真的还在调它。
   谁哪天把荧光笔的画法又内联回 drawStroke（或者换了个画法），这条当场红 ——
   否则这个自检会悄悄地退化成"断言自己送进去的那份复制品"（README 第 38 条）。 */
{
  const inkSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'lib', 'ink.js'), 'utf8')
  const calls = /if \(isHi\)\s*\{[^}]*?paintHighlight\(/s.test(inkSrc)
  if (calls) ok('应用那条路真的在调 paintHighlight（这一道画的不是自检自己造的复制品）')
  else bad('ink.js 里 `if (isHi)` 那条分支不再调用 paintHighlight —— 上面量的是别的东西了')
}

})
