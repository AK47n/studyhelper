// 这一整个文件就是 studyhelper 的文件格式定义。看懂它就等于看懂了这套工具。
//
//   - 节点标题 | 正文
//     - 子节点标题
//       - 公式 | $H = \frac{B}{\mu_0}$
//       - 用到的量 | [[B]] [[mu0]]
//     - 又一个子节点
//
// 三个约定：
//   1. 每行一个节点，行首 "- "。缩进 2 个空格 = 下一层。
//   2. 第一个 " | " 之后是正文。正文里的 $...$ 渲染成公式，[[名字]] 是引用。
//   3. "用到的量" / "用到了" 这一行里的 [[...]] 才算连线（会被计进被引次数）。
//      正文里其他地方写 [[名字]] 只是跳转，不计数。

export const FIELD_KEYS = ['公式', '定义', '用到的量', '用到了', '说的是', '题型', '方法', '易错', '注意', '什么时候能用']

const LEADING = /^(\s*)-\s+(\S.*)$/
const HEADING = /^(\s*)(#{1,6})\s+(\S.*)$/

export function indentWidth(raw) {
  let w = 0
  for (const ch of raw) {
    if (ch === ' ') w += 1
    else if (ch === '\t') w += 2
    else break
  }
  return w
}

export function splitTitleBody(s) {
  const i = s.indexOf(' | ')
  if (i === -1) return { title: s, body: '' }
  return { title: s.slice(0, i), body: s.slice(i + 3) }
}

export function firstLine(s) {
  return String(s || '').split('\n')[0]
}

export function renderTitle(node) {
  if (!node) return '（空节点）'
  const t = (node.title || '').replace(/\s+/g, ' ').trim()
  return t || firstLine(node.body) || '（空节点）'
}

/** 把 `[[B]]` 这种"带壳"的名字还原成 B */
export function cleanName(s) {
  return String(s ?? '')
    .trim()
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .trim()
}

const FIELD_KEY_RE = new RegExp(`^(${FIELD_KEYS.join('|')})$`)

/** 把 "用到的量 | [[B]] [[mu0]]" 拆成 [{key,text}]；不是字段行就返回 [null] */
export function splitFields(s) {
  const segs = String(s || '').split(/\s+\|\s+/)
  if (segs.length > 1 && FIELD_KEY_RE.test(segs[0].trim())) {
    const out = []
    for (let i = 1; i < segs.length; i++) {
      const t = segs[i].trim()
      const m = t.match(FIELD_KEY_RE)
      if (m) out.push({ key: m[1], text: '' })
      else if (out.length) out[out.length - 1].text += (out[out.length - 1].text ? ' | ' : '') + t
      else out.push({ key: segs[0].trim(), text: t })
    }
    return out.length ? out : [{ key: segs[0].trim(), text: '' }]
  }
  return [null]
}

/**
 * 更宽容的一种："值组"。
 *   "定义 | 公式 | 说的是" → { core:'定义', fields:[公式, 说的是] }
 *   "[[B]] | 磁感应强度，T"  → { core:'[[B]]', fields:[] }
 * 量节点的写法是后者——第一段是名字，后面直接跟说明，没有字段名。
 */
export function splitValue(s) {
  const segs = String(s || '')
    .split(/\s+\|\s+/)
    .map((x) => x.trim())
    .filter((x) => x !== '')
  if (!segs.length) return { core: '', fields: [] }
  const firstIsKey = FIELD_KEY_RE.test(segs[0])
  const fields = []
  if (firstIsKey) {
    for (let i = 1; i < segs.length; i++) {
      const m = segs[i].match(FIELD_KEY_RE)
      if (m) fields.push({ key: m[1], text: '' })
      else if (fields.length) fields[fields.length - 1].text += (fields[fields.length - 1].text ? ' | ' : '') + segs[i]
      else fields.push({ key: '说明', text: segs[i] })
    }
  } else {
    for (let i = 1; i < segs.length; i++) fields.push({ key: '说明', text: segs[i] })
  }
  return { core: segs[0], fields }
}

/** 一个节点正文里所有"用到的量"引用（含裸 [[名字]] 段） */
export function quantityRefsIn(node) {
  const segs = splitFields(node.body)
  const out = []
  if (segs[0]) {
    for (const f of segs) {
      if (f.key === '用到的量' || f.key === '用到了') out.push(...extractRefs(f.text))
    }
  } else {
    const { fields } = splitValue(node.body)
    for (const f of fields) out.push(...extractRefs(f.text))
  }
  return out
}

/**
 * 一个节点正文里的"值"段：
 *   "定义 | 公式 | 说的是"  → [定义, 公式, 说的是]      （字段行）
 *   "[[B]] | 磁感应强度，T" → [磁感应强度，T]           （名字 | 说明）
 */
export function displayBody(node) {
  const segs = splitFields(node.body)
  if (segs[0]) return segs.map((f) => ({ key: f.key, text: f.text }))
  const v = splitValue(node.body)
  return v.fields.length ? v.fields : v.core ? [{ key: '说明', text: v.core }] : []
}

export const REF_RE = /\[\[([^[\]]+)\]\]/g

export function extractRefs(s) {
  const out = []
  const re = new RegExp(REF_RE.source, 'g')
  let m
  while ((m = re.exec(String(s || '')))) out.push(m[1].trim())
  return out
}

/** 正文里有无配对的 $...$（还没打完的公式） */
export function hasOpenFormula(s) {
  const stripped = String(s || '').replace(/\\\$/g, '')
  return (stripped.match(/\$/g) || []).length % 2 === 1
}

export function findContainerLine(lines, fromLine) {
  for (let i = Math.min(fromLine, lines.length) - 1; i >= 0; i--) {
    const m = lines[i].match(LEADING)
    if (m && !m[2].includes('\u0000')) return i
  }
  return -1
}

/**
 * 认两种行，各自算深度，再合成一棵树：
 *   `# 标题` / `## 标题`   深度 = `#` 的个数
 *   `- 标题`               深度 = 缩进 / 2 + 1（缩进 2 空格 = 下一层）
 *
 * 有一条例外：如果最浅的标题就是 `#`，说明那份 `#` 是"文档标题"，
 * 那么所有 `- 项` 整体下移一层，好让它们挂在 `## 各节` 底下而不是跟它平级。
 * 于是下面两种写法都能得到正确的树，不用为了对齐去硬缩进：
 *
 *   ## 四、量          |  # 大物 · 电磁学
 *   - [[B]] | 磁感应强度 |  ## 四、量
 *   - [[I]] | 电流强度   |  - [[B]] | 磁感应强度
 */
function buildTree(lines) {
  const heads = lines.map((l) => l.match(HEADING)).filter(Boolean)
  const minLevel = heads.length ? Math.min(...heads.map((m) => m[2].length)) : 0
  const itemBase = minLevel === 1 ? 2 : 1 // `- ` 的起始深度

  const items = []
  lines.forEach((line, idx) => {
    const h = line.match(HEADING)
    if (h) {
      items.push({
        line: idx,
        depth: h[2].length,
        isHeading: true,
        level: h[2].length,
        raw: { title: h[3].trim() },
      })
      return
    }
    const m = line.match(LEADING)
    if (!m) return
    const rawIndent = indentWidth(m[1])
    const { title, body } = splitTitleBody(m[2].replace(/\u0000/g, '').trimEnd())
    items.push({
      line: idx,
      depth: Math.floor(rawIndent / 2) + itemBase,
      isHeading: false,
      level: 0,
      rawIndent,
      raw: { title, body },
    })
  })

  const root = { id: 'root', depth: 0, line: -1, children: [] }
  const nodes = []
  let seq = 0

  const makeNode = (it) => {
    const node = {
      id: 'n' + seq++,
      line: it.line,
      indent: it.rawIndent ?? 0,
      depth: it.depth,
      isHeading: it.isHeading,
      level: it.level,
      title: it.raw.title,
      body: it.raw.body || '',
      children: [],
      parent: null,
    }
    nodes.push(node)
    return node
  }

  // ── 第一趟：只搭标题骨架（`#` 与 `##` 之间按层级挂，同级是兄弟）
  const headingStack = [root]
  const headingByDepth = new Map() // 深度 → 该深度上最近的那个标题
  const placeHeading = (node) => {
    while (headingStack.length > 1 && headingStack[headingStack.length - 1].depth >= node.depth) headingStack.pop()
    const parent = headingStack[headingStack.length - 1]
    node.parent = parent
    parent.children.push(node)
    headingStack.push(node)
    for (const d of [...headingByDepth.keys()]) if (d >= node.depth) headingByDepth.delete(d)
    headingByDepth.set(node.depth, node)
  }

  // `- 项` 的深度 → 该挂到哪个标题深度下
  // 规律：最浅的 `- 项`（0 缩进）挂在最深的标题下，再深一层就往上找一层标题。
  const items0 = items.filter((x) => !x.isHeading)
  const firstItem = items0[0]
  const deepestHeadingDepth = items
    .filter((x) => x.isHeading && firstItem && x.line < firstItem.line)
    .reduce((m, x) => Math.max(m, x.depth), 0)
  const anchorDepth = (d) => (firstItem ? deepestHeadingDepth - (d - firstItem.depth) : d - 1)

  // ── 第二趟：标题 + 列表项按行序走，同时维护一条"列表项链"
  const stack = [root]
  for (const it of items) {
    const node = makeNode(it)
    while (stack.length > 1 && stack[stack.length - 1].depth >= node.depth && stack[stack.length - 1].isHeading === node.isHeading) {
      stack.pop()
    }
    while (stack.length > 1 && stack[stack.length - 1].depth >= node.depth) stack.pop()

    if (node.isHeading) {
      placeHeading(node)
    } else {
      const top = stack[stack.length - 1]
      const canUseTop = top.id !== 'root' && !top.isHeading && top.depth < node.depth
      if (canUseTop) {
        node.parent = top
        top.children.push(node)
      } else {
        const anchor = headingByDepth.get(anchorDepth(node.depth))
        const parent = anchor || root
        node.parent = parent
        parent.children.push(node)
      }
    }
    stack.push(node)
  }
  return { root, nodes }
}

function assignPaths(root) {
  const walk = (node, prefix) => {
    node.path = prefix
    node.children.forEach((c, i) => walk(c, prefix ? `${prefix} / ${i + 1}` : String(i + 1)))
  }
  walk(root, '')
}

/** 这一支是不是"量"的索引支（标题里含"量"，但排除"用到的量"这种字段名） */
export function isQuantitySectionTitle(t) {
  const s = String(t || '').trim()
  if (!s || s.includes('$') || s.includes('[[')) return false
  if (s === '用到的量' || s === '用到了') return false
  return s.includes('量')
}

/** section：某个节点的祖先里有没有"量"那一支 */
function inSection(node, predicate) {
  let p = node.parent
  while (p && p.id !== 'root') {
    if (predicate(p.title || '')) return true
    p = p.parent
  }
  return false
}

function isDescendantOf(node, ancestor) {
  let p = node.parent
  while (p) {
    if (p === ancestor) return true
    p = p.parent
  }
  return false
}

export function parseDoc(text) {
  const lines = String(text ?? '').split('\n')
  const { root, nodes } = buildTree(lines)
  assignPaths(root)

  // 索引：名字 → 节点。名字"去壳"后再存，于是
  // `- [[B]] | 磁感应强度`（名字写在标题里）和 `- B | 磁感应强度` 两种写法都能被 [[B]] 引用到。
  // 公式标题不收（含 $），否则公式会被当成名字。
  const stripShell = cleanName
  const index = new Map()
  for (const n of nodes) {
    const t = stripShell(n.title)
    if (!t || t.includes('$')) continue
    if (!index.has(t)) index.set(t, [])
    index.get(t).push(n)
  }
  const resolveOne = (name) => {
    const k = stripShell(name)
    if (!k) return null
    const arr = index.get(k)
    return arr && arr.length ? arr[0] : null
  }

  // 先定位"量"索引支：优先认有子节点的标题（## 四、量 这种）
  const quantityRoot =
    nodes.find((n) => isQuantitySectionTitle(n.title) && n.children.length > 0) ||
    nodes.find((n) => isQuantitySectionTitle(n.title)) ||
    null

  const isQty = (n) =>
    quantityRoot ? n === quantityRoot || isDescendantOf(n, quantityRoot) : inSection(n, isQuantitySectionTitle)

  // 连线：只统计「用到的量 / 用到了」这类字段行里的引用 + 正文里指向"量"那一支的引用
  const inbound = new Map() // targetTitle -> [{from}]
  const outbound = new Map() // nodeId -> [targetTitle]
  for (const n of nodes) {
    const found = new Set(quantityRefsIn(n))
    for (const r of extractRefs(n.body)) {
      const t = resolveOne(r)
      if (t && isQty(t)) found.add(r)
    }
    const list = [...found]
    outbound.set(n.id, list)
    for (const r of list) {
      if (!inbound.has(r)) inbound.set(r, [])
      inbound.get(r).push({ from: n.id, line: n.line })
    }
  }

  // 引用次数 / 孤岛
  const refCount = new Map()
  const inboundByNode = new Map() // nodeId → 引用它的节点（避免名字去壳问题）
  const isQuantity = new Map()
  for (const n of nodes) {
    const hit = inbound.get(stripShell(n.title)) || []
    refCount.set(n.id, hit.length)
    inboundByNode.set(n.id, hit)
    isQuantity.set(n.id, isQty(n) && n !== quantityRoot)
  }

  // 量索引支下面的叶子，才是要盯着的量
  const quantityNodes = nodes.filter((n) => {
    const t = stripShell(n.title)
    return isQuantity.get(n.id) && t && !t.includes('$') && n.children.length === 0
  })

  return {
    lines,
    root,
    nodes,
    index,
    inbound,
    inboundByNode,
    outbound,
    refCount,
    isQuantity,
    quantityNodes,
    quantityRoot,
    resolveOne,
  }
}

export function countLeaves(node) {
  if (!node.children.length) return 1
  return node.children.reduce((a, c) => a + countLeaves(c), 0)
}
