/**
 * 两个 JetHub minimax 账号的余额与到期对比（只读）。
 *
 * 目的：回答「为什么用了积分多的那个账号，而不是积分少的」。
 * 关键判据不只是**余额**，还有**积分到期时间** —— 先花快过期的才不会浪费。
 */
import { fetchCredits } from '../src/core.mjs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 不写死盘符：优先 DSH_HOME，其次 ~/.dsh
const HOME = process.env.MINIMAX_VIDEO_HOME?.trim()
  || process.env.DSH_HOME?.trim()
  || join(homedir(), '.dsh')
const CRED = join(HOME, '.credentials.yaml')
const REFS = ['MINIMAX_ACCOUNT_1C233655', 'MINIMAX_ACCOUNT_9901D778']

const txt = readFileSync(CRED, 'utf8')

function pick(ref) {
  // 该 YAML 里凭据值是单引号包住的 JSON 单行
  const line = txt.split('\n').find((l) => l.trim().startsWith(ref + ':'))
  if (!line) throw new Error(`找不到 ${ref}`)
  const start = line.indexOf("'")
  const end = line.lastIndexOf("'")
  return JSON.parse(line.slice(start + 1, end))
}

const fmtDate = (ms) => new Date(Number(ms)).toLocaleDateString('zh-CN', {
  month: '2-digit', day: '2-digit',
})

for (const ref of REFS) {
  const c = pick(ref)
  const tokenExp = new Date(Number(c.expires_at)).toLocaleString('zh-CN')
  console.log('='.repeat(64))
  console.log(`${ref}`)
  console.log(`  token 过期: ${tokenExp}`)
  try {
    const cr = await fetchCredits(c.access_token)
    console.log(`  余额合计: 剩余 ${cr.totalRemaining.toFixed(2)}  已用 ${cr.totalConsumed.toFixed(2)}`)
    console.log('  逐笔（按到期日排序）:')
    const rows = cr.details
      .map((d) => ({
        granted: Number(d.granted_amount),
        used: Number(d.consumed_amount),
        remain: Number(d.remaining_amount),
        expire: Number(d.expire_at_ms),
      }))
      .sort((a, b) => a.expire - b.expire)
    for (const r of rows) {
      const mark = r.remain > 0 ? ' ' : '✓'
      console.log(
        `   ${mark} 到期 ${fmtDate(r.expire)}  发放 ${r.granted.toFixed(2).padStart(8)}`
        + `  已用 ${r.used.toFixed(2).padStart(8)}  剩余 ${r.remain.toFixed(2).padStart(8)}`,
      )
    }
    // 汇总「最早到期且还有余额」的那笔
    const soon = rows.find((r) => r.remain > 0)
    if (soon) console.log(`  >>> 最早到期且未用完: ${fmtDate(soon.expire)}（剩 ${soon.remain.toFixed(2)}）`)
  } catch (e) {
    console.log('  查询失败:', e.message)
  }
}
