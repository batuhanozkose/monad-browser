// Watch end-to-end: a separate local fixture HTTP server, the real CLI, no external network.
// The default fetch path must work without Chrome; --render is covered when Chrome is present.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "../dist/chrome.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
const home = mkdtempSync(join(tmpdir(), "mb-watch-e2e-"));
const session = `watch-e2e-${process.pid}`;
const env = { ...process.env, MONAD_HOME: home, MONAD_SESSION: session, MONAD_NO_SANDBOX: "1", NO_COLOR: "1" };
delete env.MONAD_WATCH_NOTIFY_URL;

let base = "";
let server;

const SERVER = String.raw`
const http = require("http");
let state = {
  page: "UP", version: 1, price: 10, renderState: "ready", fail: false,
  feed: [{ title: "Docs", link: "" }]
};
let notifications = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const origin = "http://" + req.headers.host;
  if (u.pathname === "/__state") {
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ state, notifications }));
      return;
    }
    let body = "";
    req.on("data", (d) => { body += String(d); });
    req.on("end", () => {
      try {
        const patch = JSON.parse(body);
        if (patch.__clearNotifications) notifications = [];
        delete patch.__clearNotifications;
        Object.assign(state, patch);
        res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e)); }
    });
    return;
  }
  if (u.pathname === "/page") {
    res.setHeader("content-type", "text/html");
    res.end("<html><body><main><h1>Status</h1><p id=\"state\">" + state.page + "</p></main></body></html>");
    return;
  }
  if (u.pathname === "/json") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version: state.version, price: state.price }));
    return;
  }
  if (u.pathname === "/feed.xml") {
    const items = state.feed.map((e) => "<item><title>" + e.title + "</title><link>" + (e.link || origin + "/docs") + "</link></item>").join("");
    res.setHeader("content-type", "application/rss+xml");
    res.end("<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>Fixture</title>" + items + "</channel></rss>");
    return;
  }
  if (u.pathname === "/render") {
    res.setHeader("content-type", "text/html");
    res.end("<html><body><div id=\"state\">loading</div><script>setTimeout(() => { document.getElementById(\"state\").textContent = " + JSON.stringify(state.renderState) + "; }, 30)</script></body></html>");
    return;
  }
  if (u.pathname === "/notify") {
    let body = "";
    req.on("data", (d) => { body += String(d); });
    req.on("end", () => { notifications.push({ body, headers: req.headers }); res.end("ok"); });
    return;
  }
  if (u.pathname === "/fail") {
    res.writeHead(503, { "retry-after": "1", "content-type": "text/plain" });
    res.end("unavailable");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
srv.listen(0, "127.0.0.1", () => console.log("PORT " + srv.address().port));
`;

const mb = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 60_000 });
const ok = (...args) => {
  const r = mb(...args);
  assert.equal(r.status, 0, `mb ${args.join(" ")} failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r.stdout.trim();
};
const json = (...args) => JSON.parse(ok(...args));
const remove = (name) => { try { ok("watch", "remove", name); } catch { /* already gone */ } };
const waitFor = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${ms} ms`);
};
const setState = async (patch) => {
  const res = await fetch(`${base}/__state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  assert.equal(res.status, 200);
};
const notifications = async () => (await (await fetch(`${base}/__state`)).json()).notifications;

before(async () => {
  server = spawn(process.execPath, ["-e", SERVER], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture server did not start")), 10_000);
    server.stdout.on("data", (d) => {
      const m = /PORT (\d+)/.exec(String(d));
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
  });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  try { mb("stop"); } catch { /* ignore */ }
  server?.kill();
  rmSync(home, { recursive: true, force: true });
});

test("page changed: add stores a baseline, check fires, list/logs expose it, remove", async () => {
  await setState({ page: "UP" });
  assert.match(ok("watch", "add", `${base}/page`, "--kind", "page", "--extract", "text", "--condition", "changed", "--every", "1h", "--name", "e2e-page"), /baseline set/);
  await setState({ page: "DOWN" });
  const check = json("watch", "check", "e2e-page", "--json");
  assert.equal(check.checked, 1);
  assert.equal(check.fired.length, 1);
  assert.equal(check.fired[0].type, "fired");
  assert.match(check.fired[0].previous, /UP/);
  assert.match(check.fired[0].next, /DOWN/);
  assert.match(check.fired[0].diff, /DOWN/);
  assert.match(check.fired[0].at, /^\d{4}-\d\d-\d\dT/);

  const list = json("watch", "list", "--json");
  const w = list.watches.find((x) => x.name === "e2e-page");
  assert.ok(w);
  assert.equal(w.lastError, null);
  assert.equal(w.totalFires, 1);
  assert.match(w.lastValue, /DOWN/);
  assert.equal(w.every, "1h");

  const logs = json("watch", "logs", "e2e-page", "--json");
  assert.ok(logs.events.some((e) => e.kind === "baseline"));
  assert.ok(logs.events.some((e) => e.kind === "fired" && /DOWN/.test(e.summary)));

  assert.match(ok("watch", "remove", "e2e-page"), /ok removed/);
  assert.equal(json("watch", "list", "--json").watches.some((x) => x.name === "e2e-page"), false);
});

test("contains fires on the transition, not on every interval", async () => {
  await setState({ page: "UP" });
  ok("watch", "add", `${base}/page`, "--kind", "page", "--extract", "text", "--condition", 'contains "DOWN"', "--every", "1h", "--name", "e2e-contains");
  await setState({ page: "DOWN" });
  assert.equal(json("watch", "check", "e2e-contains", "--json").fired.length, 1);
  assert.equal(json("watch", "check", "e2e-contains", "--json").fired.length, 0);
  await setState({ page: "UP" });
  assert.equal(json("watch", "check", "e2e-contains", "--json").fired.length, 0);
  await setState({ page: "DOWN" });
  assert.equal(json("watch", "check", "e2e-contains", "--json").fired.length, 1);
  remove("e2e-contains");
});

test("CSS and JSON extraction watch only the selected value", async () => {
  await setState({ page: "UP" });
  ok("watch", "add", `${base}/page`, "--kind", "page", "--extract", "css:#state", "--condition", "changed", "--every", "1h", "--name", "e2e-css");
  await setState({ page: "DOWN" });
  const css = json("watch", "check", "e2e-css", "--json");
  assert.equal(css.fired[0].previous, "UP");
  assert.equal(css.fired[0].next, "DOWN");
  remove("e2e-css");

  await setState({ version: 1 });
  ok("watch", "add", `${base}/json`, "--kind", "page", "--extract", "json:version", "--condition", "> 1", "--every", "1h", "--name", "e2e-json");
  await setState({ version: 2 });
  const j = json("watch", "check", "e2e-json", "--json");
  assert.equal(j.fired.length, 1);
  assert.equal(j.fired[0].previous, "1");
  assert.equal(j.fired[0].next, "2");
  assert.equal(json("watch", "check", "e2e-json", "--json").fired.length, 0);
  remove("e2e-json");
});

test("RSS watcher fires on a new matching entry", async () => {
  await setState({ feed: [{ title: "Docs", link: "" }] });
  ok("watch", "add", `${base}/feed.xml`, "--kind", "rss", "--condition", 'contains "security"', "--every", "1h", "--name", "e2e-rss");
  await setState({ feed: [{ title: "Security fix", link: `${base}/security` }, { title: "Docs", link: "" }] });
  const check = json("watch", "check", "e2e-rss", "--json");
  assert.equal(check.fired.length, 1);
  assert.match(check.fired[0].diff, /Security fix/);
  assert.match(check.fired[0].next, /Docs/);
  assert.equal(json("watch", "check", "e2e-rss", "--json").fired.length, 0);
  remove("e2e-rss");
});

test("network errors back off, stay visible, and never kill the watcher", () => {
  const add = mb("watch", "add", `${base}/fail`, "--kind", "page", "--every", "1h", "--name", "e2e-fail");
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /first check failed/);
  let w = json("watch", "list", "--json").watches.find((x) => x.name === "e2e-fail");
  assert.match(w.lastError, /503/);
  assert.equal(w.consecutiveErrors, 1);
  const firstNext = Date.parse(w.nextCheckAt);

  const check = mb("watch", "check", "e2e-fail", "--json");
  assert.equal(check.status, 1);
  const c = JSON.parse(check.stdout);
  assert.equal(c.errors.length, 1);
  assert.match(c.errors[0].error, /503/);
  w = json("watch", "list", "--json").watches.find((x) => x.name === "e2e-fail");
  assert.equal(w.consecutiveErrors, 2);
  assert.ok(Date.parse(w.nextCheckAt) > firstNext, "backoff should grow");
  const logs = json("watch", "logs", "e2e-fail", "--json");
  assert.ok(logs.events.some((e) => e.kind === "error" && /503/.test(e.error)));
  remove("e2e-fail");
});

test("--exec and --notify run only when the condition fires", async () => {
  const marker = join(home, "exec-ran.txt");
  const script = join(home, "exec.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "ran");\n`);
  await setState({ page: "UP" });
  ok("watch", "add", `${base}/page`, "--kind", "page", "--extract", "css:#state", "--condition", "changed", "--every", "1h", "--name", "e2e-exec", "--exec", `node "${script}" "${marker}"`);
  assert.throws(() => readFileSync(marker, "utf8"), /ENOENT/);
  await setState({ page: "DOWN" });
  assert.equal(json("watch", "check", "e2e-exec", "--json").fired.length, 1);
  assert.equal(readFileSync(marker, "utf8"), "ran");
  rmSync(marker, { force: true });
  assert.equal(json("watch", "check", "e2e-exec", "--json").fired.length, 0);
  assert.throws(() => readFileSync(marker, "utf8"), /ENOENT/);
  remove("e2e-exec");

  await setState({ page: "UP", __clearNotifications: true });
  env.MONAD_WATCH_NOTIFY_URL = `${base}/notify`;
  try {
    ok("watch", "add", `${base}/page`, "--kind", "page", "--extract", "css:#state", "--condition", "changed", "--every", "1h", "--name", "e2e-notify", "--notify");
    assert.equal((await notifications()).length, 0);
    await setState({ page: "DOWN" });
    assert.equal(json("watch", "check", "e2e-notify", "--json").fired.length, 1);
    await waitFor(async () => (await notifications()).length > 0, 3000);
    const n = (await notifications())[0];
    assert.match(n.body, /e2e-notify/);
    assert.match(n.body, /DOWN/);
    assert.match(n.headers.title, /e2e-notify/);
    remove("e2e-notify");
  } finally {
    delete env.MONAD_WATCH_NOTIFY_URL;
  }
});

test("watch check all checks every watcher", async () => {
  await setState({ page: "UP" });
  ok("watch", "add", `${base}/page`, "--kind", "page", "--extract", "css:#state", "--condition", "changed", "--every", "1h", "--name", "e2e-all-1");
  ok("watch", "add", `${base}/page`, "--kind", "page", "--extract", "css:#state", "--condition", "changed", "--every", "1h", "--name", "e2e-all-2");
  await setState({ page: "DOWN" });
  const c = json("watch", "check", "all", "--json");
  assert.equal(c.checked, 2);
  assert.equal(c.fired.length, 2);
  remove("e2e-all-1");
  remove("e2e-all-2");
});

test("mb watch run is the foreground alternative", async () => {
  await setState({ page: "UP" });
  ok("watch", "add", `${base}/page`, "--kind", "page", "--extract", "css:#state", "--condition", "changed", "--every", "1s", "--name", "e2e-run");
  ok("stop");
  const child = spawn(process.execPath, [cli, "watch", "run", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(() => stderr.includes("watching 1"), 5000);
    await setState({ page: "DOWN" });
    await waitFor(() => stdout.split("\n").some((line) => {
      try { return JSON.parse(line).type === "fired"; } catch { return false; }
    }), 12_000);
    child.kill();
    const result = await exited;
    assert.ok(result.code === 0 || result.code === null || result.signal, `unexpected exit ${JSON.stringify(result)}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    remove("e2e-run");
  }
});

test("the daemon timer fires between CLI calls", async () => {
  await setState({ page: "UP" });
  ok("watch", "add", `${base}/page`, "--kind", "page", "--extract", "css:#state", "--condition", "changed", "--every", "1s", "--name", "e2e-daemon");
  await setState({ page: "DOWN" });
  await waitFor(() => {
    const w = json("watch", "list", "--json").watches.find((x) => x.name === "e2e-daemon");
    return !!w?.lastFiredAt;
  }, 20_000);
  const w = json("watch", "list", "--json").watches.find((x) => x.name === "e2e-daemon");
  assert.ok(w.totalFires >= 1);
  assert.match(w.lastValue, /DOWN/);
  remove("e2e-daemon");
  ok("stop");
});

const chrome = findChrome();
test("--render uses Chrome for JS-heavy pages", { skip: !chrome && "no Chrome found" }, async () => {
  await setState({ renderState: "ready" });
  ok("watch", "add", `${base}/render`, "--kind", "page", "--extract", "css:#state", "--condition", "changed", "--every", "1h", "--name", "e2e-render", "--render");
  const w = json("watch", "list", "--json").watches.find((x) => x.name === "e2e-render");
  assert.equal(w.lastValue, "ready");
  await setState({ renderState: "changed" });
  const c = json("watch", "check", "e2e-render", "--json");
  assert.equal(c.fired.length, 1);
  assert.equal(c.fired[0].previous, "ready");
  assert.equal(c.fired[0].next, "changed");
  remove("e2e-render");
});
