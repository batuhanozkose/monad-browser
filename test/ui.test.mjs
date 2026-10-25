// UI renderer tests: color gating, ASCII fallback, width/wrap, help layers,
// action receipts, error format, doctor and watch styling. No Chrome needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripAnsi, uiFor } from "../dist/ui/color.js";
import { stringWidth, wrap } from "../dist/ui/width.js";
import { allHelp, commandHelp, topHelp } from "../dist/help.js";
import { renderAction, renderDiff, renderDoctor, renderError, renderSnapshot } from "../dist/ui/render.js";
import { renderWatchFire, renderWatchList, renderWatchLogs } from "../dist/ui/watch.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
const tty = (columns = 80) => ({ isTTY: true, columns });
const env = (extra = {}) => ({ TERM: "xterm-256color", MB_UNICODE: "1", ...extra });

test("uiFor turns color off for NO_COLOR, CI, TERM=dumb and pipes", () => {
  assert.equal(uiFor({ isTTY: false, columns: 80 }, env()), undefined);
  assert.equal(uiFor(tty(), env({ CI: "1" })), undefined);
  assert.equal(uiFor(tty(), env({ TERM: "dumb" })), undefined);
  const noColor = uiFor(tty(), env({ NO_COLOR: "1" }));
  assert.ok(noColor);
  assert.equal(noColor.color, false);
  assert.equal(noColor.unicode, true);
  const forced = uiFor({ isTTY: false, columns: 80 }, env({ FORCE_COLOR: "1" }));
  assert.ok(forced);
  assert.equal(forced.color, true);
});

test("Windows defaults to ASCII unless the terminal opts in", { skip: process.platform !== "win32" }, () => {
  const legacy = uiFor(tty(), { TERM: "xterm" });
  assert.ok(legacy);
  assert.equal(legacy.unicode, false);
  const wt = uiFor(tty(), { TERM: "xterm", WT_SESSION: "1" });
  assert.ok(wt);
  assert.equal(wt.unicode, true);
});

test("help map is 13 lines and lists watch without ANSI when color is off", () => {
  const text = topHelp();
  assert.equal(text.split("\n").length, 13);
  assert.match(text, /usage: mb/);
  assert.match(text, /WATCH\s+watch add list check remove logs run/);
  assert.match(text, /mb help --all/);
  assert.doesNotMatch(text, /\x1b\[/);
});

test("ASCII fallback removes UI glyphs but keeps the same words", () => {
  const ui = uiFor(tty(), env({ MB_ASCII: "1" }));
  assert.ok(ui);
  const text = stripAnsi(topHelp(ui));
  assert.doesNotMatch(text, /[✓✗→·─…]/);
  assert.match(text, /mb - headless browser for agents/);
  assert.match(text, /mb <command> --help for flags - mb help --all/);
  assert.doesNotMatch(text, /[^\x00-\x7F]/);
});

test("command help starts with usage and includes flags, examples and the PowerShell note", () => {
  const snapshot = commandHelp("snapshot");
  assert.ok(snapshot?.startsWith("usage: mb snapshot"));
  assert.match(snapshot, /FLAGS/);
  assert.match(snapshot, /--max-lines/);
  assert.match(snapshot, /EXAMPLES/);
  assert.match(snapshot, /mb snapshot -i/);

  const click = commandHelp("click");
  assert.ok(click?.startsWith("usage: mb click"));
  assert.match(click, /PowerShell: a bare @12 is splatting/);
  assert.match(click, /mb click @7 -s/);

  const watch = commandHelp("watch");
  assert.ok(watch?.startsWith("usage: mb watch"));
  assert.match(watch, /conditions:/);
  assert.ok(watch.split("\n").every((line) => line.length <= 80), "watch help should wrap at 80");
});

test("full help keeps every group and aliases", () => {
  const text = allHelp();
  assert.match(text, /^PAGE$/m);
  assert.match(text, /^WATCH$/m);
  assert.match(text, /^DAEMON$/m);
  assert.match(text, /aliases: goto/);
  assert.match(text, /PowerShell/);
  assert.ok(text.split("\n").every((line) => line.length <= 80));
});

test("stringWidth handles CJK, emoji and combining marks", () => {
  assert.equal(stringWidth("abc"), 3);
  assert.equal(stringWidth("日本語"), 6);
  assert.equal(stringWidth("e\u0301"), 1);
  assert.equal(stringWidth("👋"), 2);
});

test("wrap keeps refs and quoted names atomic", () => {
  const lines = wrap('  - [button Open]@13 value="us-east-1 (Virginia)" and more text', {
    width: 40, indent: "  ", hanging: "    ", breakLong: true,
  });
  assert.ok(lines.length > 1);
  assert.ok(lines.some((l) => l.includes("[button Open]@13")));
  assert.ok(lines.some((l) => l.includes('"us-east-1 (Virginia)"')));
});

test("snapshot keeps the tree, wraps prose and never frames it", () => {
  const ui = uiFor(tty(60), env());
  assert.ok(ui);
  const raw = `# Acme — https://example.com/
- banner
  - [button Open]@13
  - Ship a container to the edge in under a minute. No cluster to manage, no YAML to write.`;
  const text = stripAnsi(renderSnapshot(raw, ui));
  assert.match(text, /Acme/);
  assert.match(text, /https:\/\/example.com/);
  assert.match(text, /\[button Open\]@13/);
  assert.match(text, /No\s+cluster/);
  assert.doesNotMatch(text, /[┌╭┐╮└╰┘╯]/);
  assert.ok(text.split("\n").every((line) => stringWidth(line) <= 60), "snapshot should fit the terminal");
});

test("diff renders stats, +/-, refs and a word highlight", () => {
  const ui = uiFor(tty(80), env());
  assert.ok(ui);
  const raw = `# Acme — https://example.com/
(diff rev 2→3: +1 -1, 25 unchanged)
    - form
-     - button "Deploy service" @12
+     - button "Deploying…" @12`;
  const text = renderDiff(raw, ui);
  assert.match(text, /diff/);
  assert.match(text, /rev 2→3/);
  assert.match(text, /\+1/);
  assert.match(text, /25 unchanged/);
  assert.match(text, /Deploying/);
  assert.match(text, /@12/);
  assert.match(text, /\x1b\[/);
});

test("action receipt is one line, then a diff with -s", () => {
  const ui = uiFor(tty(80), env());
  assert.ok(ui);
  const single = stripAnsi(renderAction("ok clicked @12 — https://example.com/", ui, 47));
  assert.match(single, /^✓ clicked @12 · https:\/\/example.com\/ · 47ms$/);
  assert.doesNotMatch(single, /^ok /);
  const withDiff = stripAnsi(renderAction("ok clicked @12 — https://example.com/\n# Acme — https://example.com/\n(diff rev 1→2: +1 -1, 3 unchanged)\n- old\n+ new", ui, 47));
  assert.match(withDiff, /^✓ clicked @12/);
  assert.match(withDiff, /diff/);
  assert.match(withDiff, /\+1/);
  assert.match(withDiff, /\+ new/);
});

test("errors are three lines with a next command", () => {
  const ui = uiFor(tty(80), env());
  assert.ok(ui);
  const text = stripAnsi(renderError("click", "unknown ref @999 — take a fresh snapshot", ui));
  const lines = text.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^✗ error unknown ref @999/);
  assert.match(lines[1], /Take a fresh snapshot\./);
  assert.match(lines[2], /→ mb snapshot/);
  const usage = stripAnsi(renderError("fill", "usage: fill <@ref|selector> <text>\nmissing target — quote it", ui));
  assert.match(usage, /mb fill --help/);
});

test("doctor renders PASS/INFO rows and a next command", () => {
  const ui = uiFor(tty(80), env());
  assert.ok(ui);
  const text = renderDoctor({
    checks: [
      { status: "pass", label: "Node", value: "26.12.1" },
      { status: "pass", label: "Chrome", value: "Chrome for Testing 156", detail: "/path/to/chrome" },
      { status: "info", label: "project config", value: "none (optional)" },
    ],
    footer: "Run `mb start` to launch a browser.",
    summary: { pass: 2, info: 1, fail: 0 },
  }, ui);
  assert.match(text, /monad-browser doctor/);
  assert.match(text, /PASS/);
  assert.match(text, /INFO/);
  assert.match(text, /2 passed/);
  assert.match(text, /→ mb start/);
});

test("watch list, fire and logs use the same palette", () => {
  const ui = uiFor(tty(80), env());
  assert.ok(ui);
  const now = Date.now();
  const watch = {
    name: "demo-status", kind: "page", source: "https://example.com/status", extract: { mode: "css", selector: "#status" },
    condition: { op: "changed" }, everySeconds: 300, render: false, notify: false, cwd: "/tmp",
    enabled: true, createdAt: now, updatedAt: now, nextCheckAt: now + 60_000,
    lastValue: "DOWN", lastHash: "x", consecutiveErrors: 0, totalFires: 1, lastFiredAt: now - 60_000,
  };
  const list = renderWatchList([watch], ui);
  assert.match(list, /demo-status/);
  assert.match(list, /page/);
  assert.match(list, /every 5m/);
  assert.match(list, /ok/);

  const outcome = {
    name: "demo-status", kind: "page", source: "https://example.com/status", condition: { op: "changed" },
    at: now, ok: true, fired: true, changed: true, previous: "UP", next: "DOWN",
    diff: "UP → DOWN", nextCheckAt: now + 300_000, backoffMs: 0,
  };
  const fire = stripAnsi(renderWatchFire(outcome, ui));
  assert.match(fire, /demo-status fired/);
  assert.match(fire, /UP/);
  assert.match(fire, /DOWN/);
  assert.match(fire, /diff/);

  const logs = renderWatchLogs([{ name: "demo-status", event: { at: now, kind: "fired", summary: "UP → DOWN" } }], ui);
  assert.match(logs, /demo-status/);
  assert.match(logs, /fired/);
});

test("help honors NO_COLOR and FORCE_COLOR through the real CLI", () => {
  const base = { ...process.env, TERM: "xterm-256color", MB_UNICODE: "1" };
  const off = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8", env: { ...base, NO_COLOR: "1", FORCE_COLOR: "" }, timeout: 20_000,
  });
  assert.equal(off.status, 0, off.stderr);
  assert.doesNotMatch(off.stdout, /\x1b\[/);
  assert.match(off.stdout, /usage: mb/);

  const on = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8", env: { ...base, NO_COLOR: "", FORCE_COLOR: "1" }, timeout: 20_000,
  });
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /\x1b\[/);
});

test("watch --json stays byte-clean with FORCE_COLOR", () => {
  const home = mkdtempSync(join(tmpdir(), "mb-ui-json-"));
  try {
    const r = spawnSync(process.execPath, [cli, "watch", "list", "--json"], {
      encoding: "utf8",
      env: { ...process.env, MONAD_HOME: home, FORCE_COLOR: "1", NO_COLOR: "" },
      timeout: 20_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /\x1b\[/);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(parsed, { watches: [] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
