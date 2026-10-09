# Benchmark: monad-browser vs the field

Measured 2026-10-09. Every tool drove the **same Chromium 154 binary** (linux/arm64, headless) through the same local proxy, against the same pages, back to back.
Tokens are counted with `o200k_base` (js-tiktoken) on exactly the text an agent would read. Latencies are medians (n=3, clicks n=5) from one machine; treat differences under ~20% as noise.
Harness: [`bench/`](bench/) — `node bench.mjs <tool>`, `node scripts.mjs <tool>`, `node fidelity.mjs`, `node report.mjs`.

| Tool | Version | How it ran |
| --- | --- | --- |
| monad-browser | main | CLI (`mb`) and MCP (`mb mcp`) |
| agent-browser (Vercel) | 0.38.2 | CLI, Rust binary |
| Playwright CLI (Microsoft) | 0.1.22 | CLI |
| Playwright MCP (Microsoft) | 0.0.83 | MCP stdio |
| Chrome DevTools MCP (Google) | 1.10.1 | MCP stdio |
| dev-browser | 0.2.9 | script mode, `--connect` to our Chromium |
| ego lite (citrolabs) | main | **not runnable here**: needs the macOS ego browser (snapshots come from its closed engine). Docs/source comparison only. |

Pages: local form fixture, example.com, Hacker News, books.toscrape.com, MDN `<select>`, Wikipedia "Gaziantep".
(github.com was dropped: the sandbox proxy re-signs it; npmjs.com was dropped: Cloudflare challenge.)

## 1. Observation cost

Re-run after the fixes (commits 0ee9d34–e657e0f): monad and agent-browser rows are fresh; both now run as **native clients** (Go `mb`, Rust `agent-browser` binary), as a global install does. Playwright / Chrome DevTools / dev-browser rows are from the first run (those tools did not change). The sandbox was shared with other heavy jobs during the re-run, so absolute latencies are noisier than before.

### Snapshot size (o200k tokens, full page)

| Page | monad CLI | monad MCP | agent-browser | Playwright CLI | Playwright MCP | Chrome DevTools MCP |
| --- | --- | --- | --- | --- | --- | --- |
| form | 98 | 97 | 177 | 300 | 299 | 291 |
| example | 232 | 231 | 267 | 340 | 339 | 320 |
| hn | 2.4k | 2.4k | 7.0k | 14k | 14k | 13k |
| books | 2.5k | 2.5k | 5.4k | 8.7k | 8.7k | 8.3k |
| mdn | 12k | 12k | 25k | 43k | 43k | 36k |
| wiki | 31k | 30k | 72k | 118k | 118k | 143k |
| **Total** | **47k** | **47k** | **109k** | **184k** | **184k** | **202k** |

### Interactive-only snapshot (tokens)

| Page | monad -i | agent-browser -i |
| --- | --- | --- |
| form | 78 | 128 |
| example | 18 | 11 |
| hn | 1.8k | 4.7k |
| books | 926 | 2.0k |
| mdn | 3.9k | 11k |
| wiki | 10k | 25k |
| **Total** | **17k** | **43k** |

### Latency (ms, warm, median)

| Tool | Cold start | open (local) | click | snapshot HN | snapshot Wikipedia |
| --- | --- | --- | --- | --- | --- |
| monad CLI | 1344 | 87 | 31 | 123 | 900 |
| monad MCP | 1126 | 59 | 33 | 112 | 959 |
| agent-browser | 1234 | 73 | 24 | 107 | 760 |
| Playwright CLI | 1479 | 383 | 850 | 425 | 961 |
| Playwright MCP | 1149 | 90 | 536 | 55 | 382 |
| Chrome DevTools MCP | 6056 | 137 | 237 | 71 | 559 |
### Agent tasks, step by step (success · tool calls · tokens read · wall ms)

| Tool | form | hn-comments | books-paginate | wiki-search | Total tokens | Total calls |
| --- | --- | --- | --- | --- | --- | --- |
| monad CLI | ✓ 5 · 357 · 233 | ✓ 2 · 37k · 2261 | ✓ 3 · 7.1k · 1312 | ✗ 2 · 708 · 1700 | 45k | 12 |
| monad MCP | ✓ 5 · 353 · 204 | ✓ 2 · 37k · 2171 | ✓ 3 · 7.1k · 1287 | ✓ 2 · 31k · 3438 | 76k | 12 |
| agent-browser | ✓ 8 · 518 · 220 | ✓ 4 · 21k · 1210 | ✓ 7 · 5.5k · 941 | ✗ 5 · 419 · 1059 | 28k | 24 |
| Playwright CLI | ✓ 9 · 1.4k · 2842 | ✓ 4 · 218k · 3154 | ✓ 6 · 24k · 3672 | ✓ 4 · 119k · 3532 | 363k | 23 |
| Playwright MCP | ✓ 9 · 1.4k · 1227 | ✓ 4 · 220k · 2064 | ✓ 6 · 24k · 1894 | ✓ 4 · 119k · 2173 | 365k | 23 |
| Chrome DevTools MCP | ✓ 7 · 673 · 1066 | ✓ 4 · 152k · 1474 | ✓ 6 · 23k · 1549 | ✓ 5 · 145k · 3054 | 321k | 22 |
### Script mode, whole task in one call (success · ms · tokens in/out)

| Tool | form | books-paginate |
| --- | --- | --- |
| monad CLI | ✓ 295 · 50/7 | ✓ 613 · 65/68 |
| agent-browser | ✓ 318 · 41/39 | ✓ 437 · 65/101 |
| Playwright CLI | ✓ 1128 · 63/89 | ✓ 1254 · 74/197 |
| Playwright MCP | ✓ 663 · 65/90 | ✓ 852 · 76/199 |
| dev-browser | ✓ 361 · 69/7 | ✓ 611 · 83/68 |
### MCP tool-definition cost (tokens loaded into every request)

| Server | Tools | Schema tokens |
| --- | --- | --- |
| monad MCP | 10 | 761 |
| Playwright MCP | 25 | 3.7k |
| Chrome DevTools MCP | 30 | 5.5k |

### Snapshot cap

The default cap is now 2000 lines (was 400), so real pages are no longer cut: Wikipedia is 701 lines, MDN 800. Default and uncapped snapshots are the same size on every test page (total 47k vs agent-browser 109k, Playwright 184k).

### Information retention (does the smaller snapshot lose content?)

Share of the page's visible paragraph/list/cell/heading texts (≥25 chars, first 40 chars, format-neutral match) found in the snapshot:

| Page | probes | monad default | monad uncapped | agent-browser full | agent-browser -i |
| --- | --- | --- | --- | --- | --- |
| hn | 69 | 99% | 99% | 100% | 99% |
| books | 27 | 96% | 96% | 96% | 33% |
| mdn | 71 | 100% | 100% | 96% | 28% |
| wiki | 367 | 95% | 95% | 95% | 40% |

monad now keeps the same content as agent-browser by default (Wikipedia 47% → 95%) at less than half the tokens.

## 2. Feature comparison

| | monad-browser | agent-browser | Playwright MCP / CLI | Chrome DevTools MCP | dev-browser | ego lite | browser-use CLI 3.0 | Stagehand v3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Runtime | Node ≥22 daemon + native Go client | Rust binary | Node, Playwright | Node, Puppeteer | Rust CLI + QuickJS sandbox, Playwright daemon | macOS app (custom Chromium) + Node helpers | Python 3.11+ | TS (Python/Go SDKs) |
| Browser link | raw CDP | CDP | Playwright protocol | CDP | Playwright over CDP | in-browser `ego` runtime | CDP harness | CDP ("Understudy") |
| Linux / headless / Docker | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ (macOS; Windows beta) | ✓ | ✓ (+ Browserbase cloud) |
| Agent interface | CLI + MCP + JS batch (`run`) | CLI + `batch` | MCP tools / CLI + `run-code` | MCP tools | JS scripts only | JS scripts only | Python exec (CLI/MCP) | SDK; MCP via Browserbase |
| Needs an LLM inside the tool | no | no | no | no | no | no | no (library agent: yes) | yes (act/extract/observe) |
| Refs | `@N`, self-healing by role/name | `@eN` | `eN` / `fNeN` | `uid` | Playwright locators | SDK refs; stale ref ⇒ re-snapshot | indices / CDP | natural language |
| Inline compact rows | ✓ | – | – | – | – | – | – | – |
| Snapshot diff | ✓ (`-d`, action `-s`) | ✓ (`diff snapshot`) | – | – | – | partial snapshots | – | – |
| Action returns page state | ✓ (diff) | ✗ (`✓ Done`) | ✓ (written to a .yml file) | opt-in `includeSnapshot` | – | – | – | – |
| iframes in snapshot | ✓ (same-origin + out-of-process, refs work inside) | – | ✓ (frame refs) | – | ✓ | ✓ (headline feature) | – | ✓ (`deepLocator`) |
| Save / load auth state | ✓ | ✓ | ✓ | isolated contexts | via browser profile | real Chrome profile | real Chrome profile | Browserbase contexts |
| Parallel isolated sessions | ✓ (`--session`) | ✓ | ✓ | ✓ | named browsers | ✓ (Spaces) | ✓ | ✓ |
| MCP schema tokens | 761 (10 tools) | – | 3.7k (25 tools) | 5.5k (30 tools) | – | – | 2 tools | 6 tools |
| Skill / instructions tokens | 581 | 714 stub (+8.2k full core) | 3.7k (CLI skill) | – | – | 4.5k SKILL + 4.2k API | – | – |
| License | MIT | Apache-2.0 | Apache-2.0 | Apache-2.0 | – | MIT (helpers; browser is a free closed download) | MIT | MIT |

ego lite publishes its own benchmark claiming up to 2.5× faster than agent-browser on four complex tasks. It is self-reported and could not be reproduced on Linux.

## 3. Findings fixed during this run

- **iframes**: snapshots descend into same-process and out-of-process (cross-site) iframes; refs, clicks and fills work inside them, with frame offsets applied.
- **CLI start-up**: native Go thin client (one unix-socket round trip, ~6 ms vs ~55 ms with Node); Node path also got compile cache, lazy imports and no status pre-check.
- **Action latency**: actionability is one in-page call; readiness is DOMContentLoaded + load-or-50 ms-quiet (cap 1 s), not full network idle. Click-with-navigation ~260 → ~165 ms.
- **Hydration races**: pre-action quiet window, `fill` verifies and refills, ref healing across textbox/searchbox/combobox, `fill --submit` falls back to `form.requestSubmit()`.
- **Diff baseline** reset on navigation (an `open` could return "no changes" with stale refs).

- **Leaked in-flight requests** (fixed): requests cut off by a navigation never sent `loadingFinished`, so after visiting MDN every later action waited the full 3 s settle timeout (form task 12 s → 0.6 s).
- **Settle tuned** (fixed): only Document/Script/XHR/Fetch/Stylesheet traffic gates settling, traffic from before the action needs no quiet window, `goto` waits 50 ms of quiet instead of 250 ms. Scripted form task 583 → 300 ms.
- **Proxy bypass** (fixed): `<-loopback>` had been sending localhost through the upstream proxy.

## 4. Where monad still loses

- **Click latency**: 31 ms vs agent-browser 24 ms (CLI). monad waits one tick to catch navigations and returns a diff; agent-browser returns `✓ Done` immediately.
- **Multi-navigation scripts**: `run` books task 613 ms vs agent-browser `batch` 437 ms (was 725 ms).
- **Fewer calls, more tokens on navigation tasks**: actions return the new page, so hn/wiki tasks read more tokens than agent-browser, which re-snapshots only on demand; total calls 12 vs 24.
- **wiki-search is flaky for every tool** (Wikipedia's search box is swapped for a Codex combobox on focus): this run monad CLI and agent-browser failed it once, monad MCP passed.
