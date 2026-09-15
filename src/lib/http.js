/* 发一个 HTTP/HTTPS 请求，拿到状态码和正文 —— 用 node 内置模块手写。
 *
 * ── 为什么不用内置 fetch ──
 * 实测：node 内置 fetch（undici 实现）连**本机 HTTPS** 时会挂住不返回，
 * 而 tls.connect 同一秒就握手成功。这个项目里所有出网请求都走这里，
 * 就是为了不踩"某些地址会永久挂住"这种最难查的坑。
 *
 * ── 为什么必须有超时 ──
 * 识别服务会排队。没有超时的话前端一直转圈，用户只会以为是自己写错了。
 */
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

/**
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:Buffer, timeoutMs?:number, maxRedirects?:number}} opts
 * @returns {Promise<{status:number, text:string, headers:object}>}
 */
export function httpRequest(url, opts = {}) {
  const { method = 'GET', headers = {}, body = null, timeoutMs = 20000, maxRedirects = 0 } = opts
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch {
      reject(new Error('地址不合法：' + url))
      return
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        // 3xx 手动跟：只跟同协议的，且限制次数（默认不跟——识别服务不该重定向）
        if (maxRedirects > 0 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, url).toString()
          httpRequest(next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve, reject)
          return
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    // 超时是"整件事"的超时（包括连接、发送、等待响应），不是"没数据"的超时
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'))
    })
    if (body) req.write(body)
    req.end()
  })
}
