/**
 * DSH 工具 schema 校验器的忠实镜像（离线）。
 *
 * 为什么要有这个文件：
 *   `ctx.tools.register()` 在**注册时**就会跑 `assertSupportedJsonSchema`，
 *   不合法会**抛错**。宿主侧代码只在 DSH 启动时加载 ⇒ 如果 schema 写错，
 *   要到重启后才会发现，且表现为「插件加载失败」。
 *   这个校验器把该判据提前到重启之前，规则**逐条抄自** asar 里
 *   `dsh-tools/lib/index.js` 的 `checkSchemaNode` / `checkObjectSchemaTail`：
 *
 *   - 允许的关键字（CONSTRAINT）：type / oneOf / properties / required /
 *     additionalProperties / items / enum / const
 *   - 允许的注解（ANNOTATION）：description / title / default / examples
 *   - 其它任何 key 都是违规（例如 minimum/maxLength/format 都**不支持**）
 *   - type 与 oneOf 不能同时出现
 *   - 必须有 type 或 oneOf 之一
 *   - type 只能是 object/array/string/number/integer/boolean/null
 *   - required 必须是字符串数组，且每项都要在 properties 里
 *   - additionalProperties 必须是 boolean
 *   - 不支持 type 数组
 *
 * 这是**镜像**不是原版：原版若有更新，此文件需同步。
 */

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 返回违规字符串数组；空数组 = 合法。 */
export function checkSchema(node, path = 'schema', seen = new Set()) {
  const violations = []

  if (!isPlainObject(node)) {
    return [`${path} must be a schema object`]
  }
  if (seen.has(node)) return [`${path} is circular`]
  seen.add(node)
  try {
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue
      if (ANNOTATION_KEYWORDS.has(key)) continue
      violations.push(
        `${path}.${key} is not a supported keyword `
        + `(subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`,
      )
    }

    if ('description' in node && typeof node.description !== 'string') {
      violations.push(`${path}.description must be a string`)
    }
    if ('title' in node && typeof node.title !== 'string') {
      violations.push(`${path}.title must be a string`)
    }

    const hasType = 'type' in node
    const hasOneOf = 'oneOf' in node
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`)
      return violations
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (key in node) violations.push(`${path}.${key} requires type or oneOf`)
      }
      return violations
    }

    if (hasOneOf) {
      const oneOf = node.oneOf
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (key in node) violations.push(`${path}.${key} is not supported beside oneOf`)
      }
      if (!Array.isArray(oneOf) || oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`)
      } else {
        oneOf.forEach((arm, i) => violations.push(...checkSchema(arm, `${path}.oneOf[${i}]`, seen)))
      }
      return violations
    }

    const type = node.type
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(
        Array.isArray(type)
          ? `${path}.type must be a single type string (type arrays are not supported)`
          : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`,
      )
      return violations
    }

    // 按类型检查该类型专属关键字的合法性
    if ('properties' in node && type !== 'object') {
      violations.push(`${path}.properties requires type "object"`)
    }
    if ('required' in node && type !== 'object') {
      violations.push(`${path}.required requires type "object"`)
    }
    if ('additionalProperties' in node && type !== 'object') {
      violations.push(`${path}.additionalProperties requires type "object"`)
    }
    if ('items' in node && type !== 'array') {
      violations.push(`${path}.items requires type "array"`)
    }
    if ('enum' in node) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        violations.push(`${path}.enum must be a non-empty array`)
      }
    }

    if (type === 'object') {
      const properties = node.properties
      if ('properties' in node && !isPlainObject(properties)) {
        violations.push(`${path}.properties must be an object`)
      }
      // required 规则（抄 checkObjectSchemaTail）
      if ('required' in node) {
        const required = node.required
        if (!Array.isArray(required) || required.some((e) => typeof e !== 'string')) {
          violations.push(`${path}.required must be an array of strings`)
        } else {
          const declared = isPlainObject(properties) ? properties : {}
          for (const key of required) {
            if (!Object.prototype.hasOwnProperty.call(declared, key)) {
              violations.push(`${path}.required names "${key}" which is not in properties`)
            }
          }
        }
      }
      if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be a boolean`)
      }
      if (isPlainObject(properties)) {
        for (const [k, sub] of Object.entries(properties)) {
          violations.push(...checkSchema(sub, `${path}.properties.${k}`, seen))
        }
      }
    }

    if (type === 'array' && 'items' in node) {
      violations.push(...checkSchema(node.items, `${path}.items`, seen))
    }
  } finally {
    seen.delete(node)
  }

  return violations
}

/** 等价于 dsh-tools 的 assertSupportedJsonSchema。 */
export function assertSupportedJsonSchema(schema, label = 'schema') {
  const v = checkSchema(schema, label)
  if (v.length > 0) {
    throw new Error(`JsonSchemaError: ${v.join('; ')}`)
  }
}
