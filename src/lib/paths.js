/* data/ 里的路径 —— **服务端和前端共用的一份规矩**（2026-09-17 起）。
 *
 * 为什么单开一个 module：
 *   从前 `data/` 是**平的** —— 文件名就是一个名字，规矩只有一条正则（`SAFE_NAME`），
 *   写在 `server.js` 里，前端只知道"列表里有个字符串"。现在文件可以放进子目录
 *   （`data/大物/电磁学/board-第一章.md`），于是"什么叫一个合法路径"这句话
 *   突然要在**三个地方**同时成立：服务端收请求时要挡穿越、写盘时要拼绝对路径、
 *   前端要把一串路径摆成一棵树还能回头问"这层下面有什么"。
 *   三份各写一遍的下场这个仓库已经演过两次（视图映射、手势记账）：
 *   **其中一份带自检，另一份是真正跑在路上的**。所以这里只留一份。
 *
 * ── 口径（都很短，但每条都有血）────────────────────────────────────────────
 *   · `name` = **相对 `data/` 的 `/` 分隔路径**。根上的老文件里没有 `/`（`board-x.md`），
 *     所以老的板一个字节都不用动，照旧能开。
 *   · **合法 = 每一段都合法**。段里不许有 `\ / : * ? " < > |` 和控制字符
 *     （Windows 上根本存不出来）、不许两头有空白、不许以 `.` 或空格结尾
 *     （Windows 会**悄悄**把尾巴去掉，于是"写进去的名字"和"读出来的名字"不是一个）、
 *     不许是 `.` / `..`（那是路径穿越）、不许超过 `MAX_SEGMENT` 个字。
 *   · 深度上限 `MAX_DEPTH`：用户要的是"大物 / 电磁学 / 第一章"这样的两三层，
 *     8 层是"够用而且不至于让左栏缩成一条缝"。
 *   · 末尾必须是 `.md`（这就是这个仓库的存储格式：纯文本、Git 里能看 diff）。
 *
 * ⚠ 两条**别混**的东西：
 *   `normalizeRel`（归一化 + 校验，**不合法就 null**）用在"收请求"和"读盘"那一侧；
 *   `sanitizeRel`（尽量修，修不出来才 null）只用在"用户手打了一个名字"那一侧
 *   （把 `?` 换成 `-` 比弹一句"文件名非法"友好）。**别拿 sanitize 去验请求** ——
 *   那等于把"谁都能写盘"抄近路放进来。
 *   ⚠ 但**穿越那一件事两个都一样硬**：`..` / 绝对路径 / 盘符在 repair 侧也不修，
 *     直接 null。修它等于猜用户想写到哪儿，而这正是最不该猜的地方。
 *
 * ── interface ─────────────────────────────────────────────────────────────
 *   normalizeRel(input, { file })  → '大物/电磁学/board-第一章.md' | null
 *   sanitizeRel(input, { file })   → 同上，但先把段里的坏字符修掉
 *   isSafeSegment(seg) → bool
 *   splitPath / parentPath / baseName / pathTitle / joinPath / isUnder / ancestors
 *   layerPath(dir, seg) / layerNeeds(dir, have) → "在这一层里新建"（点出来的那条路）
 *   compareRelPaths(a, b)          → 服务端给列表排序用的比较器（钉死顺序，见 server.js）
 *   buildFolderTree(files, folders) → 一棵树（根节点 path === ''）
 *   pruneTree(node, keep)          → 去掉"这一枝里没有我要的东西"的目录
 *   uniqueRelName(taken, dir, stem, ext) → 不撞名的 { name, stem, i }
 */

/** 段里不许出现的字符：路径分隔符 + Windows 保留字符 + 控制字符 */
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/
const BAD_CHARS_ALL = new RegExp(BAD_CHARS.source, 'g')

export const MAX_DEPTH = 8
export const MAX_SEGMENT = 80
export const MAX_PATH_LEN = 240

/** 一段路径名字能不能用（最后一段是不是 `.md` 由 `normalizeRel` 管，这里只管"这一段"） */
export function isSafeSegment(seg) {
  if (typeof seg !== 'string') return false
  if (!seg || seg !== seg.trim()) return false // 两头空白：Windows 会悄悄吃掉
  if (seg === '.' || seg === '..') return false
  if (BAD_CHARS.test(seg)) return false
  if (/[. ]$/.test(seg)) return false // Windows 存不出以 . 或空格结尾的名字
  return seg.length <= MAX_SEGMENT
}

/** 尽力把一段修成能用的（只给"用户手打名字"用，别拿它验请求） */
export function cleanSegment(seg) {
  return String(seg == null ? '' : seg)
    .trim()
    .replace(BAD_CHARS_ALL, '-')
    .replace(/[. ]+$/, '')
}

function walkSegments(input, file, { repair }) {
  if (typeof input !== 'string') return null
  const s = input.trim().replace(/\\/g, '/')
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null // 绝对路径 / 盘符
  const segs = []
  for (const raw of s.split('/')) {
    /* ★ 穿越**修也不修**：`..` 不是"打错了一个字"，是"想跑到 data/ 外面去"。
       修（比如把 `../../evil.md` 变成 `evil.md`）看着"容错"，其实是**猜**用户想干什么 ——
       而这种地方猜错的代价是写错文件的位置。宁可回一句"这个名字不能用"。 */
    if (raw.trim() === '..') return null
    const seg = repair ? cleanSegment(raw) : raw
    if (!seg || seg === '.') continue // 空段和 `.` 直接丢掉（`a//b` = `a/b`）
    if (!isSafeSegment(seg)) return null
    segs.push(seg)
  }
  if (!segs.length || segs.length > MAX_DEPTH) return null
  const last = segs[segs.length - 1]
  if (file) {
    if (!/\.md$/i.test(last)) {
      if (!repair) return null
      segs[segs.length - 1] = last + '.md'
    }
  }
  const out = segs.join('/')
  return out.length > MAX_PATH_LEN ? null : out
}

/** 归一化 + 校验。`{ file: false }` = 目录（不要求 .md）。不合法一律 null。 */
export function normalizeRel(input, { file = true } = {}) {
  return walkSegments(input, file, { repair: false })
}

/** 尽量修（坏字符换 `-`、补 `.md`、丢掉空段）。修不出来（穿越 / 太深 / 太长）才 null。 */
export function sanitizeRel(input, { file = true } = {}) {
  return walkSegments(input, file, { repair: true })
}

export function splitPath(p) {
  return String(p == null ? '' : p)
    .split('/')
    .filter(Boolean)
}

export function baseName(p) {
  const s = splitPath(p)
  return s.length ? s[s.length - 1] : ''
}

/** 这一条路径所在的目录（根上是 ''） */
export function parentPath(p) {
  const s = splitPath(p)
  s.pop()
  return s.join('/')
}

/** 文件名去掉 `.md` —— 左栏显示的就是它（板自己的标题在文件内容里，见 board.js） */
export function pathTitle(p) {
  return baseName(p).replace(/\.md$/i, '')
}

/** 这个名字改过没有？（改名对话框靠它决定"确定"亮不亮、点下去算不算数）
 *  只看最后一段：拖去别处由面板上那颗按钮管，对话框只管名字 ——
 *  所以"第一层 / 第一层/x"这种只换了归属的，在这里算没改。 */
export function isRenamed(from, to) {
  return baseName(from) !== baseName(to)
}

export function joinPath(...parts) {
  return parts
    .filter((x) => x != null && x !== '')
    .map((x) => String(x).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/** `child` 是不是就在 `dir` 里面（`dir` 传空 = 根，什么都在里面） */
export function isUnder(child, dir) {
  const c = splitPath(child)
  const d = splitPath(dir)
  if (d.length > c.length) return false
  return d.every((seg, i) => seg === c[i])
}

/** 从根往下每一层：`a/b/c` → `['a', 'a/b', 'a/b/c']`（目录自己用它，用来展开左栏） */
export function levels(p) {
  const segs = splitPath(p)
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'))
}

/* ── "在这一层里新建"：点出来的那条路（2026-09-18）────────────────────────
 * 用户原话：**「现在的分层不是很人性化我还要自己输入上层的名字才能生成，
 * 你可以参考下 onenote 的分层规则这样靠点击来在分层下面建立新白板很人性化」**。
 *
 * 根子上的错不在能力（`/api/new`、`/api/mkdir`、`uniqueRelName` 早就在了），
 * 而在**入口只有打斜杠一条**：想往"大物"里放一张板，你得把"大物"这两个字**再打一遍**。
 * 点的那一下已经把"哪一层"说清楚了 —— 再让用户写一遍，就是让他重复自己、
 * 而且给他一次打错的机会（打成"大务"就凭空多出一层，谁都不会注意）。
 *
 * 所以下面这两个函数各管一件事，都**只吃"你打的那一段"**：
 *   layerPath(dir, seg)   → 这一层里的一个子层（`大物` + `电磁学` = `大物/电磁学`）
 *   layerNeeds(dir, have) → 这一层要不要"先建出来"（上面的层不存在时自己补上）
 * ⚠ 拼路径**只走 joinPath**，别在调用处写 `dir + '/' + seg`：根那一层拼出来是 `/seg`，
 *   树里就会多出一个空名字的节点（这个坑 [6u] 里钉着）。
 */

/** 在 `dir` 这一层里做一条子路径。`dir` 传 `''` = 根。 */
export function layerPath(dir, seg) {
  return joinPath(dir, String(seg == null ? '' : seg).trim())
}

/** `dir` 这一层是不是得先建出来：`have` 是盘上已有的目录清单（`/api/list` 的 folders）。
 *  ★ 为什么不用"问服务端这一层在不在"：`/api/mkdir` 对已存在的层**不算错**
 *    （回 `{ ok, path, existed: true }`），所以这里判错的代价只是多发一次请求，不会写坏东西。 */
export function layerNeeds(dir, have = []) {
  const d = String(dir == null ? '' : dir).trim()
  if (!d) return false // 根永远在
  return !new Set(have).has(d)
}

/** 从根到这个**文件所在目录**的每一层（建完顺手把它展开） */
export function ancestors(p) {
  return levels(parentPath(p))
}

/* ── 导出的东西放哪儿（2026-09-18）────────────────────────────────────
 * 用户要的是"能把笔记发给别人"，所以要有一个**离开这个程序也能看**的文件
 * （见 lib/export-html.js）。它放在哪，只有这一处说了算。
 *
 * ★ 为什么在目录名前加一个点（`.导出`）：
 *   服务端列目录时跳过 `.` 开头的（那本来是给 `.git` 之类留的），于是
 *   **左栏不会多出一个点进去什么都没有的空目录** —— 那个目录里全是 `.html`，
 *   而这个应用只认 `.md`，所以它本来就是个"看不见内容"的地方。
 *   用户想找文件时走左栏底部那一行（那是明写着的入口），不靠它自己在树里露脸。
 *
 * ★ 为什么用中文名而不是 `export`：用户要在资源管理器里翻到它。
 *   `data/.导出/` 比 `data/.exports/` 一眼就懂。
 *
 * ★ `/api/reveal` 只允许打开这个目录 —— 见 server.js 的注释：
 *   "让浏览器指挥本机开一个文件夹"是个很危险的能力，出口只能有一个、且收得很窄。
 */
export const EXPORT_DIR = '.导出'

/** `示例 · 大物电磁学.md` → `.导出/示例 · 大物电磁学.html`
 *  （导出文件和它的源**放在同一层的 `.导出` 里**：源在 `大物/电磁学/`，
 *    导出就在 `大物/电磁学/.导出/`。这样"这一课的导出"永远跟着这一课走。） */
export function exportPathFor(name) {
  const base = baseName(name).replace(/\.md$/i, '')
  return joinPath(parentPath(name), EXPORT_DIR, base + '.html')
}


/* 列表顺序。**必须钉死**：应用打开的是"列表里第一张板"，
 * 而 localeCompare 的默认行为依赖运行环境的 ICU 数据 —— 换个 Node 版本，
 * "示例"和"zz · 模板"谁在前就可能变，打开的文件也跟着变（README 第 9 条那一族）。
 * 前端不排序，只看服务端给的顺序；这里导出是为了能在自检里断言。 */
const COLLATOR = new Intl.Collator('zh-Hans-CN', { usage: 'sort', numeric: true })
export function compareRelPaths(a, b) {
  return COLLATOR.compare(String(a == null ? '' : a), String(b == null ? '' : b))
}

/* ───────────── 把一串路径摆成一棵树（左栏那个层次就是它） ─────────────
 * 节点：{ path, name, dirs: [], files: [] }，根节点 path = ''。
 * `files` 里的元素**原样透传**（服务端给的 { name, title, mtime, size, nodes }），
 * 所以调用方还能拿到那些字段；只给字符串也认（自检里好写）。
 * 目录先按名字排好（文件之间的顺序是服务端给的，不动）。 */
export function buildFolderTree(files = [], folders = []) {
  const root = { path: '', name: '', dirs: [], files: [] }
  const byPath = new Map([['', root]])
  const ensure = (dir) => {
    const p = dir == null ? '' : String(dir)
    if (byPath.has(p)) return byPath.get(p)
    const node = { path: p, name: baseName(p), dirs: [], files: [] }
    ensure(parentPath(p)).dirs.push(node)
    byPath.set(p, node)
    return node
  }
  for (const d of folders) {
    const p = normalizeRel(d, { file: false })
    if (p) ensure(p)
  }
  for (const f of files) {
    const name = typeof f === 'string' ? f : (f && f.name) || ''
    if (!name) continue
    ensure(parentPath(name)).files.push(typeof f === 'string' ? { name: f } : f)
  }
  sortDirs(root)
  return root
}

function sortDirs(node) {
  node.dirs.sort((a, b) => compareRelPaths(a.path, b.path))
  for (const d of node.dirs) sortDirs(d)
}

function countFilesBelow(node) {
  return node.files.length + node.dirs.reduce((n, d) => n + countFilesBelow(d), 0)
}

/* 剪枝：`keep(file)` 说不留的文件不算数。
 * 一个目录留着，当且仅当 —— 它（或它下面）有 keep 的文件，**或者**它下面一个文件都没有。
 * 为什么留着空目录：那是刚建出来等着往里放东西的那一层（没有它就没法"新建到某一层"）。
 * 反过来，"只有笔记、没有白板"的目录在白板模式下就该整枝消失：左栏两个模式各看各的。 */
export function pruneTree(node, keep) {
  const dirs = node.dirs.map((d) => pruneTree(d, keep)).filter(Boolean)
  const files = node.files.filter(keep)
  if (!files.length && !dirs.length && countFilesBelow(node) > 0) return null
  return { ...node, dirs, files }
}

/* 探一个还没被占用的名字：`board-新白板.md` → `board-新白板 2.md` ……（`dir` 是所在层）。
 * ★ 为什么必须先探：服务端 `/api/new` 撞名直接回 409，不探就是**静默失败**
 *   （用户以为建好了，其实没建）。探到 99 就放弃，返回 null。 */
export function uniqueRelName(taken = [], dir = '', stem = '', ext = '.md') {
  const set = new Set(taken)
  for (let i = 1; i <= 99; i += 1) {
    const name = i === 1 ? stem : `${stem} ${i}`
    const cand = joinPath(dir, name + ext)
    if (!set.has(cand)) return { name: cand, stem: name, i }
  }
  return null
}
