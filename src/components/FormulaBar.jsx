import React, { useState } from 'react'
import { SYMBOLS, TEMPLATES } from '../lib/snippets.js'

/**
 * 常驻公式工具条。纯展示：所有插入逻辑在 useFormulaEditing 里，
 * 作用对象永远是「最后获得焦点的那个输入框」。
 */
export default function FormulaBar({ editing }) {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState('template')
  const { ac, doInsert, acceptAutocomplete } = editing

  return (
    <div className="fbar">
      <div className="fbar-row">
        <button className="fbar-toggle" onClick={() => setOpen((v) => !v)} title="收起 / 展开">
          <span className="fbar-caret">{open ? '▾' : '▸'}</span> 公式条
        </button>
        <div className="fbar-tabs">
          <button className={tab === 'template' ? 'on' : ''} onClick={() => setTab('template')}>
            结构
          </button>
          <button className={tab === 'symbol' ? 'on' : ''} onClick={() => setTab('symbol')}>
            符号
          </button>
          <button className={tab === 'help' ? 'on' : ''} onClick={() => setTab('help')}>
            快捷
          </button>
          <button className={tab === 'format' ? 'on' : ''} onClick={() => setTab('format')}>
            写法
          </button>
        </div>
        <span className="fbar-note">
          选中文字再点 = 包进去 · <b>Tab</b> 跳空位 · <b>[[</b> 引用
        </span>
      </div>

      {open && tab === 'template' && (
        <div className="fbar-grid">
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              className="chip struct"
              title={t.hint}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => doInsert(t.insert)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {open && tab === 'symbol' && (
        <div className="fbar-grid">
          {SYMBOLS.map((s) => (
            <button
              key={s.label}
              className="chip sym"
              title={s.hint}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => doInsert(s.insert)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {open && tab === 'help' && (
        <div className="help-grid">
          <div>
            <kbd>Ctrl</kbd> + <kbd>/</kbd> 分式
          </div>
          <div>
            <kbd>Ctrl</kbd> + <kbd>2</kbd> 上标
          </div>
          <div>
            <kbd>Ctrl</kbd> + <kbd>_</kbd> 下标
          </div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> 根号
          </div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> 向量箭头
          </div>
          <div>
            <kbd>Tab</kbd> 下一个空位 / 缩进
          </div>
          <div>
            <kbd>Enter</kbd> 自动续 <code>- </code>
          </div>
          <div>
            <code>[[</code> 触发引用补全
          </div>
          <div className="help-wide">
            打公式时不用管 <code>$</code>：直接点上面的按钮，两端会自动补上。
          </div>
        </div>
      )}

      {open && tab === 'format' && (
        <div className="help-list">
          <p className="help-h">整套格式只有 4 个符号，就这么多</p>
          <ul>
            <li>
              <b>行首 <code>- </code></b>：一行 = 一个节点。横线后面<b>必须有一个空格</b>。
            </li>
            <li>
              <b><code>| </code></b>（竖线，前后各一个空格）：竖线左边是这行叫什么叫什么，右边是内容。
              <br />
              没有竖线也行，那就整行都是名字。
            </li>
            <li>
              <b><code>[[ ]]</code></b>：两点连线。<b>别手打</b>——敲两个左方括号就会弹补全，↑↓ 选、Enter 确认。
            </li>
            <li>
              <b>缩进 2 个空格</b>：表示"属于上一行"。<b>不要用 Tab 缩进</b>，用空格。
            </li>
          </ul>

          <p className="help-h">一个公式节点长这样（缩进就是两个空格，抄这个形状）</p>
          <span className="help-code">{`- 安培环路定理
  - 公式 | $\\oint_L \\vec{B}\\cdot d\\vec{l} = \\mu_0 I_{\\text{内}}$
  - 说的是 | 稳恒磁场中，B 沿闭合回路的积分只跟穿过的电流有关
  - 用到的量 | [[B]] [[mu0]] [[I]]
  - 易错 | 只对稳恒电流成立`}</span>

          <p className="help-h">量（字典）节点长这样</p>
          <span className="help-code">{`- [[B]] | 磁感应强度，T。矢量，描述磁场对运动电荷的作用能力`}</span>

          <p className="help-h">
            字段名只认这 10 个（<span className="help-warn">写了别的，会变成一个新节点挂在下面，而不是这一行</span>）
          </p>
          <p>
            <code>公式</code> <code>定义</code> <code>说的是</code> <code>用到的量</code> <code>用到了</code>{' '}
            <code>题型</code> <code>方法</code> <code>易错</code> <code>注意</code> <code>什么时候能用</code>
          </p>
          <p>
            想用别的词（比如「什么时候能用」）：直接写成<b>下一层的一个小节点</b>，形状是
            <code>- 什么时候能用 | 只对稳恒电流成立</code>，一样好看，不会有副作用。
          </p>

          <p className="help-h">只有<code>用到的量</code>这一行才算"连线"</p>
          <p>
            其他地方写 <code>[[B]]</code> 只是跳转，不进被引次数。所以行文时可以随手加链接，统计不会乱。
          </p>

          <p className="help-h">公式里写中文要包 <code>\text{'{}'}</code></p>
          <span className="help-code">{`$I_{\\text{内}}$  ✓      $I_{内}$  ✗`}</span>

          <p className="help-h">不想记这些的话</p>
          <p>
            在 <code>data/zz · 模板（复制这个来写新的一课）.md</code> 里照着【】填空就行，
            或者把你草稿直接贴给 AI 让它套格式——格式是死的，你的关系才是活的。
          </p>
        </div>
      )}

      {ac && (
        <div className="ac">
          <div className="ac-hint">
            引用 <code>[[{ac.query}</code> — ↑↓ 选择，Enter 确认
            {ac.list.length === 0 && <span className="ac-empty">　没有匹配的节点，先把它建成一个节点</span>}
          </div>
          {ac.list.map((n, i) => (
            <div
              key={n.id}
              className={'ac-item' + (i === ac.sel ? ' on' : '')}
              onMouseDown={(e) => {
                e.preventDefault()
                acceptAutocomplete(n)
              }}
            >
              <span className="ac-title">{n.title}</span>
              <span className="ac-path">{n.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
