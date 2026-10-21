/**
 * Deck 归一化 + 设计审校（纯函数，无 IO）。
 *
 * 这一层是「PPT 大师」的质量闸门：在渲染之前先把数据的形状、版式的可用性、
 * 以及大师规范（一页一个观点、要点不超 5 条、数字进图表、每页有讲稿…）
 * 全部检查一遍，让模型拿到的是「问题清单 + 具体改法」，而不是一张丑图。
 */

import { LAYOUT_NAMES } from './templates.js'

const LAYOUT_ALIASES = {
  title: 'cover',
  toc: 'agenda',
  contents: 'agenda',
  outline: 'agenda',
  'agenda-page': 'agenda',
  list: 'bullets',
  'two-columns': 'two-col',
  columns: 'two-col',
  grid: 'cards',
  stats: 'kpi',
  metrics: 'kpi',
  roadmap: 'timeline',
  steps: 'process',
  flow: 'process',
  photo: 'image',
  picture: 'image',
  'full-bleed': 'image',
  thanks: 'end',
  closing: 'end',
  vs: 'compare',
  data: 'chart',
  quote_slide: 'quote',
  'quote-slide': 'quote',
  quadrant: 'matrix',
  quadrants: 'matrix',
  '2x2': 'matrix',
}

/** 把用户/模型的松写法收敛到渲染器认识的版式名。 */
export function resolveLayout(slide) {
  const raw = String(slide?.layout ?? '').trim().toLowerCase()
  if (LAYOUT_NAMES.includes(raw)) return raw
  if (LAYOUT_ALIASES[raw]) return LAYOUT_ALIASES[raw]
  for (const key of ['kpi', 'chart', 'table', 'steps', 'cards', 'quote', 'image', 'columns', 'agenda', 'matrix', 'quadrants']) {
    if (slide?.[key]) {
      if (key === 'steps') return 'process'
      if (key === 'columns') return 'two-col'
      if (key === 'matrix' || key === 'quadrants') return 'matrix'
      return key
    }
  }
  return 'bullets'
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  return [value]
}

function asText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function normalizeBullets(items) {
  return asArray(items)
    .map((item) => {
      if (item === null || item === undefined) return null
      if (typeof item === 'string' || typeof item === 'number') return { text: asText(item), level: 0 }
      if (typeof item === 'object') {
        return {
          text: asText(item.text ?? item.title ?? item.value ?? item.label),
          level: Math.max(0, Math.min(2, Number(item.level ?? 0) || 0)),
          bold: Boolean(item.bold),
          em: Boolean(item.em ?? item.emphasis),
          ...(item.color ? { color: asText(item.color) } : {}),
        }
      }
      return null
    })
    .filter((item) => item && item.text)
}

/** 议程条目：字符串收敛成 {title}，对象保留 title/desc/page。 */
function normalizeAgenda(items) {
  return asArray(items)
    .map((item) => {
      if (item === null || item === undefined) return null
      if (typeof item === 'string' || typeof item === 'number') return { title: asText(item), desc: '', page: '' }
      if (typeof item === 'object') {
        const title = asText(item.title ?? item.text ?? item.name ?? item.label)
        if (!title) return null
        return {
          title,
          desc: asText(item.desc ?? item.description ?? item.note),
          page: asText(item.page ?? item.number ?? item.index),
        }
      }
      return null
    })
    .filter(Boolean)
    .slice(0, 8)
}

/** 2×2 象限：每象限 = {title, items[]}；兼容数组直给与 {quadrants} 包裹。 */
function normalizeQuadrants(input) {
  const raw = Array.isArray(input) ? input : asArray(input?.quadrants)
  return raw
    .slice(0, 4)
    .map((quadrant) => ({
      title: asText(quadrant?.title ?? quadrant?.label ?? quadrant?.name),
      items: normalizeBullets(quadrant?.items ?? quadrant?.bullets ?? quadrant?.points),
      ...(quadrant?.color ? { color: asText(quadrant.color) } : {}),
    }))
}

/** 散点：points 接受 [{x,y}] 或 [[x,y]]，非法点丢弃。 */
function normalizePoints(input) {
  return asArray(input)
    .map((point) => {
      if (Array.isArray(point)) return { x: Number(point[0]), y: Number(point[1]) }
      if (point && typeof point === 'object') return { x: Number(point.x ?? point[0]), y: Number(point.y ?? point[1]) }
      return null
    })
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
}

/** 归一化 deck：形状收敛 + 版式解析 + 缺字段补齐；返回 {deck, warnings}。 */
export function normalizeDeck(input) {
  const warnings = []
  const source = input && typeof input === 'object' ? input : {}
  const deck = {
    title: asText(source.title) || '演示文稿',
    subtitle: asText(source.subtitle),
    author: asText(source.author),
    date: asText(source.date),
    footer: asText(source.footer) || asText(source.author) || asText(source.title),
    chrome: source.chrome !== false,
    slides: [],
  }
  const slides = asArray(source.slides)
  if (!slides.length) {
    warnings.push('deck.slides 为空，已放入一页占位封面')
    deck.slides.push({ layout: 'cover', title: deck.title, subtitle: deck.subtitle })
    return { deck, warnings }
  }
  slides.slice(0, 120).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      warnings.push(`第 ${index + 1} 页不是对象，已跳过`)
      return
    }
    const slide = { ...raw }
    slide.layout = resolveLayout(slide)
    slide.title = asText(slide.title)
    slide.notes = asText(slide.notes)
    if (slide.bullets) slide.bullets = normalizeBullets(slide.bullets)
    // agenda 版式的 items 是议程条目，不要同时收成 bullets（否则文字统计会重复）
    if (slide.items && !slide.bullets && slide.layout !== 'agenda') slide.bullets = normalizeBullets(slide.items)
    if (Array.isArray(slide.columns)) {
      slide.columns = slide.columns.slice(0, 3).map((col) => ({
        title: asText(col?.title),
        bullets: normalizeBullets(col?.bullets ?? col?.items),
      }))
    }
    if (Array.isArray(slide.cards)) {
      slide.cards = slide.cards.slice(0, 6).map((card) => ({
        title: asText(card?.title),
        body: asText(card?.body ?? card?.text),
        icon: asText(card?.icon),
        ...(card?.color ? { color: asText(card.color) } : {}),
      }))
    }
    if (Array.isArray(slide.kpi ?? slide.stats)) {
      slide.kpi = asArray(slide.kpi ?? slide.stats).slice(0, 4).map((item) => ({
        value: asText(item?.value ?? item?.number),
        unit: asText(item?.unit),
        label: asText(item?.label ?? item?.title),
        delta: asText(item?.delta),
        hint: asText(item?.hint),
      }))
    }
    if (Array.isArray(slide.steps)) {
      slide.steps = slide.steps.slice(0, 6).map((step) => ({
        time: asText(step?.time),
        title: asText(step?.title),
        desc: asText(step?.desc ?? step?.text),
      }))
    }
    if (slide.table && typeof slide.table === 'object') {
      slide.table = {
        head: asArray(slide.table.head).map(asText),
        rows: asArray(slide.table.rows).slice(0, 20).map((row) => asArray(row).map(asText)),
        ...(Array.isArray(slide.table.widths) ? { widths: slide.table.widths.map(Number) } : {}),
      }
    }
    const agendaRaw = slide.agenda ?? slide.contents ?? slide.toc ?? (slide.layout === 'agenda' ? slide.items : undefined)
    if (Array.isArray(agendaRaw)) {
      slide.agenda = normalizeAgenda(agendaRaw)
    }
    const quadrants = Array.isArray(slide.quadrants) ? slide.quadrants : slide.matrix?.quadrants
    if (Array.isArray(quadrants) || (slide.matrix && typeof slide.matrix === 'object')) {
      slide.matrix = {
        xAxis: asText(slide.matrix?.xAxis ?? slide.matrix?.x),
        yAxis: asText(slide.matrix?.yAxis ?? slide.matrix?.y),
        quadrants: normalizeQuadrants(slide.quadrants ?? slide.matrix),
      }
    }
    if (slide.chart && typeof slide.chart === 'object') {
      const chartType = (asText(slide.chart.type) || 'bar').toLowerCase()
      slide.chart = {
        type: chartType,
        categories: asArray(slide.chart.categories).map(asText),
        series: asArray(slide.chart.series).map((one) => {
          const entry = {
            name: asText(one?.name),
            values: asArray(one?.values).map((v) => (v === '' || v === null || v === undefined ? null : Number(v))),
          }
          if (one?.points !== undefined || chartType === 'scatter') entry.points = normalizePoints(one?.points)
          return entry
        }),
        ...(slide.chart.numberFormat ? { numberFormat: asText(slide.chart.numberFormat) } : {}),
        ...(slide.chart.labels !== undefined ? { labels: Boolean(slide.chart.labels) } : {}),
      }
    }
    for (const key of ['left', 'right']) {
      if (slide[key] && typeof slide[key] === 'object') {
        slide[key] = { title: asText(slide[key].title), items: normalizeBullets(slide[key].items ?? slide[key].bullets) }
      }
    }
    deck.slides.push(slide)
  })
  return { deck, warnings }
}

// ── 设计审校 ──────────────────────────────────────────────────────────

const EMPTY_TITLE_WORDS = ['分析', '概述', '背景', '介绍', '现状', '情况', '说明', '相关', '一些', '内容', '简介']
const VAGUE_WORDS = ['赋能', '抓手', '闭环', '生态', '打法', '组合拳']

function countDigits(text) {
  return (String(text).match(/\d/g) || []).length
}

function bulletSize(slide) {
  if (Array.isArray(slide.bullets)) return slide.bullets.length
  if (Array.isArray(slide.columns)) return slide.columns.reduce((n, c) => n + (c.bullets?.length || 0), 0)
  if (Array.isArray(slide.cards)) return slide.cards.length
  if (Array.isArray(slide.kpi)) return slide.kpi.length
  return 0
}

function slideTextLength(slide) {
  const parts = [slide.title, slide.subtitle, slide.insight, slide.quote, slide.caption]
  const push = (item) => parts.push(typeof item === 'string' ? item : item?.text || item?.body || item?.desc || '')
  for (const key of ['bullets', 'items', 'steps', 'cards', 'kpi']) asArray(slide[key]).forEach(push)
  for (const entry of asArray(slide.agenda)) push(entry)
  for (const quadrant of asArray(slide.matrix?.quadrants)) {
    push(quadrant?.title)
    asArray(quadrant?.items).forEach(push)
  }
  if (slide.table) {
    asArray(slide.table.head).forEach(push)
    asArray(slide.table.rows).forEach((row) => asArray(row).forEach(push))
  }
  return parts.filter(Boolean).join('').length
}

/**
 * 设计审校：返回 {score, issues[], stats}。
 * level: error（必须改）/ warn（建议改）/ info（可选）。
 */
export function lintDeck(deck) {
  const issues = []
  const slides = deck.slides || []
  const add = (level, slideNo, code, message, fix) => issues.push({ level, slide: slideNo, code, message, fix })

  if (!slides.length) add('error', 0, 'empty', 'deck 没有任何页面', '至少给一个 cover 页')
  const first = slides[0]?.layout
  const last = slides[slides.length - 1]?.layout
  if (first !== 'cover') add('warn', 1, 'no-cover', '第一页不是封面版式', '把第 1 页 layout 改成 "cover"')
  if (last !== 'end') add('info', slides.length, 'no-end', '最后一页不是结束页', '补一页 layout="end"（谢谢 + 联系方式）')
  if (slides.length > 0 && slides.length < 6) add('info', 0, 'too-few', `只有 ${slides.length} 页，可能讲不清完整逻辑`, '按「结论先行 + 3-5 段论据 + 行动项」补到 8 页以上')
  if (slides.length > 40) add('warn', 0, 'too-many', `共 ${slides.length} 页，超出常见汇报时长`, '按每页 1-2 分钟删减，或拆成主体 + 附录两份')

  let bulletRun = 0
  let visualPages = 0
  let dataPages = 0

  slides.forEach((slide, index) => {
    const no = index + 1
    const layout = slide.layout
    const title = String(slide.title || '').trim()
    if (['image', 'quote', 'end', 'cover'].includes(layout)) visualPages += 1
    if (['kpi', 'chart', 'table', 'timeline', 'process'].includes(layout)) dataPages += 1

    // 图片页与金句页可以不写标题：前者的信息在图上，后者的主体是引文。
    if (!title && !['image', 'quote'].includes(layout)) add('warn', no, 'no-title', '缺少标题', '补一句结论式标题')
    if (title) {
      if (title.length > 34) add('warn', no, 'long-title', `标题 ${title.length} 字，过长`, '压到 20 字内：前半句结论 + 后半句限定')
      if (/^(?:关于|有关)/.test(title)) add('warn', no, 'vague-title', `标题「${title}」偏栏目标题`, '改成结论句，例如「Q3 增长主因是渠道结构变化」')
      if (EMPTY_TITLE_WORDS.some((word) => title.endsWith(word)) && title.length <= 10) {
        add('warn', no, 'empty-title', `标题「${title}」没有信息量`, '标题必须是一句可被反驳的结论')
      }
      if (VAGUE_WORDS.some((word) => title.includes(word))) {
        add('info', no, 'buzzword', `标题含「${VAGUE_WORDS.find((w) => title.includes(w))}」这类无信息量词`, '换成具体动词与数字')
      }
    }

    const count = bulletSize(slide)
    if (['bullets', 'two-col', 'cards'].includes(layout)) {
      if (count > 5) add('error', no, 'too-many-bullets', `要点 ${count} 条，超过 5 条上限`, '第 6 条起移入 notes 讲稿，或拆成两页')
      else if (count === 5) add('info', no, 'five-bullets', '要点 5 条已到上限', '能压到 3-4 条会更好读')
      if (count === 1 && layout === 'bullets') add('info', no, 'single-bullet', '只有 1 条要点', '改成语句页（quote）或补足论据')
    }

    asArray(slide.bullets).forEach((item, i) => {
      const text = String(item?.text || '')
      if (text.length > 28) add('warn', no, 'long-bullet', `第 ${i + 1} 条要点 ${text.length} 字`, '压到 24 字内，细节进 notes')
      if (text.length > 12 && countDigits(text) >= 3 && ['bullets', 'two-col'].includes(layout)) {
        add('warn', no, 'numbers-in-text', `第 ${i + 1} 条要点里有 ${countDigits(text)} 个数字`, '数字改用 kpi / chart / table 版式呈现')
      }
    })

    if (asArray(slide.bullets).filter((b) => countDigits(b?.text || '') >= 3).length >= 3 && layout === 'bullets') {
      add('warn', no, 'data-as-text', '这一页大半是数字，却用文字排版', '换 kpi（2-4 个核心指标）或 chart 版式')
    }

    if (layout === 'chart') {
      const series = asArray(slide.chart?.series)
      const chartType = String(slide.chart?.type || 'bar').toLowerCase()
      const knownTypes = ['bar', 'column', 'bar-h', 'line', 'area', 'pie', 'doughnut', 'stacked', 'radar', 'scatter']
      if (!knownTypes.includes(chartType)) {
        add('warn', no, 'chart-unknown-type', `图表类型「${chartType}」不认识`, `改用 ${knownTypes.join(' / ')}`)
      }
      if (chartType === 'scatter') {
        if (!series.length) {
          add('error', no, 'chart-empty', '散点图缺少 series', '给 chart.series[{name, points:[{x,y}]}]，每个系列至少 2 个点')
        } else {
          series.forEach((one, i) => {
            const points = asArray(one.points)
            if (points.length < 2) {
              add('error', no, 'chart-points', `第 ${i + 1} 个散点系列只有 ${points.length} 个点`, '每个系列至少给 2 个 points:[{x,y}]（或 [[x,y],…]）')
            }
          })
        }
      } else if (!series.length || !asArray(slide.chart?.categories).length) {
        add('error', no, 'chart-empty', '图表页缺少 categories / series', '给全 chart.categories 与 chart.series[{name,values}]')
      } else {
        const len = asArray(slide.chart.categories).length
        series.forEach((one, i) => {
          if (asArray(one.values).length !== len) {
            add('error', no, 'chart-mismatch', `第 ${i + 1} 个系列的数据点 ${asArray(one.values).length} 个，与分类数 ${len} 不一致`, '补齐或删掉多余数据点')
          }
        })
        if (asArray(slide.chart?.categories).length > 8) add('info', no, 'chart-crowded', '分类超过 8 个，柱子会变细', '合并尾部为「其他」，或改用表格')
        if (['pie', 'doughnut'].includes(chartType) && asArray(slide.chart?.categories).length > 5) {
          add('warn', no, 'pie-many-slices', '饼图/环图分类超过 5 个', '占比图别超过 5 片，其余归入「其他」')
        }
        if (chartType === 'radar' && asArray(slide.chart?.categories).length < 3) {
          add('warn', no, 'radar-too-few-axes', '雷达图维度少于 3 个，画不出形状', '给 3-8 个维度（categories），每个系列与维度一一对应')
        }
      }
      if (series.length && !slide.insight) add('warn', no, 'chart-no-insight', '图表页没有 insight', '写一句「这张图说明什么」，观众不该自己猜')
    }

    if (layout === 'agenda') {
      const entries = asArray(slide.agenda)
      if (!entries.length) add('error', no, 'agenda-empty', '议程页缺少 agenda 条目', '给 3-6 条：agenda:[{title,desc,page}]，也接受字符串数组')
      else if (entries.length > 6) add('error', no, 'agenda-many', `议程 ${entries.length} 条，超过 6 条上限`, '压到 3-6 条，细分内容留到各章节页')
      else if (entries.length < 3) add('warn', no, 'agenda-few', `议程只有 ${entries.length} 条`, '目录页至少 3 段，否则直接用 bullets 版式')
      entries.forEach((entry, i) => {
        if (!entry?.title) add('error', no, 'agenda-no-title', `第 ${i + 1} 条议程没有标题`, '补 title；可选 desc（一句说明）与 page（页码）')
        else if (String(entry.title).length > 24) add('warn', no, 'agenda-long', `第 ${i + 1} 条议程 ${String(entry.title).length} 字`, '目录条目标题压到 24 字内')
      })
    }

    if (layout === 'matrix') {
      const quadrants = asArray(slide.matrix?.quadrants)
      if (!quadrants.length) add('error', no, 'matrix-empty', '矩阵页缺少 matrix.quadrants', '给 4 个象限：matrix:{xAxis,yAxis,quadrants:[{title,items[]}]}')
      else if (quadrants.length !== 4) add('error', no, 'matrix-shape', `矩阵页有 ${quadrants.length} 个象限，2×2 必须是 4 个`, '补齐/删减到 4 个象限（顺序：左上、右上、左下、右下）')
      else {
        quadrants.forEach((quadrant, i) => {
          if (!quadrant?.title) add('warn', no, 'matrix-no-title', `第 ${i + 1} 个象限没有标题`, '每个象限补一句短标题')
          if (asArray(quadrant?.items).length > 4) add('warn', no, 'matrix-many-items', `第 ${i + 1} 个象限有 ${asArray(quadrant?.items).length} 条要点`, '每象限压到 2-4 条，细节进 notes')
        })
      }
    }

    if (layout === 'table') {
      const head = asArray(slide.table?.head)
      const rows = asArray(slide.table?.rows)
      if (!head.length) add('error', no, 'table-no-head', '表格缺少表头', '补 table.head')
      if (rows.length > 10) add('warn', no, 'table-long', `表格 ${rows.length} 行，观众读不完`, '压到 8 行内，其余进附录')
      rows.forEach((row, r) => {
        if (asArray(row).length !== head.length) {
          add('warn', no, 'table-width', `第 ${r + 1} 行有 ${asArray(row).length} 列，与表头 ${head.length} 列不一致`, '对齐列数，缺的格子填空字符串')
        }
      })
    }

    if (layout === 'image') {
      if (!slide.image) add('error', no, 'image-missing', '图文页没有 image', '给 image（本地路径或可下载的图片 URL）')
      else if (!slide.caption) add('info', no, 'image-no-caption', '配图没有 caption', '加一句图注或来源说明')
    }

    if (layout === 'kpi' && asArray(slide.kpi).length > 4) {
      add('warn', no, 'kpi-many', '指标超过 4 个，重点会被稀释', '保留 2-4 个核心指标，其余并入表格')
    }

    if (!slide.notes) add('warn', no, 'no-notes', '没有讲稿（notes）', '写 2-4 句口播：这页要让人记住什么')
    if (slide.notes && String(slide.notes).length > 320) add('info', no, 'notes-long', '讲稿偏长', '压到 3 句以内，细节留给问答')

    const chars = slideTextLength(slide)
    if (chars > 380) add('warn', no, 'crowded', `这一页文字约 ${chars} 字，版面会挤`, '砍字优先于缩字号；先降到 5 条要点内')

    if (layout === 'bullets') {
      bulletRun += 1
      if (bulletRun === 3) add('info', no, 'monotone', '连续 3 页都是要点页，节奏单调', '插入 kpi / chart / image / quote 换气')
    } else {
      bulletRun = 0
    }
  })

  if (slides.length >= 8 && visualPages === 0) {
    add('info', 0, 'no-visual', '整份 deck 没有任何视觉页（图文/金句）', '至少插入 1 页 image 或 quote 作为呼吸')
  }
  if (slides.length >= 8 && dataPages < 2) {
    add('info', 0, 'no-data', '几乎没有数据页', '核心结论用 kpi / chart 呈现，说服力更强')
  }

  const penalty = issues.reduce((sum, item) => sum + (item.level === 'error' ? 6 : item.level === 'warn' ? 3 : 1), 0)
  const score = Math.max(0, Math.min(100, 100 - penalty))
  return {
    score,
    issues,
    stats: {
      slides: slides.length,
      errors: issues.filter((i) => i.level === 'error').length,
      warnings: issues.filter((i) => i.level === 'warn').length,
      infos: issues.filter((i) => i.level === 'info').length,
      layouts: slides.reduce((acc, s) => ({ ...acc, [s.layout]: (acc[s.layout] || 0) + 1 }), {}),
    },
  }
}

/** 审校结果 → 模型可读文本。 */
export function formatLint(report) {
  const lines = [`设计审校：${report.score}/100（${report.stats.slides} 页 · 错误 ${report.stats.errors} · 警告 ${report.stats.warnings} · 建议 ${report.stats.infos}）`]
  if (!report.issues.length) {
    lines.push('未发现问题：结构、要点密度、数据呈现、讲稿齐备。')
    return lines.join('\n')
  }
  const order = { error: 0, warn: 1, info: 2 }
  for (const issue of [...report.issues].sort((a, b) => order[a.level] - order[b.level] || a.slide - b.slide)) {
    const tag = issue.level === 'error' ? '✗ 必须改' : issue.level === 'warn' ? '! 建议改' : '· 可选'
    lines.push(`${tag}｜第 ${issue.slide} 页｜${issue.message} → ${issue.fix}`)
  }
  return lines.join('\n')
}
