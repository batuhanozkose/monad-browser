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