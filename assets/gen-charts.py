#!/usr/bin/env python3
"""Generate the benchmark SVGs in assets/ from the numbers in BENCHMARK.md.

Charts are theme-adaptive: light by default, dark under prefers-color-scheme.
Run:  python3 assets/gen-charts.py
"""
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)))
SANS = "Inter, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
MONO = "'SFMono-Regular', ui-monospace, Menlo, Consolas, monospace"

# palette (light / dark)
C = {
    "fg":      ("#1f2328", "#e6edf3"),
    "muted":   ("#59636e", "#9198a1"),
    "faint":   ("#8c959f", "#6e7681"),
    "grid":    ("#d8dee4", "#30363d"),
    "track":   ("#eef1f4", "#161b22"),
    "other":   ("#a9b4c4", "#4d5866"),
    "other2":  ("#8b97a8", "#3d4756"),
    "hl":      ("#6366f1", "#818cf8"),
    "hl2":     ("#22d3ee", "#67e8f9"),
    "amber":   ("#d29922", "#e3b341"),
    "green":   ("#1a7f37", "#3fb950"),
}


def head(w, h):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" font-family="{SANS}">
<style>
.fg{{fill:{C['fg'][0]}}} .mu{{fill:{C['muted'][0]}}} .fa{{fill:{C['faint'][0]}}}
.gr{{stroke:{C['grid'][0]}}} .tr{{fill:{C['track'][0]}}}
.ot{{fill:{C['other'][0]}}} .o2{{fill:{C['other2'][0]}}} .hi{{fill:{C['hl'][0]}}} .h2{{fill:{C['hl2'][0]}}} .am{{fill:{C['amber'][0]}}} .gn{{fill:{C['green'][0]}}}
@media (prefers-color-scheme: dark){{
.fg{{fill:{C['fg'][1]}}} .mu{{fill:{C['muted'][1]}}} .fa{{fill:{C['faint'][1]}}}
.gr{{stroke:{C['grid'][1]}}} .tr{{fill:{C['track'][1]}}}
.ot{{fill:{C['other'][1]}}} .o2{{fill:{C['other2'][1]}}} .hi{{fill:{C['hl'][1]}}} .h2{{fill:{C['hl2'][1]}}} .am{{fill:{C['amber'][1]}}} .gn{{fill:{C['green'][1]}}}
}}
</style>
<defs>
<linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/>
</linearGradient>
</defs>'''


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def hbar(x, y, w, h, r=6, cls="ot"):
    return f'<rect x="{x:.1f}" y="{y:.1f}" width="{max(w,2):.1f}" height="{h}" rx="{r}" class="{cls}"/>'


def title(x, y, main, sub=None, size=20):
    s = f'<text x="{x}" y="{y}" class="fg" font-size="{size}" font-weight="700">{esc(main)}</text>'
    if sub:
        s += f'<text x="{x}" y="{y+22}" class="mu" font-size="13">{esc(sub)}</text>'
    return s


def write(name, body):
    p = os.path.join(OUT, name)
    with open(p, "w") as f:
        f.write(body + "\n</svg>\n")
    print("wrote", p)


# ---------------------------------------------------------------- snapshot totals
def chart_snapshot():
    rows = [
        ("monad-browser", "47k", 47000, "grad"),
        ("agent-browser", "109k", 109000, "ot"),
        ("Playwright CLI", "184k", 184000, "ot"),
        ("Playwright MCP", "184k", 184000, "ot"),
        ("Chrome DevTools MCP", "202k", 202000, "ot"),
    ]
    W, top, left, right = 880, 84, 210, 96
    bh, gap = 30, 16
    H = top + len(rows) * (bh + gap) + 20
    mx = max(r[2] for r in rows)
    plot_w = W - left - right
    s = head(W, H)
    s += title(28, 36, "Snapshot cost — full page", "sum of o200k tokens over 6 pages: form · example · HN · books · MDN · Wikipedia  ·  lower is better")
    for i, (name, label, val, cls) in enumerate(rows):
        y = top + i * (bh + gap)
        s += hbar(left, y, plot_w, bh, 7, "tr")
        w = plot_w * val / mx
        if cls == "grad":
            s += f'<rect x="{left}" y="{y}" width="{w:.1f}" height="{bh}" rx="7" fill="url(#grad)"/>'
        else:
            s += hbar(left, y, w, bh, 7, cls)
        s += f'<text x="{left-14}" y="{y+bh/2+5}" text-anchor="end" class="fg" font-size="14" font-weight="{700 if cls=="grad" else 500}">{esc(name)}</text>'
        s += f'<text x="{left+w+12}" y="{y+bh/2+5}" class="{"hi" if cls=="grad" else "mu"}" font-size="14" font-weight="{700 if cls=="grad" else 600}">{esc(label)}</text>'
    s += f'<text x="{left}" y="{H-6}" class="fa" font-size="12">monad-browser reads the same content in 2.3×–4.3× fewer tokens (CLI and MCP are identical).</text>'
    write("bench-snapshot.svg", s)


# ---------------------------------------------------------------- interactive-only
def chart_interactive():
    rows = [
        ("monad-browser -i", "17k", 17000, "grad"),
        ("agent-browser -i", "43k", 43000, "ot"),
    ]
    W, top, left, right = 880, 84, 210, 96
    bh, gap = 34, 16
    H = top + len(rows) * (bh + gap) + 34
    mx = max(r[2] for r in rows)
    plot_w = W - left - right
    s = head(W, H)
    s += title(28, 36, "Interactive-only snapshot (-i)", "same 6 pages, only interactive elements")
    for i, (name, label, val, cls) in enumerate(rows):
        y = top + i * (bh + gap)
        s += hbar(left, y, plot_w, bh, 7, "tr")
        w = plot_w * val / mx
        s += (f'<rect x="{left}" y="{y}" width="{w:.1f}" height="{bh}" rx="7" fill="url(#grad)"/>'
              if cls == "grad" else hbar(left, y, w, bh, 7, cls))
        s += f'<text x="{left-14}" y="{y+bh/2+5}" text-anchor="end" class="fg" font-size="14" font-weight="{700 if cls=="grad" else 500}">{esc(name)}</text>'
        s += f'<text x="{left+w+12}" y="{y+bh/2+5}" class="{"hi" if cls=="grad" else "mu"}" font-size="14" font-weight="600">{esc(label)}</text>'
    s += f'<text x="{left}" y="{H-10}" class="fa" font-size="12">agent-browser -i keeps ~30% less page content than monad default (see retention chart).</text>'
    write("bench-interactive.svg", s)


# ---------------------------------------------------------------- latency small multiples
def chart_latency():
    panels = [
        ("open (local)", [("monad CLI", 87, "grad"), ("monad MCP", 59, "h2"), ("agent-browser", 73, "ot"), ("Playwright CLI", 383, "ot"), ("Playwright MCP", 90, "ot"), ("Chrome DevTools MCP", 137, "ot")]),
        ("click", [("monad CLI", 31, "grad"), ("monad MCP", 33, "h2"), ("agent-browser", 24, "ot"), ("Playwright CLI", 850, "ot"), ("Playwright MCP", 536, "ot"), ("Chrome DevTools MCP", 237, "ot")]),
        ("snapshot HN", [("monad CLI", 123, "grad"), ("monad MCP", 112, "h2"), ("agent-browser", 107, "ot"), ("Playwright CLI", 425, "ot"), ("Playwright MCP", 55, "ot"), ("Chrome DevTools MCP", 71, "ot")]),
        ("snapshot Wikipedia", [("monad CLI", 900, "grad"), ("monad MCP", 959, "h2"), ("agent-browser", 760, "ot"), ("Playwright CLI", 961, "ot"), ("Playwright MCP", 382, "ot"), ("Chrome DevTools MCP", 559, "ot")]),
    ]
    cols, pw, ph, gapx, gapy = 2, 424, 206, 16, 14
    W = 28 + cols * pw + (cols - 1) * gapx + 28
    rowsn = (len(panels) + cols - 1) // cols
    H = 88 + rowsn * ph + (rowsn - 1) * gapy + 48
    s = head(W, H)
    s += title(28, 36, "Warm latency — ms, median (lower is better)",
               "same Chromium 154, same proxy, back to back. Differences under ~20% are noise on one machine.")
    for pi, (ptitle, rows) in enumerate(panels):
        px = 28 + (pi % cols) * (pw + gapx)
        py = 78 + (pi // cols) * (ph + gapy)
        s += f'<rect x="{px}" y="{py}" width="{pw}" height="{ph}" rx="12" class="tr"/>'
        s += f'<text x="{px+16}" y="{py+26}" class="fg" font-size="14" font-weight="700">{esc(ptitle)}</text>'
        mx = max(r[1] for r in rows)
        lbl_w, val_w = 146, 52
        bar_x = px + lbl_w
        plot = pw - lbl_w - val_w
        bh, bg = 15, 10
        for i, (name, val, cls) in enumerate(rows):
            y = py + 46 + i * (bh + bg)
            w = plot * val / mx
            s += f'<text x="{px+14}" y="{y+bh-3}" class="mu" font-size="12">{esc(name)}</text>'
            if cls == "grad":
                s += f'<rect x="{bar_x}" y="{y}" width="{w:.1f}" height="{bh}" rx="4" fill="url(#grad)"/>'
            elif cls == "h2":
                s += hbar(bar_x, y, w, bh, 4, "h2")
            else:
                s += hbar(bar_x, y, w, bh, 4, "ot")
            s += f'<text x="{bar_x+w+8}" y="{y+bh-3}" class="{"hi" if cls in ("grad","h2") else "mu"}" font-size="12" font-weight="600">{val}</text>'
    s += f'<text x="28" y="{H-14}" class="fa" font-size="12">Cold start (first-ever launch) is ~1.1–1.5 s for every tool except Chrome DevTools MCP (~6 s); after that the daemon keeps Chrome warm.</text>'
    write("bench-latency.svg", s)


# ---------------------------------------------------------------- MCP schema cost
def chart_mcp():
    rows = [
        ("monad MCP", "761", 761, "grad", "10 tools"),
        ("Playwright MCP", "3.7k", 3700, "ot", "25 tools"),
        ("Chrome DevTools MCP", "5.5k", 5500, "ot", "30 tools"),
    ]
    W, top, left, right = 880, 84, 210, 110
    bh, gap = 34, 16
    H = top + len(rows) * (bh + gap) + 34
    mx = max(r[2] for r in rows)
    plot_w = W - left - right
    s = head(W, H)
    s += title(28, 36, "MCP tool-definition cost", "schema tokens loaded into every request")
    for i, (name, label, val, cls, tools) in enumerate(rows):
        y = top + i * (bh + gap)
        s += hbar(left, y, plot_w, bh, 7, "tr")
        w = plot_w * val / mx
        s += (f'<rect x="{left}" y="{y}" width="{w:.1f}" height="{bh}" rx="7" fill="url(#grad)"/>'
              if cls == "grad" else hbar(left, y, w, bh, 7, cls))
        s += f'<text x="{left-14}" y="{y+bh/2+5}" text-anchor="end" class="fg" font-size="14" font-weight="{700 if cls=="grad" else 500}">{esc(name)}</text>'
        s += f'<text x="{left+w+12}" y="{y+bh/2+5}" class="{"hi" if cls=="grad" else "mu"}" font-size="14" font-weight="600">{esc(label)}</text>'
        s += f'<text x="{left+w+12}" y="{y+bh/2+22}" class="fa" font-size="11">{esc(tools)}</text>'
    s += f'<text x="{left}" y="{H-10}" class="fa" font-size="12">4.9×–7.2× less context than the Playwright / Chrome DevTools MCP servers.</text>'
    write("bench-mcp.svg", s)


# ---------------------------------------------------------------- retention grouped
def chart_retention():
    pages = ["HN", "books", "MDN", "Wikipedia"]
    series = [
        ("monad default", [99, 96, 100, 95], "grad"),
        ("agent-browser full", [100, 96, 96, 95], "ot"),
        ("agent-browser -i", [99, 33, 28, 40], "am"),
    ]
    W = 880
    top, bottom = 108, 76
    left, right = 96, 40
    H = top + 250 + bottom
    plot_h = 250
    plot_w = W - left - right
    s = head(W, H)
    s += title(28, 36, "Information retention — does the smaller snapshot lose content?",
               "share of visible paragraph / list / cell / heading texts found in the snapshot (higher is better)")
    # grid
    for g in range(0, 101, 25):
        y = top + plot_h - plot_h * g / 100
        s += f'<line x1="{left}" y1="{y:.1f}" x2="{left+plot_w}" y2="{y:.1f}" class="gr" stroke-width="1" stroke-dasharray="{"" if g in (0,100) else "3 4"}"/>'
        s += f'<text x="{left-12}" y="{y+4:.1f}" text-anchor="end" class="fa" font-size="11">{g}%</text>'
    n = len(pages)
    group_w = plot_w / n
    bw = 30
    inner = 16
    for gi, page in enumerate(pages):
        gx = left + gi * group_w
        s += f'<text x="{gx+group_w/2:.1f}" y="{top+plot_h+24}" text-anchor="middle" class="fg" font-size="13" font-weight="600">{esc(page)}</text>'
        total_w = len(series) * bw + (len(series) - 1) * inner
        sx = gx + (group_w - total_w) / 2
        for si, (name, vals, cls) in enumerate(series):
            v = vals[gi]
            h = plot_h * v / 100
            x = sx + si * (bw + inner)
            y = top + plot_h - h
            if cls == "grad":
                s += f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw}" height="{h:.1f}" rx="5" fill="url(#grad)"/>'
            else:
                s += hbar(x, y, bw, h, 5, cls)
            s += f'<text x="{x+bw/2:.1f}" y="{y-7:.1f}" text-anchor="middle" class="{"hi" if cls=="grad" else "mu"}" font-size="11" font-weight="600">{v}</text>'
    # legend
    lx, ly = left, H - 30
    for name, _, cls in series:
        if cls == "grad":
            s += f'<rect x="{lx}" y="{ly-11}" width="14" height="14" rx="4" fill="url(#grad)"/>'
        else:
            s += hbar(lx, ly - 11, 14, 14, 4, cls)
        s += f'<text x="{lx+20}" y="{ly}" class="mu" font-size="13">{esc(name)}</text>'
        lx += 22 + len(name) * 7.4
    write("bench-retention.svg", s)


# ---------------------------------------------------------------- agent task tokens
def chart_agent():
    rows = [
        ("monad CLI", "45k", 45000, "grad", "12 calls"),
        ("agent-browser", "28k", 28000, "ot", "24 calls"),
        ("monad MCP", "76k", 76000, "h2", "12 calls"),
        ("Chrome DevTools MCP", "321k", 321000, "ot", "22 calls"),
        ("Playwright CLI", "363k", 363000, "ot", "23 calls"),
        ("Playwright MCP", "365k", 365000, "ot", "23 calls"),
    ]
    W, top, left, right = 880, 84, 210, 130
    bh, gap = 27, 13
    H = top + len(rows) * (bh + gap) + 40
    mx = max(r[2] for r in rows)
    plot_w = W - left - right
    s = head(W, H)
    s += title(28, 36, "Agent tasks — total tokens read", "form · HN comments · books pagination · wiki search  ·  lower is better")
    for i, (name, label, val, cls, calls) in enumerate(rows):
        y = top + i * (bh + gap)
        s += hbar(left, y, plot_w, bh, 6, "tr")
        w = plot_w * val / mx
        if cls == "grad":
            s += f'<rect x="{left}" y="{y}" width="{w:.1f}" height="{bh}" rx="6" fill="url(#grad)"/>'
        elif cls == "h2":
            s += hbar(left, y, w, bh, 6, "h2")
        else:
            s += hbar(left, y, w, bh, 6, cls)
        s += f'<text x="{left-14}" y="{y+bh/2+5}" text-anchor="end" class="fg" font-size="13" font-weight="{700 if cls=="grad" else 500}">{esc(name)}</text>'
        s += f'<text x="{left+w+12}" y="{y+bh/2+5}" class="{"hi" if cls in ("grad","h2") else "mu"}" font-size="13" font-weight="600">{esc(label)} <tspan class="fa" font-weight="400">· {esc(calls)}</tspan></text>'
    s += f'<text x="{left}" y="{H-12}" class="fa" font-size="12">monad trades fewer calls (12 vs 23–24) for more tokens on navigation tasks; agent-browser reads fewer tokens but takes ~2× the calls.</text>'
    write("bench-agent.svg", s)


if __name__ == "__main__":
    chart_snapshot()
    chart_interactive()
    chart_latency()
    chart_mcp()
    chart_retention()
    chart_agent()
