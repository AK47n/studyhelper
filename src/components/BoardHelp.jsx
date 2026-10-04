/* 「?」帮助浮层（2026-09-26）。
 *
 * 为什么要有它：这个应用一大半的本事写在按钮的 **title 悬浮提示**里，
 * 而 Surface 的笔/手指**没有 hover** —— 那些说明对最重要的那类用户等于不存在。
 * 这个浮层把三类"藏着的话"摆到明面上：
 *   ① 手势（笔/手指怎么用）
 *   ② 快捷键（键盘那半边）
 *   ③ 想做什么 → 点哪里（功能入口对照 —— 顺带把「⋯ 更多」菜单里收了什么交代清楚）
 *
 * ⚠ 快捷键这张表和 Board.jsx 的 onKey 是**两份**（没有单一实现可指）——
 *   改键盘行为时两边一起改。表里每一行都对着 onKey 里的一个分支抄的。
 *
 * Esc 关闭走**捕获阶段 + stopPropagation**：Board 的 Esc 处理器挂在 window 冒泡上，
 * 不拦的话"收起帮助"和"清掉选区/焦点"会同一帧都发生。
 * （「⋯ 更多」菜单里的 Esc 是同一套做法。）
 */
import React, { useEffect } from 'react'

const GESTURES = [
  ['笔尖写字', '翻过来就是橡皮'],
  ['一根手指拖', '平移画布'],
  ['两根手指捏', '缩放画布'],
  ['按住 Space 拖', '鼠标党的平移'],
  ['双击卡片', '直接改字'],
  ['笔杆侧键拖', '等于「⬚ 框选」'],
  /* ★ 下面这两条是给**没有键盘**的时候留的（2026-09-28 用户问的原话：
     「surface 没键盘的时候怎么摁这些快捷键」）—— 触屏/纯笔的场景里，
     所有带 Ctrl 的快捷键都等于不存在，手势必须自己把那一半补上。 */
  ['双击课件上的字', '查这个词（要先点工具条「⬚ 框选」）'],
  ['手指/笔按住那个字不动', '同上 —— 触屏上比"连点两下"稳得多'],
]

const KEYS = [
  ['P / E / S / A', '笔 · 橡皮 · 框选 · 箭头'],
  ['W', '写字板（手写公式）'],
  ['F', '公式架'],
  ['Ctrl+Z / Ctrl+Shift+Z', '撤销 · 重做'],
  ['Ctrl+C / Ctrl+V', '复制 · 粘贴（两个都有按钮：选区浮层「⧉ 复制」、工具条「⧉ 粘贴」）'],
  ['Ctrl+K', '速查那个词（工具条上有同一颗：「🔍 速查」）'],
  ['Ctrl+Shift+S', '规整形状（先框住）'],
  ['Ctrl+0', '把所有内容装回屏幕'],
  ['Delete / Backspace', '删掉选中的'],
  ['Esc', '一次收起一层'],
]

const WHERE = [
  ['认一个手写公式', '✍ 手写公式（或框住手写 → 浮层上的「∑ 公式」）'],
  ['把丑字变好看', '「⬚ 框选」圈住字 → ✨ 美化手写'],
  ['问课件上这一块', '「⬚ 框选」圈住课件 → ？ 问这里'],
  ['同一个公式用第二遍', '∑ 公式架：点一下放到眼前，拖到板上'],
  ['在板上贴 PDF/PPT', '⋯ → 📄 插入 PDF/PPT'],
  ['让老师逐页讲课件', '⋯ → ✧ 课件整理'],
  ['做作业（答案+解析）', '⋯ → 作业辅导'],
  ['整块板收成一篇笔记', '⋯ → ▤ 收成笔记'],
  ['突然不懂一个词', '🔍 速查（或双击课件上的字）—— 不用键盘也能点得到'],
  ['粘贴上次复制的', '⧉ 粘贴（不用键盘，Surface 也点得到）'],
  ['全屏只留一张纸', '⋯ → ⛶ 全屏（Esc 退出）'],
]

export default function BoardHelp({ onClose }) {
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  return (
    <div className="bd-help-back" onPointerDown={onClose}>
      <div className="bd-help" onPointerDown={(e) => e.stopPropagation()} data-help="1">
        <div className="bd-help-h">
          <span>怎么用这块板</span>
          <button className="bd-help-x" onClick={onClose} title="关掉（Esc）">×</button>
        </div>
        <div className="bd-help-cols">
          <section>
            <h3>手势</h3>
            <dl>
              {GESTURES.map(([k, v]) => (
                <div key={k} className="bd-help-row"><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          </section>
          <section>
            <h3>快捷键</h3>
            <dl>
              {KEYS.map(([k, v]) => (
                <div key={k} className="bd-help-row"><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          </section>
          <section>
            <h3>想做什么 → 点哪里</h3>
            <dl>
              {WHERE.map(([k, v]) => (
                <div key={k} className="bd-help-row"><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          </section>
        </div>
        <div className="bd-help-foot">
          按钮上悬停鼠标还有一句说明（笔和手指上没有悬浮 —— 就是为这个才做的这页）。
        </div>
      </div>
    </div>
  )
}
