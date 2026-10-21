/**
 * 五个工具的定义与注册。
 *
 * 工具描述里直接写清楚字段约定与示例 —— 模型对「版式名 + 字段」的记忆来自这里，
 * 而不是来自试错。所有工具：
 *   * 只依赖 ctx 服务与 Node 内建能力；
 *   * 返回纯 JSON（可被 JsonValue 序列化）；
 *   * 尊重 exec.signal（用户取消时不继续跑渲染）。
 */

import fs from 'node:fs'
import {
  buildPresentation,
  deleteTemplate,
  listTemplates,
  probePython,
  research,
  saveTemplate,
  storeDir,
  resolveHome,
  SCRIPT_PATH,
} from './engine.js'
import { normalizeDeck, lintDeck, formatLint, resolveLayout } from './deck.js'
import { LAYOUT_NAMES } from './templates.js'

const ok = (value) => [{ type: 'text', text: value }]

/**
 * 净化成无损 JSON：宿主对工具返回值做严格校验，undefined / NaN / BigInt /
 * 函数都会让整次调用被判为 invalid output。这里统一抹平，让工具永远返回
 * 可序列化的纯数据。
 */
function toJson(value) {
  if (value === undefined || value === null) return null
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return String(value)
  if (type === 'boolean' || type === 'string') return value
  if (type === 'function' || type === 'symbol') return null
  if (Array.isArray(value)) return value.map(toJson)
  if (type === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = toJson(item)
    }
    return out
  }
  return String(value)
}

const LEVEL_TAG = (level) => (level === 'error' ? '必改' : level === 'warn' ? '建议' : '可选')

const DECK_EXAMPLE = `{
  "title": "2026 增长战略",
  "subtitle": "董事会汇报 · 2026 Q4",
  "author": "战略部",
  "date": "2026-10",
  "template": "indigo-corporate",
  "slides": [
    { "layout": "cover", "kicker": "战略规划", "title": "把增长押在三个确定性上", "subtitle": "渠道结构 × 产品组合 × 组织效率",
      "notes": "开场 30 秒：先给结论，再说明后面 12 页怎么证明它。" },
    { "layout": "agenda", "title": "今天讲三段：现状、打法、要什么", "agenda": [
        { "title": "现状：增长从哪里来", "desc": "渠道与产品结构", "page": "P3" },
        { "title": "打法：下半年三件事", "desc": "直营、续费、供应", "page": "P6" },
        { "title": "要什么：批准 1.2 亿预算", "desc": "回报与风险", "page": "P14" } ] },
    { "layout": "kpi", "title": "三个数字定义今年的基线", "kpi": [
        { "value": "12.4", "unit": "亿元", "label": "全年营收", "delta": "+18%", "hint": "口径：合并报表" },
        { "value": "62", "unit": "%", "label": "华东区增量贡献", "delta": "+8pt" },
        { "value": "3.1", "unit": "个月", "label": "回本周期", "delta": "-0.4" } ] },
    { "layout": "chart", "title": "增量几乎全部来自渠道结构变化", "insight": "直营占比从 21% 升到 38%，是 +18% 的主因；代理增长已见顶。",
      "chart": { "type": "bar", "categories": ["Q1","Q2","Q3","Q4"], "series": [ { "name": "直营", "values": [1.2,1.9,2.6,3.4] }, { "name": "代理", "values": [2.1,2.0,2.2,2.1] } ] } },
    { "layout": "bullets", "title": "下半年只做三件事", "insight": "资源集中在回报最高的两件事上，第三件做能力储备。",
      "bullets": [ "直营门店从 180 家扩到 260 家", "把续费率从 78% 提到 85%", "建立海外供应第二通道" ] },
    { "layout": "matrix", "title": "四类增长机会的优先级", "insight": "预算优先给左上象限：高回报、低投入。",
      "matrix": { "xAxis": "投入", "yAxis": "回报", "quadrants": [
        { "title": "先做（高回报 · 低投入）", "items": ["直营扩店", "续费率提升"] },
        { "title": "重点投（高回报 · 高投入）", "items": ["海外第二供应通道"] },
        { "title": "顺手做（低回报 · 低投入）", "items": ["包装升级"] },
        { "title": "暂缓（低回报 · 高投入）", "items": ["自建物流"] } ] } },
    { "layout": "end", "title": "要一个决定：批准 Q3 的 1.2 亿扩张预算", "subtitle": "回报测算见附录", "contact": "战略部 · 王明" }
  ]
}`

function toolDefinition({ name, title, description, parameters, timeoutMs, safe, run, render }) {
  return {
    name,
    description: `${title}\n${description}`,
    parameters,
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
      render: (args, value) => ok(render(value)),
    },
    timeoutMs,
    isConcurrencySafe: () => Boolean(safe),
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error(`${name} 已被取消`)
      const result = await run(args ?? {}, exec)
      if (exec?.signal?.aborted) throw new Error(`${name} 已被取消`)
      return toJson(result)
    },
  }
}

/** 构建全部工具定义（不含注册）。ctx 由闭包带入 —— ToolRunContext 里没有 cordis ctx。 */
export function buildToolDefinitions(ctx = {}) {
  return [
    toolDefinition({
      name: 'ppt_research',
      title: '联网取材：为演示文稿搜集事实、数据、图片与配色灵感。',
      description: [
        'kind 取值：facts（默认，找可引用的事实与数据）｜images（找配图并解析页面主图 og:image）｜palette（配色灵感 + 落地色板建议）｜inspiration（同类主题的优秀呈现方式）。',
        '返回 sources（标题/链接/摘要/发布时间）、images（可直接填进 deck 的 image 字段的图片 URL）、palettes（建议色板）、notes（搜索摘要与失败原因）。',
        '两种用法：① query 搜索——给主题词；② urls 直抓——给一串已知链接，直接抓正文与 og:image（不依赖搜索能力，搜索密钥缺失时用这条）。两者可同时给。',
        '纪律：引用任何外部数据，都要把来源写进对应页的 notes；搜不到就说搜不到，不要编造数字。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索主题（中文即可），例："2026 新能源汽车渗透率"' },
          urls: { type: 'array', items: { type: 'string' }, description: '直接抓取的页面链接（最多 8 个）；不需要搜索密钥' },
          kind: { type: 'string', enum: ['facts', 'images', 'palette', 'inspiration'], description: '取材类型，默认 facts' },
          maxResults: { type: 'integer', description: '每个查询的返回条数上限（1-12，默认 6）' },
          wantImages: { type: 'boolean', description: '即使 kind 不是 images，也顺带抓取候选配图' },
          wantPalette: { type: 'boolean', description: '顺带给出与该主题匹配的落地色板建议' },
          fetchTop: { type: 'integer', description: '为找图而抓取的页面数（默认 4，最多 6）' },
        },
        additionalProperties: false,
      },
      timeoutMs: 120000,
      safe: true,
      run: (args, exec) => research(ctx, args, exec?.signal),
      render: (value) => {
        if (!value?.ok) {
          return ['取材未取到内容。', ...(value?.notes || []).slice(0, 5).map((note) => `· ${note}`)].join('\n')
        }
        const lines = [`取材「${value.query || (value.sources?.[0]?.url ?? '')}」（${value.kind}）：${value.sources.length} 个来源，${value.images.length} 张候选配图。`]
        value.sources.slice(0, 8).forEach((s, i) => lines.push(`${i + 1}. ${s.title} — ${s.url}${s.snippet ? `\n   ${String(s.snippet).slice(0, 160)}` : ''}`))
        if (value.images.length) {
          lines.push('候选配图（可直接填 deck 的 image 字段）：')
          value.images.slice(0, 6).forEach((img, i) => lines.push(`${i + 1}. ${img.url}`))
        }
        if (value.palettes?.length) {
          lines.push('建议色板：')
          value.palettes.forEach((p) => lines.push(`· ${p.colors.join(' / ')} —— ${p.howTo}`))
        }
        if (value.notes?.length) lines.push(`备注：${value.notes.slice(0, 4).join(' | ')}`)
        lines.push('提醒：把用到的来源写进该页 notes。')
        return lines.join('\n')
      },
    }),

    toolDefinition({
      name: 'ppt_templates',
      title: '模板库：查看、派生、保存、删除设计规范模板。',
      description: [
        `内置 8 套设计规范：indigo-corporate 靛蓝商务｜minimal-paper 极简素白｜deepspace-tech 深空科技｜warm-sunrise 暖阳人文｜celadon-cn 青瓷东方｜data-vivid 数据亮色｜graphite-mono 石墨黑白｜ocean-deep 深海蓝。`,
        'action=list 列出全部模板（内置 + 用户自建，用户同 id 会覆盖内置）。',
        'action=get 看一套模板的完整字段（theme 配色 / fonts 字体栈 / geometry 版式几何 / decor 装饰）。',
        'action=save 保存模板：给 baseOn 在已有模板上派生，再覆盖想改的字段（只写要改的部分，不要整套重写）；id 省略时按 name 生成。',
        'action=delete 只删用户自建模板（内置模板删不掉）。',
        `模板字段单位：geometry 全部英寸，字号磅（pt），颜色 #RRGGBB。decor.style 取值 glow｜grid｜soft｜ink｜none。`,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'save', 'delete'], description: '操作类型' },
          id: { type: 'string', description: '模板 id（get/save/delete 用）' },
          name: { type: 'string', description: '模板显示名（save 用）' },
          description: { type: 'string', description: '模板说明（save 用）' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签（save 用）' },
          baseOn: { type: 'string', description: '基于哪套模板派生（save 用，推荐）' },
          theme: { type: 'object', additionalProperties: true, description: '配色覆盖，如 {"primary":"#5B7CFA","bg":"#0A0F22","mode":"dark"}' },
          fonts: { type: 'object', additionalProperties: true, description: '字体覆盖，如 {"title":{"latin":"Georgia","ea":"Microsoft YaHei"}}' },
          geometry: { type: 'object', additionalProperties: true, description: '版式几何覆盖，如 {"marginX":0.9,"bodySize":16,"lineSpacing":1.36}' },
          decor: { type: 'object', additionalProperties: true, description: '装饰覆盖，如 {"style":"grid","coverPattern":"bars"}' },
          overwrite: { type: 'boolean', description: 'save 时同 id 是否覆盖（默认 true）' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      timeoutMs: 60000,
      safe: true,
      run: (args) => {
        const action = String(args.action || 'list').toLowerCase()
        if (action === 'list') {
          return {
            ok: true,
            action,
            build: 'v2-hot-reload-probe',
            templates: listTemplates().map((t) => ({
              id: t.id, name: t.name, origin: t.origin, tags: t.tags, description: t.description,
              theme: { bg: t.theme.bg, primary: t.theme.primary, accent: t.theme.accent, mode: t.theme.mode },
            })),
            store: storeDir(),
          }
        }
        if (action === 'get') {
          const list = listTemplates()
          const found = list.find((t) => t.id === args.id)
          if (!found) throw new Error(`模板 "${args.id}" 不存在。可用：${list.map((t) => t.id).join('、')}`)
          return { ok: true, action, template: found }
        }
        if (action === 'save') {
          const saved = saveTemplate(args)
          return { ok: true, action, id: saved.template.id, name: saved.template.name, path: saved.path, replaced: saved.replaced, template: saved.template }
        }
        if (action === 'delete') {
          const removed = deleteTemplate(args.id)
          return { ok: true, action, ...removed }
        }
        throw new Error(`未知 action：${args.action}`)
      },
      render: (value) => {
        if (value.action === 'list') {
          const lines = [`模板库（${value.templates.length} 套）· 用户模板目录 ${value.store}${value.build ? ` · ${value.build}` : ''}`, '']
          for (const t of value.templates) {
            lines.push(`· ${t.id}｜${t.name}${t.origin === 'user' ? '（自建）' : ''}｜底色 ${t.theme.bg} 主色 ${t.theme.primary} 点缀 ${t.theme.accent}`)
            lines.push(`  ${t.description}`)
          }
          lines.push('', '用法：ppt_build 的 template 字段填这里的 id。')
          return lines.join('\n')
        }
        if (value.action === 'get') return JSON.stringify(value.template, null, 2).slice(0, 6000)
        if (value.action === 'save') return `模板已保存：${value.id}（${value.name}）\n文件：${value.path}\n下一步：ppt_build 用 template="${value.id}" 出稿。`
        return `模板已删除：${value.id}`
      },
    }),

    toolDefinition({
      name: 'ppt_build',
      title: '按模板生成 PPTX（核心工具）：真实 .pptx + 全页预览图。',
      description: [
        '输入 deck（内联 JSON，或先用 write 工具写成 JSON 文件再给 deckPath），输出 .pptx 与预览 PNG（预览是版式示意：配色/分区/密度）。',
        `可用 layout：${LAYOUT_NAMES.join('｜')}（也接受 title/toc/contents/list/grid/stats/roadmap/photo/quadrant 等别名，会自动归一）。`,
        '每页通用字段：title、kicker（小标签）、subtitle、notes（讲稿）、insight（结论句）。',
        '要点写法：bullets: [{"text":"一句话","level":0}]；level 1 为次级缩进。',
        '议程页：agenda:[{title,desc,page}]（3-6 条，纯字符串数组也可以）。',
        '矩阵页：matrix:{xAxis,yAxis,quadrants:[{title,items[]}]}，必须 4 个象限（顺序：左上、右上、左下、右下）。',
        '图片：image 可给本地路径或 http(s) 图片 URL（会自动下载到临时目录，再按 cover 裁切填满，不拉伸）。',
        '数字：kpi 版式放 2-4 个核心指标；chart 版式支持 bar｜line｜area｜pie｜doughnut｜stacked｜radar｜scatter，散点用 series:[{name,points:[{x,y}]}]（也接受 [[x,y],…]），其余类型 categories 与每个 series 的 values 数量必须一致；table 版式自动把数值列右对齐。',
        '先出小样再全量：第一次只给 3-5 页核心内容，确认风格后再补全整份 —— 比一次性赌一把稳。',
        `示例 deck：\n${DECK_EXAMPLE}`,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          deck: { type: 'object', additionalProperties: true, description: '完整 deck 对象（title/subtitle/author/date/template/slides[]）' },
          deckPath: { type: 'string', description: 'deck JSON 文件路径（deck 很大时先用 write 写文件）' },
          template: { type: 'string', description: '模板 id（默认取 deck.template，再默认 indigo-corporate）' },
          templateSpec: { type: 'object', additionalProperties: true, description: '一次性内联模板（不想入库时用）' },
          out: { type: 'string', description: '输出 .pptx 完整路径' },
          outDir: { type: 'string', description: '输出目录（与 out 二选一；默认当前工作目录）' },
          fileName: { type: 'string', description: '文件名（不含目录；默认「主题-YYYYMMDD」）' },
          preview: { type: 'boolean', description: '是否生成预览图（默认 true）' },
          previewGrid: { type: 'integer', description: '预览图每行页数（默认 3）' },
          dryRun: { type: 'boolean', description: '只做归一化与审校，不调用渲染器（快速验证数据结构）' },
          python: { type: 'string', description: '自定义 Python 解释器路径（一般不用给）' },
        },
        additionalProperties: false,
      },
      timeoutMs: 300000,
      safe: false,
      run: (args, exec) => buildPresentation(args, ctx, exec?.signal),
      render: (value) => {
        const head = value.ok
          ? `${value.dryRun ? '试算完成（未渲染）' : 'PPTX 已生成'}：${value.slides} 页 · 模板 ${value.templateName}（${value.template}）`
          : `生成失败：${value.error || '未知错误'}`
        const lines = [head]
        if (value.ok && !value.dryRun) {
          lines.push(`文件：${value.out}`)
          if (value.preview) lines.push(`预览图：${value.preview}`)
          if (value.bytes) lines.push(`大小：${(value.bytes / 1024).toFixed(1)} KB${value.pythonPptx ? ` · python-pptx ${value.pythonPptx}` : ''}`)
          lines.push('下一步：用 present 把 .pptx 与预览图交付给用户。')
        }
        if (value.dryRun) lines.push('（dryRun）确认结构无误后去掉 dryRun 重跑即可出稿。')
        if (value.error) {
          lines.push(`原因：${value.error}`)
          if (value.trace) lines.push(`堆栈：${String(value.trace).split('\n').slice(-4).join(' / ')}`)
          lines.push('排障：先跑 ppt_doctor 看 Python / python-pptx / 字体 / 目录权限。')
        }
        if (value.lint) {
          lines.push(`设计审校 ${value.lint.score}/100（必改 ${value.lint.stats.errors} · 建议 ${value.lint.stats.warnings}）`)
          value.lint.issues.filter((i) => i.level === 'error').slice(0, 5).forEach((i) => lines.push(`  ✗ 第 ${i.slide} 页 ${i.message} → ${i.fix}`))
        }
        if (value.warnings?.length) lines.push(`告警：${value.warnings.slice(0, 4).join(' | ')}`)
        return lines.join('\n')
      },
    }),

    toolDefinition({
      name: 'ppt_lint',
      title: '设计审校：按「PPT 大师」规范体检 deck，指出问题与改法。',
      description: [
        '检查项：标题是否为结论句、要点是否超 5 条、单条是否超 24 字、数字是否该进图表、图表 categories/series 是否对齐（散点校验 points 形状与数量、雷达校验维度数）、议程是否 3-6 条且有序号、2×2 矩阵是否恰好 4 个象限、表格列数是否一致、是否有讲稿、版面是否过挤、节奏是否单调（连续要点页）、有无封面/结束页/视觉呼吸页。',
        '返回 score（0-100）、issues（level: error 必改 / warn 建议 / info 可选，每条带 fix 改法）、stats。',
        '用法：出稿前先跑一次，按 error 逐条改完再调 ppt_build —— 比生成后返工快。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          deck: { type: 'object', additionalProperties: true, description: '要体检的 deck 对象' },
          deckPath: { type: 'string', description: 'deck JSON 文件路径' },
        },
        additionalProperties: false,
      },
      timeoutMs: 30000,
      safe: true,
      run: (args) => {
        let raw = args.deck
        if (!raw && args.deckPath) {
          raw = JSON.parse(fs.readFileSync(String(args.deckPath), 'utf8'))
        }
        if (!raw) throw new Error('缺少 deck（或 deckPath）')
        const { deck, warnings } = normalizeDeck(raw)
        const report = lintDeck(deck)
        return { ok: true, score: report.score, issues: report.issues, stats: report.stats, warnings, layouts: deck.slides.map((s) => resolveLayout(s)) }
      },
      render: (value) => formatLint(value),
    }),

    toolDefinition({
      name: 'ppt_doctor',
      title: '环境自检：Python、python-pptx、字体、目录、网络能力。',
      description: '出任何问题（渲染失败、中文变方块、找不到文件）先跑它。返回解释器路径、python-pptx / Pillow 版本、可用字体、模板目录与写权限、web 服务与 webServer 可用性。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 90000,
      safe: true,
      run: async (args) => {
        const probe = await probePython(args?.python)
        const { home, source } = resolveHome()
        const dir = storeDir()
        let writable = false
        let writeError
        try {
          fs.mkdirSync(dir, { recursive: true })
          const probeFile = `${dir}/.write-test`
          fs.writeFileSync(probeFile, 'ok')
          fs.unlinkSync(probeFile)
          writable = true
        } catch (error) {
          writeError = String(error?.message || error)
        }
        const web = ctx.get ? ctx.get('web') : undefined
        return {
          ok: Boolean(probe.ok),
          python: probe,
          script: SCRIPT_PATH,
          home: { path: home, source, templateDir: dir, writable, writeError },
          services: {
            web: Boolean(web && typeof web.search === 'function'),
            webServer: Boolean(ctx?.get && ctx.get('webServer')),
            systemPrompt: Boolean(ctx?.get && ctx.get('systemPrompt')),
            skills: Boolean(ctx?.get && ctx.get('skills')),
          },
          templates: listTemplates().map((t) => `${t.id}${t.origin === 'user' ? '(自建)' : ''}`),
        }
      },
      render: (value) => {
        const lines = [`PPT 大师自检：${value.ok ? '✅ 渲染链可用' : '❌ 渲染链不可用'}`]
        if (value.python && typeof value.python === 'object') {
          lines.push(`Python：${value.python.executable || value.python.interpreter || '未找到'}（${value.python.python || '?'}）`)
          lines.push(`python-pptx：${value.python.pythonPptx || '缺失'} · Pillow：${value.python.pillow || '缺失'}`)
          if (value.python.fonts) lines.push(`预览字体：中文 ${value.python.fonts.title || '未找到'} · 西文 ${value.python.fonts.latin || '未找到'}`)
          if (value.python.error) lines.push(`错误：${value.python.error}`)
        }
        lines.push(`模板目录：${value.home.templateDir}（${value.home.writable ? '可写' : `不可写：${value.home.writeError}`}，来源 ${value.home.source}）`)
        lines.push(`内置/自建模板：${value.templates.join('、')}`)
        lines.push(`服务：web=${value.services.web ? 'ok' : '缺失'} webServer=${value.services.webServer ? 'ok' : '缺失'} systemPrompt=${value.services.systemPrompt ? 'ok' : '缺失'} skills=${value.services.skills ? 'ok' : '缺失'}`)
        lines.push(`渲染脚本：${value.script}`)
        return lines.join('\n')
      },
    }),
  ]
}

/**
 * 注册到给定 ctx（全局入口与 preset 作用域入口共用）。
 * 单个工具注册失败不影响其余工具：逐个 try/catch 并收集错误。
 */
export function registerPptTools(ctx, logger) {
  const disposers = []
  const failures = []
  const registered = []
  for (const definition of buildToolDefinitions(ctx)) {
    try {
      disposers.push(ctx.tools.register(definition))
      registered.push(definition.name)
    } catch (error) {
      failures.push({ name: definition.name, error: String(error?.message || error) })
    }
  }
  const log = logger || (() => {})
  if (registered.length) log(`dsh-ppt-master: 已注册工具 ${registered.join('、')}`)
  if (failures.length) log(`dsh-ppt-master: 工具注册失败 ${failures.map((f) => `${f.name}(${f.error})`).join('、')}`)
  return { disposers, registered, failures }
}
