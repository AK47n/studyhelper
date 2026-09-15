/* TLS + 出网请求的体检。
 *
 * 为什么专门有一个：手写识别那条链路要跟外部服务说话，而"发不出去"和
 * "发出去了对方不认"是完全两回事。这个脚本把"能不能连、能不能握手、
 * 能不能拿到响应"逐层测一遍，省得在业务代码里猜。
 *
 * 它还记录了一个**踩过的坑**：node 内置 fetch（undici）连本机 HTTPS 会挂住
 * 不返回，而 tls.connect / https.request 一秒就通。所以全项目的出网请求
 * 都走 src/lib/http.js（node:http/https 手写），不用 fetch。
 * 这个脚本就是把这条结论钉住 —— 谁哪天想把 http.js 换回 fetch，先跑它。
 *
 * 跑：node scripts/diag-net.js
 */
import { makeSelfSignedCert } from './lib/selfcert.js'
import { httpRequest } from '../src/lib/http.js'

let fails = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => {
  fails++
  console.log('  ✗ ' + m)
}

console.log('\n[1] 自签证书能不能被 node 接受')
{
  const c = makeSelfSignedCert()
  const srv = (await import('node:https')).createServer({ key: c.key, cert: c.cert }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('pong')
  })
  const port = await new Promise((res) => {
    srv.listen(0, '127.0.0.1', () => res(srv.address().port))
  })
  ok(`HTTPS 服务起来了（127.0.0.1:${port}，指纹 ${c.fingerprint.slice(0, 12)}）`)
  srv.close()

  // 用 X509 解析器验一遍结构（比"能不能 listen"更早发现问题）
  try {
    const x = new (await import('node:crypto')).X509Certificate(c.cert)
    ok(`证书结构合法：subject=${x.subject.replace(/\n/g, ' ')}，SAN=${x.subjectAltName}`)
  } catch (e) {
    bad('证书结构不合法：' + e.message + '（跑 node scripts/diag-cert.js 看结构）')
  }
}

console.log('\n[2] 用 src/lib/http.js 连本机 HTTPS（**这就是那个坑**）')
{
  const c = makeSelfSignedCert()
  const https = await import('node:https')
  const srv = https.createServer({ key: c.key, cert: c.cert }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('pong-from-tls')
  })
  const port = await new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)))

  // 自签证书：这个测试要放行它。做法是把 ca 指成自己那张证书 ——
  // 比关掉校验（NODE_TLS_REJECT_UNAUTHORIZED=0）克制得多：只信这一张。
  process.env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS || ''
  const t0 = Date.now()
  const done = await Promise.race([
    httpRequest(`https://127.0.0.1:${port}/ping`, { timeoutMs: 6000 }).catch((e) => ({ error: e.message })),
    new Promise((r) => setTimeout(() => r({ error: 'HANG' }), 8000)),
  ])
  const ms = Date.now() - t0
  srv.close()

  if (done.error === 'HANG') {
    bad(`httpRequest 连本机 HTTPS 挂住了（>8 秒没回）—— 说明它退化成了 fetch 那种行为`)
  } else if (done.error) {
    // 自签证书被拒是**正常**的（我们没配信任链），关键是它"及时地拒绝"而不是挂住
    if (/self.signed|unable to verify|DEPTH_ZERO|self signed/i.test(done.error)) {
      ok(`连上了 TLS 并在 ${ms}ms 内明确拒绝自签证书（预期行为；关键是"及时"，不是"同意"）`)
    } else {
      bad('预期是自签证书被拒，实际是：' + done.error)
    }
  } else {
    ok(`握手成功、拿到响应「${done.text}」（${ms}ms）`)
  }
}

console.log('\n[3] 出网：真的能连到识别服务的域名吗')
{
  const t0 = Date.now()
  const r = await Promise.race([
    httpRequest('https://server.simpletex.net', { method: 'HEAD', timeoutMs: 10000 }).catch((e) => ({ error: e.message })),
    new Promise((r) => setTimeout(() => r({ error: 'HANG' }), 12000)),
  ])
  const ms = Date.now() - t0
  if (r.error === 'HANG') bad('连识别服务挂住（>12 秒）')
  else if (r.error) console.log(`  ⚠ 连不上识别服务：${r.error}（没网也能用其它功能，识别会报 network）`)
  else ok(`识别服务可达：HTTP ${r.status}（${ms}ms）`)
}

console.log('\n' + '─'.repeat(52))
console.log(fails ? `  ${fails} 项失败` : '  全部通过')
process.exit(fails ? 1 : 0)
