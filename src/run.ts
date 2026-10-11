// `run`: execute a whole multi-step plan in one agent turn. The script runs in the daemon (Node side)
// with an async API bound to the current tab; only what the script logs/returns comes back.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import vm from "node:vm";
import type { Browser } from "./browser.js";

export async function runScript(browser: Browser, code: string, cwd: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<string> {
  const out: string[] = [];
  let step = 0;
  let lastStep = "";
  const fmt = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "undefined" : JSON.stringify(v, null, 0));
  const track = <F extends (...a: any[]) => Promise<any>>(name: string, fn: F): F =>
    (async (...a: any[]) => {
      // Cooperative cancellation: the client hung up, so stop before the next step instead of running the whole plan.
      if (signal?.aborted) throw new Error("aborted: client disconnected");
      step++;
      lastStep = `${name}(${a.map((x) => JSON.stringify(x)).join(", ").slice(0, 80)})`;
      return fn(...a);
    }) as F;

  const api = {
    goto: track("goto", async (url: string) => browser.goto(url)),
    open: track("open", async (url: string) => browser.goto(url)),
    click: track("click", async (t: string, o: { button?: "left" | "right" | "middle"; count?: number; timeout?: number } = {}) =>
      browser.click(t, { button: o.button, count: o.count, timeoutMs: o.timeout })),
    dblclick: track("dblclick", async (t: string) => browser.click(t, { count: 2 })),
    fill: track("fill", async (t: string, text: string) => browser.fill(t, String(text))),
    type: track("type", async (text: string, into?: string) => browser.type(String(text), into)),
    press: track("press", async (key: string) => browser.press(key)),
    select: track("select", async (t: string, ...values: string[]) => browser.select(t, values.flat())),
    hover: track("hover", async (t: string) => browser.hover(t)),
    scroll: track("scroll", async (dir = "down", px = 600, on?: string) => browser.scroll(dir, px, on)),
    text: track("text", async (t?: string, max = 4000) => browser.text(t, max)),
    js: track("js", async (expr: string) => browser.evaluate(expr)),
    snapshot: track("snapshot", async (o: { interactive?: boolean; maxLines?: number; diff?: boolean } = {}) => browser.snapshot(o)),
    exists: track("exists", async (t: string) => { try { await browser.resolve(t); return true; } catch { return false; } }),
    url: async () => (await browser.info()).url,
    title: async () => (await browser.info()).title,
    wait: track("wait", async (what: number | string, timeout = 10_000) => {
      if (typeof what === "number") return sleep(what);
      return browser.actionable(what, { timeoutMs: timeout, enabled: false, hitTest: false }).then(() => true);
    }),
    waitForText: track("waitForText", async (t: string, timeout = 10_000) => {
      const ok = await browser.evaluate(`new Promise(r => { const t = ${JSON.stringify(t)}; const end = Date.now() + ${timeout}; (function f(){ if (document.body && document.body.innerText.includes(t)) return r(true); if (Date.now() > end) return r(false); setTimeout(f, 100); })(); })`);
      if (!ok) throw new Error(`text not found within ${timeout} ms: ${t}`);
      return true;
    }),
    waitForIdle: track("waitForIdle", async (timeout = 5000) => browser.networkIdle(500, timeout)),
    screenshot: track("screenshot", async (path?: string, o: { full?: boolean; on?: string } = {}) => {
      const buf = await browser.screenshot({ fullPage: o.full, target: o.on });
      const p = resolvePath(cwd, path ?? `screenshot-${Date.now()}.png`);
      writeFileSync(p, buf);
      return p;
    }),
    back: track("back", async () => browser.back()),
    reload: track("reload", async () => browser.reload()),
    cdp: track("cdp", async (method: string, params: object = {}) => browser.send(method, params)),
    tabs: async () => browser.listTabs(),
    log: (...a: unknown[]) => { out.push(a.map(fmt).join(" ")); },
    sleep,
    readFile: (p: string) => readFileSync(resolvePath(cwd, p), "utf8"),
  };

  const context = vm.createContext({ ...api, console: { log: api.log, error: api.log, warn: api.log }, JSON, Math, Date, URL, setTimeout, clearTimeout, Promise });
  const wrapped = `(async () => {\n${code}\n})()`;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      new vm.Script(wrapped, { filename: "run.js" }).runInContext(context),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`run timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    if (result !== undefined) out.push(fmt(result));
    return out.join("\n") || "ok";
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    out.push(`error at step ${step} ${lastStep}: ${msg}`);
    const err = new Error(out.join("\n"));
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const RUN_HELP = `run '<js>' | run --file plan.js | run -   (stdin)
  async JS with: goto click fill type press select hover scroll text js snapshot exists
  wait(ms|target) waitForText waitForIdle screenshot back reload cdp tabs url title log sleep
  targets: @N, text=Label, role=button:Name, or CSS. Actions auto-wait for actionability.
  only log()/return output comes back — e.g.
  mb run 'await goto("example.com"); await click("text=More information..."); return await title()'`;
