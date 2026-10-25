// `doctor`: check the local install without starting a browser. `--fix` removes stale
// socket/pid files left by a daemon that was killed.
//
// `doctor()` is the plain, machine-readable contract (and what tests/CI assert).
// `doctorReport()` is the same checks as data, used only by the TTY renderer.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { findChrome } from "./chrome.js";
import { stateDir } from "./paths.js";

export type DoctorStatus = "pass" | "info" | "fail";
export type DoctorCheck = {
  status: DoctorStatus;
  label: string;
  value: string;
  detail?: string;
};
export type DoctorReport = {
  checks: DoctorCheck[];
  footer: string;
  summary: { pass: number; info: number; fail: number };
};

const ok = (s: string) => `pass  ${s}`;
const info = (s: string) => `info  ${s}`;
const fail = (s: string) => `fail  ${s}`;

function collect(fix: boolean): { lines: string[]; report: DoctorReport } {
  const lines: string[] = ["monad-browser doctor", ""];
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) {
    lines.push(ok(`Node ${process.versions.node}`));
    checks.push({ status: "pass", label: "Node", value: process.versions.node });
  } else {
    lines.push(fail(`Node ${process.versions.node} (need >= 22)`));
    checks.push({ status: "fail", label: "Node", value: `${process.versions.node} (need >= 22)` });
  }

  const chrome = findChrome();
  if (!chrome) {
    lines.push(fail("Chrome/Chromium not found (set MONAD_CHROME or install Chrome, Edge or Chromium)"));
    checks.push({ status: "fail", label: "Chrome", value: "not found", detail: "set MONAD_CHROME or install Chrome, Edge or Chromium" });
  } else {
    lines.push(ok(`Chrome/Chromium ${chrome}`));
    let version = "";
    if (process.platform === "win32") {
      // chrome.exe is a GUI binary: --version can open a window. Read the versioned application
      // subdirectory instead of launching it.
      try {
        const v = readdirSync(dirname(chrome)).filter((n) => /^\d+\./.test(n)).sort().at(-1);
        lines.push(v ? info(`Chrome ${v}`) : info("version check skipped on Windows"));
        version = v ? `Chrome ${v}` : "";
      } catch { lines.push(info("version check skipped on Windows")); }
    } else {
      try {
        const v = execFileSync(chrome, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
        lines.push(info(v));
        version = v;
      } catch { lines.push(info("could not read the Chrome version")); }
    }
    checks.push({ status: "pass", label: "Chrome", value: version || "found", detail: chrome });
  }

  const dir = stateDir();
  if (!existsSync(dir)) {
    if (fix) { try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }
    lines.push(info(`state directory does not exist yet: ${dir}`));
    checks.push({ status: "info", label: "state directory", value: "not created yet", detail: dir });
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
    if (fix) {
      lines.push(ok(`state directory ${dir} (${removed} stale file${removed === 1 ? "" : "s"} removed)`));
      checks.push({ status: "pass", label: "state directory", value: `${removed} stale file${removed === 1 ? "" : "s"} removed`, detail: dir });
    } else {
      lines.push(ok(`state directory ${dir}`));
      checks.push({ status: "pass", label: "state directory", value: dir });
      for (const path of stale) {
        lines.push(info(`stale file: ${path} (run doctor --fix)`));
        checks.push({ status: "info", label: "stale file", value: path, detail: "run doctor --fix" });
      }
    }
  }

  if (process.platform !== "win32") {
    try {
      const st = statSync(dir);
      const mode = (st.mode & 0o777).toString(8);
      lines.push(ok(`state directory permissions ${mode}`));
      checks.push({ status: "pass", label: "permissions", value: mode });
    } catch { /* missing is already reported */ }
  }

  const cfg = join(process.cwd(), "monad-browser.json");
  if (existsSync(cfg)) {
    lines.push(ok(`project config ${cfg}`));
    checks.push({ status: "pass", label: "project config", value: cfg });
  } else {
    lines.push(info("no project config (optional)"));
    checks.push({ status: "info", label: "project config", value: "none (optional)" });
  }

  const footer = "Run `mb start` to launch a browser.";
  lines.push("", footer);
  const summary = {
    pass: checks.filter((c) => c.status === "pass").length,
    info: checks.filter((c) => c.status === "info").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
  return { lines, report: { checks, footer, summary } };
}

/** Plain contract: byte-for-byte the format CI and scripts have always seen. */
export function doctor(fix = false): string {
  return collect(fix).lines.join("\n");
}

/** Structured form for the TTY renderer. */
export function doctorReport(fix = false): DoctorReport {
  return collect(fix).report;
}
