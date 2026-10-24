// End-to-end against local fixtures. Skips when no Chrome is available.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("run stops acting after its timeout", { skip }, () => {
  mb("open", `${F}/form.html`);
  assert.throws(
    () => mb("run", `await new Promise(r => setTimeout(r, 1500)); await goto("https://example.com");`, "--timeout", "300"),
    /run timed out/,
  );
  // The plan wakes up after the timeout; it must not navigate behind the caller's back.
  execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 1800)"], { env });
  assert.equal(mb("get", "title"), "Fixture Form");
  mb("snapshot", "-i"); // opening a page resets refs; the next tests rely on @6/@2
});

test("global --config only applies before the command", { skip }, () => {
  assert.equal(mb("run", "return 1", "--config", "/nonexistent"), "1");
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
  assert.match(mb("snapshot", "-d"), /unchanged rev \d+/);
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
  assert.equal(out[0].result.serverInfo.name, "monad-browser");
  assert.equal(out[0].result.serverInfo.version, JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version);
  assert.equal(out[1].result.tools.length, 14);
  assert.ok(out[1].result.tools.some((t) => t.name === "browser_run"));
  assert.match(out[2].result.content[0].text, /\[textbox Name\]@3/);
});

test("text= targets the control, not its label's text node", { skip }, () => {
  mb("open", `${F}/labels.html`);
  // A sibling <label for> matches the AX name query too, as a StaticText node. It has layout quads,
  // so it passed the visible filter and became the target — but it is not an element, so actions on
  // it failed with "el.getClientRects is not a function".
  const out = mb("run", `
    await fill("text=Promo code", "SPRING");
    await select("text=Plan", "pro");
    await fill("text=Wrapped", "w");
    await click("text=Go");
    return await text("#out");
  `);
  assert.equal(out, "go SPRING / pro");
  mb("open", `${F}/form.html`);
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

test("text=, role= and CSS targets resolve inside frames", { skip }, async () => {
  const { spawn } = await import("node:child_process");
  const srv = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>{try{r.end(require("fs").readFileSync(${JSON.stringify(join(here, "fixtures"))}+q.url.split("?")[0]))}catch{r.writeHead(404);r.end()}}).listen(18092,()=>console.log("up"))`]);
  await new Promise((r) => srv.stdout.once("data", r));
  try {
    mb("open", "http://127.0.0.1:18092/frames.html");
    mb("wait", "500");
    // CSS and role= reach the same-process frame (first in tree order).
    mb("fill", "#q", "css");
    mb("click", "role=button:Go");
    assert.match(mb("snapshot"), /\[button clicked same css\]@/);
    // Drop the same-origin frame, so the only remaining match is the cross-origin (out-of-process) one.
    mb("eval", "document.getElementById('same').remove(); return 1");
    mb("fill", "text=Inner name", "oop");
    mb("click", "text=Go");
    assert.match(mb("snapshot"), /\[button clicked cross oop\]@/);
  } finally { srv.kill(); mb("open", `${F}/form.html`); }
});

test("snapshot cache reuses an unchanged page and invalidates after a mutation", { skip }, () => {
  mb("open", `${F}/form.html`);
  const a = mb("snapshot", "--cache-ms", "60000");
  const b = mb("snapshot", "--cache-ms", "60000");
  assert.equal(b, a);
  mb("eval", `document.querySelector("h1").textContent = "Cache busted"; return 1`);
  assert.match(mb("snapshot", "--cache-ms", "60000"), /Cache busted/);
  assert.doesNotMatch(mb("snapshot", "--cache-ms", "60000"), /Sign up/);
  mb("open", `${F}/form.html`);
});

test("snapshot cache is invalidated by a reload that changes the page", { skip }, async () => {
  const { spawn } = await import("node:child_process");
  const srv = spawn(process.execPath, ["-e", `let n=0;require("http").createServer((q,r)=>{if(q.url!=="/"){r.writeHead(404);return r.end()}r.setHeader("content-type","text/html");r.end("<html><head><title>v</title></head><body><h1>v"+(++n)+"</h1></body></html>")}).listen(18093,()=>console.log("up"))`]);
  await new Promise((r) => srv.stdout.once("data", r));
  try {
    mb("open", "http://127.0.0.1:18093/");
    assert.match(mb("snapshot", "--cache-ms", "60000"), /v1/);
    mb("reload");
    // same URL, new document: the cache must not serve the old v1
    assert.match(mb("snapshot", "--cache-ms", "60000"), /v2/);
  } finally { srv.kill(); mb("open", `${F}/form.html`); }
});

test("diff baseline is per option set and --full resets it", { skip }, () => {
  mb("open", `${F}/long.html`);
  mb("snapshot", "-i");
  const changed = mb("snapshot", "-i", "-d", "--max-text", "10");
  assert.match(changed, /^# /); // a different option set is a new baseline, not a bogus diff
  assert.match(changed, /Very long/);
  const full = mb("snapshot", "-i", "-d", "--full");
  assert.match(full, /^# /);
  assert.doesNotMatch(full, /^unchanged/);
});

test("targeted queries and semantic locators", { skip }, () => {
  mb("open", `${F}/form.html`);
  mb("snapshot", "-i");
  assert.equal(mb("get", "title"), "Fixture Form");
  assert.equal(mb("is", "visible", "@3"), "true");
  assert.equal(mb("is", "checked", "@5"), "false");
  mb("find", "label", "Name", "fill", "Ada");
  assert.equal(mb("get", "value", "@3"), "Ada");
  mb("find", "placeholder", "Your name", "fill", "Grace");
  assert.equal(mb("get", "value", "@3"), "Grace");
  mb("check", "@5");
  assert.equal(mb("is", "checked", "@5"), "true");
  mb("uncheck", "@5");
  assert.equal(mb("is", "checked", "@5"), "false");
  mb("find", "role", "button", "click", "--name", "Submit");
  assert.match(mb("get", "text", "#out"), /Hello Grace/);
  assert.equal(mb("get", "count", "button"), "2");
  assert.match(mb("get", "box", "@6"), /"width"/);
});

test("read extracts markdown and readable active-tab text", { skip }, async () => {
  const { spawn } = await import("node:child_process");
  const body = JSON.stringify("# Title\n\nHello **world**.\n");
  const srv = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>{if(q.url==="/doc.md"){r.setHeader("content-type","text/markdown");r.end(${body})}else{r.writeHead(404);r.end()}}).listen(18096,()=>console.log("up"))`]);
  await new Promise((r) => srv.stdout.once("data", r));
  try {
    const out = mb("read", "--require-md", "http://127.0.0.1:18096/doc.md");
    assert.match(out, /^# Title/m);
    assert.match(out, /Hello \*\*world\*\*\./);
    mb("open", `${F}/form.html`);
    const active = mb("read", "--filter", "Sign");
    assert.match(active, /# Sign up/);
    assert.doesNotMatch(active, /Next page/);
  } finally { srv.kill(); }
});

test("annotated and change-only screenshots, plus pdf", { skip }, async () => {
  const { existsSync, mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "mb-shot-"));
  mb("open", `${F}/form.html`);
  mb("snapshot", "-i");
  const a = mb("screenshot", join(dir, "a.png"), "--annotate");
  assert.match(a, /\[1\] @1 link "Home"/);
  assert.ok(existsSync(join(dir, "a.png")));
  assert.match(mb("screenshot", join(dir, "b.png"), "--if-changed"), /^ok /);
  assert.equal(mb("screenshot", join(dir, "b.png"), "--if-changed"), "unchanged");
  assert.match(mb("pdf", join(dir, "p.pdf")), /^ok /);
  assert.equal(readFileSync(join(dir, "p.pdf")).subarray(0, 5).toString(), "%PDF-");
});

test("cookies, storage and viewport", { skip }, async () => {
  const { spawn } = await import("node:child_process");
  const srv = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>{r.setHeader("content-type","text/html");r.end("<title>s</title><h1>s</h1>")}).listen(18097,()=>console.log("up"))`]);
  await new Promise((r) => srv.stdout.once("data", r));
  try {
    mb("open", "http://127.0.0.1:18097/");
    mb("cookies", "set", "tok", "abc", "--url", "http://127.0.0.1:18097/");
    assert.match(mb("cookies", "--url", "http://127.0.0.1:18097/"), /tok=abc/);
    mb("cookies", "clear", "--url", "http://127.0.0.1:18097/");
    assert.match(mb("cookies", "--url", "http://127.0.0.1:18097/"), /no cookies/);
    mb("storage", "local", "set", "k", "v");
    assert.equal(mb("storage", "local", "get", "k"), "v");
    mb("set", "viewport", "390", "844");
    assert.equal(mb("eval", "return [innerWidth, innerHeight]"), "[390,844]");
  } finally { srv.kill(); }
});

test("network requests and route fulfill/abort", { skip }, async () => {
  const { spawn } = await import("node:child_process");
  const srv = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>{if(q.url==="/api"){r.setHeader("content-type","application/json");r.end('{"real":true}')}else{r.setHeader("content-type","text/html");r.end('<!doctype html><title>Net</title><pre id="out">loading</pre><script>fetch("/api").then(r=>r.text()).then(t=>document.getElementById("out").textContent=t).catch(()=>document.getElementById("out").textContent="ERR")</script>')}}).listen(18098,()=>console.log("up"))`]);
  await new Promise((r) => srv.stdout.once("data", r));
  try {
    mb("open", "http://127.0.0.1:18098/");
    mb("wait", "--text", "real", "--timeout", "5000");
    assert.match(mb("network", "requests", "--filter", "api"), /\/api/);
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const har = join(mkdtempSync(join(tmpdir(), "mb-har-")), "n.har");
    mb("network", "har", "start", har);
    mb("reload"); mb("wait", "--text", "real", "--timeout", "5000");
    assert.match(mb("network", "har", "stop"), /entries/);
    assert.match(readFileSync(har, "utf8"), /"version": "1.2"/);
    assert.match(readFileSync(har, "utf8"), /\/api/);
    mb("network", "route", "**/api", "--body", '{"mocked":true}', "--content-type", "application/json");
    mb("reload"); mb("wait", "--text", "mocked", "--timeout", "5000");
    assert.match(mb("get", "text", "#out"), /mocked/);
    mb("network", "unroute");
    mb("network", "route", "**/api", "--abort");
    mb("reload"); mb("wait", "--text", "ERR", "--timeout", "5000");
    assert.match(mb("get", "text", "#out"), /ERR/);
    mb("network", "unroute");
  } finally { srv.kill(); }
});

test("upload, download, drag and keyboard", { skip }, async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "mb-files-"));
  const file = join(dir, "hello.txt");
  writeFileSync(file, "hello");
  mb("open", `${F}/upload.html`);
  mb("upload", "#f", file);
  assert.equal(mb("get", "text", "#out"), "hello.txt");
  mb("open", `${F}/download.html`);
  mb("download", "#d", join(dir, "dl"));
  assert.equal(readFileSync(join(dir, "dl", "hello.txt"), "utf8"), "hello world");
  mb("open", `${F}/drag.html`);
  mb("drag", "#src", "#dst");
  assert.equal(mb("get", "text", "#out"), "dropped");
  mb("open", `${F}/form.html`);
  mb("snapshot", "-i");
  mb("focus", "@3");
  mb("keyboard", "type", "hey");
  assert.equal(mb("get", "value", "@3"), "hey");
  // Modifier keys are valid keydown/keyup targets (and chords still work).
  assert.equal(mb("keydown", "Shift"), "ok");
  assert.equal(mb("keyup", "Shift"), "ok");
  assert.equal(mb("keydown", "Control+a"), "ok");
  assert.equal(mb("keyup", "Control+a"), "ok");
});

test("json snapshot delta applies to the previous tree", { skip }, () => {
  mb("open", `${F}/many.html`);
  const full = JSON.parse(mb("snapshot", "-i", "--json"));
  assert.equal(full.kind, "full");
  const unchanged = JSON.parse(mb("snapshot", "-i", "--json", "-d"));
  assert.equal(unchanged.kind, "unchanged");
  mb("fill", "@3", "X");
  const delta = JSON.parse(mb("snapshot", "-i", "--json", "-d"));
  assert.equal(delta.kind, "delta");
  const lines = full.tree.split("\n");
  lines.splice(delta.treeChange.startLine, delta.treeChange.deleteCount, ...delta.treeChange.lines);
  const next = JSON.parse(mb("snapshot", "-i", "--json", "--full"));
  assert.deepEqual(lines, next.tree.split("\n"));
});

test("diff url and baseline file", { skip }, async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "mb-diff-"));
  const base = join(dir, "base.txt");
  mb("open", `${F}/form.html`);
  writeFileSync(base, mb("snapshot", "-i"));
  assert.match(mb("diff", "snapshot", "-i", "--baseline", base), /no changes/);
  // A baseline written on Windows has CRLF; normalize it instead of reporting every line as changed.
  const crlf = join(dir, "base-crlf.txt");
  writeFileSync(crlf, mb("snapshot", "-i").replace(/\n/g, "\r\n"));
  assert.match(mb("diff", "snapshot", "-i", "--baseline", crlf), /no changes/);
  assert.match(mb("diff", "url", `${F}/form.html`, `${F}/labels.html`, "-i"), /\+\d+ -\d+/);
});

test("dialog status/accept/dismiss with --no-auto-dialog", { skip }, () => {
  const session = `dlg-${process.pid}`;
  const run = (...args) => execFileSync(process.execPath, [cli, "--session", session, ...args], { env, encoding: "utf8" }).trim();
  try {
    run("--no-auto-dialog", "open", `${F}/dialog.html`);
    run("click", "#alert");
    assert.match(run("dialog", "status"), /alert: hi/);
    run("dialog", "accept");
    assert.equal(run("dialog", "status"), "no dialog");
    run("click", "#confirm");
    assert.match(run("dialog", "status"), /confirm: ok\?/);
    run("dialog", "dismiss");
    assert.equal(run("get", "title"), "no");
  } finally { try { run("stop"); } catch { /* ignore */ } }
});

test("doctor and skills work without a browser", { skip: false }, () => {
  assert.match(execFileSync(process.execPath, [cli, "doctor"], { env, encoding: "utf8" }), /monad-browser doctor/);
  assert.match(execFileSync(process.execPath, [cli, "skills", "list"], { env, encoding: "utf8" }), /^core\t/m);
  assert.match(execFileSync(process.execPath, [cli, "skills", "path"], { env, encoding: "utf8" }).trim(), /[\\/]\.agents[\\/]skills[\\/]monad-browser$/);
  const printed = execFileSync(process.execPath, [cli, "skills", "get", "core"], { env, encoding: "utf8" });
  assert.equal(printed, execFileSync(process.execPath, [cli, "install-skill", "--print"], { env, encoding: "utf8" }));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  assert.equal(execFileSync(process.execPath, [cli, "--version"], { env, encoding: "utf8" }).trim(), `monad-browser ${pkg.version}`);
  // npm links a global bin into prefix/bin; the launcher must resolve that symlink.
  const link = join(mkdtempSync(join(tmpdir(), "mb-bin-")), "mb");
  symlinkSync(join(here, "..", "bin", "mb"), link);
  assert.equal(execFileSync(link, ["--version"], { env, encoding: "utf8" }).trim(), `monad-browser ${pkg.version}`);
  // Help must not run the command (mcp would otherwise wait on stdin).
  assert.match(execFileSync(process.execPath, [cli, "mcp", "--help"], { env, encoding: "utf8", timeout: 2000 }), /^usage: mb mcp/);
  assert.match(execFileSync(process.execPath, [cli, "snapshot", "--help"], { env, encoding: "utf8", timeout: 2000 }), /^usage: mb snapshot/);
});

test("json delta falls back to full when the splice would not save space", { skip }, () => {
  mb("open", `${F}/long.html`);
  const full = JSON.parse(mb("snapshot", "-i", "--json"));
  assert.equal(full.kind, "full");
  mb("fill", "nth=0:input", "A");
  mb("fill", "nth=1:input", "B");
  const next = JSON.parse(mb("snapshot", "-i", "--json", "-d"));
  // Two distant edits make the contiguous splice the whole tree, so the full form wins.
  assert.equal(next.kind, "full");
});

test("global --viewport applies before the first navigation", { skip }, () => {
  const session = `vp-${process.pid}`;
  const run = (...args) => execFileSync(process.execPath, [cli, "--session", session, ...args], { env, encoding: "utf8" }).trim();
  try {
    run("--viewport", "500x700", "open", `${F}/form.html`);
    assert.equal(run("eval", "return [innerWidth, innerHeight]"), "[500,700]");
  } finally { try { run("stop"); } catch { /* ignore */ } }
});

test("profiler and trace produce files", { skip }, async () => {
  const { existsSync, mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "mb-prof-"));
  mb("open", `${F}/form.html`);
  mb("snapshot", "-i");
  mb("profiler", "start");
  mb("click", "#name");
  const profile = join(dir, "p.json");
  assert.match(mb("profiler", "stop", profile), /^ok /);
  assert.ok(existsSync(profile));
  assert.match(readFileSync(profile, "utf8"), /"startTime"/);
  mb("trace", "start");
  mb("click", "#name");
  const trace = join(dir, "t.json");
  assert.match(mb("trace", "stop", trace), /^ok /);
  assert.ok(existsSync(trace));
  assert.match(readFileSync(trace, "utf8"), /"traceEvents"/);
});
