<div align="center">

<img src="assets/banner.svg" alt="monad-browser — headless, turnkey browser CLI for AI agents" width="100%"/>

**Headless, turnkey browser CLI for AI agents.**
Raw Chrome DevTools Protocol — no Playwright — a warm daemon, and compact accessibility
snapshots with stable `@N` refs.

[![status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)](#status--roadmap)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![browser](https://img.shields.io/badge/browser-raw%20CDP-6366f1?style=flat-square)](#how-it-works)
[![mcp](https://img.shields.io/badge/MCP-10%20lean%20tools-8b5cf6?style=flat-square)](#mcp-server)

[Quick start](#quick-start) · [Why](#why-monad-browser) · [Benchmarks](#benchmarks) · [How it works](#how-it-works) ·
[Commands](#command-reference) · [MCP](#mcp-server) · [Agent skill](#agent-skill) · [Screenshots](#screenshots)

</div>

---

`mb` drives a real headless Chrome from the shell. One command opens a page and returns a compact
accessibility snapshot in which every interactive element has a short, stable reference. The agent
reads the refs, acts on them, and gets back only what changed.

```sh
mb open news.ycombinator.com
mb snapshot -i          # interactive elements only, each with an @ref
mb click @17 -s         # click, then print a fresh (diff) snapshot
mb fill @3 "hello"
mb press Enter
mb eval 'return [...document.links].length'
mb screenshot page.png --full
mb stop
```

The first command launches Chrome and a per-session daemon; every command after that is a single
unix-socket round trip, so a warm `mb` call costs roughly 40 ms.

## Quick start

```sh
git clone https://github.com/batuhanozkose/monad-browser
cd monad-browser
npm install            # installs the two build-time dev dependencies
npm run build          # tsc -> dist/
npm link               # optional: put `mb` on your PATH
```

> Chrome or Chromium must be installed. `mb` finds the usual locations; point it elsewhere with
> `MONAD_CHROME=/path/to/chrome`. A published npm package (`npm i -g monad-browser`) is on the
> roadmap; until then the source install above is the way in. `npm run build:native` is optional —
> it compiles the Go thin client for a faster hot path.

A real session — open Hacker News, list the interactive elements, follow one story:

<p align="center"><img src="assets/terminal-quickstart.svg" alt="mb open, mb snapshot -i, mb click @17 -s" width="100%"/></p>

Three concepts are doing the work here:

- **`-i`** keeps only interactive nodes, so a news front page is a handful of lines, not a wall.
- **`@N` refs** are assigned by the snapshot and stay stable for the lifetime of the element. After a
  re-render they self-heal by role + accessible name, so a stale `@17` still lands on the same story.
- **`-s`** on an action returns the page *diff* instead of the whole page — the exact lines that
  changed, under their parent, with the refs already updated. (On a navigation there is no baseline
  left to diff against, so you get a fresh full snapshot.)

## Why monad-browser

- **Fewer tokens, same content.** The snapshot merges the accessibility tree with `DOMSnapshot`
  layout and collapses rows, list items and paragraphs onto one line with inline refs. Across the
  benchmark's six pages that is **47k tokens vs 109k for agent-browser and 184k for Playwright /
  Chrome DevTools MCP** — at **95–100 % information retention** ([chart](#benchmarks)).
- **One turn, not twenty calls.** `mb run` executes a whole multi-step plan in a single call and
  returns only what you `log()` or `return`.
- **Actions that wait.** Every action waits until the target is attached, visible, stable, enabled
  and not covered. If a cookie banner or modal is over it, the error names the cover instead of
  clicking the wrong thing.
- **A warm browser.** A daemon keeps Chrome alive between commands (default idle 30 min), and a
  native Go thin client skips Node start-up on the hot path.
- **No LLM in the loop.** `mb` is a deterministic tool; your agent decides, `mb` executes.
- **Both interfaces, one browser.** The CLI and the MCP server share the same warm session, so an
  agent can mix `browser_run` tool calls with shell `mb` commands on one tab.
- **Zero runtime dependencies.** Only the Node standard library, plus an optional native client
  compiled from the Go source in [`native/`](native/).

**Also included**

- Diff snapshots (`snapshot -d`, or `-s` on any action) with an exact Myers line diff.
- Same-process **and out-of-process (cross-site) iframes** in the snapshot, with working refs,
  clicks and fills inside them.
- Sessions (`--session`), saved auth state (`state save/load`), tabs, console capture.
- Optional **snapshot cache** (`mb snapshot --cache`, `--cache-ms N`, `MONAD_SNAPSHOT_CACHE_MS`):
  reuse the last snapshot while the page is unchanged, guarded by a MutationObserver version;
  off by default.
- Proxies with credentials via a local relay that injects `Proxy-Authorization`.
- Resource blocking (`--block image,font,media`) to make pages cheaper.
- Attach to an existing Chrome (`--cdp <ws|port>`) or run headful (`--headful`).

## Benchmarks

Measured 2026-10-09. Every tool drove the **same Chromium 154 binary** through the same proxy,
against the same pages, back to back. Tokens are counted with `o200k_base` on exactly the text an
agent would read; latencies are medians (n=3, clicks n=5). Full method, per-page numbers and the
harness live in **[BENCHMARK.md](BENCHMARK.md)** and [`bench/`](bench/).

<p align="center"><img src="assets/bench-snapshot.svg" alt="Full-page snapshot token cost" width="100%"/></p>

<table>
<tr>
<td width="50%"><img src="assets/bench-interactive.svg" alt="Interactive-only snapshot token cost" width="100%"/></td>
<td width="50%"><img src="assets/bench-mcp.svg" alt="MCP tool-definition schema tokens" width="100%"/></td>
</tr>
</table>

| Page | monad CLI | monad MCP | agent-browser | Playwright CLI | Playwright MCP | Chrome DevTools MCP |
| --- | --- | --- | --- | --- | --- | --- |
| form | 98 | 97 | 177 | 300 | 299 | 291 |
| example | 232 | 231 | 267 | 340 | 339 | 320 |
| Hacker News | 2.4k | 2.4k | 7.0k | 14k | 14k | 13k |
| books | 2.5k | 2.5k | 5.4k | 8.7k | 8.7k | 8.3k |
| MDN `<select>` | 12k | 12k | 25k | 43k | 43k | 36k |
| Wikipedia | 31k | 30k | 72k | 118k | 118k | 143k |
| **Total** | **47k** | **47k** | **109k** | **184k** | **184k** | **202k** |

<p align="center"><img src="assets/bench-latency.svg" alt="Warm latency by operation" width="100%"/></p>

<p align="center"><img src="assets/bench-retention.svg" alt="Information retention" width="100%"/></p>

monad keeps the same content as agent-browser by default (Wikipedia 47 % → 95 %) at less than half
the tokens. Interactive-only snapshots fall to **17k** tokens (agent-browser `-i`: 43k), and the
whole MCP surface loads in **761 schema tokens** versus 3.7k / 5.5k.

### Whole-task cost

Four tasks, driven by an agent: fill a form · open HN comments · paginate books.toscrape ·
search Wikipedia. `tokens` is everything the agent read; `calls` is how many tool calls it took.

| Tool | tasks passed | total tokens | total calls |
| --- | --- | --- | --- |
| monad CLI | 3 / 4 | **45k** | **12** |
| monad MCP | 4 / 4 | 76k | 12 |
| agent-browser | 3 / 4 | 28k | 24 |
| Chrome DevTools MCP | 4 / 4 | 321k | 22 |
| Playwright CLI | 4 / 4 | 363k | 23 |
| Playwright MCP | 4 / 4 | 365k | 23 |

<p align="center"><img src="assets/bench-agent.svg" alt="Total tokens read per agent task" width="100%"/></p>

**Where monad still loses** — stated honestly: click latency is 31 ms vs agent-browser's 24 ms
(monad waits one tick to catch navigations and returns a diff; agent-browser returns `✓ Done`
immediately); multi-navigation `run` scripts are slower than `agent-browser batch` (613 vs 437 ms);
and because actions return the new page, navigation-heavy tasks read more tokens but need half the
calls.

## How it works

```mermaid
flowchart LR
    A["Agent<br/>shell · MCP client"] -->|"argv or JSON-RPC"| C["mb<br/>thin client"]
    C -->|"unix socket<br/>(pipe on Windows)"| D["session daemon<br/>keeps Chrome warm"]
    D --> B["browser core"]
    B -->|"raw CDP"| CH[("Chrome / Chromium")]
    B --> S["snapshot<br/>AX tree + DOMSnapshot"]
    S --> R["compact rows + stable @N refs"]
    R --> A
```

A click is a single round trip and the reply is only what changed:

```mermaid
sequenceDiagram
    participant Ag as Agent
    participant Mb as mb
    participant D as Daemon
    participant P as Page
    Ag->>Mb: mb click @17 -s
    Mb->>D: click @17
    D->>P: resolve ref → scroll → hit-test → click
    P-->>D: navigation or mutation
    D->>D: diff against last snapshot
    D-->>Mb: changed lines only
    Mb-->>Ag: only what changed, refs updated
```

- **Thin client.** On Linux/macOS a small Go binary ([`native/`](native/)) forwards the command over
  a unix socket — one round trip, no Node start-up (~6 ms vs ~55 ms). Everything else (starting the
  daemon, `mcp`, `install-skill`, help, Windows) falls back to Node.
- **Daemon.** Starts Chrome on first use, keeps one browser per session, exits after
  `MONAD_IDLE_MINUTES` (default 30) of inactivity.
- **Snapshot.** Accessibility tree merged with `DOMSnapshot` layout; hidden nodes are dropped;
  `cursor:pointer` elements without an ARIA role appear as `clickable`. Long rows collapse to one
  line with inline refs. Refs are stable and self-heal by role + name.
- **Readiness.** `DOMContentLoaded` then `load` (or 50 ms of quiet), capped at 1 s — not full
  network idle — plus a short pre-action hydration grace (`MONAD_PRE_ACTION_QUIET_MS`, default 500).
- **Actionability.** One in-page call checks attached + visible + stable + enabled + hit-test; the
  click itself is hit-tested so a covering element produces an error that names it.

## One-turn plans with `mb run`

For anything beyond a couple of steps, `run` sends the whole plan in one call. The script executes
in the daemon against the current tab; **only what you `log()` or `return` comes back**.

<p align="center"><img src="assets/terminal-run.svg" alt="mb run executing a pagination loop in one call" width="100%"/></p>

```sh
mb run '
  await goto("books.toscrape.com");
  const titles = [];
  for (let i = 0; i < 3; i++) {
    titles.push(...await js("[...document.querySelectorAll(\"h3 a\")].map(a => a.title)"));
    await click("text=next");
  }
  return titles.length;
'
```

Also `mb run --file plan.js` or pipe a script with `mb run -`.

**API inside `run`:**
`goto` `open` `click` `dblclick` `fill` `type` `press` `select` `hover` `scroll` `text` `js`
`snapshot` `exists` `wait(ms|target)` `waitForText` `waitForIdle` `screenshot` `back` `reload`
`cdp` `tabs` `url` `title` `log` `sleep` `readFile`.

> `run` scripts are **trusted, not sandboxed** — they execute in the daemon process (Node `vm`).
> It is a convenience wrapper, not a security boundary.

## Diff snapshots

Stable refs make the diff exact. `-s` on any action prints only the changed lines, under their
parent; `mb snapshot -d` does the same on demand.

<p align="center"><img src="assets/terminal-diff.svg" alt="diff snapshots for a click and a fill" width="60%"/></p>

## Targets and auto-wait

A target can be any of:

| Form | Example | Notes |
| --- | --- | --- |
| Ref | `@12` | from the latest snapshot; stable, self-heals by role + name |
| Text | `text=Sign in` | visible text match |
| Role | `role=button:Submit` | ARIA role (+ accessible name) |
| CSS | `#email` | standard CSS selector |

Selectors resolve in the **top document**. To act inside an iframe, take a snapshot and use the
`@N` refs it prints there — refs, clicks and fills reach into same-process and out-of-process
frames. Actions auto-wait until the element is actionable; a covering element is named in the error.

## Command reference

| Command | What it does |
| --- | --- |
| `open <url> [-s] [-i]` | navigate the current tab (alias `goto`, `navigate`) |
| `snapshot [-i] [-d] [--max-lines N]` | accessibility snapshot with `@N` refs (`-i` interactive only, `-d` only changes) |
| `click <target> [--button right] [--count 2] [-s]` | click, auto-waiting |
| `fill <target> <text> [--submit] [-s]` | clear and type; `--submit` presses Enter |
| `type <text> [--into @ref]` | insert text into the focused element |
| `press <key>` | `Enter`, `Tab`, `Escape`, `Control+a`, `Shift+Tab`, … |
| `select <target> <value...>` | choose `<select>` option(s) by value or label |
| `hover` · `scroll [dir] [px] [--on @ref]` | pointer / viewport |
| `eval <js>` | evaluate in the page (top-level `await`/`return` allowed) |
| `text [target] [--max N]` | visible text of the page or an element |
| `screenshot [path] [--full] [--on @ref] [--jpeg]` | PNG/JPEG of the viewport or full page |
| `back` · `forward` · `reload` | history & reload |
| `wait <ms\|selector\|--idle\|--text T>` | time, element, network idle, or text |
| `state save <file>` · `state load <file>` | cookies + storage (log in once, reuse everywhere) |
| `tabs` · `tab <n> \| tab new [url] \| tab close [n]` | tab management |
| `console` | recent page errors/warnings |
| `block <image,font,media,stylesheet\|none>` | block resource types for new tabs |
| `url` · `cdp <Domain.method> [json]` | current title/url · raw CDP on the current tab |
| `run '<js>' \| run --file f.js \| run -` | one-turn multi-step plan |
| `mcp` | run as an MCP server over stdio |
| `install-skill [--project \| --dir D \| --print]` | write `SKILL.md` for coding agents |
| `start` · `stop [--all]` · `status` · `sessions` | daemon lifecycle |

Global options come before the command:

```sh
mb --session work open x.com      # isolated browser per session
mb --headful open x.com           # visible window
mb --cdp 9222 open x.com          # attach to an existing Chrome
mb --profile ./chrome-data open x.com   # persistent profile
mb --block image,font open x.com  # block resources
```

## MCP server

`mb mcp` speaks MCP over stdio and forwards to the **same warm browser** the CLI uses. Ten lean
tools: `browser_run`, `browser_open`, `browser_snapshot`, `browser_click`, `browser_fill`,
`browser_press`, `browser_select`, `browser_text`, `browser_screenshot`, `browser_command`.

```sh
claude mcp add monad-browser -- mb mcp
```

```jsonc
// or any MCP client config
{ "mcpServers": { "monad-browser": { "command": "mb", "args": ["mcp"] } } }
```

The whole schema costs ~761 tokens loaded into every request — 4.9×–7.2× less than the Playwright
and Chrome DevTools MCP servers.

## Agent skill

`mb install-skill` writes a `SKILL.md` teaching a coding agent (Claude Code, Codex, OpenCode, …) to
use the CLI well.

```sh
mb install-skill              # ~/.claude/skills + ~/.agents/skills
mb install-skill --project    # .claude/skills + .agents/skills in this repo
mb install-skill --dir ./x    # anywhere
mb install-skill --print      # stdout
```

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `MONAD_CHROME` | auto-detected | path to the browser executable |
| `MONAD_NO_SANDBOX` | – | set to `1` to pass `--no-sandbox` (containers, root) |
| `MONAD_IDLE_MINUTES` | `30` | shut the daemon down after this long idle |
| `MONAD_HOME` | `~/.monad-browser` | state directory (sockets, pids) |
| `MONAD_SESSION` | `default` | session name when `--session` is not given |
| `MONAD_PRE_ACTION_QUIET_MS` | `500` | hydration grace before an action; set `0` on very chatty pages |
| `MONAD_SNAPSHOT_CACHE_MS` | `0` | reuse a snapshot for this long while the page is unchanged (off) |

## Screenshots

A page opened and captured with `mb open` + `mb screenshot`:

<table>
<tr>
<td width="50%"><img src="assets/screenshot-books.png" alt="books.toscrape.com driven by monad-browser" width="100%"/></td>
<td width="50%"><img src="assets/screenshot-hn.png" alt="news.ycombinator.com driven by monad-browser" width="100%"/></td>
</tr>
<tr>
<td align="center"><code>mb open books.toscrape.com</code> · <code>mb screenshot</code></td>
<td align="center"><code>mb open news.ycombinator.com</code> · <code>mb screenshot</code></td>
</tr>
</table>

## Limitations

- **Selectors search the top document, then frames.** `text=`, `role=` and CSS resolve in the main
  document first, then in same-process and out-of-process iframes (a top-document match wins an
  ambiguous one). `@N` refs remain the fastest and most precise target.
- **`run` scripts are trusted, not sandboxed.** See the note above.
- **Snapshot cost scales with page size.** The accessibility tree and layout are rebuilt on every
  snapshot (Wikipedia ≈ 0.9 s). Prefer `-i` and diff snapshots on large pages.
- **Windows** works, but without the native thin client (Node start-up per command).

## Development

```sh
npm run typecheck      # tsc --noEmit
npm run build          # tsc -p tsconfig.json  -> dist/
npm run build:native   # cross-compile the Go client into bin/native/
npm test               # build + unit & e2e tests (node --test)
```

CI runs typecheck, build, unit + e2e tests on Node 22 and `go vet` + `go build` for the native
client ([.github/workflows/ci.yml](.github/workflows/ci.yml)). The benchmark harness is in
[`bench/`](bench/) (`node bench.mjs <tool>`, `node scripts.mjs <tool>`, `node fidelity.mjs`,
`node report.mjs`).

## Status & roadmap

**Alpha.** Done: daemon, CDP core, snapshot (incl. iframes), `run`, auto-wait, diff snapshots,
sessions/auth state, MCP server, agent skill, benchmarks. Next: Docker / E2B packaging, published
npm package, a Windows native client.

## License

[MIT](LICENSE) © Batuhan Özköse. See [NOTICE](NOTICE) — `monad-browser` ships no third-party runtime
dependencies and is not affiliated with Google, Microsoft, Vercel or any project named in the
benchmarks.
