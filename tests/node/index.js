/**
 * 目录入口兼容层。
 *
 * Node 20 的测试运行器支持目录参数（`node --test tests/node/` 会递归搜索
 * `*.test.js`）；Node 21+ 改为 glob 语义，目录参数会按普通模块解析。
 * 这里显式 import 各测试文件，使 `node --test tests/node/` 在两种语义下都能
 * 真正跑到全部用例（Node 20 的目录搜索不会匹配本文件，因此不会重复执行）。
 *
 * 日常与 CI 推荐更明确的写法：`node --test tests/node/*.test.js`。
 */

import './deck.test.js'
import './templates.test.js'
import './engine.test.js'
import './example-deck.test.js'
