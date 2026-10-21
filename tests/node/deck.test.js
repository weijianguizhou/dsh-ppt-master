/**
 * lib/deck.js 单元测试：版式解析、deck 归一化、设计审校。
 *
 * 只依赖 Node 内建 node:test / node:assert —— 不引入任何 npm 包，
 * 这样 CI 里的 Node 20/22 矩阵不需要 npm install。
 *
 * 刻意保持「面向契约而非实现」的断言：新版式（agenda / matrix 等）加入时，
 * 未知版式仍应回退 bullets，本文件不会因此变红。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveLayout, normalizeDeck, lintDeck, formatLint } from '../../lib/deck.js'
import { LAYOUT_NAMES } from '../../lib/templates.js'

// ── resolveLayout ─────────────────────────────────────────────────────

test('resolveLayout：已知版式名原样返回', () => {
  for (const layout of ['cover', 'bullets', 'kpi', 'chart', 'table', 'compare', 'end']) {
    assert.equal(resolveLayout({ layout }), layout)
  }
})

test('resolveLayout：稳定别名收敛到规范名', () => {
  const cases = [
    ['title', 'cover'],
    ['stats', 'kpi'],
    ['roadmap', 'timeline'],
    ['photo', 'image'],
    ['thanks', 'end'],
    ['closing', 'end'],
    ['vs', 'compare'],
    ['data', 'chart'],
    ['columns', 'two-col'],
    ['steps', 'process'],
  ]
  for (const [alias, expected] of cases) {
    assert.equal(resolveLayout({ layout: alias }), expected, `别名 ${alias} 应映射到 ${expected}`)
  }
})

test('resolveLayout：大小写与首尾空白不敏感', () => {
  assert.equal(resolveLayout({ layout: '  KPI  ' }), 'kpi')
  assert.equal(resolveLayout({ layout: 'Title' }), 'cover')
})

test('resolveLayout：没有 layout 时按内容字段推断', () => {
  assert.equal(resolveLayout({ kpi: [{ value: '1' }] }), 'kpi')
  assert.equal(resolveLayout({ chart: { type: 'bar', categories: [], series: [] } }), 'chart')
  assert.equal(resolveLayout({ table: { head: [], rows: [] } }), 'table')
  assert.equal(resolveLayout({ steps: [{ title: '第一步' }] }), 'process')
  assert.equal(resolveLayout({ cards: [{ title: '卡片' }] }), 'cards')
  assert.equal(resolveLayout({ quote: '一句话' }), 'quote')
  assert.equal(resolveLayout({ image: 'cover.png' }), 'image')
  assert.equal(resolveLayout({ columns: [{ title: 'A' }] }), 'two-col')
})

test('resolveLayout：未知版式 / 空输入回退 bullets', () => {
  assert.equal(resolveLayout({ layout: 'no-such-layout-xyz' }), 'bullets')
  assert.equal(resolveLayout({ layout: '' }), 'bullets')
  assert.equal(resolveLayout({}), 'bullets')
  assert.equal(resolveLayout(null), 'bullets')
  assert.equal(resolveLayout(undefined), 'bullets')
  assert.equal(resolveLayout({ layout: 123 }), 'bullets')
})

test('LAYOUT_NAMES：核心版式齐全且无重复', () => {
  assert.ok(LAYOUT_NAMES.length >= 14, `内置版式数量应 ≥ 14，实际 ${LAYOUT_NAMES.length}`)
  for (const layout of ['cover', 'section', 'bullets', 'two-col', 'cards', 'kpi', 'timeline', 'image', 'quote', 'table', 'chart', 'compare', 'process', 'end']) {
    assert.ok(LAYOUT_NAMES.includes(layout), `缺少内置版式 ${layout}`)
  }
  assert.equal(new Set(LAYOUT_NAMES).size, LAYOUT_NAMES.length, 'LAYOUT_NAMES 不应有重复项')
})

// ── normalizeDeck ─────────────────────────────────────────────────────

test('normalizeDeck：空输入给出占位封面并告警', () => {
  for (const input of [undefined, null, 'not-a-deck', 42, {}]) {
    const { deck, warnings } = normalizeDeck(input)
    assert.equal(deck.slides.length, 1)
    assert.equal(deck.slides[0].layout, 'cover')
    assert.equal(deck.title, '演示文稿')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /slides 为空/)
  }
})

test('normalizeDeck：deck 级元信息与 footer 兜底', () => {
  const { deck } = normalizeDeck({
    title: 'Q3 复盘',
    subtitle: '董事会',
    author: '战略部',
    date: '2026-10',
    footer: '内部资料',
    chrome: false,
    slides: [{ layout: 'cover', title: '结论先行' }],
  })
  assert.equal(deck.title, 'Q3 复盘')
  assert.equal(deck.subtitle, '董事会')
  assert.equal(deck.author, '战略部')
  assert.equal(deck.date, '2026-10')
  assert.equal(deck.footer, '内部资料')
  assert.equal(deck.chrome, false)
  assert.equal(deck.slides[0].layout, 'cover')
})

test('normalizeDeck：footer 缺省时回落到 author / title，chrome 默认开启', () => {
  const a = normalizeDeck({ title: 'T', author: 'A', slides: [{ layout: 'cover' }] }).deck
  assert.equal(a.footer, 'A')
  assert.equal(a.chrome, true)
  const b = normalizeDeck({ title: 'T', slides: [{ layout: 'cover' }] }).deck
  assert.equal(b.footer, 'T')
  const c = normalizeDeck({ slides: [{ layout: 'cover' }] }).deck
  assert.equal(c.title, '演示文稿')
  assert.equal(c.footer, '')
})

test('normalizeDeck：非对象 slide 被跳过并逐个告警', () => {
  const { deck, warnings } = normalizeDeck({
    slides: [{ layout: 'cover', title: '正常页' }, null, 'oops', 7],
  })
  assert.equal(deck.slides.length, 1)
  assert.equal(warnings.length, 3)
  for (const warning of warnings) assert.match(warning, /不是对象，已跳过/)
})

test('normalizeDeck：slide 标题/讲稿收敛成字符串', () => {
  const { deck } = normalizeDeck({
    slides: [{ layout: 'bullets', title: 123, notes: null }, { layout: 'bullets', title: {}, notes: '口播' }],
  })
  assert.equal(deck.slides[0].title, '123')
  assert.equal(deck.slides[0].notes, '')
  assert.equal(deck.slides[1].title, '')
  assert.equal(deck.slides[1].notes, '口播')
})

test('normalizeDeck：bullets 支持字符串/数字/对象并过滤空项', () => {
  const { deck } = normalizeDeck({
    slides: [{
      layout: 'bullets',
      bullets: ['纯文本', 2, null, { text: '对象文本', level: 9 }, { title: '取 title' }, { value: '取 value' }, { label: '取 label' }, { text: '' }, { title: '' }, { em: true }],
    }],
  })
  const bullets = deck.slides[0].bullets
  assert.deepEqual(bullets.map((b) => b.text), ['纯文本', '2', '对象文本', '取 title', '取 value', '取 label'])
  assert.deepEqual(bullets.map((b) => b.level), [0, 0, 2, 0, 0, 0])
  // 对象写法的要点统一补齐 bold/em 布尔字段（字符串/数字简写不补）
  assert.equal(bullets.slice(2).every((b) => typeof b.bold === 'boolean' && typeof b.em === 'boolean'), true)
})

test('normalizeDeck：bullets 的 level 夹在 0-2，颜色等可选字段保留', () => {
  const { deck } = normalizeDeck({
    slides: [{
      layout: 'bullets',
      bullets: [
        { text: '负层级', level: -3 },
        { text: '高亮', level: '1', bold: true, em: true, color: '#FFC53D' },
        { text: '超上限', level: 99 },
      ],
    }],
  })
  const [first, second, third] = deck.slides[0].bullets
  assert.equal(first.level, 0)
  assert.equal(second.level, 1)
  assert.equal(second.bold, true)
  assert.equal(second.em, true)
  assert.equal(second.color, '#FFC53D')
  assert.equal(third.level, 2)
})

test('normalizeDeck：items 在缺 bullets 时作为 bullets 的别名', () => {
  const withItems = normalizeDeck({ slides: [{ layout: 'bullets', items: ['来自 items'] }] }).deck
  assert.equal(withItems.slides[0].bullets[0].text, '来自 items')
  const both = normalizeDeck({ slides: [{ layout: 'bullets', bullets: ['b'], items: ['i'] }] }).deck
  assert.deepEqual(both.slides[0].bullets.map((b) => b.text), ['b'])
})

test('normalizeDeck：columns 最多 3 列并归一化 bullets', () => {
  const { deck } = normalizeDeck({
    slides: [{
      layout: 'two-col',
      columns: [
        { title: 'A', bullets: ['a1', { text: 'a2' }] },
        { title: 1, items: ['b1'] },
        { title: 'C' },
        { title: 'D 会被裁掉' },
      ],
    }],
  })
  const columns = deck.slides[0].columns
  assert.equal(columns.length, 3)
  assert.equal(columns[1].title, '1')
  assert.deepEqual(columns[1].bullets.map((b) => b.text), ['b1'])
  assert.deepEqual(columns[2].bullets, [])
})

test('normalizeDeck：cards 最多 6 张，body 从 text 兜底', () => {
  const cards = Array.from({ length: 8 }, (_, i) => ({ title: `卡片${i}`, text: `正文${i}`, icon: '★' }))
  const { deck } = normalizeDeck({ slides: [{ layout: 'cards', cards }] })
  const normalized = deck.slides[0].cards
  assert.equal(normalized.length, 6)
  assert.equal(normalized[0].title, '卡片0')
  assert.equal(normalized[0].body, '正文0')
  assert.equal(normalized[0].icon, '★')
})

test('normalizeDeck：kpi 支持 stats 别名、value/number 双写法且最多 4 项', () => {
  const { deck } = normalizeDeck({
    slides: [{
      layout: 'kpi',
      stats: [
        { number: 12.4, unit: '亿元', label: '营收', delta: '+18%' },
        { value: '38', title: '占比' },
        { value: '61' },
        { value: '4' },
        { value: '5' },
      ],
    }],
  })
  const kpi = deck.slides[0].kpi
  assert.equal(kpi.length, 4)
  assert.equal(kpi[0].value, '12.4')
  assert.equal(kpi[0].unit, '亿元')
  assert.equal(kpi[1].label, '占比')
  assert.equal(kpi[0].delta, '+18%')
})

test('normalizeDeck：steps 最多 6 步，desc 从 text 兜底', () => {
  const steps = Array.from({ length: 8 }, (_, i) => ({ time: `第${i}周`, title: `步骤${i}`, text: `说明${i}` }))
  const { deck } = normalizeDeck({ slides: [{ layout: 'process', steps }] })
  const normalized = deck.slides[0].steps
  assert.equal(normalized.length, 6)
  assert.equal(normalized[0].time, '第0周')
  assert.equal(normalized[0].title, '步骤0')
  assert.equal(normalized[0].desc, '说明0')
})

test('normalizeDeck：table 表头/单元格转字符串，行数截断到 20', () => {
  const rows = Array.from({ length: 25 }, (_, i) => [`第${i}行`, i, null])
  const { deck } = normalizeDeck({
    slides: [{ layout: 'table', table: { head: ['名称', 2026], rows, widths: ['1.4', 1] } }],
  })
  const table = deck.slides[0].table
  assert.deepEqual(table.head, ['名称', '2026'])
  assert.equal(table.rows.length, 20)
  assert.deepEqual(table.rows[0], ['第0行', '0', ''])
  assert.deepEqual(table.widths, [1.4, 1])
})

test('normalizeDeck：chart 默认 bar，空值转 null、数字转 Number', () => {
  const { deck } = normalizeDeck({
    slides: [{
      layout: 'chart',
      chart: {
        categories: ['Q1', 2],
        series: [{ name: 'A', values: [1, '2.5', '', null, undefined] }],
        numberFormat: '0.0%',
      },
    }],
  })
  const chart = deck.slides[0].chart
  assert.equal(chart.type, 'bar')
  assert.deepEqual(chart.categories, ['Q1', '2'])
  assert.equal(chart.series[0].name, 'A')
  assert.equal(chart.series[0].values[0], 1)
  assert.equal(chart.series[0].values[1], 2.5)
  assert.equal(chart.series[0].values[2], null)
  assert.equal(chart.series[0].values[3], null)
  assert.equal(chart.series[0].values[4], null)
  assert.equal(chart.numberFormat, '0.0%')
  const defaulted = normalizeDeck({ slides: [{ layout: 'chart', chart: { categories: [], series: [] } }] }).deck
  assert.equal(defaulted.slides[0].chart.type, 'bar')
})

test('normalizeDeck：compare 的 left/right 归一化', () => {
  const { deck } = normalizeDeck({
    slides: [{ layout: 'compare', left: { title: 1, items: ['优点'] }, right: { title: 'B', bullets: ['缺点'] } }],
  })
  assert.equal(deck.slides[0].left.title, '1')
  assert.deepEqual(deck.slides[0].left.items.map((b) => b.text), ['优点'])
  assert.equal(deck.slides[0].right.title, 'B')
  assert.deepEqual(deck.slides[0].right.items.map((b) => b.text), ['缺点'])
})

test('normalizeDeck：超过 120 页的 slide 被截断', () => {
  const slides = Array.from({ length: 125 }, (_, i) => ({ layout: 'bullets', title: `页${i}` }))
  const { deck } = normalizeDeck({ slides })
  assert.equal(deck.slides.length, 120)
})

// ── lintDeck ──────────────────────────────────────────────────────────

function coverSlide(extra = {}) {
  return { layout: 'cover', title: '把增长押在三个确定性上', notes: '开场结论', ...extra }
}

function cleanDeck() {
  return {
    title: '干净的小 deck',
    slides: [
      coverSlide(),
      {
        layout: 'bullets',
        title: '下半年只做三件事',
        notes: '三件事分别是……',
        bullets: ['把直营门店数翻一倍', '续费率提到八成五', '建立海外供应通道'],
      },
      { layout: 'end', title: '谢谢观看', notes: '收尾 ask' },
    ],
  }
}

test('lintDeck：空 deck 报 error，score 有界', () => {
  const report = lintDeck({ slides: [] })
  const codes = report.issues.map((issue) => issue.code)
  assert.ok(codes.includes('empty'))
  assert.equal(report.stats.slides, 0)
  assert.ok(report.score >= 0 && report.score <= 100)
})

test('lintDeck：首屏不是封面、末屏不是结束页会提示', () => {
  const report = lintDeck({
    slides: [
      { layout: 'bullets', title: '第一页', notes: 'x', bullets: ['a'] },
      { layout: 'bullets', title: '第二页', notes: 'x', bullets: ['b'] },
    ],
  })
  const codes = report.issues.map((issue) => issue.code)
  assert.ok(codes.includes('no-cover'))
  assert.ok(codes.includes('no-end'))
})

test('lintDeck：要点超过 5 条是 error，5 条是 info', () => {
  const tooMany = lintDeck({
    slides: [{ layout: 'bullets', title: '要点过多', notes: 'x', bullets: ['a', 'b', 'c', 'd', 'e', 'f'] }],
  })
  const blocked = tooMany.issues.find((issue) => issue.code === 'too-many-bullets')
  assert.equal(blocked.level, 'error')

  const five = lintDeck({
    slides: [{ layout: 'bullets', title: '正好五条', notes: 'x', bullets: ['a', 'b', 'c', 'd', 'e'] }],
  })
  const hint = five.issues.find((issue) => issue.code === 'five-bullets')
  assert.equal(hint.level, 'info')
})

test('lintDeck：没有任何页面的 deck 不能被误判为通过', () => {
  const report = lintDeck({})
  assert.equal(report.stats.errors >= 1, true)
  assert.ok(report.score < 100)
})

test('lintDeck：标题过长、栏目标题、空标题、空话都有对应提示', () => {
  const report = lintDeck({
    slides: [
      coverSlide({ title: '一'.repeat(35) }),
      coverSlide({ title: '关于 Q3 的汇报' }),
      coverSlide({ title: '背景' }),
      coverSlide({ title: '用生态打法赋能增长' }),
    ],
  })
  const codes = report.issues.map((issue) => issue.code)
  assert.ok(codes.includes('long-title'))
  assert.ok(codes.includes('vague-title'))
  assert.ok(codes.includes('empty-title'))
  assert.ok(codes.includes('buzzword'))
})

test('lintDeck：长要点与「数字裸写」会被建议改版式', () => {
  // 注意：lintDeck 面向 normalizeDeck 之后的形状，bullets 已是 {text, level}
  const { deck } = normalizeDeck({
    slides: [{
      layout: 'bullets',
      title: '数字都堆在文字里',
      notes: 'x',
      bullets: [
        '营收增长 123%，门店达到 456 家，客单价 789 元',
        '总共 12 个区域，覆盖 34 个城市，复购 56%',
        '人员 78 人，预算 90 万，周期 11 个月',
        '这是一条超过二十八个字的很长很长的要点用来触发长要点提示',
      ],
    }],
  })
  const report = lintDeck(deck)
  const codes = report.issues.map((issue) => issue.code)
  assert.ok(codes.includes('numbers-in-text'), '要点里裸写数字应提示改用 kpi/chart')
  assert.ok(codes.includes('data-as-text'), '整页都是数字时应建议换数据版式')
  assert.ok(codes.includes('long-bullet'), '过长要点应提示压缩')
})

test('lintDeck：图表缺少数据、系列长度不一致是 error', () => {
  const empty = lintDeck({
    slides: [{ layout: 'chart', title: '缺数据', notes: 'x' }],
  })
  assert.ok(empty.issues.some((issue) => issue.code === 'chart-empty' && issue.level === 'error'))

  const mismatch = lintDeck({
    slides: [{
      layout: 'chart',
      title: '数据对不上',
      notes: 'x',
      insight: '说明',
      chart: { type: 'bar', categories: ['Q1', 'Q2'], series: [{ name: 'A', values: [1] }] },
    }],
  })
  assert.ok(mismatch.issues.some((issue) => issue.code === 'chart-mismatch' && issue.level === 'error'))
})

test('lintDeck：表格缺表头是 error，行列不齐是 warn', () => {
  const noHead = lintDeck({ slides: [{ layout: 'table', title: '缺表头', notes: 'x', table: { rows: [['a']] } }] })
  assert.ok(noHead.issues.some((issue) => issue.code === 'table-no-head' && issue.level === 'error'))

  const ragged = lintDeck({
    slides: [{
      layout: 'table',
      title: '行列不齐',
      notes: 'x',
      table: { head: ['A', 'B', 'C'], rows: [['1', '2']] },
    }],
  })
  assert.ok(ragged.issues.some((issue) => issue.code === 'table-width' && issue.level === 'warn'))
})

test('lintDeck：图文页缺图是 error，指标超过 4 个是 warn，缺讲稿是 warn', () => {
  const report = lintDeck({
    slides: [
      { layout: 'image', title: '只剩图' },
      {
        layout: 'kpi',
        title: '指标太多',
        notes: 'x',
        kpi: [{ value: '1' }, { value: '2' }, { value: '3' }, { value: '4' }, { value: '5' }],
      },
    ],
  })
  const byCode = new Map(report.issues.map((issue) => [issue.code, issue]))
  assert.equal(byCode.get('image-missing')?.level, 'error')
  assert.equal(byCode.get('kpi-many')?.level, 'warn')
  assert.equal(byCode.get('no-notes')?.level, 'warn')
})

test('lintDeck：连续 3 页要点页会提示节奏单调', () => {
  const slides = Array.from({ length: 3 }, (_, i) => ({
    layout: 'bullets',
    title: `第${i + 1}页`,
    notes: 'x',
    bullets: ['一', '二', '三'],
  }))
  const codes = lintDeck({ slides }).issues.map((issue) => issue.code)
  assert.ok(codes.includes('monotone'))
})

test('lintDeck：8 页以上缺视觉页与数据页会给出 info', () => {
  const slides = Array.from({ length: 8 }, (_, i) => ({
    layout: 'bullets',
    title: `要点页${i + 1}`,
    notes: 'x',
    bullets: ['一', '二'],
  }))
  const codes = lintDeck({ slides }).issues.map((issue) => issue.code)
  assert.ok(codes.includes('no-visual'))
  assert.ok(codes.includes('no-data'))
})

test('lintDeck：合格的 deck 没有 error/warn，score 接近满分', () => {
  const report = lintDeck(cleanDeck())
  assert.deepEqual(report.issues.filter((issue) => issue.level !== 'info'), [])
  assert.ok(report.score >= 90, `score 应 ≥ 90，实际 ${report.score}`)
  assert.equal(report.stats.errors, 0)
  assert.equal(report.stats.warnings, 0)
  assert.equal(report.stats.slides, 3)
  assert.deepEqual(report.stats.layouts, { cover: 1, bullets: 1, end: 1 })
})

test('formatLint：输出分数、页数与可执行改法', () => {
  const clean = formatLint(lintDeck(cleanDeck()))
  assert.match(clean, /设计审校：\d+\/100/)
  assert.match(clean, /3 页/)

  const bad = formatLint(lintDeck({ slides: [] }))
  assert.match(bad, /✗ 必须改/)
  assert.match(bad, /deck 没有任何页面/)
  assert.match(bad, /至少给一个 cover 页/)
})
