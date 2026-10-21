/**
 * 测试共用工具（零第三方依赖）。
 *
 * 约定：测试代码不写死本机路径 —— 仓库根目录由 import.meta.url 反推，
 * 临时目录一律走 os.tmpdir()，因此 Windows / macOS / Linux 与 CI 行为一致。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LIB_DIR = path.join(REPO_ROOT, 'lib')

/** 读仓库内的 JSON 文件（相对仓库根）。 */
export function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'))
}

/**
 * 建一个临时 DSH_HOME，指向它并屏蔽 DSH_CONFIG_HOME。
 * 返回的 restore() 会恢复环境变量并删除临时目录 —— 放在 try/finally 里用。
 */
export function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ppt-master-test-'))
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_CONFIG_HOME: process.env.DSH_CONFIG_HOME,
  }
  process.env.DSH_HOME = dir
  delete process.env.DSH_CONFIG_HOME
  return {
    dir,
    restore() {
      if (previous.DSH_HOME === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous.DSH_HOME
      if (previous.DSH_CONFIG_HOME === undefined) delete process.env.DSH_CONFIG_HOME
      else process.env.DSH_CONFIG_HOME = previous.DSH_CONFIG_HOME
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
