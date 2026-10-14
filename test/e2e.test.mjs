// End-to-end against local fixtures. Skips when no Chrome is available.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { findChrome } from "../dist/chrome.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
const F = pathToFileURL(join(here, "fixtures")).href;
const env = { ...process.env, MONAD_SESSION: `test-${process.pid}`, MONAD_NO_SANDBOX: "1" };
const mb = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8" }).trim();
const skip = !findChrome() && "no Chrome found";

before(() => { if (!skip) mb("open", `${F}/form.html`); });
after(() => { if (!skip) mb("stop"); });

test("snapshot is compact and refs are stable", { skip }, () => {
  const a = mb("snapshot");
  assert.match(a, /nav: \[Home\]@1 \[Next page\]@2/);
  assert.match(a, /\[textbox Name\]@3/);
  assert.doesNotMatch(a, /Hidden button/);
  assert.match(a, /clickable "Open card" @7/);
  assert.equal(mb("snapshot"), a);
});

test("run executes a multi-step plan in one call", { skip }, () => {
  const out = mb("run", `await fill("@3", "Ada"); await select("role=combobox:Plan", "Pro"); await click("text=I agree"); await click("role=button:Submit"); return await text("#out")`);
  assert.equal(out, "Hello Ada / pro / true");
});

test("refs self-heal after re-render", { skip }, () => {
  mb("eval", `const b=document.querySelector("form button"); b.replaceWith(b.cloneNode(true)); return 1`);
  assert.match(mb("click", "@6"), /ok clicked/);
});

test("covered elements report the cover", { skip }, () => {
  mb("eval", `const o=document.createElement("div");o.id="cover";o.style="position:fixed;inset:0";document.body.append(o);return 1`);
  assert.throws(() => mb("run", `await click("@6", {timeout: 300})`), /covered by div#cover/);
  mb("eval", `document.getElementById("cover").remove(); return 1`);
});

test("navigation via click settles quickly", { skip }, () => {
  const t = Date.now();
  mb("click", "@2");
  assert.ok(Date.now() - t < 3000);
  assert.match(mb("url"), /^Next/);
});

test("eval keeps the value of an expression that mentions return", { skip }, () => {
  mb("open", `${F}/form.html`);
  // A `return` inside a nested callback used to be read as a function body, so the whole
  // expression was wrapped and its value silently discarded (exit 0, "undefined", no error).
  assert.equal(mb("eval", "[1,2,3].map(function(n){return n*2})"), "[2,4,6]");
  assert.equal(mb("eval", '(function(){return "hello"})()'), "hello");
  assert.equal(mb("eval", "({ n: 1 })"), '{"n":1}');
  // the statement form still works, with and without top-level await
  assert.equal(mb("eval", "const a = 2; return a * 3"), "6");
  assert.equal(mb("eval", 'await Promise.resolve("later")'), "later");
});

test("diff snapshot returns only changes", { skip }, () => {
  mb("open", `${F}/form.html`);
  mb("snapshot");
  const d = mb("fill", "@3", "Diff", "-s");
  assert.match(d, /\+ +- \[textbox Name="Diff"\]@3/);
  assert.doesNotMatch(d, /Next page/);
  assert.match(mb("snapshot", "-d"), /no changes/);
});

test("state save/load round-trips cookies", { skip }, async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const f = join(mkdtempSync(join(tmpdir(), "mb-")), "st.json");
  mb("cdp", "Network.setCookie", JSON.stringify({ name: "tok", value: "abc", url: "https://example.com/" }));
  assert.match(mb("state", "save", f), /saved [1-9]/);
  mb("cdp", "Network.clearBrowserCookies");
  mb("state", "load", f);
  assert.match(mb("cdp", "Network.getCookies", JSON.stringify({ urls: ["https://example.com/"] })), /"tok"/);
});

test("mcp server lists tools and calls them", { skip }, () => {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_open", arguments: { url: `${F}/form.html` } } },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const out = execFileSync(process.execPath, [cli, "mcp"], { env, input, encoding: "utf8" }).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(out[1].result.tools.some((t) => t.name === "browser_run"));
  assert.match(out[2].result.content[0].text, /\[textbox Name\]@3/);
});

test("iframes (same-origin and out-of-process) are in the snapshot and clickable", { skip }, async () => {
  const { spawn } = await import("node:child_process");
  // Separate process: execFileSync blocks this event loop, so an in-process server could not answer.
  const srv = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>{try{r.end(require("fs").readFileSync(${JSON.stringify(join(here, "fixtures"))}+q.url.split("?")[0]))}catch{r.writeHead(404);r.end()}}).listen(18091,()=>console.log("up"))`]);
  await new Promise((r) => srv.stdout.once("data", r));
  try {
    mb("open", "http://127.0.0.1:18091/frames.html");
    mb("wait", "500");
    const s = mb("snapshot");
    assert.match(s, /iframe "Same origin frame"\n\s+- \[textbox Inner name\]@(\d+) \[button Go\]@(\d+)/);
    assert.match(s, /iframe "Cross origin frame"\n\s+- \[textbox Inner name\]@(\d+) \[button Go\]@(\d+)/);
    const refs = [...s.matchAll(/\[textbox Inner name\]@(\d+) \[button Go\]@(\d+)/g)];
    mb("fill", `@${refs[1][1]}`, "x");
    mb("click", `@${refs[1][2]}`);
    mb("click", `@${refs[0][2]}`);
    const after = mb("snapshot");
    assert.match(after, /\[button clicked same\]@/);
    assert.match(after, /\[button clicked cross x\]@/);
  } finally { srv.kill(); mb("open", `${F}/form.html`); }
});
