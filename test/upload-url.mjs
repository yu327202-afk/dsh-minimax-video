/**
 * 上传本地文件换取临时公网 URL，输出 JSON（含完整 temp_url）。
 *
 * 用途：插件的新代码（支持本地路径自动上传）需要重启才生效；
 * 在重启前，用本脚本先换链接，再把链接交给 minimax_video_generate。
 *
 * 用法: node test/upload-url.mjs <文件路径>
 */
import { resolveJetHubCredential, uploadTempFile, MIME_BY_EXT } from '../src/core.mjs'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

const file = process.argv[2]
if (!file) { console.error('用法: node test/upload-url.mjs <文件路径>'); process.exit(2) }

const cred = resolveJetHubCredential()
if (cred.expired) { console.error('凭据已过期'); process.exit(1) }

const info = await stat(file)
const ext = extname(file).toLowerCase()
const mime = MIME_BY_EXT[ext]
if (!mime) { console.error(`不支持的扩展名：${ext}`); process.exit(1) }

const bytes = await readFile(file)
const r = await uploadTempFile(cred.accessToken, { filename: basename(file), bytes, mimeType: mime })

// 只输出 JSON，方便程序解析
console.log(JSON.stringify({
  file,
  filename: basename(file),
  mimeType: mime,
  bytes: r.bytes,
  expiresInSeconds: r.expiresInSeconds,
  tempUrl: r.tempUrl,
}, null, 2))
