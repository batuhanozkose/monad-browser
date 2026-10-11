#!/usr/bin/env python3
"""Render the README terminal screenshots as SVG (crisp at any zoom).

The transcripts are real `mb` output captured from a live session; long lines
are truncated with an ellipsis so the images stay readable in a README.

Run:  python3 assets/gen-terminal.py
"""
import os
import re

OUT = os.path.dirname(os.path.abspath(__file__))
MONO = "'SFMono-Regular', ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace"

FS = 13.5
LH = 22
CHAR_W = 8.3
PAD = 26
HEADER = 42
MAX_COLS = 114

# colors (dark terminal, theme-independent)
BG = "#0b1020"
BAR = "#121a2e"
BORDER = "#232f4b"
FG = "#e6edf3"
MUTED = "#8b96ad"
DIM = "#5b6780"
GREEN = "#3fb950"
RED = "#f778ba"
HEAD = "#a5b4fc"
CYAN = "#22d3ee"

REDRAW = {
    "$": GREEN,
    "ok": GREEN,
    "#": HEAD,
}

TERMINALS = {
    "terminal-quickstart.svg": (
        "mb — news.ycombinator.com",
        r"""$ mb open news.ycombinator.com
ok "Hacker News" https://news.ycombinator.com/

$ mb snapshot -i
# Hacker News — https://news.ycombinator.com/
- link @1
- [Hacker News]@2 [new]@3 [past]@4 [comments]@5 [ask]@6 [show]@7 [jobs]@8 [submit]@9 [login]@10
- link @11
- [IRCv3]@12 [ircv3.net]@13 [basilikum]@14 [40 minutes ago]@15 [hide]@16 [31 comments]@17
- link @18
- [LineageOS 24.0]@19 [lineageos.org]@20 [timschumi]@21 [4 hours ago]@22 [hide]@23 [33 comments]@24
  …

$ mb click @17 -s
ok clicked @17 — https://news.ycombinator.com/item?id=50041540
# IRCv3 | Hacker News — https://news.ycombinator.com/item?id=50041540
- [link]@1 [Hacker News]@2 [new]@3 | [past]@4 | [comments]@5 | [ask]@6 | [show]@7 | [jobs]@8 …
- [link]@11 [IRCv3]@12 ([ircv3.net]@13)
- 44 points by [basilikum]@14 [39 minutes ago]@15 | [hide]@16 | [past]@17 | [favorite]@18 | [30 comments]@19
- form
  - textbox @20
  - [help]@21 [add comment]@22""",
    ),
    "terminal-run.svg": (
        "mb run — whole task, one call",
        r"""$ mb run '
    await goto("books.toscrape.com");
    const titles = [];
    for (let i = 0; i < 3; i++) {
      titles.push(...await js("[...document.querySelectorAll(\"h3 a\")].map(a => a.title)"));
      await click("text=next");
    }
    return titles.length;
  '
60

# three pages paged through, 60 titles collected — one agent turn, one line back""",
    ),
    "terminal-diff.svg": (
        "mb — diff snapshots",
        r"""$ mb open form.html -s
ok "Fixture Form" http://127.0.0.1:8099/form.html
# Fixture Form — http://127.0.0.1:8099/form.html
- nav: [Home]@1 [Next page]@2
- heading "Sign up" [level=1]
- form
  - [textbox Name]@3
  - combobox "Plan" @4 value="Free"
  - checkbox "I agree" @5
  - button "Submit" @6
- clickable "Open card" @7

$ mb click @7 -s
ok clicked @7 — http://127.0.0.1:8099/form.html
# Fixture Form — http://127.0.0.1:8099/form.html
(diff vs last snapshot: +1 -1, 7 unchanged)
- - clickable "Open card" @7
+ - clickable "card clicked" @7

$ mb fill @3 "Ada Lovelace" -s
ok filled @3
(diff vs last snapshot: +1 -1, 7 unchanged)
  - form
-   - [textbox Name]@3
+   - [textbox Name="Ada Lovelace"]@3""",
    ),
}

TOKEN = re.compile(r"(@\d+)")


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_line(line, x, y, diff):
    """Return SVG for one line, with token coloring."""
    lead = " " * (len(line) - len(line.lstrip(" ")))
    body = line.lstrip(" ")
    x0 = x + len(lead) * CHAR_W
    out = []

    if body.startswith("$ "):
        out.append(f'<text x="{x0:.1f}" y="{y}" fill="{GREEN}">$</text>')
        out.append(f'<text x="{x0 + 2*CHAR_W:.1f}" y="{y}" fill="{FG}">{esc_span(body[2:])}</text>')
        return "".join(out)
    if body.startswith("ok "):
        out.append(f'<text x="{x0:.1f}" y="{y}" fill="{GREEN}">ok</text>')
        out.append(f'<text x="{x0 + 3*CHAR_W:.1f}" y="{y}" fill="{MUTED}">{esc_span(body[3:])}</text>')
        return "".join(out)
    if body.startswith("# "):
        return f'<text x="{x0:.1f}" y="{y}" fill="{HEAD}" font-weight="600">{esc_span(body)}</text>'
    if body.startswith("(diff"):
        return f'<text x="{x0:.1f}" y="{y}" fill="{DIM}" font-style="italic">{esc_span(body)}</text>'
    if diff and body.startswith("-"):
        return f'<text x="{x0:.1f}" y="{y}" fill="{RED}">{esc_span(body)}</text>'
    if diff and body.startswith("+"):
        return f'<text x="{x0:.1f}" y="{y}" fill="{GREEN}">{esc_span(body)}</text>'
    return f'<text x="{x0:.1f}" y="{y}" fill="{FG}">{esc_span(body)}</text>'


def esc_span(s):
    """Escape and color @N refs."""
    parts = TOKEN.split(s)
    out = []
    for i, p in enumerate(parts):
        if i % 2 == 1:
            out.append(f'<tspan fill="{CYAN}">{esc(p)}</tspan>')
        else:
            out.append(esc(p))
    return "".join(out)


def build(title, text):
    raw = text.splitlines()
    lines = []
    for ln in raw:
        if len(ln) > MAX_COLS:
            ln = ln[: MAX_COLS - 1] + "…"
        lines.append(ln)
    cols = max(len(l) for l in lines)
    width = int(PAD * 2 + cols * CHAR_W)
    height = HEADER + len(lines) * LH + 18
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
         f'font-family="{MONO}" font-size="{FS}">',
         f'<rect width="{width}" height="{height}" rx="12" fill="{BG}"/>',
         f'<rect x="0.5" y="0.5" width="{width-1}" height="{height-1}" rx="12" fill="none" stroke="{BORDER}"/>',
         f'<path d="M0 12 A12 12 0 0 1 12 0 H{width-12} A12 12 0 0 1 {width} 12 V{HEADER} H0 Z" fill="{BAR}"/>',
         f'<line x1="0" y1="{HEADER}" x2="{width}" y2="{HEADER}" stroke="{BORDER}"/>']
    for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        s.append(f'<circle cx="{PAD + i*18}" cy="{HEADER/2}" r="6" fill="{c}"/>')
    s.append(f'<text x="{PAD + 66}" y="{HEADER/2 + 5}" fill="{MUTED}" font-size="13">{esc(title)}</text>')
    diff = False
    y = HEADER + 24
    for ln in lines:
        s.append(render_line(ln, PAD, y, diff))
        if ln.lstrip(" ").startswith("(diff"):
            diff = True
        elif ln.lstrip(" ").startswith("$"):
            diff = False
        y += LH
    s.append("</svg>")
    return "\n".join(s) + "\n"


if __name__ == "__main__":
    for name, (title, text) in TERMINALS.items():
        p = os.path.join(OUT, name)
        with open(p, "w") as f:
            f.write(build(title, text))
        print("wrote", p)
