#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
PPT 大师渲染器 —— 把「模板规范 + 幻灯片数据」渲染成真实的 .pptx 文件。

调用（由 dsh-ppt-master 宿主插件生成 spec.json 后调用）：

    python ppt_build.py <spec.json>
    python ppt_build.py --probe          # 仅体检：版本、字体、能力
    python ppt_build.py --selftest <dir> # 生成一份自测样例

spec.json 结构：
    {
      "template": { ...design system... },     # 由 JS 侧 normalizeTemplate 归一化
      "deck":     { "title": ..., "slides": [ {...}, ... ] },
      "out":      "D:/path/deck.pptx",
      "preview":  "D:/path/deck.preview.png",  # 可选
      "previewGrid": 3,
      "previewWidth": 620
    }

结果以一行哨兵输出供 JS 解析：
    @@PPT_RESULT@@{"ok":true,"pptx":"...","preview":"...","slides":12,"warnings":[]}

设计要点（决定「精美」与否的地方）：
  * 全部版式手写几何，不依赖默认占位符 —— 模板换了颜色字体就是另一套风格；
  * 中英混排同时写 <a:latin> 与 <a:ea>，中文不会掉字形；
  * 文字自动测量 + 回落字号，杜绝溢出（比事后手动调框可靠）；
  * 图片一律 cover 裁切填满规定框，不拉伸变形；
  * 图表、表格、卡片、KPI、时间线都是原生 PPT 对象，可在 PowerPoint 里继续编辑。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

try:  # 模块级可用（set_line 等函数直接引用）；缺失时由 --probe / main 统一报错
    from pptx.util import Pt
except Exception:  # pragma: no cover
    Pt = None

SENTINEL = '@@PPT_RESULT@@'
EMU_IN = 914400
DEFAULT_W = 13.333
DEFAULT_H = 7.5


# ────────────────────────────────────────────────────────────── 基础工具 ──

def warn(state, message):
    try:
        if message not in state['warnings']:
            state['warnings'].append(message)
    except Exception:
        pass


def hex_rgb(value, fallback='#888888'):
    from pptx.dml.color import RGBColor
    raw = str(value or fallback).strip().lstrip('#')
    if len(raw) == 3:
        raw = ''.join(c * 2 for c in raw)
    if len(raw) == 8:
        raw = raw[:6]
    if len(raw) != 6:
        raw = fallback.lstrip('#')
    try:
        return RGBColor.from_string(raw.upper())
    except Exception:
        return RGBColor.from_string(fallback.lstrip('#').upper())


def rgb_tuple(value, fallback='#888888'):
    raw = str(value or fallback).strip().lstrip('#')
    if len(raw) == 3:
        raw = ''.join(c * 2 for c in raw)
    raw = raw[:6]
    if len(raw) != 6:
        raw = fallback.lstrip('#')
    try:
        return tuple(int(raw[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return (136, 136, 136)


def mix(a, b, t, fallback_a='#000000', fallback_b='#FFFFFF'):
    """在两个颜色之间线性插值（t=0 取 a，t=1 取 b）。"""
    ca, cb = rgb_tuple(a, fallback_a), rgb_tuple(b, fallback_b)
    return tuple(int(round(ca[i] + (cb[i] - ca[i]) * t)) for i in range(3))


def is_light(color, fallback='#FFFFFF'):
    r, g, b = rgb_tuple(color, fallback)
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150


def text_on(color, dark='#111827', light='#FFFFFF'):
    """在给定底色上选一个可读的正文色。"""
    return dark if is_light(color) else light


def set_alpha(shape, alpha):
    """给纯色填充加透明度（alpha 0..100 表示不透明度百分比）。"""
    try:
        from pptx.oxml.ns import qn
        fill = shape.fill._xPr.find(qn('a:solidFill'))
        if fill is None:
            return
        clr = None
        for tag in ('a:srgbClr', 'a:schemeClr'):
            found = fill.find(qn(tag))
            if found is not None:
                clr = found
                break
        if clr is None:
            return
        for old in clr.findall(qn('a:alpha')):
            clr.remove(old)
        alpha_el = clr.makeelement(qn('a:alpha'), {'val': str(int(max(0, min(100, alpha)) * 1000))})
        clr.append(alpha_el)
    except Exception:
        pass


def set_gradient(shape, c1, c2, angle=45):
    try:
        shape.fill.gradient()
        stops = shape.fill.gradient_stops
        stops[0].color.rgb = hex_rgb(c1)
        stops[0].position = 0.0
        stops[1].color.rgb = hex_rgb(c2)
        stops[1].position = 1.0
        try:
            shape.fill.gradient_angle = angle
        except Exception:
            pass
        return True
    except Exception:
        try:
            shape.fill.solid()
            shape.fill.fore_color.rgb = hex_rgb(c1)
        except Exception:
            pass
        return False


def set_line(shape, color, width_pt=1.0):
    try:
        if color is None:
            shape.line.fill.background()
            return
        shape.line.color.rgb = hex_rgb(color)
        shape.line.width = Pt(width_pt)
    except Exception:
        pass


def no_shadow(shape):
    try:
        shape.shadow.inherit = False
    except Exception:
        pass


def add_rect(slide, x, y, w, h, fill=None, line=None, line_pt=1.0, radius=None, grad=None,
             alpha=None, shape_type=None):
    from pptx.util import Inches
    from pptx.enum.shapes import MSO_SHAPE
    st = shape_type or (MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE)
    shape = slide.shapes.add_shape(st, Inches(x), Inches(y), Inches(max(w, 0.02)), Inches(max(h, 0.02)))
    shape.shadow.inherit = False
    if radius and st == MSO_SHAPE.ROUNDED_RECTANGLE:
        try:
            shortest = max(min(w, h), 0.05)
            shape.adjustments[0] = max(0.0, min(0.5, float(radius) / shortest))
        except Exception:
            pass
    if grad:
        set_gradient(shape, grad[0], grad[1], grad[2] if len(grad) > 2 else 45)
    elif fill:
        shape.fill.solid()
        shape.fill.fore_color.rgb = hex_rgb(fill)
        if alpha is not None:
            set_alpha(shape, alpha)
    else:
        shape.fill.background()
    set_line(shape, line, line_pt)
    shape.text_frame.word_wrap = True
    return shape


def add_ellipse(slide, x, y, w, h, fill, alpha=None):
    from pptx.util import Inches
    from pptx.enum.shapes import MSO_SHAPE
    shape = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(y), Inches(w), Inches(h))
    shape.shadow.inherit = False
    shape.fill.solid()
    shape.fill.fore_color.rgb = hex_rgb(fill)
    if alpha is not None:
        set_alpha(shape, alpha)
    shape.line.fill.background()
    return shape


def text_width_estimate(text, size):
    """按磅字号估算文本宽度（英寸）：CJK 记 1.0em，西文记 0.58em。"""
    units = 0.0
    for ch in str(text or ''):
        if ch == '\t':
            units += 2.0
        elif ord(ch) > 0x2E80:
            units += 1.0
        elif ch in ' .,:;!|\'`iIlj1':
            units += 0.34
        elif ch.isupper():
            units += 0.68
        else:
            units += 0.58
    return units * size / 72.0


def fit_size(text, box_w, box_h, base, min_size=9.0, line_spacing=1.3, max_lines=None):
    """从 base 起向下回落到不溢出的字号。"""
    size = float(base)
    while size > min_size:
        per_line = max(box_w / max(text_width_estimate('x' * 10, size) / 10.0, 0.01), 1.0)
        line_len = max(box_w / max(text_width_estimate('中', size), 0.001), 1.0)
        est_lines = max(1.0, len(str(text or '')) / max(line_len, 1.0))
        if max_lines:
            est_lines = min(est_lines, float(max_lines))
        need = est_lines * size * line_spacing / 72.0
        if need <= box_h:
            break
        size -= 0.5
        # per_line 仅用于保持循环形状，避免静态分析告警
        del per_line
    return size


def add_text(slide, text, x, y, w, h, size=16.0, color='#FFFFFF', bold=False, italic=False,
             align='left', anchor='top', font=None, line_spacing=1.3, wrap=True, alpha=None,
             shrink=True, mono=False):
    from pptx.util import Inches, Pt
    from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
    text = '' if text is None else str(text)
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(max(w, 0.1)), Inches(max(h, 0.1)))
    tf = box.text_frame
    tf.word_wrap = bool(wrap)
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = {'top': MSO_ANCHOR.TOP, 'middle': MSO_ANCHOR.MIDDLE, 'bottom': MSO_ANCHOR.BOTTOM}.get(anchor, MSO_ANCHOR.TOP)
    p = tf.paragraphs[0]
    p.alignment = {'left': PP_ALIGN.LEFT, 'center': PP_ALIGN.CENTER, 'right': PP_ALIGN.RIGHT, 'justify': PP_ALIGN.JUSTIFY}.get(align, PP_ALIGN.LEFT)
    try:
        p.line_spacing = float(line_spacing)
    except Exception:
        pass
    run = p.add_run()
    run.text = text
    use_size = size
    if shrink:
        use_size = fit_size(text, w, h, size, line_spacing=line_spacing)
    apply_run(run, font, use_size, color, bold, italic, mono=mono)
    if alpha is not None:
        try:
            from pptx.oxml.ns import qn
            clr = run._r.find(qn('a:rPr')).find(qn('a:solidFill')).find(qn('a:srgbClr'))
            clr.append(clr.makeelement(qn('a:alpha'), {'val': str(int(alpha * 1000))}))
        except Exception:
            pass
    return box


def apply_run(run, font, size, color, bold=False, italic=False, mono=False):
    """给 run 同时设置西文/东亚字体，避免中文字形回退。"""
    from pptx.util import Pt
    f = run.font
    f.size = Pt(float(size))
    f.bold = bool(bold)
    f.italic = bool(italic)
    try:
        f.color.rgb = hex_rgb(color)
    except Exception:
        pass
    stack = font or {}
    if mono:
        stack = stack.get('mono', stack) if isinstance(stack, dict) else font
    latin = (stack or {}).get('latin') or 'Segoe UI'
    ea = (stack or {}).get('ea') or 'Microsoft YaHei'
    try:
        f.name = latin
    except Exception:
        pass
    try:
        from pptx.oxml.ns import qn
        rPr = run._r.get_or_add_rPr()
        for tag, typeface in (('a:latin', latin), ('a:ea', ea), ('a:cs', latin)):
            el = rPr.find(qn(tag))
            if el is None:
                el = rPr.makeelement(qn(tag), {})
                rPr.append(el)
            el.set('typeface', typeface)
    except Exception:
        pass


def add_bullets(slide, items, x, y, w, h, size, color, dim, accent, font, line_spacing=1.32,
                marker='▪', gap_after=6.0, level_sizes=None):
    """项目符号段落：真 bullet 字符 + 悬挂缩进（失败则退化为前缀字符）。"""
    from pptx.util import Inches, Pt
    from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
    from pptx.oxml.ns import nsdecls, qn
    from pptx.oxml import parse_xml
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(max(w, 0.1)), Inches(max(h, 0.1)))
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.TOP
    level_sizes = level_sizes or {0: size, 1: size - 2.0, 2: size - 3.5}
    entries = items or []
    for index, item in enumerate(entries):
        raw = item if isinstance(item, str) else (item or {}).get('text', '')
        level = 0 if isinstance(item, str) else int((item or {}).get('level', 0) or 0)
        bold = False if isinstance(item, str) else bool((item or {}).get('bold'))
        em = False if isinstance(item, str) else bool((item or {}).get('em'))
        own_color = None if isinstance(item, str) else (item or {}).get('color')
        p = tf.paragraphs[0] if index == 0 else tf.add_paragraph()
        p.alignment = PP_ALIGN.LEFT
        this_size = float(level_sizes.get(min(level, 2), size - 4.0))
        try:
            p.line_spacing = float(line_spacing)
            p.space_after = Pt(gap_after if level == 0 else gap_after * 0.6)
        except Exception:
            pass
        use_marker = marker if level == 0 else '–'
        ok = False
        try:
            pPr = p._p.get_or_add_pPr()
            pPr.set('marL', str(int(0.30 * EMU_IN)) if level == 0 else str(int(0.52 * EMU_IN)))
            pPr.set('indent', str(int(-0.24 * EMU_IN)))
            pPr.append(parse_xml('<a:buClr %s><a:srgbClr val="%s"/></a:buClr>' % (nsdecls('a'), str(accent).lstrip('#'))))
            pPr.append(parse_xml('<a:buFont %s typeface="Arial"/>' % nsdecls('a')))
            pPr.append(parse_xml('<a:buChar %s char="%s"/>' % (nsdecls('a'), use_marker)))
            ok = True
        except Exception:
            ok = False
        run = p.add_run()
        run.text = ('' if ok or not use_marker else use_marker + '  ') + str(raw)
        body_color = own_color or (color if (level == 0 and (bold or em)) else (color if level == 0 else dim))
        apply_run(run, font, this_size, body_color, bold=bold or em)
    return box


def add_picture_cover(slide, path, x, y, w, h, radius=None):
    """按 cover 方式裁切填满目标框（不拉伸变形）。"""
    from pptx.util import Inches
    pic = slide.shapes.add_picture(path, Inches(x), Inches(y), width=Inches(w), height=Inches(h))
    try:
        from PIL import Image
        with Image.open(path) as im:
            iw, ih = im.size
        if iw and ih:
            box_ar = w / max(h, 0.01)
            img_ar = iw / ih
            if img_ar > box_ar:
                keep = box_ar / img_ar
                crop = max(0.0, min(0.49, (1.0 - keep) / 2.0))
                pic.crop_left = crop
                pic.crop_right = crop
            else:
                keep = img_ar / box_ar
                crop = max(0.0, min(0.49, (1.0 - keep) / 2.0))
                pic.crop_top = crop
                pic.crop_bottom = crop
    except Exception:
        pass
    return pic


# ──────────────────────────────────────────────────────────── 版面骨架 ──

class Ctx:
    def __init__(self, prs, template, deck, state):
        self.prs = prs
        self.t = template
        self.deck = deck
        self.state = state
        self.W = DEFAULT_W if template.get('aspect') != '4:3' else 10.0
        self.H = DEFAULT_H
        self.mx = float(template['geometry'].get('marginX', 0.86))
        self.my = float(template['geometry'].get('marginY', 0.58))
        self.gap = float(template['geometry'].get('gap', 0.26))
        self.radius = float(template['geometry'].get('radius', 0.1))
        self.content_w = self.W - 2 * self.mx

    # 颜色快捷方式
    @property
    def th(self):
        return self.t['theme']

    def bg(self):
        return self.th.get('bg', '#FFFFFF')

    def fg(self):
        return self.th.get('text', '#111111')

    def dim(self):
        return self.th.get('textDim', '#666666')

    def primary(self):
        return self.th.get('primary', '#2563EB')

    def accent(self):
        return self.th.get('accent', '#F59E0B')

    def font(self, kind='body'):
        return self.t['fonts'].get(kind) or self.t['fonts'].get('body')

    def size(self, key, fallback=16.0):
        return float(self.t['geometry'].get(key, fallback))

    def new_slide(self):
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        return slide


def paint_background(ctx, slide, kind='content'):
    """铺底：内容页用纯色/微渐变，封面与尾页用对角渐变 + 装饰。"""
    style = (ctx.t.get('decor') or {}).get('style', 'soft')
    bg, bg2 = ctx.bg(), ctx.th.get('bg2', ctx.bg())
    if kind in ('cover', 'section', 'end'):
        add_rect(slide, 0, 0, ctx.W, ctx.H, grad=(bg, bg2, 35), fill=bg)
    else:
        add_rect(slide, 0, 0, ctx.W, ctx.H, fill=bg)
    if kind == 'content':
        if style == 'grid':
            step = 0.62
            line_c = mix(bg2, ctx.primary(), 0.35)
            x = ctx.mx * 0.4
            while x < ctx.W - 0.2:
                add_rect(slide, x, 0, 0.006, ctx.H, fill='#%02X%02X%02X' % line_c, alpha=16)
                x += step
        elif style == 'glow':
            add_ellipse(slide, ctx.W - 3.2, -1.4, 4.6, 4.6, ctx.primary(), alpha=7)
            add_ellipse(slide, ctx.W - 1.4, ctx.H - 2.6, 3.6, 3.6, ctx.accent(), alpha=5)
    if kind == 'section':
        add_ellipse(slide, -1.8, ctx.H - 3.4, 6.0, 6.0, ctx.primary(), alpha=10)


def slide_header(ctx, slide, title, kicker=None, subtitle=None):
    """内容页标题区：kicker + 标题 + 主色短线。"""
    y = ctx.my
    if kicker:
        add_text(slide, str(kicker).upper(), ctx.mx, y, ctx.content_w, 0.26, size=ctx.size('kickerSize', 12),
                 color=ctx.primary(), bold=True, font=ctx.font('body'), line_spacing=1.0)
        y += 0.30
    tsize = ctx.size('titleSize', 30)
    add_text(slide, title, ctx.mx, y, ctx.content_w, 0.78, size=tsize, color=ctx.fg(), bold=True,
             font=ctx.font('title'), line_spacing=1.16)
    y += 0.70
    if subtitle:
        add_text(slide, subtitle, ctx.mx, y, ctx.content_w, 0.34, size=tsize * 0.46, color=ctx.dim(),
                 font=ctx.font('body'), line_spacing=1.2)
        y += 0.42
    add_rect(slide, ctx.mx, y + 0.06, 0.86 if not (ctx.t.get('decor') or {}).get('accentBar', True) else 1.1,
             0.045, fill=ctx.primary(), radius=0.02)
    return y + 0.34


def slide_chrome(ctx, slide, index, total, *, show=True):
    if not show or ctx.deck.get('chrome') is False:
        return
    foot = ctx.deck.get('footer') or ctx.deck.get('title') or ''
    add_text(slide, foot, ctx.mx, ctx.H - 0.46, ctx.content_w * 0.6, 0.24, size=ctx.size('smallSize', 11.5),
             color=ctx.dim(), font=ctx.font('body'), line_spacing=1.0)
    add_text(slide, '%02d / %02d' % (index, total), ctx.W - ctx.mx - 1.4, ctx.H - 0.46, 1.4, 0.24,
             size=ctx.size('smallSize', 11.5), color=ctx.dim(), align='right', font=ctx.font('body'), line_spacing=1.0)


def notes(ctx, slide, text):
    if not text:
        return
    try:
        slide.notes_slide.notes_text_frame.text = str(text)
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────── 版式 ──

def layout_cover(ctx, slide, s):
    paint_background(ctx, slide, 'cover')
    decor = ctx.t.get('decor') or {}
    pattern = decor.get('coverPattern', 'orbs')
    if pattern == 'orbs':
        add_ellipse(slide, ctx.W - 4.6, -1.9, 6.6, 6.6, ctx.primary(), alpha=16)
        add_ellipse(slide, ctx.W - 2.6, 1.6, 4.2, 4.2, ctx.accent(), alpha=10)
    elif pattern == 'grid':
        step = 0.44
        x = ctx.W * 0.52
        while x < ctx.W:
            add_rect(slide, x, 0, 0.006, ctx.H, fill=ctx.primary(), alpha=22)
            x += step
        y = 0.0
        while y < ctx.H:
            add_rect(slide, ctx.W * 0.52, y, ctx.W * 0.48, 0.006, fill=ctx.primary(), alpha=22)
            y += step
    elif pattern == 'rule':
        add_rect(slide, ctx.mx, ctx.H - 2.05, ctx.content_w, 0.02, fill=ctx.th.get('line', ctx.dim()))
    elif pattern == 'arc':
        add_ellipse(slide, -2.4, ctx.H - 3.0, 7.2, 7.2, ctx.primary(), alpha=12)
    elif pattern == 'seal':
        add_rect(slide, ctx.W - ctx.mx - 1.5, ctx.my + 0.1, 1.5, 1.5, fill=None,
                 line=mix(ctx.accent(), ctx.bg(), 0.4), line_pt=1.4, radius=0.02)
        add_text(slide, '印', ctx.W - ctx.mx - 1.5, ctx.my + 0.62, 1.5, 0.5, size=30, color=ctx.accent(),
                 align='center', font=ctx.font('title'), line_spacing=1.0)
    elif pattern == 'bars':
        base_x = ctx.W - ctx.mx - 3.1
        heights = [0.9, 1.5, 2.2, 1.25, 1.9, 2.7]
        for i, h in enumerate(heights):
            add_rect(slide, base_x + i * 0.5, ctx.H - 1.25 - h, 0.3, h,
                     fill=ctx.primary() if i % 2 == 0 else mix(ctx.primary(), ctx.bg(), 0.45), radius=0.03)

    hero = s.get('image') or s.get('heroImage')
    text_w = ctx.content_w
    if hero and os.path.exists(str(hero)):
        panel_w = 5.2
        add_picture_cover(slide, str(hero), ctx.W - panel_w, 0, panel_w, ctx.H)
        add_rect(slide, ctx.W - panel_w, 0, panel_w, ctx.H, fill=ctx.bg(), alpha=22)
        text_w = ctx.W - panel_w - ctx.mx * 1.6

    y = ctx.H * 0.26
    kicker = s.get('kicker') or ctx.deck.get('kicker')
    if kicker:
        add_rect(slide, ctx.mx, y, 0.42, 0.045, fill=ctx.accent(), radius=0.02)
        add_text(slide, str(kicker).upper(), ctx.mx + 0.56, y - 0.06, text_w - 0.6, 0.3,
                 size=ctx.size('kickerSize', 12) + 1, color=ctx.accent(), bold=True, font=ctx.font('body'), line_spacing=1.0)
        y += 0.5
    title = s.get('title') or ctx.deck.get('title') or '演示文稿'
    add_text(slide, title, ctx.mx, y, text_w, 2.0, size=ctx.size('coverSize', 44), color=ctx.fg(), bold=True,
             font=ctx.font('title'), line_spacing=1.1)
    y += max(1.4, min(2.4, 0.62 * (1 + len(str(title)) // 14)))
    subtitle = s.get('subtitle') or ctx.deck.get('subtitle')
    if subtitle:
        add_text(slide, subtitle, ctx.mx, y, text_w * 0.92, 0.9, size=ctx.size('bodySize', 16) + 2,
                 color=ctx.dim(), font=ctx.font('body'), line_spacing=1.35)
        y += 0.86
    meta = s.get('meta') or ' · '.join([x for x in [ctx.deck.get('author'), ctx.deck.get('date')] if x])
    if meta:
        add_rect(slide, ctx.mx, ctx.H - 1.42, 0.62, 0.02, fill=mix(ctx.fg(), ctx.bg(), 0.6))
        add_text(slide, meta, ctx.mx, ctx.H - 1.2, text_w, 0.34, size=ctx.size('bodySize', 16) - 1.5,
                 color=ctx.dim(), font=ctx.font('body'), line_spacing=1.2)


def layout_section(ctx, slide, s):
    paint_background(ctx, slide, 'section')
    index = s.get('index')
    if index is None:
        index = s.get('number')
    label = ('%02d' % int(index)) if isinstance(index, (int, float)) else (str(index) if index else '')
    if label:
        add_text(slide, label, ctx.mx, ctx.H * 0.20, 3.0, 1.6, size=76, color=mix(ctx.primary(), ctx.bg(), 0.42),
                 bold=True, font=ctx.font('title'), line_spacing=1.0, shrink=False)
    y = ctx.H * 0.44
    add_text(slide, s.get('title') or '', ctx.mx, y, ctx.content_w * 0.84, 1.0, size=ctx.size('sectionSize', 38),
             color=ctx.fg(), bold=True, font=ctx.font('title'), line_spacing=1.12)
    add_rect(slide, ctx.mx, y + 1.02, 1.3, 0.05, fill=ctx.accent(), radius=0.02)
    if s.get('subtitle'):
        add_text(slide, s['subtitle'], ctx.mx, y + 1.28, ctx.content_w * 0.74, 0.8,
                 size=ctx.size('bodySize', 16) + 1, color=ctx.dim(), font=ctx.font('body'), line_spacing=1.34)


def layout_agenda(ctx, slide, s):
    """议程/目录页：3-6 条编号条目（序号块 + 标题 + 一句说明 + 可选页码）。"""
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    raw = s.get('agenda') or s.get('contents') or s.get('items') or []
    entries = [entry for entry in raw if entry][:6]
    if not entries:
        warn(ctx.state, 'agenda 版式缺少 agenda 条目（3-6 条）')
        return
    if len(entries) < 3:
        warn(ctx.state, 'agenda 只有 %d 条，目录页建议 3-6 条' % len(entries))
    body_bottom = ctx.H - 0.78
    body_h = max(0.8, body_bottom - top)
    gap = min(0.26, max(0.12, body_h * 0.045))
    row_h = max(0.62, min(1.32, (body_h - gap * (len(entries) - 1)) / len(entries)))
    num_w = 0.92
    page_w = 1.25
    text_x = ctx.mx + num_w + 0.3
    text_w = ctx.content_w - num_w - 0.3 - page_w - 0.2
    for i, entry in enumerate(entries):
        if isinstance(entry, str):
            entry = {'title': entry}
        elif not isinstance(entry, dict):
            entry = {'title': str(entry)}
        y = top + i * (row_h + gap)
        color = ctx.primary() if i % 2 == 0 else ctx.accent()
        add_rect(slide, ctx.mx, y, num_w, row_h, fill=color, radius=min(ctx.radius, 0.12))
        add_text(slide, '%02d' % (i + 1), ctx.mx, y, num_w, row_h,
                 size=max(15.0, min(26.0, row_h * 21)), color=text_on(color), bold=True, align='center',
                 anchor='middle', font=ctx.font('title'), line_spacing=1.0, shrink=False)
        title = entry.get('title') or entry.get('text') or ''
        desc = entry.get('desc') or entry.get('description') or ''
        if desc:
            add_text(slide, title, text_x, y + 0.12, text_w, row_h * 0.5,
                     size=ctx.size('bodySize', 16) + 2.5, color=ctx.fg(), bold=True,
                     font=ctx.font('title'), line_spacing=1.12)
            add_text(slide, desc, text_x, y + row_h * 0.5 + 0.06, text_w, row_h * 0.42,
                     size=ctx.size('bodySize', 16) - 1.5, color=ctx.dim(),
                     font=ctx.font('body'), line_spacing=1.24)
        else:
            add_text(slide, title, text_x, y, text_w, row_h,
                     size=ctx.size('bodySize', 16) + 2.5, color=ctx.fg(), bold=True, anchor='middle',
                     font=ctx.font('title'), line_spacing=1.12)
        page = entry.get('page') or entry.get('number') or entry.get('index')
        if page:
            add_text(slide, str(page), ctx.W - ctx.mx - page_w, y + row_h / 2 - 0.17, page_w, 0.34,
                     size=ctx.size('smallSize', 11.5), color=ctx.dim(), align='right',
                     anchor='middle', font=ctx.font('body'), line_spacing=1.0)


def layout_matrix(ctx, slide, s):
    """2×2 象限页：四象限各一个短标题 + 2-4 条要点；可选 x/y 轴标签。"""
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    spec = s.get('matrix') if isinstance(s.get('matrix'), dict) else {}
    raw = spec.get('quadrants') or s.get('quadrants') or []
    quadrants = [quadrant for quadrant in raw if isinstance(quadrant, dict)][:4]
    if not quadrants:
        warn(ctx.state, 'matrix 版式缺少 matrix.quadrants（需要 4 个象限）')
        return
    if len(quadrants) != 4:
        warn(ctx.state, 'matrix 需要 4 个象限，当前只有 %d 个（空白象限留空）' % len(quadrants))
    y_axis = spec.get('yAxis') or spec.get('y')
    x_axis = spec.get('xAxis') or spec.get('x')
    body_bottom = ctx.H - 0.82
    body_h = max(1.2, body_bottom - top)
    axis_w = 0.44 if y_axis else 0.0
    axis_h = 0.38 if x_axis else 0.0
    grid_x = ctx.mx + axis_w
    grid_w = ctx.content_w - axis_w
    grid_h = body_h - axis_h
    gap = 0.24
    cell_w = (grid_w - gap) / 2.0
    cell_h = (grid_h - gap) / 2.0
    if y_axis:
        cy = top + grid_h / 2.0
        box = add_text(slide, str(y_axis), ctx.mx - grid_h / 2.0 + 0.0, cy - 0.16, grid_h, 0.32,
                       size=ctx.size('smallSize', 11.5), color=ctx.dim(), align='center', bold=True,
                       font=ctx.font('body'), line_spacing=1.0, shrink=False)
        try:
            box.rotation = 270
        except Exception:
            pass
    if x_axis:
        add_text(slide, str(x_axis), grid_x, top + grid_h + 0.06, grid_w, 0.28,
                 size=ctx.size('smallSize', 11.5), color=ctx.dim(), align='center', bold=True,
                 font=ctx.font('body'), line_spacing=1.0, shrink=False)
    accents = [ctx.primary(), ctx.accent(), mix(ctx.primary(), ctx.accent(), 0.55),
               mix(ctx.primary(), ctx.bg(), 0.45)]
    # 中轴线：强化 2×2 的象限感（卡片盖掉中段，只在缝隙里露出十字）
    center_x = grid_x + grid_w / 2.0
    center_y = top + grid_h / 2.0
    axis_color = mix(ctx.th.get('line', ctx.dim()), ctx.bg(), 0.2)
    add_rect(slide, center_x - 0.01, top, 0.02, grid_h, fill=axis_color, alpha=80)
    add_rect(slide, grid_x, center_y - 0.01, grid_w, 0.02, fill=axis_color, alpha=80)
    for i in range(4):
        row, col = divmod(i, 2)
        x = grid_x + col * (cell_w + gap)
        y = top + row * (cell_h + gap)
        add_rect(slide, x, y, cell_w, cell_h, fill=ctx.th.get('surface', '#F7F7F7'), radius=ctx.radius)
        add_rect(slide, x, y, cell_w, 0.06, fill=accents[i], radius=0.02)
        quadrant = quadrants[i] if i < len(quadrants) else None
        if not quadrant:
            add_text(slide, '（留空）', x + 0.3, y + 0.32, cell_w - 0.6, 0.36,
                     size=ctx.size('bodySize', 16) - 2, color=ctx.dim(), font=ctx.font('body'), line_spacing=1.1)
            continue
        add_text(slide, str(quadrant.get('title') or ''), x + 0.3, y + 0.24, cell_w - 0.6, 0.4,
                 size=ctx.size('bodySize', 16) + 2, color=ctx.fg(), bold=True,
                 font=ctx.font('title'), line_spacing=1.14)
        items = quadrant.get('items') or quadrant.get('bullets') or quadrant.get('points') or []
        bullets = []
        for item in items:
            if isinstance(item, str):
                bullets.append(item)
            elif isinstance(item, dict) and (item.get('text') or item.get('title')):
                bullets.append(item.get('text') or item.get('title'))
        add_bullets(slide, bullets[:4], x + 0.3, y + 0.78, cell_w - 0.6, cell_h - 0.96,
                    ctx.size('bodySize', 16) - 1.5, ctx.fg(), ctx.dim(), accents[i], ctx.font('body'),
                    line_spacing=1.34, gap_after=5.0)


def layout_bullets(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    items = s.get('bullets') or s.get('items') or []
    insight = s.get('insight')
    body_bottom = ctx.H - 0.78
    body_h = body_bottom - top
    if insight:
        card_w = min(4.3, ctx.content_w * 0.36)
        card_h = min(body_h, 1.5 + 0.34 * max(2, (len(str(insight)) // 16) + 1), 3.0)
        add_rect(slide, ctx.W - ctx.mx - card_w, top, card_w, card_h, fill=ctx.th.get('surface', '#F2F2F2'),
                 radius=ctx.radius)
        add_rect(slide, ctx.W - ctx.mx - card_w + 0.28, top + 0.3, 0.5, 0.045, fill=ctx.accent(), radius=0.02)
        add_text(slide, s.get('insightTitle') or '要点', ctx.W - ctx.mx - card_w + 0.3, top + 0.5, card_w - 0.6, 0.32,
                 size=ctx.size('bodySize', 16) - 2, color=ctx.primary(), bold=True, font=ctx.font('body'), line_spacing=1.1)
        add_text(slide, insight, ctx.W - ctx.mx - card_w + 0.3, top + 0.92, card_w - 0.6,
                 card_h - 1.16, size=ctx.size('bodySize', 16) - 1, color=ctx.fg(),
                 font=ctx.font('body'), line_spacing=1.4)
        text_w = ctx.content_w - card_w - 0.42
    else:
        text_w = min(ctx.content_w, ctx.content_w * 0.94)
    per = max(1.0, len([i for i in items if isinstance(i, dict) and int(i.get('level', 0) or 0) > 0]) * 0.55)
    count = max(1.0, len(items) + per)
    size = ctx.size('bodySize', 16) + (3.5 if count <= 4 else 1.5)  # 稀疏页给足字号，别缩在角落
    while size > 11 and count * (size * 1.62) / 72.0 > body_h:
        size -= 0.5
    add_bullets(slide, items, ctx.mx, top + 0.12, text_w, body_h - 0.12, size, ctx.fg(), ctx.dim(), ctx.accent(),
                ctx.font('body'), line_spacing=1.42, gap_after=size * 0.42, marker=s.get('marker', '▪'))


def layout_two_col(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    columns = s.get('columns') or []
    if not columns:
        columns = [{'title': '', 'bullets': s.get('bullets') or []}]
    columns = columns[:3]
    n = len(columns)
    gap = 0.42
    col_w = (ctx.content_w - gap * (n - 1)) / max(n, 1)
    body_h = ctx.H - 0.8 - top
    for i, col in enumerate(columns):
        x = ctx.mx + i * (col_w + gap)
        head_color = ctx.primary() if i % 2 == 0 else ctx.accent()
        add_rect(slide, x, top, col_w, body_h, fill=ctx.th.get('surface', '#F7F7F7'), radius=ctx.radius)
        add_rect(slide, x, top, col_w, 0.05, fill=head_color, radius=0.02)
        cy = top + 0.3
        if col.get('title'):
            add_text(slide, col['title'], x + 0.3, cy, col_w - 0.6, 0.36, size=ctx.size('bodySize', 16) + 1.5,
                     color=ctx.fg(), bold=True, font=ctx.font('title'), line_spacing=1.15)
            cy += 0.56
        items = col.get('bullets') or col.get('items') or []
        size = ctx.size('bodySize', 16) - 0.5
        add_bullets(slide, items, x + 0.3, cy, col_w - 0.6, top + body_h - cy - 0.3, size, ctx.fg(), ctx.dim(),
                    head_color, ctx.font('body'), line_spacing=1.38, gap_after=6.0)


def layout_cards(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    cards = (s.get('cards') or [])[:6]
    if not cards:
        warn(ctx.state, 'cards 版式缺少 cards 数组')
        return
    body_h = ctx.H - 0.82 - top
    cols = 2 if len(cards) <= 2 else (3 if len(cards) == 3 else (2 if len(cards) == 4 else 3))
    rows = (len(cards) + cols - 1) // cols
    gap = 0.3
    cw = (ctx.content_w - gap * (cols - 1)) / cols
    block_h = min(body_h, rows * 2.35 + (rows - 1) * gap)  # 卡片不留过高的空肚子
    ch = (block_h - gap * (rows - 1)) / rows
    for i, card in enumerate(cards):
        r, c = divmod(i, cols)
        x = ctx.mx + c * (cw + gap)
        y = top + r * (ch + gap)
        add_rect(slide, x, y, cw, ch, fill=ctx.th.get('surface', '#F7F7F7'), radius=ctx.radius)
        accent = card.get('color') or (ctx.primary() if i % 2 == 0 else ctx.accent())
        add_rect(slide, x + 0.3, y + 0.3, 0.46, 0.05, fill=accent, radius=0.02)
        ty = y + 0.48
        if card.get('icon'):
            add_text(slide, str(card['icon']), x + 0.3, ty - 0.04, 0.6, 0.42, size=22, color=accent,
                     font=ctx.font('title'), line_spacing=1.0, shrink=False)
            icon_w = 0.62
        else:
            icon_w = 0.0
        add_text(slide, card.get('title') or '', x + 0.3 + icon_w, ty, cw - 0.6 - icon_w, 0.38,
                 size=ctx.size('bodySize', 16) + 1.5, color=ctx.fg(), bold=True, font=ctx.font('title'), line_spacing=1.15)
        if card.get('body') or card.get('text'):
            add_text(slide, card.get('body') or card.get('text'), x + 0.3, ty + 0.52, cw - 0.6, ch - 1.1,
                     size=ctx.size('bodySize', 16) - 1.5, color=ctx.dim(), font=ctx.font('body'), line_spacing=1.42)


def layout_kpi(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    kpis = (s.get('kpi') or s.get('stats') or [])[:4]
    if not kpis:
        warn(ctx.state, 'kpi 版式缺少 kpi 数组')
        return
    n = len(kpis)
    gap = 0.3
    tw = (ctx.content_w - gap * (n - 1)) / n
    th = min(2.6, ctx.H - 0.9 - top)
    for i, item in enumerate(kpis):
        x = ctx.mx + i * (tw + gap)
        add_rect(slide, x, top, tw, th, fill=ctx.th.get('surface', '#F7F7F7'), radius=ctx.radius)
        add_rect(slide, x, top, tw, 0.06, fill=ctx.primary() if i % 2 == 0 else ctx.accent(), radius=0.02)
        value = str(item.get('value', ''))
        vy = top + 0.42
        add_text(slide, value, x + 0.28, vy, tw - 0.5, 1.1, size=46 if len(value) <= 7 else 34,
                 color=ctx.primary() if i % 2 == 0 else ctx.fg(), bold=True, font=ctx.font('title'),
                 line_spacing=1.0, shrink=len(value) > 7)
        unit = item.get('unit')
        if unit:
            add_text(slide, str(unit), x + 0.28, vy + 1.0, tw - 0.5, 0.3, size=ctx.size('bodySize', 16) - 2,
                     color=ctx.dim(), font=ctx.font('body'), line_spacing=1.0)
            ly = vy + 1.3
        else:
            ly = vy + 1.14
        add_text(slide, item.get('label') or item.get('title') or '', x + 0.28, ly, tw - 0.5, 0.5,
                 size=ctx.size('bodySize', 16) - 0.5, color=ctx.fg(), bold=True, font=ctx.font('body'), line_spacing=1.2)
        delta = item.get('delta')
        if delta:
            good = not str(delta).strip().startswith('-')
            chip = '#2E9E6B' if good else '#D9534F'
            chip_w = min(tw - 0.56, max(0.9, text_width_estimate(delta, 12) + 0.4))
            add_rect(slide, x + 0.28, ly + (0.52 if not item.get('hint') else 0.5), chip_w, 0.32,
                     fill=chip, alpha=88, radius=0.16)
            add_text(slide, str(delta), x + 0.28, ly + (0.56 if not item.get('hint') else 0.54), chip_w, 0.26,
                     size=11.5, color='#FFFFFF', align='center', bold=True, font=ctx.font('body'), line_spacing=1.0)
        if item.get('hint'):
            add_text(slide, item['hint'], x + 0.28, ly + 0.94, tw - 0.5, 0.56, size=ctx.size('smallSize', 11.5),
                     color=ctx.dim(), font=ctx.font('body'), line_spacing=1.32)


def layout_timeline(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    steps = (s.get('steps') or [])[:6]
    if not steps:
        warn(ctx.state, 'timeline 版式缺少 steps 数组')
        return
    n = len(steps)
    rail_y = top + 1.5
    add_rect(slide, ctx.mx + 0.2, rail_y, ctx.content_w - 0.4, 0.035, fill=ctx.th.get('line', ctx.dim()), radius=0.02)
    seg = (ctx.content_w - 0.4) / max(n - 1, 1) if n > 1 else 0
    for i, step in enumerate(steps):
        cx = ctx.mx + 0.2 + (i * seg if n > 1 else ctx.content_w / 2 - 0.2)
        add_ellipse(slide, cx - 0.13, rail_y - 0.11, 0.26, 0.26, ctx.primary())
        add_ellipse(slide, cx - 0.05, rail_y - 0.03, 0.1, 0.1, ctx.bg())
        box_w = min(3.3, max(1.9, ctx.content_w / max(n, 1) - 0.16))
        bx = min(max(cx - box_w / 2, ctx.mx), ctx.W - ctx.mx - box_w)
        above = i % 2 == 0
        if step.get('time'):
            ty = rail_y - 0.62 if above else rail_y + 0.4
            add_text(slide, str(step['time']), bx, ty, box_w, 0.28, size=ctx.size('smallSize', 11.5) + 0.5,
                     color=ctx.primary(), bold=True, align='center', font=ctx.font('body'), line_spacing=1.0)
        ty = rail_y - 1.72 if above else rail_y + 0.72
        card_h = 1.0
        add_rect(slide, bx, ty, box_w, card_h, fill=ctx.th.get('surface', '#F7F7F7'), radius=ctx.radius)
        add_text(slide, step.get('title') or '', bx + 0.22, ty + 0.18, box_w - 0.44, 0.34,
                 size=ctx.size('bodySize', 16) - 0.5, color=ctx.fg(), bold=True, font=ctx.font('title'), line_spacing=1.14)
        add_text(slide, step.get('desc') or step.get('text') or '', bx + 0.22, ty + 0.56, box_w - 0.44, 0.4,
                 size=ctx.size('smallSize', 11.5) + 0.5, color=ctx.dim(), font=ctx.font('body'), line_spacing=1.28)


def layout_process(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    steps = (s.get('steps') or [])[:5]
    if not steps:
        warn(ctx.state, 'process 版式缺少 steps 数组')
        return
    from pptx.enum.shapes import MSO_SHAPE
    n = len(steps)
    gap = 0.16
    cw = (ctx.content_w - gap * (n - 1)) / n
    ch = 0.92
    for i, step in enumerate(steps):
        x = ctx.mx + i * (cw + gap)
        color = ctx.primary() if i % 2 == 0 else mix(ctx.primary(), ctx.accent(), 0.35)
        add_rect(slide, x, top, cw, ch, fill=color, radius=0.06, shape_type=MSO_SHAPE.PENTAGON)
        add_text(slide, step.get('title') or ('步骤 %d' % (i + 1)), x + 0.3, top + 0.16, cw - 0.62, 0.6,
                 size=ctx.size('bodySize', 16) - 1.5, color=text_on(color), bold=True, align='center',
                 anchor='middle', font=ctx.font('title'), line_spacing=1.1)
        add_text(slide, step.get('desc') or step.get('text') or '', x, top + ch + 0.26, cw, 1.5,
                 size=ctx.size('bodySize', 16) - 2.5, color=ctx.dim(), font=ctx.font('body'), line_spacing=1.4)


def layout_image(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    variant = s.get('variant') or s.get('position') or 'right'
    img = s.get('image')
    if not img or not os.path.exists(str(img)):
        warn(ctx.state, 'image 版式缺少可用图片：%s' % img)
        return
    if variant == 'full':
        add_picture_cover(slide, str(img), 0, 0, ctx.W, ctx.H)
        add_rect(slide, 0, 0, ctx.W, ctx.H, fill='#000000', alpha=52)
        add_text(slide, s.get('title') or '', ctx.mx, ctx.H * 0.52, ctx.content_w * 0.8, 1.2,
                 size=ctx.size('sectionSize', 38) * 0.9, color='#FFFFFF', bold=True, font=ctx.font('title'), line_spacing=1.14)
        if s.get('subtitle') or s.get('caption'):
            add_text(slide, s.get('subtitle') or s.get('caption'), ctx.mx, ctx.H * 0.52 + 1.18, ctx.content_w * 0.72, 0.7,
                     size=ctx.size('bodySize', 16) + 1, color='#EDEDED', font=ctx.font('body'), line_spacing=1.34)
        return
    left = variant == 'left'
    img_w = ctx.content_w * 0.52
    text_w = ctx.content_w - img_w - 0.5
    img_x = ctx.mx if left else ctx.W - ctx.mx - img_w
    text_x = ctx.mx + img_w + 0.5 if left else ctx.mx
    top = ctx.my
    body_h = ctx.H - 1.1 - top
    image_h = min(body_h, 4.6)
    add_picture_cover(slide, str(img), img_x, top, img_w, image_h, radius=ctx.radius)
    cy = top + 0.04
    if s.get('kicker'):
        add_text(slide, str(s['kicker']).upper(), text_x, cy, text_w, 0.28, size=ctx.size('kickerSize', 12),
                 color=ctx.primary(), bold=True, font=ctx.font('body'), line_spacing=1.0)
        cy += 0.36
    add_text(slide, s.get('title') or '', text_x, cy, text_w, 1.0, size=ctx.size('titleSize', 30) * 0.92,
             color=ctx.fg(), bold=True, font=ctx.font('title'), line_spacing=1.16)
    cy += 0.96
    add_rect(slide, text_x, cy, 0.86, 0.045, fill=ctx.accent(), radius=0.02)
    cy += 0.26
    if s.get('subtitle'):
        add_text(slide, s['subtitle'], text_x, cy, text_w, 0.7, size=ctx.size('bodySize', 16),
                 color=ctx.dim(), font=ctx.font('body'), line_spacing=1.36)
        cy += 0.78
    if s.get('bullets'):
        add_bullets(slide, s['bullets'], text_x, cy, text_w, top + body_h - cy, ctx.size('bodySize', 16) - 1,
                    ctx.fg(), ctx.dim(), ctx.accent(), ctx.font('body'), line_spacing=1.38)
    if s.get('caption'):
        add_text(slide, s['caption'], img_x, top + image_h + 0.18, img_w, 0.4, size=ctx.size('smallSize', 11.5),
                 color=ctx.dim(), font=ctx.font('body'), line_spacing=1.3)


def layout_quote(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    add_text(slide, '“', ctx.mx, ctx.H * 0.16, 2.0, 1.4, size=110, color=mix(ctx.primary(), ctx.bg(), 0.35),
             font=ctx.font('title'), line_spacing=1.0, shrink=False)
    quote = s.get('quote') or s.get('title') or ''
    add_text(slide, quote, ctx.mx + 0.5, ctx.H * 0.32, ctx.content_w - 1.0, 2.4,
             size=ctx.size('sectionSize', 38) * 0.72, color=ctx.fg(), bold=True, font=ctx.font('title'), line_spacing=1.3)
    y = ctx.H * 0.32 + 2.55
    add_rect(slide, ctx.mx + 0.5, y, 0.86, 0.045, fill=ctx.accent(), radius=0.02)
    if s.get('author'):
        add_text(slide, s['author'], ctx.mx + 0.5, y + 0.24, ctx.content_w - 1.0, 0.36,
                 size=ctx.size('bodySize', 16), color=ctx.fg(), bold=True, font=ctx.font('body'), line_spacing=1.2)
    if s.get('role'):
        add_text(slide, s['role'], ctx.mx + 0.5, y + 0.62, ctx.content_w - 1.0, 0.32,
                 size=ctx.size('bodySize', 16) - 2, color=ctx.dim(), font=ctx.font('body'), line_spacing=1.2)


def layout_table(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    spec = s.get('table') or {}
    head = list(spec.get('head') or [])
    rows = [list(r) for r in (spec.get('rows') or [])]
    if not head and rows:
        head = [str(c) for c in rows[0]]
        rows = rows[1:]
    if not head:
        warn(ctx.state, 'table 版式缺少表头')
        return
    cols = len(head)
    data = ([head] + rows)[:14]
    width = ctx.content_w
    height = min(ctx.H - 0.9 - top, 0.5 * len(data))
    from pptx.util import Inches
    from pptx.enum.text import PP_ALIGN
    shape = slide.shapes.add_table(len(data), cols, Inches(ctx.mx), Inches(top), Inches(width), Inches(height))
    table = shape.table
    table.first_row = True
    table.horz_banding = False
    weights = spec.get('widths')
    if not isinstance(weights, list) or len(weights) != cols:
        weights = None
    for c in range(cols):
        table.columns[c].width = Inches(width * ((weights[c] if weights else 1.0) / sum(weights or [1.0] * cols)))
    for r, row in enumerate(data):
        for c in range(cols):
            cell = table.cell(r, c)
            value = str(row[c]) if c < len(row) and row[c] is not None else ''
            cell.margin_left = cell.margin_right = Inches(0.14)
            cell.margin_top = cell.margin_bottom = Inches(0.06)
            try:
                from pptx.enum.text import MSO_ANCHOR
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            except Exception:
                pass
            numeric = bool(value) and all(ch in '0123456789.,%+-− ()￥$¥万亿元%/' for ch in value)
            frame = cell.text_frame
            frame.word_wrap = True
            p = frame.paragraphs[0]
            run = p.add_run()
            run.text = value
            if r == 0:
                cell.fill.solid()
                cell.fill.fore_color.rgb = hex_rgb(ctx.primary())
                apply_run(run, ctx.font('title'), ctx.size('bodySize', 16) - 1.5, text_on(ctx.primary()), bold=True)
                p.alignment = PP_ALIGN.RIGHT if numeric else PP_ALIGN.LEFT
            else:
                cell.fill.solid()
                cell.fill.fore_color.rgb = hex_rgb(ctx.th.get('surface', '#F7F7F7') if r % 2 == 1 else ctx.bg())
                apply_run(run, ctx.font('body'), ctx.size('bodySize', 16) - 1.5,
                          ctx.fg() if c == 0 else (ctx.fg() if numeric else ctx.dim()), bold=(c == 0))
                p.alignment = PP_ALIGN.RIGHT if numeric else PP_ALIGN.LEFT


CHART_TYPES = {
    'bar': 'COLUMN_CLUSTERED',
    'column': 'COLUMN_CLUSTERED',
    'bar-h': 'BAR_CLUSTERED',
    'line': 'LINE_MARKERS',
    'area': 'AREA',
    'pie': 'PIE',
    'doughnut': 'DOUGHNUT',
    'stacked': 'COLUMN_STACKED',
    'radar': 'RADAR_MARKERS',
}

# 散点图不能走 CategoryChartData：series 是 (x, y) 数值对，必须用 XyChartData。
SCATTER_TYPES = ('scatter', 'xy', 'scatter-xy')


def scatter_points(item):
    """把 series 的 points 归一化成 [(x, y), ...]；支持 [{x,y}] 与 [[x,y]]。"""
    points = []
    for point in (item or {}).get('points') or []:
        try:
            if isinstance(point, dict):
                px, py = point.get('x'), point.get('y')
            else:
                px, py = point[0], point[1]
            points.append((float(px), float(py)))
        except Exception:
            continue
    return points


def layout_chart(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    spec = s.get('chart') or {}
    categories = spec.get('categories') or []
    series = spec.get('series') or []
    chart_kind = str(spec.get('type', 'bar')).lower()
    is_scatter = chart_kind in SCATTER_TYPES
    if is_scatter:
        series = [item for item in series if scatter_points(item)]
        if not series:
            warn(ctx.state, 'scatter 图表缺少 series[].points（[{x,y}, ...]）')
            return
    elif not categories or not series:
        warn(ctx.state, 'chart 版式缺少 categories/series')
        return
    insight = s.get('insight')
    body_h = ctx.H - 0.86 - top
    chart_w = ctx.content_w * (0.63 if insight else 1.0)
    from pptx.chart.data import CategoryChartData, XyChartData
    from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION, XL_MARKER_STYLE
    from pptx.util import Inches, Pt
    if is_scatter:
        cd = XyChartData()
        for item in series:
            data_series = cd.add_series(str(item.get('name') or 'Series'))
            for px, py in scatter_points(item):
                try:
                    data_series.add_data_point(px, py)
                except Exception:
                    continue
        kind = 'XY_SCATTER'
    else:
        cd = CategoryChartData()
        cd.categories = [str(c) for c in categories]
        for item in series:
            cd.add_series(str(item.get('name') or 'Series'),
                          tuple(float(v) if v not in (None, '') else 0.0 for v in item.get('values', [])))
        kind = CHART_TYPES.get(chart_kind, 'COLUMN_CLUSTERED')
    try:
        chart_type = getattr(XL_CHART_TYPE, kind)
    except Exception:
        chart_type = XL_CHART_TYPE.XY_SCATTER if is_scatter else XL_CHART_TYPE.COLUMN_CLUSTERED
    gf = slide.shapes.add_chart(chart_type, Inches(ctx.mx), Inches(top + 0.06), Inches(chart_w), Inches(body_h - 0.1), cd)
    chart = gf.chart
    palette = [ctx.primary(), ctx.accent(), ctx.th.get('primary2', ctx.primary()),
               mix(ctx.primary(), ctx.accent(), 0.65), '#7C9CBF', '#B6A08A']
    try:
        chart.font.size = Pt(max(9.0, ctx.size('smallSize', 11.5)))
        chart.font.name = (ctx.font('body') or {}).get('latin')
        chart.font.color.rgb = hex_rgb(ctx.dim())
        chart.has_legend = len(series) > 1 or kind in ('PIE', 'DOUGHNUT')
        if chart.has_legend:
            chart.legend.position = XL_LEGEND_POSITION.BOTTOM
            chart.legend.include_in_layout = False
        plot = chart.plots[0]
        try:
            # 雷达图 / 散点图不支持 gap_width，单独兜住，别拖垮后面的样式。
            if kind not in ('RADAR_MARKERS', 'XY_SCATTER'):
                plot.gap_width = 55
        except Exception:
            pass
        wants_labels = kind in ('PIE', 'DOUGHNUT') or spec.get('labels') is True
        if wants_labels and kind != 'XY_SCATTER':
            # 散点图（CT_ScatterChart）没有图表级 dLbls，设了会抛异常；其余类型单独兜住。
            try:
                plot.has_data_labels = True
                labels = plot.data_labels
                labels.number_format = spec.get('numberFormat', '0"%"' if kind in ('PIE', 'DOUGHNUT') else '0.#')
                labels.number_format_is_linked = False
                labels.position = XL_LABEL_POSITION.OUTSIDE_END if kind not in ('PIE', 'DOUGHNUT') else XL_LABEL_POSITION.BEST_FIT
                labels.font.size = Pt(max(9.0, ctx.size('smallSize', 11.5)))
                labels.font.color.rgb = hex_rgb(ctx.fg())
            except Exception:
                pass
        for i, one in enumerate(plot.series):
            if kind in ('PIE', 'DOUGHNUT'):
                for j, point in enumerate(one.points):
                    point.format.fill.solid()
                    point.format.fill.fore_color.rgb = hex_rgb(palette[j % len(palette)])
            elif kind in ('RADAR_MARKERS', 'XY_SCATTER'):
                # 雷达=线条+标记；散点=纯标记（不连线），避免连成一条误导趋势的线。
                color = hex_rgb(palette[i % len(palette)])
                try:
                    if kind == 'XY_SCATTER':
                        one.format.line.fill.background()
                    else:
                        one.format.line.color.rgb = color
                        one.format.line.width = Pt(2.0)
                    marker = one.marker
                    marker.style = XL_MARKER_STYLE.CIRCLE
                    marker.size = 8 if kind == 'XY_SCATTER' else 6
                    marker.format.fill.solid()
                    marker.format.fill.fore_color.rgb = color
                    marker.format.line.color.rgb = color
                except Exception:
                    pass
            else:
                one.format.fill.solid()
                one.format.fill.fore_color.rgb = hex_rgb(palette[i % len(palette)])
        try:
            chart.value_axis.has_major_gridlines = True
            chart.value_axis.major_gridlines.format.line.color.rgb = hex_rgb(ctx.th.get('line', ctx.dim()))
            chart.value_axis.major_gridlines.format.line.width = Pt(0.5)
            chart.value_axis.format.line.fill.background()
            chart.category_axis.format.line.color.rgb = hex_rgb(ctx.th.get('line', ctx.dim()))
        except Exception:
            pass
    except Exception as exc:
        warn(ctx.state, '图表样式部分未应用：%s' % exc)
    if insight:
        card_x = ctx.mx + chart_w + 0.34
        card_w = ctx.content_w - chart_w - 0.34
        add_rect(slide, card_x, top + 0.06, card_w, body_h - 0.1, fill=ctx.th.get('surface', '#F7F7F7'), radius=ctx.radius)
        add_rect(slide, card_x + 0.28, top + 0.34, 0.5, 0.045, fill=ctx.accent(), radius=0.02)
        add_text(slide, s.get('insightTitle') or '解读', card_x + 0.3, top + 0.54, card_w - 0.6, 0.3,
                 size=ctx.size('bodySize', 16) - 2, color=ctx.primary(), bold=True, font=ctx.font('body'), line_spacing=1.1)
        add_text(slide, insight, card_x + 0.3, top + 0.94, card_w - 0.6, body_h - 1.4,
                 size=ctx.size('bodySize', 16) - 1.5, color=ctx.fg(), font=ctx.font('body'), line_spacing=1.44)


def layout_compare(ctx, slide, s):
    paint_background(ctx, slide, 'content')
    top = slide_header(ctx, slide, s.get('title') or '', s.get('kicker'), s.get('subtitle'))
    left = s.get('left') or {}
    right = s.get('right') or {}
    gap = 0.36
    cw = (ctx.content_w - gap) / 2
    body_h = min(ctx.H - 0.86 - top, 1.55 + 0.54 * max(len(left.get('items') or []), len(right.get('items') or []), 3))
    for i, (col, color) in enumerate(((left, '#2E9E6B'), (right, '#D9534F'))):
        x = ctx.mx + i * (cw + gap)
        add_rect(slide, x, top, cw, body_h, fill=ctx.th.get('surface', '#F7F7F7'), radius=ctx.radius)
        add_rect(slide, x, top, cw, 0.06, fill=color, radius=0.02)
        add_text(slide, col.get('title') or ('方案 A' if i == 0 else '方案 B'), x + 0.32, top + 0.32, cw - 0.64, 0.44,
                 size=ctx.size('bodySize', 16) + 3, color=ctx.fg(), bold=True, font=ctx.font('title'), line_spacing=1.15)
        add_rect(slide, x + 0.32, top + 0.86, 0.5, 0.04, fill=color, radius=0.02)
        items = col.get('items') or col.get('bullets') or []
        mark = '✓' if i == 0 else '✗'
        add_bullets(slide, items, x + 0.32, top + 1.06, cw - 0.64, body_h - 1.4,
                    ctx.size('bodySize', 16) - 1, ctx.fg(), ctx.dim(), color, ctx.font('body'),
                    line_spacing=1.4, marker=mark)


def layout_end(ctx, slide, s):
    paint_background(ctx, slide, 'end')
    add_ellipse(slide, ctx.W / 2 - 3.2, ctx.H * 0.1, 6.4, 6.4, ctx.primary(), alpha=12)
    add_text(slide, s.get('title') or '谢谢观看', ctx.mx, ctx.H * 0.36, ctx.content_w, 1.2,
             size=ctx.size('coverSize', 44) * 0.9, color=ctx.fg(), bold=True, align='center',
             font=ctx.font('title'), line_spacing=1.1)
    add_rect(slide, ctx.W / 2 - 0.55, ctx.H * 0.36 + 1.24, 1.1, 0.05, fill=ctx.accent(), radius=0.02)
    sub = s.get('subtitle') or ctx.deck.get('subtitle')
    if sub:
        add_text(slide, sub, ctx.mx, ctx.H * 0.36 + 1.5, ctx.content_w, 0.5, size=ctx.size('bodySize', 16) + 1,
                 color=ctx.dim(), align='center', font=ctx.font('body'), line_spacing=1.3)
    contact = s.get('contact') or ' · '.join([x for x in [ctx.deck.get('author'), ctx.deck.get('date')] if x])
    if contact:
        add_text(slide, contact, ctx.mx, ctx.H - 1.3, ctx.content_w, 0.34, size=ctx.size('smallSize', 11.5) + 1,
                 color=ctx.dim(), align='center', font=ctx.font('body'), line_spacing=1.2)


LAYOUTS = {
    'cover': layout_cover,
    'section': layout_section,
    'agenda': layout_agenda,
    'bullets': layout_bullets,
    'two-col': layout_two_col,
    'cards': layout_cards,
    'kpi': layout_kpi,
    'timeline': layout_timeline,
    'process': layout_process,
    'image': layout_image,
    'quote': layout_quote,
    'table': layout_table,
    'chart': layout_chart,
    'compare': layout_compare,
    'matrix': layout_matrix,
    'end': layout_end,
}

ALIASES = {
    'title': 'cover',
    'toc': 'agenda',
    'contents': 'agenda',
    'outline': 'agenda',
    'agenda-page': 'agenda',
    'bullets-lite': 'bullets',
    'list': 'bullets',
    'two-columns': 'two-col',
    'columns': 'two-col',
    'grid': 'cards',
    'stats': 'kpi',
    'metrics': 'kpi',
    'roadmap': 'timeline',
    'steps': 'process',
    'flow': 'process',
    'photo': 'image',
    'picture': 'image',
    'full-bleed': 'image',
    'quote-slide': 'quote',
    'thanks': 'end',
    'closing': 'end',
    'vs': 'compare',
    'data': 'chart',
    'quadrant': 'matrix',
    'quadrants': 'matrix',
    '2x2': 'matrix',
}


# ─────────────────────────────────────────────────────────── 预览图 ──

FONT_FILE_MAP = {
    'microsoft yahei': ['msyh.ttc', 'msyh.ttf'],
    'microsoft yahei ui': ['msyh.ttc'],
    '微软雅黑': ['msyh.ttc'],
    'microsoft yahei bold': ['msyhbd.ttc'],
    'segoe ui': ['segoeui.ttf'],
    'segoe ui semibold': ['seguisb.ttf', 'segoeui.ttf'],
    'segoe ui bold': ['segoeuib.ttf'],
    'georgia': ['georgia.ttf'],
    'arial': ['arial.ttf'],
    'arial bold': ['arialbd.ttf'],
    'consolas': ['consola.ttf'],
    'simhei': ['simhei.ttf'],
    '黑体': ['simhei.ttf'],
    'simsun': ['simsun.ttc'],
    '宋体': ['simsun.ttc'],
    'kaiti': ['simkai.ttf'],
    '楷体': ['simkai.ttf'],
    'dengxian': ['Deng.ttf'],
    '等线': ['Deng.ttf'],
    'source han sans': ['SourceHanSansSC-Regular.otf', 'SourceHanSansCN-Regular.otf'],
    'noto sans cjk sc': ['NotoSansCJKsc-Regular.otf'],
}

FONT_DIRS = [
    os.path.join(os.environ.get('WINDIR', 'C:\\Windows'), 'Fonts'),
    os.path.expanduser('~/AppData/Local/Microsoft/Windows/Fonts'),
    '/System/Library/Fonts',
    '/Library/Fonts',
    '/usr/share/fonts',
    '/usr/share/fonts/truetype',
]


def find_font(names, bold=False):
    """把字体名解析成实际字体文件路径（预览图用）。"""
    candidates = []
    for name in names:
        if not name:
            continue
        key = str(name).strip().lower()
        if bold:
            candidates.extend(FONT_FILE_MAP.get(key + ' bold', []))
        candidates.extend(FONT_FILE_MAP.get(key, []))
        candidates.append(str(name))
    for directory in FONT_DIRS:
        if not os.path.isdir(directory):
            continue
        for candidate in candidates:
            path = os.path.join(directory, candidate)
            if os.path.exists(path):
                return path
    # 目录内模糊匹配（含子目录，取第一个命中）
    wanted = [str(n).lower().replace(' ', '') for n in names if n]
    for directory in FONT_DIRS:
        if not os.path.isdir(directory):
            continue
        for root, _dirs, files in os.walk(directory):
            for fname in files:
                if not fname.lower().endswith(('.ttf', '.ttc', '.otf')):
                    continue
                flat = fname.lower().replace(' ', '')
                for want in wanted:
                    if want and want[:6] in flat:
                        return os.path.join(root, fname)
    return None


def wrap_text(draw, text, font, max_width):
    lines, line = [], ''
    for ch in str(text or ''):
        if ch == '\n':
            lines.append(line)
            line = ''
            continue
        trial = line + ch
        if draw.textlength(trial, font=font) > max_width and line:
            lines.append(line)
            line = ch
        else:
            line = trial
    if line or not lines:
        lines.append(line)
    return lines


def render_preview(ctx, state, slides_spec, out_path, grid=3, width=620):
    """把每一页画成缩略图拼成联络表（contact sheet），用于快速审版。"""
    from PIL import Image, ImageDraw, ImageFont
    bg = ctx.bg()
    pad, gap, header = 26, 16, 66
    tile_h = int(width * ctx.H / ctx.W)
    rows = (len(slides_spec) + grid - 1) // grid
    canvas_w = pad * 2 + width * grid + gap * (grid - 1)
    canvas_h = header + pad + rows * tile_h + gap * (rows - 1) + pad
    sheet_bg = mix(bg, '#808080', 0.72)
    img = Image.new('RGB', (canvas_w, canvas_h), sheet_bg)
    draw = ImageDraw.Draw(img)

    title_font_path = find_font([(ctx.font('title') or {}).get('ea'), (ctx.font('title') or {}).get('latin'), 'Microsoft YaHei'])
    body_font_path = find_font([(ctx.font('body') or {}).get('ea'), (ctx.font('body') or {}).get('latin'), 'Microsoft YaHei'])

    def load(path, size, fallback=ImageFont.load_default):
        try:
            if path:
                return ImageFont.truetype(path, size)
        except Exception:
            pass
        try:
            return ImageFont.truetype('arial.ttf', size)
        except Exception:
            return fallback()

    f_head = load(title_font_path, 26)
    f_head_s = load(body_font_path, 15)
    draw.text((pad, 16), '%s · %s' % (ctx.deck.get('title') or '演示文稿', ctx.t.get('name') or ''), font=f_head,
              fill=text_on(sheet_bg))
    draw.text((pad, 44), '%d 页 · 模板 %s · 16:9' % (len(slides_spec), ctx.t.get('id')), font=f_head_s,
              fill=mix('#808080', sheet_bg, 0.35))
    sw = 26
    for i, key in enumerate(('primary', 'accent', 'surface', 'text', 'bg')):
        c = ctx.th.get(key, '#888888')
        draw.rectangle([canvas_w - pad - (5 - i) * sw, 18, canvas_w - pad - (4 - i) * sw - 4, 44], fill=c,
                       outline=mix('#808080', sheet_bg, 0.5))

    for i, s in enumerate(slides_spec):
        r, c = divmod(i, grid)
        x0 = pad + c * (width + gap)
        y0 = header + r * (tile_h + gap)
        try:
            tile = draw_tile(ctx, s, width, tile_h, load, title_font_path, body_font_path)
        except Exception as exc:  # 单页画崩不该毁掉整张联络表
            tb_lines = traceback.format_exc().strip().splitlines()
            where = ''
            for line in reversed(tb_lines):
                if ', line ' in line:
                    where = line.strip()
                    break
            warn(state, '第 %d 页预览绘制失败：%s @ %s' % (i + 1, exc, where))
            tile = Image.new('RGB', (width, tile_h), mix(bg, '#C0392B', 0.3))
            fallback = ImageDraw.Draw(tile)
            fallback.text((12, 12), '预览绘制失败', font=f_head_s, fill='#FFFFFF')
            fallback.text((12, 36), '%s' % exc, font=f_head_s, fill='#FFE0E0')
            fallback.text((12, 60), str(s.get('title') or s.get('layout') or ''), font=f_head_s, fill='#FFFFFF')
        img.paste(tile, (x0, y0))
        draw.rectangle([x0, y0, x0 + width, y0 + tile_h], outline=mix('#808080', bg, 0.5))
        draw.text((x0 + 10, y0 + tile_h - 22), '%02d' % (i + 1), font=f_head_s, fill='#FFFFFF',
                  stroke_width=2, stroke_fill='#000000')
    img.save(out_path)
    return out_path


def paste_cover(tile, path, box):
    """把图片按 cover 方式裁切贴进 tile 的 box 区域；失败返回 False。"""
    from PIL import Image
    try:
        if not path or not os.path.exists(str(path)):
            return False
        x0, y0, x1, y1 = (int(box[0]), int(box[1]), int(box[2]), int(box[3]))
        bw, bh = max(1, x1 - x0), max(1, y1 - y0)
        with Image.open(str(path)) as raw:
            src = raw.convert('RGB')
        sw, sh = src.size
        if not sw or not sh:
            return False
        factor = max(bw / sw, bh / sh)
        nw, nh = max(1, int(sw * factor + 0.5)), max(1, int(sh * factor + 0.5))
        src = src.resize((nw, nh), Image.LANCZOS)
        left = max(0, (nw - bw) // 2)
        top = max(0, (nh - bh) // 2)
        tile.paste(src.crop((left, top, left + bw, top + bh)), (x0, y0))
        return True
    except Exception:
        return False


def draw_tile(ctx, s, w, h, load, title_font, body_font):
    from PIL import Image, ImageDraw
    layout = resolve_layout(s)
    bg = ctx.bg() if layout != 'cover' else ctx.th.get('bg2', ctx.bg())
    tile = Image.new('RGB', (w, h), bg)
    d = ImageDraw.Draw(tile)
    scale = w / ctx.W  # 每英寸像素

    def U(inches):
        """英寸 → 像素。"""
        return int(inches * scale)

    def P(points):
        """磅 → 像素（1 英寸 = 72 磅）。"""
        return max(1, int(points * scale / 72.0))

    mx = U(ctx.mx)
    f_title = load(title_font, max(11, P(ctx.size('titleSize', 30) * 0.95)))
    f_body = load(body_font, max(9, P(ctx.size('bodySize', 16))))
    f_small = load(body_font, max(8, P(ctx.size('smallSize', 11.5))))
    f_big = load(title_font, max(16, P(ctx.size('coverSize', 44) * 0.95)))

    def rr(box, fill, outline=None):
        x0, y0, x1, y1 = float(box[0]), float(box[1]), float(box[2]), float(box[3])
        if x1 < x0:
            x0, x1 = x1, x0
        if y1 < y0:
            y0, y1 = y1, y0
        if x1 - x0 < 2 or y1 - y0 < 2:
            return
        radius = max(0, min(int(0.08 * scale), int(min(x1 - x0, y1 - y0) / 2) - 1))
        d.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill, outline=outline)

    # 装饰：左上角主色条，右上角圆点群
    d.rectangle([mx, 12, mx + U(0.9), 15], fill=ctx.accent())
    if layout in ('cover', 'end', 'section'):
        cx, cy, rad = int(w * 0.86), int(h * 0.24), int(h * 0.34)
        d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=mix(bg, ctx.primary(), 0.22))
    title = str(s.get('title') or '')
    y = U(0.62)
    max_w = w - 2 * mx
    if layout in ('cover', 'end'):
        d.text((mx, int(h * 0.30)), title, font=f_big, fill=ctx.fg())
        sub = s.get('subtitle') or ctx.deck.get('subtitle')
        if sub:
            d.text((mx, int(h * 0.52)), str(sub)[:52], font=f_body, fill=ctx.dim())
    elif layout == 'section':
        d.text((mx, int(h * 0.30)), title, font=f_big, fill=ctx.fg())
        if s.get('subtitle'):
            d.text((mx, int(h * 0.56)), str(s['subtitle'])[:56], font=f_body, fill=ctx.dim())
    else:
        for line in wrap_text(d, title, f_title, max_w)[:2]:
            d.text((mx, y), line, font=f_title, fill=ctx.fg())
            y += int(f_title.size * 1.24)
        y += P(6)
        d.rectangle([mx, y, mx + U(0.7), y + 2], fill=ctx.primary())
        y += P(12)
        body_bottom = h - U(0.62)
        y = min(y, max(U(0.62), body_bottom - 14))  # 标题占满时不许越过底线
        if layout == 'bullets':
            insight = s.get('insight')
            text_right = mx + max_w
            if insight:
                card_w = int(max_w * 0.36)
                text_right = mx + max_w - card_w - 8
                bx = mx + max_w - card_w
                rr([bx, y, mx + max_w, min(body_bottom, y + int(h * 0.55))], mix(bg, ctx.th.get('surface', '#888888'), 0.6))
                ly = y + 8
                d.text((bx + 8, ly), '要点', font=f_small, fill=ctx.primary())
                ly += int(f_small.size * 1.7)
                for line in wrap_text(d, str(insight), f_small, card_w - 16)[:8]:
                    if ly > min(body_bottom, y + int(h * 0.55)) - f_small.size:
                        break
                    d.text((bx + 8, ly), line, font=f_small, fill=ctx.fg())
                    ly += int(f_small.size * 1.45)
            for item in (s.get('bullets') or [])[:6]:
                text = item if isinstance(item, str) else str((item or {}).get('text', ''))
                for line in wrap_text(d, '• ' + text, f_body, text_right - mx)[:2]:
                    if y > body_bottom - 12:
                        break
                    d.text((mx, y), line, font=f_body, fill=ctx.fg() if y < body_bottom else ctx.dim())
                    y += int(f_body.size * 1.5)
        elif layout == 'agenda':
            entries = (s.get('agenda') or s.get('contents') or s.get('items') or [])[:6]
            n = max(1, len(entries))
            gap = max(3, int((body_bottom - y) * 0.04))
            row_h = max(14, int(((body_bottom - y) - gap * (n - 1)) / n))
            num_w = U(0.72)
            page_w = max(20, U(0.9))
            for i, entry in enumerate(entries):
                if isinstance(entry, str):
                    entry = {'title': entry}
                elif not isinstance(entry, dict):
                    entry = {'title': str(entry)}
                ey = y + i * (row_h + gap)
                color = ctx.primary() if i % 2 == 0 else ctx.accent()
                rr([mx, ey, mx + num_w, ey + row_h], color)
                num_size = max(8, min(f_small.size, int(row_h * 0.62)))
                num_font = load(body_font, num_size)
                d.text((mx + max(1, num_w // 2 - P(6)), ey + row_h // 2 - num_size // 2 - 1),
                       '%02d' % (i + 1), font=num_font, fill=text_on(color))
                tx = mx + num_w + 8
                title_right = mx + max_w - page_w - 4
                title_chars = max(6, int((title_right - tx) / max(f_body.size, 1)))
                d.text((tx, ey + 2), str(entry.get('title') or '')[:title_chars], font=f_body, fill=ctx.fg())
                desc = entry.get('desc') or entry.get('description') or ''
                if desc and row_h > f_body.size * 2:
                    d.text((tx, ey + 2 + int(f_body.size * 1.35)), str(desc)[:28], font=f_small, fill=ctx.dim())
                page = entry.get('page') or entry.get('number') or ''
                if page:
                    d.text((mx + max_w - page_w, ey + row_h // 2 - f_small.size // 2), str(page)[:6],
                           font=f_small, fill=ctx.dim())
        elif layout in ('two-col', 'compare'):
            cols = s.get('columns') or [s.get('left') or {}, s.get('right') or {}]
            n = max(1, min(3, len(cols)))
            cw = (max_w - 10 * (n - 1)) / n
            for i, col in enumerate(cols[:n]):
                bx = mx + int(i * (cw + 10))
                rr([bx, y, bx + int(cw), body_bottom], mix(bg, ctx.th.get('surface', '#888888'), 0.55))
                yy = y + 8
                d.text((bx + 8, yy), str((col or {}).get('title') or '')[:20], font=f_body, fill=ctx.fg())
                yy += int(f_body.size * 1.5)
                for item in ((col or {}).get('bullets') or (col or {}).get('items') or [])[:4]:
                    text = item if isinstance(item, str) else str((item or {}).get('text', ''))
                    d.text((bx + 8, yy), '• ' + text[:24], font=f_small, fill=ctx.dim())
                    yy += int(f_small.size * 1.6)
        elif layout == 'matrix':
            matrix_spec = s.get('matrix') if isinstance(s.get('matrix'), dict) else {}
            quads = (matrix_spec.get('quadrants') or s.get('quadrants') or [])[:4]
            gap = 6
            cw = (max_w - gap) // 2
            ch = max(16, (body_bottom - y - gap) // 2)
            accents = [ctx.primary(), ctx.accent(), mix(ctx.primary(), ctx.accent(), 0.55),
                       mix(ctx.primary(), ctx.bg(), 0.45)]
            d.line([mx + max_w // 2, y, mx + max_w // 2, body_bottom], fill=ctx.th.get('line', ctx.dim()), width=2)
            d.line([mx, y + (body_bottom - y) // 2, mx + max_w, y + (body_bottom - y) // 2],
                   fill=ctx.th.get('line', ctx.dim()), width=2)
            for i in range(4):
                row, col = divmod(i, 2)
                bx = mx + col * (cw + gap)
                by = y + row * (ch + gap)
                rr([bx, by, bx + cw, by + ch], mix(bg, ctx.th.get('surface', '#888888'), 0.6))
                d.rectangle([bx, by, bx + cw, by + 4], fill=accents[i])
                if i >= len(quads):
                    continue
                quad = quads[i] or {}
                d.text((bx + 8, by + 9), str(quad.get('title') or '')[:max(4, int(cw / max(f_small.size, 1)))],
                       font=f_small, fill=ctx.fg())
                yy = by + 9 + int(f_small.size * 1.55)
                for item in (quad.get('items') or quad.get('bullets') or [])[:3]:
                    text = item if isinstance(item, str) else str((item or {}).get('text') or (item or {}).get('title') or '')
                    if not text:
                        continue
                    d.text((bx + 8, yy), '• ' + text[:max(4, int((cw - 16) / max(f_small.size, 1)) - 2)],
                           font=f_small, fill=ctx.dim())
                    yy += int(f_small.size * 1.45)
        elif layout == 'cards':
            cards = (s.get('cards') or [])[:6]
            cols = 2 if len(cards) <= 2 else (3 if len(cards) == 3 else (2 if len(cards) == 4 else 3))
            cw = (max_w - 10 * (cols - 1)) / cols
            ch = min((body_bottom - y - 10) / max(1, (len(cards) + cols - 1) // cols), U(2.35))
            for i, card in enumerate(cards):
                r, c = divmod(i, cols)
                bx = mx + int(c * (cw + 10))
                by = y + int(r * (ch + 10))
                rr([bx, by, bx + int(cw), by + int(ch)], mix(bg, ctx.th.get('surface', '#888888'), 0.6))
                d.rectangle([bx + 10, by + 10, bx + 10 + U(0.3), by + 13],
                            fill=ctx.primary() if i % 2 == 0 else ctx.accent())
                d.text((bx + 10, by + 18), str(card.get('title') or '')[:22], font=f_body, fill=ctx.fg())
                text = str(card.get('body') or card.get('text') or '')
                ly = by + 18 + int(f_body.size * 1.5)
                for line in wrap_text(d, text, f_small, max(20, int(cw) - 20))[:3]:
                    if ly > by + ch - f_small.size:
                        break
                    d.text((bx + 10, ly), line, font=f_small, fill=ctx.dim())
                    ly += int(f_small.size * 1.45)
        elif layout == 'kpi':
            kpis = (s.get('kpi') or s.get('stats') or [])[:4]
            n = max(1, len(kpis))
            cw = (max_w - 10 * (n - 1)) / n
            for i, item in enumerate(kpis):
                bx = mx + int(i * (cw + 10))
                rr([bx, y, bx + int(cw), y + min(int((body_bottom - y) * 0.8), U(2.6))], mix(bg, ctx.th.get('surface', '#888888'), 0.6))
                d.rectangle([bx, y, bx + int(cw), y + 4], fill=ctx.primary() if i % 2 == 0 else ctx.accent())
                d.text((bx + 10, y + 16), str(item.get('value', ''))[:10], font=f_big, fill=ctx.primary())
                d.text((bx + 10, y + 20 + f_big.size), str(item.get('label') or '')[:20], font=f_small, fill=ctx.fg())
        elif layout == 'timeline':
            steps = (s.get('steps') or [])[:5]
            n = max(1, len(steps))
            ry = y + int((body_bottom - y) * 0.45)
            d.line([mx, ry, w - mx, ry], fill=ctx.th.get('line', ctx.dim()), width=2)
            for i, step in enumerate(steps):
                cx = mx + int(i * ((w - 2 * mx) / max(n - 1, 1))) if n > 1 else w // 2
                d.ellipse([cx - 5, ry - 5, cx + 5, ry + 5], fill=ctx.primary())
                tx = max(mx, min(cx - 40, w - mx - 80))
                d.text((tx, ry - 34), str(step.get('title') or '')[:14], font=f_small, fill=ctx.fg())
                d.text((tx, ry + 12), str(step.get('desc') or '')[:18], font=f_small, fill=ctx.dim())
        elif layout == 'process':
            steps = (s.get('steps') or [])[:5]
            n = max(1, len(steps))
            cw = (max_w - 6 * (n - 1)) / n
            for i, step in enumerate(steps):
                bx = mx + int(i * (cw + 6))
                d.rectangle([bx, y, bx + int(cw), y + U(0.34)], fill=ctx.primary() if i % 2 == 0 else mix(ctx.primary(), ctx.accent(), 0.4))
                d.text((bx + 6, y + 6), str(step.get('title') or '')[:14], font=f_small, fill='#FFFFFF')
                ly = y + U(0.58)
                for line in wrap_text(d, str(step.get('desc') or ''), f_small, max(20, int(cw)))[:3]:
                    if ly > body_bottom - f_small.size:
                        break
                    d.text((bx, ly), line, font=f_small, fill=ctx.dim())
                    ly += int(f_small.size * 1.45)
        elif layout == 'chart':
            chart_spec = s.get('chart') or {}
            cats = chart_spec.get('categories') or []
            all_series = chart_spec.get('series') or []
            kind = str(chart_spec.get('type') or 'bar').lower()
            panel_w = int(max_w * 0.62)
            d.rectangle([mx, y, mx + panel_w, body_bottom], fill=mix(bg, ctx.th.get('surface', '#888888'), 0.5))
            pie_colors = [ctx.primary(), ctx.accent(), mix(ctx.primary(), ctx.accent(), 0.5),
                          mix(bg, ctx.primary(), 0.42), mix(bg, ctx.accent(), 0.42), ctx.th.get('primary2', ctx.primary())]
            first_vals = ((all_series[0] if all_series else {}) or {}).get('values') or []
            if kind in ('pie', 'doughnut'):
                diameter = max(24, min(panel_w - 40, body_bottom - y - 34))
                cx0, cy0 = mx + (panel_w - diameter) // 2, y + 8
                box = [cx0, cy0, cx0 + diameter, cy0 + diameter]
                total = sum(abs(float(v)) for v in first_vals if isinstance(v, (int, float))) or 1.0
                start = -90.0
                for i, v in enumerate(first_vals[:6]):
                    extent = 360.0 * abs(float(v)) / total
                    d.pieslice(box, start, start + extent, fill=pie_colors[i % len(pie_colors)])
                    start += extent
                if kind == 'doughnut':
                    inner = int(diameter * 0.52)
                    off = (diameter - inner) // 2
                    d.ellipse([cx0 + off, cy0 + off, cx0 + off + inner, cy0 + off + inner], fill=bg)
            elif kind == 'radar':
                import math
                axes_count = max(3, len(cats) or len(first_vals) or 3)
                cx = mx + panel_w // 2
                cy = y + (body_bottom - y) // 2 + 4
                radius = max(18, min(panel_w // 2 - 26, (body_bottom - y) // 2 - 22))
                for ring in (0.34, 0.67, 1.0):
                    pts = []
                    for k in range(axes_count):
                        angle = -math.pi / 2 + 2 * math.pi * k / axes_count
                        pts.append((cx + math.cos(angle) * radius * ring, cy + math.sin(angle) * radius * ring))
                    d.polygon(pts, outline=mix(bg, ctx.dim(), 0.5))
                for i, one in enumerate(all_series[:2]):
                    vals = [abs(float(v)) for v in ((one or {}).get('values') or []) if isinstance(v, (int, float))]
                    vals = (vals + [0.0] * axes_count)[:axes_count]
                    top_v = max(vals or [0.0]) or 1.0
                    pts = []
                    for k in range(axes_count):
                        angle = -math.pi / 2 + 2 * math.pi * k / axes_count
                        r = radius * max(0.0, min(1.0, vals[k] / top_v))
                        pts.append((cx + math.cos(angle) * r, cy + math.sin(angle) * r))
                    color = ctx.primary() if i == 0 else ctx.accent()
                    d.polygon(pts, outline=color)
                    for px, py in pts:
                        d.ellipse([px - 2, py - 2, px + 2, py + 2], fill=color)
            elif kind in ('scatter', 'xy', 'scatter-xy'):
                point_sets = []
                for one in all_series[:3]:
                    pts = []
                    for point in (one or {}).get('points') or []:
                        try:
                            if isinstance(point, dict):
                                px, py = float(point.get('x')), float(point.get('y'))
                            else:
                                px, py = float(point[0]), float(point[1])
                            pts.append((px, py))
                        except Exception:
                            continue
                    if pts:
                        point_sets.append((one, pts))
                if point_sets:
                    xs = [p[0] for _, pts in point_sets for p in pts]
                    ys = [p[1] for _, pts in point_sets for p in pts]
                    xmin, xmax = min(xs), max(xs)
                    ymin, ymax = min(ys), max(ys)
                    if xmax == xmin:
                        xmax = xmin + 1.0
                    if ymax == ymin:
                        ymax = ymin + 1.0
                    px0, py0 = mx + 18, y + 12
                    px1, py1 = mx + panel_w - 14, body_bottom - 16
                    d.line([px0, py1, px1, py1], fill=ctx.dim())
                    d.line([px0, py0, px0, py1], fill=ctx.dim())
                    for i, (one, pts) in enumerate(point_sets):
                        color = pie_colors[i % len(pie_colors)]
                        for xv, yv in pts:
                            xp = px0 + int((xv - xmin) / (xmax - xmin) * (px1 - px0))
                            yp = py1 - int((yv - ymin) / (ymax - ymin) * (py1 - py0))
                            d.ellipse([xp - 3, yp - 3, xp + 3, yp + 3], fill=color)
                        d.text((px0 + 4, py0 + 2 + i * int(f_small.size * 1.3)),
                               str((one or {}).get('name') or 'S%d' % (i + 1))[:12], font=f_small, fill=color)
                else:
                    d.text((mx + 8, y + 8), '散点', font=f_small, fill=ctx.dim())
            else:
                top_v = max([abs(float(v)) for v in first_vals if isinstance(v, (int, float))] or [1.0])
                bw = max(6, int(panel_w / max(len(first_vals), 1) * 0.5))
                span = max(0, body_bottom - y - 26)
                for i, v in enumerate(first_vals[:8]):
                    bh = max(0, int(span * (abs(float(v)) / top_v if top_v else 0)))
                    bx = mx + 16 + i * int(panel_w / max(len(first_vals), 1))
                    d.rectangle([bx, body_bottom - bh - 14, bx + bw, body_bottom - 14],
                                fill=ctx.primary() if i % 2 == 0 else ctx.accent())
            if kind not in ('radar', 'scatter', 'xy', 'scatter-xy'):
                d.text((mx + 6, body_bottom - 12), ' / '.join(str(c) for c in cats[:6]), font=f_small, fill=ctx.dim())
            if s.get('insight'):
                bx = mx + int(max_w * 0.66)
                rr([bx, y, w - mx, body_bottom], mix(bg, ctx.th.get('surface', '#888888'), 0.6))
                yy = y + 10
                for line in wrap_text(d, str(s['insight']), f_small, w - mx - bx - 16)[:7]:
                    d.text((bx + 8, yy), line, font=f_small, fill=ctx.fg())
                    yy += int(f_small.size * 1.5)
        elif layout == 'table':
            spec = s.get('table') or {}
            head = spec.get('head') or []
            rows = (spec.get('rows') or [])[:5]
            cols = max(1, len(head))
            cw = max_w / cols
            d.rectangle([mx, y, mx + max_w, y + U(0.3)], fill=ctx.primary())
            for i, cell in enumerate(head):
                d.text((mx + 6 + int(i * cw), y + 4), str(cell)[:12], font=f_small, fill='#FFFFFF')
            yy = y + U(0.3)
            for r, row in enumerate(rows):
                if r % 2 == 0:
                    d.rectangle([mx, yy, mx + max_w, yy + U(0.27)],
                                fill=mix(bg, ctx.th.get('surface', '#888888'), 0.5))
                for c, cell in enumerate(row[:cols]):
                    d.text((mx + 6 + int(c * cw), yy + 3), str(cell)[:12], font=f_small, fill=ctx.fg() if c == 0 else ctx.dim())
                yy += U(0.27)
        elif layout == 'image':
            path = s.get('image')
            variant = str(s.get('variant') or 'right')
            if variant == 'full':
                if not paste_cover(tile, path, (0, 0, w, h)):
                    d.rectangle([0, 0, w, h], fill=mix(bg, '#8899AA', 0.5))
                scrim = Image.new('RGB', (w, h), '#000000')
                tile = Image.blend(tile, scrim, 0.42)
                d = ImageDraw.Draw(tile)
                d.text((mx, int(h * 0.52)), title, font=f_big, fill='#FFFFFF')
                if s.get('subtitle'):
                    d.text((mx, int(h * 0.52) + int(f_big.size * 1.3)), str(s['subtitle'])[:44], font=f_body, fill='#EDEDED')
            else:
                bx0 = mx if variant == 'left' else int(w * 0.5)
                tx0 = int(w * 0.5) if variant == 'left' else mx
                if not paste_cover(tile, path, (bx0, y, bx0 + int(w * 0.42), body_bottom)):
                    d.rectangle([bx0, y, bx0 + int(w * 0.42), body_bottom], fill=mix(bg, '#8899AA', 0.5))
                    d.text((bx0 + 10, y + 8), '图片', font=f_small, fill='#FFFFFF')
                yy = y + int(f_body.size * 1.6)
                for line in wrap_text(d, str(s.get('subtitle') or ''), f_body, int(w * 0.44))[:4]:
                    d.text((tx0, yy), line, font=f_body, fill=ctx.dim())
                    yy += int(f_body.size * 1.5)
        elif layout == 'quote':
            d.text((mx, y), '"', font=f_big, fill=mix(bg, ctx.primary(), 0.5))
            yy = y + int(f_big.size * 1.1)
            for line in wrap_text(d, str(s.get('quote') or ''), f_body, max_w)[:4]:
                d.text((mx + 14, yy), line, font=f_body, fill=ctx.fg())
                yy += int(f_body.size * 1.6)
            d.text((mx + 14, yy + 6), str(s.get('author') or ''), font=f_small, fill=ctx.dim())
    d.text((w - mx - 40, h - 18), 'PPT', font=f_small, fill=mix(bg, ctx.th.get('text', '#888888'), 0.6))
    return tile


def resolve_layout(slide):
    raw = str((slide or {}).get('layout') or 'bullets').strip().lower()
    if raw in LAYOUTS:
        return raw
    if raw in ALIASES:
        return ALIASES[raw]
    # 猜测：有 kpi 字段就是 kpi，有 chart 就是 chart……
    for key, target in (('kpi', 'kpi'), ('chart', 'chart'), ('table', 'table'), ('steps', 'process'),
                        ('cards', 'cards'), ('quote', 'quote'), ('image', 'image'),
                        ('agenda', 'agenda'), ('matrix', 'matrix'), ('quadrants', 'matrix')):
        if key in ('agenda', 'matrix', 'quadrants'):
            # 新版式：字段存在即认版式（数组为空也照认，交给 lint 报缺字段，不要静默降级）
            if key in slide:
                return target
        elif slide.get(key):
            return target
    return 'bullets'


# ────────────────────────────────────────────────────────────── 主流程 ──

def build(spec):
    from pptx import Presentation
    from pptx.util import Inches
    state = {'warnings': []}
    template = spec.get('template') or {}
    deck = spec.get('deck') or {}
    slides_spec = [s for s in (deck.get('slides') or []) if isinstance(s, dict)]
    if not slides_spec:
        raise ValueError('deck.slides 为空：至少需要一页')
    prs = Presentation()
    prs.slide_width = Inches(DEFAULT_W if template.get('aspect') != '4:3' else 10.0)
    prs.slide_height = Inches(DEFAULT_H)
    ctx = Ctx(prs, template, deck, state)
    total = len(slides_spec)
    used = []
    for index, s in enumerate(slides_spec, start=1):
        layout = resolve_layout(s)
        used.append(layout)
        slide = ctx.new_slide()
        fn = LAYOUTS.get(layout) or LAYOUTS['bullets']
        try:
            fn(ctx, slide, s)
        except Exception as exc:
            warn(state, '第 %d 页(%s)渲染异常，已降级为要点页：%s' % (index, layout, exc))
            try:
                layout_bullets(ctx, slide, s)
            except Exception:
                pass
        if layout not in ('cover', 'end', 'image'):
            slide_chrome(ctx, slide, index, total)
        notes(ctx, slide, s.get('notes'))
    out_path = spec.get('out')
    if not out_path:
        raise ValueError('缺少 out 路径')
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    prs.save(out_path)
    result = {'ok': True, 'pptx': out_path, 'slides': total, 'layouts': used, 'warnings': state['warnings']}
    # 结构自检：zip 完整性 + 用 python-pptx 重新打开一遍。
    # 自己写的 XML（bullet / alpha / 渐变）若有结构错误，会在这里暴露成 warnings，
    # 而不是等用户在 PowerPoint 里打不开才发现。
    try:
        import zipfile
        with zipfile.ZipFile(out_path) as archive:
            broken = archive.testzip()
        if broken:
            state['warnings'].append('文件内 %s 校验失败，可能已损坏' % broken)
        reopened = Presentation(out_path)
        shape_total = sum(len(sl.shapes) for sl in reopened.slides)
        result['verified'] = {'slides': len(reopened.slides), 'shapes': shape_total}
        if len(reopened.slides) != total:
            state['warnings'].append('自检页数不符：写入 %d 页，读回 %d 页' % (total, len(reopened.slides)))
    except Exception as exc:
        state['warnings'].append('生成的文件重新打开失败（结构可能损坏）：%s' % exc)
    preview = spec.get('preview')
    if preview:
        try:
            render_preview(ctx, state, slides_spec, preview,
                           grid=int(spec.get('previewGrid') or 3), width=int(spec.get('previewWidth') or 620))
            result['preview'] = preview
        except Exception as exc:
            state['warnings'].append('预览图生成失败（不影响 PPTX）：%s' % exc)
    result['bytes'] = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    try:
        import pptx as _pptx
        result['pythonPptx'] = getattr(_pptx, '__version__', 'unknown')
    except Exception:
        pass
    return result


def probe():
    info = {'ok': True, 'python': sys.version.split()[0], 'executable': sys.executable}
    try:
        import pptx
        info['pythonPptx'] = getattr(pptx, '__version__', 'unknown')
    except Exception as exc:
        info['ok'] = False
        info['pythonPptx'] = None
        info['error'] = 'python-pptx 不可用：%s' % exc
    try:
        import PIL
        info['pillow'] = getattr(PIL, '__version__', 'unknown')
    except Exception as exc:
        info['pillow'] = None
        info['pillowError'] = str(exc)
    found = {}
    for label, names in (('title', ['Microsoft YaHei', '微软雅黑', 'SimHei', 'Arial']),
                         ('latin', ['Segoe UI', 'Arial'])):
        path = find_font(names)
        found[label] = path or None
    info['fonts'] = found
    return info


def _repo_root():
    """插件所在仓库根：<root>/plugins/dsh-ppt-master/lib/python/ppt_build.py。"""
    here = os.path.dirname(os.path.abspath(__file__))
    plugin_root = os.path.dirname(os.path.dirname(here))
    parent = os.path.dirname(plugin_root)
    if os.path.basename(parent).lower() == 'plugins':
        return os.path.dirname(parent)
    return parent


def _search_roots():
    """可能藏着 Node 运行时与插件模块的根目录（去重、只保留存在的目录）。"""
    roots = []
    for candidate in (os.environ.get('DSH_HOME'), os.environ.get('DSH_CONFIG_HOME'), _repo_root(), os.getcwd()):
        if not candidate:
            continue
        try:
            norm = os.path.abspath(os.path.expanduser(str(candidate)))
        except Exception:
            continue
        if os.path.isdir(norm) and norm not in roots:
            roots.append(norm)
    return roots


def find_node():
    """定位可用的 Node 解释器：显式环境变量 → DSH 运行时目录 → PATH。"""
    import shutil
    explicit = (os.environ.get('DSH_PPT_NODE') or os.environ.get('DSH_NODE')
                or os.environ.get('DSH_NODE_EXE') or '')
    candidates = [explicit] if explicit else []
    for root in _search_roots():
        candidates.extend([
            os.path.join(root, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
            os.path.join(root, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node'),
            os.path.join(root, 'home', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
            os.path.join(root, 'home', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node'),
            os.path.join(root, 'dependencies', 'node', 'bin', 'node.exe'),
            os.path.join(root, 'dependencies', 'node', 'bin', 'node'),
        ])
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    for name in ('node', 'node.exe'):
        found = shutil.which(name)
        if found:
            return found
    return None


def js_check_paths():
    """哨兵文件 / 结果文件位置：env 覆盖 → DSH_HOME / 仓库根 → 系统临时目录。"""
    base = os.environ.get('DSH_PPT_JSCHECK_DIR')
    if not base:
        for candidate in (os.environ.get('DSH_HOME'), _repo_root()):
            if not candidate:
                continue
            try:
                norm = os.path.abspath(os.path.expanduser(str(candidate)))
            except Exception:
                continue
            if os.path.isdir(norm):
                base = norm
                break
    if not base:
        import tempfile
        base = tempfile.gettempdir()
    base = os.path.abspath(os.path.expanduser(str(base)))
    return (os.path.join(base, '.ppt-master-jscheck'), os.path.join(base, '.ppt-master-jscheck.json'))


def _module_targets():
    """待自检模块：源码 lib 下的 .js；已安装副本存在时一并测，不存在就跳过。"""
    lib_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    targets = []
    for name in ('index.js', 'preset.js', 'tools.js', 'engine.js', 'deck.js', 'templates.js', 'master.js'):
        path = os.path.join(lib_dir, name)
        if os.path.isfile(path):
            targets.append(('source/' + name, path))
    known = [path for _label, path in targets]
    for root in _search_roots():
        installed = os.path.join(root, 'profiles', 'desktop', 'node_modules', 'dsh-ppt-master', 'lib')
        if not os.path.isdir(installed):
            continue
        for name in ('index.js', 'preset.js'):
            path = os.path.join(installed, name)
            if os.path.isfile(path) and path not in known:
                targets.append(('installed/' + name, path))
        break
    return targets


def _write_js_report(report):
    try:
        _flag, out_path = js_check_paths()
        with open(out_path, 'w', encoding='utf-8') as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
    except Exception:
        pass

# 冒烟脚本：在没有宿主的情况下把纯函数与联网取材跑一遍（用假 web 服务注入，
# 因此不依赖真实网络与密钥）。改 JS 后靠它验证「行为」而不只是「能不能 import」。
JS_SMOKE = r'''
(async () => {
  const engine = await import('__ENGINE__');
  const deck = await import('__DECK__');
  const out = {};
  out.templates = engine.listTemplates().map(t => t.id);
  const norm = deck.normalizeDeck({ title: 'tsmoke', slides: [
    { layout: 'bullets', title: '一页一个观点', bullets: ['要点一', { text: '要点二', level: 1 }] },
  ] });
  out.normalizedSlides = norm.deck.slides.length;
  out.lintScore = deck.lintDeck(norm.deck).score;
  out.slug = engine.slugify('2026 增长/战略 报告');
  out.homeHasTemplateDir = Boolean(engine.storeDir());
  out.noCtx = await engine.research(undefined, { query: 'x' });
  const fakeWeb = {
    search: async () => { throw new Error('DeepSeek search has no API key for "DEEPSEEK_API_KEY"'); },
    fetch: async () => ({ body: { kind: 'html', content: '<title>示例页</title><meta property="og:image" content="https://img/x.jpg"><body>正文内容</body>' } }),
  };
  const ctx = { get: (n) => (n === 'web' ? fakeWeb : undefined) };
  const byUrls = await engine.research(ctx, { urls: ['https://example.com'], kind: 'images' });
  out.researchUrls = { ok: byUrls.ok, sources: byUrls.sources.length, images: byUrls.images.length, firstTitle: byUrls.sources[0] && byUrls.sources[0].title };
  const byQuery = await engine.research(ctx, { query: '渗透率', kind: 'facts' });
  out.researchQuery = { ok: byQuery.ok, notes: byQuery.notes.length, mentionsKey: byQuery.notes.some(n => n.indexOf('密钥') >= 0) };
  out.palette = engine.research ? 'ok' : 'missing';
  console.log(JSON.stringify({ ok: true, smoke: out }));
})().catch(e => console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e), stack: String((e && e.stack) || '').split('\n').slice(0, 4) })));
'''


def _file_url(path):
    from pathlib import Path
    return Path(path).as_uri()


def js_check_enabled():
    """哨兵文件存在且内容不以 off 开头时启用 JS 自检。"""
    try:
        flag_path, _out_path = js_check_paths()
        if not os.path.exists(flag_path):
            return False
        with open(flag_path, 'r', encoding='utf-8', errors='replace') as handle:
            return not handle.read().strip().lower().startswith('off')
    except Exception:
        return False


def js_selfcheck():
    """可选自检：用 Node 逐个 import 插件模块，验证语法与导出。

    存在的理由：宿主插件的模块在进程内被 ESM 缓存，改代码不会热重载，
    肉眼也看不出「加载不起来」的原因。这里让 Python 反调 Node 做一次真实
    import —— 语法错误、导入路径错误、shim 转发失败都会在这里现形。
    仅在哨兵文件存在时运行（默认不打扰正常渲染）。路径全部由 env / __file__ /
    PATH 推导；找不到 Node 或模块时跳过自检并记 warning，绝不因自检把渲染搞崩。
    """
    import subprocess
    report = {'node': None, 'results': []}
    node = find_node()
    report['node'] = node
    if not node:
        report['warning'] = '未找到 Node 解释器，已跳过 JS 自检（不影响 PPTX 渲染）'
        _write_js_report(report)
        return report
    targets = _module_targets()
    if not targets:
        report['warning'] = '未找到插件 JS 模块，已跳过 JS 自检（目录：%s）' % os.path.dirname(os.path.abspath(__file__))
        _write_js_report(report)
        return report
    code = (
        "const url = require('node:url').pathToFileURL(process.argv[1]).href;"
        "import(url).then(m => {"
        "  const keys = Object.keys(m).sort();"
        "  console.log(JSON.stringify({ ok: true, keys }));"
        "}).catch(e => {"
        "  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e),"
        "    stack: String((e && e.stack) || '').split('\\n').slice(0, 4) }));"
        "});"
    )
    for label, path in targets:
        entry = {'target': label, 'path': path, 'exists': os.path.exists(path)}
        if not entry['exists']:
            entry['ok'] = False
            entry['error'] = '文件不存在'
            report['results'].append(entry)
            continue
        try:
            proc = subprocess.run([node, '-e', code, path], capture_output=True, text=True, timeout=90,
                                  encoding='utf-8', errors='replace')
            out = (proc.stdout or '').strip().splitlines()
            payload = None
            for line in reversed(out):
                line = line.strip()
                if line.startswith('{'):
                    try:
                        payload = json.loads(line)
                        break
                    except Exception:
                        continue
            if payload is None:
                entry['ok'] = False
                entry['error'] = (proc.stderr or proc.stdout or '无输出').strip()[-400:]
            else:
                entry.update(payload)
        except Exception as exc:
            entry['ok'] = False
            entry['error'] = 'spawn 失败：%s' % exc
        report['results'].append(entry)
    # 冒烟：行为级验证（假 web 注入，不需要真实网络）
    source_paths = dict(targets)
    engine_path = source_paths.get('source/engine.js')
    deck_path = source_paths.get('source/deck.js')
    if engine_path and deck_path:
        try:
            smoke_code = (JS_SMOKE
                          .replace('__ENGINE__', _file_url(engine_path))
                          .replace('__DECK__', _file_url(deck_path)))
            proc = subprocess.run([node, '-e', smoke_code], capture_output=True, text=True, timeout=120,
                                  encoding='utf-8', errors='replace')
            payload = None
            for line in reversed((proc.stdout or '').strip().splitlines()):
                line = line.strip()
                if line.startswith('{'):
                    try:
                        payload = json.loads(line)
                        break
                    except Exception:
                        continue
            entry = {'target': 'smoke(behavior)', 'ok': bool(payload and payload.get('ok'))}
            if payload:
                entry.update(payload)
            else:
                entry['error'] = (proc.stderr or proc.stdout or '无输出').strip()[-500:]
            report['results'].append(entry)
        except Exception as exc:
            report['results'].append({'target': 'smoke(behavior)', 'ok': False, 'error': 'spawn 失败：%s' % exc})
    else:
        report['results'].append({'target': 'smoke(behavior)', 'ok': False,
                                  'error': '缺少 source/engine.js 或 source/deck.js，已跳过行为冒烟'})
    _write_js_report(report)
    return report


# ── 自测样张（--selftest）─────────────────────────────────────────────
# 一张 3 页的迷你 deck + 一套内置配色的最小模板：不依赖 JS 侧数据，
# 用来验证「Python + python-pptx + 字体」链路本身是否可用。
SELFTEST_TEMPLATE = {
    'aspect': '16:9',
    'theme': {
        'mode': 'dark', 'bg': '#0B1020', 'bg2': '#151D3A', 'surface': '#1B2544', 'surfaceAlt': '#25315C',
        'primary': '#5B7CFA', 'primary2': '#8AA0FF', 'accent': '#FFC53D',
        'text': '#F4F7FF', 'textDim': '#A9B4D6', 'line': '#2C3760',
    },
    'fonts': {
        'title': {'latin': 'Segoe UI Semibold', 'ea': 'Microsoft YaHei'},
        'body': {'latin': 'Segoe UI', 'ea': 'Microsoft YaHei'},
        'mono': {'latin': 'Consolas', 'ea': 'Microsoft YaHei'},
    },
    'geometry': {
        'marginX': 0.86, 'marginY': 0.58, 'coverSize': 44, 'sectionSize': 38, 'titleSize': 30,
        'bodySize': 16, 'smallSize': 11.5, 'kickerSize': 12, 'radius': 0.1, 'gap': 0.26,
        'lineSpacing': 1.32,
    },
    'decor': {'style': 'glow', 'accentBar': True, 'coverPattern': 'orbs'},
}

SELFTEST_DECK = {
    'title': 'PPT 大师 · 自测样张',
    'subtitle': 'python ppt_build.py --selftest <dir>',
    'slides': [
        {'layout': 'cover', 'kicker': '自检', 'title': '渲染链路已经打通',
         'subtitle': '这张 deck 由渲染器内置样张生成，用于验证 Python 环境',
         'notes': '自测样张：如果这一页正常，说明 python-pptx 可以创建幻灯片。'},
        {'layout': 'kpi', 'title': '三个数字验证版式确实被渲染',
         'kpi': [
             {'value': '3', 'unit': '页', 'label': '样张页数'},
             {'value': '16', 'unit': 'pt', 'label': '正文基准字号'},
             {'value': '0', 'unit': '个', 'label': '外部模板依赖'},
         ],
         'notes': '自测样张：KPI 卡片依赖形状、文本框与颜色，全部由渲染器手写。'},
        {'layout': 'bullets', 'title': '再看一眼中文与数字混排',
         'bullets': ['中文汉字与英文 Latin 同时写入字体项', '数字 0123456789 正常显示', '如果三页都正常，渲染链可用'],
         'insight': '自检只验证渲染链，不替代设计审校。',
         'notes': '自测样张：中英文混排与换行逻辑的快速检查。'},
    ],
}


def selftest_spec(out_dir):
    """构造 --selftest 的 spec：3 页样张，输出到 out_dir。"""
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.join(out_dir, 'selftest')
    return {
        'template': SELFTEST_TEMPLATE,
        'deck': SELFTEST_DECK,
        'out': stem + '.pptx',
        'preview': stem + '.preview.png',
        'previewGrid': 3,
        'previewWidth': 620,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description='PPT 大师渲染器')
    parser.add_argument('spec', nargs='?', help='spec.json 路径')
    parser.add_argument('--probe', action='store_true', help='仅输出环境体检信息')
    parser.add_argument('--selftest', metavar='DIR', help='在 DIR 生成一份 3 页自测样张（PPTX + 预览图）')
    args = parser.parse_args(argv)
    js_report = None
    if js_check_enabled():
        try:
            js_report = js_selfcheck()
        except Exception:
            js_report = {'error': traceback.format_exc()[-600:]}
    try:
        if args.probe:
            payload = probe()
        elif args.selftest:
            payload = build(selftest_spec(args.selftest))
        else:
            if not args.spec:
                raise ValueError('缺少 spec 路径（或用 --probe / --selftest DIR）')
            with open(args.spec, 'r', encoding='utf-8') as handle:
                spec = json.load(handle)
            payload = build(spec)
    except Exception as exc:
        payload = {'ok': False, 'error': str(exc), 'trace': traceback.format_exc()[-4000:]}
    if js_report is not None:
        payload['jsCheck'] = {
            'node': js_report.get('node'),
            'summary': ['%s:%s' % (r.get('target'), 'ok' if r.get('ok') else (r.get('error') or '?')[:80])
                        for r in js_report.get('results', [])],
        }
    sys.stdout.write((json.dumps(payload, ensure_ascii=False) + '\n'))
    sys.stdout.write(SENTINEL + json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()
    return 0 if payload.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
