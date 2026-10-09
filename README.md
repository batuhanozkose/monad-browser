# monad-browser

Headless, turnkey browser CLI for AI agents. Raw CDP, no Playwright, warm daemon, compact
accessibility snapshots with stable `@N` refs.

```sh
mb open news.ycombinator.com
mb snapshot -i          # interactive elements only, each with an @ref
mb click @12 -s         # click, then print a fresh snapshot
mb fill @3 "hello"
mb press Enter
mb eval 'return [...document.links].length'
mb screenshot page.png --full
mb stop
```

- **Warm daemon**: first command launches Chrome and a per-session daemon (unix socket); later commands take ~40 ms.
- **Snapshot**: Accessibility tree merged with DOMSnapshot layout. Hidden nodes are dropped; `cursor:pointer`
  elements without an ARIA role show up as `clickable`. Refs stay stable for an element's lifetime.
- **Safe clicks**: hit-tested; if something covers the target you get an error naming it instead of a wrong click.
- **Proxies**: `HTTPS_PROXY` with credentials works (local relay injects `Proxy-Authorization`).
- **Resource blocking**: `mb --block image,font,media open …`
- **Sessions**: `mb --session work open …` runs an isolated browser. `--cdp <ws|port>` attaches to an existing Chrome.

Env: `MONAD_CHROME` (browser path), `MONAD_NO_SANDBOX=1`, `MONAD_IDLE_MINUTES` (default 30), `MONAD_HOME`.

Status: alpha, phase 1 (daemon, CDP core, snapshot, basic commands). Next: `run` JS batch, auto-wait,
diff snapshots, MCP mode.
