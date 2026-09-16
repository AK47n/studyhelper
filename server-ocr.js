/* 手写识别的服务端：管密钥 + 代理请求（不含 HTTP 路由，路由在 server.js）。
 *
 * ── 为什么识别这件事必须走服务端 ──
 * ① **密钥不能进浏览器。** 页面里能读到的密钥，等于任何一段被注入的脚本都能读到。
 *    密钥只躺在你自己电脑上的 config/ocr.json 里，浏览器从来没见过它。
 * ② 识别服务不发 CORS 头，浏览器直接 fetch 会被拦（跨域）。
 * ③ 顺手能做限流、缓存、把"哪种失败"翻译成人话。
 *
 * ── 为什么把这一层单独写成文件 ──
 * 这样它能被 scripts/check-ocr-server.js 用一个**假的识别服务**
 * （本地 HTTPS + 自签证书）整条跑通：包含"服务器到服务器怎么发请求"这件事。
 * 如果这段逻辑长在 server.js 的路由里，就只能靠真密钥 + 真网络才能测，
 * 那等于没测。路由只留三行转发。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { httpRequest } from './src/lib/http.js'
import { buildMultipart } from './src/lib/multipart.js'

export const CONFIG_PATH = ['config', 'ocr.json']

/* 两家识别服务。字段名和请求形状都不一样，所以"翻译"集中在下面几个函数里，
   换服务/加服务只动这里（server.js 只负责把图递进来）。

   ① deepseek（默认）：DeepSeek 的原生多模态模型，走 OpenAI 兼容的 /chat/completions。
      好处是**用你已经在用的那个账号和 key**，不用再申请一家。
      ⚠ 模型名要跟着官方走：文档里写得很清楚，旧的 `deepseek-v4-flash-vision-exp`
        已经下线（虽然还能调，但请求由最新的 Flash 承接），现在的名字是 `deepseek-flash`。
        所以模型名做成配置项 —— 它变的时候改配置，不用改代码。
   ② simpletex：专门做公式识别的服务，手写公式更对路、有每日免费额度。
      接口形状完全不一样（multipart 直接传图 → 返回 latex）。

   两家都要在"发出去"和"认回来"两头做翻译，也都**必须**能单独测 ——
   见 scripts/check-ocr-server.js（它用一个假的识别服务把两条路各跑一遍）。 */
export const DEFAULT_CONFIG = {
  enabled: true,
  provider: 'deepseek',
  // deepseek
  dsBase: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-flash',
  // simpletex
  base: 'https://server.simpletex.net/api/latex_ocr',
  turbo: true,
  tokenHeader: 'token',
  // 两家共用一个密钥字段：同一时间只用一个 provider，没必要分两个
  token: '',
}

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek（deepseek-flash，用你已有的 key）',
    needs: 'DeepSeek 的 API Key（sk- 开头）',
    note: '图片会发到 api.deepseek.com。用你平时那个账号的 key 就行，不用另外申请。公式和普通文字都认。',
    modes: ['formula', 'text'],
  },
  simpletex: {
    label: 'SimpleTex（专门认公式，手写更对路）',
    needs: 'SimpleTex 的鉴权串（UAT / APP）',
    note: '图片会发到 server.simpletex.net。有每日免费额度，轻量模型每天 2000 次。**只认公式**，不认普通文字。',
    modes: ['formula'],
    // 认普通文字（白板「美化手写」）时，这家用不了 —— 它的接口就只吐 LaTeX
    formulaOnly: true,
  },
}

/* 让模型只输出公式。
   为什么写得这么啰嗦：LLM 天生爱说废话（"图片里是一个公式：…"），
   还爱把结果包在 ```latex 里。这段提示词就是为了把这些堵掉 ——
   拿到一段带解释的文字，比拿到空的还难处理。
   识别**只用一次请求，不做多轮**：错了你自己在输入框里改，比让模型"再想想"更可控。 */
export const FORMULA_PROMPT = [
  '你是公式识别工具。图片里是一个手写的数学或物理公式。',
  '只输出这个公式的 LaTeX 代码，不要任何解释、不要客套、不要 Markdown 代码块。',
  '不要加 $ 或 $$ 定界符。',
  '如果图片里根本没有公式，只输出一个词：EMPTY。',
].join('\n')

/* 认**普通文字**（白板上随手写的笔记、标题、单词）用的提示词。
 *
 * 和认公式是两条不同的路，所以是两段提示词而不是一段加参数：
 *   · 公式要的是"翻译成 LaTeX"；文字要的是"照抄"。
 *   · 文字**保留换行** —— 你写了两行，卡片上就该是两行（一坨连在一起没法看）。
 *   · 明确说"不要把数学符号转成 LaTeX"：转了之后文字卡里会出现一堆
 *     反斜杠花括号，而文字卡是纯文本、不渲染 LaTeX —— 看起来就像乱码。
 *     要公式请用「✍ 手写公式」那条路，那里才排得好看。
 *   · 顺手让它别把中英文之间的空格、标点乱改：抄写任务的正确姿势是"少动手"。 */
export const TEXT_PROMPT = [
  '你是手写文字识别工具。图片里是别人手写的一段内容，可能是中文、英文、数字或者混着写。',
  '把里面的文字**原样抄下来**，保留原来的换行。',
  '不要翻译、不要改写、不要补充标点、不要加任何解释或客套、不要 Markdown 代码块。',
  '数学符号按普通字符写出来（比如 x^2 就写 x^2），**不要**转成 LaTeX 命令。',
  '如果图片里根本没有可辨认的文字，只输出一个词：EMPTY。',
].join('\n')


export function configFile(root) {
  return path.join(root, ...CONFIG_PATH)
}

export async function loadConfig(root) {
  const file = configFile(root)
  let cfg
  let fromFile = false
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
    cfg = normalizeConfig(raw)
    fromFile = true
  } catch {
    // 没配过就是没配过，不是错误 —— 第一次用的人不该看到一句报错
    cfg = { ...DEFAULT_CONFIG }
  }
  /* 环境变量顶上来，但**只在还没有配置文件的时候**。
     两个用处：
     ① 自检：check-ocr-browser.js 起一个假识别服务，把地址指过去，
        于是整条链路能在完全离线、不花额度的前提下跑通。
     ② 实用：想挂自己搭的识别服务，不用改仓库里的文件，设个环境变量就行。
     为什么"只在没有配置文件时"：否则你在界面上改了配置、存进文件，重启后
     被环境变量默默覆盖回去 —— 那种"改了不生效"最难查。 */
  if (!fromFile) {
    if (process.env.STUDYHELPER_OCR_PROVIDER) cfg.provider = String(process.env.STUDYHELPER_OCR_PROVIDER)
    if (process.env.STUDYHELPER_OCR_DS_BASE) cfg.dsBase = String(process.env.STUDYHELPER_OCR_DS_BASE)
    if (process.env.STUDYHELPER_OCR_MODEL) cfg.model = String(process.env.STUDYHELPER_OCR_MODEL)
    if (process.env.STUDYHELPER_OCR_BASE) cfg.base = String(process.env.STUDYHELPER_OCR_BASE)
    if (process.env.STUDYHELPER_OCR_TOKEN) cfg.token = String(process.env.STUDYHELPER_OCR_TOKEN)
    if (process.env.STUDYHELPER_OCR_TURBO === '0') cfg.turbo = false
    if (process.env.STUDYHELPER_OCR_TURBO === '1') cfg.turbo = true
  }
  return normalizeConfig(cfg)
}

export async function saveConfig(root, patch) {
  const cur = await loadConfig(root)
  const next = normalizeConfig({ ...cur, ...(patch || {}) })
  const file = configFile(root)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, file) // 原子写，和 data/ 一个规矩
  return next
}

export function normalizeConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
  const httpish = (v, fallback) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : fallback)
  return {
    enabled: c.enabled !== false,
    provider: PROVIDERS[c.provider] ? c.provider : DEFAULT_CONFIG.provider,
    dsBase: httpish(c.dsBase, DEFAULT_CONFIG.dsBase),
    model: typeof c.model === 'string' && c.model.trim() ? c.model.trim() : DEFAULT_CONFIG.model,
    base: httpish(c.base, DEFAULT_CONFIG.base),
    turbo: c.turbo !== false,
    tokenHeader: typeof c.tokenHeader === 'string' && c.tokenHeader.trim() ? c.tokenHeader.trim() : DEFAULT_CONFIG.tokenHeader,
    token: typeof c.token === 'string' ? c.token.trim() : '',
  }
}

export function hasKey(cfg) {
  return !!(cfg && cfg.token && cfg.token.length >= 8)
}

/* 密钥怎么放进 Header。
   ★ 这里刻意**不猜**：你填什么就发什么。识别服务的鉴权串（UAT/APP）本身就是
     "前缀 + 密钥"接在一起的完整串，替用户拼前缀只会拼错。
     如果服务改了这个头的名字，改 config 里的 tokenHeader 即可，不用改代码。 */
export function authHeaders(cfg) {
  const h = {}
  if (hasKey(cfg)) h[cfg.tokenHeader || 'token'] = cfg.token
  return h
}

/* turbo 接口的地址 = 标准地址 + "_turbo"。
   查文档确认过：/api/latex_ocr 和 /api/latex_ocr_turbo 是两个模型，
   轻量模型快、标准模型准一点，免费额度也是分开算的。 */
export function endpointOf(cfg) {
  const base = String(cfg.base || DEFAULT_CONFIG.base).replace(/\/+$/, '')
  return cfg.turbo ? base + '_turbo' : base
}

/* ── 把服务端的返回翻译成我们的形状 ──
   为什么不直接把原文透给前端：不同服务的字段名不一样，前端不该知道"这家叫 res.latex、
   那家叫 data.text"。翻译只在这一个地方做，换服务只改这个函数。 */
export function parseProviderResponse(body) {
  if (!body || typeof body !== 'object') return { ok: false, kind: 'bad', error: '识别服务返回了空内容' }
  // 有的服务失败也回 200，把错误写在 body 里
  if (body.status === false || body.error) {
    const msg = body.message || body.error || body.msg || '识别服务说这次调用失败了'
    return { ok: false, kind: 'bad', error: String(msg) }
  }
  const res = body.res && typeof body.res === 'object' ? body.res : body
  const latex = cleanLatex(res.latex ?? res.text ?? res.result ?? '')
  if (!latex) return { ok: false, kind: 'empty', error: '没认出公式（可能是笔画太少，或者写得太小）' }
  const conf = Number(res.conf ?? res.confidence)
  return { ok: true, latex, conf: Number.isFinite(conf) ? conf : null }
}

/* 剥掉定界符。双写一遍（和 src/lib/ocr.js 里那份一样）是有意的：
   服务端要能在"前端没剥干净"的时候兜住，前端要能在"显示前"兜住。
   两份都很短，且 check-ocr-server.js 会断言两边行为一致。 */
export function cleanLatex(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if (s.startsWith('$$') && s.endsWith('$$') && s.length > 4) s = s.slice(2, -2).trim()
  else if (s.startsWith('$') && s.endsWith('$') && s.length > 2) s = s.slice(1, -1).trim()
  s = s.replace(/^\\\[/, '').replace(/\\\]$/, '').replace(/^\\\(/, '').replace(/\\\)$/, '').trim()
  return s
}

/* ── 真正发请求：按 provider 分派 ── */
/* 走 src/lib/http.js 而不是内置 fetch：
   fetch（undici）连本机 HTTPS 会挂住（实测），而这条链路以后很可能指向自建/本机代理。
   超时必须有：识别服务会排队，没超时的话前端一直转圈，用户以为是自己写错了。

   mode —— 'formula'（默认，认公式）| 'text'（认普通文字，白板的「美化手写」用）。
   ★ SimpleTex 走不通 text 模式：它的接口契约就是"一张图 → 一个 LaTeX"，
     没有"给我文字"这回事。**在这里挡掉、并且说清楚该换哪一家**，
     比让它认出一堆 `\text{...}` 再回来强 —— 那种失败用户根本看不懂。
     这个判断放在服务端而不是前端，是因为"哪家能干什么"是这一层的知识。 */
export async function callProvider(cfg, imageBytes, { mode = 'formula', timeoutMs = 30000 } = {}) {
  if (mode === 'text') {
    if (cfg.provider === 'simpletex') {
      return {
        ok: false,
        kind: 'provider',
        error: 'SimpleTex 只认公式，认普通文字要用 DeepSeek —— 去「手写识别设置」里把「用哪家识别」换成 DeepSeek，再点一次。',
      }
    }
    return callDeepSeek(cfg, imageBytes, { mode, timeoutMs })
  }
  return cfg.provider === 'simpletex'
    ? callSimpleTex(cfg, imageBytes, { timeoutMs })
    : callDeepSeek(cfg, imageBytes, { mode, timeoutMs })
}

/* 把 http 层的报错/状态码翻译成"用户该干什么"。
   两家服务共用这一套分类，因为下一步是同一批：改密钥 / 等额度 / 查网络。 */
function classifyHttp(status, text) {
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    /* 不是 JSON —— 只能按状态码说 */
  }
  const msg = body && body.error && (body.error.message || body.error.msg || body.error)
  if (status === 401 || status === 403) {
    return { ok: false, kind: 'key', error: '密钥不对或者没权限（去设置里重新填一次）', httpStatus: status, raw: text.slice(0, 300) }
  }
  if (status === 429) {
    return { ok: false, kind: 'quota', error: '额度用完了（或者请求太快被限流）', httpStatus: status, raw: text.slice(0, 300) }
  }
  return {
    ok: false,
    kind: 'bad',
    error: (msg ? String(msg) : `识别服务回了 HTTP ${status}`) + (status === 402 ? '（余额不足）' : ''),
    httpStatus: status,
    raw: text.slice(0, 300),
  }
}

/* ── DeepSeek：OpenAI 兼容的 /chat/completions ──
   契约（查过官方文档，别凭记忆改）：
     POST https://api.deepseek.com/chat/completions
     Header: Authorization: Bearer <key>
     Body:   { model, messages: [ { role:'user', content: [ {type:'text'}, {type:'image_url', image_url:{url:'data:image/png;base64,…'}} ] } ] }
     返回:   { choices: [ { message: { content: "…" } } ] }
   图片用 base64 data URL 内联（官方支持的三种方式里最简单的一种，不用先传 Files）。 */
export async function callDeepSeek(cfg, imageBytes, { mode = 'formula', timeoutMs = 30000 } = {}) {
  if (!hasKey(cfg)) return { ok: false, kind: 'no-key', error: '还没填密钥' }
  const wantText = mode === 'text'

  const body = JSON.stringify({
    model: cfg.model || DEFAULT_CONFIG.model,
    // temperature 0：识别是"抄"不是"创作"，让它尽量别发挥
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: wantText ? TEXT_PROMPT : FORMULA_PROMPT },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.from(imageBytes).toString('base64') } },
        ],
      },
    ],
  })

  let res
  try {
    res = await httpRequest(cfg.dsBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: Buffer.from(body, 'utf8'),
      timeoutMs,
    })
  } catch (e) {
    return netError(e, timeoutMs)
  }
  if (res.status < 200 || res.status >= 300) return classifyHttp(res.status, res.text)

  let parsed = null
  try {
    parsed = JSON.parse(res.text)
  } catch {
    return { ok: false, kind: 'bad', error: '识别服务回的不是 JSON', raw: res.text.slice(0, 300) }
  }
  const content =
    (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || ''

  if (wantText) {
    const text = cleanTextOutput(content)
    if (!text) {
      return { ok: false, kind: 'empty', error: '模型没认出文字（它回的是一句解释，不是一个词）', raw: String(content).slice(0, 200) }
    }
    return { ok: true, text, conf: null, note: '识别来自 ' + (cfg.model || DEFAULT_CONFIG.model) }
  }

  const latex = cleanModelOutput(content)
  if (!latex) return { ok: false, kind: 'empty', error: '模型没认出公式（它回的是一句解释，不是式子）', raw: String(content).slice(0, 200) }
  return { ok: true, latex, conf: null, note: '识别来自 ' + (cfg.model || DEFAULT_CONFIG.model) }
}

/* 模型回话里把公式抠出来。
   ★ 这一段决定了"能不能用"：LLM 会做这些事，全都得处理 ——
     · 包在 ```latex … ``` 里（哪怕你明确说了不要）
     · 前面加一句"图片里的公式是："
     · 带 $ $ 或 \[ \]
     · 干脆回一句"这张图里没有公式"
   处理原则：**能抠出来就抠，抠不出来就老实说没认出**，
   绝不把一整句中文当 LaTeX 塞给卡片（那会渲染成一堆红字，比空着更糟）。 */
export function cleanModelOutput(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if (!s) return ''

  // ① ```latex … ``` / ``` … ```（你说了不要，它还是会包）
  const fence = /```(?:latex|tex|math)?\s*([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1].trim()

  /* ② 多行就取**含有 LaTeX 特征的那一行**。
     LLM 常见的回法是先一句"图片里是"，再单独一行给公式。 */
  const lines = s.split('\n').map((x) => x.trim()).filter(Boolean)
  if (lines.length > 1) {
    const best = lines.filter(looksLikeLatex).pop()
    if (best) s = best
  }

  /* ③ 一句话里混着"前言 + 公式"：取最后一个冒号后面那段。
     `图片里的公式是：\oint…` → `\oint…`
     `公式：B=\frac…`        → `B=\frac…`
     这一步和上面那条的区别是：**同一行内的前言**，多行那条管不到。
     冒号全是中文全角的话（比如"以下是公式："）也一并处理。 */
  const colon = /[:：]/.exec(s)
  if (colon) {
    const tail = s.slice(colon.index + 1).trim()
    const head = s.slice(0, colon.index)
    // 只在"冒号前像人话、冒号后有东西"的时候才切
    if (tail && !looksLikeLatex(head) && /[\u4e00-\u9fff a-zA-Z]/.test(head)) s = tail
  }

  s = cleanLatex(s)

  // ④ 模型说"没有公式"的各种说法
  if (/^(EMPTY|N\/A|无|没有公式|图片中没有公式|这张图.*没有公式)\.?$/i.test(s)) return ''
  // ⑤ 还是一整句人话：有中文、而且没有任何 LaTeX 特征 → 当没认出。
  //    绝不把中文句子塞进卡片（会渲染成一堆红字，比空着更糟）。
  if (/[\u4e00-\u9fff]/.test(s) && !looksLikeLatex(s)) return ''
  return s
}

/* "这段像不像 LaTeX"。判据故意宽松：宁可多认一个，也别把真公式误判成人话。 */
function looksLikeLatex(t) {
  return /\\[a-zA-Z]|[_^={}]|\d\s*[a-zA-Z]/.test(String(t || ''))
}

/* 模型回话里把**文字**抠出来。
 *
 * ★ 为什么不复用上面那个 cleanModelOutput —— 这是这个功能最容易踩的一脚：
 *   cleanModelOutput 里有一条"一句话里混着前言 + 公式，就取最后一个冒号后面那段"。
 *   对公式是对的（`图片里的公式是：\oint…`），对**文字是灾难**：
 *   笔记里本来就到处是冒号（`安培环路定理：只对稳恒电流成立`），
 *   那一步会把用户写的一整行悄悄砍掉前半句，而**界面上看不出来**
 *   （卡片里就是少了一段字，你会以为是自己没写全）。
 *   所以文字这条路只做三件事，一律"宁可留着，不可删掉"：
 *     ① 剥 ``` 围栏（说了不要它还是会包）
 *     ② 剥掉整段外面被包上的引号（模型爱说"内容是："再配一对引号）
 *     ③ 认 EMPTY 哨兵
 *   多行的取舍也不同：公式取"最像 LaTeX 的那一行"，文字**每一行都留着**。 */
export function cleanTextOutput(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if (!s) return ''

  const fence = /```(?:text|markdown|md|plain|latex|tex)?\s*([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1].trim()

  // 整段被一对引号包着（半角 / 中文 / 书名号），且里面没有第二对同样的引号
  const pairs = [['"', '"'], ['“', '”'], ["'", "'"], ['「', '」'], ['『', '』']]
  for (const [a, b] of pairs) {
    if (s.length > 1 && s.startsWith(a) && s.endsWith(b) && !s.slice(1, -1).includes(b)) {
      s = s.slice(1, -1).trim()
      break
    }
  }

  /* 句末的句号有半角也**有全角**（"这张图里没有文字。"）。
     这里的 `[.。]?` 不是随手加的：公式那条路漏了全角句号也没暴露 ——
     因为公式的兜底是"有中文且不像 LaTeX 就当没认出"，中文句子照样被丢掉。
     文字这条路的中文是**正文**，兜底那条不存在，所以标点必须自己认全。 */
  if (/^(EMPTY|N\/A|无|没有文字|图片中没有文字|这张图.*没有(文字|内容))[.。]?$/i.test(s)) return ''
  return s
}

/* ── SimpleTex：multipart 直接传图 ──
   契约：POST {base}{|_turbo}，Header 带鉴权，Body 一个 file 字段，
        返回 { status, res: { latex, conf }, request_id }。 */
export async function callSimpleTex(cfg, imageBytes, { timeoutMs = 25000 } = {}) {
  const url = endpointOf(cfg)
  const { body, contentType } = buildMultipart([
    { name: 'file', filename: 'ink.png', type: 'image/png', data: imageBytes },
  ])

  let res
  try {
    res = await httpRequest(url, {
      method: 'POST',
      headers: { ...authHeaders(cfg), 'Content-Type': contentType },
      body,
      timeoutMs,
    })
  } catch (e) {
    return netError(e, timeoutMs)
  }

  if (res.status < 200 || res.status >= 300) return classifyHttp(res.status, res.text)

  let parsedBody = null
  try {
    parsedBody = JSON.parse(res.text)
  } catch {
    /* 不是 JSON —— 按"看不懂"处理 */
  }
  const parsed = parseProviderResponse(parsedBody)
  if (!parsed.ok) return { ...parsed, httpStatus: res.status, raw: res.text.slice(0, 300) }
  return {
    ...parsed,
    httpStatus: res.status,
    requestId: parsedBody && parsedBody.request_id ? parsedBody.request_id : null,
  }
}

function netError(e, timeoutMs) {
  const timedOut = e && /timeout/i.test(e.message || '')
  return {
    ok: false,
    kind: 'network',
    error: timedOut
      ? `识别服务 ${Math.round(timeoutMs / 1000)} 秒没回话（网络慢，或者它那边在排队）`
      : '连不上识别服务：' + ((e && e.message) || e),
  }
}

/* ── 体检：用一张极小的留白图探一下密钥通不通 ──
   为什么不复用用户刚写的那笔：那样"密钥错"和"没写清楚"会混在一起，
   用户不知道该改密钥还是重写。这里发一张留白的图，
   只要鉴权过了就算通（认不出内容是正常的、也是预期的）。 */
export async function testProvider(cfg, { timeoutMs = 20000 } = {}) {
  if (!hasKey(cfg)) return { ok: false, kind: 'no-key', error: '还没填密钥' }
  const png = tinyWhitePng(96, 48)
  const r = await callProvider(cfg, png, { timeoutMs })
  // "没认出东西"恰恰说明鉴权通过了、服务也活着
  if (r.ok) return { ok: true, note: '服务正常，而且从测试图里认出了内容：' + String(r.latex).slice(0, 40) }
  if (r.kind === 'empty') {
    return { ok: true, note: '服务正常（测试图是留白，认不出内容是正常的）' }
  }
  return r
}

/* ── 现场造一张小 PNG（留白）──────────────────────────────────────
   为了一张 96×48 的白图存一个二进制文件进仓库不值得：手写二进制没法在
   diff 里看懂，而"造一张白图"这件事本身就是十几行 zlib 调用。
   PNG 的三块：IHDR（尺寸/位深）、IDAT（压缩过的像素）、IEND。 */
export function tinyWhitePng(w = 96, h = 48) {
  const raw = Buffer.alloc((w * 4 + 1) * h) // 每行前面一个 filter 字节
  for (let y = 0; y < h; y++) {
    const off = y * (w * 4 + 1)
    raw[off] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 4
      raw[p] = 0xff // R
      raw[p + 1] = 0xff // G
      raw[p + 2] = 0xff // B
      raw[p + 3] = 0xff // A
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibDeflate(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([len, body, crc])
}

function zlibDeflate(buf) {
  return zlib.deflateSync(buf) // zlib 自带的头（0x78 0x9c）正好是 PNG IDAT 要的
}

/* CRC32（PNG 每块都要）。查表法，表只建一次。 */
let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* 给前端的状态：**不含密钥本身**。
   只回一个"填没填、大概长什么样"，够前端显示"已配置"就够了。
   少一个把密钥漏出去的地方。 */
export function publicStatus(cfg) {
  return {
    enabled: cfg.enabled !== false,
    provider: cfg.provider,
    providers: PROVIDERS,
    configured: hasKey(cfg),
    endpoint: cfg.provider === 'simpletex' ? endpointOf(cfg) : cfg.dsBase,
    model: cfg.provider === 'simpletex' ? (cfg.turbo ? 'turbo（轻量）' : 'standard（标准）') : cfg.model,
    turbo: cfg.turbo !== false,
    dsBase: cfg.dsBase,
    base: cfg.base,
    tokenHeader: cfg.tokenHeader || 'token',
    tokenTail: hasKey(cfg) ? '…' + cfg.token.slice(-4) : '',
    configHint: path.join(...CONFIG_PATH),
  }
}
