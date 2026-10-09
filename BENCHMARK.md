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

### Snapshot size (o200k tokens, full page)

| Page | monad CLI | monad MCP | agent-browser | Playwright CLI | Playwright MCP | Chrome DevTools MCP |
| --- | --- | --- | --- | --- | --- | --- |
| form | 98 | 97 | 177 | 300 | 299 | 291 |
| example | 232 | 231 | 267 | 340 | 339 | 320 |
| hn | 2.3k | 2.3k | 7.0k | 14k | 14k | 13k |
| books | 2.5k | 2.5k | 5.4k | 8.7k | 8.7k | 8.3k |
| mdn | 4.6k | 4.6k | 25k | 43k | 43k | 36k |
| wiki | 16k | 16k | 72k | 118k | 118k | 143k |
| **Total** | **26k** | **26k** | **109k** | **184k** | **184k** | **202k** |

### Interactive-only snapshot (tokens)

| Page | monad -i | agent-browser -i |
| --- | --- | --- |
| form | 78 | 128 |
| example | 18 | 11 |
| hn | 1.8k | 4.7k |
| books | 926 | 2.0k |
| mdn | 3.7k | 11k |
| wiki | 10k | 25k |
| **Total** | **17k** | **43k** |

### Latency (ms, warm, median)

| Tool | Cold start | open (local) | click | snapshot HN | snapshot Wikipedia |
| --- | --- | --- | --- | --- | --- |
| monad CLI | 923 | 141 | 98 | 123 | 686 |
| monad MCP | 919 | 105 | 54 | 75 | 623 |
| agent-browser | 1964 | 254 | 77 | 112 | 835 |
| Playwright CLI | 1479 | 383 | 850 | 425 | 961 |
| Playwright MCP | 1149 | 90 | 536 | 55 | 382 |
| Chrome DevTools MCP | 6056 | 137 | 237 | 71 | 559 |
### Agent tasks, step by step (success · tool calls · tokens read · wall ms)

| Tool | form | hn-comments | books-paginate | wiki-search | Total tokens | Total calls |
| --- | --- | --- | --- | --- | --- | --- |
| monad CLI | ✓ 6 · 418 · 591 | ✓ 2 · 34k · 1800 | ✓ 3 · 7.1k · 1864 | ✓ 2 · 18k · 2699 | 60k | 13 |
| monad MCP | ✓ 6 · 413 · 226 | ✓ 2 · 34k · 1502 | ✓ 3 · 7.1k · 1298 | ✓ 2 · 18k · 2533 | 60k | 13 |
| agent-browser | ✓ 8 · 488 · 544 | ✓ 4 · 40k · 1582 | ✓ 6 · 5.5k · 1578 | ✓ 5 · 16k · 2291 | 62k | 23 |
| Playwright CLI | ✓ 9 · 1.4k · 2842 | ✓ 4 · 218k · 3154 | ✓ 6 · 24k · 3672 | ✓ 4 · 119k · 3532 | 363k | 23 |
| Playwright MCP | ✓ 9 · 1.4k · 1227 | ✓ 4 · 220k · 2064 | ✓ 6 · 24k · 1894 | ✓ 4 · 119k · 2173 | 365k | 23 |
| Chrome DevTools MCP | ✓ 7 · 673 · 1066 | ✓ 4 · 152k · 1474 | ✓ 6 · 23k · 1549 | ✓ 5 · 145k · 3054 | 321k | 22 |
### Script mode, whole task in one call (success · ms · tokens in/out)

| Tool | form | books-paginate |
| --- | --- | --- |
| monad CLI | ✓ 300 · 50/7 | ✓ 725 · 65/68 |
| agent-browser | ✓ 385 · 41/39 | ✓ 435 · 65/101 |
| Playwright CLI | ✓ 1128 · 63/89 | ✓ 1254 · 74/197 |
| Playwright MCP | ✓ 663 · 65/90 | ✓ 852 · 76/199 |
| dev-browser | ✓ 361 · 69/7 | ✓ 611 · 83/68 |
### MCP tool-definition cost (tokens loaded into every request)

| Server | Tools | Schema tokens |
| --- | --- | --- |
| monad MCP | 10 | 761 |
| Playwright MCP | 25 | 3.7k |
| Chrome DevTools MCP | 30 | 5.5k |

### monad without its 400-line cap (`--max-lines 1e6 --max-text 1e6`)

The default monad snapshot stops at 400 lines and says so (`… N more lines`). Uncapped, it is still 2.1–3× smaller than agent-browser and 3.6–4.7× smaller than Playwright:

| Page | monad uncapped | agent-browser | Playwright MCP | Chrome DevTools MCP |
| --- | --- | --- | --- | --- |
| hn | 2.3k | 7.0k | 14k | 13k |
| books | 2.5k | 5.4k | 8.7k | 8.3k |
| mdn | 11.6k | 25k | 43k | 36k |
| wiki | 30.8k | 72k | 118k | 143k |
| **Total (6 pages)** | **47.6k** | **109k** | **184k** | **202k** |

### Information retention (does the smaller snapshot lose content?)

Share of the page's visible paragraph/list/cell/heading texts (≥25 chars, first 40 chars, format-neutral match) found in the snapshot:

| Page | probes | monad default | monad uncapped | agent-browser full | agent-browser -i |
| --- | --- | --- | --- | --- | --- |
| hn | 66 | 98% | 98% | 100% | 98% |
| books | 27 | 96% | 96% | 96% | 33% |
| mdn | 71 | 76% | 100% | 96% | 28% |
| wiki | 367 | 47% | 95% | 95% | 41% |

Uncapped monad keeps the same content as agent-browser at less than half the tokens. The default cap trades content for tokens on long articles (Wikipedia 47%), so agents reading prose should use `text` or `--max-lines`.

## 2. Feature comparison

| | monad-browser | agent-browser | Playwright MCP / CLI | Chrome DevTools MCP | dev-browser | ego lite | browser-use CLI 3.0 | Stagehand v3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Runtime | Node ≥22, TS | Rust binary | Node, Playwright | Node, Puppeteer | Rust CLI + QuickJS sandbox, Playwright daemon | macOS app (custom Chromium) + Node helpers | Python 3.11+ | TS (Python/Go SDKs) |
| Browser link | raw CDP | CDP | Playwright protocol | CDP | Playwright over CDP | in-browser `ego` runtime | CDP harness | CDP ("Understudy") |
| Linux / headless / Docker | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ (macOS; Windows beta) | ✓ | ✓ (+ Browserbase cloud) |
| Agent interface | CLI + MCP + JS batch (`run`) | CLI + `batch` | MCP tools / CLI + `run-code` | MCP tools | JS scripts only | JS scripts only | Python exec (CLI/MCP) | SDK; MCP via Browserbase |
| Needs an LLM inside the tool | no | no | no | no | no | no | no (library agent: yes) | yes (act/extract/observe) |
| Refs | `@N`, self-healing by role/name | `@eN` | `eN` / `fNeN` | `uid` | Playwright locators | SDK refs; stale ref ⇒ re-snapshot | indices / CDP | natural language |
| Inline compact rows | ✓ | – | – | – | – | – | – | – |
| Snapshot diff | ✓ (`-d`, action `-s`) | ✓ (`diff snapshot`) | – | – | – | partial snapshots | – | – |
| Action returns page state | ✓ (diff) | ✗ (`✓ Done`) | ✓ (written to a .yml file) | opt-in `includeSnapshot` | – | – | – | – |
| iframes in snapshot | ✗ (gap) | – | ✓ (frame refs) | – | ✓ | ✓ (headline feature) | – | ✓ (`deepLocator`) |
| Save / load auth state | ✓ | ✓ | ✓ | isolated contexts | via browser profile | real Chrome profile | real Chrome profile | Browserbase contexts |
| Parallel isolated sessions | ✓ (`--session`) | ✓ | ✓ | ✓ | named browsers | ✓ (Spaces) | ✓ | ✓ |
| MCP schema tokens | 761 (10 tools) | – | 3.7k (25 tools) | 5.5k (30 tools) | – | – | 2 tools | 6 tools |
| Skill / instructions tokens | 581 | 714 stub (+8.2k full core) | 3.7k (CLI skill) | – | – | 4.5k SKILL + 4.2k API | – | – |
| License | MIT | Apache-2.0 | Apache-2.0 | Apache-2.0 | – | MIT (helpers; browser is a free closed download) | MIT | MIT |

ego lite publishes its own benchmark claiming up to 2.5× faster than agent-browser on four complex tasks. It is self-reported and could not be reproduced on Linux.

## 3. Findings fixed during this run

- **Leaked in-flight requests** (fixed): requests cut off by a navigation never sent `loadingFinished`, so after visiting MDN every later action waited the full 3 s settle timeout (form task 12 s → 0.6 s).
- **Settle tuned** (fixed): only Document/Script/XHR/Fetch/Stylesheet traffic gates settling, traffic from before the action needs no quiet window, `goto` waits 50 ms of quiet instead of 250 ms. Scripted form task 583 → 300 ms.
- **Proxy bypass** (fixed): `<-loopback>` had been sending localhost through the upstream proxy.

## 4. Where monad still loses

- **Click latency through the CLI**: agent-browser's Rust client is ~20 ms faster per call (≈45 ms Node start-up per `mb` invocation). MCP mode avoids it (54 ms).
- **Multi-navigation scripts**: `run` books task 725 ms vs agent-browser `batch` 435 ms and dev-browser 611 ms. agent-browser waits only for `load`; monad also waits for network quiet.
- **Cold start**: Playwright MCP (1.1 s) is close to monad (0.9 s); agent-browser 2.0 s; Chrome DevTools MCP 6.1 s.
- **iframes** are still missing from the snapshot.
