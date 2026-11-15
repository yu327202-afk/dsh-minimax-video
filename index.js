/**
 * dsh-minimax-video —— 把 MiniMax 视频生成接入 DSH。
 *
 * 设计要点（都来自本轮实测，不是推断）：
 *
 * 1. **零外部依赖**：只用 node 内置模块 + 本地 core.mjs。
 *    为什么不用 `import { defineTool } from '@deepseek-ai/dsh-tools'`：
 *    profile 的 node_modules 里**没有**该包（实测 `createRequire` 解析
 *    MODULE_NOT_FOUND），只有 app.asar 内有。`ctx.tools.register()` 实际只要求
 *    一个普通对象 `{ name, description, parameters, output:{schema,render}, execute }`
 *    （读 asar 里 dsh-tools 的 `register()` 实现确认），`defineTool` 只是把 DSL
 *    编译成 JSON Schema 的语法糖 ⇒ 手写等价对象即可，不必冒解析失败的风险。
 *
 * 2. **凭据走 JetHub 账号池**：读 `$DSH_HOME/jet-hub/state.json` 找启用的
 *    minimax 账号 → 从 `.credentials.yaml` 取 `MINIMAX_ACCOUNT_*`。
 *    **只读、绝不写入续期逻辑**。2026-11-09 即插即用改造把写死的盘符换成
 *    按 `DSH_HOME` 环境变量动态解析（宿主进程自带），别人的实例装好 JetHub
 *    即可用，无需任何额外配置。
 *
 * 3. **异步三段式**：视频生成是异步任务，H3 要 15–30 分钟。
 *    故拆成「提交」与「查询」两个工具，提交立即返回 task_id，
 *    绝不阻塞等待（会撞 DSH 工具超时）。
 */
import { writeFile, readFile, stat } from 'node:fs/promises'
import { resolve as resolvePath, isAbsolute, join, extname, basename } from 'node:path'
import {
  resolveBestMinimaxCredential,
  listJetHubMinimaxCredentials,
  expiringWithin,
  earliestExpiry,
  RESCUE_WINDOW_DAYS,
  submitVideo,
  queryVideo,
  fetchCredits,
  estimateCredits,
  uploadTempFile,
  MIME_BY_EXT,
  MODEL_SPECS,
  VIDEO_MODELS,
} from './src/core.mjs'

export const name = 'minimax-video'

/** 需要 tools 服务才能注册工具。 */
export const inject = ['tools']

const text = (s) => [{ type: 'text', text: s }]

/**
 * 取会话工作区目录。
 *
 * ⚠️ **不能**用 `process.cwd()`（第一版就踩了这个坑）：
 *   宿主进程的 cwd 是 **DSH profile 目录**（形如 `<home>/profiles/desktop`），
 *   不是用户的工作区。
 *   用它拼相对路径会把产物写到 profile 里（还会因目录不存在而 ENOENT）。
 *
 * 正确来源是 `exec.agent.session.header.cwd` —— 官方 `dsh-tool-present` /
 * `dsh-tool-fs` 就是这么取的（读 asar 源码确认）。
 */
function workspaceCwd(exec) {
  return exec?.agent?.session?.header?.cwd
}

/**
 * 解析输出路径：相对路径按**会话工作区**解析，绝对路径原样。
 * 取不到工作区时**显式报错**，不静默回落到 process.cwd()（那会写错地方）。
 */
function resolveOut(p, exec) {
  if (isAbsolute(p)) return p
  const cwd = workspaceCwd(exec)
  if (cwd === undefined || cwd === null || String(cwd).length === 0) {
    throw new Error(
      `无法确定会话工作区，拒绝用相对路径 "${p}"（避免写错目录）。请改用绝对路径。`,
    )
  }
  return resolvePath(String(cwd), p)
}

/**
 * 取一个可用凭据 —— ⭐ 按**积分到期紧迫度**选号（不是令牌新鲜度）。
 *
 * 详见 core.mjs 里 `resolveBestMinimaxCredential` 的注释：本机两个账号的
 * 令牌过期只差 84 毫秒，按令牌选号等于掷硬币，会让快过期的积分白白作废。
 */
async function credentialOrThrow(exec) {
  const cred = await resolveBestMinimaxCredential({ signal: exec?.signal })
  if (cred.expired) {
    throw new Error(
      `MiniMax 凭据（${cred.ref}）已过期`
      + `（${new Date(cred.expiresAt).toLocaleString('zh-CN')}）。`
      + '请到 JetHub 设置页点该账号的「刷新」，或重新登录一次。',
    )
  }
  return cred
}

const MODEL_ENUM_DESC =
  'Video model. MiniMax-H3 = best quality, account credits, 15-30 min, supports multimodal references + native audio. '
  + 'MiniMax-H3-Max = fast (~20s), keyframes only, 480P/768P, account credits. '
  + 'MiniMax-Hailuo-2.3 = cheaper and Token-Plan eligible but SILENT and keyframe-only.'

const MEDIA_HINT = ' Accepts a public HTTPS URL, or a LOCAL FILE PATH (which this plugin uploads first to get a temporary URL).'

/**
 * 把「URL 或本地路径」统一成公网 URL。
 * - 已是 http(s):// → 原样返回（不下载、不重传，与官方实现同款）
 * - 否则当作本地路径 → 上传换临时链接
 */
async function toPublicUrl(token, value, label, exec) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} 不能为空`)
  }
  const v = value.trim()
  if (/^https?:\/\//i.test(v)) return { url: v, uploaded: false }

  const abs = isAbsolute(v) ? v : resolvePath(workspaceCwd(exec) ?? process.cwd(), v)
  let info
  try {
    info = await stat(abs)
  } catch {
    throw new Error(`${label} 既不是 HTTPS 链接，也不是可读的本地文件：${v}`)
  }
  if (!info.isFile()) throw new Error(`${label} 不是文件：${abs}`)
  if (info.size > 100 * 1024 * 1024) {
    throw new Error(`${label} 超过 100MB 上限：${(info.size / 1048576).toFixed(1)}MB`)
  }

  const ext = extname(abs).toLowerCase()
  const mimeType = MIME_BY_EXT[ext]
  if (mimeType === undefined) {
    throw new Error(`${label} 的扩展名 ${ext} 不被支持（支持：${Object.keys(MIME_BY_EXT).join(' ')}）`)
  }

  const bytes = await readFile(abs)
  const { tempUrl, expiresInSeconds } = await uploadTempFile(
    token,
    { filename: basename(abs), bytes, mimeType },
    { signal: exec?.signal },
  )
  return { url: tempUrl, uploaded: true, localPath: abs, expiresInSeconds, bytes: info.size }
}

/** 批量处理媒体数组。 */
async function toPublicUrlList(token, list, label, exec) {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const r = await toPublicUrl(token, list[i], `${label}[${i}]`, exec)
    out.push(r)
  }
  return out
}

export function apply(ctx) {
  // ── 工具 1：提交视频任务 ────────────────────────────────────────────
  ctx.tools.register({
    name: 'minimax_video_generate',
    description:
      'Submit a MiniMax video generation task (asynchronous) and return a task_id immediately. '
      + 'Then poll with minimax_video_status. Uses MiniMax Code account credits (the daily check-in credits), NOT a paid API key. '
      + 'MiniMax-H3 is slow (15-30 min); prefer MiniMax-H3-Max when iterating on a prompt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'Required video description, up to 7000 characters. For H3/H3-Max it also drives the native audio track (dialogue, ambience, SFX).' },
        model: { type: 'string', enum: VIDEO_MODELS, description: MODEL_ENUM_DESC },
        duration: { type: 'integer', description: 'Required. H3: 4-15 seconds. H3-Max: 5-15. Hailuo-2.3: 6 or 10.' },
        resolution: { type: 'string', enum: ['480P', '768P', '1080P', '2K'], description: 'H3: 768P or 2K (default 2K). H3-Max: 480P or 768P. Hailuo-2.3: 768P or 1080P.' },
        ratio: { type: 'string', enum: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], description: 'H3 family only. Text-to-video needs a concrete ratio (default 16:9); keyframe mode is always adaptive.' },
        inputImage: { type: 'string', description: 'First-frame image (or a single reference).' + MEDIA_HINT },
        lastFrameImage: { type: 'string', description: 'H3 / H3-Max first+last-frame mode: the ending frame.' + MEDIA_HINT },
        referenceType: { type: 'string', enum: ['first_frame', 'last_frame', 'subject'], description: 'How inputImage is used.' },
        referenceImages: { type: 'array', items: { type: 'string' }, description: 'MiniMax-H3 only: 1-9 reference images.' + MEDIA_HINT },
        referenceVideos: { type: 'array', items: { type: 'string' }, description: 'MiniMax-H3 only: 1-3 reference videos (2-15s each, <=50MB). Billed by the second on top of generation.' + MEDIA_HINT },
        referenceAudios: { type: 'array', items: { type: 'string' }, description: 'MiniMax-H3 only: 1-3 public HTTPS audio URLs; must accompany reference images or videos.' },
      },
      required: ['prompt', 'model', 'duration'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          taskId: { type: 'string' },
          model: { type: 'string' },
          estimatedCredits: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, v) => text(formatSubmit(v)),
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cred = await credentialOrThrow(exec)

      // 先把「URL 或本地路径」统一成公网 URL（本地文件会上传换链接）
      const uploads = []
      const track = (r) => { if (r.uploaded) uploads.push(r); return r }

      const inputImage = args.inputImage !== undefined
        ? track(await toPublicUrl(cred.accessToken, args.inputImage, 'inputImage', exec))
        : undefined
      const lastFrameImage = args.lastFrameImage !== undefined
        ? track(await toPublicUrl(cred.accessToken, args.lastFrameImage, 'lastFrameImage', exec))
        : undefined
      const refImages = args.referenceImages !== undefined
        ? (await toPublicUrlList(cred.accessToken, args.referenceImages, 'referenceImages', exec)).map(track)
        : undefined
      const refVideos = args.referenceVideos !== undefined
        ? (await toPublicUrlList(cred.accessToken, args.referenceVideos, 'referenceVideos', exec)).map(track)
        : undefined
      const refAudios = args.referenceAudios !== undefined
        ? (await toPublicUrlList(cred.accessToken, args.referenceAudios, 'referenceAudios', exec)).map(track)
        : undefined

      const upstream = {
        prompt: args.prompt,
        model: args.model,
        duration: args.duration,
        ...args.resolution !== undefined ? { resolution: args.resolution } : {},
        ...args.ratio !== undefined ? { ratio: args.ratio } : {},
        ...inputImage !== undefined ? { input_image: { url: inputImage.url } } : {},
        ...lastFrameImage !== undefined ? { last_frame_image: { url: lastFrameImage.url } } : {},
        ...args.referenceType !== undefined ? { reference_type: args.referenceType } : {},
        ...refImages !== undefined ? { reference_images: refImages.map((r) => ({ url: r.url })) } : {},
        ...refVideos !== undefined ? { reference_videos: refVideos.map((r) => ({ url: r.url })) } : {},
        ...refAudios !== undefined ? { reference_audios: refAudios.map((r) => ({ url: r.url })) } : {},
      }

      const est = estimateCredits({
        model: args.model,
        resolution: args.resolution,
        duration: args.duration,
      })

      const result = await submitVideo(cred.accessToken, upstream, { signal: exec?.signal })
      const taskId = result?.task_id ?? result?.taskId
      if (typeof taskId !== 'string' || taskId.length === 0) {
        throw new Error(`提交成功但没拿到 task_id，返回：${JSON.stringify(result).slice(0, 300)}`)
      }

      const spec = MODEL_SPECS[args.model]
      return {
        taskId,
        model: args.model,
        ...est !== undefined ? { estimatedCredits: est } : {},
        ...uploads.length > 0 ? { uploaded: uploads.map((u) => u.localPath) } : {},
        note: `${spec.speed}。用 minimax_video_status 查进度（taskId=${taskId}）。`
          + (est !== undefined ? `预估消耗约 ${est} 积分（按目录价折算，官方未公布积分换算表）。` : '')
          + (uploads.length > 0 ? `（已上传 ${uploads.length} 个本地素材换取临时链接）` : ''),
      }
    },
  })

  // ── 工具 2：查询 / 下载 ─────────────────────────────────────────────
  ctx.tools.register({
    name: 'minimax_video_status',
    description:
      'Query one MiniMax video task. When it succeeds, downloads the mp4 to outputPath and returns the local path. '
      + 'Read-only with respect to billing (does not create another charge). '
      + 'Video download links are temporary and videos are retained for 7 days, so download soon after success.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: 'task_id returned by minimax_video_generate.' },
        model: { type: 'string', enum: VIDEO_MODELS, description: 'Must be the same model used at submit time.' },
        outputPath: { type: 'string', description: 'Where to save the mp4, e.g. "videos/cat.mp4". Relative paths resolve against the session working directory. Only written on success.' },
      },
      required: ['taskId', 'model', 'outputPath'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: { type: 'string' },
          savedTo: { type: 'string' },
          videoUrl: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, v) => text(formatStatus(v)),
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cred = await credentialOrThrow(exec)
      const result = await queryVideo(
        cred.accessToken,
        { taskId: args.taskId, model: args.model },
        { signal: exec?.signal },
      )

      const status = String(result?.status ?? result?.task?.status ?? 'unknown')
      if (status !== 'succeeded') {
        return { status, message: `任务状态：${status}${status === 'running' || status === 'queued' ? '，请稍后再查。' : ''}` }
      }

      const videoUrl = result?.video_url ?? result?.task?.content?.url
      if (typeof videoUrl !== 'string' || videoUrl.length === 0) {
        return { status, message: '任务成功但没有返回 video_url（可能已被清理，视频仅保留 7 天）。' }
      }

      const out = resolveOut(args.outputPath, exec)
      const res = await fetch(videoUrl, { signal: exec?.signal })
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      await writeFile(out, buf)

      return { status, savedTo: out, videoUrl, message: `已保存到 ${out}（${(buf.length / 1048576).toFixed(1)} MB）` }
    },
  })

  // ── 工具 3：查积分余额（只读） ──────────────────────────────────────
  ctx.tools.register({
    name: 'minimax_video_credits',
    description:
      'Read the MiniMax Code credit balance for the JetHub minimax account (read-only, costs nothing). '
      + 'Useful before submitting an expensive video task.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          accountId: { type: 'string' },
          totalRemaining: { type: 'number' },
          totalConsumed: { type: 'number' },
          summary: { type: 'string' },
        },
      },
      render: (_args, v) => text(v.summary),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const cred = await credentialOrThrow(exec)
      const cr = await fetchCredits(cred.accessToken, { signal: exec?.signal })

      // 把所有账号的「谁快到期」摊开，让用户能看见储备账号的紧迫度
      const all = listJetHubMinimaxCredentials()
      const lines = [
        `本次用号：${cred.accountId}`,
        `  ${cred.reason ?? ''}`,
        `  积分剩余 ${cr.totalRemaining.toFixed(2)}，累计已用 ${cr.totalConsumed.toFixed(2)}`,
        `  （1,000 积分 = ¥7；折合约 ¥${(cr.totalRemaining / 1000 * 7).toFixed(2)}）`,
      ]

      // 列出所有账号的余额与「最早到期」，便于判断切换时机
      lines.push('', '账号池一览（只读）：')
      for (const c of all) {
        let info = ''
        try {
          const x = c.accountId === cred.accountId ? cr : await fetchCredits(c.accessToken)
          const soon = expiringWithin(x, RESCUE_WINDOW_DAYS * 86_400_000)
          const days = Math.max(0, Math.round((earliestExpiry(x) - Date.now()) / 86_400_000))
          info = `剩余 ${x.totalRemaining.toFixed(2)} · 最早到期约 ${days} 天后`
            + (soon > 0 ? ` · ⚠️ ${soon.toFixed(2)} 积分在 ${RESCUE_WINDOW_DAYS} 天内到期` : '')
        } catch {
          info = '（余额查询失败）'
        }
        lines.push(`  ${c.accountId === cred.accountId ? '▶' : ' '} ${c.accountId}  ${info}`)
      }

      return {
        accountId: cred.accountId,
        totalRemaining: cr.totalRemaining,
        totalConsumed: cr.totalConsumed,
        policy: cred.policy,
        summary: lines.join('\n'),
      }
    },
  })
}

// ─────────────────────────── 渲染（纯展示） ───────────────────────────

function formatSubmit(v) {
  const lines = [
    `已提交视频任务。`,
    `  任务 ID：${v.taskId}`,
    `  模型：${v.model}`,
  ]
  if (v.estimatedCredits !== undefined) {
    lines.push(`  预估消耗：约 ${v.estimatedCredits} 积分（≈¥${(v.estimatedCredits / 1000 * 7).toFixed(2)}，按目录价折算）`)
  }
  lines.push(``, `下一步：用 minimax_video_status 查询（taskId=${v.taskId}）。`)
  if (v.note) lines.push(v.note)
  return lines.join('\n')
}

function formatStatus(v) {
  if (v.savedTo) return `✅ 视频已生成并保存：${v.savedTo}\n${v.message ?? ''}`
  return v.message ?? `状态：${v.status}`
}
