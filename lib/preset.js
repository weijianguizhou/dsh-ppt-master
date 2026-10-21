/**
 * dsh-ppt-master/preset —— 「PPT 大师」模式的作用域入口。
 *
 * 这个模块**只在 preset 的隔离作用域里挂载**（见 cordis.patch.yml 的
 * preset-ppt-master 行）。它做三件事：
 *   1. 注册大师人设系统提示词段落 —— 会话一开场就把工作流与设计硬规则摆到台面上；
 *   2. 注册动态上下文 —— 把当前可用的模板清单实时喂给模型，省一次工具往返；
 *   3. 在同作用域内再注册一遍工具与技能 —— 作用域注册可遮蔽全局注册（不会重复报错），
 *      这样即便该模式将来收紧全局工具，模式自带的能力也一定在。
 *
 * 不做工具 restrict：restrict 对未知工具名会直接抛错，一旦别的插件改动工具集，
 * 整个模式就会变成 broken preset。宁可少一层过滤，也不要一个会自己坏掉的模式。
 */

import { registerPptTools } from './tools.js'
import { listTemplates } from './engine.js'
import { MASTER_PERSONA, MASTER_PLAYBOOK } from './master.js'

export const name = 'ppt-master-mode'
export const inject = []

/** 段落顺序：排在核心身份之后、收尾之前，做「身份叠加」而不是抢主场。 */
const SECTION_ORDER = 900
const CONTEXT_ORDER = 900

export function apply(ctx) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(`dsh-ppt-master(preset): ${message}`)
    } catch {
      /* ignore */
    }
  }
  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : null
  const run = (fn, label) => {
    if (effect) effect(fn, `dsh-ppt-master: ${label}`)
    else fn()
  }

  // ① 大师人设（常驻提示词）
  const systemPrompt = ctx.get ? ctx.get('systemPrompt') : undefined
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    run(() => {
      try {
        return systemPrompt.section({
          name: 'ppt-master-persona',
          order: SECTION_ORDER,
          text: MASTER_PERSONA,
        })
      } catch (error) {
        log(`人设段落注册失败：${error?.message || error}`)
        return () => {}
      }
    }, 'persona')
  } else {
    log('systemPrompt 不可用：模式人设未注入（工具仍可用）')
  }

  // ② 动态上下文：实时模板清单
  if (systemPrompt && typeof systemPrompt.context === 'function') {
    run(() => {
      try {
        return systemPrompt.context({
          name: 'ppt-master-templates',
          order: CONTEXT_ORDER,
          text: () => {
            try {
              const lines = listTemplates().map((t) => `- ${t.id}（${t.name}${t.origin === 'user' ? '·自建' : ''}）：${t.description}`)
              return `可用演示模板（ppt_build 的 template 字段填 id）：\n${lines.join('\n')}`
            } catch (error) {
              return `模板清单读取失败：${error?.message || error}`
            }
          },
        })
      } catch (error) {
        log(`模板上下文注册失败：${error?.message || error}`)
        return () => {}
      }
    }, 'template-context')
  }

  // ③ 技能（作用域层）
  const skills = ctx.get ? ctx.get('skills') : undefined
  if (skills && typeof skills.register === 'function') {
    run(() => {
      try {
        return skills.register({
          name: 'ppt-master',
          description: '做演示文稿时的大师手册：五步工作流、16 种版式选择表、设计与数据呈现硬规则、反面清单。',
          whenToUse: '当用户要做 PPT / 汇报材料 / 演示文稿 / slide / deck，或要润色、审校已有演示时加载。',
          content: MASTER_PLAYBOOK,
          source: 'bundled',
          invocation: { modelInvocable: true, userInvocable: true },
          metadata: { plugin: 'dsh-ppt-master', scope: 'preset:ppt-master' },
        })
      } catch (error) {
        log(`技能注册失败：${error?.message || error}`)
        return () => {}
      }
    }, 'skill')
  }

  // ④ 工具（作用域层，遮蔽全局同名注册）
  if (ctx.get && ctx.get('tools')) {
    run(() => {
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
        log(`工具注册失败：${error?.message || error}`)
        return () => {}
      }
    }, 'tools')
  }

  log('「PPT 大师」模式已就绪')
}
