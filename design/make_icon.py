"""Generate RepoFind's icon artwork as SVG.

    python3 design/make_icon.py

Writes design/icon-macos.svg (artwork inset on a transparent canvas, 824 of 1024 px,
as macOS draws icons) and design/icon-full.svg (full bleed, for Windows / Linux / web).
Render each to a 1024×1024 PNG in app/ with any SVG renderer that keeps transparency, e.g.

    chrome --headless --window-size=1024,1024 --default-background-color=00000000 \
           --screenshot=app/icon-macos.png design/icon-macos.svg

The mark: a radar scope whose blips are joined like a commit graph — the bright one is
the repo you were looking for.
"""
import math
import os

AMBER = "#e8a33d"
AMBER_HOT = "#ffd58a"
TEAL = "#5fb3a1"
CX = CY = 512
RINGS = (150, 270, 390)


def polar(r, deg):
    a = math.radians(deg)
    return CX + r * math.cos(a), CY + r * math.sin(a)


def sweep(start, end, radius, slices=180):
    """A fading wedge: thin sectors whose opacity rises toward the leading edge."""
    out = []
    step = (end - start) / slices
    for i in range(slices):
        a0, a1 = start + i * step, start + (i + 1) * step + 0.02  # hairline overlap hides seams
        x0, y0 = polar(radius, a0)
        x1, y1 = polar(radius, a1)
        opacity = 0.02 + 0.30 * ((i + 1) / slices) ** 2.2
        out.append(
            f'<path d="M{CX},{CY} L{x0:.1f},{y0:.1f} A{radius},{radius} 0 0 1 {x1:.1f},{y1:.1f} Z" '
            f'fill="{AMBER}" opacity="{opacity:.3f}"/>'
        )
    return "\n    ".join(out)


def artwork():
    hit = polar(270, -42)      # the repo that was found
    near = polar(150, 152)     # a neighbour on the inner ring
    far = polar(390, 118)      # a faint one on the outer ring
    edge = polar(390, -42)     # where the sweep's leading edge meets the rim
    rings = "\n    ".join(
        f'<circle cx="{CX}" cy="{CY}" r="{r}" fill="none" stroke="{AMBER}" stroke-width="5" opacity="{o}"/>'
        for r, o in zip(RINGS, (0.34, 0.26, 0.20))
    )
    return f"""
    <rect width="1024" height="1024" fill="url(#bg)"/>
    <g opacity="0.12" stroke="{AMBER}" stroke-width="4">
      <line x1="{CX}" y1="70" x2="{CX}" y2="954"/>
      <line x1="70" y1="{CY}" x2="954" y2="{CY}"/>
    </g>
    {rings}
    {sweep(-132, -42, 390)}
    <line x1="{CX}" y1="{CY}" x2="{edge[0]:.1f}" y2="{edge[1]:.1f}" stroke="{AMBER}" stroke-width="6" opacity="0.55" stroke-linecap="round"/>

    <!-- commit graph: centre → found repo, centre → neighbours -->
    <g fill="none" stroke-linecap="round">
      <line x1="{CX}" y1="{CY}" x2="{near[0]:.1f}" y2="{near[1]:.1f}" stroke="{TEAL}" stroke-width="12" opacity="0.75"/>
      <line x1="{near[0]:.1f}" y1="{near[1]:.1f}" x2="{far[0]:.1f}" y2="{far[1]:.1f}" stroke="{TEAL}" stroke-width="10" opacity="0.38"/>
      <line x1="{CX}" y1="{CY}" x2="{hit[0]:.1f}" y2="{hit[1]:.1f}" stroke="{AMBER}" stroke-width="16"/>
    </g>
    <circle cx="{far[0]:.1f}" cy="{far[1]:.1f}" r="20" fill="{TEAL}" opacity="0.5"/>
    <circle cx="{near[0]:.1f}" cy="{near[1]:.1f}" r="30" fill="{TEAL}"/>
    <circle cx="{CX}" cy="{CY}" r="40" fill="#111417" stroke="{AMBER}" stroke-width="16"/>

    <circle cx="{hit[0]:.1f}" cy="{hit[1]:.1f}" r="150" fill="url(#glow)"/>
    <circle cx="{hit[0]:.1f}" cy="{hit[1]:.1f}" r="52" fill="{AMBER}"/>
    <circle cx="{hit[0]:.1f}" cy="{hit[1]:.1f}" r="24" fill="{AMBER_HOT}"/>
    """


DEFS = f"""
  <defs>
    <radialGradient id="bg" cx="50%" cy="46%" r="72%">
      <stop offset="0" stop-color="#252b31"/>
      <stop offset="0.6" stop-color="#15181b"/>
      <stop offset="1" stop-color="#0b0d0f"/>
    </radialGradient>
    <radialGradient id="glow">
      <stop offset="0" stop-color="{AMBER}" stop-opacity="0.55"/>
      <stop offset="0.45" stop-color="{AMBER}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="{AMBER}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="squircle"><rect x="100" y="100" width="824" height="824" rx="185" ry="185"/></clipPath>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>"""


def svg(body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">{DEFS}\n{body}\n</svg>\n'


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    art = artwork()
    full = svg(f"  <g>{art}</g>")
    # macOS: the same artwork scaled into an 824 px rounded square, with a soft shadow and a hairline rim
    macos = svg(
        f"""  <g filter="url(#shadow)"><g clip-path="url(#squircle)">
    <g transform="translate(100 100) scale({824 / 1024:.6f})">{art}</g>
  </g></g>
  <rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="#ffffff" stroke-opacity="0.10" stroke-width="3"/>"""
    )
    for name, content in (("icon-full.svg", full), ("icon-macos.svg", macos)):
        with open(os.path.join(here, name), "w", encoding="utf-8") as f:
            f.write(content)
        print("wrote", name)


if __name__ == "__main__":
    main()
