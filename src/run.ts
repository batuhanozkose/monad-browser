// `run`: execute a whole multi-step plan in one agent turn. The script runs in the daemon (Node side)
// with an async API bound to the current tab; only what the script logs/returns comes back.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import vm from "node:vm";
import type { Browser } from "./browser.js";
import { matchGlob } from "./diff.js";
import { htmlToText, readUrl } from "./read.js";

export async function runScript(browser: Browser, code: string, cwd: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<string> {
  const out: string[] = [];
  let step = 0;
  let lastStep = "";
  let aborted = false;
  const onAbort = () => { aborted = true; };
  signal?.addEventListener("abort", onAbort, { once: true });
  const fmt = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "undefined" : JSON.stringify(v, null, 0));
  const track = <F extends (...a: any[]) => Promise<any>>(name: string, fn: F): F =>
    (async (...a: any[]) => {
      // Cooperative cancellation: the client hung up or the script timed out, so stop before the
      // next step instead of continuing to click and type after the caller got its error.
      if (aborted || signal?.aborted) throw new Error("aborted: run stopped");
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
    snapshot: track("snapshot", async (o: { interactive?: boolean; maxLines?: number; diff?: boolean; full?: boolean; json?: boolean } = {}) => browser.snapshot(o)),
    exists: track("exists", async (t: string) => { try { await browser.resolve(t); return true; } catch { return false; } }),
    get: track("get", async (what: string, target?: string, arg?: string) => {
      switch (what) {
        case "title": return (await browser.info()).title;
        case "url": return (await browser.info()).url;
        case "cdp-url": return browser.cdpUrl();
        case "count": return browser.getCount(String(target));
        case "text": return browser.text(target);
        case "html": return browser.getHtml(String(target));
        case "value": return browser.getValue(String(target));
        case "attr": return browser.getAttr(String(target), String(arg));
        case "box": return browser.getBox(String(target));
        case "styles": return browser.getStyles(String(target));
        default: throw new Error(`unknown get target: ${what}`);
      }
    }),
    is: track("is", async (what: string, target: string) => {
      if (what === "visible") return browser.isVisible(target);
      if (what === "enabled") return browser.isEnabled(target);
      if (what === "checked") return browser.isChecked(target);
      throw new Error(`unknown is target: ${what}`);
    }),
    find: track("find", async (locator: string, value: string, action: string, text?: string, o: { name?: string; exact?: boolean } = {}) => {
      const target = locator === "role" ? `role=${value}${o.name ? `:${o.name}` : ""}`
        : locator === "text" ? `${o.exact ? "text=" : "text~="}${value}`
        : locator === "first" ? `nth=0:${value}`
        : locator === "last" ? `nth=-1:${value}`
        : locator === "nth" ? `nth=${value}:${action}`
        : `${locator}=${value}`;
      if (locator === "nth") { const real = text; if (real === "click") { await browser.click(target); return true; } throw new Error("nth supports click in run()"); }
      if (action === "click") { await browser.click(target); return true; }
      if (action === "fill") { await browser.fill(target, String(text ?? "")); return true; }
      if (action === "check" || action === "uncheck") { await browser.setChecked(target, action === "check"); return true; }
      if (action === "hover") { await browser.hover(target); return true; }
      if (action === "focus") { await browser.focus(target); return true; }
      if (action === "text") return browser.text(target);
      throw new Error(`unknown find action: ${action}`);
    }),
    check: track("check", async (t: string) => browser.setChecked(t, true)),
    uncheck: track("uncheck", async (t: string) => browser.setChecked(t, false)),
    focus: track("focus", async (t: string) => browser.focus(t)),
    scrollIntoView: track("scrollIntoView", async (t: string) => browser.scrollIntoViewTarget(t)),
    upload: track("upload", async (t: string, files: string[]) => browser.upload(t, files.map((f) => resolvePath(cwd, f)))),
    pdf: track("pdf", async (path?: string) => {
      const out = resolvePath(cwd, path ?? `page-${Date.now()}.pdf`);
      writeFileSync(out, await browser.pdf());
      return out;
    }),
    read: track("read", async (url?: string, o: { outline?: boolean; filter?: string } = {}) => {
      if (url) return readUrl(url, o);
      const html = String(await browser.evaluate("document.documentElement ? document.documentElement.outerHTML : ''"));
      return htmlToText(html, o);
    }),
    waitForUrl: track("waitForUrl", async (pattern: string, timeout = 10_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const { url } = await browser.info();
        if (matchGlob(url, pattern)) return url;
        await sleep(100);
      }
      throw new Error(`URL did not match ${pattern} within ${timeout} ms`);
    }),
    waitForFn: track("waitForFn", async (js: string, timeout = 10_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await browser.evaluate(js).catch(() => false)) return true;
        await sleep(100);
      }
      throw new Error(`expression stayed false for ${timeout} ms`);
    }),
    dialogAccept: track("dialogAccept", async (text?: string) => browser.dialogAccept(text)),
    dialogDismiss: track("dialogDismiss", async () => browser.dialogDismiss()),
    download: track("download", async (t: string, dir = "downloads") => browser.download(t, resolvePath(cwd, dir))),
    drag: track("drag", async (src: string, dst: string) => browser.drag(src, dst)),
    cookies: track("cookies", async (url?: string) => browser.cookies(url)),
    storage: track("storage", async (kind: "local" | "session" = "local") => browser.storage(kind)),
    networkRequests: track("networkRequests", async (filter?: string) => browser.networkRequests(filter)),
    setViewport: track("setViewport", async (w: number, h: number, scale = 1) => browser.setViewport(w, h, scale)),
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
    screenshot: track("screenshot", async (path?: string, o: { full?: boolean; on?: string; ifChanged?: boolean } = {}) => {
      const buf = await browser.screenshot({ fullPage: o.full, target: o.on, ifChanged: o.ifChanged });
      if (!buf) return "unchanged";
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
      new Promise((_, rej) => { timer = setTimeout(() => { aborted = true; rej(new Error(`run timed out after ${timeoutMs} ms`)); }, timeoutMs); }),
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
    signal?.removeEventListener("abort", onAbort);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const RUN_HELP = `run '<js>' | run --file plan.js | run -   (stdin)
  async JS with: goto click fill type press select hover scroll text js snapshot exists get is find
  check uncheck focus scrollIntoView upload pdf read drag download cookies storage networkRequests
  wait(ms|target) waitForText waitForUrl waitForFn waitForIdle screenshot back reload cdp tabs url title log sleep
  targets: @N, text=Label, text~=Substring, role=button:Name, label=..., placeholder=..., nth=N:css, or CSS.
  Actions auto-wait for actionability. only log()/return output comes back — e.g.
  mb run 'await goto("example.com"); await click("text=More information..."); return await title()'`;
