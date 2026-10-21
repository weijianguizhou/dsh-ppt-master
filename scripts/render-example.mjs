#!/usr/bin/env node
/**
 * 一键渲染示例 deck：把 examples/demo-deck.json 渲染成真实的 .pptx。
 *
 * 零 npm 依赖：只 import Node 内建模块与仓库自带的 lib/engine.js；
 * Python 解释器由 engine.js 自动探测（也可用 --python 或 DSH_PPT_PYTHON 指定）。
 *
 * 用法：
 *   node scripts/render-example.mjs                     # 输出 examples/out/demo-deck.pptx（含预览图）
 *   node scripts/render-example.mjs --no-preview        # 只出 PPTX，适合 CI / 无 Pillow 环境
 *   node scripts/render-example.mjs --out /tmp/x.pptx   # 自定义输出路径
 *   node scripts/render-example.mjs --dry-run           # 只做归一化 + 设计审校，不调用渲染器
 *
 * 退出码：0 成功；1 失败（结果里带 error / trace / log）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPresentation } from '../lib/engine.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DECK = path.join(ROOT, 'examples', 'demo-deck.json')
const DEFAULT_OUT = path.join(ROOT, 'examples', 'out', 'demo-deck.pptx')

const USAGE = `用法：node scripts/render-example.mjs [选项]

选项：
  --deck <path>      要渲染的 deck JSON（默认 examples/demo-deck.json）
  --out <path>       PPTX 输出路径（默认 examples/out/demo-deck.pptx）
  --out-dir <dir>    输出目录（未给 --out 时生效）
  --template <id>    覆盖 deck 里的模板（如 indigo-corporate / minimal-paper）
  --preview          生成全页预览 PNG（默认开启）
  --no-preview       不生成预览 PNG（CI / 无 Pillow 时用）
  --python <path>    指定 Python 解释器（缺省自动探测）
  --dry-run          只做归一化与设计审校，不调用渲染器
  --keep-temp        保留渲染临时目录（排查用）
  -h, --help         显示本帮助
`

export function parseArgs(argv) {
  const args = { preview: true }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true
        break
      case '--deck':
        args.deck = argv[++i]
        break
      case '--out':
        args.out = argv[++i]
        break
      case '--out-dir':
        args.outDir = argv[++i]
        break
      case '--template':
        args.template = argv[++i]
        break
      case '--preview':
        args.preview = true
        break
      case '--no-preview':
        args.preview = false
        break
      case '--python':
        args.python = argv[++i]
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--keep-temp':
        args.keepTemp = true
        break
      default:
        throw new Error(`未知参数：${flag}（用 --help 查看用法）`)
    }
  }
  return args
}

function rel(target) {
  const relative = path.relative(ROOT, target)
  return relative && !relative.startsWith('..') ? relative : target
}

function kb(bytes) {
  return `${(Number(bytes || 0) / 1024).toFixed(1)} KB`
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const deckPath = path.resolve(args.deck || DEFAULT_DECK)
  if (!fs.existsSync(deckPath)) throw new Error(`deck 文件不存在：${deckPath}`)
  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(args.outDir ? path.resolve(args.outDir) : path.dirname(DEFAULT_OUT), path.basename(DEFAULT_OUT))

  const t0 = Date.now()
  const result = await buildPresentation(
    {
      deckPath,
      ...(args.template ? { template: args.template } : {}),
      out: outPath,
      preview: args.preview,
      dryRun: Boolean(args.dryRun),
      keepTemp: Boolean(args.keepTemp),
      ...(args.python ? { python: args.python } : {}),
    },
    {},
    undefined,
  )
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  if (!result.ok) {
    process.stderr.write(`✗ 渲染失败：${result.error || '未知错误'}\n`)
    if (result.attempts) process.stderr.write(`  Python 尝试：${JSON.stringify(result.attempts)}\n`)
    if (result.trace) process.stderr.write(`  trace：\n${result.trace}\n`)
    if (result.log) process.stderr.write(`  日志：\n${result.log}\n`)
    return 1
  }

  const lint = result.lint || {}
  // dry-run 不产出文件，不能 stat；显式区分，避免无意义地抛 ENOENT。
  const size = result.bytes
    ? kb(result.bytes)
    : fs.existsSync(outPath)
      ? kb(fs.statSync(outPath).size)
      : '未生成'
  process.stdout.write(`✓ ${result.dryRun ? 'dry-run 通过' : '渲染成功'}：${rel(outPath)}（${size}）\n`)
  process.stdout.write(`  · ${result.slides} 页 · 模板 ${result.template}（${result.templateOrigin || 'builtin'}）\n`)
  process.stdout.write(`  · 版式：${(result.layouts || []).join(' / ')}\n`)
  process.stdout.write(`  · 设计审校：${lint.score}/100（错误 ${lint.stats?.errors ?? 0} · 警告 ${lint.stats?.warnings ?? 0} · 建议 ${lint.stats?.infos ?? 0}）\n`)
  if (result.preview) process.stdout.write(`  · 预览图：${rel(result.preview)}\n`)
  if (result.python) process.stdout.write(`  · Python：${result.python}\n`)
  if (result.pythonPptx) process.stdout.write(`  · python-pptx：${result.pythonPptx}\n`)
  if (result.warnings?.length) {
    process.stdout.write(`  · 警告（${result.warnings.length}）：\n`)
    for (const warning of result.warnings) process.stdout.write(`    - ${warning}\n`)
  }
  process.stdout.write(`  · 耗时 ${elapsed}s\n`)
  if (result.dryRun) process.stdout.write('  （dryRun：未调用渲染器）\n')
  else process.stdout.write(`回读校验：python -c "from pptx import Presentation; print(len(Presentation(r'${outPath}').slides), 'slides')"\n`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      const message = error?.message || String(error)
      process.stderr.write(`✗ ${message}\n`)
      if (process.env.PPT_EXAMPLE_DEBUG) process.stderr.write(`${error?.stack || ''}\n`)
      process.exitCode = 1
    })
}

export { main }
