/**
 * lib/templates.js 单元测试：内置模板完整性、默认值合并、颜色归一化、深拷贝。
 *
 * 断言对「新增模板」友好：数量用 >= 6 而不是硬编码具体数字，
 * 逐个模板检查必需字段，而不是写死某个模板的配色值。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BUILTIN_TEMPLATES,
  TEMPLATE_DEFAULTS,
  LAYOUT_NAMES,
  builtinTemplates,
  getBuiltinTemplate,
  normalizeTemplate,
  clone,
} from '../../lib/templates.js'

const HEX = /^#[0-9A-F]{6}$/

function assertTemplateShape(template, label) {
  assert.equal(typeof template.id, 'string', `${label}.id 应为字符串`)
  assert.ok(template.id.trim().length > 0, `${label}.id 不应为空`)
  assert.equal(typeof template.name, 'string', `${label}.name 应为字符串`)
  assert.equal(typeof template.description, 'string', `${label}.description 应为字符串`)
  assert.ok(Array.isArray(template.tags), `${label}.tags 应为数组`)
  assert.ok(['16:9', '4:3'].includes(template.aspect), `${label}.aspect 应为 16:9 或 4:3`)

  assert.equal(typeof template.theme, 'object')
  for (const key of ['mode', 'bg', 'bg2', 'surface', 'primary', 'accent', 'text', 'textDim', 'line']) {
    assert.equal(typeof template.theme[key], 'string', `${label}.theme.${key} 应为字符串`)
  }
  assert.match(template.theme.bg, HEX, `${label}.theme.bg 应为 #RRGGBB`)
  assert.match(template.theme.primary, HEX, `${label}.theme.primary 应为 #RRGGBB`)
  assert.ok(['dark', 'light'].includes(template.theme.mode), `${label}.theme.mode 应为 dark/light`)

  assert.equal(typeof template.fonts?.title?.latin, 'string', `${label}.fonts.title.latin 缺失`)
  assert.equal(typeof template.fonts?.body?.ea, 'string', `${label}.fonts.body.ea 缺失`)

  assert.equal(typeof template.geometry?.marginX, 'number', `${label}.geometry.marginX 应为数字`)
  assert.equal(typeof template.geometry?.bodySize, 'number', `${label}.geometry.bodySize 应为数字`)
  assert.ok(template.geometry.marginX > 0, `${label}.geometry.marginX 应大于 0`)

  assert.equal(typeof template.decor?.style, 'string', `${label}.decor.style 缺失`)
}

test('builtinTemplates：至少 6 套内置模板，id 唯一', () => {
  const templates = builtinTemplates()
  assert.ok(templates.length >= 6, `内置模板应 ≥ 6 套，实际 ${templates.length}`)
  const ids = templates.map((template) => template.id)
  assert.equal(new Set(ids).size, ids.length, '内置模板 id 不应重复')
  assert.ok(ids.includes('indigo-corporate'), '应保留默认模板 indigo-corporate')
})

test('builtinTemplates：每套模板字段完整、颜色为 #RRGGBB', () => {
  for (const template of builtinTemplates()) {
    assertTemplateShape(template, template.id)
  }
})

test('builtinTemplates：返回深拷贝，调用方修改不污染内置常量', () => {
  const first = builtinTemplates()[0]
  const originalBg = first.theme.bg
  first.theme.bg = '#000000'
  first.name = '被改坏了'
  const second = builtinTemplates()[0]
  assert.equal(second.theme.bg, originalBg)
  assert.notEqual(second.name, '被改坏了')
  assert.notEqual(BUILTIN_TEMPLATES[0].theme.bg, '#000000')
})

test('getBuiltinTemplate：命中返回归一化模板，未知 id 返回 undefined', () => {
  const template = getBuiltinTemplate('indigo-corporate')
  assert.ok(template)
  assertTemplateShape(template, 'indigo-corporate')
  assert.equal(getBuiltinTemplate('no-such-template'), undefined)
  assert.equal(getBuiltinTemplate(''), undefined)
})

test('normalizeTemplate：支持只给字符串 id', () => {
  const template = normalizeTemplate('my-deck')
  assert.equal(template.id, 'my-deck')
  assert.equal(template.name, 'my-deck')
  assert.deepEqual(template.tags, [])
  assert.equal(template.description, '')
})

test('normalizeTemplate：缺省字段从 TEMPLATE_DEFAULTS 补齐', () => {
  const template = normalizeTemplate({ id: 'defaults-only' })
  assert.equal(template.aspect, TEMPLATE_DEFAULTS.aspect)
  assert.equal(template.theme.mode, TEMPLATE_DEFAULTS.theme.mode)
  assert.equal(template.fonts.title.latin, TEMPLATE_DEFAULTS.fonts.title.latin)
  assert.equal(template.geometry.marginX, TEMPLATE_DEFAULTS.geometry.marginX)
  assert.equal(template.decor.style, TEMPLATE_DEFAULTS.decor.style)
})

test('normalizeTemplate：用户字段覆盖默认值，其余字段保留默认', () => {
  const template = normalizeTemplate({
    id: 'override-me',
    name: '覆盖测试',
    aspect: '4:3',
    theme: { primary: '#ff0000', mode: 'light' },
    geometry: { bodySize: 18 },
  })
  assert.equal(template.name, '覆盖测试')
  assert.equal(template.aspect, '4:3')
  assert.equal(template.theme.primary, '#FF0000')
  assert.equal(template.theme.mode, 'light')
  assert.equal(template.geometry.bodySize, 18)
  // 没覆盖的字段仍来自默认值
  assert.equal(template.theme.bg, TEMPLATE_DEFAULTS.theme.bg)
  assert.equal(template.geometry.marginX, TEMPLATE_DEFAULTS.geometry.marginX)
})

test('normalizeTemplate：非法 aspect 回退 16:9', () => {
  assert.equal(normalizeTemplate({ id: 'x', aspect: '21:9' }).aspect, '16:9')
  assert.equal(normalizeTemplate({ id: 'x', aspect: '4:3' }).aspect, '4:3')
})

test('normalizeTemplate：3 位颜色补成 6 位并统一大写', () => {
  const template = normalizeTemplate({ id: 'color', theme: { primary: 'abc', accent: '#f0c' } })
  assert.equal(template.theme.primary, '#AABBCC')
  assert.equal(template.theme.accent, '#FF00CC')
})

test('normalizeTemplate：默认值之外的自定义字段保留', () => {
  const template = normalizeTemplate({ id: 'extra', note: '团队内部模板', tags: ['自定义', 42] })
  assert.equal(template.note, '团队内部模板')
  assert.deepEqual(template.tags, ['自定义', '42'])
})

test('normalizeTemplate：缺少 id/name 时抛错', () => {
  assert.throws(() => normalizeTemplate({}), /缺少 id/)
  assert.throws(() => normalizeTemplate({ name: '   ' }), /缺少 id/)
  assert.throws(() => normalizeTemplate(null), /缺少 id/)
})

test('clone：深拷贝且互不影响', () => {
  const source = { a: 1, nested: { list: [1, 2], text: 'x' } }
  const copy = clone(source)
  assert.notEqual(copy, source)
  assert.notEqual(copy.nested, source.nested)
  assert.deepEqual(copy, source)
  copy.nested.list.push(3)
  assert.deepEqual(source.nested.list, [1, 2])
})

test('LAYOUT_NAMES：核心版式齐全、无重复、至少 14 种', () => {
  assert.ok(LAYOUT_NAMES.length >= 14)
  assert.equal(new Set(LAYOUT_NAMES).size, LAYOUT_NAMES.length)
  for (const layout of ['cover', 'bullets', 'kpi', 'chart', 'table', 'end']) {
    assert.ok(LAYOUT_NAMES.includes(layout))
  }
})
