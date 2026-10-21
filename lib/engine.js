/**
 * 引擎层：模板仓库（文件系统）+ 图片下载 + Python 渲染器调用。
 *
 * 依赖只有 Node 内建模块 —— 不 import 任何 @deepseek-ai/* 运行时包：
 * 插件与宿主共享同一进程，import 宿主私有包极易因版本/解析路径不同而炸在
 * 加载期（本项目里就有 peer 依赖解析不到的实例）。所有外部能力都走 ctx 服务，
 * 拿不到就降级并告警。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { builtinTemplates, getBuiltinTemplate, normalizeTemplate, clone } from './templates.js'
import { normalizeDeck, lintDeck } from './deck.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SCRIPT_PATH = path.join(HERE, 'python', 'ppt_build.py')
const SENTINEL = '@@PPT_RESULT@@'

// ── 路径解析 ──────────────────────────────────────────────────────────

/** DSH 主目录（存放用户自建模板）。 */
export function resolveHome() {
  const env = process.env.DSH_HOME || process.env.DSH_CONFIG_HOME
  if (env && env.trim()) return { home: path.resolve(env.trim()), source: 'env:DSH_HOME' }
  const fallback = path.join(os.homedir(), '.dsh')
  return { home: fallback, source: `fallback:${fallback}` }
}

export function storeDir() {
  const { home } = resolveHome()
  return path.join(home, 'ppt-master', 'templates')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function slugify(input, fallback = 'deck') {
  const raw = String(input ?? '').trim()
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const trimmed = cleaned.slice(0, 60)
  return trimmed || fallback
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

// ── 模板仓库 ──────────────────────────────────────────────────────────

function userTemplatePath(id) {
  return path.join(storeDir(), `${slugify(id)}.json`)
}

/** 模板总表：内置 + 用户自建（用户同 id 覆盖内置）。 */
export function listTemplates() {
  const items = builtinTemplates().map((t) => ({ ...t, origin: 'builtin' }))
  const dir = storeDir()
  try {
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        if (!file.toLowerCase().endsWith('.json')) continue
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
          const spec = normalizeTemplate(raw)
          const index = items.findIndex((t) => t.id === spec.id)
          const entry = { ...spec, origin: 'user' }
          if (index >= 0) items[index] = entry
          else items.push(entry)
        } catch {
          /* 单个坏文件不影响整表 */
        }
      }
    }
  } catch {
    /* 目录不可读时只返回内置 */
  }
  return items
}

/** 取模板：优先用户自定义，其次内置；也接受直接内联的模板对象。 */
export function getTemplate(ref) {
  if (ref && typeof ref === 'object') return { template: normalizeTemplate(ref), origin: 'inline' }
  const id = String(ref ?? '').trim()
  if (!id) throw new Error('缺少模板 id（用 ppt_templates 的 action="list" 查看全部）')
  const found = listTemplates().find((t) => t.id === id)
  if (!found) {
    const ids = listTemplates().map((t) => t.id)
    throw new Error(`模板 "${id}" 不存在。可用：${ids.join('、')}`)
  }
  return { template: normalizeTemplate(found), origin: found.origin }
}

/** 保存模板（可基于已有模板派生）。 */
export function saveTemplate(input) {
  const base = input?.baseOn ? getTemplate(input.baseOn).template : undefined
  const merged = base ? clone(base) : {}
  for (const key of ['id', 'name', 'description', 'tags', 'aspect', 'theme', 'fonts', 'geometry', 'decor']) {
    if (input?.[key] !== undefined && input[key] !== null && !(typeof input[key] === 'object' && !Array.isArray(input[key]) && !Object.keys(input[key]).length)) {
      merged[key] = input[key]
    }
  }
  if (merged.theme && typeof merged.theme === 'object') merged.theme = { ...(base?.theme ?? {}), ...merged.theme }
  if (merged.geometry && typeof merged.geometry === 'object') merged.geometry = { ...(base?.geometry ?? {}), ...merged.geometry }
  if (merged.decor && typeof merged.decor === 'object') merged.decor = { ...(base?.decor ?? {}), ...merged.decor }
  if (base && !input?.name) merged.name = `${base.name}（派生）`
  if (!merged.id && input?.name) merged.id = slugify(String(input.name), 'custom-template')
  const spec = normalizeTemplate(merged)
  const dir = ensureDir(storeDir())
  const file = userTemplatePath(spec.id)
  const existed = fs.existsSync(file)
  if (existed && input?.overwrite === false) {
    throw new Error(`模板 ${spec.id} 已存在（overwrite=false 时不会覆盖）`)
  }
  fs.writeFileSync(file, JSON.stringify(spec, null, 2), 'utf8')
  return { template: spec, path: file, replaced: existed }
}

export function deleteTemplate(id) {
  const file = userTemplatePath(id)
  if (!fs.existsSync(file)) {
    const builtin = getBuiltinTemplate(id)
    if (builtin) throw new Error(`"${id}" 是内置模板，不能删除；可基于它 save 一个新模板`)
    throw new Error(`用户模板 "${id}" 不存在`)
  }
  fs.unlinkSync(file)
  return { id: String(id), path: file }
}

// ── 图片下载 ──────────────────────────────────────────────────────────

function extFor(contentType) {
  const type = String(contentType || '').toLowerCase()
  if (type.includes('png')) return '.png'
  if (type.includes('webp')) return '.webp'
  if (type.includes('gif')) return '.gif'
  if (type.includes('bmp')) return '.bmp'
  return '.jpg'
}

/** 把 deck 里的图片 URL 下载到本地临时目录，返回 {deck, warnings, downloaded}。 */
export async function materializeImages(deck, dir, signal) {
  const warnings = []
  const downloaded = []
  ensureDir(dir)
  let counter = 0
  const fetchOne = async (url, name) => {
    const target = path.join(dir, `${slugify(name, 'img')}-${++counter}${extFor('')}`)
    const response = await fetch(url, { signal, redirect: 'follow', headers: { 'user-agent': 'dsh-ppt-master/0.1' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const type = response.headers.get('content-type') || ''
    if (!/^image\//i.test(type)) throw new Error(`不是图片（content-type: ${type || '未知'}）`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > 12 * 1024 * 1024) throw new Error('图片超过 12MB')
    if (buffer.byteLength < 512) throw new Error('图片内容过小，可能被拦截')
    const final = target.replace(/\.(jpg|png|webp|gif|bmp)$/i, extFor(type))
    fs.writeFileSync(final, buffer)
    downloaded.push({ url, path: final, bytes: buffer.byteLength })
    return final
  }
  const walk = async (slide, key) => {
    const value = slide?.[key]
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return
    try {
      slide[key] = await fetchOne(value, `${deck.title || 'img'}-${key}`)
    } catch (error) {
      warnings.push(`图片下载失败（${key}: ${value}）：${error.message}`)
      slide[key] = undefined
    }
  }
  for (const slide of deck.slides ?? []) {
    await walk(slide, 'image')
    await walk(slide, 'heroImage')
  }
  if (deck.coverImage) {
    const cover = deck.slides?.[0]
    if (cover && !cover.image) {
      try {
        cover.image = /^https?:\/\//i.test(deck.coverImage) ? await fetchOne(deck.coverImage, 'cover') : deck.coverImage
      } catch (error) {
        warnings.push(`封面图下载失败：${error.message}`)
      }
    }
  }
  return { deck, warnings, downloaded }
}

// ── Python 调用 ───────────────────────────────────────────────────────

/**
 * 宿主自带 Python 运行时的候选位置。
 * 不写死机器路径：从插件自身位置向上找 DSH 安装根（源码布局 <root>/plugins/…，
 * 安装布局 <root>/profiles/desktop/node_modules/…），再按平台拼运行时相对路径；
 * 也兼容 DSH_HOME 指向的 home 目录与 ~/.dsh。找不到就返回空串，退回 PATH。
 */
function bundledPythonCandidate() {
  const subdir = path.join('dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python')
  const names = process.platform === 'win32'
    ? ['python.exe']
    : [path.join('bin', 'python3'), path.join('bin', 'python')]
  const roots = []
  let dir = HERE
  for (let depth = 0; depth < 8; depth += 1) {
    roots.push(dir, path.join(dir, 'home'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  roots.push(path.join(os.homedir(), '.dsh'))
  const seen = new Set()
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, subdir, name)
      if (seen.has(candidate)) continue
      seen.add(candidate)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        /* 无权限/坏路径直接跳过 */
      }
    }
  }
  return ''
}

const DEFAULT_PYTHON = process.env.DSH_PPT_PYTHON || bundledPythonCandidate()

/** 依次尝试的 Python 解释器候选（存在性优先，其次常见命令名）。 */
export function pythonCandidates(extra) {
  const list = []
  if (extra) list.push(extra)
  if (DEFAULT_PYTHON) list.push(DEFAULT_PYTHON)
  for (const name of ['python3', 'python', 'py']) list.push(name)
  const seen = new Set()
  return list.filter((item) => item && !seen.has(item) && seen.add(item))
}

function runProcess(command, args, { timeout = 240000, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...env },
    }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function parseSentinel(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (line.startsWith(SENTINEL)) {
      try {
        return JSON.parse(line.slice(SENTINEL.length))
      } catch {
        return null
      }
    }
  }
  return null
}

/** 体检 Python 环境（供 ppt_doctor 使用）。 */
export async function probePython(custom) {
  const attempts = []
  for (const candidate of pythonCandidates(custom)) {
    const { error, stdout, stderr } = await runProcess(candidate, ['-X', 'utf8', SCRIPT_PATH, '--probe'], { timeout: 60000 })
    if (!error) {
      const payload = parseSentinel(stdout)
      if (payload) return { ...payload, interpreter: candidate, attempts }
    }
    attempts.push({ candidate, error: error ? String(error.message || error) : '无输出', stderr: stderr.slice(-500) })
  }
  return { ok: false, error: '没有可用的 Python 解释器', attempts }
}

/** 调用渲染器；返回 {ok, payload, log}。 */
export async function runRender(spec, { customPython, timeout = 240000 } = {}) {
  const attempts = []
  for (const candidate of pythonCandidates(customPython)) {
    const { error, stdout, stderr } = await runProcess(candidate, ['-X', 'utf8', SCRIPT_PATH, spec.specPath], { timeout })
    const payload = parseSentinel(stdout)
    const log = [stderr.trim(), stdout.split(SENTINEL)[0].trim()].filter(Boolean).join('\n').slice(-2000)
    if (payload) {
      return { ok: Boolean(payload.ok), payload, log, interpreter: candidate }
    }
    attempts.push({ candidate, error: error ? String(error.message || error) : '未解析到结果', log })
  }
  return { ok: false, payload: { ok: false, error: '渲染器未能启动（Python 不可用或脚本异常）', attempts }, log: '' }
}

// ── 构建主流程（tools.js 调用） ───────────────────────────────────────

function tempDir() {
  const dir = path.join(os.tmpdir(), `dsh-ppt-master-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  return ensureDir(dir)
}

/**
 * 生成 PPTX。args:
 *   deck | deckPath | slides, template | templateSpec, out | outDir, fileName,
 *   preview(默认 true), previewGrid, python, keepTemp, dryRun
 */
export async function buildPresentation(args = {}, ctx = {}, signal) {
  const warnings = []
  let rawDeck = args.deck
  if (!rawDeck && args.deckPath) {
    const file = path.resolve(String(args.deckPath))
    if (!fs.existsSync(file)) throw new Error(`deckPath 不存在：${file}`)
    rawDeck = JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  if (!rawDeck && args.slides) rawDeck = { ...args, slides: args.slides }
  if (!rawDeck) throw new Error('缺少 deck（或 deckPath / slides）')
  if (!rawDeck.title && args.title) rawDeck = { ...rawDeck, title: args.title }
  if (!rawDeck.subtitle && args.subtitle) rawDeck = { ...rawDeck, subtitle: args.subtitle }

  const { deck, warnings: deckWarnings } = normalizeDeck(rawDeck)
  warnings.push(...deckWarnings)
  const templateRef = args.templateSpec ?? args.template ?? templateArgFromDeck(rawDeck)
  const { template, origin } = getTemplate(templateRef)

  const baseDir = args.outDir ? path.resolve(String(args.outDir)) : (args.out ? path.dirname(path.resolve(String(args.out))) : process.cwd())
  ensureDir(baseDir)
  const fileName = args.fileName
    ? String(args.fileName)
    : `${slugify(deck.title || template.id)}-${stamp()}`
  const outPath = args.out
    ? path.resolve(String(args.out))
    : path.join(baseDir, fileName.toLowerCase().endsWith('.pptx') ? fileName : `${fileName}.pptx`)
  ensureDir(path.dirname(outPath))
  const previewPath = args.preview === false ? undefined : (args.previewPath || outPath.replace(/\.pptx$/i, '.preview.png'))

  const workDir = tempDir()
  const { deck: deckWithLocalImages, warnings: imageWarnings } = await materializeImages(deck, path.join(workDir, 'images'), signal)
  warnings.push(...imageWarnings)

  const spec = {
    template,
    deck: deckWithLocalImages,
    out: outPath,
    preview: previewPath,
    previewGrid: Number(args.previewGrid ?? 3),
    previewWidth: Number(args.previewWidth ?? 620),
  }
  const specPath = path.join(workDir, 'spec.json')
  fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8')

  const lint = lintDeck(deckWithLocalImages)
  const result = {
    ok: false,
    template: template.id,
    templateName: template.name,
    templateOrigin: origin,
    out: outPath,
    preview: previewPath,
    slides: deckWithLocalImages.slides.length,
    layouts: deckWithLocalImages.slides.map((s) => s.layout),
    lint,
    warnings,
    workDir,
  }

  if (args.dryRun) {
    result.ok = true
    result.dryRun = true
    result.note = 'dryRun：只做归一化与审校，未调用渲染器。'
    if (!args.keepTemp) cleanup(workDir)
    return result
  }

  const render = await runRender({ specPath, out: outPath }, { customPython: args.python })
  result.python = render.interpreter ?? null
  if (render.payload?.warnings?.length) warnings.push(...render.payload.warnings)
  if (!render.ok) {
    result.ok = false
    result.error = render.payload?.error || '渲染失败'
    result.trace = render.payload?.trace ? String(render.payload.trace).slice(-1500) : undefined
    result.attempts = render.payload?.attempts
    result.log = render.log
    if (!args.keepTemp) cleanup(workDir)
    return result
  }
  result.ok = true
  result.bytes = render.payload.bytes
  result.pythonPptx = render.payload.pythonPptx
  if (render.payload.preview) result.preview = render.payload.preview
  result.log = render.log || undefined
  if (!args.keepTemp) cleanup(workDir)
  return result
}

function templateArgFromDeck(deck) {
  return deck?.template ?? deck?.templateId ?? 'indigo-corporate'
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结果 */
  }
}

// ── 联网取材 ──────────────────────────────────────────────────────────

const KIND_SUFFIX = {
  facts: '',
  images: ' 高清图片',
  palette: ' 配色方案 color palette',
  inspiration: ' 演示文稿 设计 参考',
}

/** 关键词 → 建议色板（确定性映射，避免编造"搜索结果里的配色"）。 */
const KEYWORD_PALETTES = [
  { keys: ['科技', 'ai', '人工智能', '芯片', '算法', '云', 'tech'], palette: ['#05070F', '#31E1F7', '#7C6BFF', '#EAF6FF'] },
  { keys: ['金融', '银行', '投资', '保险', '财报', 'finance'], palette: ['#0A0F22', '#5B7CFA', '#FFC53D', '#F5F7FF'] },
  { keys: ['医疗', '健康', '生物', '医院', '药'], palette: ['#F6FBFC', '#0E7490', '#34D399', '#0F172A'] },
  { keys: ['教育', '培训', '校园', '学习', '课程'], palette: ['#FDF7F0', '#D2694A', '#1F5C4D', '#2C211B'] },
  { keys: ['环保', '能源', '双碳', '可持续', '绿色', 'esg'], palette: ['#F2F7F3', '#3E6B5A', '#B23A48', '#1C2B25'] },
  { keys: ['政府', '政务', '公共', '政策', '报告'], palette: ['#FFFFFF', '#1D4ED8', '#C0392B', '#0F172A'] },
  { keys: ['消费', '零售', '品牌', '市场', '营销'], palette: ['#FDF7F0', '#D2694A', '#E79A76', '#2C211B'] },
  { keys: ['汽车', '制造', '工业', '供应链', '物流'], palette: ['#0B1020', '#3B82F6', '#F59E0B', '#F8FAFC'] },
  { keys: ['文化', '国潮', '东方', '艺术', '设计'], palette: ['#F2F7F3', '#3E6B5A', '#B23A48', '#1C2B25'] },
  { keys: ['儿童', '亲子', '游戏', '娱乐'], palette: ['#FFF8F0', '#FF7A59', '#4C6EF5', '#241C15'] },
]

const KIND_QUERIES = {
  facts: (query) => [query, `${query} 数据 统计 报告`],
  images: (query) => [`${query} 高清图片`, `${query} 视觉素材`],
  palette: (query) => [`${query} 配色方案`, `${query} color palette inspiration`],
  inspiration: (query) => [`${query} ppt 设计`, `${query} 演示 模板 灵感`],
}

function suggestPalettes(query) {
  const text = String(query || '').toLowerCase()
  const hit = KEYWORD_PALETTES.filter((item) => item.keys.some((key) => text.includes(key)))
  const picks = hit.length ? hit : []
  return picks.slice(0, 3).map((item) => ({
    keywords: item.keys.slice(0, 3),
    colors: item.palette,
    howTo: `主题色 ${item.palette[1]}，点缀 ${item.palette[2]}，底色 ${item.palette[0]}`,
  }))
}

const OG_IMAGE_RE = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i
const TITLE_RE = /<title[^>]*>([\s\S]{0,180}?)<\/title>/i

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

/** 粗抽正文：去脚本/样式/标签，压空白，给模型一段可读摘要。 */
function extractText(html, limit = 600) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

/**
 * 联网取材：搜索来源 + 图片候选 + 配色建议。两条路径互相独立：
 *   A. urls 直抓 —— 不依赖搜索能力（本机没配搜索密钥时唯一的取材途径）；
 *   B. query 搜索 —— 走宿主 web 服务的搜索提供方。
 */
export async function research(ctx, args = {}, signal) {
  const kind = String(args.kind ?? 'facts').toLowerCase()
  const query = String(args.query ?? '').trim()
  const explicitUrls = asStringArray(args.urls).slice(0, 8)
  const notes = []
  const sources = []
  const images = []
  if (!query && !explicitUrls.length) throw new Error('缺少 query（也可以给 urls 直接抓取指定页面）')

  const web = ctx?.get ? ctx.get('web') : undefined
  const canFetch = Boolean(web && typeof web.fetch === 'function')
  const canSearch = Boolean(web && typeof web.search === 'function')
  const palettes = kind === 'palette' || args.wantPalette ? suggestPalettes(query || explicitUrls.join(' ')) : []
  if (!canFetch && !canSearch) {
    notes.push('未取到 web 服务（网络能力不可用），本次结果为空。')
    return { ok: false, query, kind, sources, images, palettes, notes }
  }

  // 路径 A：直接抓取指定链接（含 og:image 与正文摘要）
  const fetchedPages = []
  for (const url of explicitUrls) {
    if (!canFetch) {
      notes.push('web.fetch 不可用，无法直抓 urls')
      break
    }
    try {
      const page = await web.fetch({ url }, signal)
      const html = page?.body?.content || ''
      const title = (html.match(TITLE_RE)?.[1] || '').trim()
      const og = html.match(OG_IMAGE_RE)?.[1]
      if (og) images.push({ url: og.replace(/&amp;/g, '&'), page: url, title: title.slice(0, 120) })
      sources.push({ title: title || url, url, snippet: extractText(html, 700), publishedAt: '' })
      fetchedPages.push(url)
    } catch (error) {
      notes.push(`抓取 ${url} 失败：${error?.message || error}`)
    }
  }

  // 路径 B：搜索
  if (query && canSearch) {
    const queries = KIND_QUERIES[kind] ? KIND_QUERIES[kind](query) : [query]
    const limit = Math.max(1, Math.min(12, Number(args.maxResults ?? 6)))
    for (const one of queries) {
      try {
        const result = await web.search({ query: one, maxResults: limit }, signal)
        if (result?.content) notes.push(`[${one}] ${String(result.content).slice(0, 900)}`)
        for (const source of result?.sources ?? []) {
          if (!source?.url) continue
          if (!sources.some((s) => s.url === source.url)) {
            sources.push({ title: source.title || source.url, url: source.url, snippet: source.snippet || '', publishedAt: source.publishedAt || '' })
          }
        }
      } catch (error) {
        const message = String(error?.message || error)
        notes.push(`搜索「${one}」失败：${message}`)
        if (/no API key|API_KEY/i.test(message)) {
          notes.push('搜索提供方没有密钥：可在「设置→模型」里配置搜索密钥；也可以把已知链接用 urls 参数直接抓取（本工具已支持，不依赖搜索）。')
        }
      }
    }
  } else if (query && !canSearch) {
    notes.push('web.search 不可用：改用 urls 参数直接抓取指定页面。')
  }

  // 配图补抓：对搜索到的来源抓 og:image（kind=images 或 wantImages 时）
  const wantImages = kind === 'images' || args.wantImages === true
  if (wantImages && canFetch && sources.length) {
    const top = sources.slice(0, Math.max(1, Math.min(6, Number(args.fetchTop ?? 4)))).filter((s) => !fetchedPages.includes(s.url))
    for (const source of top) {
      try {
        const page = await web.fetch({ url: source.url }, signal)
        const html = page?.body?.content || ''
        const og = html.match(OG_IMAGE_RE)?.[1]
        const title = (html.match(TITLE_RE)?.[1] || '').trim()
        if (og) images.push({ url: og.replace(/&amp;/g, '&'), page: source.url, title: (title || source.title || '').slice(0, 120) })
      } catch (error) {
        notes.push(`抓取 ${source.url} 失败：${error?.message || error}`)
      }
    }
    if (!images.length) notes.push('没有解析到 og:image；可让用户直接给图片链接，或到图库站自行取图。')
  }

  return {
    ok: sources.length > 0 || images.length > 0,
    query,
    kind,
    sources: sources.slice(0, 16),
    images: images.slice(0, 12),
    palettes,
    notes,
  }
}
