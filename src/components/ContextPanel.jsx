import React from 'react'
import { displayBody, renderTitle, cleanName, quantityRefsIn } from '../lib/parse.js'
import { inlineHtml } from './Preview.jsx'

/**
 * 右侧「节点上下文」。
 * 这里是 (b) 方案的收益兑现处：你没为这些列表做任何额外劳动，
 * 它们全是你写 [[...]] 的副产品。
 */
export default function ContextPanel({ doc, selectedId, onSelect, onRefTitle, onJumpLine }) {
  const node = doc.nodes.find((n) => n.id === selectedId)

  if (!node) {
    const qty = doc.quantityNodes
    const hubs = [...qty].sort((a, b) => (doc.refCount.get(b.id) || 0) - (doc.refCount.get(a.id) || 0))
    const islands = qty.filter((n) => (doc.refCount.get(n.id) || 0) === 0)
    return (
      <div className="ctx">
        <div className="ctx-head">
          <div className="ctx-kicker">量索引</div>
          <h3>点左边/中间任何一个节点</h3>
        </div>
        <p className="ctx-note">
          这里会显示它「被哪些公式用到」「用到了哪些量」，以及怎么跳过去。
        </p>

        <div className="ctx-sec">
          <div className="sec-title">枢纽（被引最多）</div>
          {hubs.slice(0, 8).map((n) => (
            <button key={n.id} className="link-row" onClick={() => onSelect(n.id)}>
              <span className="lr-name">{cleanName(n.title)}</span>
              <span className={'badge heat h' + Math.min(doc.refCount.get(n.id) || 0, 5)}>
                {doc.refCount.get(n.id)} 处
              </span>
            </button>
          ))}
          {hubs.length === 0 && <div className="dim">还没有「量」节点。在 <code>## 量</code> 下面建几个试试。</div>}
        </div>

        {islands.length > 0 && (
          <div className="ctx-sec">
            <div className="sec-title">
              孤岛 <span className="dim">（没有任何公式用到）</span>
            </div>
            {islands.map((n) => (
              <button key={n.id} className="link-row" onClick={() => onSelect(n.id)}>
                <span className="lr-name island-text">{cleanName(n.title)}</span>
              </button>
            ))}
            <p className="ctx-hint">
              孤岛不一定是错的——可能是你还没想到它和谁有关。这正是值得停一下的地方。
            </p>
          </div>
        )}
      </div>
    )
  }

  const title = cleanName(node.title)
  const inbound = doc.inboundByNode.get(node.id) || []
  const outbound = doc.outbound.get(node.id) || []
  const fields = displayBody(node)
  const usesEdge = quantityRefsIn(node).length > 0
  const isQty = doc.isQuantity.get(node.id)

  return (
    <div className="ctx">
      <div className="ctx-head">
        <div className="ctx-kicker">{isQty ? '量' : '节点'} · {node.path || '—'}</div>
        <h3>{renderTitle(node)}</h3>
        <div className="ctx-actions">
          <button className="mini" onClick={() => onJumpLine(node.line)}>
            跳到第 {node.line + 1} 行
          </button>
        </div>
      </div>

      {isQty && (
        <div className={'verdict ' + ((doc.refCount.get(node.id) || 0) > 0 ? 'ok' : 'warn')}>
          {doc.refCount.get(node.id) > 0
            ? `被 ${doc.refCount.get(node.id)} 处用到`
            : '孤岛：还没有任何公式声明用到它'}
        </div>
      )}

      <div className="ctx-sec">
        <div className="sec-title">被这些地方用到（{inbound.length}）</div>
        {inbound.map(({ from }, i) => {
          const n = doc.nodes.find((x) => x.id === from)
          if (!n) return null
          return (
            <button key={i} className="link-row" onClick={() => onSelect(n.id)}>
              <span className="lr-name">{renderTitle(n)}</span>
              <span className="lr-line">L{n.line + 1}</span>
            </button>
          )
        })}
        {inbound.length === 0 && (
          <div className="dim">
            {isQty
              ? '还没有。去某个公式节点下面加一行「用到的量 | [[' + title + ']]」。'
              : '还没有地方引用它。'}
          </div>
        )}
      </div>

      <div className="ctx-sec">
        <div className="sec-title">这个节点用到的量（{outbound.length}）</div>
        {outbound.map((t, i) => {
          const target = doc.resolveOne(t)
          return (
            <button
              key={i}
              className={'link-row' + (target ? '' : ' dangling')}
              onClick={() => target && onSelect(target.id)}
              title={target ? '' : '这个量还没有定义节点'}
            >
              <span className="lr-name">{t}</span>
              {!target && <span className="lr-line">未定义</span>}
            </button>
          )
        })}
        {outbound.length === 0 && <div className="dim">没有声明用到任何量。</div>}
      </div>

      <div className="ctx-sec">
        <div className="sec-title">这个节点的内容</div>
        {fields.map((f, i) => (
          <div className="ctx-field" key={i}>
            <span className="fkey">{f.key}</span>
            <div className="fval">{inlineHtml(f.text, { resolve: doc.resolveOne, onRefTitle })}</div>
          </div>
        ))}
        {!fields.length && (
          <div className="ctx-plain">{inlineHtml(node.body || '（正文是空的）', { resolve: doc.resolveOne, onRefTitle })}</div>
        )}
        {node.children.length > 0 && (
          <div className="ctx-kids">
            {node.children.map((c) => (
              <button key={c.id} className="link-row sub" onClick={() => onSelect(c.id)}>
                <span className="lr-name">{renderTitle(c)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!usesEdge && !isQty && (
        <p className="ctx-hint">
          想让工具帮你连线，就在这个节点下面加一行：<code>用到的量 | [[B]] [[mu0]]</code>
        </p>
      )}
    </div>
  )
}
