#!/usr/bin/env node
/**
 * dsh-minimax-video 安装器（幂等，带备份）。
 *
 * 做三件事：
 *   1. profile 的 node_modules 里建 junction → 本插件目录
 *   2. profile 的 package.json：dependencies 加 link:，dsh.profile.bundles 加条目
 *   3. 自愈：若 home 级 cordis.patch.yml 里有本插件的旧残留裸 patch，清掉它
 *
 * ⚠️ **不往 home 级 patch 追加任何东西**：本插件自带的
 *    `cordis.patch.yml`（`- insert: - id: minimax-video`）已完成挂载，
 *    home 级再写一条同 id 的裸 patch 会触发 `duplicate loader entry id`。
 *
 * ⚠️ 用本脚本改 package.json 而不是 `dsh plugin add`：
 *   后者在部分实例上会被 minimumReleaseAge 供应链策略拦。
 *   如果你是从站点下载的 .tgz，请按 README 的 `pnpm add file:<tgz>` 装 ——
 *   本脚本只适用于「从源码目录直接挂载」的开发场景，且**必须**先设 DSH_HOME。
 *
 * 幂等：重复运行只补齐缺失项；已存在则跳过。
 * 备份：package.json / cordis.patch.yml 各备份一份带时间戳的副本。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, lstatSync, symlinkSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// ⚠️ 不写死任何盘符：DSH_HOME 必须由调用方环境提供（宿主进程自带），
//    没设就明确报错，绝不猜一个本机路径。
const DSH_HOME = process.env.DSH_HOME
if (!DSH_HOME) {
  console.error('✗ 未设置环境变量 DSH_HOME，无法确定 profile 目录。')
  console.error('  请先设置：set DSH_HOME=<你的 DSH home 目录>   （PowerShell: $env:DSH_HOME="..."）')
  process.exit(1)
}
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const PKG = join(PROFILE, 'package.json')
const HOME_PATCH = join(DSH_HOME, 'cordis.patch.yml')
const LINK_PATH = join(PROFILE, 'node_modules', 'dsh-minimax-video')
const PLUGIN_NAME = 'dsh-minimax-video'
const ENTRY_ID = 'minimax-video'

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const log = (s) => console.log(s)

function backup(p) {
  if (!existsSync(p)) return undefined
  const b = `${p}.bak-minimaxvideo-${stamp}`
  copyFileSync(p, b)
  return b
}

// ── 前置检查 ──────────────────────────────────────────────────────
if (!existsSync(PKG)) {
  console.error(`✗ 找不到 profile package.json：${PKG}`)
  console.error(`  如果你的 DSH_HOME 不是 ${DSH_HOME}，请先设置环境变量 DSH_HOME`)
  process.exit(1)
}

log(`DSH_HOME = ${DSH_HOME}`)
log(`插件目录 = ${HERE}`)

// ── 1. node_modules 链接 ──────────────────────────────────────────
log('\n[1/3] node_modules 链接')
mkdirSync(dirname(LINK_PATH), { recursive: true })
if (existsSync(LINK_PATH)) {
  let isLink = false
  try { isLink = lstatSync(LINK_PATH).isSymbolicLink() } catch { /* ignore */ }
  if (isLink) {
    log(`  已存在（符号链接），跳过`)
  } else {
    log(`  ⚠️ 已存在但不是链接 —— 说明可能是实体副本。为安全起见不覆盖。`)
    log(`     如需重装，请先手动删除：${LINK_PATH}`)
  }
} else {
  symlinkSync(HERE, LINK_PATH, 'junction')
  log(`  ✓ 已创建 junction → ${HERE}`)
}

// ── 2. package.json ───────────────────────────────────────────────
log('\n[2/3] profile package.json')
const pkgBak = backup(PKG)
if (pkgBak) log(`  备份 → ${pkgBak}`)

const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
let changed = false

pkg.dependencies ??= {}
const wantDep = `link:${HERE}`
if (pkg.dependencies[PLUGIN_NAME] !== wantDep) {
  pkg.dependencies[PLUGIN_NAME] = wantDep
  changed = true
  log(`  ✓ dependencies.${PLUGIN_NAME} = ${wantDep}`)
} else {
  log(`  dependencies 已正确，跳过`)
}

pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
if (!pkg.dsh.profile.bundles.includes(PLUGIN_NAME)) {
  pkg.dsh.profile.bundles.push(PLUGIN_NAME)
  changed = true
  log(`  ✓ dsh.profile.bundles 已加入 ${PLUGIN_NAME}`)
} else {
  log(`  bundles 已包含，跳过`)
}

if (changed) {
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  log(`  ✓ 已写回`)
} else {
  log(`  无需改动`)
}

// ── 3. home 级 patch —— 不需要！ ─────────────────────────────────
// ⚠️ 第一版安装器在这里画蛇添足地往 home 级 patch 追加了一条**裸 patch**
//    `- id: minimax-video`，理由是「home 级不被 plugin-manager 重写」。
//    那是**错的**，会导致 DSH 启动失败（`duplicate loader entry id`）：
//
//    本插件自带的 `cordis.patch.yml` 用的是 `- insert: - id: minimax-video`，
//    已经完成了挂载。home 级再写一条同 id 的裸 patch 就是**重复挂载**。
//
//    home 级那层的用途是**覆盖已有条目的 config**（例如 image-gen 改 baseURL、
//    dsh-imagegen-relay 改端口），不是用来做首次挂载的。
//    判据：看 home 级 patch 里现存的 3 条 —— dsh-imagegen-relay / image-gen
//    都是带 `config:` 的覆盖；没有 config 可覆盖的插件（per-turn-stats /
//    context-menu / compaction-knob 等）在 home 级**一条都没有**，
//    它们只靠自带 patch 就挂上了。
//
//    已实测：2026-10-14 首装时写入了该条，随后确认其为 duplicate 并移除。
log('\n[3/3] home 级 patch —— 本插件不需要（自带 patch 已挂载）')
log('  （跳过；若曾误写入，下面的自愈逻辑会清掉）')

// 自愈：若 home 级存在本插件残留的裸 patch，清掉它。
if (existsSync(HOME_PATCH)) {
  const text = readFileSync(HOME_PATCH, 'utf8')
  const stray = new RegExp(
    `\\n*# ── dsh-minimax-video[^\\n]*\\n(?:#[^\\n]*\\n)*- id: ${ENTRY_ID}\\n\\s*name: ${PLUGIN_NAME}\\n?`,
  )
  if (stray.test(text)) {
    const patchBak = backup(HOME_PATCH)
    if (patchBak) log(`  发现残留裸 patch，备份 → ${patchBak}`)
    writeFileSync(HOME_PATCH, text.replace(stray, '\n'), 'utf8')
    log(`  ✓ 已清除残留的 - id: ${ENTRY_ID}（避免 duplicate loader entry）`)
  } else {
    log('  ✓ 无残留')
  }
}

log('\n──────────────────────────────────────────')
log('安装完成。**请重启 DSH 使宿主侧代码生效**')
log('（插件只在 DSH 启动时加载，不热重载）')
log('')
log('重启后验证：问一句「查一下 MiniMax 视频积分余额」')
log('应该看到 minimax_video_credits 被调用并返回余额。')
