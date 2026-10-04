/* multipart/form-data 的**拼**和**拆**，只用 node 内置能力。
 *
 * ── 为什么自己拼而不是用内置 FormData + fetch ──
 * 实测：node 内置 fetch（undici）在**本机 HTTPS** 上会直接挂住不返回，
 * 而同一个地址用 tls.connect / https.request 一秒就通。
 * 这条链路（本地服务 → 识别服务）以后还可能指向自建/本机代理，
 * 踩一个"某些地址会永久挂住"的坑不值得，所以统一走 node:http/https。
 * 自己拼 multipart 也就六十行，而且是能测的六十行。
 *
 * ── 为什么拆的时候不能先转字符串 ──
 * PNG 是二进制，`toString('utf8')` 会把非法字节换成 U+FFFD，图片当场就废了，
 * 而且**不报错**：本地这边看着一切正常，识别服务只回一句"看不懂这张图"。
 * 所以全程在 Buffer 上按字节找边界。
 */

const CRLF = '\r\n'

/** 拼一个 multipart 请求体。返回 {body, contentType} */
export function buildMultipart(fields, { boundary } = {}) {
  const b = boundary || '----studyhelper' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  const parts = []
  for (const f of fields || []) {
    if (!f || f.data == null) continue
    const name = f.name || 'file'
    const filename = f.filename
    const type = f.type || 'application/octet-stream'
    let head = `--${b}${CRLF}Content-Disposition: form-data; name="${name}"`
    if (filename) head += `; filename="${filename}"`
    head += CRLF
    if (filename || f.type) head += `Content-Type: ${type}${CRLF}`
    head += CRLF
    parts.push(Buffer.from(head, 'utf8'))
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8'))
    parts.push(Buffer.from(CRLF, 'utf8'))
  }
  parts.push(Buffer.from(`--${b}--${CRLF}`, 'utf8'))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` }
}

/**
 * 从 multipart 请求体里抠出第一个文件部分。
 * @returns {{name:string, filename:string, data:Buffer}|null}
 */
export function extractFilePart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  if (!m) return null
  const boundary = '--' + (m[1] || m[2]).trim()
  const bBuf = Buffer.from(boundary, 'utf8')

  let pos = buf.indexOf(bBuf)
  while (pos >= 0) {
    const headStart = pos + bBuf.length
    const headEnd = buf.indexOf('\r\n\r\n', headStart)
    if (headEnd < 0) return null
    const header = buf.subarray(headStart, headEnd).toString('utf8')

    const dataStart = headEnd + 4
    const next = buf.indexOf(bBuf, dataStart)
    if (next < 0) return null
    let dataEnd = next
    // 边界前面那对 \r\n 是分隔符的一部分，不算数据
    if (buf[dataEnd - 2] === 0x0d && buf[dataEnd - 1] === 0x0a) dataEnd -= 2

    const nameMatch = /name="([^"]*)"/i.exec(header)
    const fileMatch = /filename="([^"]*)"/i.exec(header)
    const isFile = !!fileMatch || (nameMatch && nameMatch[1] === 'file')
    if (isFile && dataEnd > dataStart) {
      return {
        name: nameMatch ? nameMatch[1] : 'file',
        filename: fileMatch ? fileMatch[1] : '',
        data: buf.subarray(dataStart, dataEnd),
      }
    }
    /* ★ 下一个 part 就是**这个** boundary 后面那一段，所以从这里接着扫。
       ⚠ 这里原来写的是 `buf.indexOf(bBuf, next + bBuf.length)` ——
         那就等于把下一个 part 整个跳过，于是这个循环只看得到第 1、3、5… 个 part。
         一直没出事，只是因为浏览器 FormData 里文件恰好排第一个（找到就返回了）。
         手写美化要在同一个请求里加一个 mode 文本字段，这个坑才露出来：
         `mode` 藏在第 2 个 part，永远扫不到 → 服务端会一直按"公式"处理。
         修法就是从头扫全：**每一个 part 都要看，不能隔一个看一个。** */
    pos = next
  }
  return null
}

/**
 * 从 multipart 请求体里抠出**某一个名字**的文件部分（`file2` 这种）。
 *
 * ── 为什么要有它（2026-09-22，「框选追问」）─────────────────────────────
 * 那一趟要发**两张图**：整页（带红框）+ 框里那一块放大。同名的两个 `file` 字段
 * 在 FormData 里是合法的，但 `extractFilePart` 只交第一个 —— 想拿第二个就得有
 * 一把按名字找的钥匙（`extractTextPart` 那一族只管文本，读不了二进制）。
 *
 * ⚠ 和上面两个一样：全程在 Buffer 上按字节找边界，**绝不**先把 body 转成字符串
 *   （PNG/JPEG 里有非法字节，转一次这张图就废了，而且不报错）。
 * ⚠ 找不到就返回 null —— 调用方（那一趟）退回单图，而不是报错：
 *   "少一张图"该降级成"上下文少一点"，不该让整个问题问不出去。
 */
export function extractFilePartNamed(buf, contentType, name) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  if (!m) return null
  const boundary = '--' + (m[1] || m[2]).trim()
  const bBuf = Buffer.from(boundary, 'utf8')
  const want = String(name || '')
  if (!want) return null

  let pos = buf.indexOf(bBuf)
  while (pos >= 0) {
    const headStart = pos + bBuf.length
    const headEnd = buf.indexOf('\r\n\r\n', headStart)
    if (headEnd < 0) return null
    const header = buf.subarray(headStart, headEnd).toString('utf8')

    const dataStart = headEnd + 4
    const next = buf.indexOf(bBuf, dataStart)
    if (next < 0) return null
    let dataEnd = next
    if (buf[dataEnd - 2] === 0x0d && buf[dataEnd - 1] === 0x0a) dataEnd -= 2

    const nameMatch = /name="([^"]*)"/i.exec(header)
    const fileMatch = /filename="([^"]*)"/i.exec(header)
    if ((fileMatch || nameMatch) && nameMatch && nameMatch[1] === want && dataEnd > dataStart) {
      return {
        name: nameMatch[1],
        filename: fileMatch ? fileMatch[1] : '',
        data: buf.subarray(dataStart, dataEnd),
      }
    }
    pos = next
  }
  return null
}

/**
 * 从 multipart 请求体里抠出**一个文本字段**（不是文件）。
 *
 * 为什么需要它：`/api/ocr` 除了那张图，还要知道"这次认的是公式还是普通文字"
 * （mode 字段）。浏览器发的 FormData 里，文本字段排在文件**后面**，
 * 所以扫描必须一路走过文件那一段 —— 这也正是它不能和 extractFilePart 合并的原因：
 * 那个函数找到第一个"文件"就 return 了。
 *
 * ⚠ 和 extractFilePart 一样，全程在 Buffer 上按字节找边界。文本这一段最后才
 *    toString('utf8')，绝不提前把整个 body（里面躺着 PNG）转成字符串。
 *
 * ★★ 契约：**没有这个字段时回 `null`，不是空串**（下面四处 `return null`）。
 *    所以每个调用方都得自己兜底，写法是 `extractTextPart(...) || ''`。
 *    2026-09-22 用户报的 `Cannot read properties of null (reading 'slice')` 就是
 *    `server.js` 里 `knowledge` 那一条漏了兜底 —— 而"板上一张讲解卡都没有"时
 *    前端**根本不发那一段**，于是 `null.slice(...)` 当场抛。
 *    这是**故意**的：分得清"没这一段"和"这一段是空的"，调用方才有得选。
 *    守卫：`check-ocr-server.js`（这里回 null）+ `check-homework.js` 第 ⑦ 节
 *    （照着 server.js 的读法兜底一遍，外加源码扫描不许再出现 `.方法(` 直连）。
 */
export function extractTextPart(buf, contentType, name) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  if (!m) return null
  const boundary = '--' + (m[1] || m[2]).trim()
  const bBuf = Buffer.from(boundary, 'utf8')
  const want = String(name || '')

  let pos = buf.indexOf(bBuf)
  while (pos >= 0) {
    const headStart = pos + bBuf.length
    const headEnd = buf.indexOf('\r\n\r\n', headStart)
    if (headEnd < 0) return null
    const header = buf.subarray(headStart, headEnd).toString('utf8')

    const dataStart = headEnd + 4
    const next = buf.indexOf(bBuf, dataStart)
    if (next < 0) return null
    let dataEnd = next
    if (buf[dataEnd - 2] === 0x0d && buf[dataEnd - 1] === 0x0a) dataEnd -= 2

    const nameMatch = /name="([^"]*)"/i.exec(header)
    const fileMatch = /filename="([^"]*)"/i.exec(header)
    // 文件部分跳过（不能把 PNG 当文本读），只认要的那个文本字段
    if (!fileMatch && nameMatch && nameMatch[1] === want) {
      return buf.subarray(dataStart, dataEnd).toString('utf8')
    }
    pos = next
  }
  return null
}
