// Cross-shell end-to-end: runs the real `mb` through pwsh, cmd and bash against example.com.
// The Windows job is the one that matters most: PowerShell parses `@12` as splatting and drops it
// before the CLI starts, so a ref must survive as `'@12'`, as the plain number `12`, or (in cmd) as
// `@12`. This test drives every one of those forms through an actual shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "../dist/chrome.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const install = process.argv.includes("--install");
const chromeSkip = !findChrome() && "no Chrome found";

const quotePwsh = (s) => `'${s.replaceAll("'", "''")}'`;
const quoteBash = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const quoteCmd = (s) => (/^[\w@.=:+-]+$/.test(s) ? s : `"${s.replaceAll('"', '""')}"`);
const forceCmd = (s) => `"${s.replaceAll('"', '""')}"`;

const SHELLS = {
  pwsh: {
    file: "pwsh", args: (line) => ["-NoProfile", "-NonInteractive", "-Command", line],
    quote: quotePwsh, force: quotePwsh,
  },
  bash: {
    file: "bash", args: (line) => ["-c", line],
    quote: quoteBash, force: quoteBash,
  },
  cmd: {
    file: "cmd", args: (line) => ["/d", "/s", "/c", line],
    quote: quoteCmd, force: forceCmd,
  },
};

/** A real `mb` shim installed under a throwaway prefix, so PATH points at the npm-generated one. */
function installMb() {
  const prefix = mkdtempSync(join(tmpdir(), "mb-shell-prefix-"));
  const r = spawnSync("npm link", {
    cwd: root, encoding: "utf8", shell: true,
    env: { ...process.env, npm_config_prefix: prefix },
  });
  assert.equal(r.status, 0, `npm link failed:\n${r.stdout}\n${r.stderr}`);
  return process.platform === "win32" ? prefix : join(prefix, "bin");
}

const binDir = !chromeSkip && install ? installMb() : undefined;
const baseEnv = binDir
  ? { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` }
  : { ...process.env };

// cmd commands run from a batch file (see run); keep them in one throwaway directory.
const cmdDir = process.platform === "win32" ? mkdtempSync(join(tmpdir(), "mb-cmd-")) : undefined;
let cmdSeq = 0;
if (cmdDir) process.on("exit", () => rmSync(cmdDir, { recursive: true, force: true }));

function available(shell) {
  const s = SHELLS[shell];
  const r = spawnSync(s.file, s.args("exit 0"), { encoding: "utf8" });
  return !r.error && r.status === 0;
}

/** Run one `mb` command line through a shell. `{ quoted }` forces quoting, `{ raw }` opts out. */
function run(shell, session, argv) {
  const s = SHELLS[shell];
  const line = ["mb", ...argv.map((a) => {
    if (typeof a === "string") return s.quote(a);
    return a.raw !== undefined ? a.raw : s.force(a.quoted);
  })].join(" ");
  const opts = {
    encoding: "utf8", timeout: 120_000,
    env: { ...baseEnv, MONAD_SESSION: session, MONAD_NO_SANDBOX: process.env.MONAD_NO_SANDBOX ?? "1" },
  };
  // `cmd /s /c "<line>"` keeps inner quotes literally, so a URL arrives as "https://…". Writing the
  // line to a batch file removes that extra quoting layer and is still real cmd parsing.
  let r;
  if (shell === "cmd") {
    const file = join(cmdDir, `step-${++cmdSeq}.cmd`);
    writeFileSync(file, `@echo off\r\n${line}\r\n`);
    r = spawnSync("cmd", ["/d", "/c", file], opts);
  } else {
    r = spawnSync(s.file, s.args(line), opts);
  }
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), error: r.error, line };
}

const refOf = (snapshot) => {
  const m = /@(\d+)/.exec(snapshot);
  assert.ok(m, `snapshot printed no @ref:\n${snapshot}`);
  return m[1];
};

const URL = "https://example.com";

function scenario(shell) {
  const session = `shell-${process.pid}-${shell}`;
  const ok = (argv) => {
    const r = run(shell, session, argv);
    assert.equal(r.code, 0, `${shell}: \`${r.line}\` failed\n${r.out}\n${r.err}${r.error ? `\n${r.error}` : ""}`);
    return r.out;
  };

  try {
    const first = refOf(ok(["open", URL, "-s", "-i"]));

    // Quoted ref: `'@12'` in pwsh/bash, `"@12"` in cmd.
    assert.match(ok(["click", { quoted: `@${first}` }, "-s"]), /^ok clicked/);
    assert.match(ok(["url"]), /iana\.org/);

    // Bare numeric ref: the same target without the `@`, which no shell rewrites.
    const second = refOf(ok(["open", URL, "-s", "-i"]));
    assert.match(ok(["click", second, "-s"]), /^ok clicked/);
    assert.match(ok(["url"]), /iana\.org/);

    // An unquoted @ref: PowerShell drops it, so mb must explain the fix. cmd/bash pass it through.
    const third = refOf(ok(["open", URL, "-s", "-i"]));
    const bare = run(shell, session, ["click", { raw: `@${third}` }, "-s"]);
    if (shell === "pwsh") {
      assert.equal(bare.code, 1, `pwsh: a bare @ref should not reach mb\n${bare.out}`);
      assert.match(bare.err, /missing target/);
      assert.match(bare.err, /quote it \('@12'\) or pass the number \(12\)/);
    } else {
      assert.equal(bare.code, 0, `${shell}: a bare @ref should work\n${bare.err}`);
      assert.match(bare.out, /^ok clicked/);
    }

    ok(["open", URL]);
    assert.match(ok(["read"]), /domain/i);
    assert.ok(ok(["find", "role", "link", "text"]).length > 0, `${shell}: mb find returned nothing`);
    assert.match(ok(["stop"]), /ok stopped/);
  } finally {
    run(shell, session, ["stop"]);
  }
}

const shells = [
  ...(available("pwsh") ? ["pwsh"] : []),
  ...(process.platform === "win32" ? (available("cmd") ? ["cmd"] : []) : available("bash") ? ["bash"] : []),
];

assert.ok(shells.length > 0, "no usable shell found");

for (const shell of shells) {
  test(`real mb through ${shell}`, { skip: chromeSkip }, () => scenario(shell));
}
