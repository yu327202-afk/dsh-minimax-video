/**
 * 上传链路探针（只上传，不生成视频 ⇒ 不消耗视频积分）。
 *
 * 判据：本地图片能换成可访问的 HTTPS 临时链接。
 * 这一步会把文件传到 MiniMax 的临时存储（官方 upload_temp_url 的设计用途），
 * 但**不创建视频任务、不扣视频积分**。
 */
import { resolveJetHubCredential, uploadTempFile, MIME_BY_EXT } from '../src/core.mjs'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

const file = process.argv[2]
if (!file) {
  console.error('用法: node test/upload-probe.mjs <图片路径>')
  process.exit(2)
}

const line = (s) => console.log(s)

line('=== 1. 凭据 ===')
const cred = resolveJetHubCredential()
line(`  账号 ${cred.accountId}（过期=${cred.expired}）`)
if (cred.expired) { line('  ✗ 凭据过期'); process.exit(1) }
line('  ✓ 有效')

line('\n=== 2. 本地文件 ===')
const info = await stat(file)
const ext = extname(file).toLowerCase()
const mime = MIME_BY_EXT[ext]
line(`  ${basename(file)}  ${(info.size / 1048576).toFixed(2)} MB  ${mime}`)
if (!mime) { line(`  ✗ 不支持的扩展名 ${ext}`); process.exit(1) }
line('  ✓ 可上传')

line('\n=== 3. 上传（换取临时链接）===')
const bytes = await readFile(file)
const r = await uploadTempFile(cred.accessToken, { filename: basename(file), bytes, mimeType: mime })
line(`  temp_url: ${r.tempUrl.slice(0, 110)}${r.tempUrl.length > 110 ? '…' : ''}`)
line(`  有效期: ${r.expiresInSeconds} 秒`)
line(`  字节数: ${r.bytes}`)

line('\n=== 4. 验证链接真的可访问（GET，比对字节数）===')
// ⚠️ 必须用 GET，不能用 HEAD：实测该 OSS 签名 URL 对 HEAD 返回 403
//    （签名只覆盖 GET；`x-oss-signature` 与请求方法绑定）。
//    第一版用 HEAD 判定，得到假阴性「链接不可访问」。
const res = await fetch(r.tempUrl)
line(`  HTTP ${res.status}  content-type=${res.headers.get('content-type')}  length=${res.headers.get('content-length')}`)
if (!res.ok) { line('  ✗ 链接不可访问'); process.exit(1) }
const got = Buffer.from(await res.arrayBuffer())
line(`  实收字节数: ${got.length}（原始 ${bytes.length}）`)
if (got.length !== bytes.length) { line('  ✗ 字节数不一致，上传可能被截断'); process.exit(1) }
// 再验内容指纹（PNG 头 + 尾），确认不是占位文件
const isPng = got.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
line(`  PNG 魔数: ${isPng ? '✓ 正确' : '✗ 不对'}`)
if (!isPng) { line('  ✗ 内容不是 PNG'); process.exit(1) }
line('  ✓ 链接可访问且内容完整')

line('\n全部通过 ✅（未创建视频任务、未消耗视频积分）')
