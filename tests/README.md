# 测试与示例

本目录是 `dsh-ppt-master` 的测试与示例说明。测试**零第三方依赖**：Node 侧只用内建
`node:test`，Python 侧只用 `unittest` + 运行时依赖 `python-pptx` / `pillow`。

```
tests/
├── node/                    # Node 内建测试（node --test）
│   ├── _helpers.mjs         # 临时 DSH_HOME、仓库根路径等公共工具
│   ├── index.js             # 目录入口兼容层（让 Node 21+ 也能跑目录参数）
│   ├── deck.test.js         # 版式解析 / deck 归一化 / 设计审校
│   ├── templates.test.js    # 内置模板完整性 / 默认值合并 / 颜色归一化
│   ├── engine.test.js       # slugify / 路径解析 / 模板仓库增删查往返
│   └── example-deck.test.js # examples/demo-deck.json 的契约测试
└── python/
    └── test_render.py       # 渲染器契约 + 真实渲染 + python-pptx 回读
```

## 一次跑完全部

在**仓库根目录**执行：

```bash
# Node 单元测试（零依赖，不需要 npm install）
node --test tests/node/*.test.js

# Python 渲染器测试（先安装运行时依赖）
python -m pip install python-pptx pillow
python -m unittest discover -s tests/python -v
```

仓库根目录的 `package.json` 里也提供了等价脚本：

```bash
npm test            # node --test
npm run test:python # unittest discover
npm run test:all    # 两者都跑
npm run example     # 渲染示例 deck
```

> **Node 版本提示**：Node 20 原生支持目录参数 `node --test tests/node/`；
> Node 21+ 的测试运行器改用 glob 语义，仓库通过 `tests/node/index.js` 显式
> import 各测试文件，使目录形式在 Node 21+ 上同样能跑到全部用例（失败会正常
> 传播退出码）。跨版本最稳的写法仍是 `node --test tests/node/*.test.js`
> —— 命令里的 `*` 由 shell 先展开成显式文件列表，Node 20/22/24 都支持。

## 用仓库自带的运行时跑（Windows 本机示例）

DSH 自带 Node 与 Python，直接给绝对路径即可（仅作本机示例，测试代码本身不依赖这些路径）：

```powershell
$NODE = "D:\DSH\home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$PY   = "D:\DSH\home\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

& $NODE --test tests/node/*.test.js
& $PY -m unittest discover -s tests/python -v
& $NODE scripts/render-example.mjs
```

## 示例 deck：`examples/demo-deck.json`

9 页示例，覆盖 `cover / section / kpi / chart / table / bullets / compare / quote / end`，
数据自洽、每页都有讲稿，且能通过设计审校（100/100）。它是仓库的「活文档」：
`tests/node/example-deck.test.js` 会校验页数、版式覆盖、图表系列与表格列对齐、
讲稿齐备、审校无 error/warn。

一键渲染到 `examples/out/`：

```bash
node scripts/render-example.mjs                     # PPTX + 预览 PNG
node scripts/render-example.mjs --no-preview        # 只出 PPTX（CI / 无 Pillow）
node scripts/render-example.mjs --dry-run           # 只做归一化 + 设计审校
node scripts/render-example.mjs --out /tmp/x.pptx   # 自定义输出路径
node scripts/render-example.mjs --python /path/to/python   # 指定解释器
```

脚本零 npm 依赖，内部复用 `lib/engine.js` 的 `buildPresentation`；Python 解释器
按 `--python` → `DSH_PPT_PYTHON` → 宿主自带 → `python3` / `python` 的顺序探测。

## 测试环境约定

- **不写死本机路径**：仓库根目录由 `import.meta.url` / `__file__` 反推，临时文件一律
  走 `os.tmpdir()`（Node 侧 `fs.mkdtempSync`，Python 侧 `tempfile.mkdtemp`）。
- **不污染真实 DSH_HOME**：模板仓库测试把 `process.env.DSH_HOME` 指向临时目录，
  测试结束后恢复环境变量并删除目录；不会读写 `~/.dsh`。
- **python-pptx / Pillow 缺失时 skip 而不是 fail**：`tests/python/test_render.py`
  用 `unittest.skipUnless` 标记需要它们的用例。
- **不依赖 Windows 字体**：渲染测试不生成预览图；预览图用例允许在无字体环境
  降级为 warning。CI 的渲染冒烟用 `--no-preview`，断言只看 PPTX 结构。
- **与新版式开发解耦**：模板数量用 `>= 6`、未知版式断言「回退 bullets」，
  不会因为新增 agenda / matrix 等版式而误报。

## CI 行为（`.github/workflows/ci.yml`）

| Job | Runner | 内容 |
| --- | --- | --- |
| `node-tests` | ubuntu · Node 20/22 | `node --test tests/node/*.test.js` + 示例 deck dry-run |
| `python-tests` | ubuntu · Python 3.11/3.12 | `pip install python-pptx pillow` + `unittest discover` |
| `render-smoke` | ubuntu · Node 22 + Python 3.12 | 渲染 `examples/demo-deck.json` → python-pptx 回读断言（页数/图表/表格/讲稿），并上传产物 |

## 排障

| 现象 | 处理 |
| --- | --- |
| `python-pptx 未安装` 导致用例 skip | `python -m pip install python-pptx pillow` 后重跑 |
| 渲染报「没有可用的 Python 解释器」 | 用 `--python` 指定解释器，或设置 `DSH_PPT_PYTHON` |
| 预览图中文变方块 / 预览失败 | Linux 缺中文字体属预期，渲染本体不受影响；`--no-preview` 跳过 |
| 模板仓库测试污染了真实模板 | 不应发生；检查测试是否在 `try/finally` 里调用了 `home.restore()` |
| Node 报 `Cannot find module .../tests/node` | Node 21+ 不接受目录参数，改用上面的 glob/文件列表命令 |
