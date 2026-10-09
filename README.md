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

- **One-turn plans**: `mb run 'await goto("site"); await fill("role=textbox:Email", "a@b.c"); await click("text=Sign in"); return await title()'`
  runs many steps in a single call; only what you `log()`/`return` comes back. Also `run --file plan.js` or `run -` (stdin).
- **Auto-wait**: actions wait until the target is attached, visible, stable, enabled and not covered.
  A cover (cookie banner, modal) is named in the error. Refs self-heal by role + name after re-renders.
- **Targets**: `@N`, `text=Label`, `role=button:Submit`, or CSS.
- **Inline snapshot**: rows, list items and paragraphs collapse to one line with inline refs
  (`- row: 675 points by [ilreb]@14 [4 hours ago]@15 | [hide]@16`), about half the size of a tree dump.
- **Warm daemon**: first command launches Chrome and a per-session daemon (unix socket); later commands take ~40 ms.
- **Snapshot**: Accessibility tree merged with DOMSnapshot layout. Hidden nodes are dropped; `cursor:pointer`
  elements without an ARIA role show up as `clickable`. Refs stay stable for an element's lifetime.
- **Safe clicks**: hit-tested; if something covers the target you get an error naming it instead of a wrong click.
- **Proxies**: `HTTPS_PROXY` with credentials works (local relay injects `Proxy-Authorization`).
- **Resource blocking**: `mb --block image,font,media open …`
- **Sessions**: `mb --session work open …` runs an isolated browser. `--cdp <ws|port>` attaches to an existing Chrome.

Env: `MONAD_CHROME` (browser path), `MONAD_NO_SANDBOX=1`, `MONAD_IDLE_MINUTES` (default 30), `MONAD_HOME`.

Status: alpha. Done: daemon, CDP core, snapshot, commands, `run`, auto-wait. Next: diff snapshots, sessions, MCP mode, benchmark.
