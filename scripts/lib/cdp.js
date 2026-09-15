/* 从 /json/list 里挑出"应用的那个页面"。
 *
 * 为什么不能只判 type === 'page'：
 *   Edge 会把**它自己的内部页**和所有扩展的后台页也塞进这个列表，
 *   而且排在应用页**前面**。本机实测（Edge 153.0.4234.32）拿到的顺序是：
 *     [0] page  edge://sync-confirmation-dialog/      ← 就是它被挑中了
 *     [1..5] background_page  chrome-extension://...
 *     [6] page  http://127.0.0.1:5177/                ← 我们要的
 *   Chrome 干净安装没这些内部页，所以这个坑只在 Edge 上暴露。
 *   挑错的症状是"对着 Edge 自己的弹窗求值"，报出来却是
 *   「找不到 textarea 或 .hl-inner」—— 看着像页面坏了，其实连错了页面。
 *
 * 用法：
 *   const list = await (await fetch(CDP + '/json/list')).json()
 *   const page = findAppPage(list)
 */

/** 只要 http(s) 的页面。传 appUrl 就进一步要求 host/port 对得上 */
export function findAppPage (list, appUrl) {
  if (!Array.isArray(list)) return null
  const pages = list.filter(
    (t) => t && t.type === 'page' && typeof t.url === 'string' && /^https?:\/\//.test(t.url)
  )
  if (!appUrl) return pages[0] || null
  let want
  try {
    want = new URL(appUrl)
  } catch {
    return pages[0] || null
  }
  return (
    pages.find((t) => {
      try {
        const u = new URL(t.url)
        return u.host === want.host
      } catch {
        return false
      }
    }) || pages[0] || null
  )
}

/** 轮询等页面出现；等不到返回 null */
export async function waitForAppPage (cdpUrl, { appUrl, tries = 40, gapMs = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    const list = await fetch(cdpUrl + '/json/list').then((r) => r.json()).catch(() => null)
    const page = findAppPage(list, appUrl)
    if (page) return page
    await new Promise((r) => setTimeout(r, gapMs))
  }
  return null
}
