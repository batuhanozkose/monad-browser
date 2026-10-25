// Unit tests for the pure helpers: the Myers diff, the argv parser, and cross-platform paths.
// No Chrome needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTreeChange, diffLines, globToRegExp, matchGlob, renderDiff, treeChange } from "../dist/diff.js";
import { filterSections, htmlToText, outlineMarkdown } from "../dist/read.js";
import { parseArgs } from "../dist/commands.js";
import { assertSession, socketPathFor } from "../dist/paths.js";
import { chromeCandidates, launchChrome, readDevToolsActivePort } from "../dist/chrome.js";
import { nativeBinaryName, nativeBinaryPath } from "../scripts/native-name.mjs";

test("diffLines finds equal, removed and added runs", () => {
  const ops = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
  const removed = ops.filter((o) => o.t === "-").map((o) => o.line);
  const added = ops.filter((o) => o.t === "+").map((o) => o.line);
  const same = ops.filter((o) => o.t === "=").map((o) => o.line);
  assert.deepEqual(removed, ["b"]);
  assert.deepEqual(added.sort(), ["e", "x"]);
  assert.deepEqual(same, ["a", "c", "d"]);
});

test("diffLines is empty for identical input", () => {
  const ops = diffLines(["a", "b"], ["a", "b"]);
  assert.ok(ops.every((o) => o.t === "="));
});

test("renderDiff reports counts and marks lines", () => {
  const d = renderDiff(["a", "b", "c"], ["a", "c", "d"]);
  assert.equal(d.removed, 1);
  assert.equal(d.added, 1);
  assert.equal(d.same, 2);
  assert.match(d.text, /^- b$/m);
  assert.match(d.text, /^\+ d$/m);
});

test("renderDiff keeps the nearest unchanged ancestor as context", () => {
  const d = renderDiff(
    ["- list", "  - row", "    - [ok]@1"],
    ["- list", "  - row", "    - [changed]@1"],
  );
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.match(d.text, /- row/); // nearest less-indented ancestor, not the root
  assert.doesNotMatch(d.text, /- list/);
});

test("treeChange + applyTreeChange reconstruct the new tree", () => {
  const cases = [
    [["a", "b", "c"], ["a", "x", "c"]],
    [["a", "b"], ["a", "b", "c"]],
    [["a", "b", "c"], ["a", "c"]],
    [["a", "b", "c", "d", "e"], ["a", "X", "c", "d", "Y"]],
    [[], ["a"]],
    [["a"], []],
  ];
  for (const [before, after] of cases) {
    const change = treeChange(before, after);
    assert.deepEqual(applyTreeChange(before, change), after);
  }
  // The splice is contiguous: two distant changes cover the middle, which is why the text
  // diff (Myers) is used for humans and the JSON patch falls back to full when it is large.
  const scattered = treeChange(["a", "b", "c", "d"], ["A", "b", "c", "D"]);
  assert.equal(scattered.startLine, 0);
  assert.equal(scattered.deleteCount, 4);
});

test("globToRegExp matches URL globs and plain strings match as substrings", () => {
  assert.ok(globToRegExp("**/api").test("https://x.test/v1/api"));
  assert.ok(!globToRegExp("**/api").test("https://x.test/v1/apis"));
  assert.ok(globToRegExp("*.example.com").test("a.example.com"));
  assert.ok(!globToRegExp("*.example.com").test("example.com"));
  assert.ok(matchGlob("https://x.test/a/b", "**/b"));
  assert.ok(matchGlob("https://x.test/a/b", "a/b"));
  assert.ok(!matchGlob("https://x.test/a/b", "c"));
});

test("htmlToText strips chrome, keeps structure and decodes entities", () => {
  const html = `<html><body><nav><a href="/x">Nav</a></nav><main>
    <h1>Title &amp; More</h1><p>Hello <strong>world</strong>.</p>
    <ul><li>one</li><li>two</li></ul>
    <pre><code>const x = 1;</code></pre>
    <a href="/docs">Docs</a>
  </main><footer>Footer</footer></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /^# Title & More/m);
  assert.match(text, /Hello \*\*world\*\*\./);
  assert.match(text, /- one/);
  assert.match(text, /```/);
  assert.match(text, /\[Docs\]\(\/docs\)/);
  assert.doesNotMatch(text, /Nav/);
  assert.doesNotMatch(text, /Footer/);
  assert.equal(htmlToText(html, { outline: true }), "# Title & More");
});

test("htmlToText keeps a main heading inside a <header> but strips site chrome", () => {
  const html = `<body>
    <header><nav><a href="/">Site</a></nav></header>
    <main><header><h1>Article title</h1><p>By Ada</p></header><p>Body text</p></main>
  </body>`;
  const text = htmlToText(html);
  assert.match(text, /^# Article title/m);
  assert.match(text, /Body text/);
  assert.doesNotMatch(text, /Site/);
  assert.equal(htmlToText(html, { outline: true }), "# Article title");
});

test("filterSections keeps matching markdown sections and outlineMarkdown lists headings", () => {
  const md = "# Alpha\none\n## Beta\ntwo\n## Gamma\nthree";
  assert.equal(filterSections(md, "Beta"), "## Beta\ntwo");
  assert.equal(outlineMarkdown(md), "# Alpha\n## Beta\n## Gamma");
});

test("parseArgs handles short flags, values and --", () => {
  assert.deepEqual(parseArgs(["-s"]).flags.snapshot, true);
  assert.deepEqual(parseArgs(["-i", "-d"]).flags, { interactive: true, diff: true });
  assert.deepEqual(parseArgs(["-is"]).flags, { interactive: true, snapshot: true });
  assert.deepEqual(parseArgs(["open", "x.com", "-isd"]).flags, { interactive: true, snapshot: true, diff: true });
  assert.deepEqual(parseArgs(["-abc"]).args, ["-abc"]);
  assert.equal(parseArgs(["--max-lines", "5"]).flags["max-lines"], "5");
  assert.equal(parseArgs(["--max-lines=5"]).flags["max-lines"], "5");
  assert.deepEqual(parseArgs(["--", "-x", "y"]).args, ["-x", "y"]);
});

test("parseArgs treats declared booleans as flags, not values", () => {
  const { args, flags } = parseArgs(["--interactive", "example.com"]);
  assert.equal(flags.interactive, true);
  assert.deepEqual(args, ["example.com"]);
});

test("loadConfig merges a project config and normalizes arrays", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mb-cfg-"));
  writeFileSync(join(dir, "monad-browser.json"), JSON.stringify({
    idleMinutes: 7, block: ["image"], viewport: { width: 390, height: 844 },
    initScripts: ["a.js", "b.js"], headers: { "X-Test": "1" },
  }));
  const { loadConfig } = await import("../dist/config.js");
  const cfg = loadConfig(dir);
  assert.equal(cfg.idleMinutes, 7);
  assert.deepEqual(cfg.block, ["image"]);
  assert.deepEqual(cfg.viewport, { width: 390, height: 844 });
  assert.deepEqual(cfg.initScripts, ["a.js", "b.js"]);
  assert.deepEqual(cfg.headers, { "X-Test": "1" });
});

test("parseArgs accepts the new diff/query/wait flags", () => {
  assert.deepEqual(parseArgs(["--full", "--json"]).flags, { full: true, json: true });
  assert.deepEqual(parseArgs(["--annotate", "--if-changed"]).flags, { annotate: true, "if-changed": true });
  assert.equal(parseArgs(["--url", "**/dash"]).flags.url, "**/dash");
  assert.equal(parseArgs(["--fn", "window.ready === true"]).flags.fn, "window.ready === true");
  assert.equal(parseArgs(["--state", "hidden", "#x"]).flags.state, "hidden");
  assert.equal(parseArgs(["--body", '{"ok":true}']).flags.body, '{"ok":true}');
});

test("nativeBinaryName maps every packaged platform/arch to its file name", () => {
  assert.equal(nativeBinaryName("linux", "x64"), "mb-linux-amd64");
  assert.equal(nativeBinaryName("linux", "arm64"), "mb-linux-arm64");
  assert.equal(nativeBinaryName("darwin", "x64"), "mb-darwin-amd64");
  assert.equal(nativeBinaryName("darwin", "arm64"), "mb-darwin-arm64");
  // Windows is a Node fallback today, but a future build must be found by the same shim.
  assert.equal(nativeBinaryName("win32", "x64"), "mb-windows-amd64.exe");
  assert.equal(nativeBinaryName("win32", "arm64"), "mb-windows-arm64.exe");
  assert.equal(nativeBinaryName("freebsd", "x64"), undefined);
  assert.equal(nativeBinaryName("linux", "mips"), undefined);
});

test("nativeBinaryPath points inside the package bin/native directory", () => {
  assert.equal(nativeBinaryPath("/pkg", "linux", "x64"), join("/pkg", "bin", "native", "mb-linux-amd64"));
  assert.equal(nativeBinaryPath("/pkg", "darwin", "arm64"), join("/pkg", "bin", "native", "mb-darwin-arm64"));
  assert.equal(nativeBinaryPath("/pkg", "win32", "x64"), join("/pkg", "bin", "native", "mb-windows-amd64.exe"));
  assert.equal(nativeBinaryPath("/pkg", "freebsd", "x64"), undefined);
});

test("socketPathFor uses a per-user named pipe on win32 and a socket file elsewhere", () => {
  const pipe = socketPathFor("win32", "C:\\Users\\a\\.monad-browser", "default");
  assert.ok(pipe.startsWith(String.raw`\\.\pipe\monad-browser-`));
  assert.match(pipe, /[0-9a-f]{8}-default$/);
  // Two users (or two MONAD_HOME values) must never meet on one machine-global pipe.
  assert.notEqual(pipe, socketPathFor("win32", "C:\\Users\\b\\.monad-browser", "default"));
  assert.equal(socketPathFor("linux", "/home/a/.monad-browser", "default"), join("/home/a/.monad-browser", "default.sock"));
  assert.equal(socketPathFor("darwin", "/Users/a/.monad-browser", "work"), join("/Users/a/.monad-browser", "work.sock"));
});

test("assertSession rejects separators that break sockets and Windows paths", () => {
  assert.doesNotThrow(() => assertSession("work-2"));
  assert.doesNotThrow(() => assertSession("a.b_c"));
  assert.doesNotThrow(() => assertSession("my work")); // a space is a valid file and pipe name
  assert.throws(() => assertSession("a/b"), /invalid session name/);
  assert.throws(() => assertSession("a\\b"), /invalid session name/);
  assert.throws(() => assertSession("a:b"), /invalid session name/);
  assert.throws(() => assertSession("a*b"), /invalid session name/);
  assert.throws(() => assertSession("a?b"), /invalid session name/);
  assert.throws(() => assertSession('a"b'), /invalid session name/);
  assert.throws(() => assertSession("a|b"), /invalid session name/);
  assert.throws(() => assertSession("a\nb"), /invalid session name/);
  assert.throws(() => assertSession(""), /invalid session name/);
});

test("bin/mb falls back to the Node CLI when no native binary is packaged", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "mb-shim-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(root, "bin", "mb"), join(dir, "bin", "mb"));
  cpSync(join(root, "scripts", "native-name.mjs"), join(dir, "scripts", "native-name.mjs"));
  cpSync(join(root, "dist"), join(dir, "dist"), { recursive: true });
  cpSync(join(root, "package.json"), join(dir, "package.json"));
  const out = execFileSync(process.execPath, [join(dir, "bin", "mb"), "--version"], { encoding: "utf8" }).trim();
  assert.equal(out, `monad-browser ${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}`);
});

test("chromeCandidates covers Windows, macOS and Linux without literal undefined paths", () => {
  assert.deepEqual(chromeCandidates("win32", {}), []);
  const win = chromeCandidates("win32", { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" });
  assert.ok(win.some((p) => p.endsWith(join("Google", "Chrome", "Application", "chrome.exe"))));
  assert.ok(win.some((p) => p.endsWith(join("Microsoft", "Edge", "Application", "msedge.exe"))));
  assert.ok(win.some((p) => p.endsWith(join("Chromium", "Application", "chrome.exe"))));
  assert.ok(win.every((p) => !p.includes("undefined")));
  assert.ok(chromeCandidates("darwin", {}).some((p) => p.includes("Google Chrome.app")));
  assert.ok(chromeCandidates("darwin", {}).some((p) => p.includes("Microsoft Edge.app")));
  assert.ok(chromeCandidates("linux", {}).includes("/usr/bin/google-chrome"));
  assert.ok(chromeCandidates("linux", {}).includes("/usr/bin/microsoft-edge"));
});

test("readDevToolsActivePort tolerates CRLF from Windows Chrome", () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-port-"));
  writeFileSync(join(dir, "DevToolsActivePort"), "12345\n/devtools/browser/abc\r\n");
  assert.equal(readDevToolsActivePort(dir), "ws://127.0.0.1:12345/devtools/browser/abc");
});

test("doctor treats an empty pid file as stale (pid 0 is the process group)", async () => {
  const { doctor } = await import("../dist/doctor.js");
  const dir = mkdtempSync(join(tmpdir(), "mb-doc-"));
  writeFileSync(join(dir, "empty.pid"), "");
  const old = process.env.MONAD_HOME;
  process.env.MONAD_HOME = dir;
  try {
    const out = doctor(true);
    assert.match(out, /1 stale file removed/);
    assert.equal(existsSync(join(dir, "empty.pid")), false);
  } finally {
    if (old === undefined) delete process.env.MONAD_HOME;
    else process.env.MONAD_HOME = old;
  }
});

test("launchChrome rejects a missing executable instead of crashing", async () => {
  await assert.rejects(
    launchChrome({ executable: join(tmpdir(), "mb-definitely-missing-chrome") }),
    /ENOENT|spawn/i,
  );
});
