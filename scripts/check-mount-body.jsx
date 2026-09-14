// 测试体：在已经装好的 jsdom 环境里真挂载 App，模拟"打开 → 打字 → 保存"。
// 由 check-mount.js 动态载入（这个文件含 JSX，需要打包成 CJS）。
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import App from '../src/App.jsx'

export async function run({ window, container, getDiskText, calls }) {
  const results = []
  let failed = 0
  const ok = (m) => {
    results.push('  ✓ ' + m)
  }
  const fail = (m) => {
    failed++
    results.push('  ✗ ' + m)
  }

  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

  // 收集 React 的告警
  const errors = []
  const origError = console.error
  console.error = (...a) => {
    errors.push(a.map(String).join(' '))
  }

  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(React.createElement(App))
    })
    await act(async () => {
      await tick(150)
    })
    ok('App 挂载成功，没有抛异常')
  } catch (e) {
    console.error = origError
    console.log('  ✗ 挂载时抛异常: ' + e.message)
    console.log(e.stack)
    return { failed: 1, results }
  }

  results.push('')
  results.push('=== 挂载后的 DOM ===')
  const html = () => container.innerHTML

  if (html().includes('studyhelper')) ok('左侧栏渲染出来了')
  else fail('没看到左侧栏')

  // 高亮层：行数 / 公式 / 引用 / 标题 / 字段 都要有着色
  const hlLines = container.querySelectorAll('.hl-line')
  if (hlLines.length > 20) ok(`着色层渲染了 ${hlLines.length} 行`)
  else fail(`着色层只有 ${hlLines.length} 行，应该更多`)
  const nFormula = container.querySelectorAll('.hl-formula').length
  if (nFormula >= 10) ok(`公式被着色：${nFormula} 处`)
  else fail(`公式着色数不对：${nFormula}`)

  const nRef = container.querySelectorAll('.hl-ref').length
  if (nRef >= 15) ok(`引用被着色：${nRef} 处`)
  else fail(`引用着色数不对：${nRef}`)

  const nHead = container.querySelectorAll('.hl-line.head').length
  if (nHead >= 6) ok(`标题行被着色：${nHead} 行`)
  else fail(`标题着色不对：${nHead}`)

  const nField = container.querySelectorAll('.hl-line.field').length
  if (nField >= 10) ok(`字段行被着色：${nField} 行`)
  else fail(`字段着色不对：${nField}`)

  if (container.querySelectorAll('.hl-formula.unclosed').length === 0) ok('没有误报"未闭合公式"')
  else fail('示例里存在误报为未闭合的公式')

  const ta = container.querySelector('textarea.raw')
  if (!ta) fail('找不到 textarea.raw')
  else {
    ok('textarea 存在')
    if (ta.value.length > 500) ok(`文件内容已载入 textarea（${ta.value.length} 字符）`)
    else fail('textarea 是空的，文件没被载入')
  }

  if (container.querySelector('.zoom-val')) ok('字号控件存在')
  else fail('字号控件缺失')

  const nQty = container.querySelectorAll('.badge.heat, .badge.island').length
  if (nQty >= 5) ok(`枢纽/孤岛色标出现：${nQty} 个`)
  else fail(`色标数不对：${nQty}`)

  // ---- 切到「阅读」视图：应该渲染出 KaTeX 公式的树 ----
  results.push('')
  results.push('=== 阅读视图 ===')
  const tabs = [...container.querySelectorAll('.viewtabs button')]
  const readTab = tabs.find((b) => b.textContent.includes('阅读'))
  if (!readTab) fail('找不到「阅读」页签')
  else {
    await act(async () => {
      readTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await tick(120)
    })
    const nKatex = container.querySelectorAll('.katex').length
    if (nKatex > 5) ok(`阅读视图里 KaTeX 渲染了 ${nKatex} 个公式`)
    else fail(`阅读视图没渲染公式（katex 节点 ${nKatex} 个）`)
    if (!container.querySelector('textarea.raw')) ok('阅读视图里编辑区已隐藏（整屏阅读）')
    else fail('阅读视图里编辑区还在，说明没有整屏')

    // 点一个节点应该切回编辑并跳到那一行
    const editTab = [...container.querySelectorAll('.viewtabs button')].find((b) => b.textContent.includes('编辑'))
    await act(async () => {
      editTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await tick(120)
    })
    if (container.querySelector('textarea.raw')) ok('切回编辑视图正常')
    else fail('切不回编辑视图')
  }

  // 重新取一次 textarea（切视图后是新元素）
  const ta2 = container.querySelector('textarea.raw')

  // ---- 模拟打字 ----
  results.push('')
  results.push('=== 模拟编辑 ===')
  if (ta2) {
    const before = getDiskText()
    const newText = before.replace('磁感应强度，T', '磁感应强度，单位特斯拉')
    await act(async () => {
      ta2.value = newText
      ta2.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => {
      await tick(200)
    })

    if (html().includes('单位特斯拉')) ok('打字后着色层立即更新')
    else fail('打字后着色层没更新（lines 没跟着 text 重算）')

    if (container.querySelector('.dot-dirty')) ok('脏标记出现（提示未保存）')
    else fail('没有脏标记')
  }

  // ---- 模拟 Ctrl+S ----
  results.push('')
  results.push('=== 模拟保存 ===')
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    await tick(150)
  })
  if (calls.some((c) => c.method === 'PUT')) ok('Ctrl+S 触发了保存（PUT 请求）')
  else fail('Ctrl+S 没有触发保存')
  if (getDiskText().includes('单位特斯拉')) ok('保存的内容是编辑后的文本')
  else fail('保存的内容不对')
  if (!container.querySelector('.dot-dirty')) ok('保存后脏标记消失')
  else fail('保存后脏标记还在')

  // ---- React 告警 ----
  results.push('')
  results.push('=== React 告警 ===')
  const noisy = errors.filter((e) => !e.includes('not wrapped in act'))
  if (noisy.length) {
    fail(`有 ${noisy.length} 条 React 告警/错误：`)
    for (const e of noisy.slice(0, 6)) results.push('     ' + e.split('\n')[0])
  } else ok('没有 React 告警/错误')

  console.error = origError
  return { failed, results }
}
