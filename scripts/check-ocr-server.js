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
import { extractFilePart, extractTextPart, buildMultipart } from '../src/lib/multipart.js'
import { httpRequest } from '../src/lib/http.js'
import { cleanText, interpretOcrResponse } from '../src/lib/ocr.js'
import {
  BOARD_PROMPT, BOARD_LINES_PROMPT, CONFIG_KEYS, DEFAULT_CONFIG, DOC_PROMPT, PROVIDERS, STRUCT_PROMPT, TEXT_PROMPT, authHeaders, boardLinesPrompt,
  callDeepSeek, callProvider, callSimpleTex, cleanLatex,
  cleanModelOutput, cleanTextOutput, configFile, endpointOf, hasKey, loadConfig, normalizeConfig, parseProviderResponse,
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

  // ★ 界面上能改的字段 = CONFIG_KEYS（server.js 的白名单问它，**只有这一处**）
  //   漏一个键的表现是"设置里改了、存下去没了"，而且一句报错都没有：`boardModel` 就这么丢过。
  {
    const missing = Object.keys(DEFAULT_CONFIG).filter((k) => !CONFIG_KEYS.includes(k))
    eq(missing.join(','), '', '★ 设置里能改的字段一个都没漏（DEFAULT_CONFIG 的键必须都在 CONFIG_KEYS 里）')
    eq(CONFIG_KEYS.includes('boardModel'), true, '★ 「整板转录专用模型」能存进去（它丢过一次）')
    const kept = await saveConfig(root, { boardModel: 'strong-model-x', token: 'abcdef1234567890' })
    eq(kept.boardModel, 'strong-model-x', '存进去的 boardModel 留得住')
    eq(publicStatus(kept).boardModel, 'strong-model-x', '状态里报得出它（设置面板回显要用）')
    await saveConfig(root, { boardModel: '', token: 'abcdef1234567890' })
    eq((await loadConfig(root)).boardModel, '', '清空 = 回落到普通模型（不是删掉这个键）')
  }

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

// ═════════════════════ 8. 认普通文字（白板「美化手写」那条路） ═════════════════════
/* 这一节钉的是**两条路必须不一样**：认公式和认文字共用同一个接口、同一个 provider，
   差别全在 mode 上。混起来的后果都很安静 ——
   发错提示词（拿到一堆解释）、用错清洗规则（把用户写的半句话砍掉），
   界面上都不会报错，只会"认出来不对劲"。 */
console.log('\n[8] mode=text：认普通文字')
{
  const png = tinyWhitePng(8, 8)

  // ── mode 是 multipart 里的一个文本字段，而且排在文件**后面** ──
  const { body, contentType } = buildMultipart([
    { name: 'file', filename: 'ink.png', type: 'image/png', data: png },
    { name: 'mode', data: 'text' },
  ])
  eq(extractTextPart(body, contentType, 'mode'), 'text', '读得出 mode=text（它在文件那一段的后面，扫描得走过去）')
  /* ★ 文本字段排在**文件前面**时，文件也得找得到。
     这一条钉的是一个老 bug：multipart 的扫描原来是"每轮跳过下一个 part"，
     于是只看得到第 1、3、5… 个 part。以前浏览器总是把 file 排第一，所以没露出来。 */
  const swapped = buildMultipart([
    { name: 'mode', data: 'text' },
    { name: 'file', filename: 'ink.png', type: 'image/png', data: png },
  ])
  const sBack = extractFilePart(swapped.body, swapped.contentType)
  if (sBack && Buffer.compare(sBack.data, png) === 0) ok('文本字段排在前面时，后面的图照样找得到（不再隔一个 part 看一个）')
  else bad('文件排在第二个就找不到了 —— 扫描漏了偶数位那个 part')
  eq(extractTextPart(swapped.body, swapped.contentType, 'mode'), 'text', '文本字段排在前面时也读得到')
  const back = extractFilePart(body, contentType)
  if (back && Buffer.compare(back.data, png) === 0) ok('同一个包里那张图仍然逐字节完整（多一个文本字段没把它切坏）')
  else bad('加了文本字段之后图被切坏了 —— 这正是"识别服务说看不懂这张图"的来源')
  eq(extractTextPart(body, contentType, 'nope'), null, '没有这个字段 → null（不是空串，别把两者混起来）')
  eq(extractTextPart(png, 'image/png', 'mode'), null, '不是 multipart → null，不崩')

  // ── 清洗：文字这条**必须**和公式那条不同 ──
  eq(cleanTextOutput('安培环路定理：只对稳恒电流成立'), '安培环路定理：只对稳恒电流成立', '★ 冒号不动它 —— 整行都在')
  eq(cleanModelOutput('安培环路定理：只对稳恒电流成立'), '', '（对照）公式那条规则把它当"一句人话"整句丢掉 —— 所以两边必须是两个函数')
  eq(cleanTextOutput('第一行\n第二行'), '第一行\n第二行', '多行原样保留（公式那条只留"最像 LaTeX"的一行）')
  eq(cleanTextOutput('```\n一段笔记\n```'), '一段笔记', '``` 围栏剥掉（说了不要，模型还是会包）')
  eq(cleanTextOutput('“一句话”'), '一句话', '整段被成对引号包着 → 剥掉')
  eq(cleanTextOutput('EMPTY'), '', 'EMPTY → 没认出')
  eq(cleanTextOutput('这张图里没有文字。'), '', '"没有文字" → 没认出')
  eq(cleanTextOutput(''), '', '空回话 → 空')
  eq(cleanTextOutput(null), '', 'null → 空，不崩')

  /* 前端那份（src/lib/ocr.js 的 cleanText）和服务端这份各写了一遍 ——
     两份就必须**逐例一致**，否则"服务端清干净了、前端又清坏一遍"。 */
  const samples = ['a：b', '第一行\n第二行', '```\nx\n```', '“引用”', '「引用」', 'EMPTY', '', '  留白  ', '上面：下面\n第三行']
  const diff = samples.filter((s) => cleanTextOutput(s) !== cleanText(s))
  if (!diff.length) ok(`前端那份 cleanText 和服务端逐例一致（${samples.length} 个样例）`)
  else bad('两边清洗结果不一致：' + JSON.stringify(diff.map((s) => [s, cleanTextOutput(s), cleanText(s)])))

  // ── SimpleTex 干不了这件事，而且要当场说清换哪一家 ──
  const sx = normalizeConfig({ provider: 'simpletex', base: 'http://127.0.0.1:1/api/latex_ocr', token: 'test-token-123456' })
  const rp = await callProvider(sx, png, { mode: 'text' })
  eq(rp.kind, 'provider', 'SimpleTex + 认文字 → 单独一类错（不是笼统的"识别失败"）')
  if (/DeepSeek/.test(rp.error)) ok('这句提示直接告诉用户该换成 DeepSeek')
  else bad('错误提示里没说该换哪一家：' + rp.error)

  // ── DeepSeek 走 text：发出去的必须是**另一段提示词** ──
  const seen = []
  let reply = { code: 200, body: { choices: [{ message: { content: '```\n安培环路定理：只对稳恒电流成立\n```' } }] } }
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let json = null
      try {
        json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {}
      seen.push({ url: req.url, json })
      res.writeHead(reply.code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  const ds = normalizeConfig({ provider: 'deepseek', dsBase: `http://127.0.0.1:${port}/chat/completions`, token: 'sk-test-abcdefgh' })

  const rt = await callProvider(ds, png, { mode: 'text' })
  eq(rt.ok, true, '认普通文字 → 成功')
  eq(rt.text, '安培环路定理：只对稳恒电流成立', '围栏剥掉了，而且**整行都在**（冒号没被当成分隔符）')

  const promptOf = (req) => {
    const c = req && req.json && req.json.messages && req.json.messages[0] && req.json.messages[0].content
    const t = Array.isArray(c) ? c.find((x) => x.type === 'text') : null
    return (t && t.text) || ''
  }
  /* content 块本身（`[文字]` 还是 `[文字, 图]`）—— 结构整理那一趟必须**没有图**。 */
  const msgContent = (req) => req && req.json && req.json.messages && req.json.messages[0] && req.json.messages[0].content
  const pText = promptOf(seen[0])
  if (pText === TEXT_PROMPT) ok('发出去的是认文字那段提示词（原样，没被改过）')
  else bad('提示词不对：' + pText.slice(0, 80))
  if (/换行/.test(pText)) ok('提示词里要求保留换行（不然两行笔记会被连成一坨）')
  else bad('提示词没提换行')
  if (/不要.*LaTeX/.test(pText)) ok('提示词里写明了别把符号转成 LaTeX（文字卡是纯文本，转了就是一堆反斜杠）')
  else bad('提示词没挡住 LaTeX 转换')

  // 公式模式不能被这次改动带跑偏：不传 mode 时还是老样子
  reply = { code: 200, body: { choices: [{ message: { content: 'B=\\frac{a}{b}' } }] } }
  const rf = await callProvider(ds, png)
  eq(rf.latex, 'B=\\frac{a}{b}', '不传 mode（老调用方）→ 还是走公式那条路')
  if (promptOf(seen[1]) !== TEXT_PROMPT) ok('公式模式发的仍是公式提示词（两条路没有串）')
  else bad('公式模式也发成了文字提示词 —— 老功能会认出一堆解释')
  /* 板框脚手架（2026-09-19 晚）：图里会画进浅灰虚线框，提示词必须说清"它只是记号"，
     不然模型把框线当内容抄，草稿里就长出一堆"□"。 */
  if (/虚线框/.test(BOARD_PROMPT) && /分区记号/.test(BOARD_PROMPT) && /照常转录/.test(BOARD_PROMPT)) {
    ok('整板转录的提示词说清了虚线框只是分区记号（板框脚手架那刀）')
  } else bad('BOARD_PROMPT 缺"虚线框是分区记号、框内照常转录"那句 —— 模型会把框线当内容抄')

  /* ── 第 4 步：两趟分开（按行抄 / 结构整理）──────────────────────────────
     ① 带行清单时换成 BOARD_LINES_PROMPT，而且清单是**拼进去**的；
     ② 不带清单时退回老 BOARD_PROMPT（行为可预测，老调用方一个字不用改）；
     ③ 结构整理那一趟**一张图都不发**（content 里只有文字）。 */
  seen.length = 0
  reply = { code: 200, body: { choices: [{ message: { content: 'L1|甲\nL2-3|$\\frac{a}{b}$' } }] } }
  const rl = await callProvider(ds, png, { mode: 'board', lines: '行清单（这一块从上到下共 3 行）：\nL1 位于 0% 高度，居中' })
  eq(rl.ok, true, '带行清单的整板转录照旧成功')
  eq(promptOf(seen[0]).includes('L1 位于 0% 高度'), true, '★ 行清单被拼进了提示词（模型得先知道有几个行号）')
  eq(/\{\{LINES\}\}/.test(promptOf(seen[0])), false, '占位符被替换掉了（没漏出去）')
  eq(/L<行号>\|/.test(promptOf(seen[0])), true, '提示词里写明了 `L<行号>|` 这个契约')
  eq(/L5-6\|/.test(promptOf(seen[0])), true, '★ 也写明了"几行其实是一整块东西"时的范围写法（分数/矩阵）')
  eq(rl.text, 'L1|甲\nL2-3|$\\frac{a}{b}$', '认回来的原文一个字不改（行号是契约的一部分，不能剥）')
  seen.length = 0
  const rl2 = await callProvider(ds, png, { mode: 'board' })
  eq(promptOf(seen[0]) === BOARD_PROMPT, true, '★ 没有行清单 → 退回老 BOARD_PROMPT（老调用方行为不变）')
  eq(rl2.ok, true, '退回老路也照样成功')

  seen.length = 0
  reply = { code: 200, body: { choices: [{ message: { content: '{"sections":[],"relations":[]}' } }] } }
  const rs = await callProvider(ds, null, { mode: 'structure', input: 'L1：安培环路定理\nL2：只对稳恒电流成立' })
  eq(rs.ok, true, '结构整理那一趟成功')
  eq(rs.text, '{"sections":[],"relations":[]}', '回的就是那段 JSON（服务端**不解析**它 —— 落行校验在纯函数那边）')
  eq(promptOf(seen[0]).includes('L1：安培环路定理'), true, '输入那段文字跟着提示词一起发了过去')
  eq(/一个字都不要写/.test(promptOf(seen[0])), true, '★ 提示词里的铁律在：行的文字一个字都不许它写')
  /* ★ 2026-09-20 放行的那一处（`say`）：铁律要**收窄**，不能还写成"整趟一个字都不许写" ——
     那样模型会连 `say` 也不写，这一趟又退回"只有骨架"（用户报的正是那个）。 */
  eq(/除了 `say`/.test(promptOf(seen[0])), true, '★ 铁律收窄成"除了 say 那一段"（不然 say 永远不会出现）')
  eq(/唯一一处你可以自己写字的地方/.test(promptOf(seen[0])), true, '说清 `say` 是唯一可写处')
  eq(/不许引入这些行里没有的量、数字、结论/.test(promptOf(seen[0])), true, '★ 三个不许在（放行 ≠ 放开编造）')
  eq(/看不出这一节在讲什么，就写 null/.test(promptOf(seen[0])), true, '★ 看不出来就写 null（空的比硬凑的好）')
  eq(/推导/.test(promptOf(seen[0])) && /等价/.test(promptOf(seen[0])), true, '五个关系词都列了（不让它自由发挥）')
  eq(Array.isArray(msgContent(seen[0])) && msgContent(seen[0]).length === 1 && msgContent(seen[0])[0].type === 'text', true,
    '★ 结构整理**一张图都不发**（content 里只有文字块）')
  eq(/结构整理来自/.test(rs.note || ''), true, 'note 里报得出这一趟用的是什么（哪儿来的字要看得见）')

  /* ── 2026-09-22：课件整理（mode:'doc'）──────────────────────────────────
     一页课件 → 知识点 JSON。三件事必须在提示词这一层就钉住，因为它们决定了
     落到板上的东西对不对：① 页码要写在图上那段文字里（模型只看得到 content）；
     ② 提示词里**不许有位置/尺寸字段**（摆版是本地算的）；③ 回的 JSON 一行都不能压。 */
  seen.length = 0
  reply = { code: 200, body: { choices: [{ message: { content: '```json\n{"page":7,"unit":"拉普拉斯变换","points":[{"kind":"formula","tex":"F(s)=\\\\int_0^\\\\infty f(t)e^{-st}dt"}]}\n```' } }] } }
  const rd = await callProvider(ds, png, { mode: 'doc', page: 7 })
  eq(rd.ok, true, '课件整理那一趟成功')
  eq(promptOf(seen[0]).startsWith(DOC_PROMPT), true, '发出去的是课件整理那段提示词')
  eq(promptOf(seen[0]).includes('这一页是**第 7 页**'), true, '★ 页码写进了图上那段文字里（doc-cards 靠它把知识点挂到页上）')
  eq(/points/.test(DOC_PROMPT) && /"kind": "note"/.test(DOC_PROMPT), true, '提示词里给了回话的 JSON 形状（含 kind:note）')
  eq(/kind":"formula"|kind": "formula"/.test(DOC_PROMPT), true, '提示词里说清了"公式单独成一条"（公式要落成公式卡）')
  eq(/绝对不要编造/.test(DOC_PROMPT), true, '★ "绝对不要编造"在（白板是学生要信的起点，混进编的比少几条糟得多）')
  eq(/宁可少而准/.test(DOC_PROMPT), true, '★ "宁可少而准"在（凑数的条目会把白板淹掉）')
  /* ⚠ 判据要写得具体：`/x|y/` 会命中 `tex`（提示词里到处是它）—— 那种断言看着绿、
     其实什么都没验。这里只挑"坐标/尺寸"那一族的说法。 */
  eq(/"x"\s*:|"y"\s*:|坐标为|位置为|宽度|高度|左上角/.test(DOC_PROMPT), false, '★ 提示词里**没有**位置/尺寸这一族字段（摆版由 doc-cards.js 的 projectDeck 算）')
  eq(Array.isArray(msgContent(seen[0])) && msgContent(seen[0]).filter((x) => x.type === 'image_url').length === 1, true,
    '课件整理**要发图**（和结构整理相反）')
  eq(rd.text.includes('"page":7'), true, '回话原样带回来（围栏剥掉，JSON 一个字符不改）')
  /* 不传页码时不加那一行 —— 免得提示词里出现"第 0 页"这种会把它带偏的话。 */
  seen.length = 0
  await callProvider(ds, png, { mode: 'doc' })
  eq(/第 0 页/.test(promptOf(seen[0])), false, '不传 page 时不加"第 N 页"那一行')
  /* SimpleTex 干不了这一趟 —— 要在服务端就挡掉并说清换哪一家。 */
  const sxDoc = await callProvider(sx, png, { mode: 'doc' })
  eq(sxDoc.ok, false, 'SimpleTex + 课件整理 → 拒')
  eq(sxDoc.kind, 'provider', '归类成 provider（"这家干不了这件事"，用户该换一家）')
  eq(/课件整理/.test(sxDoc.error || ''), true, '错误里点名是"课件整理"要用 DeepSeek：' + String(sxDoc.error || '').slice(0, 30) + '…')

  srv.close()
}

// ═════════════════════ 9. 服务端没重启时不许"悄悄认成公式" ═════════════════════
/* 2026-09-16 用户报的原话：「美化手写依旧在认公式而不是字」。
 *
 * 根因不是这段逻辑，而是**改了 server-ocr.js 却没重启服务**：
 * 5177 上跑的还是启动那一刻加载的模块，它不认 mode 字段，
 * 于是照样按公式认、回一个 { ok, latex }。而前端是新构建的 ——
 * 一半新一半旧，界面上一句报错都没有，看起来就是"功能没做对"。
 *
 * 这条链路上必须有东西**当场认出"服务端是旧的"**，否则用户拿到的是
 * 一串塞进文字卡里的 LaTeX（反斜杠花括号），而且完全不知道哪里错了。
 * 两道防线：
 *   ① 面板读 /api/ocr/status 里的 `providers[p].modes` —— 老服务端根本没这个字段；
 *   ② 真发出去之后，认文字的**成功回包必须带 mode:'text'**，没带就拒收。
 * 这一节钉的是第 ② 道（纯函数，能在这里断言）。 */
console.log('\n[9] 服务端旧版：不许把"认公式的结果"当成文字收下')
{
  const staleBody = { ok: true, latex: 'B=\\frac{\\mu_0 I}{2\\pi r}', conf: null }
  const r1 = interpretOcrResponse(staleBody, 'text')
  eq(r1.ok, false, '认文字收到一个"没有 mode 字段"的成功回包 → **拒收**')
  eq(r1.kind, 'stale', '归类成 stale（不是 bad，也不是成功）—— 界面才能给出"重启服务"这句下一步')
  if (/重启|关掉再打开/.test(r1.error)) ok('错误里直接说了该重启：' + r1.error.slice(0, 40) + '…')
  else bad('没说清该干什么：' + r1.error)

  // 新版服务端的成功回包：带 mode:'text'
  const good = interpretOcrResponse({ ok: true, mode: 'text', text: '安培环路定理', conf: null }, 'text')
  eq(good.ok, true, '新版服务端（回包带 mode:text）→ 正常收下')
  eq(good.text, '安培环路定理', '文字原样拿到')
  // 公式这条老路不能被误伤：回包里本来就没有 mode 的时代也照样能用
  eq(interpretOcrResponse({ ok: true, latex: 'x^2', conf: 0.9 }, 'formula').ok, true, '公式模式不检查 mode（老回包照样收）')
  eq(interpretOcrResponse({ ok: true, mode: 'formula', latex: 'x^2' }, 'formula').latex, 'x^2', '公式模式拿到 latex')
  // 不传 mode = 老调用方的默认行为
  eq(interpretOcrResponse({ ok: true, latex: 'x^2' }).ok, true, '不传 mode（默认公式）→ 收下')
  // 错误回包原样透传，别被这道防线改写成 stale
  eq(interpretOcrResponse({ ok: false, kind: 'no-key', error: '还没填密钥' }, 'text').kind, 'no-key', '失败回包原样透传（不覆盖成 stale）')
  eq(interpretOcrResponse(null, 'text').kind, 'bad', '空回包 → bad，不崩')

  /* 第 ① 道防线就在 status 里：`modes` 是老服务端不会有的字段。
     这里断言它确实跟着 PROVIDERS 一起发出去（面板靠它提前警告）。 */
  const st = publicStatus(normalizeConfig({ provider: 'deepseek' }))
  eq(st.providers.deepseek.modes, ['formula', 'text', 'board', 'structure', 'doc'], 'status 里报得出"DeepSeek 能认公式、认文字、整板转录、结构整理、课件整理"（老服务端没这个字段 —— 这是第一道防线）')
  eq(st.providers.simpletex.formulaOnly, true, 'status 里说清了 SimpleTex 只认公式（面板据此提前警告，而不是等失败）')
}

console.log('\n' + '─'.repeat(56))
if (fails) {  console.log(`  ${checks} 项通过，${fails} 项失败`)
  process.exit(1)
} else {
  console.log(`  全部 ${checks} 项通过`)
}
