/* 手写识别的自检（纯 node，不联网、不花额度、不用真密钥）。
 *
 * ── 怎么做到"整条链路都测"却又不联网 ──
 * 起一个**假的识别服务**（就一个本地 HTTP 服务），让它按官方文档的形状回话：
 *   { "status": true, "res": { "latex": "...", "conf": 0.95 }, "request_id": "..." }
 * 然后把 base 指过去。这样"我们的服务器到底发出去了什么请求"这件事
 * 是被**真的收下并检查**的 —— 不是靠 mock 掉 fetch 假装成功。
 *
 * ── 为什么值得这么麻烦 ──
 * 这一段是"本地服务 → 外部服务"，最容易出的错是**看着成功其实什么都没发对**：
 *   · multipart 拼错 → 对方收不到文件
 *   · 鉴权头写错名字 → 401
 *   · 把二进制的 PNG 转成字符串再拼 → 图片被换成 U+FFFD，对方说"看不懂"
 *   · 回包字段名认错 → 明明识别成功却报"没认出公式"
 * 这些全都不会在本地报错。所以这个自检把发出去的请求逐字节看一遍。
 *
 * 跑：npm run check:ocr
 */
import http from 'node:http'
import { extractFilePart, buildMultipart } from '../src/lib/multipart.js'
import { httpRequest } from '../src/lib/http.js'
import {
  DEFAULT_CONFIG, PROVIDERS, authHeaders, callDeepSeek, callProvider, callSimpleTex, cleanLatex,
  cleanModelOutput, configFile, endpointOf, hasKey, loadConfig, normalizeConfig, parseProviderResponse,
  publicStatus, saveConfig, testProvider, tinyWhitePng,
} from '../server-ocr.js'

let fails = 0
let checks = 0
const ok = (m) => {
  checks++
  console.log('  ✓ ' + m)
}
const bad = (m) => {
  fails++
  console.log('  ✗ ' + m)
}
const eq = (got, want, label) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) ok(`${label}  →  ${g}`)
  else bad(`${label}\n      实际 ${g}\n      期望 ${w}`)
}

// ═════════════════════ 1. multipart 的拼与拆 ═════════════════════
console.log('\n[1] multipart：二进制必须原样过去')
{
  /* ★ 这一节是整个自检里最重要的一条。
     把 PNG 先 toString 再拼，是这条链路上最典型的静默错误：
     图废了、但本地一切正常，只有识别服务回一句"看不懂这张图"。 */
  const png = tinyWhitePng(8, 8)
  const { body, contentType } = buildMultipart([
    { name: 'file', filename: 'ink.png', type: 'image/png', data: png },
  ])
  const back = extractFilePart(body, contentType)
  if (!back) bad('拼出来的 multipart 自己拆不回来')
  else {
    ok(`拼了 ${body.length} 字节，自己拆回来了（${back.filename}）`)
    if (Buffer.compare(back.data, png) === 0) ok(`${png.length} 字节二进制逐字节一致（没有被当字符串改写）`)
    else {
      bad('二进制被改写了 —— 这正是"图片发过去对方说看不懂"的根因')
      console.log(`      发出 ${png.length} 字节，收回 ${back.data.length} 字节`)
    }
  }

  // 含 0x00 / 0xFF / 换行 / 边界样字符串的极端二进制
  const evil = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x80, 0xc3, 0x28, 0xff, 0x00, 0x1a])
  const e2 = buildMultipart([{ name: 'file', filename: 'x.bin', data: evil }])
  const back2 = extractFilePart(e2.body, e2.contentType)
  if (back2 && Buffer.compare(back2.data, evil) === 0) ok('含 0x00/0xFF/换行的二进制也原样通过')
  else bad('特殊字节被改写了')

  // 空文件和缺字段
  eq(extractFilePart(Buffer.from('not-multipart'), 'text/plain'), null, '不是 multipart → null（不崩）')
  eq(extractFilePart(Buffer.alloc(0), 'multipart/form-data; boundary=xyz'), null, '空体 → null')

  // 边界带引号（浏览器会这么发）
  const q = buildMultipart([{ name: 'file', filename: 'a.png', data: png }], { boundary: 'B-1' })
  if (extractFilePart(q.body, 'multipart/form-data; boundary="B-1"')) ok('边界带引号也能拆（浏览器会这么发）')
  else bad('边界带引号时拆不出来')
}

// ═════════════════════ 2. 配置与密钥 ═════════════════════
console.log('\n[2] 配置：密钥进得来、出不去')
{
  const root = '.cache/ocr-test-root'
  const fs = await import('node:fs/promises')
  await fs.rm(root, { recursive: true, force: true })

  const fresh = await loadConfig(root)
  eq(hasKey(fresh), false, '没配过 → 没有密钥')
  eq(fresh.base, DEFAULT_CONFIG.base, '没配过 → 用默认的服务地址')

  const saved = await saveConfig(root, { token: 'abcdef1234567890', turbo: false })
  eq(saved.turbo, false, '存进去的 turbo=false 生效了')
  const back = await loadConfig(root)
  eq(back.token, 'abcdef1234567890', '密钥存得住')
  if (configFile(root).replace(/\\/g, '/').endsWith('config/ocr.json')) ok('配置文件在 config/ocr.json（.gitignore 里排掉了）')
  else bad('配置文件路径不对：' + configFile(root))

  // ★ 密钥绝不能出现在"给前端的状态"里
  const st = publicStatus(back)
  const dump = JSON.stringify(st)
  if (dump.includes('abcdef1234567890')) bad('给前端的状态里带着完整密钥 —— 等于把密钥发给了页面')
  else ok('给前端的状态里没有密钥（只给末四位：' + st.tokenTail + '）')
  eq(st.configured, true, '状态里只说"配过了"')

  // 清空密钥 = 合法操作（不该被当成"没改"）
  const cleared = await saveConfig(root, { token: '' })
  eq(hasKey(cleared), false, '密钥可以被清空')

  // 一堆脏输入不能把地址带跑偏
  eq(normalizeConfig({ base: 'file:///etc/passwd' }).base, DEFAULT_CONFIG.base, '非 http(s) 的地址被挡回默认值')
  eq(normalizeConfig({ base: '  ' }).base, DEFAULT_CONFIG.base, '空地址 → 默认值')
  eq(normalizeConfig({ token: '   abcdefgh   ' }).token, 'abcdefgh', '密钥两边的空格被去掉')
  eq(normalizeConfig({ enabled: 'no' }).enabled, true, '只认布尔 false 才算关（字符串不算）')
  eq(normalizeConfig(null).turbo, true, 'null 配置 → 全部默认')

  await fs.rm(root, { recursive: true, force: true })
}

// ═════════════════════ 3. 请求长什么样 ═════════════════════
console.log('\n[3] 请求：地址和鉴权头')
{
  const c = normalizeConfig({ base: 'https://example.com/api/latex_ocr', token: 'tok-abcdefgh', turbo: true })
  eq(endpointOf(c), 'https://example.com/api/latex_ocr_turbo', 'turbo 模式 → 地址加 _turbo（官方就这两个接口）')
  eq(endpointOf({ ...c, turbo: false }), 'https://example.com/api/latex_ocr', '标准模式 → 原地址')
  eq(endpointOf({ ...c, base: 'https://example.com/api/latex_ocr/' }), 'https://example.com/api/latex_ocr_turbo', '末尾多一个斜杠也不会拼出 //')
  eq(authHeaders(c), { token: 'tok-abcdefgh' }, '鉴权头默认叫 token')
  eq(authHeaders({ ...c, tokenHeader: 'Authorization' }), { Authorization: 'tok-abcdefgh' }, '头名字可以改（服务改了我们不用改代码）')
  eq(authHeaders({ ...c, token: '' }), {}, '没密钥就不带鉴权头')
}

// ═════════════════════ 4. 回包怎么认 ═════════════════════
console.log('\n[4] 回包：认得出成功，也认得出失败')
{
  eq(parseProviderResponse({ status: true, res: { latex: 'a^{2}-b^{2}', conf: 0.95 } }), { ok: true, latex: 'a^{2}-b^{2}', conf: 0.95 }, '官方文档里的成功样子')
  eq(parseProviderResponse({ status: false, message: '余额不足' }).kind, 'bad', 'status=false 时把对方的话带回来')
  eq(parseProviderResponse(null).ok, false, '空回包 → 失败，不崩')
  eq(parseProviderResponse({ status: true, res: {} }).kind, 'empty', '回包里没有 latex → empty（不是"失败"，是"没认出"）')
  eq(parseProviderResponse({ status: true, res: { latex: '   ' } }).kind, 'empty', '空白 latex 也算没认出')
  // 定界符要剥掉
  eq(cleanLatex('$$x^2$$'), 'x^2', '$$…$$ 剥掉')
  eq(cleanLatex('$x^2$'), 'x^2', '$…$ 剥掉')
  eq(cleanLatex('\\[x^2\\]'), 'x^2', '\\[…\\] 剥掉')
  eq(cleanLatex('x^2'), 'x^2', '本来没定界符就不动')
  eq(parseProviderResponse({ status: true, res: { latex: '$E=mc^2$' } }).latex, 'E=mc^2', '回包里的定界符也剥掉')
}

// ═════════════════════ 5. 假的识别服务（端到端） ═════════════════════
console.log('\n[5] 端到端：起一个假识别服务，看我们到底发出去了什么')
{
  const seen = []
  let reply = { code: 200, body: { status: true, res: { latex: '\\frac{a}{b}', conf: 0.93 }, request_id: 'req-1' } }

  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const part = extractFilePart(raw, req.headers['content-type'] || '')
      seen.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        bytes: raw.length,
        filename: part ? part.filename : null,
        magic: part ? part.data.subarray(0, 4).toString('hex') : null,
        fileBytes: part ? part.data.length : 0,
      })
      res.writeHead(reply.code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  const base = `http://127.0.0.1:${port}/api/latex_ocr`
  /* 显式指定 simpletex：这个假服务回的是 SimpleTex 那种形状
     （{status, res:{latex}}）。default 现在是 deepseek，
     不写这一行的话请求会走 OpenAI 兼容那条路，然后"认不出回包"——
     那种失败看起来像"识别服务坏了"，其实是测试自己没配好。 */
  const cfg = normalizeConfig({ provider: 'simpletex', base, token: 'test-token-123456', turbo: true })

  // ① 正常一次
  const png = tinyWhitePng(16, 16)
  const r1 = await callProvider(cfg, png)
  eq(r1.ok, true, '假服务回成功 → 我们报成功')
  eq(r1.latex, '\\frac{a}{b}', '把 latex 取出来了')
  eq(r1.conf, 0.93, '置信度也取出来了')
  eq(r1.requestId, 'req-1', 'request_id 透出来了（排查时有用）')

  const s = seen[0]
  eq(s.method, 'POST', '用的是 POST')
  eq(s.url, '/api/latex_ocr_turbo', '打到了 turbo 那个地址')
  eq(s.headers.token, 'test-token-123456', '鉴权头带上了（名字对、值对）')
  eq(s.filename, 'ink.png', '文件名是 ink.png')
  if (s.magic === '89504e47') ok('收到的确实是 PNG（魔数 89 50 4e 47）')
  else bad('对方收到的不是 PNG，魔数是 ' + s.magic + ' —— multipart 拼坏了')
  eq(s.fileBytes, png.length, `图片字节数一致（${png.length}）`)

  // ② 各种失败：分得清是谁的错
  reply = { code: 401, body: { status: false, message: 'invalid token' } }
  const r401 = await callProvider(cfg, png)
  eq(r401.ok, false, '401 → 失败')
  eq(r401.kind, 'key', '401 → 归类成"密钥问题"（提示用户去改密钥，而不是去改网络）')

  reply = { code: 429, body: { status: false } }
  eq((await callProvider(cfg, png)).kind, 'quota', '429 → 归类成"额度/限流"')

  reply = { code: 500, body: { error: 'internal' } }
  eq((await callProvider(cfg, png)).kind, 'bad', '500 → 归类成"对方出问题了"')

  reply = { code: 200, body: { status: true, res: {} } }
  eq((await callProvider(cfg, png)).kind, 'empty', '200 但没内容 → "没认出"')

  reply = { code: 200, body: '<html>网关错误页</html>' }
  const rHtml = await callProvider(cfg, png)
  eq(rHtml.ok, false, '回的不是 JSON 也不崩')
  if (rHtml.raw && rHtml.raw.includes('网关')) ok('把对方的原文留了一段（排查时能看出真相）')
  else bad('没留下对方原文，出问题时无从查起')

  // ③ 连不上：地址指到一个没人听的端口
  /* ★ provider 必须显式写死成 simpletex。
     漏了它就会走默认的 deepseek，然后请求真的发到 api.deepseek.com 去了 ——
     拿一个假 token 换回一个 401，于是归类成 "key" 而不是 "network"。
     这条断言之所以值钱：它是唯一会**真的出网**的一步，
     写错了不会报错，只会安静地去连真服务。 */
  const dead = normalizeConfig({ provider: 'simpletex', base: 'http://127.0.0.1:1/api/latex_ocr', token: 'test-token-123456' })
  const rDead = await callProvider(dead, png, { timeoutMs: 3000 })
  eq(rDead.ok, false, '连不上 → 失败')
  eq(rDead.kind, 'network', '连不上 → 归类成 network')

  // 同一个"连不上"，DeepSeek 那条路也得分类正确（它是另一段代码）
  const deadDs = normalizeConfig({ provider: 'deepseek', dsBase: 'http://127.0.0.1:1/chat/completions', token: 'sk-test-123456' })
  eq((await callDeepSeek(deadDs, png, { timeoutMs: 3000 })).kind, 'network', 'DeepSeek 那条路连不上也归成 network')

  // ④ 体检：留白图认不出内容也算"服务正常"
  reply = { code: 200, body: { status: true, res: {} } }
  const t = await testProvider(cfg)
  eq(t.ok, true, '体检：留白图 → 服务正常（认不出内容是预期的）')
  eq((await testProvider(normalizeConfig({ base, token: '' }))).kind, 'no-key', '体检：没填密钥就直接说没填')

  srv.close()
}

// ═════════════════════ 5. DeepSeek（默认 provider）的契约 ═════════════════════
/* 这一节按官方文档钉住请求形状：OpenAI 兼容的 /chat/completions、Bearer 鉴权、
   content 是**块数组**（不是字符串）、图片走 base64 data URL。
   这些都是"写错了就 400、而且报错看不出是哪个字段"的地方。 */
console.log('\n[5] DeepSeek：请求形状和回话清洗')
{
  // ── 回话清洗（LLM 会做的事，全得处理）──
  eq(cleanModelOutput('\\frac{a}{b}'), '\\frac{a}{b}', '老老实实只回 LaTeX → 原样')
  eq(cleanModelOutput('```latex\n\\frac{a}{b}\n```'), '\\frac{a}{b}', '包在 ```latex 里 → 剥掉（哪怕说了不要，它还是会包）')
  eq(cleanModelOutput('```\nE=mc^2\n```'), 'E=mc^2', '包在 ``` 里 → 剥掉')
  eq(cleanModelOutput('$E=mc^2$'), 'E=mc^2', '带 $ 定界符 → 剥掉')
  eq(cleanModelOutput('图片里的公式是：\\oint \\vec{B}\\cdot d\\vec{l}'), '\\oint \\vec{B}\\cdot d\\vec{l}', '"图片里的公式是：" 这种前言 → 抠出后面那句')
  eq(cleanModelOutput('这张图片中是一个手写的积分公式。'), '', '只回一句中文解释 → 当没认出（不把中文塞进卡片）')
  eq(cleanModelOutput('EMPTY'), '', 'EMPTY → 没认出')
  eq(cleanModelOutput('这张图里没有公式。'), '', '"没有公式" → 没认出')
  eq(cleanModelOutput(''), '', '空回话 → 没认出')
  eq(cleanModelOutput(null), '', 'null → 没认出')
  // 有中文但确实带 LaTeX 的，要留下（\text{内} 这种很常见）
  eq(cleanModelOutput('I_{\\text{内}}'), 'I_{\\text{内}}', '带 \\text{中文} 的式子要留下')
  eq(cleanModelOutput('公式：B=\\frac{\\mu_0 I}{2\\pi r}'), 'B=\\frac{\\mu_0 I}{2\\pi r}', '中文前言 + 真公式 → 抠出公式')

  // ── 请求形状：起一个假 DeepSeek ──
  const seen = []
  let reply = { code: 200, body: { choices: [{ message: { role: 'assistant', content: '```latex\nB=\\frac{\\mu_{0}I}{2\\pi r}\n```' } }] } }
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let json = null
      try {
        json = JSON.parse(raw)
      } catch {}
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, ct: req.headers['content-type'], json })
      res.writeHead(reply.code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  const cfg = normalizeConfig({ provider: 'deepseek', dsBase: `http://127.0.0.1:${port}/chat/completions`, model: 'deepseek-flash', token: 'sk-test-abcdefgh' })

  const png = tinyWhitePng(16, 16)
  const r1 = await callProvider(cfg, png)
  eq(r1.ok, true, '假 DeepSeek 回成功 → 我们报成功')
  eq(r1.latex, 'B=\\frac{\\mu_{0}I}{2\\pi r}', '把 ```latex 里的公式抠出来了')

  const s = seen[0]
  eq(s.method, 'POST', '用的是 POST')
  eq(s.url, '/chat/completions', '打到 /chat/completions')
  eq(s.auth, 'Bearer sk-test-abcdefgh', '鉴权是 Authorization: Bearer（不是 SimpleTex 那种 token 头）')
  eq(s.ct, 'application/json', 'Content-Type 是 JSON')
  eq(s.json && s.json.model, 'deepseek-flash', 'model 字段是 deepseek-flash（旧名字 deepseek-v4-flash-vision-exp 已下线）')
  const content = s.json && s.json.messages && s.json.messages[0] && s.json.messages[0].content
  if (Array.isArray(content)) ok('content 是**块数组**（OpenAI 视觉格式就要求这样，写成字符串会 400）')
  else bad('content 不是块数组：' + typeof content)
  if (Array.isArray(content) && content.some((c) => c.type === 'text')) ok('块数组里有 text 块（那段"只输出 LaTeX"的指令）')
  else bad('块数组里没有 text 块')
  const img = Array.isArray(content) && content.find((c) => c.type === 'image_url')
  if (img && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img.image_url.url)) ok('图是 base64 data URL（官方支持的内联方式）')
  else bad('图片块形状不对：' + JSON.stringify(img).slice(0, 120))
  if (s.json && s.json.temperature === 0) ok('temperature=0（识别是"抄"不是"创作"）')
  else bad('没有把 temperature 设成 0')

  // 错误分流（DeepSeek 和 SimpleTex 共用同一套分类）
  reply = { code: 401, body: { error: { message: 'Authentication Fails' } } }
  eq((await callDeepSeek(cfg, png)).kind, 'key', 'DeepSeek 401 → 归类成"密钥问题"')
  reply = { code: 402, body: { error: { message: 'Insufficient Balance' } } }
  const r402 = await callDeepSeek(cfg, png)
  eq(r402.kind, 'bad', '402 余额不足 → 归到 bad')
  if (/余额不足/.test(r402.error)) ok('402 的提示里说了"余额不足"，还把对方的话带出来了')
  else bad('402 的提示不清楚：' + r402.error)
  reply = { code: 200, body: { choices: [{ message: { content: '这张图里没有公式。' } }] } }
  eq((await callDeepSeek(cfg, png)).kind, 'empty', '模型回"没有公式" → 归成 empty（不是失败）')
  reply = { code: 200, body: { choices: [] } }
  eq((await callDeepSeek(cfg, png)).kind, 'empty', '回包里没有 choices → 不崩，归成 empty')

  // 体检
  reply = { code: 200, body: { choices: [{ message: { content: 'EMPTY' } }] } }
  const t = await testProvider(cfg)
  eq(t.ok, true, '体检：留白图 → 服务正常')
  eq((await testProvider(normalizeConfig({ ...cfg, token: '' }))).kind, 'no-key', '体检：没填密钥就直接说没填')

  srv.close()

  // provider 分派：配的是谁就发给谁
  eq(normalizeConfig({ provider: '胡说' }).provider, 'deepseek', '认不出的 provider 名 → 回默认（不会因为配置写错就整个不能用）')
  if (PROVIDERS.deepseek && PROVIDERS.simpletex) ok('两家 provider 都有给界面看的说明文字（label/needs/note）')
  else bad('PROVIDERS 里缺说明文字，设置面板会显示空白')
  const st = publicStatus(normalizeConfig({ token: 'sk-secret-should-not-leak' }))
  if (!JSON.stringify(st).includes('sk-secret-should-not-leak')) ok('DeepSeek 的密钥同样不会出现在给前端的状态里')
  else bad('密钥漏进状态里了')
}

// ═════════════════════ 6. SimpleTex 的契约（另一条路） ═════════════════════
console.log('\n[6] SimpleTex：multipart 那条路也得是通的')
{
  const seen = []
  let reply = { code: 200, body: { status: true, res: { latex: '\\frac{a}{b}', conf: 0.93 }, request_id: 'req-1' } }
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const part = extractFilePart(raw, req.headers['content-type'] || '')
      seen.push({ url: req.url, token: req.headers.token, magic: part ? part.data.subarray(0, 4).toString('hex') : null, fileBytes: part ? part.data.length : 0 })
      res.writeHead(reply.code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  const cfg = normalizeConfig({ provider: 'simpletex', base: `http://127.0.0.1:${port}/api/latex_ocr`, token: 'test-token-123456', turbo: true })

  const png = tinyWhitePng(16, 16)
  const r1 = await callProvider(cfg, png)
  eq(r1.ok, true, 'provider=simpletex 时走的是 multipart 那条路')
  eq(seen[0].url, '/api/latex_ocr_turbo', '地址还是带 _turbo')
  eq(seen[0].token, 'test-token-123456', '鉴权用的是 token 头（不是 Bearer）')
  eq(seen[0].magic, '89504e47', '发出去的还是 PNG')
  eq(seen[0].fileBytes, png.length, '字节数一致')

  reply = { code: 401, body: { status: false } }
  eq((await callSimpleTex(cfg, png)).kind, 'key', 'SimpleTex 401 走同一套分类')
  srv.close()
}

// ═════════════════════ 7. httpRequest 真的发的出去 ═════════════════════
console.log('\n[7] httpRequest：真的能把 body 发出去并收回 JSON')
{
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: true, res: { latex: 'x^2', conf: 1 }, got: Buffer.concat(chunks).length }))
    })
  })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  const { body, contentType } = buildMultipart([{ name: 'file', filename: 'ink.png', data: tinyWhitePng(4, 4) }])
  const r = await httpRequest(`http://127.0.0.1:${port}/x`, { method: 'POST', headers: { 'Content-Type': contentType }, body, timeoutMs: 5000 })
  eq(r.status, 200, 'HTTP 200')
  eq(JSON.parse(r.text).got, body.length, '对方收到的字节数和我们发的一致')
  srv.close()

  // 超时：对方不回，我们必须及时放弃（不能让前端一直转圈）
  const slow = http.createServer(() => {})
  const p2 = await new Promise((r2) => slow.listen(0, '127.0.0.1', () => r2(slow.address().port)))
  const t0 = Date.now()
  let timedOut = false
  try {
    await httpRequest(`http://127.0.0.1:${p2}/x`, { method: 'POST', body: Buffer.from('x'), timeoutMs: 800 })
  } catch (e) {
    timedOut = /timeout/i.test(e.message)
  }
  const ms = Date.now() - t0
  if (timedOut && ms < 4000) ok(`对方不回话时 ${ms}ms 就放弃了（不是一直挂着）`)
  else bad(`超时没生效（${ms}ms，timedOut=${timedOut}）`)
  slow.close()
}

console.log('\n' + '─'.repeat(56))
if (fails) {
  console.log(`  ${checks} 项通过，${fails} 项失败`)
  process.exit(1)
} else {
  console.log(`  全部 ${checks} 项通过`)
}
