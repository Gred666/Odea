"""Odea 的 Logo：生成源文件，并（可选）重建 src-tauri/icons。

    python design/logo/gen.py           # 只写 design/logo/*.svg 和 preview.html
    python design/logo/gen.py --apply   # 再用 tauri CLI 渲染整套应用图标

图形：起笔一点。Odea 是把 idea 的 i 写成了 O（ode，颂诗）—— i 上那一点留着，
就是 O 右上缺口里的蓝点：先有一个想法，再从它旁边起笔，绕一圈写成字。

笔画不是 stroke，是算出来的填充轮廓：中线按弧长取样，宽度 = 平头笔模型（顺着笔锋走最细）
× 起笔 / 收笔的压力，沿法线外扩、两端补圆头，再用 Catmull-Rom 转成三次贝塞尔。
小尺寸（16 / 24 / 32px）单独出一版：线加粗、去掉粗细变化，不然在任务栏里只剩一个灰圈。
依赖：Python 3 + Pillow（只有 --apply 要用），tauri CLI（node_modules 里那个）。
"""

import math
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))

# 和 src/styles/globals.css 的 token 一致
INK, INK_DARK = "#1A1A18", "#EEEEE9"
ACCENT, ACCENT_DARK = "#2F63D8", "#6B93F0"


# ---------------------------------------------------------------- 几何


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def fmt(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def catmull_rom(points):
    """闭合的三次贝塞尔路径，穿过所有点（均匀 Catmull-Rom）。"""
    n = len(points)
    d = [f"M{fmt(points[0][0])} {fmt(points[0][1])}"]
    for i in range(n):
        p0, p1, p2, p3 = (points[(i + k) % n] for k in (-1, 0, 1, 2))
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d.append(f"C{fmt(c1[0])} {fmt(c1[1])} {fmt(c2[0])} {fmt(c2[1])} {fmt(p2[0])} {fmt(p2[1])}")
    return "".join(d) + "Z"


def resample(fn, t0, t1, count, dense=4000):
    """fn(t) 上按弧长等距取 count 个点。"""
    raw = [fn(lerp(t0, t1, i / dense)) for i in range(dense + 1)]
    cum = [0.0]
    for a, b in zip(raw, raw[1:]):
        cum.append(cum[-1] + math.dist(a, b))
    out, j = [], 0
    for k in range(count):
        target = cum[-1] * k / (count - 1)
        while j < dense - 1 and cum[j + 1] < target:
            j += 1
        t = (target - cum[j]) / ((cum[j + 1] - cum[j]) or 1)
        out.append((lerp(raw[j][0], raw[j + 1][0], t), lerp(raw[j][1], raw[j + 1][1], t)))
    return out


def stroke_outline(pts, width_fn, cap_steps=8):
    """width_fn(s, 切向) -> 全宽。返回闭合轮廓（两端圆头）的点列。"""
    n = len(pts)
    tans = []
    for i in range(n):
        a, b = pts[max(i - 1, 0)], pts[min(i + 1, n - 1)]
        L = math.dist(a, b) or 1
        tans.append(((b[0] - a[0]) / L, (b[1] - a[1]) / L))
    left, right, half = [], [], []
    for i, (p, t) in enumerate(zip(pts, tans)):
        h = width_fn(i / (n - 1), t) / 2
        half.append(h)
        left.append((p[0] - t[1] * h, p[1] + t[0] * h))
        right.append((p[0] + t[1] * h, p[1] - t[0] * h))

    def cap(c, t, r, sgn):
        # 从一侧绕到另一侧的半圆；sgn=1 往前凸（收笔），-1 往后凸（起笔）
        nx, ny = -t[1], t[0]
        return [
            (
                c[0] + r * (sgn * nx * math.cos(a) + sgn * t[0] * math.sin(a)),
                c[1] + r * (sgn * ny * math.cos(a) + sgn * t[1] * math.sin(a)),
            )
            for a in (math.pi * k / cap_steps for k in range(1, cap_steps))
        ]

    return (
        left
        + cap(pts[-1], tans[-1], half[-1], 1)
        + right[::-1]
        + cap(pts[0], tans[0], half[0], -1)
    )


def nib(t, thin_deg, amount):
    """平头笔：走向和笔锋平行时最细。"""
    th = math.radians(thin_deg)
    c = t[0] * math.cos(th) + t[1] * math.sin(th)
    return 1 - amount * c * c


def superellipse(cx, cy, a, n=5.0, count=96):
    pts = []
    for i in range(count):
        t = 2 * math.pi * i / count
        c, s = math.cos(t), math.sin(t)
        pts.append(
            (cx + a * math.copysign(abs(c) ** (2 / n), c), cy + a * math.copysign(abs(s) ** (2 / n), s))
        )
    return catmull_rom(pts)


# ---------------------------------------------------------------- 图形

# 三档给图标：标准（48px 以上）、中（32px）、小（16 / 24px）
WEIGHTS = {
    "regular": dict(W=68, dot_r=46, nib_amt=0.28, entry=(0.72, 0.12), exit_=(0.6, 0.66), gaps=(22, 24)),
    "mid": dict(W=82, dot_r=54, nib_amt=0.12, entry=(0.9, 0.08), exit_=(0.8, 0.7), gaps=(24, 26), scale=1.1),
    "small": dict(W=96, dot_r=60, nib_amt=0.0, entry=(1, 0.01), exit_=(1, 0.99), gaps=(26, 28), scale=1.2),
}


def mark(weight="regular", cx=512, cy=508):
    """(笔画轮廓 d, (点 cx, cy, r))，坐标在 1024 的画布上。"""
    p = WEIGHTS[weight]
    scale = p.get("scale", 1.0)
    rx, ry, rot = 214 * scale, 232 * scale, math.radians(9)  # 竖着略长、顶部右倾：手写的 O

    def ring(tdeg):
        t = math.radians(tdeg)
        k = 1 + 0.02 * math.sin(2 * t + 0.9) + 0.012 * math.sin(3 * t + 2.2)  # 一点点不规整
        x, y = rx * k * math.cos(t), -ry * k * math.sin(t)
        return cx + x * math.cos(rot) - y * math.sin(rot), cy + x * math.sin(rot) + y * math.cos(rot)

    t_dot = 56  # 蓝点在一点半方向；笔画从它左边起笔，逆时针绕一圈，停在它下面
    pts = resample(ring, t_dot + p["gaps"][0], t_dot + 360 - p["gaps"][1], 96)
    W = p["W"] * scale

    def width(s, tan):
        e = lerp(p["entry"][0], 1.0, smoothstep(0.0, p["entry"][1], s))
        x = lerp(1.0, p["exit_"][0], smoothstep(p["exit_"][1], 1.0, s))
        return W * e * x * nib(tan, -40, p["nib_amt"])

    dx, dy = ring(t_dot)
    return catmull_rom(stroke_outline(pts, width)), (dx, dy, p["dot_r"] * scale)


def mark_box(weight="regular", pad=0.04):
    """标记的外接框 (x, y, w, h)，四边留 pad × 边长的余量。"""
    p = WEIGHTS[weight]
    d, (dx, dy, dr) = mark(weight)
    nums = [float(v) for v in d.replace("M", " ").replace("C", " ").replace("Z", " ").split()]
    xs, ys = nums[0::2] + [dx - dr, dx + dr], nums[1::2] + [dy - dr, dy + dr]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    m = max(x1 - x0, y1 - y0) * pad
    return x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m


# ---------------------------------------------------------------- 应用图标

TILES = {
    # 纸：和应用本身一样，白纸、墨色、一点主色
    "paper": dict(
        bg=("#FDFDFB", "#ECECE6"),
        edge="#1A1A18",
        edge_op=0.1,
        hi_op=0.9,
        ink=("#2A2A27", "#121211"),
        dot=("#5B87EE", ACCENT, "#2652B8"),
    ),
    # 墨：暗色版
    "ink": dict(
        bg=("#2C2C29", "#151514"),
        edge="#000000",
        edge_op=0.35,
        hi_op=0.1,
        ink=("#FAFAF6", "#DCDCD5"),
        dot=("#93B2F6", ACCENT_DARK, "#4F7BE6"),
    ),
}


def icon_svg(tile="paper", weight="regular", mac=False):
    """完整的应用图标。mac=True 按 Apple 的 824 网格留边并加投影。"""
    p = TILES[tile]
    stroke_d, (dx, dy, dr) = mark(weight)
    size = 824 if mac else 920
    sq = superellipse(512, 512, size / 2)
    k = size / 920
    shadow = ' filter="url(#sh)"' if mac else ""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{p['bg'][0]}"/><stop offset="1" stop-color="{p['bg'][1]}"/></linearGradient>
  <linearGradient id="hi" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF" stop-opacity="{p['hi_op']}"/><stop offset="0.35" stop-color="#FFF" stop-opacity="0"/></linearGradient>
  <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="0" y1="260" x2="0" y2="780"><stop offset="0" stop-color="{p['ink'][0]}"/><stop offset="1" stop-color="{p['ink'][1]}"/></linearGradient>
  <radialGradient id="dot" cx="0.36" cy="0.3" r="0.8"><stop offset="0" stop-color="{p['dot'][0]}"/><stop offset="0.55" stop-color="{p['dot'][1]}"/><stop offset="1" stop-color="{p['dot'][2]}"/></radialGradient>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="10"/><feComponentTransfer><feFuncA type="linear" slope="0.28"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<g{shadow}><path d="{sq}" fill="url(#bg)"/></g>
<path d="{sq}" fill="url(#hi)"/>
<path d="{sq}" fill="none" stroke="{p['edge']}" stroke-opacity="{p['edge_op']}" stroke-width="2"/>
<g transform="translate(512 512) scale({k:.4f}) translate(-512 -512)">
  <path d="{stroke_d}" fill="url(#ink)"/>
  <circle cx="{fmt(dx)}" cy="{fmt(dy)}" r="{fmt(dr)}" fill="url(#dot)"/>
</g>
</svg>
"""


# ---------------------------------------------------------------- 不带底板的标记

def glyph_svg(weight="regular", favicon=False):
    """单独的标记。默认墨色走 currentColor、点走主色 token，嵌进页面会跟着暗色模式换；
    favicon=True 时颜色写死，靠 SVG 里的媒体查询切暗色。"""
    stroke_d, (dx, dy, dr) = mark(weight)
    box = " ".join(fmt(v) for v in mark_box(weight))
    if favicon:
        style = (
            f"<style>.i{{fill:{INK}}}.d{{fill:{ACCENT}}}"
            f"@media (prefers-color-scheme:dark){{.i{{fill:{INK_DARK}}}.d{{fill:{ACCENT_DARK}}}}}</style>"
        )
        ink, dot = 'class="i"', 'class="d"'
    else:
        style = ""
        ink, dot = 'fill="currentColor"', f'fill="{ACCENT}" style="fill:var(--color-accent,{ACCENT})"'
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box}">{style}
<path {ink} d="{stroke_d}"/>
<circle {dot} cx="{fmt(dx)}" cy="{fmt(dy)}" r="{fmt(dr)}"/>
</svg>
"""


# 和 src/components/logoGeometry.ts 的 STROKES、DOT 同一组：开口的 O、d 的碗和竖、e、a
WORDMARK = [
    "M30.78 14.91 C 26.57 14.27, 21.99 15.45, 18 19 C 9 27, 7 46, 15 55 C 23 64, 38 60, 43 47 C 45.65 39.94, 45.18 32.1, 42.97 26.24",
    "M74 37 C 69 32, 60 32, 56 39 C 52 46, 54 56, 61 59 C 67 61, 72 55, 73 47 C 74 41, 74 38, 74 36",
    "M76 12 C 75 26, 74 41, 74 52 C 74 56, 74 59, 75 61",
    "M82 48 C 88 46, 96 44, 101 42 C 103 37, 99 33, 94 34 C 88 35, 83 41, 83 48 C 83 55, 88 62, 96 61 C 100 60, 103 57, 105 54",
    "M134 37 C 129 32, 120 32, 116 39 C 112 46, 114 56, 121 59 C 127 61, 132 55, 133 47 C 134 41, 134 37, 134 35 C 133 44, 133 53, 134 61",
]
WORDMARK_DOT = (38.4, 18.8, 3.5)


def lockup_svg():
    """字标：手写的 Odea。它的 O 就是图标 —— 开口、缺口里一个蓝点，所以不用再在左边另摆一个标记。"""
    words = "".join(f'<path d="{d}"/>' for d in WORDMARK)
    dx, dy, dr = WORDMARK_DOT
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 6 136 62">
<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">{words}</g>
<circle fill="{ACCENT}" style="fill:var(--color-accent,{ACCENT})" cx="{fmt(dx)}" cy="{fmt(dy)}" r="{fmt(dr)}"/>
</svg>
"""


# ---------------------------------------------------------------- 输出


def write(name, text):
    with open(os.path.join(HERE, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def build_sources():
    write("icon.svg", icon_svg("paper"))
    write("icon-dark.svg", icon_svg("ink"))
    write("icon-macos.svg", icon_svg("paper", mac=True))
    write("icon-32.svg", icon_svg("paper", "mid"))
    write("icon-16.svg", icon_svg("paper", "small"))
    write("mark.svg", glyph_svg())
    write("lockup.svg", lockup_svg())
    favicon = glyph_svg("small", favicon=True)
    write("favicon.svg", favicon)
    os.makedirs(os.path.join(ROOT, "public"), exist_ok=True)
    with open(os.path.join(ROOT, "public", "favicon.svg"), "w", encoding="utf-8", newline="\n") as f:
        f.write(favicon)


def tauri(*args):
    exe = os.path.join(ROOT, "node_modules", ".bin", "tauri.CMD" if os.name == "nt" else "tauri")
    subprocess.run([exe, "icon", *args], check=True, capture_output=True, cwd=ROOT)


def write_ico(path, frames):
    """按给的顺序写 ICO（每张都是 PNG 编码）。PIL 自己写会按尺寸从小到大排。"""
    import io
    import struct

    blobs = []
    for im in frames:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        blobs.append(buf.getvalue())
    header = [struct.pack("<HHH", 0, 1, len(frames))]
    offset = 6 + 16 * len(frames)
    for im, blob in zip(frames, blobs):
        w, h = im.size
        header.append(struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(blob), offset))
        offset += len(blob)
    with open(path, "wb") as f:
        f.write(b"".join(header + blobs))


def apply_icons():
    from PIL import Image

    icons = os.path.join(ROOT, "src-tauri", "icons")
    tauri(os.path.join(HERE, "icon.svg"), "-o", icons)
    with tempfile.TemporaryDirectory() as tmp:
        # macOS：Apple 网格（留边 + 投影）
        tauri(os.path.join(HERE, "icon-macos.svg"), "-o", os.path.join(tmp, "mac"))
        shutil.copyfile(os.path.join(tmp, "mac", "icon.icns"), os.path.join(icons, "icon.icns"))

        # 小尺寸用加粗版重画
        tauri(os.path.join(HERE, "icon-16.svg"), "-o", os.path.join(tmp, "s"), "-p", "16,24")
        tauri(os.path.join(HERE, "icon-32.svg"), "-o", os.path.join(tmp, "m"), "-p", "30,32,44")
        tauri(os.path.join(HERE, "icon.svg"), "-o", os.path.join(tmp, "r"), "-p", "48,64,256,1024")
        png = lambda d, n: Image.open(os.path.join(tmp, d, f"{n}x{n}.png")).convert("RGBA")  # noqa: E731

        # 32 放第一张（和 `tauri icon` 一样）：Tauri 2.11 拿第一张当窗口图标的兜底，
        # 以前 16 在最前面，任务栏把它拉到 48px，糊成一团。真正用的窗口图标见 src-tauri/src/lib.rs
        frames = [png("m", 32), png("s", 16), png("s", 24), png("r", 48), png("r", 64), png("r", 256)]
        write_ico(os.path.join(icons, "icon.ico"), frames)
        png("m", 32).save(os.path.join(icons, "32x32.png"))
        png("m", 30).save(os.path.join(icons, "Square30x30Logo.png"))
        png("m", 44).save(os.path.join(icons, "Square44x44Logo.png"))
        # `pnpm tauri icon` 不带参数时读这张；小尺寸的加粗版只有跑这个脚本才有
        png("r", 1024).save(os.path.join(ROOT, "src-tauri", "app-icon.png"))


# ---------------------------------------------------------------- 预览页


def preview_html():
    """design/logo/preview.html：SVG 全部内联；小尺寸放的是 tauri CLI 实际渲染出的 PNG。"""
    import base64

    def read(name):
        with open(os.path.join(HERE, name), encoding="utf-8") as f:
            return f.read()

    def inline(name):
        # 几张图标的渐变 id 一样（bg / ink / dot…），内联到同一页要各自加前缀，不然后面的引用到前面的
        pre = name.split(".")[0] + "-"
        svg = read(name).replace('width="1024" height="1024"', 'width="100%" height="100%"')
        return svg.replace('id="', f'id="{pre}').replace("url(#", f"url(#{pre}")

    renders = {}
    with tempfile.TemporaryDirectory() as tmp:
        jobs = (("icon-16", "16,24"), ("icon-32", "32"), ("icon", "48,64,128,256"), ("icon-dark", "32"))
        for name, sizes in jobs:
            out = os.path.join(tmp, name)
            tauri(os.path.join(HERE, f"{name}.svg"), "-o", out, "-p", sizes)
            for s in sizes.split(","):
                with open(os.path.join(out, f"{s}x{s}.png"), "rb") as f:
                    data = base64.b64encode(f.read()).decode()
                renders[(name, int(s))] = f"data:image/png;base64,{data}"

    def png(name, s, css=None):
        css = css or s
        return f'<img src="{renders[(name, s)]}" width="{css}" height="{css}" alt="">'

    steps = (
        ("icon", 256),
        ("icon", 128),
        ("icon", 64),
        ("icon", 48),
        ("icon-32", 32),
        ("icon-16", 24),
        ("icon-16", 16),
    )
    ladder = "".join(f"<figure>{png(n, s)}<figcaption>{s}</figcaption></figure>" for n, s in steps)
    html = read("preview.template.html")
    for key, value in {
        "hero": inline("icon.svg"),
        "dark": inline("icon-dark.svg"),
        "mac": inline("icon-macos.svg"),
        "mark": read("mark.svg"),
        "lockup": read("lockup.svg"),
        "ladder": ladder,
        "task-paper": png("icon-32", 32, 24),
        "task-ink": png("icon-dark", 32, 24),
    }.items():
        html = html.replace(f"<!--{key}-->", value)
    write("preview.html", html)


if __name__ == "__main__":
    build_sources()
    if "--apply" in sys.argv:
        apply_icons()
    preview_html()
    print("done")
