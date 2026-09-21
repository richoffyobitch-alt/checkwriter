#!/usr/bin/env python3
"""
Builds the Windows and macOS application icons from the mark used inside
the app.

The in-app logo is five bars of alternating weight on a rounded square — a
nod to the magnetic-ink characters along the bottom of a check. That reads
well at 28px in the sidebar and beautifully at 256px, but the two narrow
1.75-unit bars collapse into grey mush somewhere below 32px.

A .ico is a container holding several independent images, so rather than
scaling one drawing down and hoping, this draws the mark twice: the full
five-bar version for large sizes, and a simplified three-bar version with
wider strokes and bigger gaps for the sizes Windows uses in the taskbar and
Explorer lists.

Everything is drawn directly with Pillow. The geometry mirrors layout.tsx.
"""

from PIL import Image, ImageDraw
import os

BRAND = (235, 20, 20, 255)      # hsl(0 84% 50%) -> the app's --primary
WHITE = (255, 255, 255, 255)

# Bars from layout.tsx, on the original 32-unit grid: (x, y, w, h)
FULL_BARS = [
    (7.00, 9.0, 3.50, 14.0),
    (12.00, 9.0, 1.75, 14.0),
    (15.25, 14.0, 3.50, 9.0),
    (20.25, 9.0, 1.75, 14.0),
    (23.50, 9.0, 1.75, 9.0),
]

# Simplified mark for small sizes: three bars, wider, evenly gapped. Keeps
# the silhouette and the short-bar rhythm without sub-pixel strokes.
SIMPLE_BARS = [
    (7.0, 9.0, 4.5, 14.0),
    (13.5, 14.0, 4.5, 9.0),
    (20.0, 9.0, 4.5, 14.0),
]

CORNER_RADIUS = 7.5  # on the 32-unit grid


def render(size: int, bars, supersample: int = 8) -> Image.Image:
    """Draw the mark at `size` px, oversampled then reduced for clean edges."""
    s = size * supersample
    scale = s / 32.0

    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = CORNER_RADIUS * scale
    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BRAND)

    for x, y, w, h in bars:
        x0, y0 = x * scale, y * scale
        x1, y1 = (x + w) * scale, (y + h) * scale
        # 0.6-unit corner rounding on the bars, same as the SVG
        r = min(0.6 * scale, (x1 - x0) / 2, (y1 - y0) / 2)
        draw.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


# macOS draws icons on a fixed grid rather than edge to edge. On a 1024px
# canvas the rounded square occupies 824px centred, leaving a 100px margin
# the system uses for its own drop shadow and for the hover/press animation
# in the Dock. An icon that fills the whole canvas looks oversized next to
# every other app, so this is not cosmetic fussiness.
MAC_CANVAS = 1024
MAC_BODY = 824
# Apple's squircle is close to 22.5% of the body width. Pillow draws a true
# circular arc rather than a superellipse; at this radius the difference is
# not visible at Dock sizes.
MAC_RADIUS_RATIO = 0.225


def render_mac(supersample: int = 4) -> Image.Image:
    """Draw the mark on the macOS icon grid: 824px body on a 1024px canvas."""
    canvas = MAC_CANVAS * supersample
    body = MAC_BODY * supersample
    inset = (canvas - body) // 2
    scale = body / 32.0

    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle(
        [inset, inset, inset + body - 1, inset + body - 1],
        radius=body * MAC_RADIUS_RATIO,
        fill=BRAND,
    )

    for x, y, w, h in FULL_BARS:
        x0, y0 = inset + x * scale, inset + y * scale
        x1, y1 = inset + (x + w) * scale, inset + (y + h) * scale
        r = min(0.6 * scale, (x1 - x0) / 2, (y1 - y0) / 2)
        draw.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=WHITE)

    return img.resize((MAC_CANVAS, MAC_CANVAS), Image.LANCZOS)


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(os.path.dirname(here), "build")
    os.makedirs(out_dir, exist_ok=True)

    # Below this, the five-bar mark stops being readable.
    SIMPLIFY_BELOW = 40

    sizes = [256, 128, 64, 48, 32, 24, 16]
    layers = []
    for size in sizes:
        bars = FULL_BARS if size >= SIMPLIFY_BELOW else SIMPLE_BARS
        img = render(size, bars)
        layers.append(img)
        which = "full" if size >= SIMPLIFY_BELOW else "simplified"
        print(f"  {size:>3}px  {which}")

    ico_path = os.path.join(out_dir, "icon.ico")
    # Pillow writes every supplied image as its own frame when sizes are given.
    layers[0].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=layers[1:],
    )
    print(f"wrote {ico_path}")

    # electron-builder wants a >=256px PNG for non-Windows targets, and the
    # BrowserWindow icon option uses it too.
    png_path = os.path.join(out_dir, "icon.png")
    render(512, FULL_BARS).save(png_path, format="PNG")
    print(f"wrote {png_path}")

    # macOS. electron-builder converts this to a multi-resolution .icns, and
    # it must be exactly 1024x1024 or the conversion is rejected.
    mac_path = os.path.join(out_dir, "icon-mac.png")
    render_mac().save(mac_path, format="PNG")
    print(f"wrote {mac_path}")

    # Contact sheet so the icon can be eyeballed at real sizes.
    pad = 24
    row1_w = sum(sizes) + pad * (len(sizes) + 1)
    mags = [(16, 8), (24, 8), (32, 8)]
    row2_w = sum(s * m for s, m in mags) + pad * (len(mags) + 1)
    width = max(row1_w, row2_w, 640)
    row1_h = max(sizes)
    row2_h = max(s * m for s, m in mags)
    height = pad + row1_h + pad * 2 + row2_h + pad

    sheet = Image.new("RGBA", (width, height), (18, 18, 20, 255))

    x = pad
    y1 = pad
    for size in sizes:
        bars = FULL_BARS if size >= SIMPLIFY_BELOW else SIMPLE_BARS
        img = render(size, bars)
        # bottom-align the row so the sizes read as a staircase
        sheet.paste(img, (x, y1 + row1_h - size), img)
        x += size + pad

    x = pad
    y2 = pad + row1_h + pad * 2
    for size, mult in mags:
        bars = FULL_BARS if size >= SIMPLIFY_BELOW else SIMPLE_BARS
        img = render(size, bars).resize((size * mult, size * mult), Image.NEAREST)
        sheet.paste(img, (x, y2), img)
        x += size * mult + pad

    sheet_path = os.path.join(out_dir, "icon-preview.png")
    sheet.save(sheet_path)
    print(f"wrote {sheet_path} ({width}x{height})")


if __name__ == "__main__":
    main()
