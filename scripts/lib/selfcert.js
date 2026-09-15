/* 现场生成一张自签证书 + 私钥（PEM）。
 *
 * 为什么需要它：手写识别的整条链路要测到"服务端到服务端怎么发请求"这一层，
 * 那就得有一个真的 HTTPS 服务在监听。而 HTTPS 需要证书。
 *
 * 为什么不把证书当成文件塞进仓库：私钥进 Git 是坏习惯（哪怕它只是个测试证书）——
 * 下一个人会以为"这个仓库里有密钥是正常的"。而且证书有有效期，
 * 存进去过两年就过期，自检会变成一个和代码无关的失败。
 *
 * ⚠ 这是**测试用**的：只有 1 天有效期、CN 写死在 127.0.0.1、不签任何别的东西。
 *
 * ── 手搓 ASN.1 这件事我栽了四轮，把形状记在这里 ──
 * Node 没有公开的"签发证书"API。这个文件按 X.509 的字段顺序拼 DER，
 * 好处是**拼错就立刻报错**（tls.createServer 当场拒绝，不会静默降级成明文），
 * 坏处是报错只有一句 `wrong tag` / `nested asn1`，完全看不出是哪一层。
 * 所以配了 scripts/diag-cert.js：它把 DER 逐层打出来，并且**用二分裁剪**定位
 * （我最后就是靠"去掉 extensions 就通过"才找到那个漏掉的 OCTET STRING）。
 */
import crypto from 'node:crypto'

const B64 = (buf) =>
  Buffer.from(buf)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()

function pem(label, der) {
  return `-----BEGIN ${label}-----\n${B64(der)}\n-----END ${label}-----\n`
}

/**
 * @returns {{key: string, cert: string, fingerprint: string}} 都是 PEM 文本
 */
export function makeSelfSignedCert({ days = 1, cn = '127.0.0.1' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

  const now = new Date()
  const notBefore = new Date(now.getTime() - 60 * 1000)
  const notAfter = new Date(now.getTime() + days * 24 * 3600 * 1000)

  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const tbs = buildTbs({ cn, spki, notBefore, notAfter })
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })

  const certDer = seq(tbs, sigAlg(), derBitString(sig))
  return {
    key: pem('PRIVATE KEY', privateKey.export({ type: 'pkcs8', format: 'der' })),
    cert: pem('CERTIFICATE', certDer),
    fingerprint: crypto.createHash('sha256').update(certDer).digest('hex'),
  }
}

/* ── 够用就好的 DER 编码（只覆盖这张证书要用的几个标签）── */

const len = (n) =>
  n < 0x80
    ? Buffer.from([n])
    : n < 0x100
      ? Buffer.from([0x81, n])
      : Buffer.from([0x82, n >> 8, n & 0xff])
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body])
const seq = (...parts) => tlv(0x30, Buffer.concat(parts))
const set = (...parts) => tlv(0x31, Buffer.concat(parts))
const int = (n) => {
  const bytes = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v >>= 8
  }
  if (!bytes.length) bytes.push(0)
  if (bytes[0] & 0x80) bytes.unshift(0) // 正整数不能看起来像负数
  return tlv(0x02, Buffer.from(bytes))
}
const oid = (dotted) => {
  const parts = dotted.split('.').map(Number)
  const body = [40 * parts[0] + parts[1]]
  for (const p of parts.slice(2)) {
    const stack = []
    let v = p
    do {
      stack.unshift(v & 0x7f)
      v >>= 7
    } while (v > 0)
    for (let i = 0; i < stack.length - 1; i++) stack[i] |= 0x80
    body.push(...stack)
  }
  return tlv(0x06, Buffer.from(body))
}
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))
const nullTag = () => Buffer.from([0x05, 0x00])
const derBitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]))
const octet = (buf) => tlv(0x04, buf)
const ctx = (n, body) => tlv(0xa0 + n, body)

/* 用 GeneralizedTime（0x18）而不是 UTCTime（0x17）：UTCTime 只写两位年份，
   解释时以 50 年为界（"26" 是 2026 还是 1926 有歧义）。有效期就 1 天时两种都对，
   但 GeneralizedTime 不给人留这个坑。 */
function genTime(d) {
  const p = (x) => String(x).padStart(2, '0')
  const s = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return tlv(0x18, Buffer.from(s, 'ascii'))
}

const sigAlg = () => seq(oid('1.2.840.10045.4.3.2'), nullTag()) // ecdsa-with-SHA256

const rdn = (cn) => set(seq(oid('2.5.4.3'), utf8(cn))) // CN

function buildTbs({ cn, spki, notBefore, notAfter }) {
  const version = ctx(0, int(2)) // v3
  const serial = int(Math.floor(Date.now() / 1000) & 0x7fffffff)
  const validity = seq(genTime(notBefore), genTime(notAfter))
  const subject = seq(rdn(cn))
  const issuer = subject // 自签：签发者就是自己

  /* SAN 必须有：现代 TLS 校验已经不认 CN 了，没有 SAN 的证书会报
     "cert altname invalid" —— 那个报错看起来像"地址写错了"，会让人查错方向。
   ⚠ Extension 的形状必须记准（我在这上面栽了三轮，最后靠二分裁剪才定位）：
       Extension  ::= SEQUENCE { extnID OID, extnValue OCTET STRING }
       extnValue 里装的才是 SAN 自己的 DER（再里面才是 GeneralNames 的 SEQUENCE）
     也就是：ctx[3]( SEQUENCE( SEQUENCE( OID, OCTETSTRING( SEQUENCE( ctx[2]( name ) ) ) ) ) )
     漏掉那个 OCTET STRING 时 OpenSSL 只说一句 wrong tag，看不出是哪一层。 */
  const sanExt = seq(
    oid('2.5.29.17'), // subjectAltName
    octet(seq(tlv(0x82, Buffer.from(cn, 'ascii'))))
  )
  const extensions = ctx(3, seq(sanExt))

  /* spki 已经是完整的 SEQUENCE（publicKey.export 给的就是 DER），
     所以直接放进去，**不要**再包一层 seq —— 多包一层就是 nested asn1。 */
  return seq(version, serial, sigAlg(), issuer, validity, subject, spki, extensions)
}
