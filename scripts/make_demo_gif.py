#!/usr/bin/env python3
"""Render the small, source-controlled landing-page demo. Requires Pillow."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "assets" / "agent-vigil-demo.gif"
W, H = 1200, 675
BG = "#07100f"
PANEL = "#0d1b18"
GRID = "#17322c"
MINT = "#8fffc1"
AMBER = "#ffcb6b"
RED = "#ff6b66"
TEXT = "#e8f1ed"
MUTED = "#86a39a"


def font(size: int, bold: bool = False):
    names = [
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/SFNSMonoBold.ttf" if bold else "",
        "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for name in names:
        if name and Path(name).exists():
            try:
                return ImageFont.truetype(name, size)
            except OSError:
                pass
    return ImageFont.load_default()


F14 = font(18)
F20 = font(23)
F34 = font(39, True)
F56 = font(62, True)

scenes = [
    ("CLAIM", "ALL 99 TESTS PASS", "Agent narrative", AMBER, ["Regression included.", "Ready to merge."]),
    ("BIND", "BASE ↔ HEAD", "Exact change identity", MINT, ["base  38bc…91d", "head  a214…ce8", "policy from base"]),
    ("RUN", "42 TESTS OBSERVED", "Fresh verification", AMBER, ["command exited 0", "claimed count: 99", "observed count: 42"]),
    ("CONTROL", "BASE ALSO PASSES", "Regression negative control", RED, ["candidate: PASS", "base + candidate test: PASS", "new test proves nothing"]),
    ("VERDICT", "FAIL", "The green check is withheld", RED, ["✗ test-count", "✗ differential-base-fail", "receipt sha256: c312…5f"]),
    ("REMEDIATE", "MAKE THE PROOF TRUE", "Specific next action", MINT, ["Fix the changed test.", "Re-run against base and head.", "Attach the new receipt."]),
]

OUT.parent.mkdir(parents=True, exist_ok=True)
frames = []
for number, (kicker, title, subtitle, accent, lines) in enumerate(scenes, 1):
    im = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(im)
    for x in range(0, W, 60):
        draw.line((x, 0, x, H), fill=GRID, width=1)
    for y in range(0, H, 60):
        draw.line((0, y, W, y), fill=GRID, width=1)
    draw.rounded_rectangle((55, 48, W - 55, H - 48), radius=18, fill=PANEL, outline=accent, width=2)
    draw.rectangle((55, 48, W - 55, 58), fill=accent)
    draw.text((92, 88), "AGENT VIGIL / 60 SECOND GATE", font=F14, fill=MUTED)
    draw.text((92, 146), f"0{number}  {kicker}", font=F20, fill=accent)
    draw.text((92, 204), title, font=F56, fill=TEXT)
    draw.text((95, 294), subtitle, font=F20, fill=MUTED)
    y = 370
    for line in lines:
        draw.ellipse((99, y + 10, 111, y + 22), fill=accent)
        draw.text((137, y), line, font=F34, fill=TEXT)
        y += 60
    draw.text((92, 584), "ILLUSTRATIVE DEMO · EXACT HISTORICAL CASES IN /proof", font=F14, fill=MUTED)
    draw.text((1045, 584), f"{number}/6", font=F14, fill=accent)
    frames.append(im)

frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=[1700] * 6, loop=0, optimize=True)
print(OUT)
