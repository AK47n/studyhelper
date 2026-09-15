// 一键备份：把新写的总结提交并推到 GitHub。
// 用法：双击根目录的「备份到GitHub.bat」，或者 npm run sync。
// 做三件事：提交 → 拉取（rebase，避免分叉）→ 推送。
//
// ── 三个写这个脚本时踩到的坑，改之前先看 ──
// 1. root 必须往上一级。这个文件在 scripts/ 里，path.dirname(import.meta.url)
//    得到的是 scripts/ 而不是项目根 —— 于是它在找 scripts\.git，永远找不到，
//    报出来却是"这个目录还不是 git 仓库"，把人往错的方向带。
// 2. 只信退出码，不要捕获 git 的输出。输出全部继承给终端（stdio: 'inherit'）：
//    报错时你直接看到 git 自己说的话，比转述的准；也绕开了"管道拿输出"这类
//    在受限环境里会失败的操作，不会再出现"拿不到输出"被误判成"命令失败"。
// 3. 但**提交信息**里想写清"这次改了哪几个文件"，就必须拿到 status 的文本 ——
//    见下面 gitToFile：stdio 的第二项直接给一个**打开的文件描述符**，git 写盘、我们读盘，
//    全程没有管道、没有 shell 重定向，所以第 2 条的前提没被破坏。
//    拿不到文本就退回老样子（提交信息只写 `笔记更新 <时间>`）——
//    信息少一点可以接受，备份不能因为"想问清楚改了啥"而失败。
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)) // …/studyhelper/scripts
const root = path.resolve(here, '..') // …/studyhelper

const say = (s = '') => console.log(s)
const die = (msg, hint) => {
  say('')
  say('  ✗ ' + msg)
  if (hint) say('    ' + hint)
  say('')
  process.exit(1)
}

/** 跑一条 git；只返回退出码，输出直接打到终端 */
function git(args) {
  const r = spawnSync('git', args, { cwd: root, stdio: 'inherit' })
  if (r.error) die('调不起 git（没装？不在 PATH？）', String(r.error.message))
  return r.status ?? 1
}

/** 跑一条 git，把它的 stdout **写进临时文件**再读回来（不走管道）。
 *  失败一律返回 null：调用方要能"没有这份文本也照样把备份做完"。 */
function gitToFile(args) {
  const tmp = path.join(os.tmpdir(), `studyhelper-sync-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  let fd
  try {
    fd = openSync(tmp, 'w')
    const r = spawnSync('git', args, { cwd: root, stdio: ['ignore', fd, 'inherit'] })
    closeSync(fd)
    fd = undefined
    if (r.error || (r.status ?? 1) !== 0) return null
    return readFileSync(tmp, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
    try {
      unlinkSync(tmp)
    } catch {}
  }
}

/** 提交信息：主题 = 时间 + 文件数，正文 = 完整改动清单。
 *
 *  为什么值得这么啰嗦（2026-09-15 改的）：原来一律叫「笔记更新 <时间>」，
 *  于是"改了 35 个文件、里面有白板图层修复"这种提交，在 git log 里和
 *  "改了一篇笔记"长得一模一样 —— 事后翻历史根本分不清哪次是代码。
 *  前缀「笔记更新」保留（这是这个脚本一直以来的名字，用熟了别改），
 *  只在后面挂上文件数；正文里如果动了 data/ 之外的东西，第一句就说明。 */
function buildCommitMessage(statusText) {
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
  const lines = String(statusText || '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '')
  if (!lines.length) return { subject: `笔记更新 ${stamp}`, body: '' }

  const paths = lines.map((l) => l.slice(3).replace(/^"|"$/g, ''))
  const notesOnly = paths.every((p) => p.startsWith('data/'))

  const MAX = 200
  const body = [
    notesOnly
      ? '这次动的都是 data/ 里的笔记。'
      : '⚠ 这次不全是在 data/ 里写笔记 —— 上面这些里面有代码 / 脚本 / 文档。\n  （「笔记更新」是这个脚本一直以来的名字，不代表这次只改了笔记。）',
    '',
    '改动清单（git status --short）：',
    ...lines.slice(0, MAX).map((l) => '  ' + l),
    ...(lines.length > MAX ? [`  …（还有 ${lines.length - MAX} 个，完整清单见 git show --stat HEAD）`] : []),
  ].join('\n')

  return { subject: `笔记更新 ${stamp}（${lines.length} 个文件）`, body }
}

say('')
say('  studyhelper 备份到 GitHub')
say('  ─────────────────────────────────────')

if (!existsSync(path.join(root, '.git'))) {
  die('这个目录还不是 git 仓库', '先跑一次：git init -b main')
}

const hasRemote = git(['remote', 'get-url', 'origin']) === 0
if (!hasRemote) {
  die('没有配置远端 origin', '先跑：gh repo create studyhelper --public --source=. --remote=origin --push')
}

/* 有没有要提交的。
   ★ 判据用 `git status --porcelain`，不是原来的 `git diff-index --quiet HEAD`：
     后者只看**已跟踪文件**的改动，**看不见新文件** —— 从别处拷进来一篇新笔记、
     或者应用新开了一张板（`data/board-*.md` 是新文件），这种时候旧判据会说
     "没有新改动"、然后什么都不提交，是**静默漏备份**。
     拿不到文本（见 gitToFile 的说明）就退回旧判据：宁可漏发现，也不误判成"有改动"
     而对着一个空工作区提交。 */
const statusText = gitToFile(['-c', 'core.quotepath=false', 'status', '--porcelain'])
const dirty = statusText === null ? git(['diff-index', '--quiet', 'HEAD', '--']) !== 0 : statusText.trim() !== ''

if (dirty) {
  if (git(['add', '-A']) !== 0) die('git add 失败')

  /* 打印 + 写进提交信息都用**暂存后**的清单：add 之后每一行都是"这次会进提交的东西"，
     没有"已暂存/未暂存"两份的歧义。
     `core.quotepath=false` 是为了中文文件名：默认 git 会把非 ASCII 转义成
     "data/board-\346\226\260…"，在提交信息里就是一堆看不懂的八进制。
     拿不到清单就照旧直接打给终端（至少人在那个窗口里能看到）。 */
  const staged = gitToFile(['-c', 'core.quotepath=false', 'status', '--short'])
  say('')
  say('  改动清单：')
  if (staged === null) {
    git(['-c', 'core.quotepath=false', 'status', '--short'])
  } else {
    for (const line of staged.replace(/\s+$/, '').split('\n')) say('  ' + line)
  }
  say('')

  const { subject, body } = buildCommitMessage(staged)
  const args = ['commit', '-m', subject]
  if (body) args.push('-m', body)
  if (git(args) !== 0) die('提交失败（上面的 git 输出里有原因）')
  say('  ✓ 已提交')
} else {
  say('  没有新改动（工作区是干净的）')
}

say('')
if (git(['pull', '--rebase', 'origin', 'HEAD']) !== 0) {
  die(
    '拉取远端失败——多半是有冲突要你决定留哪边',
    '打开这个目录，用 git status 看冲突文件；不确定就把这一步的输出发给我'
  )
}
say('  ✓ 已同步远端')

if (git(['push', '-u', 'origin', 'HEAD']) !== 0) {
  die('推送失败', '看上面 git 的输出：常见是没登录（gh auth login）或网络不通')
}
say('  ✓ 已推送到 GitHub')

say('')
say('  远端仓库：https://github.com/AK47n/studyhelper')
say('  数据安全了。关掉这个窗口就行。')
say('')
