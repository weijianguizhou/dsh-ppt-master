/**
 * 「PPT 大师」内置设计规范模板（design system）。
 *
 * 一个模板 = 一套可渲染的视觉规范：配色（theme）、字体栈（fonts）、
 * 版式几何（geometry）与装饰手法（decor）。渲染器（lib/python/ppt_build.py）
 * 只认这些字段，因此用户自建模板与内置模板走完全相同的代码路径。
 *
 * 单位约定：geometry 全部为英寸，字号全部为磅（pt），颜色为 #RRGGBB。
 * 字体栈给出 latin（西文）+ ea（东亚）双字体名 —— 渲染器会把两者同时写入
 * run 的 <a:latin>/<a:ea>，中文与数字混排才不会掉字形。
 */

/** 模板字段的默认值（用户自建模板缺省字段时补齐）。 */
export const TEMPLATE_DEFAULTS = {
  aspect: '16:9',
  theme: {
    mode: 'dark',
    bg: '#0B1020',
    bg2: '#151D3A',
    surface: '#1B2544',
    surfaceAlt: '#25315C',
    primary: '#5B7CFA',
    primary2: '#8AA0FF',
    accent: '#FFC53D',
    text: '#F4F7FF',
    textDim: '#A9B4D6',
    line: '#2C3760',
  },
  fonts: {
    title: { latin: 'Segoe UI Semibold', ea: 'Microsoft YaHei' },
    body: { latin: 'Segoe UI', ea: 'Microsoft YaHei' },
    mono: { latin: 'Consolas', ea: 'Microsoft YaHei' },
  },
  geometry: {
    marginX: 0.86,
    marginY: 0.58,
    coverSize: 44,
    sectionSize: 38,
    titleSize: 30,
    bodySize: 16,
    smallSize: 11.5,
    kickerSize: 12,
    radius: 0.1,
    gap: 0.26,
    lineSpacing: 1.32,
  },
  decor: {
    style: 'glow',
    accentBar: true,
    coverPattern: 'orbs',
  },
}

/** 8 套内置模板。 */
export const BUILTIN_TEMPLATES = [
  {
    id: 'indigo-corporate',
    name: '靛蓝商务',
    description: '深蓝夜空底 + 电光靛蓝 + 琥珀点缀。稳重、有科技感，适合战略汇报、融资路演、季度复盘。',
    tags: ['商务', '汇报', '深色', '稳重'],
    theme: {
      mode: 'dark',
      bg: '#0A0F22',
      bg2: '#141D40',
      surface: '#18224A',
      surfaceAlt: '#222E60',
      primary: '#5B7CFA',
      primary2: '#8FA6FF',
      accent: '#FFC53D',
      text: '#F5F7FF',
      textDim: '#A7B2D6',
      line: '#2B3765',
    },
    geometry: { coverSize: 46, titleSize: 30, bodySize: 16, marginX: 0.86 },
    decor: { style: 'glow', accentBar: true, coverPattern: 'orbs' },
  },
  {
    id: 'minimal-paper',
    name: '极简素白',
    description: '暖白纸感底 + 近黑正文 + 一点朱红。留白极大、层级克制，适合学术分享、设计评审、产品说明。',
    tags: ['极简', '浅色', '学术', '高级'],
    theme: {
      mode: 'light',
      bg: '#FBFAF7',
      bg2: '#F1EEE8',
      surface: '#FFFFFF',
      surfaceAlt: '#F4F1EB',
      primary: '#C0392B',
      primary2: '#E0685A',
      accent: '#1F2933',
      text: '#14181D',
      textDim: '#6B7480',
      line: '#E2DED6',
    },
    fonts: {
      title: { latin: 'Georgia', ea: 'Microsoft YaHei' },
      body: { latin: 'Segoe UI', ea: 'Microsoft YaHei' },
      mono: { latin: 'Consolas', ea: 'Microsoft YaHei' },
    },
    geometry: { marginX: 1.0, marginY: 0.66, titleSize: 30, bodySize: 16, lineSpacing: 1.42, gap: 0.3 },
    decor: { style: 'soft', accentBar: true, coverPattern: 'rule' },
  },
  {
    id: 'deepspace-tech',
    name: '深空科技',
    description: '近黑底 + 青紫霓虹 + 网格光晕。强未来感，适合 AI/硬件发布、技术架构、产品愿景。',
    tags: ['科技', '深色', '发布', '前沿'],
    theme: {
      mode: 'dark',
      bg: '#05070F',
      bg2: '#0B1226',
      surface: '#101A33',
      surfaceAlt: '#16244A',
      primary: '#31E1F7',
      primary2: '#7C6BFF',
      accent: '#39FF88',
      text: '#EAF6FF',
      textDim: '#8FA6C4',
      line: '#1D2C4E',
    },
    fonts: {
      title: { latin: 'Segoe UI Semibold', ea: 'Microsoft YaHei' },
      body: { latin: 'Segoe UI', ea: 'Microsoft YaHei' },
      mono: { latin: 'Consolas', ea: 'Microsoft YaHei' },
    },
    geometry: { coverSize: 46, titleSize: 30, bodySize: 15.5, marginX: 0.86 },
    decor: { style: 'grid', accentBar: true, coverPattern: 'grid' },
  },
  {
    id: 'warm-sunrise',
    name: '暖阳人文',
    description: '米杏暖底 + 陶土橙 + 深松绿。有温度、不冰冷，适合品牌故事、团队文化、公益与教育主题。',
    tags: ['暖色', '人文', '品牌', '故事'],
    theme: {
      mode: 'light',
      bg: '#FDF7F0',
      bg2: '#F6E8DC',
      surface: '#FFFFFF',
      surfaceAlt: '#FBEFE4',
      primary: '#D2694A',
      primary2: '#E79A76',
      accent: '#1F5C4D',
      text: '#2C211B',
      textDim: '#7A6455',
      line: '#EBD8C7',
    },
    geometry: { coverSize: 46, titleSize: 30, bodySize: 16, marginX: 0.92, lineSpacing: 1.4 },
    decor: { style: 'soft', accentBar: true, coverPattern: 'arc' },
  },
  {
    id: 'celadon-cn',
    name: '青瓷东方',
    description: '青瓷釉色底 + 墨色正文 + 朱砂点睛。克制的东方美学，适合文化、品牌、年度总结。',
    tags: ['东方', '浅色', '典雅', '文化'],
    theme: {
      mode: 'light',
      bg: '#F2F7F3',
      bg2: '#E3EFE6',
      surface: '#FFFFFF',
      surfaceAlt: '#EAF3EC',
      primary: '#3E6B5A',
      primary2: '#6B9B87',
      accent: '#B23A48',
      text: '#1C2B25',
      textDim: '#5F7268',
      line: '#D3E4D8',
    },
    fonts: {
      title: { latin: 'Georgia', ea: 'Microsoft YaHei' },
      body: { latin: 'Segoe UI', ea: 'Microsoft YaHei' },
      mono: { latin: 'Consolas', ea: 'Microsoft YaHei' },
    },
    geometry: { coverSize: 44, titleSize: 29, bodySize: 16, marginX: 1.0, lineSpacing: 1.44 },
    decor: { style: 'ink', accentBar: true, coverPattern: 'seal' },
  },
  {
    id: 'data-vivid',
    name: '数据亮色',
    description: '纯白底 + 高辨识度分类色板。图表、指标、对比数据优先，适合数据分析与经营看板汇报。',
    tags: ['数据', '图表', '亮色', '分析'],
    theme: {
      mode: 'light',
      bg: '#FFFFFF',
      bg2: '#F4F6FA',
      surface: '#F8FAFD',
      surfaceAlt: '#EEF3FA',
      primary: '#2563EB',
      primary2: '#60A5FA',
      accent: '#F59E0B',
      text: '#0F172A',
      textDim: '#5B6B85',
      line: '#DCE4F0',
    },
    geometry: { coverSize: 42, titleSize: 28, bodySize: 15.5, marginX: 0.8, lineSpacing: 1.34 },
    decor: { style: 'grid', accentBar: true, coverPattern: 'bars' },
  },
  {
    id: 'graphite-mono',
    name: '石墨黑白',
    description: '纯白纸底 + 石墨黑正文 + 冷灰层次，无彩色干扰。为正式打印与黑白复印优化，适合报告、论文答辩、公文与合同附件。',
    tags: ['黑白', '打印', '正式', '克制'],
    theme: {
      mode: 'light',
      bg: '#FFFFFF',
      bg2: '#F2F3F5',
      surface: '#F7F7F8',
      surfaceAlt: '#EBECEE',
      primary: '#2B2F33',
      primary2: '#5A6066',
      accent: '#8A8F94',
      text: '#16181A',
      textDim: '#5F656B',
      line: '#D5D8DB',
    },
    fonts: {
      title: { latin: 'Segoe UI Semibold', ea: 'Microsoft YaHei' },
      body: { latin: 'Segoe UI', ea: 'Microsoft YaHei' },
      mono: { latin: 'Consolas', ea: 'Microsoft YaHei' },
    },
    geometry: {
      marginX: 0.95,
      marginY: 0.62,
      coverSize: 44,
      sectionSize: 38,
      titleSize: 29,
      bodySize: 16,
      smallSize: 11.5,
      kickerSize: 12,
      radius: 0.04,
      gap: 0.28,
      lineSpacing: 1.42,
    },
    decor: { style: 'none', accentBar: true, coverPattern: 'rule' },
  },
  {
    id: 'ocean-deep',
    name: '深海蓝',
    description: '深海墨蓝渐变底 + 荧光青主色 + 海松绿点缀。冷静通透的科技感，适合技术方案、数据平台、产品架构与行业洞察。',
    tags: ['科技', '深色', '蓝色', '数据'],
    theme: {
      mode: 'dark',
      bg: '#04121F',
      bg2: '#0A2740',
      surface: '#0B1F33',
      surfaceAlt: '#123049',
      primary: '#2EC5FF',
      primary2: '#5AA6FF',
      accent: '#3EE0B0',
      text: '#EAF6FF',
      textDim: '#8FB0C8',
      line: '#1B3A55',
    },
    fonts: {
      title: { latin: 'Segoe UI Semibold', ea: 'Microsoft YaHei' },
      body: { latin: 'Segoe UI', ea: 'Microsoft YaHei' },
      mono: { latin: 'Consolas', ea: 'Microsoft YaHei' },
    },
    geometry: {
      marginX: 0.88,
      marginY: 0.6,
      coverSize: 46,
      sectionSize: 38,
      titleSize: 30,
      bodySize: 16,
      smallSize: 11.5,
      kickerSize: 12,
      radius: 0.1,
      gap: 0.26,
      lineSpacing: 1.36,
    },
    decor: { style: 'glow', accentBar: true, coverPattern: 'grid' },
  },
]

/** 深拷贝（模板对象会被渲染器按引用读取，禁止调用方就地改内置常量）。 */
export function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 按字段递归补默认值：已有值优先，缺失字段落到默认值。 */
function deepDefaults(value, defaults) {
  const out = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const current = value?.[key]
    if (current === undefined || current === null) {
      out[key] = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? clone(fallback) : fallback
    } else if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      out[key] = deepDefaults(current, fallback)
    } else {
      out[key] = current
    }
  }
  // 保留默认值之外的自定义字段（如用户加的 note）。
  for (const [key, current] of Object.entries(value ?? {})) {
    if (!(key in out)) out[key] = current
  }
  return out
}

/** 归一化模板：补默认值 + 校验 id/name + 统一颜色大小写。 */
export function normalizeTemplate(input) {
  const spec = typeof input === 'string' ? { id: input } : { ...(input ?? {}) }
  const id = String(spec.id ?? spec.name ?? '').trim()
  if (!id) throw new Error('模板缺少 id')
  const merged = deepDefaults({ ...spec, id, name: spec.name ?? id }, TEMPLATE_DEFAULTS)
  merged.id = id
  merged.name = String(merged.name ?? id)
  merged.description = String(merged.description ?? '')
  merged.tags = Array.isArray(merged.tags) ? merged.tags.map(String) : []
  merged.theme = normalizeColors(merged.theme)
  if (merged.aspect !== '16:9' && merged.aspect !== '4:3') merged.aspect = '16:9'
  return merged
}

function normalizeColors(theme) {
  const out = { ...theme }
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string' || !/^#?[0-9a-fA-F]{3,8}$/.test(value.trim())) continue
    const raw = value.trim().replace('#', '')
    if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw)) continue
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
    out[key] = '#' + full.slice(0, 6).toUpperCase()
  }
  return out
}

/** 内置模板（已归一化）。 */
export function builtinTemplates() {
  return BUILTIN_TEMPLATES.map((t) => normalizeTemplate(t))
}

/** 取内置模板。 */
export function getBuiltinTemplate(id) {
  const found = BUILTIN_TEMPLATES.find((t) => t.id === id)
  return found ? normalizeTemplate(found) : undefined
}

export const LAYOUT_NAMES = [
  'cover', 'section', 'agenda', 'bullets', 'two-col', 'cards', 'kpi', 'timeline',
  'image', 'quote', 'table', 'chart', 'compare', 'process', 'matrix', 'end',
]
