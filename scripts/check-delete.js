/* /api/delete 的端到端自检：真服务 + 真回收站。
 *
 * 为什么必须有这一条（而不是只靠 check-board.js 里的纯逻辑那几项）：
 *   纯逻辑只能证"路径归一化对了"；而这条路上真正会翻车的是**盘上那一步** ——
 *   非空目录要不要先问、force 能不能真删掉、删掉的到底去了回收站还是被永久删了。
 *   这些都只有真起一个服务、真删、再回头查盘才能看见。
 *
 * ★ 跑在**临时目录**里（照 check-storage 的老规矩）：复制清单从 server.js 的
 *   import 推出来（`serverModules`），`data/` 从零开始。所以它**根本碰不到**
 *   你项目里的 data/ —— 不是"跑完记得删"，是"从头到尾没连上"。
 *
 * ★★ 回收站那条判据用**条数**，不用名字：
 *   PowerShell 吐回来的中文会被重编码成 GBK（这台机器实测 `甲组` 变 `鐢茬粍`），
 *   拿中文去 match 永远不中 —— 而"回收站条目 +1"是个数字，编码不了。
 *   另外回收站**不是同步的**：InvokeVerb 回来之后要等一两秒它才落定，
 *   不等就查会得到"删了但没进回收站"的假红（这个假红我踩过一次）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT as ROOT_DIR, serverModules, linkRuntimeDeps } from './lib/board-check.js'

const ROOT = ROOT_DIR
const TMP = path.join(os.tmpdir(), 'studyhelper-del-' + process.pid)
/* 端口每个脚本一套（这里 5189 / 别的脚本占了别的号）；串了会验到别的应用上。 */
const PORT = Number(process.env.STUDYHELPER_DEL_PORT || 5189)
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const ok = (c, msg, got) => {
  if (c) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.log(`  ✗ ${msg}` + (got === undefined ? '' : `  → ${JSON.stringify(got)}`))
  }
}
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let j = null
  try {
    j = await r.json()
  } catch {
    j = null
  }
  return { status: r.status, json: j }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 回收站里有几条 —— 数字，编码无关。（读不出来回 -1，那条断言会自己红。） */
const rbCount = () =>
  new Promise((resolve) => {
    const q =
      '$ErrorActionPreference="SilentlyContinue";' +
      '$sh=New-Object -ComObject Shell.Application;' +
      '@($sh.Namespace(10).Items()).Count'
    const ch = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], { windowsHide: true })
    let o = ''
    ch.stdout.on('data', (d) => {
      o += d
    })
    ch.on('close', () => resolve(Number(o.trim()) || -1))
    ch.on('error', () => resolve(-1))
    setTimeout(() => resolve(-1), 25000)
  })

async function portBusy() {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 700)
    await fetch(BASE + '/api/list', { signal: ctl.signal })
    clearTimeout(t)
    return true
  } catch {
    return false
  }
}

console.log('\n[delete] /api/delete：真服务 + 真删 + 真回收站（临时目录 ' + TMP + '）')
console.log('  你项目里的 data/ 从头到尾没被连上（这一条跑的是复制出去的那一份）\n')

fs.rmSync(TMP, { recursive: true, force: true })
for (const f of serverModules()) {
  fs.mkdirSync(path.dirname(path.join(TMP, f)), { recursive: true })
  fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f))
}
fs.cpSync(path.join(ROOT, 'src'), path.join(TMP, 'src'), { recursive: true })
linkRuntimeDeps(TMP)

/* 临时 data/：空层、非空层（套两层）、根上一个文件、一个要留着当"证人"的文件 */
const D = path.join(TMP, 'data')
fs.mkdirSync(path.join(D, '甲组', '子层'), { recursive: true })
fs.mkdirSync(path.join(D, '空层'), { recursive: true })
fs.mkdirSync(path.join(D, '丙组', '深', '更深'), { recursive: true })
fs.writeFileSync(path.join(D, '甲组', '子层', 'board-一.md'), '# 一\n')
fs.writeFileSync(path.join(D, '丙组', '深', '更深', 'board-深.md'), '# 深\n')
fs.writeFileSync(path.join(D, '据守.md'), '# 根上一个，谁也不许动我\n')

let srv = null
let log = ''

if (await portBusy()) {
  ok(false, `端口 ${PORT} 上已经有服务了 —— 先关掉它（不然验的是别的应用）`)
} else {
  srv = spawn(process.execPath, ['server.js', '--no-open', '--no-auto-exit'], {
    cwd: TMP,
    env: { ...process.env, STUDYHELPER_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stdout.on('data', (d) => {
    log += d
  })
  srv.stderr.on('data', (d) => {
    log += d
  })

  try {
    let up = false
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(BASE + '/api/list')
        if (r.ok) {
          up = true
          break
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(250)
    }
    if (!up) throw new Error('服务没起来：\n' + log.slice(0, 800))

    console.log('── ① 空层：一次就删掉 ──')
    {
      const r = await post('/api/delete', { path: '空层' })
      ok(r.status === 200 && r.json?.ok === true, '删空层 → 200 {ok:true}', r)
      ok(!fs.existsSync(path.join(D, '空层')), '盘上那个空层真没了')
    }

    console.log('\n── ② 非空层：先 409 带清单，force 才真删 ──')
    {
      let r = await post('/api/delete', { path: '甲组' })
      ok(r.status === 409, '不带 force → 409', r)
      ok(r.json?.code === 'not-empty', 'code 是 not-empty（前端据这个弹问话，不靠字面匹配）', r.json?.code)
      ok(typeof r.json?.count === 'number' && r.json.count > 0, '带回来里面有几样东西 —— 数字，不是句子', r.json?.count)
      ok(Array.isArray(r.json?.samples) && r.json.samples.length > 0, '还带了样品的名字（给用户看"里面有什么"）', r.json?.samples)
      ok(fs.existsSync(path.join(D, '甲组', '子层', 'board-一.md')), '★ 被拒之后，里面的文件一个字节都没动')
      r = await post('/api/delete', { path: '甲组', force: true })
      ok(r.status === 200 && r.json?.ok === true, '带 force → 200 真删了', r)
      ok(!fs.existsSync(path.join(D, '甲组')), '★ 那一层连着里面的文件一起没了')
      ok(r.json?.dir === true, '回话里说明了这是目录')
    }

    console.log('\n── ③ 删一个文件：别的文件不许受牵连 ──')
    {
      const r = await post('/api/delete', { path: '据守.md' })
      ok(r.status === 200 && r.json?.ok === true, '删根上那个文件 → 200', r)
      ok(!fs.existsSync(path.join(D, '据守.md')), '它自己没了')
      ok(fs.existsSync(path.join(D, '丙组', '深', '更深', 'board-深.md')), '★ 同层的其他文件还好好在盘上')
    }

    console.log('\n── ④ 递归数数：深一层也数得清 ──')
    {
      const r = await post('/api/delete', { path: '丙组' })
      ok(r.status === 409, '丙组（空筐里套着 深/更深/一个文件）→ 409', r)
      ok(r.json?.count === 3, '数出来是 3 样（深、更深、那个 .md）—— 递归数，不是只看第一层', r.json?.count)
    }

    console.log('\n── ⑤ 三道闸 ──')
    {
      let r = await post('/api/delete', { path: '' })
      ok(r.status === 400, '空路径 → 400', r)
      r = await post('/api/delete', { path: '/' })
      ok(r.status === 400, '★ 根 `/` → 400（归一化之前就拒，不然它和空串长得一样）', r)
      r = await post('/api/delete', { path: '../../package.json' })
      ok(r.status === 400, '往上一路跑出去 → 400', r)
      ok(fs.existsSync(path.join(ROOT, 'package.json')), '★ 项目根上的 package.json 一个字节没动')
      r = await post('/api/delete', { path: '.资料' })
      ok(r.status === 403, '★ 点开头的 → 403（回收站不是左栏，别拿它删 .资料/.git）', r)
      r = await post('/api/delete', { path: '从来没有过的东西' })
      ok(r.status === 404, '本来就没有的 → 404', r)
    }

    console.log('\n── ⑥ 回收站：东西是真进去了（判据用条数，名字会被重编码） ──')
    {
      fs.mkdirSync(path.join(D, '丁组', '内'), { recursive: true })
      fs.writeFileSync(path.join(D, '丁组', '内', 'board-丁.md'), '# 丁\n')
      const n0 = await rbCount()
      const r = await post('/api/delete', { path: '丁组', force: true })
      ok(r.status === 200, '删掉一个新造的非空层 → 200', r)
      ok(n0 > 0, '回收站是读得到的（不然下面那条 +1 是假的）', n0)
      await sleep(2500) // 回收站不是同步落定的
      const n1 = await rbCount()
      ok(
        n0 > 0 && n1 === n0 + 1,
        `★ 回收站条数 +1（${n0} → ${n1}）—— 进回收站了，不是永久删`,
        [n0, n1],
      )
    }
  } catch (e) {
    fail++
    console.log('\n[炸了] ' + (e?.stack || e))
    console.log(log.slice(0, 1500))
  }
}

if (srv) {
  try {
    srv.kill('SIGKILL')
  } catch {
    /* 已经退了 */
  }
  await sleep(300)
}
try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {
  /* 有 Edge 之类占着就算了，临时目录不心疼 */
}

console.log(`\n──────────────────────────────────────────────────`)
if (fail === 0) console.log(`全部通过（${pass} 项）`)
else console.log(`有红：${fail} 项没过（共 ${pass + fail} 项）—— 别放过`)
process.exit(fail === 0 ? 0 : 1)
