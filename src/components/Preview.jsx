import React, { useMemo } from 'react'
import { displayBody } from '../lib/parse.js'
/* ★ 「怎么读一小段文本」搬去了 lib/inline.js（2026-09-18）——
   因为导出（lib/export-html.js）也要用**同一份**读法。从前它只住在这个文件里，
   谁再要一份就只能抄，而"同一句话有两份实现"这个仓库已经踩过两次
   （一份带自检、一份真在路上跑，出错的是路上那份）。
   ⚠ 那个文件**不许 import katex**（服务端也要用它，而服务端不装依赖）——
     所以排公式单独放在 lib/renderMath.js，切文本放在那边。
   这里只负责把零件的**样子**变成 React 节点。 */
import { splitInline } from '../lib/inline.js'
import { renderMathToHtml } from '../lib/renderMath.js'

/** 一小段文本 → React 节点：$公式$ 走 KaTeX，[[引用]] 变成可点的小标签 */
function inlineHtml(text, { resolve, onRefTitle } = {}) {
  return splitInline(text).map((p, i) => {
    if (p.type === 'math') {
      const html = renderMathToHtml(p.latex)
      if (html) {
        return <span key={i} className="math" dangerouslySetInnerHTML={{ __html: html }} />
      }
      return (
        <span key={i} className="math-bad" title="公式还没写完">
          {p.latex}
        </span>
      )
    }
    if (p.type === 'ref') {
      const target = resolve ? resolve(p.title) : null
      return (
        <button
          key={i}
          className={'ref' + (target ? '' : ' dangling')}
          title={target ? `跳到：${p.title}` : `${p.title} 还没有定义节点`}
          onClick={(e) => {
            e.stopPropagation()
            onRefTitle && onRefTitle(p.title)
          }}
        >
          {`[[${p.title}]]`}
        </button>
      )
    }
    return <span key={i}>{p.text}</span>
  })
}

function NodeRow({ node, doc, selectedId, onSelect, onRefTitle }) {
  const fields = displayBody(node)
  /* 兜底：正文里还有字，但一段都没被认出来（比如 `- 关系名 | 说明` 这种
     既不是字段名、又不是 `名字 | 说明` 量条目的写法）。
     以前这些字会**静默消失**——屏幕上只剩前半截，看起来很像是"格式没生效"。
     宁可丑，不可丢：认不出来就当普通说明渲染出来。 */
  if (fields.length === 0 && node.body.trim()) {
    fields.push({ key: '说明', text: node.body.trim() })
  }
  const count = doc.refCount.get(node.id) || 0
  const qty = doc.isQuantity.get(node.id)
  return (
    <div className="pnode">
      <div
        className={'prow' + (selectedId === node.id ? ' on' : '')}
        onClick={() => onSelect(node.id)}
        title={`第 ${node.line + 1} 行`}
      >
        <span className="pdot" />
        <span className="ptitle">
          {inlineHtml(node.title, { resolve: doc.resolveOne, onRefTitle })}
        </span>
        {qty && count > 0 && <span className={'badge heat h' + Math.min(count, 5)}>{count} 处引用</span>}
        {qty && count === 0 && <span className="badge island" title="没有任何公式用到它——想清楚它和什么有关，或者删掉">孤岛</span>}
      </div>

      {fields.length > 0 && (
        <div className="pfields">
          {fields.map((f, i) => (
            <div className={'pfield k-' + f.key} key={i}>
              <span className="fkey">{f.key}</span>
              <span className="fval">{inlineHtml(f.text, { resolve: doc.resolveOne, onRefTitle })}</span>
            </div>
          ))}
        </div>
      )}

      {node.children.length > 0 && (
        <div className="pkids">
          {node.children.map((c) => (
            <NodeRow
              key={c.id}
              node={c}
              doc={doc}
              selectedId={selectedId}
              onSelect={onSelect}
              onRefTitle={onRefTitle}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Preview({ doc, selectedId, onSelect, onRefTitle }) {
  const roots = doc.root.children
  const empty = useMemo(() => roots.length === 0, [roots])
  if (empty) {
    return (
      <div className="preview empty">
        <p>左边还没有内容。</p>
        <p className="dim">
          打 <code>- 标题</code> 起一个节点，回车自动续下一行，<b>Tab</b> 缩进成子节点。
        </p>
      </div>
    )
  }
  return (
    <div className="preview">
      {roots.map((n) => (
        <NodeRow
          key={n.id}
          node={n}
          doc={doc}
          selectedId={selectedId}
          onSelect={onSelect}
          onRefTitle={onRefTitle}
        />
      ))}
    </div>
  )
}

export { inlineHtml }
