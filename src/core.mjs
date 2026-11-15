/**
 * MiniMax 视频生成核心逻辑（不依赖 DSH，可独立测试）。
 *
 * 通路（2026-10-14 实测确认）：
 *   POST {apiHost}/minimax-cloud/api/v1/connectors/tools/call
 *   Body: { provider, provider_tool_name, runtime_tool_name, arguments_json }
 *   ⚠️ 四个字段缺一不可；arguments_json 是 **JSON 字符串**，不是对象。
 *
 * 凭据：JetHub 账号池（$DSH_HOME/jet-hub/state.json → .credentials.yaml
 * 的 MINIMAX_ACCOUNT_*）。**本模块只读，绝不写入续期逻辑。**
 * 前置条件：目标 DSH 实例装了 JetHub 账号池插件、且已登录 minimax 账号。
 *
 * ⚠️ 2026-11-09 即插即用改造：此前这里把 DSH_HOME 写死成开发机的绝对路径，
 *    导致插件只在那一台机器上能跑。现在 home 目录按
 *    opts.homeDir → DSH_HOME → ~/.dsh 三级解析，**不含任何本机绝对路径**；
 *    凭据路线不变，仍走 JetHub。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const API_HOST = 'https://agent.minimax.cn'
export const LIST_PATH = '/minimax-cloud/api/v1/connectors/connected-tools/list'
export const CALL_PATH = '/minimax-cloud/api/v1/connectors/tools/call'
export const CREDIT_PATH = '/minimax-cloud/api/v1/credit/details'

export const VIDEO_MODELS = ['MiniMax-H3', 'MiniMax-H3-Max', 'MiniMax-Hailuo-2.3']

/** 默认参数表（按模型）—— 取自工具 input_schema 的实测值。 */
export const MODEL_SPECS = {
  'MiniMax-H3': {
    durations: [4, 15],
    resolutions: ['768P', '2K'],
    defaultResolution: '2K',
    supportsReferences: true,
    supportsLastFrame: true,
    hasAudio: true,
    speed: '慢（15–30 分钟）',
    note: '质量最好；用积分，不吃 Token Plan 额度',
  },
  'MiniMax-H3-Max': {
    durations: [5, 15],
    resolutions: ['480P', '768P'],
    defaultResolution: '768P',
    supportsReferences: false,
    supportsLastFrame: true,
    hasAudio: true,
    speed: '快（约 20 秒）',
    note: '极速版；只支持文生/首尾帧，不支持多模态参考',
  },
  'MiniMax-Hailuo-2.3': {
    durations: [6, 10],
    resolutions: ['768P', '1080P'],
    defaultResolution: '768P',
    supportsReferences: false,
    supportsLastFrame: false,
    hasAudio: false,
    speed: '中等',
    note: '低成本，可用 Token Plan；**无声**，要配音需另调语音合成',
  },
}

// ─────────────────────────── 凭据读取（只读） ───────────────────────────

/** 极简 YAML 取值：只为从 .credentials.yaml 里抠出 MINIMAX_ACCOUNT_* 那几行。 */
function pickCredentialLines(text) {
  const out = new Map()
  const re = /^\s*(MINIMAX_ACCOUNT_[A-Za-z0-9_]+)\s*:\s*'(.+?)'\s*$/gm
  let m
  while ((m = re.exec(text)) !== null) out.set(m[1], m[2])
  return out
}

/**
 * 解析 DSH home 目录 —— **绝不写死任何盘符**（2026-11-09 即插即用改造）。
 *
 * 优先级：显式 opts.homeDir → DSH_HOME → ~/.dsh。
 * 宿主进程自带 DSH_HOME（实测），所以别人的实例装好 JetHub 后无需任何配置。
 */
export function resolveHomeDir(opts = {}) {
  if (opts.homeDir) return opts.homeDir
  if (process.env.DSH_HOME?.trim()) return process.env.DSH_HOME.trim()
  return join(homedir(), '.dsh')
}

/**
 * 列出 JetHub 账号池里所有启用的 minimax 账号及其凭据（只读，不发网络请求）。
 *
 * ⚠️ 文件缺失 / 无账号 / 缺 token 一律**显式抛错**，不静默返回空。
 *
 * @param {{homeDir?: string}} [opts] homeDir 缺省时按 resolveHomeDir() 动态解析
 * @returns {Array<{accountId, ref, accessToken, expiresAt, expired}>}
 */
export function listJetHubMinimaxCredentials(opts = {}) {
  const home = resolveHomeDir(opts)
  const statePath = join(home, 'jet-hub', 'state.json')
  const credPath = join(home, '.credentials.yaml')

  if (!existsSync(statePath)) {
    throw new Error(
      `JetHub 状态文件不存在：${statePath}。`
      + '本插件依赖目标 DSH 实例已安装 JetHub 账号池并登录 minimax 账号。',
    )
  }
  if (!existsSync(credPath)) throw new Error(`凭据文件不存在：${credPath}`)

  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const accounts = (state.accounts ?? []).filter(
    (a) => a.provider === 'minimax' && a.enabled !== false,
  )
  if (accounts.length === 0) throw new Error('JetHub 账号池里没有启用的 minimax 账号')

  const creds = pickCredentialLines(readFileSync(credPath, 'utf8'))

  const out = []
  const missing = []
  for (const a of accounts) {
    const raw = creds.get(a.credentialRef)
    if (typeof raw !== 'string') { missing.push(a.credentialRef); continue }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`凭据 ${a.credentialRef} 不是合法 JSON`)
    }
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new Error(`凭据 ${a.credentialRef} 缺少 access_token`)
    }
    const expiresAt = Number(parsed.expires_at ?? a.expiresAt ?? 0)
    out.push({
      accountId: a.id,
      ref: a.credentialRef,
      accessToken: parsed.access_token,
      expiresAt,
      expired: expiresAt > 0 && expiresAt <= Date.now(),
    })
  }

  if (out.length === 0) {
    throw new Error(
      `账号池里有 ${accounts.length} 个 minimax 账号，但凭据文件里找不到对应条目`
      + `（找过：${missing.join(', ')}）`,
    )
  }
  return out
}

/**
 * 取一个可用的 minimax 凭据（**按令牌新鲜度**，同步、不发网络）。
 *
 * ⚠️ 这个函数**只看令牌何时过期**，不看积分。选号请优先用
 * `resolveBestMinimaxCredential()`（按积分到期紧迫度选）。
 * 保留本函数名是因为离线探针与历史测试都在调它。
 */
export function resolveJetHubCredential(opts = {}) {
  const list = listJetHubMinimaxCredentials(opts)
  // 选令牌过期时间最晚的（= 最新鲜）
  return list.slice().sort((a, b) => b.expiresAt - a.expiresAt)[0]
}

/** 取某账号「最早到期且仍有余额」的那笔积分的到期时间（紧迫度指标，越小越先到期）。 */
function earliestExpiringWithBalance(credits) {
  const rows = (credits.details ?? [])
    .filter((d) => Number(d.remaining_amount ?? 0) > 0)
    .map((d) => Number(d.expire_at_ms ?? Number.MAX_SAFE_INTEGER))
  if (rows.length === 0) return Number.MAX_SAFE_INTEGER
  return Math.min(...rows)
}

/** 对外暴露的「最早到期」查询（供 UI 展示紧迫度）。 */
export function earliestExpiry(credits) {
  return earliestExpiringWithBalance(credits)
}

/** 某账号「N 天内会到期、且还有余额」的积分总额（0 表示没有快过期的）。 */
export function expiringWithin(credits, windowMs, nowMs = Date.now()) {
  const limit = nowMs + windowMs
  return (credits.details ?? [])
    .filter((d) => Number(d.remaining_amount ?? 0) > 0)
    .filter((d) => Number(d.expire_at_ms ?? Number.MAX_SAFE_INTEGER) <= limit)
    .reduce((s, d) => s + Number(d.remaining_amount ?? 0), 0)
}

/** 救援窗口：账号1（积分多的）出现「这么多天内到期」的积分时，才切过去救。 */
export const RESCUE_WINDOW_DAYS = 5
const RESCUE_WINDOW_MS = RESCUE_WINDOW_DAYS * 86_400_000

/**
 * ⭐ **纯决策函数**：给定各账号的余额，决定这次用哪个。
 *
 * 抽成纯函数是为了**可离线验证** —— 真实场景里「账号1 的积分进入 5 天窗口」
 * 要等好几天才发生，不可能靠等来测；用合成数据 + 可注入的 `nowMs` 才能
 * 精确锁住切换逻辑（见 `test/selection.test.mjs`）。
 *
 * 策略（**用户 2026-10-14 明确指定**）：
 *   账号1 = 当前**积分多**的那个；账号2 = **积分少**的那个。
 *   - **默认优先花账号2**（把积分多的那个当储备）
 *   - 一旦**账号1 出现「5 天内到期」的积分** ⇒ 切到账号1，把这部分救回来
 *   - 那部分花完（账号1 不再有 5 天内到期的）⇒ **切回账号2**
 *
 * @param {Array<{cred: object, credits?: object}>} candidates 各账号（credits 缺失=查不到余额）
 * @param {{rescueWindowDays?: number, nowMs?: number}} [opts]
 * @returns {{picked: object, policy: string, reason: string}}
 */
export function decideAccount(candidates, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now()
  const windowMs = (opts.rescueWindowDays ?? RESCUE_WINDOW_DAYS) * 86_400_000

  const rows = candidates.map((c) => {
    const credits = c.credits
    return {
      ...c,
      remaining: credits === undefined ? undefined : credits.totalRemaining,
      urgency: credits === undefined
        ? Number.MAX_SAFE_INTEGER
        : earliestExpiringWithBalance(credits),
      rescueable: credits === undefined ? 0 : expiringWithin(credits, windowMs, nowMs),
    }
  })

  if (rows.length === 0) throw new Error('decideAccount: 候选账号为空')

  // 账号1 = 积分最多；账号2 = 积分最少（余额查不到的排最后）
  const byAmount = rows.slice().sort((a, b) => {
    const ra = a.remaining ?? -1
    const rb = b.remaining ?? -1
    if (ra !== rb) return rb - ra
    return b.cred.expiresAt - a.cred.expiresAt
  })

  const account1 = byAmount[0]
  // 默认燃烧账号 = 积分最少的那个（用户口径的「账号2」）
  const defaultBurn = byAmount[byAmount.length - 1]

  // 救援判据：**除默认账号外**的账号里，是否有「窗口内到期且还有余额」的积分
  const rescuable = rows
    .filter((x) => x !== defaultBurn && x.rescueable > 0)
    .sort((a, b) => a.urgency - b.urgency)

  const days = (ms) => Math.max(0, Math.round((ms - nowMs) / 86_400_000))

  if (rescuable.length > 0) {
    const pick = rescuable[0]
    const d = pick.urgency === Number.MAX_SAFE_INTEGER ? undefined : days(pick.urgency)
    return {
      picked: pick,
      policy: 'rescue-expiring',
      reason:
        `切换到 ${pick.cred.accountId}（积分 ${pick.remaining?.toFixed(2) ?? '?'}）：`
        + `其中有 ${pick.rescueable.toFixed(2)} 积分将在约 ${d} 天内到期 —— 先把这部分救回来。`
        + (pick.cred.accountId === account1.cred.accountId ? '（这是积分多的账号1）' : ''),
    }
  }

  const d = defaultBurn.urgency === Number.MAX_SAFE_INTEGER ? undefined : days(defaultBurn.urgency)
  return {
    picked: defaultBurn,
    policy: 'default-burn',
    reason:
      `使用 ${defaultBurn.cred.accountId}（积分 ${defaultBurn.remaining?.toFixed(2) ?? '?'}）：`
      + `默认烧积分少的这个，把积分多的账号1 留作储备。`
      + (d !== undefined ? `（本账号最早到期还有约 ${d} 天）` : ''),
  }
}

/**
 * ⭐ 选号（对外接口）：拉余额后交给 `decideAccount` 决策。
 *
 * 为什么不能按「令牌新鲜度」选号（真实缺陷，2026-10-14 发现）：
 *   本机两个账号的令牌过期时间只差 **84 毫秒**
 *   （1C233655 = 18:50:49.912，9901D778 = 18:50:49.824）⇒ 按令牌排序等于**掷硬币**。
 *   实测那次选中积分多的账号纯属运气。
 *
 * 代价：每个账号一次 `credit/details` **只读**请求（不消耗积分）。
 * 本机只有 2 个账号，开销可忽略。查不到余额的账号退到「令牌新鲜度」维度。
 *
 * @param {{homeDir?: string, rescueWindowDays?: number, signal?: AbortSignal, nowMs?: number}} [opts]
 * @returns {Promise<{accountId, ref, accessToken, expiresAt, expired, reason, policy, credits?}>}
 */
export async function resolveBestMinimaxCredential(opts = {}) {
  const list = listJetHubMinimaxCredentials(opts)
  const usable = list.filter((c) => !c.expired)
  if (usable.length === 0) {
    // 全过期：返回令牌最新的那个，让上层给出「去 JetHub 刷新」的明确报错
    return {
      ...list.slice().sort((a, b) => b.expiresAt - a.expiresAt)[0],
      policy: 'all-expired',
      reason: '所有 minimax 账号的令牌都已过期，请到 JetHub 设置页刷新或重新登录。',
    }
  }
  if (usable.length === 1) {
    return { ...usable[0], policy: 'only-one', reason: `只有 ${usable[0].accountId} 一个可用账号。` }
  }

  const candidates = []
  for (const c of usable) {
    try {
      const credits = await fetchCredits(c.accessToken, { signal: opts.signal })
      candidates.push({ cred: c, credits })
    } catch {
      // 查不到余额的账号不作废，退到「令牌新鲜度」维度参与排序
      candidates.push({ cred: c, credits: undefined })
    }
  }

  const { picked, policy, reason } = decideAccount(candidates, {
    rescueWindowDays: opts.rescueWindowDays,
    nowMs: opts.nowMs,
  })
  return { ...picked.cred, credits: picked.credits, policy, reason }
}



// ─────────────────────────── HTTP 客户端 ───────────────────────────

async function postJson(path, body, token, { signal, timeoutMs = 30_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })
  try {
    const res = await fetch(`${API_HOST}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`MiniMax 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`)
    }
    if (!res.ok) {
      throw new Error(`MiniMax HTTP ${res.status}：${text.slice(0, 400)}`)
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

/** 列出当前账号可用的 Connector 工具。 */
export async function listConnectorTools(token, opts = {}) {
  const data = await postJson(LIST_PATH, {}, token, opts)
  return {
    tools: (data.tools ?? []).map((t) => ({
      runtimeName: t.runtime_tool_name,
      provider: t.provider,
      providerToolName: t.provider_tool_name,
      description: t.description,
    })),
    failures: data.provider_failures ?? [],
  }
}

// ─────────────────────── 本地文件上传（换 HTTPS 链接） ───────────────────────
//
// 上游接口只收公网 HTTPS URL，本地图片/视频必须先换链接。协议是**两步**：
//   ① 调 `upload_temp_url` 工具 → 拿签名（upload_host + fields + temp_url）
//   ② 把文件以 multipart/form-data POST 到 upload_host
// 实现逐条对齐 mcode-tools 的 `uploadTempUrlCommand` / `parseSignedUpload`。

/** 扩展名 → MIME（抄自 mcode-tools 的 inferMimeType，只留我们支持的）。 */
export const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/**
 * 把本地文件上传成临时公网 URL。
 *
 * @param {string} token
 * @param {{filename: string, bytes: Uint8Array, mimeType: string}} file
 * @returns {Promise<{tempUrl: string, expiresInSeconds: number, bytes: number}>}
 */
export async function uploadTempFile(token, file, opts = {}) {
  const { filename, bytes, mimeType } = file
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`文件超过 100MB 上限：${(bytes.length / 1048576).toFixed(1)}MB`)
  }

  // ① 要签名
  const { result, isError } = await callConnectorTool(
    token,
    {
      provider: 'matrix',
      providerToolName: 'matrix_upload_temp_url',
      runtimeToolName: 'connector__matrix__upload_temp_url',
      args: { filename, mime_type: mimeType },
    },
    opts,
  )
  if (isError) throw new Error(`取上传签名失败：${JSON.stringify(result).slice(0, 300)}`)
  if (result && typeof result === 'object' && result.code !== undefined && Number(result.code) !== 0) {
    throw new Error(`取上传签名失败（code ${result.code}）：${result.message ?? ''}`)
  }

  const uploadHost = result?.upload_host
  const tempUrl = result?.temp_url
  const fields = result?.fields ?? {}
  const fileFieldName = result?.file_field_name ?? 'file'
  const maxBytes = Number(result?.max_bytes ?? MAX_UPLOAD_BYTES)
  const expiresInSeconds = Number(result?.expires_in_seconds ?? 0)

  if (typeof uploadHost !== 'string' || !uploadHost.startsWith('https://')) {
    throw new Error(`上传地址非法（必须是 HTTPS）：${uploadHost}`)
  }
  if (typeof tempUrl !== 'string' || tempUrl.length === 0) {
    throw new Error('上游没有返回 temp_url')
  }
  if (bytes.length > maxBytes) {
    throw new Error(`文件超过签名允许的上限 ${maxBytes} 字节`)
  }

  // ② 表单上传（顺序：先签名自带字段，再文件字段 —— 与官方实现一致）
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v))
  form.append(fileFieldName, new Blob([bytes], { type: mimeType }), filename)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('upload timeout')), 300_000)
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(opts.signal.reason), { once: true })
  let res
  try {
    res = await fetch(uploadHost, { method: 'POST', body: form, signal: ctrl.signal })
  } catch (cause) {
    throw new Error(`上传失败：${cause instanceof Error ? cause.message : String(cause)}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`)

  return { tempUrl, expiresInSeconds, bytes: bytes.length }
}

/**
 * 调用一个 Connector 工具。
 * @returns 解析后的业务结果（result_json 已 JSON.parse）
 */
export async function callConnectorTool(token, { provider, providerToolName, runtimeToolName, args }, opts = {}) {
  const data = await postJson(
    CALL_PATH,
    {
      provider,
      provider_tool_name: providerToolName,
      runtime_tool_name: runtimeToolName,
      arguments_json: JSON.stringify(args ?? {}),
    },
    token,
    { timeoutMs: 600_000, ...opts },
  )
  let result = data.result_json
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result)
    } catch {
      /* 保留原始字符串 */
    }
  }
  return { result, isError: data.is_error === true, raw: data }
}

/** 提交视频生成任务 → 返回 task_id。 */
export async function submitVideo(token, args, opts = {}) {
  const model = args.model
  if (!VIDEO_MODELS.includes(model)) {
    throw new Error(`model 必须是 ${VIDEO_MODELS.join(' / ')} 之一，收到：${model}`)
  }
  const spec = MODEL_SPECS[model]
  const [dMin, dMax] = spec.durations
  if (!Number.isInteger(args.duration) || args.duration < dMin || args.duration > dMax) {
    throw new Error(`${model} 的 duration 必须是 ${dMin}~${dMax} 的整数，收到：${args.duration}`)
  }
  if (args.resolution !== undefined && !spec.resolutions.includes(args.resolution)) {
    throw new Error(`${model} 的 resolution 只支持 ${spec.resolutions.join(' / ')}`)
  }
  if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
    throw new Error('prompt 不能为空')
  }

  const { result, isError } = await callConnectorTool(
    token,
    {
      provider: 'matrix',
      providerToolName: 'matrix_submit_video_generation',
      runtimeToolName: 'connector__matrix__submit_video_generation',
      args,
    },
    opts,
  )
  if (isError) throw new Error(`提交失败：${JSON.stringify(result).slice(0, 400)}`)
  if (result && typeof result === 'object' && result.code && result.code >= 400) {
    throw new Error(`提交被拒（code ${result.code}）：${result.message ?? ''}`)
  }
  return result
}

/** 查询视频任务状态。 */
export async function queryVideo(token, { taskId, model }, opts = {}) {
  const { result, isError } = await callConnectorTool(
    token,
    {
      provider: 'matrix',
      providerToolName: 'matrix_query_video_generation',
      runtimeToolName: 'connector__matrix__query_video_generation',
      args: { task_id: taskId, model },
    },
    opts,
  )
  if (isError) throw new Error(`查询失败：${JSON.stringify(result).slice(0, 400)}`)
  return result
}

/** 查积分余额（只读，不消耗）。 */
export async function fetchCredits(token, opts = {}) {
  const url = `${API_HOST}${CREDIT_PATH}?timezone_id=${encodeURIComponent('Asia/Shanghai')}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: opts.signal,
  })
  if (!res.ok) throw new Error(`余额查询 HTTP ${res.status}`)
  const data = await res.json()
  const details = data.details ?? []
  return {
    totalRemaining: details.reduce((s, d) => s + Number(d.remaining_amount ?? 0), 0),
    totalConsumed: details.reduce((s, d) => s + Number(d.consumed_amount ?? 0), 0),
    details,
  }
}

/** 按目录价折算积分估算（1,000 积分 = ¥7 ⇒ 1 元 ≈ 142.86 积分）。 */
export const CREDITS_PER_YUAN = 1000 / 7
export const VIDEO_PRICE_YUAN_PER_SEC = {
  'MiniMax-H3': { '768P': 0.5, '2K': 0.8 },
  'MiniMax-H3-Max': { '480P': 0.33, '768P': 0.5 },
  'MiniMax-Hailuo-2.3': { '768P': 2 / 6, '1080P': 3.5 / 6 },
}

export function estimateCredits({ model, resolution, duration }) {
  const table = VIDEO_PRICE_YUAN_PER_SEC[model]
  if (!table) return undefined
  const spec = MODEL_SPECS[model]
  const res = resolution ?? spec.defaultResolution
  const perSec = table[res]
  if (perSec === undefined) return undefined
  return Math.round(perSec * duration * CREDITS_PER_YUAN)
}
