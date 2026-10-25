#!/usr/bin/env python3
"""
Generate EPURE brand assets (light/dark, full/emblem/mark, favicons, OG image)
from 'Logo EPURE _ Fusion entre Géométrie et Réseau.png'.
"""

import os
from collections import deque
import numpy as np
from PIL import Image

SOURCE_PATH = "docs/public/logo-source.png"
OUT_DIR = "docs/public"


def find_node_hole_mask(is_white_candidate: np.ndarray) -> np.ndarray:
    """
    Find only the two circular hollow node interiors on the left of the wishbone
    (around x=638..670, y=436..468 and y=732..764), keeping all other white areas
    (between blueprint arcs, inside the wishbone fork, inside letters P and R)
    100% transparent!
    """
    h, w = is_white_candidate.shape
    visited = np.zeros_like(is_white_candidate, dtype=bool)
    node_holes = np.zeros_like(is_white_candidate, dtype=bool)

    for y in range(h):
        for x in range(w):
            if is_white_candidate[y, x] and not visited[y, x]:
                q = deque([(y, x)])
                visited[y, x] = True
                pixels = []
                touches_border = False
                while q:
                    cy, cx = q.popleft()
                    pixels.append((cy, cx))
                    if cy == 0 or cy == h - 1 or cx == 0 or cx == w - 1:
                        touches_border = True
                    for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                        if 0 <= ny < h and 0 <= nx < w and is_white_candidate[ny, nx] and not visited[ny, nx]:
                            visited[ny, nx] = True
                            q.append((ny, nx))
                if not touches_border and 600 <= len(pixels) <= 1050:
                    ys = [p[0] for p in pixels]
                    xs = [p[1] for p in pixels]
                    if 620 <= min(xs) and max(xs) <= 690 and max(ys) < 900:
                        for py, px in pixels:
                            node_holes[py, px] = True
    return node_holes


def load_and_segment(path: str):
    im = Image.open(path).convert("RGB")
    arr = np.array(im, dtype=np.float32)
    h, w, _ = arr.shape

    whiteness = np.min(arr, axis=-1)
    is_white_candidate = whiteness >= 242.0

    # Only the two small circular node interiors should have an opaque fill
    node_holes = find_node_hole_mask(is_white_candidate)

    # Smooth alpha for all ink strokes (everything non-white)
    max_diff_from_white = 254.0 - whiteness
    stroke_alpha = np.clip(max_diff_from_white / (254.0 - 210.0), 0.0, 1.0)

    # Light mode RGBA:
    # - Ink strokes get un-matted RGB and smooth alpha
    # - The two hollow node interiors get clean white fill so the node looks solid inside its ring
    # - All background and blueprint/wishbone gaps are 100% transparent
    alpha_light = np.where(node_holes, 1.0, stroke_alpha)

    safe_alpha = np.maximum(alpha_light[:, :, None], 1e-4)
    rgb_light = np.where(
        node_holes[:, :, None],
        255.0,
        255.0 - (255.0 - arr) / safe_alpha
    )
    rgb_light = np.clip(rgb_light, 0.0, 255.0)

    rgba_light = np.zeros((h, w, 4), dtype=np.uint8)
    rgba_light[:, :, :3] = np.round(rgb_light).astype(np.uint8)
    rgba_light[:, :, 3] = np.round(alpha_light * 255.0).astype(np.uint8)

    # Dark mode RGBA:
    # Identify teal accent pixels: G - R > 35 and G > 130
    g_minus_r = rgb_light[:, :, 1] - rgb_light[:, :, 0]
    teal_weight = np.clip((g_minus_r - 35.0) / 55.0, 0.0, 1.0)

    # Luminance of un-matted light ink:
    # - Primary Navy (#01254F) has luminance ~ 0.12 -> Crisp Ice White (#F8FAFC)
    # - Mid-Blue blueprint construction lines (#9CADC1) have luminance ~ 0.67 -> Luminous Sky Blue (#60A5FA)
    # - Teal node (#4ED8B8) -> Vibrant Mint Teal (#5EEAD4)
    # - Two small node holes -> Dark Slate (#0F172A)
    luminance = (0.299 * rgb_light[:, :, 0] + 0.587 * rgb_light[:, :, 1] + 0.114 * rgb_light[:, :, 2]) / 255.0
    line_blend = np.clip((luminance - 0.18) / (0.65 - 0.18), 0.0, 1.0)[:, :, None]

    ice_white = np.array([248.0, 250.0, 252.0])      # #F8FAFC
    blueprint_sky = np.array([96.0, 165.0, 250.0])   # #60A5FA
    mint_teal = np.array([94.0, 234.0, 212.0])       # #5EEAD4
    dark_hollow = np.array([15.0, 23.0, 42.0])       # #0F172A

    non_teal_dark_rgb = (1.0 - line_blend) * ice_white + line_blend * blueprint_sky
    tw = teal_weight[:, :, None]
    stroke_dark_rgb = (1.0 - tw) * non_teal_dark_rgb + tw * mint_teal

    rgb_dark = np.where(node_holes[:, :, None], dark_hollow, stroke_dark_rgb)
    alpha_dark = np.where(
        node_holes,
        1.0,
        np.clip(stroke_alpha * 1.18, 0.0, 1.0)
    )

    rgba_dark = np.zeros((h, w, 4), dtype=np.uint8)
    rgba_dark[:, :, :3] = np.round(np.clip(rgb_dark, 0.0, 255.0)).astype(np.uint8)
    rgba_dark[:, :, 3] = np.round(alpha_dark * 255.0).astype(np.uint8)

    return Image.fromarray(rgba_light, "RGBA"), Image.fromarray(rgba_dark, "RGBA")


def crop_square_centered(img: Image.Image, box: tuple[int, int, int, int], pad_ratio: float = 0.06) -> Image.Image:
    x0, y0, x1, y1 = box
    bw = x1 - x0
    bh = y1 - y0
    side = int(round(max(bw, bh) * (1.0 + 2.0 * pad_ratio)))

    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    crop = img.crop((x0, y0, x1, y1))
    paste_x = int(round((side - bw) / 2.0))
    paste_y = int(round((side - bh) / 2.0))
    canvas.paste(crop, (paste_x, paste_y), crop)
    return canvas


def build_clean_favicon_mark(img: Image.Image) -> Image.Image:
    """
    Extract the iconic right-hand wishbone merge mark (x=616..1014, y=420..780)
    and remove the left-most blueprint axis/stubs to the left of the two input nodes
    so small favicons (16x16, 32x32, 48x48) look clean and sharp without cut-off lines.
    """
    arr = np.array(img).copy()
    # The two left input nodes have centers at (cx=654, cy=452) and (cx=654, cy=748), outer radius ~ 31px.
    # For x < 654, only keep pixels within distance <= 31.5px of either node center (removes horizontal/vertical blueprint stubs!)
    yy, xx = np.ogrid[:arr.shape[0], :arr.shape[1]]
    dist_top = np.sqrt((xx - 654.0) ** 2 + (yy - 452.0) ** 2)
    dist_bot = np.sqrt((xx - 654.0) ** 2 + (yy - 748.0) ** 2)
    in_left_nodes = (dist_top <= 31.5) | (dist_bot <= 31.5)

    left_stub_mask = (xx < 660) & (~in_left_nodes)
    arr[left_stub_mask, 3] = 0

    # Also between y=485..715 and x < 700, mask out any blueprint lines between the two nodes
    arr[485:715, :700, 3] = 0
    # Mask out above y=420 and below y=780
    arr[:420, :, 3] = 0
    arr[780:, :, 3] = 0

    cleaned = Image.fromarray(arr, "RGBA")
    return crop_square_centered(cleaned, (620, 418, 1012, 782), pad_ratio=0.08)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    img_light, img_dark = load_and_segment(SOURCE_PATH)

    # 1. Full Logo (Emblem + "EPURE" wordmark): x=260..1014, y=128..1068
    full_box = (260, 128, 1014, 1068)
    # 2. Emblem Only (Blueprint + Wishbone, no text): x=260..1014, y=128..936
    emblem_box = (260, 128, 1014, 936)

    full_light = crop_square_centered(img_light, full_box, pad_ratio=0.05)
    full_dark = crop_square_centered(img_dark, full_box, pad_ratio=0.05)

    emblem_light = crop_square_centered(img_light, emblem_box, pad_ratio=0.04)
    emblem_dark = crop_square_centered(img_dark, emblem_box, pad_ratio=0.04)

    mark_light = build_clean_favicon_mark(img_light)
    mark_dark = build_clean_favicon_mark(img_dark)

    # Save Full Logo variants (512x512)
    full_light.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "logo-full-light.png"), optimize=True)
    full_dark.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "logo-full-dark.png"), optimize=True)

    # Save Emblem Hero variants (512x512)
    emblem_light.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "logo-light.png"), optimize=True)
    emblem_dark.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "logo-dark.png"), optimize=True)

    # Save Navbar compact Emblem variants (128x128)
    emblem_light.resize((128, 128), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "logo-navbar-light.png"), optimize=True)
    emblem_dark.resize((128, 128), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "logo-navbar-dark.png"), optimize=True)

    # Save Core Wishbone Mark variants (256x256)
    mark_light.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "logo-mark-light.png"), optimize=True)
    mark_dark.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "logo-mark-dark.png"), optimize=True)

    # Favicons (16x16, 32x32 light & dark, multi-size favicon.ico)
    mark_light.resize((16, 16), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "favicon-16x16.png"), optimize=True)
    mark_light.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "favicon-32x32.png"), optimize=True)
    mark_dark.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(OUT_DIR, "favicon-dark-32x32.png"), optimize=True)

    mark_light.save(
        os.path.join(OUT_DIR, "favicon.ico"),
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)]
    )

    # Apple touch icon (180x180 on #FFFFFF card)
    apple_bg = Image.new("RGBA", (180, 180), (255, 255, 255, 255))
    emblem_156 = emblem_light.resize((156, 156), Image.Resampling.LANCZOS)
    apple_bg.paste(emblem_156, (12, 12), emblem_156)
    apple_bg.convert("RGB").save(os.path.join(OUT_DIR, "apple-touch-icon.png"), optimize=True)

    # Social OpenGraph Banner (1200x630 on #0B0F19 blueprint dark background)
    og = Image.new("RGBA", (1200, 630), (11, 15, 25, 255))
    full_dark_540 = full_dark.resize((540, 540), Image.Resampling.LANCZOS)
    og.paste(full_dark_540, ((1200 - 540) // 2, (630 - 540) // 2), full_dark_540)
    og.convert("RGB").save(os.path.join(OUT_DIR, "og-image.png"), optimize=True)

    print("Generated all EPURE brand assets in", OUT_DIR)


if __name__ == "__main__":
    main()
