/* check-look-browser：**速查**（上课突然不懂的那个词）的端到端。
 *
 * 纯逻辑那一半在 check-look.js（53 条断言，node 里跑）。这一条盯的是**只有真跑一遍
 * 才看得见**的那几件事：
 *   [1] Ctrl+K 真的唤得出那个窗（真 Ctrl 按下 —— 不是 dispatchEvent 合成的假事件）；
 *   [2] 打一个词 + 回车 → 真的只发**一次**请求、发的就是打的那个词；回来的四行
 *       摆进界面（解释 / 例 / 那几个可点的相关词）；
 *   [3] ★ **同一个词再查一次不再出网**（命中缓存标记）—— 这个功能存在的理由
 *       就是"老师第三次说到这个词"，第三次还要付钱就等于没做；
 *   [4] **不点「留到板上」一个字节都不写**（ADR-0006 那条在速查上一样成立）；
 *   [5] ★ 双击课件上的字 → 窗带着**预填的那个词**出现（不必他自己打）；
 *   [6] ★ 「留到板上」→ 板文件真多**一张**答案卡，留的内容是「词 + 讲 + 例」、
 *       卡上有出处（`ask` 指到第 1 页），紧接着 Ctrl+Z **一步**退回去；
 *   [7] 页面上没有 JS 报错；用户自己的板一个字节没动（守卫盯着）。
 *
 * ── ★★ 为什么不碰 config/ocr.json ──────────────────────────────────────
 *   check-deck / check-followup-browser 那一族是把用户的识别配置**挪开**、换上假密钥跑的。
 *   ⚠ 而今天（2026-09-28）白天的那个故障就是这么来的：脚本被掐断时还原那一步没跑到，
 *     config/ocr.json 从此停在假的测试配置上 —— 用户看到的是"AI 讲不了 PPT，44 页全失败"。
 *   所以这一条**换一条路**：出网的那一层用页面里替换掉的 `fetch` 替住，
 *     本地服务跑的是真代码，只是最后一步请求被换成假回答。
 *   ⇒ 既不需要动你的密钥文件，也不需要真的花钱，而夹在这中间那一整套（路由、
 *     拼 FormData、回声校验、拆四行、缓存）走的仍然是真代码。
 *
 * 夹具板 board-zz-look.md 和夹具 PDF .资料/zz-look-smoke.pdf 都自造自删。
 *
 * 用法：node scripts/check-look-browser.js   （或 npm run check:look-browser）
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA, withBoard } from './lib/board-check.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'
import { KEEP_BUTTON } from '../src/lib/answer-cards.js'

const FIX_PDF = path.join(DATA, '.资料', 'zz-look-smoke.pdf')
const FIX_NAME = '.资料/zz-look-smoke.pdf'

/* ── 一页自造的课件（Helvetica，ASCII）─────────────────────────────────────
 * 为什么用英文单词：手搭一个带中文/CID 字体的 PDF 是另一件事（要嵌字体），
 * 而这里要验的是"双击某个字能不能取出一个词"这条机制的接线 ——
 * 中文那一段（没有空格 ⇒ 只能靠标点断）在 check-look.js 的 [A] 里带着算好的坐标钉着。
 *
 * 那一串字摆在页面上第 (60, 300) 个点（PDF 里 y 从下往上），字号 64：
 *   x ≈ 60/720 = 0.083 起；基线 y=300 ⇒ 行的上下沿大约在 y_norm 0.30~0.47 之间。
 * ⇒ 下面双击的点取 (0.30, 0.40) —— 正好落在那一串字的当中间。 */
function buildPdf() {
  const stream = '0.9 0.9 0.9 rg 40 40 640 460 re f 0.1 0.1 0.1 rg BT /F1 64 Tf 60 300 Td (convolution) Tj ET'
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objs[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 540] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>'
  objs[5] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
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

/* ── 页面里替住出网那一层 ─────────────────────────────────────────────────
 * ⚠ 替的是 `window.fetch`，不是 '/api/lookup' 那个路由：那个路由本身（server.js）
 *   仍然被真的调 ——— 只是它转头去连 DeepSeek 的那一步被换掉。
 * ⚠ 收到的东西一律记在 window 上给自检读（发的什么词、发了几次），
 *   这些才是"前端真的把正确的东西交出去了"的证据。 */
const STUB = `
(() => {
  const orig = window.fetch
  window.__lookCalls = []
  window.fetch = function (input, init) {
    let url = ''
    try { url = typeof input === 'string' ? input : String((input && input.url) || '') } catch {}
    if (url.indexOf('/api/lookup') < 0) return orig.apply(this, arguments)
    let term = '', line = '', context = ''
    try {
      const body = init && init.body
      if (body && typeof body.forEach === 'function') {
        body.forEach((v, k) => {
          if (k === 'term') term = String(v)
          if (k === 'line') line = String(v)
          if (k === 'context') context = String(v)
        })
      }
    } catch {}
    window.__lookCalls.push({ term: term, line: line, context: context })
    const text = [
      '词：' + term,
      '讲：把一个信号翻转、平移、相乘、积分 —— 这就是它\\u3002',
      '例：输入方波 \\u2192 输出三角波。',
      '近：卷积定理, 冲激响应',
    ].join('\\n')
    const payload = JSON.stringify({
      ok: true, mode: 'lookup', text: text,
      usage: { prompt: 118, completion: 42, cached: 0, reasoning: 0 },
    })
    return Promise.resolve(new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
})()
`

/** 真 Ctrl（或 Meta）组合键：`s.key()` 是一个人都没有的组合 —— 这里得自己按住 Ctrl。 */
async function modCombo(s, k, code, vk) {
  const down = { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 162, nativeVirtualKeyCode: 162, modifiers: 2 }
  await s.send('Input.dispatchKeyEvent', down)
  /* ⚠ `char` 那一发不能省（`keypress` / 隐式提交靠它），
     而修饰键自己不许带 text（带了 CDP 会拒），见 board-check.js 里 `Session.key` 那段。 */
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 })
  await s.send('Input.dispatchKeyEvent', { type: 'char', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 162, nativeVirtualKeyCode: 162, modifiers: 0 })
  await s.sleep(280)
}

/** 一个字一个字打字（真键盘事件）。 */
async function typeWord(s, word) {
  for (const ch of word) await s.key(ch, 'Key' + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0))
}

/* ── 真·手指（2026-09-28 Surface 场景）────────────────────────────────────
   用 CDP 合成 **touch** 事件，而不是 mouse：
   长按那条路的判据是 `pointerType === 'touch' || 'pen'` ——
   用鼠标合成的话这条分支根本不会走，"平板上能不能用"这个问题就验不成。
   ⚠ `Emulation.setTouchEmulationEnabled` 必须先开：不然 Chromium 认为这台机器
     没有触摸屏，touch 事件会被丢掉（症状：`pointerdown` 一个都不来，
     而报出来是"长按没反应"这种看不出根因的错）。 */
async function touchDown(s, x, y) {
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
}
async function touchMove(s, x, y) {
  await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
}
async function touchUp(s) {
  /* ⚠ touchEnd 传的是"还剩下哪几个手指"，全松开就是**空数组**（传当前那个点会报错）。 */
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}
async function longPress(s, x, y, ms) {
  await touchDown(s, x, y)
  await s.sleep(ms)
  await touchUp(s)
  await s.sleep(320)
}

const fails = await withBoard(
  {
    tag: 'look',
    port: 5244,
    cdpPort: 9284,
    window: '1440,960',
    make: () => {
      const b = newBoard('速查自检夹具（跑完自动删除）')
      b.docs = [{ id: 'docx1', path: FIX_NAME, x: 120, y: 90, w: 720, pages: [[720, 540]] }]
      return serializeBoardDocument(b)
    },
  },
  async ({ s, ok, bad, open, read, after, until, untilSaved, untilFile, raw, drift }) => {
    fs.mkdirSync(path.dirname(FIX_PDF), { recursive: true })
    fs.writeFileSync(FIX_PDF, buildPdf())
    /* ★ 夹具必须**自己删掉**（而且是这一个文件、不是整个目录 ——
       "删的是谁的"那条纪律：用户 .资料 里那几十份书一份都不许动）。 */
    after(() => {
      try {
        fs.rmSync(FIX_PDF, { force: true })
      } catch {}
    })

    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })
    await open({ settle: 2600 })

    const had = raw()

    /* ══ [1] Ctrl+K 唤得出那个窗 ══ */
    console.log('\n[1] Ctrl+K 唤出速查窗')
    {
      const before = await s.eval(`!!document.querySelector('.bd-look')`)
      if (before) bad('打开就有窗 —— 它不该自己冒出来（ansprüche 也得是用户要的）')
      else ok('刚进来时没有那个窗（浮着的东西就该是"你唤它才出现"，不该自己冒出来）')

      await modCombo(s, 'k', 'KeyK', 75)
      const w = await until(async () => {
        const q = await s.eval(`(() => { const el = document.querySelector('.bd-look'); if (!el) return null
          const ta = el.querySelector('.bd-look-ta')
          return { title: (el.querySelector('.bd-look-title')||{}).textContent || '', value: ta ? ta.value : null, focused: !!ta && document.activeElement === ta,
                   left: Math.round(el.getBoundingClientRect().left), top: Math.round(el.getBoundingClientRect().top) } })()`)
        return q
      }, { what: '速查窗出现' })
      if (!w.ok) bad('Ctrl+K 按下去窗没出来（按键没接上 / 组件没渲染）')
      else {
        ok('Ctrl+K 唤出「' + w.value.title.trim() + '」')
        if (w.value.value === '') ok('输入框是空的（手动唤起不该替他编一个词去查 —— 那会白白花一次钱）')
        else bad('手动唤起的输入框不是空的：' + JSON.stringify(w.value.value))
        if (w.value.focused) ok('焦点直接落在输入框（唤出来就能打，不用再点一下）')
        else bad('唤出来焦点不在输入框上 —— 还得先点它才能打字')
        if (w.value.left >= 0 && w.value.top >= 0) ok('窗摆在画布里面（left=' + w.value.left + ', top=' + w.value.top + '，没有跑出屏幕）')
        else bad('窗跑到屏幕外了：' + JSON.stringify(w.value))
      }
    }

    /* ══ [2] 打一个词 + 回车 → 那四行摆进来 ══ */
    console.log('\n[2] 打字 → 回车 → 解释 / 例 / 相关词')
    await typeWord(s, 'ft')
    await s.key('Enter', 'Enter', 13)
    {
      const got = await until(async () => {
        const q = await s.eval(`(() => {
          const el = document.querySelector('.bd-look'); if (!el) return null
          return {
            say: ((el.querySelector('.bd-look-say')||{}).textContent || '').trim(),
            eg: ((el.querySelector('.bd-look-eg')||{}).textContent || '').trim(),
            chips: [...el.querySelectorAll('.bd-look-chip')].map((b) => b.textContent.trim()),
            calls: (window.__lookCalls || []).length,
          } })()`)
        return q && q.say ? q : undefined
      }, { what: '解释显示出来' })
      if (!got.ok) bad('回车之后没有解释（请求没发出去 / 回来的四行没拆开）')
      else {
        const v = got.value
        ok('解释显示出来了：' + JSON.stringify(v.say.slice(0, 24)) + '…')
        if (v.eg) ok('「例」那一行也在：' + JSON.stringify(v.eg.slice(0, 20)) + '…')
        else bad('缺「例」那一行')
        if (v.chips.length >= 2) ok('「近」是 ' + v.chips.length + ' 个可点的词（接着该懂的那个点一下就有，比重打一遍快）')
        else bad('相关词没有显示：' + JSON.stringify(v.chips))

        const calls = await s.eval(`(window.__lookCalls || [])`)
        const t0 = calls[0] || {}
        if (calls.length === 1) ok('★ 只发了**一次**请求（一次查询就该是一趟）')
        else bad('请求发了 ' + calls.length + ' 次（一次查询不该发多趟）')
        if (t0.term === 'ft') ok('发出去的就是他打的那两个字母（term=' + JSON.stringify(t0.term) + '）')
        else bad('发出去的词不对：' + JSON.stringify(t0))
      }
    }

    /* ══ [3] 同一个词再查一次 ⇒ 不再出网 ══ */
    console.log('\n[3] 同一个词第二次：命中缓存，不再花那趟钱')
    {
      const before = await s.eval(`(window.__lookCalls || []).length`)
      await s.eval(`(() => { const ta = document.querySelector('.bd-look-ta'); if (ta) ta.value = '' })()`)
      await typeWord(s, 'ft')
      await s.key('Enter', 'Enter', 13)
      const got = await until(async () => {
        const q = await s.eval(`(() => { const el = document.querySelector('.bd-look')
          if (!el) return null
          const u = el.querySelector('.bd-look-usage')
          return { usage: u ? u.textContent.trim() : '', calls: (window.__lookCalls || []).length } })()`)
        return q && q.usage ? q : undefined
      }, { what: '第二次查询有结果' })
      if (!got.ok) bad('第二次查同一个词没有结果')
      else {
        const v = got.value
        if (v.calls === before) ok('★★ 第二次**没有出网**（请求数仍是 ' + v.calls + '）—— 课堂上反复听到同一个词时，这才是它该有的样子')
        else bad('第二次又发了一次请求（' + before + ' → ' + v.calls + '）：缓存没命中')
        if (v.usage) ok('界面上写明了这一趟的来历：' + JSON.stringify(v.usage))
        else bad('没有那句"上次查过的"（用户会以为又花了一次钱）')
      }
    }

    /* ══ [4] 不留 ⇒ 板一个字节都不变 ══ */
    console.log('\n[4] 不点「留到板上」：板一个字节都不动')
    {
      await s.key('Escape', 'Escape', 27)
      const closed = await until(async () => (await s.eval(`!document.querySelector('.bd-look')`)) || undefined, { what: 'Esc 关掉那个窗' })
      if (closed.ok) ok('Esc 关掉了窗（点过按钮之后焦点不在输入框上，Esc 也得管用）')
      else bad('Esc 关不掉那个窗')
      await untilSaved().catch(() => {})
      const now = raw()
      if (now === had) ok('★★ 看了两个词、一个都没留 ⇒ 板文件**一个字节都没变**（这个功能不许替他做决定）')
      else bad('没点「留到板上」，板文件却变了')
      const doc = read()
      if (doc && (doc.cards || []).length === 0) ok('板上还是 0 张卡')
      else bad('板上冒出了卡片：' + JSON.stringify((doc && doc.cards || []).length))
    }

    /* ══ [5] 双击课件上的字 ══ */
    console.log('\n[5] 双击课件上的字 → 带着挑出来的那个词开窗')
    {
      /* S = 框选工具（笔握着的时候双击会在纸上留下两个墨点，见 Board.jsx 那段；
         这一条顺便把"提示里说的那个手势"验成真的） */
      await s.key('s', 'KeyS', 83)
      const rect = await until(async () => {
        const r = await s.eval(`(() => { const el = document.querySelector('.bd-docpage'); if (!el) return null
          const b = el.getBoundingClientRect()
          return b.width > 40 && b.height > 30 ? { x: b.left, y: b.top, w: b.width, h: b.height } : null })()`)
        return r
      }, { what: '课件那一页出现在画布上', timeout: 9000 })
      if (!rect.ok) bad('板上找不到课件那一页（夹具 PDF 没铺上来？）')
      else {
        const px = Math.round(rect.value.x + rect.value.w * 0.3)
        const py = Math.round(rect.value.y + rect.value.h * 0.4)
        await s.doubleClick(px, py)
        const got = await until(async () => {
          const q = await s.eval(`(() => { const el = document.querySelector('.bd-look'); if (!el) return null
            const ta = el.querySelector('.bd-look-ta')
            return { value: ta ? ta.value : '', say: ((el.querySelector('.bd-look-say')||{}).textContent || '').trim() } })()`)
          return q && q.value ? q : undefined
        }, { what: '双击那个字之后窗带了词出来' })
        if (!got.ok) bad('双击课件上的字没有唤出速查窗（取词失败 / 双击那条路没接上）')
        else {
          const v = got.value
          ok('★ 双击挑出来的词：' + JSON.stringify(v.value) + '（不用他自己打）')
          const waited = await until(async () => (await s.eval(`((document.querySelector('.bd-look-say')||{}).textContent || '').trim()`)) || undefined, { what: '双击之后自动查' })
          if (waited.ok) ok('开窗就自动查了（"双击"那个动作本身就是"我现在就想知道"）')
          else bad('双击开了窗却不自动查，还得再点一下「查」')
        }
      }
    }

    /* ══ [6] 「留到板上」 → 板文件多一张答案卡 ══ */
    console.log('\n[6] 「' + KEEP_BUTTON + '」→ 板文件里真多一张卡；Ctrl+Z 一步退回去')
    {
      const before = raw()
      const btn = await s.eval(`(() => { const el = document.querySelector('.bd-look-keep'); if (!el) return null
        const b = el.getBoundingClientRect()
        return { x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2), text: el.textContent.trim() } })()`)
      if (!btn) bad('找不到「' + KEEP_BUTTON + '」那颗按钮')
      else {
        await s.mouse(btn.x, btn.y)
        const grew = await untilFile((d) => (d.cards || []).length === 1, { what: '板上多出一张卡', timeout: 9000 })
        if (!grew.ok) bad('点了「留到板上」板文件没有变化（keepQuick 那一层没真的写盘）')
        else {
          const card = grew.value.cards[0]
          ok('★★ 板上多了一张卡：' + JSON.stringify(String(card.text || '').slice(0, 18)) + '…')
          if (card.answer === true) ok('卡上记着"这是一张答案卡"（`answer: true` —— 它是查来的，不是讲义）')
          else bad('这张卡没有 `answer` 标记（以后会被当成"这节课的知识"喂给下一次讲解）')
          if (card.ask && card.ask.page === 1) ok('带上出处了（`ask.page = 1` —— 这张卡属于课件的第 1 页）')
          else bad('没有出处：' + JSON.stringify(card.ask))
          if (String(card.text || '').includes('例：')) ok('留的内容里带着「例」')
          else bad('留的内容缺「例」那一段：' + JSON.stringify(card.text))
          const keptLabel = await s.eval(`((document.querySelector('.bd-look-kept')||{}).textContent || '').trim()`)
          if (keptLabel) ok('按钮变成了「' + keptLabel + '」（点完有回音，不会让人以为没点上）')
          else bad('点完之后按钮没有变成"已在板上"')
        }
      }
      /* Ctrl+Z 退回去 */
      await modCombo(s, 'z', 'KeyZ', 90)
      const undone = await until(async () => {
        const t = raw()
        return t === before ? true : undefined
      }, { what: 'Ctrl+Z 退回原样', timeout: 9000 })
      if (undone.ok) ok('★★ Ctrl+Z **一步**退回去（板文件一个字节不差 —— 贴错了可以用它撤回）')
      else bad('Ctrl+Z 没有退回到原来的样子')
      void untilSaved
    }

    /* ══ [7] 没有键盘的那半边：Surface / 平板 ══
       用户问的原话：「surface 没键盘的时候怎么摁这些快捷键」。
       这一节全程**不碰键盘**（除了最后关窗），一条条验这三个入口：
         ① 工具条那颗「🔍 速查」—— Ctrl+K 的替身；
         ② 手指按住课件上的字不放 —— 双击的替身；
         ③ ✕ 关窗 —— Esc 的替身。 */
    console.log('\n[7] 一根手指、一块板：不按 Ctrl、不双击，也能查到那个词')
    {
      /* 先把 [6] 留下那个窗关掉：**点 ✕**（这正是没有 Esc 时的退路，顺手验掉）。 */
      await s.eval(`(() => { const el = document.querySelector('.bd-look-x'); if (el) el.click(); return 1 })()`)
      const closed = await until(async () => (await s.eval(`document.querySelector('.bd-look') ? undefined : true`)) || undefined, { what: '点 ✕ 关掉窗' })
      if (closed.ok) ok('★ 点右上角的 ✕ 也能关（没键盘的时候 Esc 是摁不出来的）')
      else bad('✕ 关不掉这个窗 —— 平板上就再也退不出去了')

      /* ① 工具条那颗「🔍 速查」 */
      const b0 = await until(async () => {
        const r = await s.eval(`(() => { const el = document.querySelector('[data-tool="look"]'); if (!el) return null
          const b = el.getBoundingClientRect()
          return b.width > 8 && b.height > 8
            ? {
                x: Math.round(b.left + b.width / 2),
                y: Math.round(b.top + b.height / 2),
                text: (el.textContent || '').trim(),
                hit: String(((document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)) || {}).className) || ''),
                win: window.innerHeight,
              }
            : null })()`)
        return r
      }, { what: '工具条上有「速查」那颗按钮', timeout: 6000 })
      if (!b0.ok) bad('工具条上没有「🔍 速查」那颗按钮 —— 没键盘的用户就一个入口都没有了')
      else {
        console.log('    · 按钮落在 ' + JSON.stringify(b0.value) + '（点的那一刻这一点的宿主元素是 ' + JSON.stringify(b0.value.hit) + '）')
        /* 顺手钉一条（2026-09-28 用户点名的）：全屏**常驻**在工具条上，不收进「⋯ 更多」。
           它是上课每块板都要按一次的按钮，收进"一次课点不了几回"的那一格里等于没有。 */
        const fsBtn = await s.eval(`(() => { const el = document.querySelector('.bd-tools [data-tool="fullscreen"]'); if (!el) return 'none'
          return el.closest('.bd-more-pop') ? 'in-pop' : 'on-bar' })()`)
        if (fsBtn === 'on-bar') ok('★ 全屏那颗常驻在工具条上（⛶，不收在「⋯ 更多」里）')
        else bad('全屏按钮不在工具条上（现在是 ' + fsBtn + '）—— 「把全屏按钮拿出来」这条没落地')
        await s.mouse(b0.value.x, b0.value.y)
        /* ★★ 顺手量一次工具条的排版：工具条是 flex 换行的，往里加一颗按钮
           有可能把后面的组挤到屏幕外 —— 这个仓库的老规矩是"加一颗按钮之前先量"
           （当初量过的数据留在 `.cache/probe-cbar5.mjs`）。所以"按钮存在"不等于
           "按钮点得到"，这两句都得问一遍。 */
        const rows = await s.eval(`(() => {
          const h = window.innerHeight
          const els = [...document.querySelectorAll('.bd-t')]
          const out = els.map((el) => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), vis: b.width > 4 && b.height > 4 } })
          return { h, n: els.length, off: out.filter((o) => o.vis && (o.t < 0 || o.b > h)).length, maxBottom: Math.max(...out.map((o) => o.b)) } })()`)
        if (rows && rows.off === 0) ok('★ 加了这颗之后工具条没挤乱：' + rows.n + ' 颗按钮全都还在屏幕里（最低那颗的下沿 ' + rows.maxBottom + ' / 屏高 ' + rows.h + '）')
        else if (rows) bad('有 ' + rows.off + ' 颗工具条按钮被挤到屏幕外了（最低下沿 ' + rows.maxBottom + ' / 屏高 ' + rows.h + '）—— 这颗「速查」得挪个位或者把文字缩短')
        const up = await until(
          async () => (await s.eval(`(() => { const el = document.querySelector('.bd-look'); if (!el) return null
            const ta = el.querySelector('.bd-look-ta'); return { value: ta ? ta.value : null } })()`)) || undefined,
          { what: '点工具条那颗按钮唤出速查窗' }
        )
        if (up.ok) ok('★★ 点工具条「' + String(b0.value.text) + '」就开窗 —— 这就是 Ctrl+K 的替身')
        else bad('点了工具条那颗「速查」按钮没反应')
        /* 手工唤起不该替他编一个词去查（和 [1] 那条同一条规矩，两个入口不许分叉）。 */
        if (up.ok && up.value.value === '') ok('手动唤起的输入框是空的（不替他编词 —— 那条约定两个入口都得守住）')
        else if (up.ok) bad('点按钮唤出来的窗里有个词：' + JSON.stringify(up.value.value))
        await s.eval(`(() => { const el = document.querySelector('.bd-look-x'); if (el) el.click(); return 1 })()`)
        await s.sleep(300)
      }

      /* ② 手指按住课件上的字不放 → 查这个词。
         ⚠ 平板上没有"双击"的可靠版本：浏览器认双击的判据是两次点击落在半秒之内，
           而手指做不到那么准 —— 这条就是给他留的那条路。 */
      await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      const rect = await until(async () => {
        const r = await s.eval(`(() => { const el = document.querySelector('.bd-docpage'); if (!el) return null
          const b = el.getBoundingClientRect()
          return b.width > 40 && b.height > 30 ? { x: b.left, y: b.top, w: b.width, h: b.height } : null })()`)
        return r
      }, { what: '课件那一页在画布上', timeout: 9000 })
      if (!rect.ok) bad('板上找不到课件那一页（夹具 PDF 没铺上来？）')
      else {
        const px = Math.round(rect.value.x + rect.value.w * 0.3)
        const py = Math.round(rect.value.y + rect.value.h * 0.4)
        const cards0 = (read().cards || []).length

        /* 先钉死一条反向：**动了就不算按住**（平移、框选长得都是"按下 + 移动"，
           要是它也算长按，手指一划就会飞出一个窗）。 */
        await touchDown(s, px, py)
        for (const d of [12, 26, 44, 60]) {
          await touchMove(s, px + d, py)
          await s.sleep(40)
        }
        await s.sleep(900)
        await touchUp(s)
        const noisy = await s.eval(`(() => { const el = document.querySelector('.bd-look'); return el ? 1 : 0 })()`)
        if (!noisy) ok('★ 手指一划、没有停下 ⇒ 不弹窗（"按住"必须包含"没动"，不然一划就乱飞）')
        else {
          bad('手指按住拖出去也算长按了 —— 平移画布 / 框选都会误触出一个窗')
          await s.eval(`(() => { const el = document.querySelector('.bd-look-x'); if (el) el.click(); return 1 })()`)
          await s.sleep(300)
        }

        await longPress(s, px, py, 900)
        const got = await until(async () => {
          const q = await s.eval(`(() => { const el = document.querySelector('.bd-look'); if (!el) return null
            const ta = el.querySelector('.bd-look-ta'); return ta && ta.value ? { value: ta.value } : null })()`)
          return q
        }, { what: '手指按住不放把那个词挑了出来' })
        if (!got.ok) bad('长按课件上的字没有唤出速查窗（这条是为没有键盘的那类用户留的）')
        else {
          ok('★★ 手指按住不动 ⇒ 挑出来的词是 ' + JSON.stringify(got.value.value) + '（全程没碰键盘）')
          const said = await until(async () => (await s.eval(`((document.querySelector('.bd-look-say')||{}).textContent || '').trim()`)) || undefined, { what: '长按之后自动查' })
          if (said.ok) ok('★ 松开手之前它已经在查了（愣住的那一下就该开始干活）')
          else bad('长按开了窗却不查')
        }
        /* 关掉这节的窗（下节要验"板一个字节没动"，留着虽然不影响结论，但干净一点好查）。 */
        await s.eval(`(() => { const el = document.querySelector('.bd-look-x'); if (el) el.click(); return 1 })()`)
        await s.sleep(300)
        const wrong = (read().cards || []).length
        if (wrong === cards0) ok('一路看下来、没点「留到板上」⇒ 板上依然 ' + cards0 + ' 张卡')
        else bad('这一节动到了板上的卡（' + cards0 + ' → ' + wrong + '）')
        await s.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      }
    }

    /* ══ [8] 没有报错、用户数据没动 ══ */
    console.log('\n[8] 页面干干净净，你的板一个字节没动')
    {
      const errs = s.errors()
      if (!errs.length) ok('页面上没有 JS 报错')
      else bad('页面报错 ' + errs.length + ' 条：' + errs.slice(0, 2).join(' | '))
      const moved = drift()
      if (!moved.length) ok('★★ data/ 里你原本那些文件一个都没被改')
      else bad('你的文件被改了：' + moved.join(', '))
    }
  }
)

console.log(fails ? `\n${fails} 项失败` : '\n全部通过 —— 速查那条链路端到端是通的')
process.exitCode = fails ? 1 : 0
