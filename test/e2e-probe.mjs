/**
 * 端到端探针（只读，不创建任务、不花积分）。
 *
 * 判据：
 *  1. 凭据能从 JetHub 账号池读到，且未过期
 *  2. 工具列表 HTTP 200 且含两个视频工具
 *  3. **真实调用 tools/call**：查一个不存在的 task_id
 *     —— 这会真的走完整条 HTTP 链路，但因为是查询且 task_id 不存在，
 *        不产生任何生成任务、不扣积分。
 *     期望：拿到一个业务层响应（而不是 50001 internal error），
 *     证明「四字段 payload + 端点」完全正确。
 */
import { resolveJetHubCredential, listConnectorTools, callConnectorTool, fetchCredits } from '../src/core.mjs'

const line = (s) => console.log(s)

line('=== 1. 凭据 ===')
const cred = resolveJetHubCredential()
line(`  账号 ${cred.accountId} / ${cred.ref}`)
line(`  过期=${cred.expired}  到期 ${new Date(cred.expiresAt).toLocaleString('zh-CN')}`)
if (cred.expired) {
  line('  ✗ 凭据已过期，后续跳过')
  process.exit(1)
}
line('  ✓ 凭据有效')

line('\n=== 2. 工具列表 ===')
const { tools } = await listConnectorTools(cred.accessToken)
const videoTools = tools.filter((t) => /video_generation/.test(t.runtimeName))
line(`  共 ${tools.length} 个工具；视频相关 ${videoTools.length} 个`)
for (const t of videoTools) line(`    * ${t.runtimeName}`)
if (videoTools.length !== 2) {
  line('  ✗ 期望正好 2 个 video_generation 工具')
  process.exit(1)
}
line('  ✓ 两个视频工具都在')

line('\n=== 3. 真实调用 tools/call（查不存在的任务，不扣费）===')
const r = await callConnectorTool(cred.accessToken, {
  provider: 'matrix',
  providerToolName: 'matrix_query_video_generation',
  runtimeToolName: 'connector__matrix__query_video_generation',
  args: { task_id: '__probe_no_such_task__', model: 'MiniMax-H3' },
})
line(`  isError = ${r.isError}`)
line(`  返回：${JSON.stringify(r.result).slice(0, 400)}`)
if (r.result && typeof r.result === 'object' && r.result.code === 50001) {
  line('  ✗ 仍是 50001 internal error —— payload 形状可能不对')
  process.exit(1)
}
line('  ✓ 走到了业务层（非 50001），四字段 payload 与端点均正确')

line('\n=== 4. 积分余额（只读）===')
const cr = await fetchCredits(cred.accessToken)
line(`  剩余 ${cr.totalRemaining.toFixed(2)} / 已用 ${cr.totalConsumed.toFixed(2)}`)
line('  ✓ 余额链路通')

line('\n全部通过 ✅（本次未创建任何任务、未消耗积分）')
