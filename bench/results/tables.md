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