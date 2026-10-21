/**
 * examples/demo-deck.json 的契约测试。
 *
 * 示例 deck 是仓库的「活文档」：既要覆盖核心版式，也要自身通过设计审校，
 * 这样 `node scripts/render-example.mjs` 才有可复现的基准输出。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readJson } from './_helpers.mjs'
import { normalizeDeck, lintDeck } from '../../lib/deck.js'
import { builtinTemplates } from '../../lib/templates.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const demo = readJson(path.join('examples', 'demo-deck.json'))

test('demo-deck：8-10 页，首封面尾结束页', () => {
  assert.ok(Array.isArray(demo.slides))
  assert.ok(demo.slides.length >= 8 && demo.slides.length <= 10, `应为 8-10 页，实际 ${demo.slides.length}`)
  assert.equal(demo.slides[0].layout, 'cover')
  assert.equal(demo.slides[demo.slides.length - 1].layout, 'end')
})

test('demo-deck：覆盖核心版式', () => {
  const layouts = demo.slides.map((slide) => slide.layout)
  for (const layout of ['cover', 'kpi', 'chart', 'table', 'bullets', 'compare', 'end']) {
    assert.ok(layouts.includes(layout), `示例 deck 应覆盖 ${layout} 版式，实际：${layouts.join(', ')}`)
  }
})

test('demo-deck：每页都有讲稿 notes', () => {
  demo.slides.forEach((slide, index) => {
    assert.equal(typeof slide.notes, 'string', `第 ${index + 1} 页缺 notes`)
    assert.ok(slide.notes.trim().length > 0, `第 ${index + 1} 页 notes 为空`)
  })
})

test('demo-deck：chart 分类数与每个系列数据点数量一致', () => {
  for (const slide of demo.slides.filter((one) => one.layout === 'chart')) {
    const categories = slide.chart.categories
    assert.ok(categories.length > 0)
    assert.ok(slide.chart.series.length > 0)
    for (const series of slide.chart.series) {
      assert.equal(series.values.length, categories.length, `系列 ${series.name} 数据点数量与分类数不一致`)
    }
  }
})

test('demo-deck：table 每行列数与表头一致', () => {
  for (const slide of demo.slides.filter((one) => one.layout === 'table')) {
    const head = slide.table.head
    assert.ok(head.length > 0)
    for (const row of slide.table.rows) assert.equal(row.length, head.length)
  }
})

test('demo-deck：引用的模板是内置模板', () => {
  assert.equal(typeof demo.template, 'string')
  assert.ok(
    builtinTemplates().some((template) => template.id === demo.template),
    `deck.template = ${demo.template} 不在内置模板中`,
  )
})

test('demo-deck：归一化无告警，设计审校无 error/warn', () => {
  const { deck, warnings } = normalizeDeck(demo)
  assert.deepEqual(warnings, [])
  assert.equal(deck.slides.length, demo.slides.length)
  assert.equal(deck.slides[0].layout, 'cover')
  assert.equal(deck.slides[deck.slides.length - 1].layout, 'end')

  const report = lintDeck(deck)
  const blocking = report.issues.filter((issue) => issue.level !== 'info')
  assert.deepEqual(blocking, [], `示例 deck 不应有 error/warn 级问题：\n${JSON.stringify(blocking, null, 2)}`)
  assert.ok(report.score >= 90, `示例 deck 审校分应 ≥ 90，实际 ${report.score}`)
})

test('scripts/render-example.mjs --dry-run：退出码 0 且不依赖产物文件存在', () => {
  // 回归保护：dryRun 不生成 .pptx，脚本不能对产物做 stat（CI 曾因此 ENOENT 失败）。
  const script = path.join(ROOT, 'scripts', 'render-example.mjs')
  const result = spawnSync(process.execPath, [script, '--dry-run'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env },
  })
  assert.equal(result.status, 0, `dry-run 应成功，stderr：${result.stderr}`)
  assert.match(result.stdout, /dry-run 通过/)
  assert.match(result.stdout, /设计审校：\d+\/100/)
})
