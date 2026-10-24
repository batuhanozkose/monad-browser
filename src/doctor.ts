// `doctor`: check the local install without starting a browser. `--fix` removes stale
// socket/pid files left by a daemon that was killed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { findChrome } from "./chrome.js";
import { stateDir } from "./paths.js";

const ok = (s: string) => `pass  ${s}`;
const info = (s: string) => `info  ${s}`;
const fail = (s: string) => `fail  ${s}`;

export function doctor(fix = false): string {
  const lines: string[] = ["monad-browser doctor", ""];
  const major = Number(process.versions.node.split(".")[0]);
  lines.push(major >= 22 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} (need >= 22)`));

  const chrome = findChrome();
  if (!chrome) lines.push(fail("Chrome/Chromium not found (set MONAD_CHROME or install Chrome, Edge or Chromium)"));
  else {
    lines.push(ok(`Chrome/Chromium ${chrome}`));
    if (process.platform === "win32") {
      // chrome.exe is a GUI binary: --version can open a window. Read the versioned application
      // subdirectory instead of launching it.
      try {
        const v = readdirSync(dirname(chrome)).filter((n) => /^\d+\./.test(n)).sort().at(-1);
        lines.push(v ? info(`Chrome ${v}`) : info("version check skipped on Windows"));
      } catch { lines.push(info("version check skipped on Windows")); }
    } else {
      try {
        const v = execFileSync(chrome, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
        lines.push(info(v));
      } catch { lines.push(info("could not read the Chrome version")); }
    }
  }

  const dir = stateDir();
  if (!existsSync(dir)) {
    if (fix) { try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }
    lines.push(info(`state directory does not exist yet: ${dir}`));
  } else {
    const alive = (name: string) => {
      try {
        const pid = Number(readFileSync(join(dir, `${name}.pid`), "utf8").trim());
        // PID 0 means "the current process group" to process.kill, not a dead daemon.
        if (!Number.isInteger(pid) || pid <= 0) return false;
        process.kill(pid, 0);
        return true;
      } catch { return false; }
    };
    let removed = 0;
    const stale: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".sock") && !name.endsWith(".pid")) continue;
      const session = name.replace(/\.(sock|pid)$/, "");
      if (alive(session)) continue;
      const path = join(dir, name);
      stale.push(path);
      if (fix) { try { rmSync(path, { force: true }); removed++; } catch { /* ignore */ } }
    }
    if (fix) lines.push(ok(`state directory ${dir} (${removed} stale file${removed === 1 ? "" : "s"} removed)`));
    else {
      lines.push(ok(`state directory ${dir}`));
      for (const path of stale) lines.push(info(`stale file: ${path} (run doctor --fix)`));
    }
  }

  if (process.platform !== "win32") {
    try {
      const st = statSync(dir);
      lines.push(ok(`state directory permissions ${(st.mode & 0o777).toString(8)}`));
    } catch { /* missing is already reported */ }
  }

  const cfg = join(process.cwd(), "monad-browser.json");
  lines.push(existsSync(cfg) ? ok(`project config ${cfg}`) : info("no project config (optional)"));
  lines.push("", "Run `mb start` to launch a browser.");
  return lines.join("\n");
}
