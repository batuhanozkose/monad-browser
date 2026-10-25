// Cross-platform command matrix: every CLI command, run through real shells against real Chrome.
// One scenario runs per available shell (bash on unix, pwsh everywhere, cmd on Windows); each step
// records its command so the final test can prove the inventory is covered.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "../dist/chrome.js";
import { COMMANDS, EXTRA_USAGE } from "../dist/commands.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const install = process.argv.includes("--install");
const soft = process.env.MATRIX_SOFT === "1";
const chrome = findChrome();
const skip = !chrome && "no Chrome found";

// --- shells ---------------------------------------------------------------------------------

const quotePwsh = (s) => `'${s.replaceAll("'", "''")}'`;
const quoteBash = (s) => `'${s.replaceAll("'", "'\\''")}'`;
// Windows argument escaping: quote only when needed, and escape backslashes before a quote.
const quoteCmd = (s) => {
  if (/^[\w@.=:+-]+$/.test(s)) return s;
  const escaped = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
};
const forceCmd = (s) => `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;

const SHELLS = {
  pwsh: { file: "pwsh", args: (line) => ["-NoProfile", "-NonInteractive", "-Command", line], quote: quotePwsh, force: quotePwsh },
  bash: { file: "bash", args: (line) => ["-c", line], quote: quoteBash, force: quoteBash },
  cmd: { file: "cmd", args: (line) => ["/d", "/c", line], quote: quoteCmd, force: forceCmd },
};

function available(shell) {
  const s = SHELLS[shell];
  const r = spawnSync(s.file, s.args("exit 0"), { encoding: "utf8" });
  return !r.error && r.status === 0;
}

function installMb() {
  const prefix = mkdtempSync(join(tmpdir(), "mb-matrix-prefix-"));
  const r = spawnSync("npm link", {
    cwd: root, encoding: "utf8", shell: true,
    env: { ...process.env, npm_config_prefix: prefix },
  });
  assert.equal(r.status, 0, `npm link failed:\n${r.stdout}\n${r.stderr}`);
  return process.platform === "win32" ? prefix : join(prefix, "bin");
}

const binDir = !skip && install ? installMb() : undefined;
const pathEnv = binDir ? `${binDir}${delimiter}${process.env.PATH}` : process.env.PATH;
const prefix = !install && !process.env.MB_BIN ? [process.execPath, join(root, "dist", "cli.js")] : ["mb"];

const cmdDir = process.platform === "win32" ? mkdtempSync(join(tmpdir(), "mb-matrix-cmd-")) : undefined;
let cmdSeq = 0;
if (cmdDir) process.on("exit", () => rmSync(cmdDir, { recursive: true, force: true }));

// --- fixture server -------------------------------------------------------------------------

const SERVER = `
const http = require("http"), fs = require("fs"), path = require("path");
const dir = process.env.FIXTURES;
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/echo") {
    const body = JSON.stringify({ query: u.search, headers: q.headers });
    r.setHeader("content-type", "text/html");
    r.end("<title>Echo</title><pre id=out>" + body.replace(/</g, "&lt;") + "</pre>");
    return;
  }
  if (u.pathname === "/md") { r.setHeader("content-type", "text/markdown"); r.end("# Matrix Doc\\n\\nHello **matrix**.\\n"); return; }
  if (u.pathname === "/llms.txt") { r.setHeader("content-type", "text/plain"); r.end("# Matrix llms\\n- [Doc](/md)\\n"); return; }
  try {
    const name = u.pathname;
    const file = path.join(dir, name.split("?")[0]);
    const type = { ".html": "text/html", ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json" }[path.extname(file)] || "application/octet-stream";
    r.setHeader("content-type", type);
    r.end(fs.readFileSync(file));
  }
  catch { r.writeHead(404); r.end("not found"); }
});
srv.listen(0, "127.0.0.1", () => console.log("PORT " + srv.address().port));
`;

let server;
let baseUrl;
before(async () => {
  if (skip) return;
  server = spawn(process.execPath, ["-e", SERVER], {
    env: { ...process.env, FIXTURES: join(here, "fixtures") }, stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("fixture server did not start")), 10_000);
    server.stdout.on("data", (d) => {
      const m = /PORT (\d+)/.exec(String(d));
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
});
after(() => { server?.kill(); });

// --- runner ---------------------------------------------------------------------------------

class Runner {
  constructor(shell, session, cwd) {
    this.shell = shell;
    this.session = session;
    this.cwd = cwd;
    this.results = [];
    this.state = {};
    this.failures = [];
    // Isolate daemon state per shell so `sessions` starts empty and leftovers never interfere.
    this.home = join(cwd, "state");
    mkdirSync(this.home, { recursive: true });
  }

  line(argv) {
    const s = SHELLS[this.shell];
    const args = argv.map((a) => {
      if (typeof a === "string") return s.quote(a);
      return a.raw !== undefined ? a.raw : s.force(a.quoted);
    });
    if (prefix.length === 1) return ["mb", ...args].join(" ");
    const head = prefix.map((p) => s.quote(p));
    return this.shell === "pwsh" ? `& ${head.concat(args).join(" ")}` : head.concat(args).join(" ");
  }

  run(argv, opts = {}) {
    const s = SHELLS[this.shell];
    const line = this.line(argv);
    const spawnOpts = {
      cwd: this.cwd,
      encoding: "utf8",
      timeout: opts.timeout ?? 120_000,
      input: opts.input,
      env: {
        ...process.env,
        PATH: pathEnv,
        MONAD_HOME: this.home,
        MONAD_SESSION: this.session,
        MONAD_NO_SANDBOX: process.env.MONAD_NO_SANDBOX ?? "1",
        ...opts.env,
      },
    };
    let r;
    if (this.shell === "cmd") {
      const file = join(cmdDir, `step-${++cmdSeq}.cmd`);
      writeFileSync(file, `@echo off\r\nchcp 65001 >nul 2>&1\r\n${line}\r\n`);
      r = spawnSync("cmd", ["/d", "/c", file], spawnOpts);
    } else {
      r = spawnSync(s.file, s.args(line), spawnOpts);
    }
    return {
      code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(),
      error: r.error, line,
    };
  }

  step(id, cmd, argv, opts = {}) {
    const r = this.run(argv, opts);
    const detail = `${this.shell} step "${id}"\n  $ ${r.line}\n  exit ${r.code}\n  stdout: ${r.out.slice(0, 1200)}\n  stderr: ${r.err.slice(0, 1200)}${r.error ? `\n  ${r.error}` : ""}`;
    try {
      assert.equal(r.code, opts.code ?? 0, detail);
      if (opts.out) assert.match(r.out, opts.out, detail);
      if (opts.outNot) assert.doesNotMatch(r.out, opts.outNot, detail);
      if (opts.err) assert.match(r.err, opts.err, detail);
      if (opts.emptyStdout) assert.equal(r.out, "", detail);
      if (opts.fn) opts.fn(r, detail);
    } catch (e) {
      this.failures.push({ id, detail: e.message });
      if (!soft) throw e;
    }
    this.results.push({ id, cmd, sub: opts.sub });
    return r.out;
  }

  check(cond, message) {
    if (cond) return;
    if (soft) { this.failures.push({ id: "check", detail: message }); return; }
    assert.fail(message);
  }

  /** Two clients at once on one warm daemon. */
  async concurrent(argv) {
    const s = SHELLS[this.shell];
    const line = this.line(argv);
    const spawnOne = () => new Promise((resolve) => {
      const child = this.shell === "cmd"
        ? spawn("cmd", ["/d", "/c", writeBatch(line)], spawnOpts(this))
        : spawn(s.file, s.args(line), spawnOpts(this));
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
    });
    const [a, b] = await Promise.all([spawnOne(), spawnOne()]);
    assert.equal(a.code, 0, `${this.shell}: concurrent call A failed: ${a.err}`);
    assert.equal(b.code, 0, `${this.shell}: concurrent call B failed: ${b.err}`);
    this.results.push({ id: "concurrent clients", cmd: "eval" });
  }
}

function writeBatch(line) {
  const file = join(cmdDir, `step-${++cmdSeq}.cmd`);
  writeFileSync(file, `@echo off\r\nchcp 65001 >nul 2>&1\r\n${line}\r\n`);
  return file;
}

function spawnOpts(runner) {
  return {
    cwd: runner.cwd,
    env: { ...process.env, PATH: pathEnv, MONAD_HOME: runner.home, MONAD_SESSION: runner.session, MONAD_NO_SANDBOX: process.env.MONAD_NO_SANDBOX ?? "1" },
  };
}

// --- scenario -------------------------------------------------------------------------------

const REF = { raw: (n) => ({ raw: `@${n}` }), quoted: (n) => ({ quoted: `@${n}` }) };

async function scenario(r) {
  const S = (id, cmd, argv, opts) => r.step(id, cmd, argv, opts);
  const F = (p) => `${baseUrl}/${p}`;
  const cwd = r.cwd;
  const out = join(cwd, "çıktı lar");
  mkdirSync(out, { recursive: true });
  const st = r.state;

  // -- static CLI ---------------------------------------------------------------------------
  S("version", "version", ["--version"], { out: /^monad-browser \d+\.\d+\.\d+$/ });
  S("help", "help", ["help"], { out: /usage: mb/ });
  S("help click", "help", ["help", "click"], { out: /^usage: mb click/ });
  S("click --help", "click", ["click", "--help"], { out: /^usage: mb click/ });
  S("doctor", "doctor", ["doctor"], { out: /monad-browser doctor/ });
  S("skills list", "skills", ["skills", "list"], { sub: "skills list", out: /^core\t/m });
  S("skills get", "skills", ["skills", "get", "core"], { sub: "skills get", out: /Windows and PowerShell/ });
  S("skills path", "skills", ["skills", "path"], { sub: "skills path", out: /skills[\\/]monad-browser$/m });
  S("install-skill --print", "install-skill", ["install-skill", "--print"], { out: /^---\nname: monad-browser/m });
  S("install-skill --dir", "install-skill", ["install-skill", "--dir", join(cwd, "skill out")], {
    sub: "install-skill --dir", out: /ok wrote/,
  });
  r.check(existsSync(join(cwd, "skill out", "SKILL.md")), "install-skill wrote no SKILL.md");
  S("sessions (none)", "sessions", ["sessions"], { out: /no sessions running/ });
  S("status (stopped)", "status", ["status"], { out: /stopped/ });
  S("stop (not running)", "stop", ["stop"], { out: /not running/ });
  S("missing flag value", null, ["--headers"], { code: 1, err: /--headers needs a value/ });

  // -- daemon lifecycle ---------------------------------------------------------------------
  S("start", "start", ["start"], { out: /ok started session/ });
  S("status (running)", "status", ["status"], { out: /running session=/ });
  S("sessions (one)", "sessions", ["sessions"], { out: new RegExp(r.session.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
  S("unknown command", null, ["nope"], { code: 1, err: /unknown command: nope/, emptyStdout: true });
  S("missing target", "click", ["click"], { code: 1, err: /missing target — in PowerShell/, emptyStdout: true });

  // -- browser core + refs ------------------------------------------------------------------
  const grab = (re, what) => {
    const m = re.exec(snap);
    r.check(m, `snapshot has no ${what} ref:\n${snap}`);
    return m?.[1] ?? "1";
  };
  let snap = S("open -s -i", "open", ["open", F("form.html"), "-s", "-i"], { out: /Name/ });
  st.name = grab(/(?:\[textbox Name\]@|textbox "Name" @)(\d+)/, "Name");
  st.link = grab(/\[Next page\]@(\d+)/, "Next page");
  st.checkbox = grab(/(?:\[checkbox I agree\]@|checkbox "I agree" @)(\d+)/, "checkbox");
  st.card = grab(/clickable "Open card" @(\d+)/, "card");

  S("url", "url", ["url"], { out: /Fixture Form/ });
  S("snapshot", "snapshot", ["snapshot"], { out: /# Fixture Form/ });
  S("snapshot -i", "snapshot", ["snapshot", "-i"], { out: /textbox "Name" @|\[textbox Name\]@/ });
  S("snapshot -d", "snapshot", ["snapshot", "-d"], { out: /unchanged|# Fixture Form/ });
  S("snapshot --full", "snapshot", ["snapshot", "--full"], { out: /# Fixture Form/ });
  S("snapshot --json", "snapshot", ["snapshot", "--json"], {
    fn: (x) => assert.ok(["full", "unchanged", "delta"].includes(JSON.parse(x.out).kind)),
  });
  S("snapshot --max-lines", "snapshot", ["snapshot", "--max-lines", "4"], { out: /^# / });
  S("snapshot --max-text", "snapshot", ["snapshot", "--max-text", "8"]);
  S("snapshot --cache-ms", "snapshot", ["snapshot", "--cache-ms", "60000"]);
  S("snapshot --cache", "snapshot", ["snapshot", "--cache"]);

  S("click quoted ref", "click", ["click", REF.quoted(st.name), "-s"], { out: /^ok clicked @/ });
  S("click bare ref", "click", ["click", st.name, "-s"], { out: new RegExp(`^ok clicked ${st.name}`) });
  if (r.shell === "pwsh") {
    S("click raw ref (pwsh drops it)", "click", ["click", REF.raw(st.name), "-s"], {
      code: 1, err: /missing target — in PowerShell a bare @ref is splatting/, emptyStdout: true,
    });
  } else {
    S("click raw ref", "click", ["click", REF.raw(st.name), "-s"], { out: /^ok clicked @/ });
  }
  S("click --button right", "click", ["click", st.name, "--button", "right"]);
  S("click --count 2", "click", ["click", st.name, "--count", "2"]);
  S("click --new-tab", "click", ["click", st.link, "--new-tab"], { out: /^ok clicked/ });
  S("tabs (two)", "tabs", ["tabs"]);
  S("tab close", "tab", ["tab", "close"], { sub: "tab close" });
  S("tab 0", "tab", ["tab", "0"]);
  S("tab new", "tab", ["tab", "new", F("next.html")], { sub: "tab new" });
  S("tab back to form", "tab", ["tab", "0"]);

  S("fill", "fill", ["fill", st.name, "Ada"]);
  S("get value", "get", ["get", "value", st.name], { out: /^Ada$/ });
  S("fill empty string", "fill", ["fill", st.name, ""]);
  S("get value (empty)", "get", ["get", "value", st.name], { out: /^$/ });
  S("type --into", "type", ["type", "Grace", "--into", st.name]);
  S("get value (typed)", "get", ["get", "value", st.name], { out: /Grace/ });
  S("press", "press", ["press", "Escape"]);
  S("keydown", "keydown", ["keydown", "Shift"]);
  S("keyup", "keyup", ["keyup", "Shift"]);
  S("keyboard type", "keyboard", ["keyboard", "type", "x"], { sub: "keyboard type" });
  S("keyboard inserttext", "keyboard", ["keyboard", "inserttext", "y"], { sub: "keyboard inserttext" });
  S("select", "select", ["select", "role=combobox:Plan", "Pro"]);
  S("check", "check", ["check", st.checkbox]);
  S("is checked", "is", ["is", "checked", st.checkbox], { out: /true/ });
  S("uncheck", "uncheck", ["uncheck", st.checkbox]);
  S("is visible", "is", ["is", "visible", st.checkbox], { out: /true/ });
  S("is enabled", "is", ["is", "enabled", st.checkbox], { out: /true/ });

  S("get title", "get", ["get", "title"], { out: /Fixture Form/ });
  S("get url", "get", ["get", "url"], { out: /form\.html/ });
  S("get cdp-url", "get", ["get", "cdp-url"], { out: /^wss?:\/\// });
  S("get text", "get", ["get", "text", "h1"], { out: /Sign up/ });
  S("get html", "get", ["get", "html", "body"], { out: /<h1>Sign up<\/h1>/ });
  S("get attr", "get", ["get", "attr", st.name, "placeholder"], { out: /Your name/ });
  S("get count", "get", ["get", "count", "button"], { out: /^\d+$/ });
  S("get box", "get", ["get", "box", st.name], { fn: (x) => assert.ok("width" in JSON.parse(x.out)) });
  S("get styles", "get", ["get", "styles", st.name, "--props", "display,color"], { fn: (x) => assert.ok("display" in JSON.parse(x.out)) });
  S("text page", "text", ["text"], { out: /Sign up/ });
  S("text element", "text", ["text", "h1"], { out: /^Sign up$/ });

  S("find label", "find", ["find", "label", "Name", "fill", "Labeled"], { out: /^ok filled/ });
  S("find placeholder", "find", ["find", "placeholder", "Your name", "fill", "Place"], { out: /^ok filled/ });
  S("find role", "find", ["find", "role", "button", "click", "--name", "Submit"], { out: /^ok clicked/ });
  S("find text", "find", ["find", "text", "Sign up", "text"], { out: /Sign up/ });
  S("find first", "find", ["find", "first", ".card", "text"], { out: /Open/ });
  S("find last", "find", ["find", "last", ".card", "text"], { out: /Open/ });
  S("find nth", "find", ["find", "nth", "0", ".card", "text"], { out: /Open/ });

  // -- selectors on matrix.html -------------------------------------------------------------
  S("open matrix.html", "open", ["open", F("matrix.html"), "-s", "-i"]);
  S("selector #id", "text", ["text", "#ident"], { out: /id target/ });
  S("selector .cls", "text", ["text", ".cls"], { out: /id target/ });
  S("selector [attr]", "text", ["text", '[data-testid="go"]'], { out: /Test ID/ });
  S("selector :nth-child", "text", ["text", "li:nth-child(2)"], { out: /two/ });
  S("selector nth=0", "text", ["text", "nth=0:.item"], { out: /one/ });
  S("selector text=", "text", ["text", "text=Test ID"], { out: /Test ID/ });
  S("selector testid=", "find", ["find", "testid", "go", "click"], { out: /^ok clicked/ });
  S("selector alt=", "is", ["is", "visible", "alt=Logo alt"], { out: /true/ });
  S("selector title=", "find", ["find", "title", "Tooltip title", "text"], { out: /titled/ });
  S("selector role=", "find", ["find", "role", "button", "click", "--name", "Icon Only"], { out: /^ok clicked/ });

  // -- actions ------------------------------------------------------------------------------
  // The selector block navigated to matrix.html; actions need the form and fresh refs.
  snap = S("open form for actions", "open", ["open", F("form.html"), "-s", "-i"]);
  st.name = grab(/(?:\[textbox Name\]@|textbox "Name" @)(\d+)/, "Name");
  st.card = grab(/clickable "Open card" @(\d+)/, "card");
  S("hover", "hover", ["hover", ".card"]);
  S("scroll", "scroll", ["scroll", "down", "120"]);
  S("scroll --on", "scroll", ["scroll", "down", "120", "--on", st.card]);
  S("scrollintoview", "scrollintoview", ["scrollintoview", st.card]);
  S("highlight", "highlight", ["highlight", st.card]);
  S("focus", "focus", ["focus", st.name]);
  S("mouse move", "mouse", ["mouse", "move", "10", "10"], { sub: "mouse move" });
  S("mouse down", "mouse", ["mouse", "down"], { sub: "mouse down" });
  S("mouse up", "mouse", ["mouse", "up"], { sub: "mouse up" });
  S("mouse wheel negative", "mouse", ["mouse", "wheel", "-120"], { sub: "mouse wheel" });

  // drag runs on its own page
  S("open drag", "open", ["open", F("drag.html")]);
  S("drag source target", "drag", ["drag", "#src", "#dst"], { out: /^ok$/ });
  S("get dropped", "get", ["get", "text", "#out"], { out: /dropped/ });

  S("open next", "open", ["open", F("next.html")]);
  S("back", "back", ["back"]);
  S("forward", "forward", ["forward"]);
  S("reload", "reload", ["reload"]);
  S("open form again", "open", ["open", F("form.html"), "-s", "-i"]);
  st.name = /(?:\[textbox Name\]@|textbox "Name" @)(\d+)/.exec(S("snapshot after open", "snapshot", ["snapshot", "-i"]))[1];

  S("wait ms", "wait", ["wait", "50"]);
  S("wait selector", "wait", ["wait", "#name"]);
  S("wait --text", "wait", ["wait", "--text", "Sign up"]);
  S("wait --url", "wait", ["wait", "--url", "**/form.html"]);
  S("wait --fn", "wait", ["wait", "--fn", "document.title === 'Fixture Form'"]);
  S("wait --state hidden", "wait", ["wait", "--state", "hidden", "#nope"]);
  S("wait --idle", "wait", ["wait", "--idle", "--timeout", "5000"]);

  S("console error", "eval", ["eval", 'console.error("matrix-console"); return 1']);
  S("console", "console", ["console"], { out: /matrix-console/ });
  S("block", "block", ["block", "image,font"]);
  S("open with block", "open", ["open", F("form.html")]);
  snap = S("snapshot after block", "snapshot", ["snapshot", "-i"]);
  st.name = grab(/(?:\[textbox Name\]@|textbox "Name" @)(\d+)/, "Name");
  S("block none", "block", ["block", "none"]);
  S("cdp", "cdp", ["cdp", "Browser.getVersion"], { out: /protocolVersion/ });
  S("cdp with json", "cdp", ["cdp", "Runtime.evaluate", '{"expression":"1+1","returnByValue":true}'], { out: /"value":2/ });

  S("eval", "eval", ["eval", "return 1+1"], { out: /^2$/ });
  S("eval --", "eval", ["eval", "--", "return 2+2"], { out: /^4$/ });
  S("eval quoting", "eval", ["eval", 'return "a;b|c&d(e)f,g`h!i"'], { out: /^a;b\|c&d\(e\)f,g`h!i$/ });
  S("eval json", "eval", ["eval", 'return JSON.stringify({a:[1,2]})'], { out: /^\{"a":\[1,2\]\}$/ });

  // -- files --------------------------------------------------------------------------------
  const shot = join(out, "ekran görüntüsü.png");
  S("screenshot path with spaces", "screenshot", ["screenshot", shot], { out: /^ok / });
  r.check(existsSync(shot), "screenshot was not written");
  S("screenshot relative", "screenshot", ["screenshot", "relative.png"], { out: /^ok / });
  r.check(existsSync(join(cwd, "relative.png")), "relative screenshot was not written");
  S("screenshot --full", "screenshot", ["screenshot", join(out, "full.png"), "--full"]);
  S("screenshot --jpeg", "screenshot", ["screenshot", join(out, "shot.jpg"), "--jpeg"]);
  S("screenshot --on", "screenshot", ["screenshot", join(out, "el.png"), "--on", st.name]);
  S("screenshot --annotate", "screenshot", ["screenshot", join(out, "ann.png"), "--annotate"], { out: /\[1\] @/ });
  S("screenshot --if-changed", "screenshot", ["screenshot", join(out, "chg.png"), "--if-changed"], { out: /^ok / });
  S("screenshot --if-changed again", "screenshot", ["screenshot", join(out, "chg.png"), "--if-changed"], { out: /^unchanged$/ });
  S("screenshot --dir", "screenshot", ["screenshot", "--dir", out, "--jpeg"], { out: /^ok / });
  S("pdf", "pdf", ["pdf", join(out, "sayfa.pdf")], { out: /^ok / });
  r.check(readFileSync(join(out, "sayfa.pdf")).subarray(0, 5).toString() === "%PDF-", "pdf is not a PDF");

  const uploadFile = join(out, "yükle me.txt");
  writeFileSync(uploadFile, "hello matrix");
  S("open upload", "open", ["open", F("upload.html")]);
  S("upload", "upload", ["upload", "#f", uploadFile], { out: /^ok uploaded 1/ });
  S("uploaded name", "get", ["get", "text", "#out"], { out: /yükle me\.txt/ });
  S("open download", "open", ["open", F("download.html")]);
  S("download", "download", ["download", "#d", join(out, "indir me")], { out: /^ok / });
  r.check(readFileSync(join(out, "indir me", "hello.txt"), "utf8") === "hello world", "download content mismatch");

  const stateFile = join(out, "durum.json");
  S("state save", "state", ["state", "save", stateFile], { sub: "state save", out: /^ok saved/ });
  S("state load", "state", ["state", "load", stateFile], { sub: "state load", out: /^ok loaded/ });

  const profile = join(out, "profil.json");
  S("profiler start", "profiler", ["profiler", "start"], { sub: "profiler start" });
  S("profiler stop", "profiler", ["profiler", "stop", profile], { sub: "profiler stop", out: /^ok / });
  r.check(existsSync(profile), "profiler wrote no file");
  const trace = join(out, "iz.json");
  S("trace start", "trace", ["trace", "start"], { sub: "trace start" });
  S("trace stop", "trace", ["trace", "stop", trace], { sub: "trace stop", out: /^ok / });
  r.check(existsSync(trace), "trace wrote no file");

  // -- cookies / storage / network ----------------------------------------------------------
  S("cookies set", "cookies", ["cookies", "set", "tok", "abc", "--url", F("form.html")], { sub: "cookies set" });
  S("cookies get", "cookies", ["cookies", "get", "--url", F("form.html")], { sub: "cookies get", out: /tok=abc/ });
  S("cookies clear", "cookies", ["cookies", "clear", "--url", F("form.html")], { sub: "cookies clear" });
  S("storage local set", "storage", ["storage", "local", "set", "k", "v"], { sub: "storage local" });
  S("storage local get", "storage", ["storage", "local", "get", "k"], { out: /^v$/ });
  S("storage session set", "storage", ["storage", "session", "set", "s", "w"], { sub: "storage session" });
  S("storage session get", "storage", ["storage", "session", "get", "s"], { out: /^w$/ });
  S("storage local clear", "storage", ["storage", "local", "clear"]);

  S("open echo", "open", ["open", F("echo?a=1&b=2#frag")]);
  S("url with & ? #", "eval", ["eval", "return location.search + '|' + location.hash"], { out: /^\?a=1&b=2\|#frag$/ });
  S("network requests", "network", ["network", "requests", "--filter", "echo"], { sub: "network requests", out: /echo/ });
  S("network clear", "network", ["network", "clear"], { sub: "network clear" });
  const har = join(out, "ag.har");
  S("network har start", "network", ["network", "har", "start", har], { sub: "network har start" });
  S("open echo for har", "open", ["open", F("echo?har=1")]);
  S("network har stop", "network", ["network", "har", "stop"], { sub: "network har stop", out: /entries/ });
  r.check(readFileSync(har, "utf8").includes('"version": "1.2"'), "har has no version 1.2");
  S("network route", "network", ["network", "route", "**/echo*", "--body", '{"mocked":true}', "--content-type", "application/json"], { sub: "network route" });
  S("open routed", "open", ["open", F("echo?routed=1")]);
  S("routed body", "text", ["text"], { out: /mocked/ });
  S("network unroute", "network", ["network", "unroute"], { sub: "network unroute" });

  // -- emulation ----------------------------------------------------------------------------
  S("set viewport", "set", ["set", "viewport", "500", "700"], { sub: "set viewport" });
  S("viewport applied", "eval", ["eval", "return [innerWidth, innerHeight]"], { out: /^\[500,700\]$/ });
  S("set viewport scale", "set", ["set", "viewport", "400", "600", "--scale", "2"], { sub: "set viewport" });
  S("scale applied", "eval", ["eval", "return devicePixelRatio"], { out: /^2$/ });
  S("set device", "set", ["set", "device", "iPhone 15"], { sub: "set device", out: /^ok$/ });
  S("set media dark", "set", ["set", "media", "dark"], { sub: "set media" });
  S("dark applied", "eval", ["eval", "return matchMedia('(prefers-color-scheme: dark)').matches"], { out: /true/ });
  S("set media light", "set", ["set", "media", "light", "--reduced-motion"], { sub: "set media" });
  S("set headers", "set", ["set", "headers", '{"X-Matrix":"a b"}'], { sub: "set headers" });
  S("open with headers", "open", ["open", F("echo?hdr=1")]);
  S("header applied", "text", ["text", "#out"], { out: /"x-matrix":"a b"/ });
  S("set geo", "set", ["set", "geo", "41", "29"], { sub: "set geo" });
  S("set offline on", "set", ["set", "offline", "on"], { sub: "set offline" });
  S("offline blocks", "open", ["open", F("form.html")], { code: 1, err: /navigation failed|ERR_INTERNET_DISCONNECTED/ });
  S("set offline off", "set", ["set", "offline", "off"], { sub: "set offline" });

  // -- diff ---------------------------------------------------------------------------------
  S("open form for diff", "open", ["open", F("form.html")]);
  const base = join(out, "base.txt");
  writeFileSync(base, S("snapshot for diff", "snapshot", ["snapshot", "-i"]));
  S("diff snapshot", "diff", ["diff", "snapshot", "-i", "--baseline", base], { sub: "diff snapshot", out: /no changes/ });
  S("diff url", "diff", ["diff", "url", F("form.html"), F("matrix.html"), "-i"], { sub: "diff url", out: /[+-]\d+/ });

  // -- dialog -------------------------------------------------------------------------------
  const dlg = { MONAD_SESSION: `${r.session}-dlg` };
  S("dialog open", "open", ["--no-auto-dialog", "open", F("dialog.html")], { env: dlg });
  S("dialog alert", "click", ["click", "#alert"], { env: dlg });
  S("dialog status", "dialog", ["dialog", "status"], { sub: "dialog status", env: dlg, out: /alert: hi/ });
  S("dialog accept", "dialog", ["dialog", "accept"], { sub: "dialog accept", env: dlg });
  S("dialog confirm", "click", ["click", "#confirm"], { env: dlg });
  S("dialog dismiss", "dialog", ["dialog", "dismiss"], { sub: "dialog dismiss", env: dlg });
  S("dialog stop", "stop", ["stop"], { env: dlg });

  // -- run ----------------------------------------------------------------------------------
  S("run inline", "run", ["run", `await goto("${F("form.html")}"); return await title()`], { out: /Fixture Form/ });
  S("run inline quoting", "run", ["run", "return 'dollar:$ tick:`'"], { out: /^dollar:\$ tick:`$/ });
  const plan = join(out, "plan dosyası.js");
  writeFileSync(plan, `const dollar = "$HOME";\nconst tick = \`tick\`;\nawait goto(${JSON.stringify(F("form.html"))});\nreturn dollar + "|" + tick + "|" + (await title());\n`);
  S("run --file", "run", ["run", "--file", plan], { out: /\$HOME\|tick\|Fixture Form/ });
  S("run - stdin", "run", ["run", "-"], { input: "return 6*7\n", out: /^42$/ });

  // -- read ---------------------------------------------------------------------------------
  S("read url", "read", ["read", F("md"), "--require-md"], { out: /# Matrix Doc/ });
  S("read --raw", "read", ["read", F("echo?raw=1"), "--raw"], { out: /<title>Echo<\/title>/ });
  S("read --outline", "read", ["read", F("matrix.html"), "--outline"], { out: /Matrix/ });
  S("read --filter", "read", ["read", F("matrix.html"), "--filter", "Matrix"], { out: /Matrix/ });
  S("read --llms", "read", ["read", F("llms.txt"), "--llms", "index"], { out: /Matrix llms/ });
  S("read active tab", "read", ["read"], { out: /Sign up/ });

  // -- mcp ----------------------------------------------------------------------------------
  const mcpInput = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "matrix", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_open", arguments: { url: F("form.html") } } },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  S("mcp handshake", "mcp", ["mcp"], { input: mcpInput, out: /"serverInfo"/, fn: (x) => {
    const lines = x.out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    r.check(lines.length === 3, `mcp returned ${lines.length} responses`);
    r.check(lines[1]?.result?.tools?.length === 14, "mcp tools/list is not 14 tools");
    r.check(/\[textbox Name\]@|textbox "Name" @/.test(lines[2]?.result?.content?.[0]?.text ?? ""), "mcp browser_open returned no snapshot");
  } });

  S("stop", "stop", ["stop"], { out: /ok stopped/ });
  S("status after stop", "status", ["status"], { out: /stopped/ });

  // -- global launch flags ------------------------------------------------------------------
  const hdr = { MONAD_SESSION: `${r.session}-hdr` };
  S("--headers json", "open", ["--headers", '{"X-Global":"g h"}', "open", F("echo?global=1")], { env: hdr });
  S("--headers applied", "text", ["text", "#out"], { env: hdr, out: /"x-global":"g h"/ });
  S("--headers stop", "stop", ["stop"], { env: hdr });

  const arg = { MONAD_SESSION: `${r.session}-args` };
  S("--args json", "open", ["--args", '["--disable-gpu"]', "open", F("form.html")], { env: arg });
  S("--args stop", "stop", ["stop"], { env: arg });

  const cfgDir = join(cwd, "ayar lar");
  mkdirSync(cfgDir, { recursive: true });
  const cfg = join(cfgDir, "config.json");
  writeFileSync(cfg, JSON.stringify({ viewport: { width: 501, height: 702 } }));
  const cfgEnv = { MONAD_SESSION: `${r.session}-cfg` };
  S("--config path with spaces", "open", ["--config", cfg, "open", F("form.html")], { env: cfgEnv });
  S("--config applied", "eval", ["eval", "return [innerWidth, innerHeight]"], { env: cfgEnv, out: /^\[501,702\]$/ });
  S("--config stop", "stop", ["stop"], { env: cfgEnv });

  // -- environment paths --------------------------------------------------------------------
  const home = join(cwd, "monad home ış");
  mkdirSync(home, { recursive: true });
  const homeEnv = { MONAD_HOME: home, MONAD_SESSION: `${r.session}-home` };
  S("MONAD_HOME with spaces", "open", ["open", F("form.html")], { env: homeEnv });
  S("MONAD_HOME stop", "stop", ["stop"], { env: homeEnv });

  const chromeDir = join(cwd, "chrome dir");
  mkdirSync(chromeDir, { recursive: true });
  let chromePath = chrome;
  if (process.platform !== "win32") {
    const link = join(chromeDir, "chrome");
    if (!existsSync(link)) symlinkSync(chrome, link);
    chromePath = link;
  }
  const chromeEnv = { MONAD_CHROME: chromePath, MONAD_SESSION: `${r.session}-chrome` };
  S("MONAD_CHROME with spaces", "open", ["open", F("form.html")], { env: chromeEnv });
  S("MONAD_CHROME stop", "stop", ["stop"], { env: chromeEnv });

  // -- session names ------------------------------------------------------------------------
  const named = "matris ış oturum";
  S("session name with space/unicode", "open", ["--session", named, "open", F("form.html")], { out: /Fixture Form/ });
  S("named session status", "status", ["--session", named, "status"], { out: /running session=matris/ });
  S("named session stop", "stop", ["--session", named, "stop"], { out: /ok stopped/ });

  // -- concurrency / stale state ------------------------------------------------------------
  S("start for concurrency", "start", ["start"]);
  await r.concurrent(["eval", "return 1"]);
  S("stop after concurrency", "stop", ["stop"]);

  const staleHome = join(cwd, "stale home");
  mkdirSync(staleHome, { recursive: true });
  writeFileSync(join(staleHome, "stale.sock"), "");
  writeFileSync(join(staleHome, "stale.pid"), "999999");
  const staleEnv = { MONAD_HOME: staleHome, MONAD_SESSION: "stale" };
  S("stale socket and pid", "open", ["open", F("form.html")], { env: staleEnv });
  S("stale stop", "stop", ["stop"], { env: staleEnv });

  // -- long path ----------------------------------------------------------------------------
  const longDir = join(cwd, "uzun", "a".repeat(50), "b".repeat(50));
  mkdirSync(longDir, { recursive: true });
  S("long path screenshot", "screenshot", ["screenshot", join(longDir, "shot.png")], { out: /^ok / });
  r.check(existsSync(join(longDir, "shot.png")), "long-path screenshot was not written");

  // -- parser boundaries --------------------------------------------------------------------
  S("repeated flag", "snapshot", ["snapshot", "--max-text", "10", "--max-text", "20"]);
  S("flag with empty value", "snapshot", ["snapshot", "--max-text="]);
  S("unknown flag", "snapshot", ["snapshot", "--not-a-flag"]);
  S("short flag cluster", "open", ["open", F("form.html"), "-is"], { out: /textbox "Name" @|\[textbox Name\]@/ });
  S("upload missing file", "upload", ["upload", "#f", join(cwd, "yok.txt")], { code: 1, err: /no such file/, emptyStdout: true });

  // -- cleanup ------------------------------------------------------------------------------
  S("stop --all", "stop", ["stop", "--all"]);
}

// --- run the matrix -------------------------------------------------------------------------

const shells = [
  ...(available("pwsh") ? ["pwsh"] : []),
  ...(process.platform === "win32" ? (available("cmd") ? ["cmd"] : []) : available("bash") ? ["bash"] : []),
];

const covered = { cmd: new Set(), sub: new Set() };

for (const shell of shells) {
  test(`matrix through ${shell}`, { skip }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mb matris ış "));
    const r = new Runner(shell, `matrix-${process.pid}-${shell}`, cwd);
    try {
      await scenario(r);
      for (const x of r.results) { covered.cmd.add(x.cmd); if (x.sub) covered.sub.add(x.sub); }
    } finally {
      r.run(["stop", "--all"]);
    }
    if (r.failures.length) {
      throw new Error(`${r.failures.length} failing steps:\n\n${r.failures.map((f) => `- ${f.id}\n${f.detail}`).join("\n\n")}`);
    }
    console.log(`${shell}: ${r.results.length} steps`);
  });
}

// --- inventory coverage ---------------------------------------------------------------------

const ALIASES = new Set(["goto", "navigate", "snap", "js", "scrollinto", "key"]);
const INVENTORY = new Set([
  ...Object.keys(COMMANDS), ...Object.keys(EXTRA_USAGE), "help", "version",
].filter((k) => !ALIASES.has(k)));

const SUBCOMMANDS = [
  "state save", "state load", "tab new", "tab close",
  "keyboard type", "keyboard inserttext", "mouse move", "mouse down", "mouse up", "mouse wheel",
  "set viewport", "set device", "set media", "set offline", "set headers", "set geo",
  "cookies get", "cookies set", "cookies clear",
  "storage local", "storage session",
  "network requests", "network clear", "network har start", "network har stop", "network route", "network unroute",
  "dialog status", "dialog accept", "dialog dismiss",
  "diff snapshot", "diff url",
  "profiler start", "profiler stop", "trace start", "trace stop",
  "skills list", "skills get", "skills path", "install-skill --dir",
];

test("matrix covers the whole command inventory", () => {
  const missing = [...INVENTORY].filter((c) => !covered.cmd.has(c));
  const missingSub = SUBCOMMANDS.filter((s) => !covered.sub.has(s));
  assert.deepEqual(missing, [], `commands missing from the matrix: ${missing.join(", ")}`);
  assert.deepEqual(missingSub, [], `subcommands missing from the matrix: ${missingSub.join(", ")}`);
});
