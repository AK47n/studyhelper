/* 板文件这一步：怎么读写 `data/` 里那些文件，以及**打开哪一个**。
 *
 * 为什么单开一个 module（2026-09-16 架构 review 的 C4）：
 *   `App.jsx` 从前自己管着这一整套 —— 四个 fetch 包装、三个"建/补文件"的函数、
 *   以及首次加载里那串四层分支（`?file=` > 列表第一张板 > 补一张空的 > 退回第一个笔记）。
 *   麻烦在于**那串分支是应用的入口行为，却只有真浏览器跑得出来**：
 *   "data/ 里一张板都没有时打开必须是白板"这条自检（`check:default`）要的正是
 *   "一张板都没有"这个场景，而本机有用户的板，它每次都跳过 ——
 *   2026-09-16 验它的时候，是把整个仓库复制到临时目录、把 `data/` 留空才跑起来的。
 *   而 `?file=<名字>`（自检专用入口）当时只是那条链上又加的一个 if。
 *
 *   现在"打开哪一个"是一个**纯决定**：`planStartup({ files, want })` 拿列表和地址栏上
 *   那个 `?file=`，回一个 step，调用方照着做。于是：
 *     · 每种入口情形（空目录 / 只有笔记 / 有板 / `?file=` 指名 / `?file=` 指了个不存在的）
 *       都能在 `check-board.js` 的 [6n] 里断言，不用真浏览器；
 *     · `check:default` 仍然是端到端对手（它跑的是真应用 + 真服务）。
 *
 * ── 分层（2026-09-17 起）───────────────────────────────────────────────────
 *   `data/` 不再必须是平的：文件可以放在子目录里（`data/大物/电磁学/board-第一章.md`），
 *   于是**每张板的身份是一个相对路径**（`name`），不是一个名字。根上的老文件里没有 `/`，
 *   一个字节都不用改。
 *   · 路径本身合法不合法、怎么拆、怎么拼、怎么摆成树 —— 全在 `src/lib/paths.js`
 *     （服务端也用同一份，别在这儿再抄一遍正则）。
 *   · 这个 module 只管两件事：**这一层（目录）叫什么**，以及**打开哪一个**。
 *
 * ── interface ─────────────────────────────────────────────────────────────
 *   createFileApi({ fetch }) → { list, get, put, create, mkdir, move }   ← data/ 的读写（URL 只在这一处）
 *   planStartup({ files, want }) → 下面几种 step 之一（纯函数：
 *     { step: 'seed', why }                        data/ 一个文件都没有 → 先放样板，再重新 plan
 *     { step: 'open', name, force, why }           打开这一个（name 是相对路径）
 *     { step: 'create-board', name, why }          一张板都没有 → 先建这张空板，再打开它
 *     { step: 'none', why }                        什么都不打开（`?file=` 指了个不存在的）
 *   nextBoardName(taken, dir) → '新白板' 那张板该叫什么（撞名往后排，探到 99；探完回 null）
 *   boardFileName(title) → 'board-<标题>.md'（只是一层里的文件名，不含目录）
 *   boardPath(dir, title) → '大物/电磁学/board-第一章.md'
 *   SEED_BOARD_NAME / NEW_BOARD_BASE
 *   （"是不是一张板"由 `board.js` 的 `isBoardName` 定 —— 它只看**最后一段**，
 *     所以 `大物/电磁学/board-第一章.md` 也是一张板；这里不重定义那套口径。）
 */

import { isBoardName } from './board.js'
import { joinPath, uniqueRelName } from './paths.js'

/** 第一次打开（data/ 完全空）时放的那张样板板 —— 名字要和 App.jsx 建它时一致 */
export const SEED_BOARD_NAME = 'board-示例 · 大物电磁学.md'
/** "一张板都没有"时补的那张空板叫这个；撞名往后排 2..99（见 nextBoardName） */
export const NEW_BOARD_BASE = '新白板'

/** 新板的文件名：标题去掉 .md 再加前缀（Git 和左栏看的是这个名字）。**不含目录。** */
export function boardFileName(title) {
  return 'board-' + String(title == null ? '' : title).trim().replace(/\.md$/i, '') + '.md'
}

/** 新板的**相对路径**：放在哪一层 + 叫什么（`boardPath('大物/电磁学', '第一章')`）。 */
export function boardPath(dir, title) {
  return joinPath(dir, boardFileName(title))
}

/** 标题里的层次：`大物/电磁学/第一章` → `{ dir: '大物/电磁学', title: '第一章' }`。
 *  用户在"这一课叫什么"里直接打路径，就是分层存储最直接的那个入口。 */
export function splitTitlePath(raw) {
  const s = String(raw == null ? '' : raw)
    .trim()
    .replace(/\.md$/i, '')
    .replace(/\\/g, '/')
  const segs = s.split('/').map((x) => x.trim()).filter(Boolean)
  const title = segs.length ? segs.pop() : ''
  return { dir: segs.join('/'), title }
}

/* 探一个还没被占用的名字：`board-新白板.md`、`board-新白板 2.md`……
 * ★ 为什么必须先探一遍：服务端 `/api/new` 撞名直接回 409，不探就是**静默失败** ——
 *   结果是"用户以为建好了，其实没建"。探到 99 就放弃（返回 null，调用方自己决定怎么办）。
 * `dir` 是打算放在哪一层（默认根上）。撞名只在**同一层里**算：不同层的两张板
 * 叫同一个名字是正常的（大物/第一章 和 模电/第一章）。 */
export function nextBoardName(taken = [], dir = '') {
  const r = uniqueRelName(taken, dir, 'board-' + NEW_BOARD_BASE)
  return r ? r.name : null
}

/* 首次加载：打开哪一个？
 * 顺序（和 README「打开哪一个」那一节一一对应）：
 *   ① data/ 里一个文件都没有 → 'seed'（先放样板板 + 样板笔记，然后重新问一次）
 *   ② 地址栏有 `?file=` → **只认这一个**：在列表里就打开，不在就**什么都不打开**
 *      （绝不退回"列表里第一个" —— 那正是自检要躲的东西，也免得用户拼错一个名字
 *        就莫名其妙打开了另一张板）
 *   ③ 否则：列表里第一张板（服务端把排序钉死了，见 server.js 的 /api/list）
 *   ④ 一张板都没有（笔记还在、板被删干净了）→ 补一张空的再进去（补在根上）
 *   ⑤ 连名字都探不出来（1..99 全被占）→ 退回打开列表里第一个，至少不是白屏
 * `force` 是说"打开它的时候不必问'当前文件没保存，切换会丢'"
 * —— 首次加载时其实还没打开任何文件，这几条只是把原来的口径照抄下来。 */
export function planStartup({ files = [], want = null } = {}) {
  const names = files.map((f) => f && f.name)
  if (!names.length) {
    return { step: 'seed', why: 'data/ 里一个文件都没有：先放一张样板板 + 一份样板笔记' }
  }
  if (want) {
    return names.includes(want)
      ? { step: 'open', name: want, force: true, why: '?file= 指名的那一张' }
      : { step: 'none', why: '?file= 说的那个文件不在列表里（不许退回"列表里第一个"）', want }
  }
  const firstBoard = files.find((f) => f && isBoardName(f.name))
  if (firstBoard) return { step: 'open', name: firstBoard.name, force: false, why: '列表里第一张板' }
  const made = nextBoardName(names)
  if (made) return { step: 'create-board', name: made, why: '一张板都没有：补一张空的' }
  /* 兜底：**按现在的口径到不了** —— 候选名（`board-新白板…`）全都长得像板，
     所以"99 个都被占"就意味着列表里本来就有板，上面那条 `firstBoard` 早就返回了。
     留在这儿是因为"什么算一张板"的口径在 `board.js` 里：万一前缀变了、
     这里不能把一个坏名字交出去（[6n] 里那条断言顺便把这件事说清楚）。 */
  return names[0]
    ? { step: 'open', name: names[0], force: true, why: '连新板的名字都探不出来（1..99 全被占）：退回列表第一个' }
    : { step: 'none', why: '列表是空的' }
}

/* data/ 的读写。**URL 只有这一处**（`encodeURIComponent` 一个都不能漏：
 * 中文名、`·`、空格、括号在板文件名里很常见，没编码就是 404 —— 而且症状是
 * "这张板打不开"，看着像文件坏了）。
 * ★ 路径里的 `/` 是**分隔符**，所以整条相对路径**整体**编码（`%2F`）——
 *   服务端在 decode 之后再按 `/` 拆。一个一个段编码反而会因为漏掉哪一段而 404。
 * 返回值原样透传服务端的 `{ error }`，不抛。 */
export function createFileApi({ fetch: f = fetch } = {}) {
  const post = (url, data) =>
    f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then((r) => r.json())
  return {
    list: () => f('/api/list').then((r) => r.json()),
    get: (name) => f('/api/file/' + encodeURIComponent(name)).then((r) => r.json()),
    put: (name, text) =>
      f('/api/file/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }).then((r) => r.json()),
    create: (name, text) => post('/api/new', { name, text }),
    mkdir: (dir) => post('/api/mkdir', { path: dir }),
    move: (from, to) => post('/api/move', { from, to }),
    /* 导出一条笔记（→ 一个能发出去的 .html）。`fonts` 是浏览器量出来的
       公式字体清单（见 lib/fonts.js）—— 服务端没有 canvas，量不了。 */
    exportNote: (name, { title = '', fonts = '' } = {}) => post('/api/export', { name, title, fonts }),
    /* 在资源管理器里打开导出目录。**这是唯一一个"让网页指挥本机开文件夹"的出口**，
       服务端那边收得很窄（只认 .导出），别在前端再包一层别的意思。 */
    reveal: (path) => post('/api/reveal', { path }),
  }
}
