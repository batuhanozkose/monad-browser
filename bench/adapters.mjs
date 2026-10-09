// One adapter per tool. Every call returns { ms, out } where `out` is exactly what an agent would read.
import { sh, mcp, BIN, CHROME, PROXY, chromeOnPort } from "./common.mjs";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const MB = new URL("../dist/cli.js", import.meta.url).pathname;
// Native thin clients, as a global install runs them (no Node wrapper per call).
const ARCH = { x64: "amd64", arm64: "arm64" }[process.arch];
const MB_NATIVE = new URL(`../bin/native/mb-${process.platform}-${ARCH}`, import.meta.url).pathname;
const AB_NATIVE = new URL(`./node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}`, import.meta.url).pathname;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameRe = (n) => (n instanceof RegExp ? n : new RegExp(`^\\s*${esc(n)}\\s*$`, "i"));

// ---------- ref finders (parse each tool's own snapshot format) ----------
function findMonad(text, role, name) {
  const re = nameRe(name);
  for (const m of text.matchAll(/\[(?:(textbox|combobox|checkbox|button|searchbox|radio|switch|slider|spinbutton|tab|menuitem|option|clickable) )?([^\]]*?)(?:="[^"]*")?(?: \([^)]*\))?\]@(\d+)/g)) {
    const r = m[1] ?? "link";
    if ((!role || role === r || (role === "link" && !m[1])) && re.test(m[2])) return `@${m[3]}`;
  }
  for (const m of text.matchAll(/- (\w+) "([^"]*)" @(\d+)/g)) if ((!role || m[1] === role) && re.test(m[2])) return `@${m[3]}`;
  return null;
}
function findPW(text, role, name) {
  const re = nameRe(name);
  for (const m of text.matchAll(/(\w+) "([^"]*)"[^\n]*?\[ref=([a-z0-9]+)\]/g)) if ((!role || m[1] === role) && re.test(m[2])) return m[3];
  return null;
}
function findAB(text, role, name) {
  const re = nameRe(name);
  for (const m of text.matchAll(/(\w+) "([^"]*)" \[(?:[^\]]*?)ref=(e\d+)/g)) if ((!role || m[1] === role) && re.test(m[2])) return `@${m[3]}`;
  return null;
}
function findCDT(text, role, name) {
  const re = nameRe(name);
  for (const m of text.matchAll(/uid=(\S+) (\w+) "([^"]*)"/g)) {
    const r = m[2] === "StaticText" ? null : m[2];
    if ((!role || r === role) && re.test(m[3])) return m[1];
  }
  return null;
}

// ---------- monad (CLI) ----------
export function monadCli() {
  const env = { MONAD_CHROME: CHROME, MONAD_NO_SANDBOX: "1", MONAD_PROXY: PROXY, MONAD_SESSION: "bench" };
  const run = (...a) => sh(MB_NATIVE, a, { env: { ...env, MONAD_NODE_CLI: MB } });
  return {
    name: "monad-browser (CLI)", kind: "cli", actionsReturnPage: true, find: findMonad,
    start: () => run("open", "https://example.com"),
    open: (u) => run("open", u, "-s"),
    snap: (mode = "full") => run("snapshot", ...(mode === "i" ? ["-i"] : [])),
    click: (r) => run("click", r, "-s"),
    fill: (r, t) => run("fill", r, t, "-s"),
    fillSubmit: (r, t) => run("fill", r, t, "--submit", "-s"),
    select: (r, v) => run("select", r, v, "-s"),
    url: async () => (await run("eval", "location.href")).out,
    script: (code) => run("run", "--", code),
    stop: () => run("stop"),
  };
}

// ---------- monad (MCP) ----------
export function monadMcp() {
  let m;
  const env = { MONAD_CHROME: CHROME, MONAD_NO_SANDBOX: "1", MONAD_PROXY: PROXY, MONAD_SESSION: "benchmcp" };
  return {
    name: "monad-browser (MCP)", kind: "mcp", actionsReturnPage: true, find: findMonad,
    async start() { const t = performance.now(); m = await mcp(process.execPath, [MB, "mcp"], env); const r = await m.call("browser_command", { argv: ["open", "https://example.com"] }); return { ms: performance.now() - t, out: r.out }; },
    tools: () => m.tools,
    open: (u) => m.call("browser_open", { url: u }),
    snap: (mode = "full") => m.call("browser_snapshot", { interactive: mode === "i" }),
    click: (r) => m.call("browser_click", { target: r }),
    fill: (r, t) => m.call("browser_fill", { target: r, text: t }),
    fillSubmit: (r, t) => m.call("browser_fill", { target: r, text: t, submit: true }),
    select: (r, v) => m.call("browser_select", { target: r, values: [v] }),
    url: async () => (await m.call("browser_command", { argv: ["eval", "location.href"] })).out,
    async stop() { await m.call("browser_command", { argv: ["stop"] }).catch(() => {}); await m.close(); return { ms: 0, out: "" }; },
  };
}

// ---------- agent-browser (Vercel) ----------
export function agentBrowser() {
  const env = { AGENT_BROWSER_EXECUTABLE_PATH: CHROME, AGENT_BROWSER_ARGS: "--no-sandbox", AGENT_BROWSER_PROXY: PROXY, AGENT_BROWSER_PROXY_BYPASS: "127.0.0.1,localhost", AGENT_BROWSER_SESSION: "bench" };
  const run = (...a) => sh(AB_NATIVE, a, { env });
  return {
    name: "agent-browser", kind: "cli", actionsReturnPage: false, find: findAB, snapMode: "i",
    start: () => run("open", "https://example.com"),
    open: (u) => run("open", u),
    snap: (mode = "full") => run("snapshot", ...(mode === "i" ? ["-i"] : [])),
    click: (r) => run("click", r),
    fill: (r, t) => run("fill", r, t),
    fillSubmit: async (r, t) => { const a = await run("fill", r, t); const b = await run("press", "Enter"); return { ms: a.ms + b.ms, out: a.out + b.out, calls: 2 }; },
    select: (r, v) => run("select", r, v),
    url: async () => (await run("get", "url")).out,
    script: (cmds) => sh(AB_NATIVE, ["batch", "--bail", ...cmds], { env }),
    stop: () => run("close"),
  };
}

// ---------- Playwright CLI (Microsoft, @playwright/cli) ----------
export function playwrightCli() {
  const cfg = new URL("./pwcli.json", import.meta.url).pathname;
  const run = (...a) => sh(BIN + "playwright-cli", a);
  // Snapshots are written to .playwright-cli/*.yml and linked; an agent reads the file, so count its content.
  const withFile = async (p) => {
    const r = await p;
    const m = /\[Snapshot\]\((\.playwright-cli\/[^)]+\.yml)\)/.exec(r.out);
    if (m) { try { r.out += "\n" + readFileSync(m[1], "utf8"); r.calls = 2; } catch {} }
    return r;
  };
  return {
    name: "Playwright CLI", kind: "cli", actionsReturnPage: true, find: findPW,
    start: () => run("open", "https://example.com", "--config", cfg),
    open: (u) => withFile(run("goto", u)),
    snap: () => run("snapshot"),
    click: (r) => withFile(run("click", r)),
    fill: (r, t) => withFile(run("fill", r, t)),
    fillSubmit: (r, t) => withFile(run("fill", r, t, "--submit")),
    select: (r, v) => withFile(run("select", r, v)),
    url: async () => (await run("eval", "location.href")).out,
    script: (code) => run("run-code", code),
    stop: () => run("close"),
  };
}

// ---------- Playwright MCP ----------
export function playwrightMcp() {
  let m;
  const withFile = async (p) => {
    const r = await p;
    const f = /\[Snapshot\]\((\.playwright-mcp\/[^)]+\.yml)\)/.exec(r.out);
    if (f) { try { r.out += "\n" + readFileSync(f[1], "utf8"); r.calls = 2; } catch {} }
    return r;
  };
  return {
    name: "Playwright MCP", kind: "mcp", actionsReturnPage: true, find: findPW,
    async start() {
      const t = performance.now();
      m = await mcp(BIN + "playwright-mcp", ["--headless", "--isolated", "--no-sandbox", "--executable-path", CHROME, "--proxy-server", PROXY, "--proxy-bypass", "127.0.0.1,localhost"]);
      const r = await m.call("browser_navigate", { url: "https://example.com" });
      return { ms: performance.now() - t, out: r.out };
    },
    tools: () => m.tools,
    open: (u) => withFile(m.call("browser_navigate", { url: u })),
    snap: () => m.call("browser_snapshot", {}),
    click: (r) => withFile(m.call("browser_click", { target: r })),
    fill: (r, t) => withFile(m.call("browser_type", { target: r, text: t })),
    fillSubmit: (r, t) => withFile(m.call("browser_type", { target: r, text: t, submit: true })),
    select: (r, v) => withFile(m.call("browser_select_option", { target: r, values: [v] })),
    url: async () => (await m.call("browser_evaluate", { function: "() => location.href" })).out,
    script: (code) => m.call("browser_run_code_unsafe", { code }),
    async stop() { await m.call("browser_close", {}).catch(() => {}); await m.close(); return { ms: 0, out: "" }; },
  };
}

// ---------- Chrome DevTools MCP (Google) ----------
export function chromeDevtoolsMcp() {
  let m, pageId = 1;
  const p = () => ({ pageId });
  return {
    name: "Chrome DevTools MCP", kind: "mcp", actionsReturnPage: false, find: findCDT,
    async start() {
      const t = performance.now();
      m = await mcp(BIN + "chrome-devtools-mcp", ["--headless", "--isolated", "--executablePath", CHROME, "--chromeArg=--no-sandbox", `--chromeArg=--proxy-server=${PROXY}`]);
      const l = await m.call("list_pages", {});
      const id = /(\d+):.*\[selected\]/.exec(l.out) ?? /(\d+):/.exec(l.out);
      if (id) pageId = Number(id[1]);
      const r = await m.call("navigate_page", { ...p(), type: "url", url: "https://example.com" });
      return { ms: performance.now() - t, out: l.out + r.out };
    },
    tools: () => m.tools,
    open: (u) => m.call("navigate_page", { ...p(), type: "url", url: u }),
    snap: () => m.call("take_snapshot", p()),
    click: (r) => m.call("click", { ...p(), uid: r }),
    fill: (r, t) => m.call("fill", { ...p(), uid: r, value: t }),
    fillSubmit: async (r, t) => { const a = await m.call("fill", { ...p(), uid: r, value: t }); const b = await m.call("press_key", { ...p(), key: "Enter" }); return { ms: a.ms + b.ms, out: a.out + b.out, calls: 2 }; },
    select: (r, v) => m.call("fill", { ...p(), uid: r, value: v }),
    url: async () => (await m.call("evaluate_script", { ...p(), function: "() => location.href" })).out,
    script: (fn) => m.call("evaluate_script", { ...p(), function: fn }),
    async stop() { await m.close(); return { ms: 0, out: "" }; },
  };
}

// ---------- dev-browser (script-only; attaches to a Chrome we launch) ----------
export function devBrowser() {
  let chrome;
  const run = (code) => sh(BIN + "dev-browser", ["--connect", "http://127.0.0.1:9334"], { input: code, timeout: 100000 });
  return {
    name: "dev-browser", kind: "script",
    async start() {
      const t = performance.now();
      chrome = await chromeOnPort(9334);
      const r = await run(`const page = await browser.getPage("main"); await page.goto("https://example.com"); console.log(await page.title());`);
      return { ms: performance.now() - t, out: r.out };
    },
    snapshot: async (u) => run(`const page = await browser.getPage("main"); await page.goto(${JSON.stringify(u)}); console.log((await page.snapshotForAI()).full);`),
    script: (code) => run(code),
    async stop() { await sh(BIN + "dev-browser", ["stop"]); chrome?.kill(); return { ms: 0, out: "" }; },
  };
}
