/**
 * lib/engine.js 单元测试：slugify、DSH_HOME 路径解析、模板仓库增删查往返。
 *
 * 关键点：所有写操作都落在 os.tmpdir() 下的临时 DSH_HOME 里，
 * 绝不动真实用户目录（~/.dsh），也不依赖本机固定路径。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  SCRIPT_PATH,
  resolveHome,
  storeDir,
  slugify,
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
} from '../../lib/engine.js'
import { tempHome } from './_helpers.mjs'

// ── slugify ───────────────────────────────────────────────────────────

test('slugify：空格转连字符、非法文件名字符删除', () => {
  assert.equal(slugify('Q3 Growth Plan'), 'Q3-Growth-Plan')
  assert.equal(slugify('2026 增长 报告'), '2026-增长-报告')
  assert.equal(slugify('a/b:c*d?e"f<g>h|i'), 'abcdefghi')
})

test('slugify：压缩连续连字符、去掉首尾连字符与点', () => {
  assert.equal(slugify('  --hello---world--  '), 'hello-world')
  assert.equal(slugify('...deck...'), 'deck')
  assert.equal(slugify('a    b'), 'a-b')
})

test('slugify：空输入回退 fallback，默认 deck', () => {
  assert.equal(slugify(''), 'deck')
  assert.equal(slugify(undefined), 'deck')
  assert.equal(slugify(null), 'deck')
  assert.equal(slugify('   '), 'deck')
  assert.equal(slugify('///'), 'deck')
  assert.equal(slugify('', 'custom'), 'custom')
  assert.equal(slugify(null, 'custom'), 'custom')
})

test('slugify：超长输入截断到 60 字符', () => {
  assert.equal(slugify('长'.repeat(100)).length, 60)
  assert.equal(slugify('a '.repeat(80)).length, 60)
  const shortened = slugify('word '.repeat(30))
  assert.ok(shortened.length <= 60)
  assert.doesNotMatch(shortened, /^-/)
})

// ── 路径解析 ──────────────────────────────────────────────────────────

test('resolveHome/storeDir：DSH_HOME 指向临时目录时模板仓库随之迁移', () => {
  const home = tempHome()
  try {
    const resolved = resolveHome()
    assert.equal(resolved.home, path.resolve(home.dir))
    assert.match(resolved.source, /^env:/)
    assert.equal(storeDir(), path.join(path.resolve(home.dir), 'ppt-master', 'templates'))
  } finally {
    home.restore()
  }
})

test('resolveHome：DSH_HOME 缺失时回退 DSH_CONFIG_HOME', () => {
  const home = tempHome()
  const dshHome = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    process.env.DSH_CONFIG_HOME = dshHome
    const resolved = resolveHome()
    assert.equal(resolved.home, path.resolve(dshHome))
  } finally {
    home.restore()
  }
})

test('SCRIPT_PATH：指向仓库内的 Python 渲染器且真实存在', () => {
  assert.equal(path.basename(SCRIPT_PATH), 'ppt_build.py')
  assert.equal(path.basename(path.dirname(SCRIPT_PATH)), 'python')
  assert.ok(fs.existsSync(SCRIPT_PATH), `渲染器不存在：${SCRIPT_PATH}`)
})

// ── 模板仓库 ──────────────────────────────────────────────────────────

test('listTemplates：空 DSH_HOME 下只返回内置模板', () => {
  const home = tempHome()
  try {
    assert.equal(fs.existsSync(storeDir()), false)
    const templates = listTemplates()
    assert.ok(templates.length >= 6)
    assert.equal(templates.every((template) => template.origin === 'builtin'), true)
    assert.ok(templates.some((template) => template.id === 'indigo-corporate'))
  } finally {
    home.restore()
  }
})

test('getTemplate：未知 id 报错并列出可用模板', () => {
  const home = tempHome()
  try {
    assert.throws(() => getTemplate('no-such-template-xyz'), /不存在/)
    assert.throws(() => getTemplate(''), /缺少模板 id/)
  } finally {
    home.restore()
  }
})

test('saveTemplate/listTemplates/getTemplate/deleteTemplate：完整往返', () => {
  const home = tempHome()
  try {
    const saved = saveTemplate({
      id: 'qa-custom',
      name: 'QA 自定义模板',
      description: '测试用模板',
      tags: ['qa', 'test'],
      theme: { primary: '#123456', mode: 'light' },
    })
    assert.equal(saved.replaced, false)
    assert.equal(saved.template.id, 'qa-custom')
    assert.ok(fs.existsSync(saved.path), '模板文件应落盘')
    assert.equal(path.dirname(saved.path), storeDir(), '模板文件应落在 storeDir 下')

    const listed = listTemplates()
    const found = listed.find((template) => template.id === 'qa-custom')
    assert.ok(found, 'listTemplates 应包含新模板')
    assert.equal(found.origin, 'user')
    assert.deepEqual(found.tags, ['qa', 'test'])
    assert.equal(found.theme.primary, '#123456')

    const got = getTemplate('qa-custom')
    assert.equal(got.origin, 'user')
    assert.equal(got.template.name, 'QA 自定义模板')
    assert.equal(got.template.theme.mode, 'light')

    // 覆盖保存
    const again = saveTemplate({ id: 'qa-custom', name: 'QA 自定义模板 v2' })
    assert.equal(again.replaced, true)
    assert.equal(getTemplate('qa-custom').template.name, 'QA 自定义模板 v2')

    // 不允许覆盖时抛错
    assert.throws(() => saveTemplate({ id: 'qa-custom', name: 'x', overwrite: false }), /overwrite=false/)

    // 删除后回不到旧状态
    const removed = deleteTemplate('qa-custom')
    assert.equal(removed.id, 'qa-custom')
    assert.equal(fs.existsSync(removed.path), false)
    assert.throws(() => getTemplate('qa-custom'), /不存在/)
    assert.throws(() => deleteTemplate('qa-custom'), /不存在/)
  } finally {
    home.restore()
  }
})

test('saveTemplate：baseOn 派生继承父模板并允许局部覆盖', () => {
  const home = tempHome()
  try {
    const base = getTemplate('indigo-corporate').template
    const saved = saveTemplate({
      baseOn: 'indigo-corporate',
      id: 'qa-derived',
      theme: { primary: '#123456' },
      geometry: { bodySize: 17 },
    })
    const derived = saved.template
    assert.equal(derived.id, 'qa-derived')
    assert.match(derived.name, /派生/, '派生模板默认名应带「派生」标记')
    assert.equal(derived.theme.primary, '#123456')
    assert.equal(derived.theme.bg, base.theme.bg, '未覆盖的主题字段应继承父模板')
    assert.equal(derived.geometry.bodySize, 17)
    assert.equal(derived.geometry.marginX, base.geometry.marginX, '未覆盖的几何字段应继承父模板')

    assert.throws(() => saveTemplate({ baseOn: 'no-such-base', id: 'x' }), /不存在/)
  } finally {
    home.restore()
  }
})

test('saveTemplate：只给 name 时自动用 slug 生成 id', () => {
  const home = tempHome()
  try {
    const saved = saveTemplate({ name: 'QA Named Template' })
    assert.equal(saved.template.id, 'QA-Named-Template')
    assert.equal(path.basename(saved.path), 'QA-Named-Template.json')
    assert.ok(listTemplates().some((template) => template.id === 'QA-Named-Template'))
  } finally {
    home.restore()
  }
})

test('saveTemplate：用户模板可覆盖同名内置模板，删除后恢复内置', () => {
  const home = tempHome()
  try {
    saveTemplate({ id: 'minimal-paper', name: '我的极简', theme: { bg: '#010203', mode: 'light' } })
    const overridden = listTemplates().find((template) => template.id === 'minimal-paper')
    assert.equal(overridden.origin, 'user')
    assert.equal(overridden.name, '我的极简')
    assert.equal(overridden.theme.bg, '#010203')
    assert.equal(getTemplate('minimal-paper').origin, 'user')

    deleteTemplate('minimal-paper')
    const restored = listTemplates().find((template) => template.id === 'minimal-paper')
    assert.equal(restored.origin, 'builtin')
    assert.notEqual(restored.name, '我的极简')
  } finally {
    home.restore()
  }
})

test('deleteTemplate：内置模板不允许删除', () => {
  const home = tempHome()
  try {
    assert.throws(() => deleteTemplate('indigo-corporate'), /内置模板/)
  } finally {
    home.restore()
  }
})

test('模板仓库：坏 JSON 文件不会拖垮整张模板表', () => {
  const home = tempHome()
  try {
    fs.mkdirSync(storeDir(), { recursive: true })
    fs.writeFileSync(path.join(storeDir(), 'broken.json'), '{ not valid json', 'utf8')
    fs.writeFileSync(
      path.join(storeDir(), 'valid.json'),
      JSON.stringify({ id: 'qa-valid', name: '有效模板' }),
      'utf8',
    )
    const templates = listTemplates()
    assert.ok(templates.some((template) => template.id === 'qa-valid'))
    assert.ok(templates.some((template) => template.id === 'indigo-corporate'))
  } finally {
    home.restore()
  }
})

test('模板仓库：不存在的 DSH_HOME 目录会被自动创建', () => {
  const home = tempHome()
  try {
    const nested = path.join(home.dir, 'deep', 'nested')
    process.env.DSH_HOME = nested
    assert.equal(fs.existsSync(storeDir()), false)
    saveTemplate({ id: 'qa-nested', name: '嵌套目录模板' })
    assert.ok(fs.existsSync(storeDir()))
  } finally {
    home.restore()
  }
})

test('模板仓库：读写只发生在临时目录内', () => {
  const home = tempHome()
  try {
    const saved = saveTemplate({ id: 'qa-scope', name: '作用域检查' })
    const resolvedSaved = path.resolve(saved.path)
    const tmpRoot = path.resolve(os.tmpdir())
    assert.ok(resolvedSaved.startsWith(tmpRoot), `模板路径应位于系统临时目录：${resolvedSaved}`)
    assert.ok(resolvedSaved.startsWith(path.resolve(home.dir)), '模板路径应位于临时 DSH_HOME 内')
  } finally {
    home.restore()
  }
})
