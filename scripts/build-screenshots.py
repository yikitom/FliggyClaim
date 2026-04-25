#!/usr/bin/env python3
"""Render Chrome Web Store screenshots (1280x800) for FliggyClaim."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "store-assets"
OUT.mkdir(exist_ok=True)

FONT_PATH = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"

W, H = 1280, 800
POPUP_W, POPUP_H = 420, 600

# Apple HIG-ish palette
BG = (245, 245, 247)
BG_ELEV = (255, 255, 255)
LABEL = (29, 29, 31)
LABEL_2 = (110, 110, 115)
LABEL_3 = (160, 160, 165)
SEPARATOR = (60, 60, 67, 30)
ACCENT = (10, 132, 255)
RED = (215, 30, 30)
RED_TOP = (255, 80, 70)
GREEN = (48, 209, 88)
ORANGE = (255, 149, 0)


def font(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, size)


def rounded_rect(img: Image.Image, box, radius, fill=None, outline=None, width=1):
    ImageDraw.Draw(img).rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def shadow(size, radius, color=(0, 0, 0, 35), blur=24):
    s = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(s).rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=color)
    return s.filter(ImageFilter.GaussianBlur(blur))


def gradient(size, top, bottom):
    img = Image.new("RGB", size, top)
    d = ImageDraw.Draw(img)
    for y in range(size[1]):
        t = y / max(size[1] - 1, 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (size[0], y)], fill=c)
    return img


# ----------- Popup renderer -----------

def render_popup(state: str = "empty", drag: bool = False) -> Image.Image:
    """Return a (POPUP_W, POPUP_H) RGBA popup mockup."""
    p = Image.new("RGBA", (POPUP_W, POPUP_H), BG + (255,))
    d = ImageDraw.Draw(p)

    # Title bar
    d.rectangle((0, 0, POPUP_W, 44), fill=BG_ELEV)
    d.line((0, 44, POPUP_W, 44), fill=(60, 60, 67, 25))

    # Brand mark (red rounded square with 报)
    mx, my = 14, 13
    grad = gradient((18, 18), RED_TOP, RED)
    mask = Image.new("L", (18, 18), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 18, 18), radius=5, fill=255)
    p.paste(grad, (mx, my), mask)
    f_brand_glyph = font(11)
    d.text((mx + 9, my + 9), "报", fill="white", font=f_brand_glyph, anchor="mm")

    # Brand name
    d.text((mx + 26, 22), "FliggyClaim", fill=LABEL, font=font(14), anchor="lm")

    # Settings gear
    d.text((POPUP_W - 22, 22), "⚙", fill=LABEL_2, font=font(14), anchor="mm")

    # Segmented control
    seg_y = 52
    seg_h = 28
    seg_pad = 14
    seg_gap = 4
    seg_w = (POPUP_W - 2 * seg_pad - seg_gap) // 2
    upload_active = state in ("empty", "drag", "files", "parsing")
    parsed_active = not upload_active

    # left
    rounded_rect(p, (seg_pad, seg_y, seg_pad + seg_w, seg_y + seg_h), 8,
                 fill=BG_ELEV if upload_active else (120, 120, 128, 35))
    if upload_active:
        # subtle shadow under active segment
        sh = shadow((seg_w, seg_h), 8, (0, 0, 0, 18), 6)
        p.alpha_composite(sh, (seg_pad, seg_y + 1))
        rounded_rect(p, (seg_pad, seg_y, seg_pad + seg_w, seg_y + seg_h), 8, fill=BG_ELEV)
    d.text((seg_pad + seg_w / 2, seg_y + seg_h / 2), "上传凭证",
           fill=LABEL if upload_active else LABEL_2, font=font(12), anchor="mm")
    # right
    rx = seg_pad + seg_w + seg_gap
    rounded_rect(p, (rx, seg_y, rx + seg_w, seg_y + seg_h), 8,
                 fill=BG_ELEV if parsed_active else (120, 120, 128, 35))
    if parsed_active:
        sh = shadow((seg_w, seg_h), 8, (0, 0, 0, 18), 6)
        p.alpha_composite(sh, (rx, seg_y + 1))
        rounded_rect(p, (rx, seg_y, rx + seg_w, seg_y + seg_h), 8, fill=BG_ELEV)
    label_text = "费用明细"
    text_x = rx + seg_w / 2
    if parsed_active:
        text_x -= 8
    d.text((text_x, seg_y + seg_h / 2), label_text,
           fill=LABEL if parsed_active else LABEL_2, font=font(12), anchor="mm")
    if parsed_active:
        # badge
        bx = text_x + 33
        by = seg_y + seg_h / 2
        d.ellipse((bx - 9, by - 8, bx + 9, by + 8), fill=ACCENT)
        d.text((bx, by), "5", fill="white", font=font(10), anchor="mm")

    # Body
    body_y = 90
    footer_h = 64
    body_h = POPUP_H - body_y - footer_h

    if upload_active:
        draw_upload_panel(p, body_y, body_h, state, drag)
    else:
        draw_parsed_panel(p, body_y, body_h, state)

    # Footer
    fy = POPUP_H - footer_h
    d.rectangle((0, fy, POPUP_W, POPUP_H), fill=BG_ELEV)
    d.line((0, fy, POPUP_W, fy), fill=(60, 60, 67, 25))

    if state == "parsing":
        # progress
        bar_x, bar_y, bar_w, bar_h = 14, fy + 12, POPUP_W - 80, 6
        rounded_rect(p, (bar_x, bar_y, bar_x + bar_w, bar_y + bar_h), 3, fill=(120, 120, 128, 50))
        rounded_rect(p, (bar_x, bar_y, bar_x + int(bar_w * 0.7), bar_y + bar_h), 3, fill=ACCENT)
        d.text((bar_x + bar_w + 6, bar_y + 3), "5 / 7", fill=LABEL_2, font=font(11), anchor="lm")
        # disabled button
        bx0 = 14
        bx1 = POPUP_W - 14
        by0 = fy + 24
        by1 = by0 + 36
        rounded_rect(p, (bx0, by0, bx1, by1), 10, fill=(10, 132, 255, 110))
        d.text(((bx0 + bx1) / 2, (by0 + by1) / 2), "解析中…", fill="white", font=font(13), anchor="mm")
    else:
        # button
        bx0 = 14
        bx1 = POPUP_W - 14
        by0 = fy + 14
        by1 = by0 + 36
        if upload_active:
            label = "确定解析"
            disabled = state == "empty"
        else:
            label = "确定导入到报销系统"
            disabled = False
        color = (10, 132, 255, 110) if disabled else ACCENT + (255,)
        rounded_rect(p, (bx0, by0, bx1, by1), 10, fill=color)
        d.text(((bx0 + bx1) / 2, (by0 + by1) / 2), label, fill="white", font=font(13), anchor="mm")
        if not upload_active:
            # totals
            d.text((POPUP_W / 2, fy + 6), "5 条记录  ·  合计 4,820.50 CNY",
                   fill=LABEL_2, font=font(11), anchor="mm")

    return p


def draw_upload_panel(p: Image.Image, y: int, h: int, state: str, drag: bool):
    d = ImageDraw.Draw(p)
    pad = 14
    gap = 10

    drop_w = int((POPUP_W - 2 * pad - gap) * (2 / 3))
    sum_w = POPUP_W - 2 * pad - gap - drop_w
    drop_box = (pad, y + 4, pad + drop_w, y + h - 6)
    sum_box = (pad + drop_w + gap, y + 4, POPUP_W - pad, y + h - 6)

    # Dropzone
    border = ACCENT if drag else (200, 200, 205)
    fill = (230, 244, 255) if drag else (255, 255, 255, 200)
    rounded_rect(p, drop_box, 16, fill=fill, outline=border, width=2)

    # icon (cloud-up-arrow simplified)
    cx = (drop_box[0] + drop_box[2]) / 2
    cy = drop_box[1] + (drop_box[3] - drop_box[1]) * 0.32
    d.line([(cx, cy + 22), (cx, cy - 8)], fill=ACCENT, width=3)
    d.polygon([(cx - 12, cy + 4), (cx, cy - 8), (cx + 12, cy + 4)], fill=ACCENT)
    d.line([(cx - 18, cy + 28), (cx + 18, cy + 28)], fill=ACCENT, width=3)

    # text
    title_y = cy + 46
    d.text((cx, title_y), "拖拽文件到这里上传" if not drag else "松手即可上传",
           fill=LABEL, font=font(15), anchor="mm")
    d.text((cx, title_y + 22), "支持 PDF、PNG、JPG、HEIC 等",
           fill=LABEL_3, font=font(11), anchor="mm")
    # browse button
    bw = 88
    bh = 28
    bx0 = cx - bw / 2
    by0 = title_y + 46
    rounded_rect(p, (bx0, by0, bx0 + bw, by0 + bh), 8, fill=(120, 120, 128, 30))
    d.text((cx, by0 + bh / 2), "选择文件", fill=LABEL, font=font(12), anchor="mm")

    # Summary panel
    rounded_rect(p, sum_box, 16, fill=BG_ELEV, outline=(60, 60, 67, 25), width=1)
    sx0, sy0, sx1, sy1 = sum_box
    d.text((sx0 + 12, sy0 + 14), "已添加", fill=LABEL_2, font=font(10), anchor="lm")
    if state in ("files", "drag", "parsing"):
        d.text((sx1 - 12, sy0 + 14), "清空", fill=ACCENT, font=font(11), anchor="rm")
    d.line((sx0 + 8, sy0 + 28, sx1 - 8, sy0 + 28), fill=(60, 60, 67, 25))

    items = []
    if state in ("files", "drag", "parsing"):
        items = [
            ("PDF", "国航行程单_PEK_PVG.pdf", "284 KB", RED),
            ("JPG", "酒店发票_全季杭州.jpg", "1.2 MB", (48, 158, 74)),
            ("JPG", "餐饮_西餐厅.jpg", "892 KB", (48, 158, 74)),
            ("PDF", "出租车票_2026-04-23.pdf", "44 KB", RED),
            ("HEIC", "晚餐_海底捞.heic", "1.4 MB", (48, 158, 74)),
            ("PDF", "酒店发票_万豪上海.pdf", "312 KB", RED),
            ("JPG", "打车_滴滴.jpg", "654 KB", (48, 158, 74)),
        ]
    yy = sy0 + 36
    for ext, name, size, c in items:
        if yy + 30 > sy1 - 60:
            break
        # ext badge
        rounded_rect(p, (sx0 + 8, yy, sx0 + 8 + 26, yy + 22), 5, fill=c + (40,))
        d.text((sx0 + 8 + 13, yy + 11), ext.lower()[:3], fill=c, font=font(8), anchor="mm")
        # name (truncate)
        max_chars = 11
        nm = name if len(name) <= max_chars else name[:max_chars] + "…"
        d.text((sx0 + 40, yy + 6), nm, fill=LABEL, font=font(11), anchor="lm")
        d.text((sx0 + 40, yy + 18), size, fill=LABEL_3, font=font(9.5), anchor="lm")
        yy += 28

    # stats footer
    line_y = sy1 - 50
    d.line((sx0 + 8, line_y, sx1 - 8, line_y), fill=(60, 60, 67, 25))
    half = (sx0 + sx1) / 2
    n = str(len(items))
    sz = "4.8 MB" if items else "0 KB"
    d.text(((sx0 + half) / 2, line_y + 14), n, fill=LABEL, font=font(15), anchor="mm")
    d.text(((sx0 + half) / 2, line_y + 32), "个文件", fill=LABEL_3, font=font(10), anchor="mm")
    d.line((half, line_y + 8, half, sy1 - 8), fill=(60, 60, 67, 25))
    d.text(((half + sx1) / 2, line_y + 14), sz, fill=LABEL, font=font(15), anchor="mm")
    d.text(((half + sx1) / 2, line_y + 32), "总大小", fill=LABEL_3, font=font(10), anchor="mm")


def draw_parsed_panel(p: Image.Image, y: int, h: int, state: str):
    d = ImageDraw.Draw(p)
    pad = 14
    yy = y + 6

    records = [
        ("机票", "flight", "2026-04-22", "CNY", "1,820.00", "PEK-PVG 国航 CA1859"),
        ("酒店", "hotel", "2026-04-22", "CNY", "1,360.00", "全季酒店 杭州西湖店"),
        ("餐饮", "meal", "2026-04-23", "CNY", "286.50", "工作餐 西餐厅"),
        ("打车", "taxi", "2026-04-23", "CNY", "78.00", "杭州市内打车"),
        ("酒店", "hotel", "2026-04-24", "CNY", "1,276.00", "万豪酒店 上海虹桥"),
    ]

    type_color = {
        "flight": (255, 149, 0),
        "hotel": (88, 86, 214),
        "meal": (255, 59, 48),
        "taxi": (48, 209, 88),
        "other": (142, 142, 147),
    }

    for label, code, date, cur, amt, note in records:
        card_h = 60
        if yy + card_h > y + h - 4:
            break
        cb = (pad, yy, POPUP_W - pad, yy + card_h)
        # subtle shadow
        sh = shadow((cb[2] - cb[0], card_h), 12, (0, 0, 0, 18), 8)
        p.alpha_composite(sh, (cb[0], cb[1] + 2))
        rounded_rect(p, cb, 12, fill=BG_ELEV, outline=(60, 60, 67, 25), width=1)

        col_x = cb[0] + 10
        # type pill
        c = type_color[code]
        pw = 50
        rounded_rect(p, (col_x, cb[1] + 8, col_x + pw, cb[1] + 8 + 22), 6, fill=c + (40,))
        d.text((col_x + pw / 2, cb[1] + 8 + 11), label, fill=c, font=font(11), anchor="mm")

        # date
        dx = col_x + pw + 8
        rounded_rect(p, (dx, cb[1] + 8, dx + 86, cb[1] + 8 + 22), 6, fill=(120, 120, 128, 25))
        d.text((dx + 6, cb[1] + 8 + 11), date, fill=LABEL, font=font(11), anchor="lm")

        # currency
        cx_ = dx + 92
        rounded_rect(p, (cx_, cb[1] + 8, cx_ + 50, cb[1] + 8 + 22), 6, fill=(120, 120, 128, 25))
        d.text((cx_ + 25, cb[1] + 8 + 11), cur, fill=LABEL, font=font(11), anchor="mm")

        # amount
        ax = cx_ + 58
        rounded_rect(p, (ax, cb[1] + 8, cb[2] - 10, cb[1] + 8 + 22), 6, fill=(120, 120, 128, 25))
        d.text((cb[2] - 14, cb[1] + 8 + 11), amt, fill=LABEL, font=font(11), anchor="rm")

        # note
        rounded_rect(p, (col_x, cb[1] + 34, cb[2] - 50, cb[1] + 34 + 20), 6, fill=(120, 120, 128, 25))
        d.text((col_x + 8, cb[1] + 34 + 10), note, fill=LABEL, font=font(11), anchor="lm")
        d.text((cb[2] - 18, cb[1] + 34 + 10), "×", fill=LABEL_3, font=font(13), anchor="mm")

        yy += card_h + 6


# ----------- Composite scenes -----------

def make_scene(headline, subhead, popup_state="empty", popup_drag=False, with_overlay=False, accent_color=(255, 80, 70)):
    canvas = gradient((W, H), (250, 250, 252), (235, 238, 245))
    d = ImageDraw.Draw(canvas)

    # subtle decorative blob
    blob = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(blob)
    bd.ellipse((-200, 380, 600, 1180), fill=accent_color + (35,))
    bd.ellipse((900, -200, 1480, 380), fill=(10, 132, 255, 25))
    blob = blob.filter(ImageFilter.GaussianBlur(60))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), blob).convert("RGB")
    d = ImageDraw.Draw(canvas)

    # Headline left side
    pad_l = 90
    d.text((pad_l, 240), headline, fill=LABEL, font=font(56), anchor="lm")
    # subhead, possibly multi-line
    yy = 320
    for line in subhead.split("\n"):
        d.text((pad_l, yy), line, fill=LABEL_2, font=font(22), anchor="lm")
        yy += 36

    # bullets
    bullets_y = yy + 28
    bullets = ["拖拽 PDF / 图片，自动汇总", "AI 识别票据 → 类型 / 日期 / 金额 / 备注",
               "一键写入飞猪报销系统并保存"]
    for i, b in enumerate(bullets):
        bx = pad_l
        by = bullets_y + i * 38
        # dot
        d.ellipse((bx, by - 5, bx + 10, by + 5), fill=accent_color)
        d.text((bx + 22, by), b, fill=LABEL, font=font(18), anchor="lm")

    # Popup on the right
    popup = render_popup(popup_state, drag=popup_drag)

    # Drop shadow
    sh = shadow(popup.size, 24, (0, 0, 0, 70), 30)
    px = W - POPUP_W - 110
    py = (H - POPUP_H) // 2
    canvas_rgba = canvas.convert("RGBA")
    canvas_rgba.alpha_composite(sh, (px - 8, py + 14))
    canvas_rgba.alpha_composite(popup, (px, py))

    if with_overlay:
        # Page-context toast simulating the in-page overlay
        ov = Image.new("RGBA", (340, 56), (0, 0, 0, 0))
        rounded_rect(ov, (0, 0, 340, 56), 14, fill=(28, 28, 30, 240))
        ImageDraw.Draw(ov).text((170, 28), "已写入 5 / 5 条到报销系统",
                                fill="white", font=font(14), anchor="mm")
        sh2 = shadow(ov.size, 14, (0, 0, 0, 60), 18)
        canvas_rgba.alpha_composite(sh2, (px - 360 - 8, py + 14))
        canvas_rgba.alpha_composite(ov, (px - 360, py))

    return canvas_rgba.convert("RGB")


def make_promo_tile(size=(440, 280)) -> Image.Image:
    """Small promotional tile for the Web Store listing (440x280)."""
    w, h = size
    canvas = gradient(size, (255, 100, 90), (190, 25, 25)).convert("RGBA")

    # decorative circles
    blob = Image.new("RGBA", size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(blob)
    bd.ellipse((-80, -120, 220, 180), fill=(255, 255, 255, 28))
    bd.ellipse((w - 200, h - 120, w + 100, h + 180), fill=(255, 255, 255, 18))
    blob = blob.filter(ImageFilter.GaussianBlur(20))
    canvas.alpha_composite(blob)

    d = ImageDraw.Draw(canvas)

    # 报 mark (rounded square, white on red gradient)
    mark_size = 88
    mx = 30
    my = (h - mark_size) // 2
    inner = gradient((mark_size, mark_size), (255, 255, 255, 255), (245, 245, 245, 255))
    inner = inner.convert("RGBA")
    mask = Image.new("L", (mark_size, mark_size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, mark_size, mark_size), radius=22, fill=255)
    canvas.paste(inner, (mx, my), mask)
    # the 报 character
    f_glyph = font(64)
    d.text((mx + mark_size / 2, my + mark_size / 2 + 2), "报",
           fill=(215, 30, 30), font=f_glyph, anchor="mm")

    # Title block
    tx = mx + mark_size + 22
    d.text((tx, 96), "FliggyClaim", fill="white", font=font(34), anchor="lm")
    d.text((tx, 138), "报销助手", fill=(255, 255, 255, 240), font=font(22), anchor="lm")
    d.text((tx, 188), "拍照 → 解析 → 一键导入", fill=(255, 255, 255, 220),
           font=font(16), anchor="lm")

    return canvas.convert("RGB")


def make_marquee(size=(1400, 560)) -> Image.Image:
    """Optional marquee promotional tile."""
    w, h = size
    canvas = gradient(size, (255, 100, 90), (180, 20, 20)).convert("RGBA")
    blob = Image.new("RGBA", size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(blob)
    bd.ellipse((-200, -300, 600, 500), fill=(255, 255, 255, 28))
    bd.ellipse((w - 400, h - 300, w + 200, h + 500), fill=(255, 255, 255, 16))
    blob = blob.filter(ImageFilter.GaussianBlur(40))
    canvas.alpha_composite(blob)
    d = ImageDraw.Draw(canvas)

    # mark
    ms = 180
    mx, my = 90, (h - ms) // 2
    inner = Image.new("RGBA", (ms, ms), (255, 255, 255, 255))
    mask = Image.new("L", (ms, ms), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, ms, ms), radius=44, fill=255)
    canvas.paste(inner, (mx, my), mask)
    d.text((mx + ms / 2, my + ms / 2 + 4), "报", fill=(215, 30, 30), font=font(140), anchor="mm")

    # text
    tx = mx + ms + 60
    d.text((tx, 200), "FliggyClaim 报销助手", fill="white", font=font(64), anchor="lm")
    d.text((tx, 280), "拍好凭证，AI 自动解析，一键填进飞猪报销系统", fill="white", font=font(28), anchor="lm")
    d.text((tx, 340), "支持 PDF / 图片 · 类型 / 日期 / 金额 / 备注全识别", fill=(255, 255, 255, 220), font=font(22), anchor="lm")

    return canvas.convert("RGB")


def main() -> int:
    scenes = [
        # 1. Hero - empty
        ("01-hero",
         "出差报销，5 倍提速",
         "拍照、拖入、解析、入账，4 步搞定。\n再也不用一张张录入凭证。",
         "empty", False, False),
        # 2. Drag in progress
        ("02-drag-drop",
         "拖进来就行",
         "PDF、JPG、HEIC、WEBP 全支持。\n本地处理，文件不离开你的电脑。",
         "drag", True, False),
        # 3. Files queued
        ("03-files-queued",
         "批量汇总，一目了然",
         "支持任意数量的票据。\n汇总区实时显示数量与大小。",
         "files", False, False),
        # 4. Parsing
        ("04-parsing",
         "AI 自动识别字段",
         "类型、日期、币种、金额、20 字内的备注。\n带进度条，一目了然。",
         "parsing", False, False),
        # 5. Parsed + import
        ("05-import",
         "一键写入报销系统",
         "解析结果可编辑核对。\n确认后自动填到飞猪报销页并保存草稿。",
         "parsed", False, True),
    ]

    for name, h1, h2, st, drag, ov in scenes:
        img = make_scene(h1, h2, st, drag, ov)
        out = OUT / f"{name}.png"
        img.save(out, "PNG", optimize=True)
        print(f"  {out.relative_to(ROOT)}  ({out.stat().st_size // 1024} KB)")

    promo = make_promo_tile()
    promo_path = OUT / "promo-tile-440x280.png"
    promo.save(promo_path, "PNG", optimize=True)
    print(f"  {promo_path.relative_to(ROOT)}  ({promo_path.stat().st_size // 1024} KB)")

    marquee = make_marquee()
    marquee_path = OUT / "marquee-1400x560.png"
    marquee.save(marquee_path, "PNG", optimize=True)
    print(f"  {marquee_path.relative_to(ROOT)}  ({marquee_path.stat().st_size // 1024} KB)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
