#!/usr/bin/env python3
"""
build-photos.py — the teacher's photos, from the untouched originals in
data/source/photos/ to the web-ready files in assets/img/.

    python tools/build-photos.py

Needs Pillow + numpy, and rembg for the cut-out
(`pip install "rembg[cpu]"`; the model downloads once, ~180 MB).
Run it only when an original photo changes — the outputs are committed.

1. teacher-portrait-*.webp / .jpg  (square, shown as a circle)
   Source: teacher-branded-portrait.jpg — the studio portrait from his
   branding graphic. The graphic bakes a slogan and a chart onto the dark
   board beside his head; a tight circular crop would slice through those
   letters, so the lettering inside the crop is painted out with the board's
   own colour before cropping. The name banner below the photo is excluded
   by the crop itself.

2. teacher-standing-*.webp  (4:5, transparent background)
   Source: teacher-full-length.jpg — cut out with rembg (isnet-general-use,
   which kept a clean edge where u2net_human_seg left a cream halo), edge
   colours decontaminated so no wall colour shows on dark backgrounds, then
   cropped head-to-waist for the arch frame.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "source" / "photos"
OUT = ROOT / "assets" / "img"

# --- 1. Portrait ---------------------------------------------------------------

# Crop circle, in original pixels. Chosen so the circle holds the whole head
# with headroom, stays inside the graphic's gold ring, and stops above the
# name banner (which starts at y ~ 795).
PORTRAIT_CX, PORTRAIT_CY, PORTRAIT_R = 660, 415, 375

# The part of the lettered board that falls inside that circle. It ends at
# x=415, left of his ear (which starts at x ~ 420).
BOARD = (262, 176, 416, 648)  # left, top, right, bottom


def polyfit_surface(xs, ys, values, deg=2):
    """Least-squares 2-D polynomial, used as a smooth model of the board."""
    terms = [(i, j) for i in range(deg + 1) for j in range(deg + 1 - i)]
    a = np.stack([(xs ** i) * (ys ** j) for i, j in terms], axis=1)
    coef, *_ = np.linalg.lstsq(a, values, rcond=None)

    def evaluate(gx, gy):
        return sum(c * (gx ** i) * (gy ** j) for c, (i, j) in zip(coef, terms))

    return evaluate


def paint_out_board_lettering(img):
    arr = np.asarray(img).astype(np.float64)
    left, top, right, bottom = BOARD
    patch = arr[top:bottom, left:right]
    lum = 0.2126 * patch[..., 0] + 0.7152 * patch[..., 1] + 0.0722 * patch[..., 2]

    # Lettering and the chart are light beige/gold on a dark board.
    board_level = np.percentile(lum, 35)
    text = lum > board_level + 28
    mask_img = Image.fromarray((text * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(11))
    text = np.asarray(mask_img) > 0

    # Only touch pixels that will actually be visible inside the crop circle.
    h, w = lum.shape
    gy, gx = np.mgrid[0:h, 0:w]
    inside = ((gx + left - PORTRAIT_CX) ** 2 + (gy + top - PORTRAIT_CY) ** 2) <= (PORTRAIT_R + 12) ** 2
    target = text & inside

    # Model the clean board from the pixels that are not lettering.
    keep = ~text
    nx, ny = gx / w, gy / h
    model = np.zeros_like(patch)
    residual_std = []
    for c in range(3):
        fit = polyfit_surface(nx[keep], ny[keep], patch[..., c][keep])
        model[..., c] = fit(nx, ny)
        residual_std.append(np.std(patch[..., c][keep] - model[..., c][keep]))

    # Matching grain, so the repaired area has the photo's texture rather than
    # looking airbrushed.
    rng = np.random.default_rng(7)
    grain = rng.normal(0, 1, size=patch.shape[:2])[..., None] * np.array(residual_std)[None, None, :] * 0.8
    repaired = Image.fromarray(np.clip(model + grain, 0, 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(1.2)
    )

    # Feathered blend so no seam shows at the mask edge.
    alpha = Image.fromarray((target * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(4))
    alpha = np.asarray(alpha).astype(np.float64)[..., None] / 255.0
    blended = patch * (1 - alpha) + np.asarray(repaired).astype(np.float64) * alpha
    arr[top:bottom, left:right] = blended
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def build_portrait():
    src = Image.open(SRC / "teacher-branded-portrait.jpg").convert("RGB")
    clean = paint_out_board_lettering(src)
    box = (
        PORTRAIT_CX - PORTRAIT_R,
        PORTRAIT_CY - PORTRAIT_R,
        PORTRAIT_CX + PORTRAIT_R,
        PORTRAIT_CY + PORTRAIT_R,
    )
    square = clean.crop(box)
    for size in (720, 360):
        square.resize((size, size), Image.LANCZOS).save(
            OUT / f"teacher-portrait-{size}.webp", "WEBP", quality=86, method=6
        )
    # JPEG avatar for crawlers and link previews that expect one. Search
    # engines may show it square, so the circle is composited onto a clean
    # background with a gold ring: nothing outside the circle (the graphic's
    # own ring and lettering) can show in a corner.
    size, ring = 720, 10
    avatar = Image.new("RGB", (size, size), (255, 255, 255))
    draw = ImageDraw.Draw(avatar)
    draw.ellipse((4, 4, size - 5, size - 5), fill=(180, 133, 79))
    inner = size - 2 * (ring + 4)
    mask = Image.new("L", (inner * 4, inner * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, inner * 4 - 1, inner * 4 - 1), fill=255)
    mask = mask.resize((inner, inner), Image.LANCZOS)
    avatar.paste(square.resize((inner, inner), Image.LANCZOS), (ring + 4, ring + 4), mask)
    avatar.save(OUT / "teacher-portrait.jpg", "JPEG", quality=88, optimize=True, progressive=True)
    return square


# --- 2. Standing cut-out ---------------------------------------------------------

STANDING_BOX = (35, 130, 895, 1205)  # head to waist, 4:5


def estimate_background(rgb, alpha):
    """Fill the subject with the surrounding wall colour (normalised blur)."""
    arr = np.asarray(rgb).astype(np.float64)
    bg_weight = (alpha < 0.02).astype(np.float64)
    radius = 40
    w_img = Image.fromarray((bg_weight * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius))
    w = np.asarray(w_img).astype(np.float64) / 255.0
    out = np.zeros_like(arr)
    for c in range(3):
        channel = Image.fromarray(np.clip(arr[..., c] * bg_weight, 0, 255).astype(np.uint8))
        blurred = np.asarray(channel.filter(ImageFilter.GaussianBlur(radius))).astype(np.float64)
        out[..., c] = blurred / np.maximum(w, 1e-3)
    return out


def build_standing():
    from rembg import new_session, remove

    src = Image.open(SRC / "teacher-full-length.jpg").convert("RGB")
    cut = remove(src, session=new_session("isnet-general-use"), post_process_mask=True)
    alpha = np.asarray(cut.split()[-1]).astype(np.float64) / 255.0

    # Tighten the matte slightly and remove the cream wall colour that the
    # soft edge pixels carry, so the outline stays clean on navy.
    alpha = np.clip((alpha - 0.08) / 0.92, 0, 1)
    bg = estimate_background(src, alpha)
    rgb = np.asarray(src).astype(np.float64)
    a = alpha[..., None]
    edge = (a > 0.02) & (a < 0.98)
    fg = np.where(edge, (rgb - (1 - a) * bg) / np.maximum(a, 0.02), rgb)
    fg = np.clip(fg, 0, 255)

    rgba = np.dstack([fg, alpha * 255]).astype(np.uint8)
    out = Image.fromarray(rgba, "RGBA").crop(STANDING_BOX)
    for w in (720, 400):
        h = round(w * out.height / out.width)
        out.resize((w, h), Image.LANCZOS).save(
            OUT / f"teacher-standing-{w}.webp", "WEBP", quality=86, method=6
        )
    return out


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    p = build_portrait()
    print("portrait :", p.size, "->", [f.name for f in sorted(OUT.glob("teacher-portrait*"))])
    s = build_standing()
    print("standing :", s.size, "->", [f.name for f in sorted(OUT.glob("teacher-standing*"))])
