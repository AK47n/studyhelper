// 一键备份：把新写的总结提交并推到 GitHub。
// 用法：双击根目录的「备份到GitHub.bat」，或者 npm run sync。
// 做三件事：提交 → 拉取（rebase，避免分叉）→ 推送。
//
// ── 两个写这个脚本时踩到的坑，改之前先看 ──
// 1. root 必须往上一级。这个文件在 scripts/ 里，path.dirname(import.meta.url)
//    得到的是 scripts/ 而不是项目根 —— 于是它在找 scripts\.git，永远找不到，
//    报出来却是"这个目录还不是 git 仓库"，把人往错的方向带。
// 2. 只信退出码，不要捕获 git 的输出。输出全部继承给终端（stdio: 'inherit'）：
//    报错时你直接看到 git 自己说的话，比转述的准；也绕开了"管道拿输出"这类
//    在受限环境里会失败的操作，不会再出现"拿不到输出"被误判成"命令失败"。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

/* 有没有要提交的：--quiet 干净时退 0、有改动时退 1（不看输出，所以不怕管道限制）。
   没有 HEAD（还没提交过）也算"有改动"。 */
const clean = git(['diff-index', '--quiet', 'HEAD', '--']) === 0

if (!clean) {
  say('')
  say('  改动清单：')
  git(['status', '--short'])
  say('')
  if (git(['add', '-A']) !== 0) die('git add 失败')
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
  if (git(['commit', '-m', `笔记更新 ${stamp}`]) !== 0) die('提交失败（上面的 git 输出里有原因）')
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
