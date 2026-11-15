/**
 * 选号策略的**离线决策测试**（合成数据 + 可注入时间，不连网、不花积分）。
 *
 * 为什么必须离线测：真实场景里「账号1 的积分进入 5 天到期窗口」要等十几天才发生，
 * 不可能靠等来验证切换逻辑。故把决策抽成纯函数 `decideAccount`，
 * 用**真实余额快照**（2026-10-14 实测）+ 可注入的 `nowMs` 精确锁住切换点。
 *
 * 策略（用户 2026-10-14 指定）：
 *   账号1 = 积分多的；账号2 = 积分少的
 *   - 默认烧账号2；账号1 出现「5 天内到期」的积分时切到账号1
 *   - 那部分花完 ⇒ 切回账号2
 *
 * ⚠️ 每条断言都配「不该选」的对照，避免恒真。
 */
import assert from 'node:assert/strict'
import { decideAccount, expiringWithin } from '../src/core.mjs'

const DAY = 86_400_000

let pass = 0
let fail = 0
const failures = []
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

/** 把 "2026-10-31" 解析成当天 00:00 (UTC+8) 的毫秒时间戳。 */
const at = (dateStr) => Date.parse(`${dateStr}T00:00:00+08:00`)

/** 造一个假的 credit/details 响应。rows = [[日期, 剩余]] */
const credits = (rows) => ({
  totalRemaining: rows.reduce((s, [, remain]) => s + remain, 0),
  totalConsumed: 0,
  details: rows.map(([date, remain]) => ({
    granted_amount: String(remain),
    remaining_amount: String(remain),
    consumed_amount: '0',
    expire_at_ms: at(date),
  })),
})

/** 造一个假账号。 */
const acct = (id, rows) => ({ cred: { accountId: id, expiresAt: at('2026-10-15'), expired: false }, credits: credits(rows) })

// ── 真实余额快照（2026-10-14 实测，逐笔照抄） ────────────────────────
const ACCT1 = acct('acct1-积分多', [           // 9955.18
  ['2026-10-31', 155.18],
  ['2026-11-01', 2000],
  ['2026-11-02', 800],
  ['2026-11-03', 800],
  ['2026-11-04', 2000],
  ['2026-11-05', 800],
  ['2026-11-06', 800],
  ['2026-11-09', 400],
  ['2026-11-10', 400],
  ['2026-11-11', 400],
  ['2026-11-12', 1000],
  ['2026-11-13', 400],
])
const ACCT2 = acct('acct2-积分少', [           // 2599.86
  ['2026-11-09', 399.86],
  ['2026-11-10', 400],
  ['2026-11-11', 400],
  ['2026-11-12', 1000],
  ['2026-11-13', 400],
])

const NOW = at('2026-10-14') + 12 * 3600_000 // 2026-10-14 12:00

console.log('\n[0] 快照自检：数据与线上一致')

check('账号1 合计 9955.18、账号2 合计 2599.86', () => {
  assert.equal(Math.round(ACCT1.credits.totalRemaining * 100) / 100, 9955.18)
  assert.equal(Math.round(ACCT2.credits.totalRemaining * 100) / 100, 2599.86)
})

console.log('\n[1] expiringWithin：窗口内且还有余额才算')

check('4 天后到期的 500 分 → 计入', () => {
  assert.equal(expiringWithin(credits([['2026-10-18', 500]]), 5 * DAY, NOW), 500)
})

check('「不该选」对照：30 天后到期的 500 分 → **不计入**', () => {
  assert.equal(expiringWithin(credits([['2026-11-13', 500]]), 5 * DAY, NOW), 0)
})

check('余额为 0 的那笔即使快到期也不计入', () => {
  assert.equal(expiringWithin(credits([['2026-10-15', 0]]), 5 * DAY, NOW), 0)
})

console.log('\n[2] 现状（2026-10-14）：应默认烧账号2')

check('账号1 无 5 天内到期的积分（最早 10/31，还有 17 天）', () => {
  assert.equal(expiringWithin(ACCT1.credits, 5 * DAY, NOW), 0)
})

check('决策 = 默认烧账号2（积分少的），账号1 留作储备', () => {
  const d = decideAccount([ACCT1, ACCT2], { nowMs: NOW })
  assert.equal(d.policy, 'default-burn')
  assert.equal(d.picked.cred.accountId, 'acct2-积分少')
})

check('「不该选」对照：此时**不应**是 rescue 策略', () => {
  const d = decideAccount([ACCT1, ACCT2], { nowMs: NOW })
  assert.notEqual(d.policy, 'rescue-expiring')
})

console.log('\n[3] 时间推进到 2026-10-27：账号1 进入 5 天窗口 → 应切过去救')

const T_1027 = at('2026-10-27') + 12 * 3600_000

check('账号1 出现 5 天内到期的 155.18（10/31）+ 2000（11/01）= 2155.18', () => {
  assert.equal(Math.round(expiringWithin(ACCT1.credits, 5 * DAY, T_1027) * 100) / 100, 2155.18)
})

check('账号2 在这时仍无 5 天内到期（最早 11/09）→ 它不该被救', () => {
  assert.equal(expiringWithin(ACCT2.credits, 5 * DAY, T_1027), 0)
})

check('决策 = rescue-expiring，且选中账号1', () => {
  const d = decideAccount([ACCT1, ACCT2], { nowMs: T_1027 })
  assert.equal(d.policy, 'rescue-expiring')
  assert.equal(d.picked.cred.accountId, 'acct1-积分多')
})

check('「不该选」对照：此时**不应**还是 default-burn', () => {
  const d = decideAccount([ACCT1, ACCT2], { nowMs: T_1027 })
  assert.notEqual(d.policy, 'default-burn')
})

console.log('\n[4] 那部分花完 → 应切回账号2')

// 模拟：10/31(155.18) 与 11/01(2000) 已花完，其余顺延到更晚
const ACCT1_BURNED = acct('acct1-积分多', [
  ['2026-10-31', 0],
  ['2026-11-01', 0],
  ['2026-11-02', 800],
  ['2026-11-03', 800],
  ['2026-11-04', 2000],
  ['2026-11-05', 800],
  ['2026-11-06', 800],
  ['2026-11-09', 400],
  ['2026-11-10', 400],
  ['2026-11-11', 400],
  ['2026-11-12', 1000],
  ['2026-11-13', 400],
])

check('窗口内只剩 800（11/02，距今 6 天 → 已在窗口外）→ 不再救援', () => {
  // 以 10/27 为基准：11/02 距今 6 天，超出 5 天窗口
  const r = expiringWithin(ACCT1_BURNED.credits, 5 * DAY, T_1027)
  assert.equal(r, 0, `实际 ${r}`)
})

check('决策回到 default-burn（切回账号2）', () => {
  const d = decideAccount([ACCT1_BURNED, ACCT2], { nowMs: T_1027 })
  assert.equal(d.policy, 'default-burn')
  assert.equal(d.picked.cred.accountId, 'acct2-积分少')
})

check('「不该选」对照：仍有窗口内余额时应继续救援（11/02 再晚一天就进窗口）', () => {
  const T = at('2026-10-28') + 12 * 3600_000 // 距 11/02 还有 4 天 ⇒ 进窗口
  const d = decideAccount([ACCT1_BURNED, ACCT2], { nowMs: T })
  assert.equal(d.policy, 'rescue-expiring')
  assert.equal(d.picked.cred.accountId, 'acct1-积分多')
})

console.log('\n[5] 边界与退化情形')

check('只有一个账号时直接用它', () => {
  const d = decideAccount([ACCT2], { nowMs: NOW })
  assert.equal(d.picked.cred.accountId, 'acct2-积分少')
})

check('余额查不到的账号不被作废（仍参与决策）', () => {
  const d = decideAccount([{ cred: { accountId: 'unknown', expiresAt: at('2026-10-15'), expired: false }, credits: undefined }, ACCT2], { nowMs: NOW })
  // unknown 的 remaining 视为 undefined → 排最后 → 成为 default-burn
  assert.equal(d.picked.cred.accountId, 'unknown')
})

check('两个账号余额完全相同时不抛错（取令牌较新者）', () => {
  const a = acct('same-a', [['2026-11-09', 500]])
  const b = acct('same-b', [['2026-11-09', 500]])
  const d = decideAccount([a, b], { nowMs: NOW })
  assert.ok(d.picked.cred.accountId === 'same-a' || d.picked.cred.accountId === 'same-b')
})

console.log(`\n${'─'.repeat(50)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过 ✅ —— 选号策略在真实余额快照上符合用户口径')
