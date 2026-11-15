# dsh-minimax-video

把 **MiniMax Code 的视频生成**接入 DSH：复用目标实例 JetHub 账号池里已登录的
minimax 登录态，**消耗签到积分**，无需付费 API Key。

版本 1.1.0 · MIT · 适用于 DSH 0.2.0 及以上 · Windows / macOS / Linux

---

## 这是什么

在 DSH 里直接说「生成一个视频：夕阳下的猫」，模型就会调用本插件，走 MiniMax 官方的
Connector 接口生成视频并下载到工作区。

**不新增付费**、**不改动 JetHub 插件**、**无常驻进程**（随 DSH 启停）。

---

## ⚠️ 前置条件（装之前先确认）

1. 目标 DSH 实例**已安装 JetHub 账号池插件**，且里面**已登录并启用 minimax 账号**
   （设置页可见、未停用、令牌未过期）。
2. 插件按环境变量 `DSH_HOME` 定位账号池文件：
   `$DSH_HOME/jet-hub/state.json` → `.credentials.yaml` 的 `MINIMAX_ACCOUNT_*`。
   **宿主进程自带 `DSH_HOME`，无需任何手工配置**；本包不含任何本机绝对路径、盘符或
   `link:` 依赖。

> 没有 JetHub 账号池的实例不要用本包 —— 报错会明确提示「需装 JetHub 并登录 minimax」，
> 不会静默失败。JetHub 每 30 分钟自动续期，本插件**只读**凭据，绝不碰续期逻辑。

---

## 三个工具

| 工具 | 作用 |
|---|---|
| `minimax_video_generate` | 提交任务，立即返回 `taskId`（异步，不阻塞） |
| `minimax_video_status` | 查状态；成功后**自动下载 mp4** 到指定路径 |
| `minimax_video_credits` | 查积分余额（只读，不花钱） |

---

## 安装（通用 .tgz 装法）

在**你的 DSH profile 目录**执行（`cd "$DSH_HOME/profiles/desktop"`，或用你自己的 profile 名）：

```bash
pnpm add file:./dsh-minimax-video-1.1.0.tgz
```

然后把 `dsh-minimax-video` 加进同目录 `package.json` 的 `dsh.profile.bundles` 数组，
**重启 DSH**（插件只在启动时加载，热重载对新插件无效）。

手动装法（等价）：把 `.tgz` 解压到 `node_modules/dsh-minimax-video/`，
在 `package.json` 的 `dependencies` 里加
`"dsh-minimax-video": "file:./dsh-minimax-video-1.1.0.tgz"`，
`dsh.profile.bundles` 加同名条目，跑 `pnpm install`，重启。

> ⚠️ 不要用 `link:` 指向某个源码目录 —— 那是开发场景，你机器上没有那个目录。
> ⚠️ 不要往 `$DSH_HOME/cordis.patch.yml` 里加本插件条目：包内自带的
> `cordis.patch.yml`（`- insert: - id: minimax-video`）已完成挂载，重复添加会触发
> `duplicate loader entry id`，导致 DSH 启动失败。

装完验证：问一句「查一下 MiniMax 视频积分余额」，应看到 `minimax_video_credits`
被调用并返回余额；若提示缺 JetHub，按上面「前置条件」处理。

---

## 为什么是「三段式」

视频生成是**异步任务**，不像生图那样同步返回：

```
提交 → 拿 taskId → 轮询状态 → 成功了下载 mp4
```

⚠️ **MiniMax-H3 要 15–30 分钟**，远超 DSH 的工具超时。
所以「提交」和「查询」必须拆成两个工具 —— 提交立即返回，绝不阻塞等待。

---

## 模型选择

| 模型 | 速度 | 分辨率 | 时长 | 参考素材 | 声音 |
|---|---|---|---|---|---|
| **MiniMax-H3** | 慢（15–30 分钟） | 768P / **2K** | 4–15s | ✅ 图+视频+音频 | ✅ 原生同步 |
| **MiniMax-H3-Max** | **快（约 20 秒）** | 480P / 768P | 5–15s | ❌ 仅首尾帧 | ✅ 原生同步 |
| MiniMax-Hailuo-2.3 | 中等 | 768P / 1080P | 6 或 10s | ❌ 仅首帧 | ❌ **无声** |

**建议打法**：用 **H3-Max 试提示词**（约 20 秒出片，迭代快），定稿后用 **H3** 出正片。

---

## 本地素材

`inputImage` / `lastFrameImage` / `referenceImages` / `referenceVideos` 既收
**公网 HTTPS URL**，也收**本地文件路径**（插件会自动走官方 `upload_temp_url`
两步上传换临时链接，100MB 上限，支持 png/jpg/webp/mp4/mov/wav/mp3 等）。
`referenceAudios` 只收公网 HTTPS URL。

> 视频生成结果只保留 7 天、下载链接为临时链接 ⇒ 成功后尽快用
> `minimax_video_status` 下载到工作区。

---

## 成本

**官方口径：1,000 积分 = ¥7**（≈ 1 元 = 143 积分）。

| 模型 | 5 秒一条 | 一周签到（4000 积分）能出 |
|---|---|---|
| H3 2K | ≈ 571 积分 | 7 条 |
| H3 768P | ≈ 357 积分 | 11 条 |
| H3-Max 480P | ≈ **236 积分** | **16 条** |
| H3-Max 768P | ≈ 357 积分 | 11 条 |

⚠️ **上表是按官方「目录价」（元/秒）反推的估算** —— MiniMax **官方未公布积分到秒的换算表**。
插件在提交前会打印预估积分，但那也是同一个估算口径，**不是账单**。

⚠️ **输入素材单独计费**：H3 参考视频按秒计费（2K 0.80 元/秒、768P 0.50 元/秒），
传长参考视频可能比生成本身还贵。

---

## ⭐ 选号策略（重要）

JetHub 池子里有多个 minimax 账号时，插件**不是随机选**，而是按积分到期紧迫度：

| | 定义 | 角色 |
|---|---|---|
| **账号1** | 当前**积分多**的那个 | **储备**，平时不动 |
| **账号2** | 当前**积分少**的那个 | **默认燃烧** |

**切换规则：**

```
默认：烧账号2
   ↓
账号1 一旦出现「5 天内到期」的积分
   ↓  切到账号1，把这部分救回来
那部分花完（账号1 不再有 5 天内到期的）
   ↓  切回账号2
```

**为什么这么设计**：积分到期就清零、不结转。这个策略**只救临死的那部分** ——
平时烧账号2，账号1 只在最后 5 天窗口被动用。既不浪费到期积分，
又尽量保留账号1 里更长命的余额。

> ⚠️ **不要**用「令牌新鲜度」选号：账号令牌过期时间可能只差几十毫秒，
> 那样选等于掷硬币（这是第一版的真实缺陷，已修）。
> 也**不要**简单地「谁快过期就全烧谁」—— 那会把储备账号一开始就抽干。

窗口天数改 `RESCUE_WINDOW_DAYS`（`src/core.mjs`，默认 5）。

每次调用 `minimax_video_credits` 都会**打印本次用号与理由**，以及账号池一览
（含每个账号「最早到期约 N 天后」、是否有积分临近过期），便于随时核对。

---

## 卸载

从 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 移除该条目 →
`pnpm install` → 删 `node_modules/dsh-minimax-video/` → 重启。
（home 级 patch 里本就没有本插件的条目，无需清理。）

---

## 自测

```bash
node test/offline.test.mjs      # 37 项：注册合法性、参数校验、防复发、即插即用硬判据
node test/schema.test.mjs       # 17 项：DSH schema 规则镜像校验（含反向验证）
node test/selection.test.mjs    # 17 项：选号策略决策（真实余额快照 + 可注入时间）
node test/e2e-probe.mjs         # 端到端只读探针（不创建任务、不扣积分，需真实 JetHub）
node test/upload-probe.mjs <文件>  # 上传链路探针（只上传，不生成视频）
node test/compare-accounts.mjs  # 账号余额与逐笔到期对比（只读）
```

---

## 已知限制

- **依赖 JetHub 账号池**：见「前置条件」。凭据过期时插件会报错并提示去 JetHub 点「刷新」。
- **视频只保留 7 天**，下载链接是临时的 ⇒ 成功后尽快下载。
- **成本无法预知精确值**：官方未公布积分换算表，插件给的是按目录价的估算。
- **任务状态不持久化**：DSH 重启后 `taskId` 会丢，需重新提交。
- **只有工具调用，无前端界面**（用户已确认够用）。

## 变更记录

- **1.1.0（2026-11-09）**：即插即用改造 —— 去掉 `src/core.mjs` 与 `install.mjs` 里
  写死的 `F:\dsh-official\home`，改为按 `DSH_HOME` 环境变量动态解析；凭据路线不变，仍走
  JetHub 账号池；安装说明改为通用 `.tgz` 装法并写清 JetHub 前置条件；修正「本地上传未实现」
  的过时说明（代码早已支持）；新增 6 条即插即用离线硬判据。
- **1.0.0（2026-10-14）**：首版，三工具 + 按积分到期紧迫度选号 + 本地素材两步上传。
