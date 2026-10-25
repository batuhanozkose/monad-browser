// Thin client: forwards argv to the session daemon, starting it on first use.
// Only paths + client load on the hot path; the browser, commands and MCP code load lazily.
import { existsSync, readdirSync } from "node:fs";
import { assertSession, socketPath, stateDir } from "./paths.js";
import { request, startDaemon, notListening } from "./client.js";
import { loadConfig, type Config } from "./config.js";
import { paint, uiFor } from "./ui/color.js";
import { renderAction, renderDoctor, renderError, renderOutput, renderSessions } from "./ui/render.js";

const LAUNCH_FLAGS = new Set([
  "cdp", "headful", "profile", "block", "chrome", "idle", "proxy", "headers", "user-agent",
  "ignore-https-errors", "init-script", "download-path", "color-scheme", "viewport", "extension",
  "args", "no-auto-dialog",
]);
const BOOL_LAUNCH = new Set(["headful", "ignore-https-errors", "no-auto-dialog"]);
const STDOUT_UI = uiFor(process.stdout);
const STDERR_UI = uiFor(process.stderr);

/** --json is a contract: never let the TTY renderer touch it. */
function wantsJson(argv: string[]): boolean {
  for (const a of argv) {
    if (a === "--") break;
    if (a === "--json" || a.startsWith("--json=")) return true;
  }
  return false;
}

const splitList = (v: unknown) => typeof v === "string" ? v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : [];

function parseViewport(v: unknown): { width: number; height: number; scale?: number } | undefined {
  if (typeof v !== "string") return undefined;
  const [w, h, s] = v.split("x").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(`--viewport expects WxH or WxHxSCALE, got ${v}`);
  return { width: w, height: h, scale: Number.isFinite(s) ? s : undefined };
}

function configLaunch(cfg: Config): string[] {
  const out: string[] = [];
  if (cfg.chrome) out.push("--chrome", cfg.chrome);
  if (cfg.headful) out.push("--headful");
  if (cfg.idleMinutes !== undefined) out.push("--idle", String(cfg.idleMinutes));
  if (cfg.block?.length) out.push("--block", cfg.block.join(","));
  if (cfg.proxy) out.push("--proxy", cfg.proxy);
  if (cfg.headers && Object.keys(cfg.headers).length) out.push("--headers", JSON.stringify(cfg.headers));
  if (cfg.userAgent) out.push("--user-agent", cfg.userAgent);
  if (cfg.ignoreHttpsErrors) out.push("--ignore-https-errors");
  if (cfg.initScripts?.length) out.push("--init-script", cfg.initScripts.join(","));
  if (cfg.downloadPath) out.push("--download-path", cfg.downloadPath);
  if (cfg.colorScheme) out.push("--color-scheme", cfg.colorScheme);
  if (cfg.viewport) out.push("--viewport", `${cfg.viewport.width}x${cfg.viewport.height}${cfg.viewport.scale ? `x${cfg.viewport.scale}` : ""}`);
  if (cfg.autoDialog === false) out.push("--no-auto-dialog");
  if (cfg.extraArgs?.length) out.push("--args", JSON.stringify(cfg.extraArgs));
  return out;
}

async function liveSessions() {
  if (!existsSync(stateDir())) return [];
  const names = readdirSync(stateDir()).filter((f) => f.endsWith(".pid")).map((f) => f.slice(0, -4));
  const live: string[] = [];
  for (const n of names) { try { await request(n, ["status"], 2000); live.push(n); } catch { /* stale */ } }
  return live;
}
async function listSessions() {
  const live = await liveSessions();
  if (!live.length) return "no sessions running";
  const out: string[] = [];
  for (const n of live) {
    const r = await request(n, ["status"], 2000).catch(() => null);
    const first = r?.out?.split("\n").find((l) => l.includes("*")) ?? "";
    out.push(`${n}\t${first.replace(/^\s*\*?\s*/, "")}`);
  }
  return out.join("\n");
}

async function main() {
  let argv = process.argv.slice(2);
  if (argv[0] === "__daemon") {
    const [, session, ...rest] = argv;
    const [{ parseArgs }, { runDaemon }] = await Promise.all([import("./commands.js"), import("./daemon.js")]);
    const { flags } = parseArgs(rest);
    const initScripts = splitList(flags["init-script"]);
    let extraArgs = splitList(flags.args);
    if (typeof flags.args === "string" && flags.args.trim().startsWith("[")) {
      try { extraArgs = JSON.parse(flags.args); } catch { /* fall back to the comma list */ }
    }
    for (const ext of splitList(flags.extension)) extraArgs.push(`--load-extension=${ext}`);
    const headers = typeof flags.headers === "string" ? JSON.parse(flags.headers) : undefined;
    await runDaemon(session, {
      cdpEndpoint: flags.cdp as string | undefined,
      headful: !!flags.headful,
      userDataDir: flags.profile as string | undefined,
      executable: flags.chrome as string | undefined,
      block: typeof flags.block === "string" ? flags.block.split(",") : [],
      proxy: flags.proxy as string | undefined,
      headers,
      userAgent: flags["user-agent"] as string | undefined,
      ignoreHttpsErrors: !!flags["ignore-https-errors"],
      initScripts: initScripts.length ? initScripts : undefined,
      downloadPath: flags["download-path"] as string | undefined,
      colorScheme: (flags["color-scheme"] as any) || undefined,
      viewport: parseViewport(flags.viewport),
      autoDialog: flags["no-auto-dialog"] ? false : undefined,
      extraArgs: extraArgs.length ? extraArgs : undefined,
      idleMinutes: flags.idle !== undefined ? Number(flags.idle) : undefined,
      watchOnly: !!flags["watch-only"],
    });
    return;
  }

  // Config may be selected before the command; CLI flags still win over its values. Stop at the
  // first non-option so a command's own `--config` argument is not mistaken for the global one.
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" || !a.startsWith("--")) break;
    const [k, v] = a.slice(2).split("=", 2);
    if (k === "config") { configPath = v ?? argv[i + 1]; break; }
    if (v === undefined && (k === "session" || (LAUNCH_FLAGS.has(k) && !BOOL_LAUNCH.has(k)))) i++;
  }
  const cfg = loadConfig(process.cwd(), configPath);
  if (cfg.noSandbox) process.env.MONAD_NO_SANDBOX = "1";
  if (cfg.snapshotCacheMs !== undefined) process.env.MONAD_SNAPSHOT_CACHE_MS = String(cfg.snapshotCacheMs);
  if (cfg.actionTimeout !== undefined) process.env.MONAD_ACTION_TIMEOUT = String(cfg.actionTimeout);
  if (cfg.screenshotDir) process.env.MONAD_SCREENSHOT_DIR = cfg.screenshotDir;
  if (cfg.screenshotFormat) process.env.MONAD_SCREENSHOT_FORMAT = cfg.screenshotFormat;
  if (cfg.screenshotQuality !== undefined) process.env.MONAD_SCREENSHOT_QUALITY = String(cfg.screenshotQuality);
  if (cfg.watchNotifyUrl) process.env.MONAD_WATCH_NOTIFY_URL = cfg.watchNotifyUrl;

  // Global options come before the command.
  let session = process.env.MONAD_SESSION || "default";
  const launch: string[] = configLaunch(cfg);
  while (argv[0]?.startsWith("--")) {
    const [k, v] = argv[0].slice(2).split("=", 2);
    if (k === "session") { session = v ?? argv[1]; argv = argv.slice(v ? 1 : 2); continue; }
    if (k === "config") { argv = argv.slice(v ? 1 : 2); continue; }
    if (k === "help") break;
    if (LAUNCH_FLAGS.has(k)) {
      if (BOOL_LAUNCH.has(k)) { launch.push(`--${k}`); argv = argv.slice(1); continue; }
      const val = v ?? argv[1];
      if (val === undefined) throw new Error(`--${k} needs a value`);
      launch.push(`--${k}`, val);
      argv = argv.slice(v ? 1 : 2);
      continue;
    }
    break;
  }
  assertSession(session);
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    const { allHelp, commandHelp, topHelp } = await import("./help.js");
    if ((cmd === "help" || cmd === "--help") && (argv[1] === "--all" || argv.includes("--all"))) {
      console.log(allHelp(STDOUT_UI));
      return;
    }
    if (cmd === "help" && argv[1]) {
      const help = commandHelp(argv[1], STDOUT_UI);
      if (help) { console.log(help); return; }
      throw new Error(`unknown command: ${argv[1]}\n\nRun mb help --all for every command.`);
    }
    console.log(topHelp(STDOUT_UI));
    return;
  }
  const helpArgs = argv.slice(1);
  const dash = helpArgs.indexOf("--");
  const wantsHelp = (dash < 0 ? helpArgs : helpArgs.slice(0, dash)).some((a) => a === "--help" || a === "-h");
  if (wantsHelp) {
    const { commandHelp } = await import("./help.js");
    const help = commandHelp(cmd, STDOUT_UI);
    if (help) { console.log(help); return; }
  }
  if (cmd === "--version" || cmd === "version") { const { VERSION } = await import("./version.js"); console.log(`monad-browser ${VERSION}`); return; }

  if (cmd === "doctor") {
    const { doctor, doctorReport } = await import("./doctor.js");
    console.log(STDOUT_UI ? renderDoctor(doctorReport(argv.includes("--fix")), STDOUT_UI) : doctor(argv.includes("--fix")));
    return;
  }
  if (cmd === "skills") {
    const { listSkills, getSkill, skillPath } = await import("./skill.js");
    const sub = argv[1] ?? "list";
    if (sub === "list") { console.log(listSkills()); return; }
    if (sub === "get") { console.log(getSkill(argv[2] ?? "core")); return; }
    if (sub === "path") { console.log(skillPath(argv[2] ?? "core")); return; }
    throw new Error("usage: mb skills list | mb skills get <name> | mb skills path [name]");
  }
  if (cmd === "read") {
    const { parseArgs } = await import("./commands.js");
    const { args, flags } = parseArgs(argv.slice(1));
    if (args[0]) {
      const { readUrl } = await import("./read.js");
      const out = await readUrl(args[0], {
        raw: !!flags.raw, requireMd: !!flags["require-md"], outline: !!flags.outline,
        filter: typeof flags.filter === "string" ? flags.filter : undefined,
        llms: flags.llms === "index" || flags.llms === "full" ? flags.llms : undefined,
        timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) : undefined,
      });
      process.stdout.write(out.endsWith("\n") ? out : out + "\n");
      return;
    }
  }

  if (cmd === "watch") {
    const { runWatchCommand } = await import("./watch-cli.js");
    const result = await runWatchCommand(argv.slice(1), { cwd: process.cwd(), ui: wantsJson(argv) ? undefined : STDOUT_UI });
    if (result.out) process.stdout.write(result.out.endsWith("\n") ? result.out : result.out + "\n");
    if (result.exitCode !== undefined) process.exitCode = result.exitCode;
    if (result.startDaemon) {
      try {
        // Reuse a warm session; otherwise start a watch-only daemon (no Chrome until a browser
        // command arrives). The scheduler must outlive this CLI process.
        try { await request(session, ["status"], 2000); }
        catch { await startDaemon(session, [...launch, "--watch-only"]); }
      } catch (e: any) {
        process.stderr.write(`warning: watcher saved but the scheduler did not start: ${e?.message ?? e}\n`);
        process.exitCode = 1;
      }
    }
    return;
  }

  if (cmd === "mcp") { const { runMcp } = await import("./mcp.js"); await runMcp(session, launch); return; }
  if (cmd === "install-skill") { const { installSkill } = await import("./skill.js"); console.log(installSkill(argv.slice(1))); return; }
  if (cmd === "sessions") {
    const text = await listSessions();
    console.log(STDOUT_UI ? renderSessions(text, STDOUT_UI) : text);
    return;
  }
  if (cmd === "stop" && argv[1] === "--all") {
    for (const s of await liveSessions()) {
      await request(s, ["stop"], 5000).catch(() => {});
      const out = `ok stopped ${s}`;
      console.log(STDOUT_UI ? renderAction(out, STDOUT_UI) : out);
    }
    return;
  }
  const alive = async () => { try { await request(session, ["status"], 3000); return true; } catch { return false; } };
  if (cmd === "start") {
    const rest = argv.slice(1);
    if (await alive()) { console.log(STDOUT_UI ? paint(STDOUT_UI, `already running (session ${session})`, "dim") : `already running (session ${session})`); return; }
    await startDaemon(session, [...launch, ...rest]);
    const out = `ok started session ${session}`;
    console.log(STDOUT_UI ? renderAction(out, STDOUT_UI) : out);
    return;
  }
  if (cmd === "run" && (argv[1] === "-" || (argv.length === 1 && !process.stdin.isTTY))) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    argv = ["run", "--", Buffer.concat(chunks).toString("utf8")];
  }
  // Optimistic: a warm daemon costs exactly one round trip; start it only when nobody is listening.
  const timeout = cmd === "run" ? 600_000 : 120_000;
  let res;
  try { res = await request(session, argv, timeout); }
  catch (e) {
    // status/stop are lifecycle questions: a daemon that vanished between connect and write
    // (EPIPE on an idle shutdown) is simply not running.
    if (cmd === "stop" || cmd === "status") {
      const out = cmd === "stop" ? "not running" : "stopped";
      console.log(STDOUT_UI ? paint(STDOUT_UI, out, "dim") : out);
      return;
    }
    if (!notListening(e)) throw e;
    await startDaemon(session, launch);
    res = await request(session, argv, timeout);
  }
  if (res.ok) {
    if (res.out) {
      const out = STDOUT_UI && !wantsJson(argv) ? renderOutput(cmd, argv, res.out, STDOUT_UI, res.ms) : res.out;
      process.stdout.write(out.endsWith("\n") ? out : out + "\n");
    }
  } else {
    const out = STDERR_UI ? renderError(cmd, res.error ?? "unknown error", STDERR_UI) : `error: ${res.error}`;
    process.stderr.write(out.endsWith("\n") ? out : out + "\n");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  const message = e?.message ?? String(e);
  const out = STDERR_UI ? renderError(undefined, message, STDERR_UI) : `error: ${message}`;
  process.stderr.write(out.endsWith("\n") ? out : out + "\n");
  process.exit(1);
});
