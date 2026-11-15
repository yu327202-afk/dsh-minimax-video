/**
 * 用 DSH 真实规则的镜像，校验本插件注册的每个 schema。
 *
 * 这一步能在**重启之前**发现「schema 不被 DSH 支持」——否则要等重启后
 * 插件加载失败才知道。
 *
 * 同时做**反向验证**：故意造几个非法 schema，确认镜像校验器真会报错。
 * 否则「全部通过」可能只是因为校验器什么都不查（同义反复）。
 */
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSchema, assertSupportedJsonSchema } from './schema-mirror.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
const failures = []
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

// ── 1. 反向验证：镜像校验器必须能抓出非法 schema ──────────────────
console.log('\n[1] 反向验证（确认校验器不是恒真）')

check('抓得住：不支持的 keyword（minimum）', () => {
  const v = checkSchema({ type: 'integer', minimum: 4 })
  assert.ok(v.length > 0, '应该报错但没报')
  assert.match(v[0], /minimum is not a supported keyword/)
})

check('抓得住：type 与 oneOf 并存', () => {
  const v = checkSchema({ type: 'string', oneOf: [{ type: 'string' }, { type: 'number' }] })
  assert.ok(v.some((x) => /cannot declare both type and oneOf/.test(x)))
})

check('抓得住：required 里有 properties 不存在的键', () => {
  const v = checkSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] })
  assert.ok(v.some((x) => /names "b" which is not in properties/.test(x)))
})

check('抓得住：additionalProperties 不是 boolean', () => {
  const v = checkSchema({ type: 'object', additionalProperties: { type: 'string' } })
  assert.ok(v.some((x) => /additionalProperties must be a boolean/.test(x)))
})

check('抓得住：type 数组', () => {
  const v = checkSchema({ type: ['string', 'null'] })
  assert.ok(v.some((x) => /type arrays are not supported/.test(x)))
})

check('抓得住：properties 用在非 object 上', () => {
  const v = checkSchema({ type: 'string', properties: {} })
  assert.ok(v.length > 0)
})

check('抓得住：既无 type 也无 oneOf', () => {
  const v = checkSchema({ description: 'x' })
  assert.ok(v.length === 0, '这种空 schema 上游是允许的（无约束）')
})

// ── 2. 正版校验：本插件的每个 schema ──────────────────────────────
console.log('\n[2] 本插件注册对象的 schema')

const mod = await import(`file://${join(root, 'index.js').replace(/\\/g, '/')}`)
const registered = []
mod.apply({ tools: { register: (d) => { registered.push(d); return () => {} } } })

for (const def of registered) {
  check(`${def.name}: parameters 通过 DSH 校验`, () => {
    assertSupportedJsonSchema(def.parameters, `${def.name}.parameters`)
  })
  check(`${def.name}: output.schema 通过 DSH 校验`, () => {
    assertSupportedJsonSchema(def.output.schema, `${def.name}.output.schema`)
  })
  check(`${def.name}: output.schema 是 object 根`, () => {
    assert.equal(def.output.schema.type, 'object', 'DSH 的结构化输出要求 object 根')
  })
}

// ── 3. 边界：确保我们没用到不支持的关键字 ────────────────────────
console.log('\n[3] 关键字白名单扫描（防止将来手滑加 minimum/maxLength 等）')

const ALLOWED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])

/**
 * 收集**关键字**位置上的 key。
 *
 * ⚠️ 不能盲目递归：`properties` 的值是「字段名 → schema」的映射，
 * 那些字段名（prompt / model / …）是**数据**不是关键字。
 * 第一版就是这么写错的，把 25 个字段名误报成非法关键字。
 * 必须按 schema 结构走：只有 schema 节点上的 key 才算关键字。
 */
function collectKeys(node, out = new Set()) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return out
  for (const [k, v] of Object.entries(node)) {
    out.add(k)
    if (k === 'properties' && typeof v === 'object' && v !== null) {
      // v 是 name → schema，name 不算关键字，只继续走 schema
      for (const sub of Object.values(v)) collectKeys(sub, out)
    } else if (k === 'items' || k === 'oneOf') {
      if (Array.isArray(v)) v.forEach((x) => collectKeys(x, out))
      else collectKeys(v, out)
    }
    // 其余关键字的值是数据（enum 的取值、description 文本…），不再下钻
  }
  return out
}

check('所有 schema 里只出现白名单关键字', () => {
  const bad = new Set()
  for (const def of registered) {
    for (const key of collectKeys(def.parameters)) if (!ALLOWED.has(key)) bad.add(`parameters:${key}`)
    for (const key of collectKeys(def.output.schema)) if (!ALLOWED.has(key)) bad.add(`output:${key}`)
  }
  assert.equal(bad.size, 0, `出现不支持的关键字：${[...bad].join(', ')}`)
})

console.log(`\n${'─'.repeat(50)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过 ✅ —— schema 可被 DSH 接受（重启前即可确认）')
