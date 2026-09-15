/* 让"笔记界面"的自检自己切进笔记界面 —— 别再靠环境里碰巧有什么文件。
 *
 * ── 为什么需要它（2026-09-15 踩的）──
 * 应用打开时**优先进白板**：列表里有 board-*.md 就进白板；一张板都没有时还会
 * 自动补一张空板（App.jsx 的 ensureBoard）。于是 cdp-align / cdp-caretfit 过去
 * 赖以活着的那个前提 —— "data/ 里碰巧没有板，所以打开就是笔记界面" —— 没了。
 * 实测：加了自动补板之后，这两个脚本立刻报
 *   ✗ 找不到 textarea 或 .hl-inner
 * 页面根本没坏，只是它现在站在白板画布上找笔记的编辑框。
 *
 * 修法就是下面这 20 行：点一下左栏「笔记」，等 textarea.raw 真的出现。
 * 这和 check-board-browser 的做法是一个道理（那个是"自检自己保证进白板"）：
 * **自检要自己保证处在它需要的环境里，不靠运气。**
 *
 * ⚠ 两个坑：
 *   ① 一份笔记都没有时，「笔记」按钮会走 newNote() 弹 prompt；headless 里没人回答，
 *      会把页面和后面的 evaluate 一起卡住。所以点之前先把 window.prompt 按住（返回 null
 *      = newNote 当成"用户取消"）。
 *   ② 点击是异步的（要 fetch 文件 + 渲染），必须轮询等，不能点完立刻求值。
 */
export async function gotoNoteMode(evaluate, { tries = 60, gapMs = 250 } = {}) {
  if (await evaluate(`!!document.querySelector('textarea.raw')`)) return 'already'

  const clicked = await evaluate(`(() => {
    if (!window.__shPromptMuted) {
      window.__shPromptMuted = true
      window.prompt = () => null
    }
    const note = document.querySelectorAll('.modes .mode')[1]
    if (!note) return 'no-button'
    note.click()
    return 'clicked'
  })()`)
  if (clicked === 'no-button') throw new Error('左栏找不到「笔记」按钮（界面结构改了？）')

  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, gapMs))
    if (await evaluate(`!!document.querySelector('textarea.raw')`)) return 'switched'
  }
  throw new Error('点了「笔记」但编辑区一直没出现（data/ 里一份笔记都没有？）')
}
