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
    pos = buf.indexOf(bBuf, next + bBuf.length)
  }
  return null
}
