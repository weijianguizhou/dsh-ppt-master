# Changelog

本文件格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（暂无）

## [0.2.0] - 2026-10-21

### Added

- 新增 `agenda`（议程）与 `matrix`（矩阵）两种版式，版式总数从 14 增加到 16。
- 新增 `radar`（雷达图）与 `scatter`（散点图）两类原生图表，图表类型增加到 8 类。
- 新增两套内置设计规范模板：`graphite-mono`（石墨黑白，省墨打印友好）与
  `ocean-deep`（深海蓝，沉稳的深色汇报风），内置模板从 6 套增加到 8 套。
- 新增 Node 内建测试（`tests/node/`，零依赖）与 Python `unittest`
  （`tests/python/`），覆盖版式归一化、设计审校、模板仓库增删查、渲染器构建与
  python-pptx 回读。
- 新增 GitHub Actions CI（`.github/workflows/ci.yml`）：Node 20/22、Python
  3.11/3.12 矩阵测试，外加一次 Linux 下的渲染冒烟。
- 新增 `examples/demo-deck.json` 示例 deck 与 `scripts/render-example.mjs`
  一键渲染脚本。
- 新增 `examples/showcase-deck.json`（18 页、覆盖全部 16 种版式与三类图表）与
  `docs/preview.png` 全页预览图，README 顶部直接展示。
- 渲染器新增 `--selftest <dir>`：不依赖 JS 侧数据，生成 3 页样张验证
  Python / python-pptx / 字体链路。
- 新增 `CHANGELOG.md`、`LICENSE`（MIT）与 `.gitignore`，补齐开源仓库所需的
  基础文件。

### Changed

- 路径可移植化：Python 解释器、字体目录、临时目录与自检哨兵路径不再写死
  Windows 绝对路径，优先从环境变量与运行时推断，macOS / Linux 可直接使用。
- `package.json` 版本升到 `0.2.0`，补充 `test` / `test:python` / `example`
  脚本与 `files` 白名单。

### Fixed

- 设计审校不再对 `quote`（金句页）误报「缺少标题」——金句页的主体是引文，
  与 `image` 版式一样允许不写标题。
- `--selftest` 的文档与实现对齐：此前 docstring 声称支持但 `main()` 未实现，
  现在会真的生成 3 页自测样张并输出标准哨兵 JSON。

## [0.1.0] - 2026-10-03

### Added

- 初始版本：DSH「PPT 大师」会话模式、`ppt_research` / `ppt_templates` /
  `ppt_build` / `ppt_lint` / `ppt_doctor` 五个工具，以及 `ppt-master` 技能。
- 14 种手写几何版式（cover / section / bullets / two-col / cards / kpi /
  timeline / process / image / quote / table / chart / compare / end）。
- 6 套内置设计规范模板与 6 类原生图表（bar / bar-h / line / area / pie /
  doughnut），支持用户模板 `baseOn` 派生、模板增删查。
- 设计审校器（结论式标题、要点上限、数字进图表、讲稿齐备等规则）。
- 模板画廊 / 模板 JSON / 健康检查三个可视化端点。

[Unreleased]: https://github.com/weijianguizhou/dsh-ppt-master/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/weijianguizhou/dsh-ppt-master/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/weijianguizhou/dsh-ppt-master/releases/tag/v0.1.0
