#!/usr/bin/env node
/**
 * 批量出图工具 —— 基于 OpenAI 兼容 Images API
 *
 * 用法:
 *   node batch.mjs
 *   node batch.mjs --config config.json --prompts prompts.txt --out output --concurrency 3
 *
 * 功能:
 *   - 读 txt 提示词(每行一条, # 开头为注释, 空行跳过)
 *   - 支持参考图(图生图): 行内用 Tab 分隔, 左边是参考图路径, 右边是提示词
 *     例: ref.png<TAB>把这张图改成红色车身; 多图用 | 分隔: a.png|b.png<TAB>提示词
 *   - 调用 POST {baseUrl}/images/generations 批量出图
 *   - 并发控制 / 超时 / 失败自动重试
 *   - 断点续传: 输出目录里已有文件的任务自动跳过
 *   - 结果记录到 manifest.txt, 失败列表写入 failed.txt
 *
 * 配置优先级: 默认值 < config.json < 命令行参数
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { out[key] = next; i++ }
    else out[key] = true
  }
  return out
}

function slugify(s, max = 30) {
  const cleaned = String(s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+$/, '')
    .slice(0, max)
  return cleaned || 'img'
}

// 根据 base64 魔数判断图片扩展名
function detectExt(b64) {
  if (/^\/9j/.test(b64)) return 'jpg'
  if (/^iVBOR/.test(b64)) return 'png'
  if (/^R0lGOD/.test(b64)) return 'gif'
  if (/^UklGR/.test(b64)) return 'webp'
  return 'png'
}

// 剥离可能存在的 data URL 前缀。部分中转接口会把 b64_json 返回成完整的
// "data:image/png;base64,....", 若不剥离直接 Buffer.from(x,'base64') 解码,
// 前缀字符也会被当作 base64 数据, 导致真正的图片数据整体错位、文件损坏。
function stripDataUrl(s) {
  const m = /^\s*data:([^;,]*)(?:;[^,]*)*,/i.exec(s)
  if (!m) return { b64: String(s).trim(), ext: null }
  const extMap = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  }
  return { b64: s.slice(m[0].length).trim(), ext: extMap[m[1].toLowerCase()] || null }
}

// 用二进制魔数校验解码结果是不是真正的图片, 避免把损坏/非图片内容静默写盘
function isValidImage(buf) {
  if (!buf || buf.length < 12) return false
  const b = buf
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true                  // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true                  // GIF
  if (b[0] === 0x42 && b[1] === 0x4d) return true                                   // BMP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true // WEBP
  return false
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// 简单并发池: 同时最多 limit 个 worker
function runPool(items, limit, worker) {
  return new Promise((resolve) => {
    const results = []
    let idx = 0
    let active = 0
    const next = () => {
      if (idx >= items.length && active === 0) return resolve(results)
      while (active < limit && idx < items.length) {
        const item = items[idx++]
        active++
        worker(item).then((r) => results.push(r)).catch(() => {}).finally(() => {
          active--
          next()
        })
      }
    }
    next()
  })
}

// ---------------------------------------------------------------------------
// 配置加载
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  // 中转站/官方接口 base url, 通常以 /v1 结尾。留空则必须由 config.json 提供。
  baseUrl: '',

  // API Key。**强烈建议留空**, 改用环境变量 API_KEY, 避免密钥写进文件被误提交。
  apiKey: '',

  model: 'gpt-image-1',                  // 模型名, 按你的接口支持填
  size: '',                              // 尺寸, 如 1024x1024 / 1024x1536; 留空用接口默认
  quality: '',                           // low / medium / high / auto(留空)
  imagesPerPrompt: 1,                    // 每条提示词出几张
  responseFormat: 'b64_json',            // b64_json 或 url
  timeoutMs: 240000,
  retries: 2,
  retryDelayMs: 3000,
  concurrency: 2,
  delayMs: 500,                          // 每张成功后的间隔, 防限流
  outputDir: 'output',
  extraHeaders: {},                      // 额外请求头
  extraBody: {},                         // 额外请求体字段(合并进 body)
}

const args = parseArgs(process.argv.slice(2))
const configPath = args.config || 'config.json'

let config = { ...DEFAULT_CONFIG }
if (existsSync(configPath)) {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath, 'utf8')) }
  } catch (e) {
    console.error(`✗ 读取配置文件 ${configPath} 失败: ${e.message}`)
    process.exit(1)
  }
}
if (process.env.API_KEY) config.apiKey = process.env.API_KEY
if (process.env.API_BASE_URL) config.baseUrl = process.env.API_BASE_URL

// 命令行参数覆盖
if (args.prompts) config.promptsFile = args.prompts
if (args.out) config.outputDir = args.out
if (args.concurrency) config.concurrency = Number(args.concurrency)
if (args.model) config.model = args.model
if (args.size) config.size = args.size
if (args['api-key']) config.apiKey = args['api-key']

// ---------------------------------------------------------------------------
// 读取提示词
//   每行一条。支持两种格式:
//   1. 纯文本:            提示词内容
//   2. 带参考图:          参考图路径<TAB>提示词内容
//      - 多个参考图用 | 分隔, 例如: ref1.png|ref2.png<TAB>提示词
//      - 路径相对于脚本运行目录
//      - 遮罩(只改遮罩区域, 其余像素保持原图): 在参考图段加 mask=xxx.png
//        例: ref.png|mask=masks/ref_mask.png<TAB>只把车窗外换成...
//        带 mask 时只会走 /images/edits(multipart), 不会降级到不支持遮罩的策略
// ---------------------------------------------------------------------------
function loadPrompts(file) {
  const raw = readFileSync(file, 'utf8')
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const idx = line.indexOf('\t')
      if (idx === -1) return { prompt: line, refImages: [], mask: null }
      const refPart = line.slice(0, idx).trim()
      const prompt = line.slice(idx + 1).trim()
      if (!prompt || !refPart) return { prompt: line, refImages: [], mask: null }
      const refImages = []
      let mask = null
      for (const token of refPart.split('|').map((p) => p.trim()).filter(Boolean)) {
        if (/^mask=/i.test(token)) mask = token.slice(5).trim()
        else refImages.push(token)
      }
      return { prompt, refImages, mask }
    })
    .filter((t) => t.prompt)
}

// 参考图路径 -> base64 data URL (OpenAI 兼容接口要求的格式)
const MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

function toDataUrl(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  const mime = MIME_TYPES[ext] || 'image/png'
  const buf = readFileSync(filePath)
  if (buf.length === 0) throw new Error(`参考图为空: ${filePath}`)
  return `data:${mime};base64,${buf.toString('base64')}`
}

// ---------------------------------------------------------------------------
// API 调用与保存
//
// 兼容性说明(重要 —— 这是本工具最核心的适配逻辑):
//
//   很多中转站(one-api / new-api / API2D 等)是"多通道负载均衡", 同一个请求体
//   打到不同上游通道上表现不同:
//     · 部分通道在 /images/generations 上接受 image 参数(内部自动转成 edits)
//     · 部分通道直接 400 unknown_parameter: 'image'
//     · 部分通道不接受 response_format(某些模型本身就固定返回 b64_json)
//
//   典型症状: 同一提示词, 这条成功、那条一直 400 —— 不是缓存问题, 是通道差异。
//   靠改提示词或调参考图顺序去"碰运气"是无效的。
//
//   因此这里为每个任务准备多条"请求策略", 按兼容性从低到高逐条降级,
//   哪条被通道接受就用哪条。非参数类错误(网络/超时/5xx)不降级, 交给外层重试。
//
//   若你的接口稳定, 用不到降级——第一条策略就会直接成功, 无额外开销。
// ---------------------------------------------------------------------------
const STRATEGY_BLOCK_THRESHOLD = 4      // 某策略连续被拒 N 次后, 本进程内不再尝试
const strategyFails = new Map()         // id -> 连续失败次数

function normalizeSize(v) {
  // 清洗尺寸格式: "906 × 1737" / "906x1737" / "906X1737" / "906 x 1737" 统一为 "906x1737"
  if (!v) return ''
  return String(v).replace(/[×xX]/g, 'x').replace(/\s+/g, '')
}

// 为一条任务生成候选请求策略(按顺序尝试)
// 带 mask 时只保留 edits 策略: 遮蔽式改图必须走 multipart, 且不能降级成"无遮罩重绘",
// 否则就违背"不改原图"的要求, 宁可重试。
function buildStrategies(cfg, prompt, refDataUrls, maskDataUrl = null) {
  const base = { model: cfg.model, prompt, n: cfg.imagesPerPrompt || 1 }
  const size = normalizeSize(cfg.size)
  if (size) base.size = size
  if (cfg.quality) base.quality = cfg.quality
  Object.assign(base, cfg.extraBody || {})

  if (maskDataUrl) {
    return [{ id: 'edits+mask', kind: 'edits', fields: base, images: refDataUrls, mask: maskDataUrl }]
  }

  const imageField = refDataUrls.length === 0
    ? null
    : (refDataUrls.length === 1 ? { image: refDataUrls[0] } : { image: refDataUrls })

  const list = [
    // A. generations: image + response_format(能接受的通道兼容性最广)
    {
      id: 'gen+image+response_format',
      kind: 'generations',
      body: { ...base, response_format: cfg.responseFormat || 'b64_json', ...(imageField || {}) },
    },
  ]
  if (refDataUrls.length > 0) {
    // B. generations: 带 image, 去掉 response_format
    list.push({ id: 'gen+image', kind: 'generations', body: { ...base, ...imageField } })
    // C. 官方图生图端点 /images/edits(multipart 表单): 兼容性最好, 作为最终兜底
    list.push({ id: 'edits', kind: 'edits', fields: base, images: refDataUrls })
  } else {
    // 纯文生图: 补一条不带 response_format 的兜底
    list.push({ id: 'gen', kind: 'generations', body: { ...base } })
  }
  return list
}

// 把 data URL 还原成二进制 + mime, 供 multipart 上传
function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]*)(?:;base64)?,(.*)$/s.exec(dataUrl)
  if (!m) return { buf: Buffer.from(dataUrl, 'base64'), mime: 'image/png', ext: 'png' }
  const mime = m[1] || 'image/png'
  const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg')
  return { buf: Buffer.from(m[2], 'base64'), mime, ext }
}

function resolveEndpoint(baseUrl, kind) {
  let endpoint = baseUrl.replace(/\/+$/, '')
  if (/images\/(generations|edits)$/.test(endpoint)) {
    if (kind === 'edits') endpoint = endpoint.replace(/\/generations$/, '/edits')
    return endpoint
  }
  return endpoint + (kind === 'edits' ? '/images/edits' : '/images/generations')
}

// 参数类错误 -> 说明该策略不被通道支持, 可以降级
function isParamError(msg) {
  return /unknown_parameter|Unknown parameter|unsupported_?parameter|Unsupported parameter|not supported|unsupported_value|invalid_request_error/i.test(String(msg))
}

async function callStrategy(cfg, s) {
  const endpoint = resolveEndpoint(cfg.baseUrl, s.kind)
  let res
  if (s.kind === 'edits') {
    // 官方 /images/edits: multipart/form-data, 图片字段为 image(单) 或 image[](多)
    const fd = new FormData()
    for (const [k, v] of Object.entries(s.fields)) {
      if (v === undefined || v === null || v === '') continue
      fd.append(k, String(v))
    }
    s.images.forEach((dataUrl, i) => {
      const { buf, mime, ext } = decodeDataUrl(dataUrl)
      const key = s.images.length > 1 ? 'image[]' : 'image'
      fd.append(key, new Blob([buf], { type: mime }), `ref${i + 1}.${ext}`)
    })
    if (s.mask) {
      // 遮罩: 透明处可编辑、不透明处保留原像素
      const { buf, mime } = decodeDataUrl(s.mask)
      fd.append('mask', new Blob([buf], { type: mime || 'image/png' }), 'mask.png')
    }
    res = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(cfg.extraHeaders || {}) },
        body: fd,
      },
      cfg.timeoutMs,
    )
  } else {
    res = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
          ...(cfg.extraHeaders || {}),
        },
        body: JSON.stringify(s.body),
      },
      cfg.timeoutMs,
    )
  }

  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 500) } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}: ${detail}`)
  }

  const json = await res.json()
  const data = json?.data
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`响应中无 data: ${JSON.stringify(json).slice(0, 300)}`)
  }
  return data
}

async function generateImage(cfg, prompt, refImages = [], maskDataUrl = null) {
  const strategies = buildStrategies(cfg, prompt, refImages, maskDataUrl)
    .filter((s) => (strategyFails.get(s.id) || 0) < STRATEGY_BLOCK_THRESHOLD)

  let lastErr
  let skipped = 0
  for (const s of strategies) {
    try {
      const data = await callStrategy(cfg, s)
      strategyFails.delete(s.id)
      if (skipped > 0) console.log(`  · 通道拒绝了前 ${skipped} 条策略, 已用 [${s.id}] 出图`)
      return data
    } catch (e) {
      lastErr = e
      if (isParamError(e.message)) {
        const n = (strategyFails.get(s.id) || 0) + 1
        strategyFails.set(s.id, n)
        if (strategies.length > 1) {
          skipped++
          console.log(`  · 策略 [${s.id}] 被通道拒绝, 降级重试`)
          continue          // 换下一条策略
        }
      }
      throw e               // 网络/超时/5xx 等: 抛给外层重试
    }
  }
  throw lastErr
}

async function downloadBinary(url, timeoutMs) {
  const res = await fetchWithTimeout(url, {}, timeoutMs)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error('下载内容为空')
  return buf
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  if (!config.baseUrl) {
    console.error('✗ 未配置 baseUrl。请复制 config.example.json 为 config.json 并填入接口地址,')
    console.error('  或设置环境变量 API_BASE_URL。例如: https://api.example.com/v1')
    process.exit(1)
  }
  if (!config.apiKey) {
    console.error('✗ 未配置 apiKey。推荐设置环境变量 API_KEY, 或写进 config.json。')
    process.exit(1)
  }

  const promptsFile = config.promptsFile || args.prompts || 'prompts.txt'
  if (!existsSync(promptsFile)) {
    console.error(`✗ 找不到提示词文件: ${promptsFile}`)
    process.exit(1)
  }
  const prompts = loadPrompts(promptsFile)
  if (prompts.length === 0) {
    console.error(`✗ 提示词文件 ${promptsFile} 中没有有效内容`)
    process.exit(1)
  }

  const outDir = path.resolve(config.outputDir)
  mkdirSync(outDir, { recursive: true })

  // 断点续传: 已存在的序号跳过
  const doneSet = new Set()
  for (const f of readdirSync(outDir)) {
    const m = f.match(/^(\d{3,})_/)
    if (m) doneSet.add(Number(m[1]))
  }

  const allTasks = prompts.map((p, i) => ({
    seq: i + 1,
    prompt: p.prompt,
    refImages: p.refImages || [],
    mask: p.mask || null,
  }))
  const todo = allTasks.filter((t) => !doneSet.has(t.seq))
  const skipped = allTasks.length - todo.length

  console.log(`共 ${allTasks.length} 条提示词 | 待生成 ${todo.length} | 已完成跳过 ${skipped}`)
  if (todo.length === 0) {
    console.log('没有需要生成的任务, 退出。')
    return
  }
  console.log(`接口: ${config.baseUrl} | 模型: ${config.model} | 尺寸: ${config.size || '默认'} | 并发: ${config.concurrency}`)
  console.log('-'.repeat(60))

  const logLines = [`# ${new Date().toISOString()}  共${allTasks.length} 成功待统计 失败待统计 跳过${skipped}`]

  const results = await runPool(todo, config.concurrency, async (task) => {
    const { seq, prompt, refImages = [], mask } = task
    const slug = slugify(prompt)
    const imgTag = refImages.length > 0 ? `[图${refImages.length}${mask ? '+罩' : ''}] ` : ''
    let lastErr

    for (let attempt = 0; attempt <= config.retries; attempt++) {
      if (attempt > 0) await sleep(config.retryDelayMs)
      try {
        const started = Date.now()
        // 参考图在每次尝试时读取(文件可能较大, 失败重试也重新读)
        const refDataUrls = refImages.map((p) => {
          const abs = path.resolve(p)
          if (!existsSync(abs)) throw new Error(`参考图不存在: ${p}`)
          return toDataUrl(abs)
        })
        let maskDataUrl = null
        if (mask) {
          const abs = path.resolve(mask)
          if (!existsSync(abs)) throw new Error(`遮罩不存在: ${mask}`)
          maskDataUrl = toDataUrl(abs)
        }
        const items = await generateImage(config, prompt, refDataUrls, maskDataUrl)
        const saved = []

        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          let buf, ext
          if (item.b64_json) {
            // 有些中转接口会把 b64_json 返回成完整 data URL, 需先剥离前缀再解码, 否则图片错位损坏
            const { b64, ext: urlExt } = stripDataUrl(item.b64_json)
            ext = urlExt || detectExt(b64)
            buf = Buffer.from(b64, 'base64')
          } else if (item.url) {
            buf = await downloadBinary(item.url, config.timeoutMs)
            ext = 'png'
          } else {
            throw new Error(`任务返回了无法识别的数据: ${JSON.stringify(item).slice(0, 200)}`)
          }
          if (buf.length === 0) throw new Error('返回的图片内容为空')
          // 兜底校验: 解码后必须是真正的图片, 否则抛错触发重试/失败, 避免把损坏内容静默写盘
          if (!isValidImage(buf)) {
            throw new Error(`解码结果不是有效图片(前8字节 ${buf.subarray(0, 8).toString('hex')}), 接口可能返回了异常数据`)
          }

          const multi = items.length > 1 ? `_${i + 1}` : ''
          const filename = `${String(seq).padStart(3, '0')}_${slug}${multi}.${ext}`
          writeFileSync(path.join(outDir, filename), buf)
          saved.push(filename)
        }

        const secs = ((Date.now() - started) / 1000).toFixed(1)
        console.log(`  ✓ [${seq}/${allTasks.length}] ${imgTag}${saved.join(', ')} (${secs}s)`)
        const refPart = refImages.length > 0 ? `${refImages.join('|')}\t` : ''
        logLines.push(`OK\t${seq}\t${saved.join(', ')}\t${refPart}${prompt.replace(/\t/g, ' ')}`)

        if (config.delayMs > 0) await sleep(config.delayMs)
        return { seq, ok: true, files: saved }
      } catch (e) {
        lastErr = e
        if (attempt < config.retries) {
          console.log(`  ⚠ [${seq}] 第 ${attempt + 1} 次失败(${e.message.slice(0, 100)}), 稍后重试...`)
        }
      }
    }

    console.log(`  ✗ [${seq}] ${imgTag}失败: ${String(lastErr.message || lastErr).slice(0, 160)}`)
    logLines.push(`FAIL\t${seq}\t${String(lastErr.message || lastErr).replace(/\t/g, ' ')}\t${refImages.join('|')}\t${prompt.replace(/\t/g, ' ')}`)
    return { seq, ok: false, error: String(lastErr.message || lastErr) }
  })

  const okCount = results.filter((r) => r.ok).length
  const failCount = results.length - okCount

  // 写入 manifest 和 failed.txt
  writeFileSync(path.join(outDir, 'manifest.txt'), logLines.join('\n'), 'utf8')
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    writeFileSync(
      path.join(outDir, 'failed.txt'),
      failed.map((r) => `${r.seq}\t${r.error}`).join('\n'),
      'utf8',
    )
  }

  console.log('-'.repeat(60))
  console.log(`完成! 成功 ${okCount} | 失败 ${failCount} | 跳过 ${skipped} | 输出目录: ${outDir}`)
  console.log(`明细: ${path.join(outDir, 'manifest.txt')}`)
  if (failed.length) console.log(`失败任务序号见: ${path.join(outDir, 'failed.txt')} (可直接重跑脚本自动续传)`)

  if (failCount > 0) process.exitCode = 1
}

// 仅在被直接运行时执行主流程; 被 import 时(如测试)只导出工具函数
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`✗ 运行出错: ${e.stack || e.message}`)
    process.exit(1)
  })
}

export { slugify, detectExt, stripDataUrl, isValidImage }
