/**
 * 离线自测：不连网、不花积分、不需要 DSH。
 *
 * 判据（每条都可证伪）：
 *  1. index.js 能被 import（语法/依赖解析无误）
 *  2. apply(mockCtx) 注册 3 个工具
 *  3. 每个注册对象满足 dsh-tools `register()` 的真实前置校验：
 *     - 有 name / description / parameters / output
 *     - output.schema 是对象、output.render 是函数
 *     - parameters 是合法 JSON Schema 形状（object + properties）
 *     - execute 是函数
 *     - name 不是保留名 run_code
 *  4. core.mjs 的纯函数逻辑：参数校验、成本估算
 *  5. 凭据读取器对「文件缺失 / 无账号 / 缺 access_token」都要**显式抛错**，不静默
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push(`${name}: ${e.message}`)
    console.log(`  ✗ ${name}\n      ${e.message}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push(`${name}: ${e.message}`)
    console.log(`  ✗ ${name}\n      ${e.message}`)
  }
}

const RESERVED = 'run_code'

console.log('\n[1] 插件模块加载与工具注册')
const mod = await import(`file://${join(root, 'index.js').replace(/\\/g, '/')}`)

const registered = []
const mockCtx = {
  tools: { register: (def) => { registered.push(def); return () => {} } },
}

await checkAsync('apply() 注册 3 个工具', () => {
  mod.apply(mockCtx)
  assert.equal(registered.length, 3, `实际注册 ${registered.length} 个`)
})

const EXPECTED = ['minimax_video_generate', 'minimax_video_status', 'minimax_video_credits']
check('工具名齐全', () => {
  const names = registered.map((d) => d.name).sort()
  assert.deepEqual(names, [...EXPECTED].sort())
})

console.log('\n[2] 注册对象满足 register() 的前置校验')

for (const def of registered) {
  check(`${def.name}: output 形状合法`, () => {
    assert.ok(def.output && typeof def.output === 'object', 'output 缺失')
    assert.ok(def.output.schema && typeof def.output.schema === 'object', 'output.schema 缺失')
    assert.equal(typeof def.output.render, 'function', 'output.render 必须是函数')
  })

  check(`${def.name}: parameters 是 object 型 JSON Schema`, () => {
    assert.equal(def.parameters.type, 'object', 'parameters.type 必须是 object')
    assert.ok(def.parameters.properties, 'parameters.properties 缺失')
  })

  check(`${def.name}: execute 是函数且未占用保留名`, () => {
    assert.equal(typeof def.execute, 'function', 'execute 必须是函数')
    assert.notEqual(def.name, RESERVED, `不能占用保留名 ${RESERVED}`)
  })

  check(`${def.name}: description 非空`, () => {
    assert.equal(typeof def.description, 'string')
    assert.ok(def.description.length > 20, 'description 太短，模型无法判断用途')
  })
}

check('required 字段都真实存在于 properties 里', () => {
  for (const def of registered) {
    for (const r of def.parameters.required ?? []) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(def.parameters.properties, r),
        `${def.name}: required 里的 "${r}" 不在 properties 中`,
      )
    }
  }
})

check('enum 字段的默认值（若有）在 enum 内', () => {
  for (const def of registered) {
    for (const [key, spec] of Object.entries(def.parameters.properties)) {
      if (spec.enum && spec.default !== undefined) {
        assert.ok(spec.enum.includes(spec.default), `${def.name}.${key} 默认值不在 enum 内`)
      }
    }
  }
})

console.log('\n[3] core.mjs 纯逻辑')

const core = await import(`file://${join(root, 'src/core.mjs').replace(/\\/g, '/')}`)

check('成本估算：H3-Max 480P 5s ≈ 236 积分', () => {
  const v = core.estimateCredits({ model: 'MiniMax-H3-Max', resolution: '480P', duration: 5 })
  assert.equal(v, 236)
})

check('成本估算：H3 2K 5s ≈ 571 积分', () => {
  const v = core.estimateCredits({ model: 'MiniMax-H3', resolution: '2K', duration: 5 })
  assert.equal(v, 571)
})

check('成本估算：未知模型返回 undefined（不编造）', () => {
  assert.equal(core.estimateCredits({ model: '__nope__', duration: 5 }), undefined)
})

await checkAsync('submitVideo 拒绝非法模型名（本地先拦，不打上游）', async () => {
  await assert.rejects(
    () => core.submitVideo('fake-token', { model: '__bad__', prompt: 'x', duration: 5 }),
    /model 必须是/,
  )
})

await checkAsync('submitVideo 拒绝超范围 duration', async () => {
  await assert.rejects(
    () => core.submitVideo('fake-token', { model: 'MiniMax-H3-Max', prompt: 'x', duration: 99 }),
    /duration 必须是/,
  )
})

await checkAsync('submitVideo 拒绝空 prompt', async () => {
  await assert.rejects(
    () => core.submitVideo('fake-token', { model: 'MiniMax-H3', prompt: '   ', duration: 5 }),
    /prompt 不能为空/,
  )
})

await checkAsync('submitVideo 拒绝不支持的 resolution', async () => {
  await assert.rejects(
    () => core.submitVideo('fake-token', { model: 'MiniMax-H3-Max', prompt: 'x', duration: 5, resolution: '2K' }),
    /resolution 只支持/,
  )
})

console.log('\n[4] 凭据读取器的失败路径必须显式')

check('目录不存在时抛错（不静默返回空）', () => {
  // 用 cross-platform 的绝不存在的目录，不写死任何盘符
  const bogus = join(homedir(), '__minimax_video_no_such_home__', String(Date.now()))
  assert.throws(
    () => core.resolveJetHubCredential({ homeDir: bogus }),
    /(不存在|找不到任何 MiniMax 凭据)/,
  )
})

console.log('\n[5] 源码静态检查（防手滑）')

check('index.js 不含硬编码 token 字样', () => {
  const src = readFileSync(join(root, 'index.js'), 'utf8')
  assert.ok(!/mmoat_|mmort_/.test(src), '源码里出现疑似真实 token')
})

check('index.js 不写入 JetHub 文件（只读纪律）', () => {
  const src = readFileSync(join(root, 'index.js'), 'utf8')
  const coreSrc = readFileSync(join(root, 'src/core.mjs'), 'utf8')
  for (const [label, s] of [['index.js', src], ['core.mjs', coreSrc]]) {
    assert.ok(!/writeFileSync|appendFileSync|writeFile\s*\(/.test(s.replace(/await writeFile\(out, buf\)/g, '')),
      `${label} 里出现写文件调用（除下载 mp4 外不应有）`)
  }
})

check('⚠️ 不得用 process.cwd() 解析相对路径（真实 bug 防复发）', () => {
  const src = readFileSync(join(root, 'index.js'), 'utf8')
  // 背景：宿主进程的 cwd 是 DSH profile 目录（形如 <home>/profiles/desktop），
  // 不是用户的工作区。第一版用它拼输出路径 ⇒ 产物写到 profile 里 + ENOENT。
  // 正确来源是 exec.agent.session.header.cwd（官方 dsh-tool-present 同款）。
  assert.ok(!/resolvePath\(process\.cwd\(\)/.test(src),
    'index.js 仍用 process.cwd() 解析相对路径 —— 会写错目录')
  assert.ok(/exec\?\.agent\?\.session\?\.header\?\.cwd/.test(src),
    'index.js 没有从 exec.agent.session.header.cwd 取工作区')
})

check('resolveOut 在取不到工作区时显式抛错（不静默回落）', () => {
  const src = readFileSync(join(root, 'index.js'), 'utf8')
  assert.ok(/无法确定会话工作区/.test(src), '缺少「取不到工作区」的显式报错')
})

check('⚠️ 选号必须按积分到期紧迫度，不能只按令牌新鲜度（真实缺陷防复发）', () => {
  const idx = readFileSync(join(root, 'index.js'), 'utf8')
  // 背景：本机两个账号的令牌过期只差 84ms，按令牌选号等于掷硬币；
  // 而两个账号的积分到期情况差异巨大（一个 7355 积分 11/06 前到期）。
  // 必须用 resolveBestMinimaxCredential（按最早到期积分选）。
  assert.ok(!/resolveJetHubCredential\(/.test(idx),
    'index.js 仍调用只看令牌新鲜度的 resolveJetHubCredential —— 会浪费快过期的积分')
  assert.ok(/resolveBestMinimaxCredential\(/.test(idx),
    'index.js 没有使用按积分到期紧迫度选号的 resolveBestMinimaxCredential')
})

check('core.mjs 里选号逻辑确实比较了积分到期时间', () => {
  const coreSrc = readFileSync(join(root, 'src/core.mjs'), 'utf8')
  assert.ok(/earliestExpiringWithBalance/.test(coreSrc), '缺少「最早到期积分」判据')
  assert.ok(/expire_at_ms/.test(coreSrc), '没有读 expire_at_ms（积分到期时间）')
})

check('package.json 的 dsh.bundle.patch 指向存在的文件', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const p = join(root, pkg.dsh.bundle.patch)
  assert.ok(existsSync(p), `patch 文件不存在：${p}`)
})

console.log('\n[6] 即插即用硬判据（2026-11-09 新增）')

check('⚠️ 包内源码不含任何本机绝对路径 / 盘符 / link: 本地依赖', () => {
  const files = ['index.js', 'src/core.mjs', 'install.mjs']
  // 注释里出现过的历史盘符不算硬编码；只查「代码里被当成默认路径」的形态
  const bad = /['"`][A-Za-z]:[\\/][^'"`]*['"`]|link:[A-Za-z]:[\\/]/
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8')
    assert.ok(!bad.test(src), `${f} 里仍有本机绝对路径或 link: 本地依赖`)
  }
})

check('核心模块按 DSH_HOME 动态解析 home，不再写死盘符', () => {
  const src = readFileSync(join(root, 'src/core.mjs'), 'utf8')
  assert.ok(/export function resolveHomeDir/.test(src), '缺少动态 home 解析函数')
  assert.ok(/process\.env\.DSH_HOME/.test(src), '没有读 DSH_HOME 环境变量')
  assert.ok(!/opts\.homeDir\s*\?\?\s*['"]F:/.test(src), 'core.mjs 仍把 F: 盘当默认 home')
})

check('install.mjs 未设 DSH_HOME 时明确报错，不猜盘符', () => {
  const src = readFileSync(join(root, 'install.mjs'), 'utf8')
  assert.ok(/if \(!DSH_HOME\)/.test(src), '缺少 DSH_HOME 缺失检查')
  assert.ok(!/process\.env\.DSH_HOME\s*\?\?\s*['"]F:/.test(src), '仍写死 F: 盘兜底')
})

check('resolveHomeDir 尊重 opts.homeDir / DSH_HOME / ~/.dsh 三级', () => {
  const explicit = join(tmpdir(), 'mmv-explicit-home')
  assert.equal(core.resolveHomeDir({ homeDir: explicit }), explicit)
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = join(tmpdir(), 'mmv-env-home')
    assert.equal(core.resolveHomeDir(), process.env.DSH_HOME)
    delete process.env.DSH_HOME
    assert.equal(core.resolveHomeDir(), join(homedir(), '.dsh'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

check('伪造的 JetHub home（任意盘符/目录）能读出账号 —— 证明不依赖本机路径', () => {
  // 造一份最小 JetHub 账号池，验证「别人实例装好 JetHub 即可用」这一前提
  const tmp = mkdtempSync(join(tmpdir(), 'minimax-video-fake-home-'))
  try {
    const jetDir = join(tmp, 'jet-hub')
    mkdirSync(jetDir, { recursive: true })
    writeFileSync(join(jetDir, 'state.json'), JSON.stringify({
      accounts: [{ provider: 'minimax', id: 'fake-acct', enabled: true, credentialRef: 'MINIMAX_ACCOUNT_FAKE' }],
    }), 'utf8')
    writeFileSync(join(tmp, '.credentials.yaml'),
      "MINIMAX_ACCOUNT_FAKE: '{\"access_token\":\"fake-token\",\"expires_at\":4102444800000}'\n", 'utf8')
    const rows = core.listJetHubMinimaxCredentials({ homeDir: tmp })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].accountId, 'fake-acct')
    assert.equal(rows[0].accessToken, 'fake-token')
    assert.equal(rows[0].expired, false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('没有 JetHub 账号池时报错写明前置条件，不静默', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'minimax-video-no-jethub-'))
  try {
    assert.throws(
      () => core.listJetHubMinimaxCredentials({ homeDir: tmp }),
      (e) => /JetHub 状态文件不存在/.test(e.message) && /JetHub 账号池/.test(e.message),
      '报错应告知「需装 JetHub 并登录 minimax」这个前置条件',
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

console.log(`\n${'─'.repeat(50)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过 ✅')
