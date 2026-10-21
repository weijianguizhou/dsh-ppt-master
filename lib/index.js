/**
 * dsh-ppt-master —— 宿主插件本体（全局入口）。
 *
 * 挂载后提供：
 *   * 5 个工具：ppt_research / ppt_templates / ppt_build / ppt_lint / ppt_doctor；
 *   * 3 条只读 HTTP 路由：/status、/templates、/gallery（模板可视化预览页，
 *     可直接在 DSH 的浏览器面板里打开，不需要客户端插件）；
 *   * 1 个技能：ppt-master（大师手册，按需加载）。
 *
 * 依赖策略（教训来自本机其它插件的真实故障）：只硬依赖 tools；
 * systemPrompt / skills / webServer 一律在 apply 内动态探测，缺失则降级告警，
 * 绝不因为可选能力缺席而让整个插件停在 PENDING。
 */

import { registerPptTools } from './tools.js'
import { listTemplates, storeDir, SCRIPT_PATH } from './engine.js'
import { MASTER_PLAYBOOK } from './master.js'

export const name = 'ppt-master'
export const inject = ['tools']

const ROUTE_BASE = '/plugins/dsh-ppt-master'

function json(response, payload, status = 200) {
  const body = JSON.stringify(payload, null, 2)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

function html(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

/** 模板画廊页：一屏看完 8 套设计规范的配色与气质。 */
function galleryHtml() {
  const templates = listTemplates()
  const cards = templates.map((t) => {
    const th = t.theme
    const swatch = ['bg', 'surface', 'primary', 'accent', 'text', 'textDim']
      .map((key) => `<span class="sw" style="background:${escapeHtml(th[key] || '#888')}" title="${key} ${escapeHtml(th[key] || '')}"></span>`)
      .join('')
    return `
    <section class="card" style="background:${escapeHtml(th.bg)};color:${escapeHtml(th.text)};border-color:${escapeHtml(th.line || th.surface)}">
      <div class="meta">
        <h2>${escapeHtml(t.name)}<small>${escapeHtml(t.id)}${t.origin === 'user' ? ' · 自建' : ''}</small></h2>
        <p>${escapeHtml(t.description)}</p>
      </div>
      <div class="preview">
        <span class="bar" style="background:${escapeHtml(th.primary)}"></span>
        <span class="kick" style="color:${escapeHtml(th.accent)}">KICKER</span>
        <strong style="color:${escapeHtml(th.text)}">一页一个观点</strong>
        <em style="color:${escapeHtml(th.textDim)}">要点不超过 5 条，每条 24 字以内；数字交给图表。</em>
        <span class="chip" style="background:${escapeHtml(th.surface)};color:${escapeHtml(th.primary)}">12.4 亿元 · +18%</span>
      </div>
      <div class="sws">${swatch}</div>
      <div class="tags">${(t.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
    </section>`
  }).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>PPT 大师 · 模板库</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:28px; font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif; background:#0d1117; color:#e6edf3; }
  h1 { font-size:22px; margin:0 0 6px; }
  .intro { color:#9aa7b8; margin:0 0 22px; }
  .intro code { background:#1b2230; padding:1px 6px; border-radius:5px; }
  .grid { display:grid; gap:18px; grid-template-columns:repeat(auto-fill,minmax(380px,1fr)); }
  .card { border:1px solid #30363d; border-radius:14px; padding:18px; display:flex; flex-direction:column; gap:12px; }
  .meta h2 { font-size:17px; margin:0 0 4px; display:flex; align-items:baseline; gap:8px; }
  .meta h2 small { font-size:11px; opacity:.6; font-weight:400; }
  .meta p { margin:0; font-size:12.5px; opacity:.78; }
  .preview { border-radius:10px; padding:14px 16px; display:flex; flex-direction:column; gap:6px; background:rgba(127,127,127,.10); }
  .preview .bar { display:block; width:46px; height:4px; border-radius:2px; }
  .preview .kick { font-size:10.5px; letter-spacing:.14em; font-weight:700; }
  .preview strong { font-size:21px; letter-spacing:.01em; }
  .preview em { font-style:normal; font-size:12.5px; }
  .preview .chip { align-self:flex-start; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:700; }
  .sws { display:flex; gap:6px; }
  .sw { width:26px; height:26px; border-radius:7px; border:1px solid rgba(127,127,127,.35); display:inline-block; }
  .tags { display:flex; flex-wrap:wrap; gap:6px; font-size:11px; opacity:.7; }
  .tags span { border:1px solid rgba(127,127,127,.35); border-radius:999px; padding:1px 8px; }
</style></head>
<body>
  <h1>PPT 大师 · 模板库</h1>
  <p class="intro">共 ${templates.length} 套设计规范。用法：让 Agent 用 <code>ppt_build</code> 的 <code>template</code> 字段指定下面的 id。
  用户模板目录：<code>${escapeHtml(storeDir())}</code>。渲染器：<code>${escapeHtml(SCRIPT_PATH)}</code>。</p>
  <div class="grid">${cards}</div>
</body></html>`
}

export function apply(ctx) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(`dsh-ppt-master: ${message}`)
    } catch {
      /* 日志失败不影响功能 */
    }
  }
  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : null

  // ① 工具
  const registerTools = () => {
    try {
      const { disposers } = registerPptTools(ctx, log)
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    } catch (error) {
      log(`工具注册整体失败：${error?.message || error}`)
      return () => {}
    }
  }
  if (effect) effect(registerTools, 'dsh-ppt-master: tools')
  else registerTools()

  // ② HTTP 路由（webServer 可能存在也可能不存在）
  const webServer = ctx.get ? ctx.get('webServer') : undefined
  if (webServer && typeof webServer.register === 'function') {
    const registerRoutes = () => {
      const disposers = []
      const add = (route) => {
        try {
          disposers.push(webServer.register(route))
        } catch (error) {
          log(`路由 ${route.path} 注册失败：${error?.message || error}`)
        }
      }
      const guard = (handler) => (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        try {
          handler(req, res)
        } catch (error) {
          json(res, { ok: false, error: String(error?.message || error) }, 500)
        }
      }
      add({
        kind: 'exact',
        path: `${ROUTE_BASE}/status`,
        handler: guard((_req, res) => json(res, {
          ok: true,
          plugin: 'dsh-ppt-master',
          templates: listTemplates().length,
          templateDir: storeDir(),
          script: SCRIPT_PATH,
        })),
      })
      add({
        kind: 'exact',
        path: `${ROUTE_BASE}/templates`,
        handler: guard((_req, res) => json(res, { ok: true, templates: listTemplates() })),
      })
      add({
        kind: 'prefix',
        path: `${ROUTE_BASE}/template/`,
        handler: guard((req, res) => {
          const id = decodeURIComponent(String(req.url || '').split('/').pop() || '')
          const found = listTemplates().find((t) => t.id === id)
          if (!found) {
            json(res, { ok: false, error: `模板 ${id} 不存在` }, 404)
            return
          }
          json(res, { ok: true, template: found })
        }),
      })
      add({
        kind: 'exact',
        path: `${ROUTE_BASE}/gallery`,
        handler: guard((_req, res) => html(res, galleryHtml())),
      })
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (effect) effect(registerRoutes, 'dsh-ppt-master: routes')
    else registerRoutes()
    log(`模板画廊：${ROUTE_BASE}/gallery`)
  } else {
    log('webServer 不可用：跳过模板画廊路由（工具与技能不受影响）')
  }

  // ③ 技能：大师手册
  const skills = ctx.get ? ctx.get('skills') : undefined
  if (skills && typeof skills.register === 'function') {
    const registerSkill = () => {
      try {
        return skills.register({
          name: 'ppt-master',
          description: '做演示文稿时的大师手册：五步工作流、16 种版式选择表、设计与数据呈现硬规则、反面清单。',
          whenToUse: '当用户要做 PPT / 汇报材料 / 演示文稿 / slide / deck，或要润色、审校已有演示时加载。',
          content: MASTER_PLAYBOOK,
          source: 'bundled',
          invocation: { modelInvocable: true, userInvocable: true },
          metadata: { plugin: 'dsh-ppt-master', tools: ['ppt_research', 'ppt_templates', 'ppt_build', 'ppt_lint', 'ppt_doctor'] },
        })
      } catch (error) {
        log(`技能注册失败：${error?.message || error}`)
        return () => {}
      }
    }
    if (effect) effect(registerSkill, 'dsh-ppt-master: skill')
    else registerSkill()
  } else {
    log('skills 服务不可用：跳过 ppt-master 技能注册')
  }

  log('已就绪（工具 / 模板画廊 / 技能）')
}
