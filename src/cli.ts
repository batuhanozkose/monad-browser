#!/usr/bin/env node
// Thin client: forwards argv to the session daemon, starting it on first use.
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { socketPath, stateDir, runDaemon, type Response } from "./daemon.js";
import { helpText, parseArgs } from "./commands.js";

function request(session: string, argv: string[], timeoutMs = 120_000): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath(session));
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`timeout after ${timeoutMs}ms`)); }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ argv, cwd: process.cwd() }) + "\n"));
    sock.on("data", (d) => (buf += d.toString()));
    sock.on("end", () => { clearTimeout(timer); try { resolve(JSON.parse(buf)); } catch { reject(new Error("bad daemon response")); } });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function startDaemon(session: string, launchArgv: string[]) {
  mkdirSync(stateDir(), { recursive: true });
  const log = openSync(join(stateDir(), `${session}.log`), "a");
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, "__daemon", session, ...launchArgv], {
    detached: true, stdio: ["ignore", log, log, "ipc"], env: process.env,
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`daemon did not start in 30s — see ${join(stateDir(), session + ".log")}`)), 30_000);
    child.once("message", () => { clearTimeout(t); resolve(); });
    child.once("exit", (code) => { clearTimeout(t); reject(new Error(`daemon exited (${code}) — see ${join(stateDir(), session + ".log")}`)); });
  });
  child.disconnect();
  child.unref();
}

const LAUNCH_FLAGS = ["cdp", "headful", "profile", "block", "chrome", "idle", "proxy"];

async function main() {
  let argv = process.argv.slice(2);
  if (argv[0] === "__daemon") {
    const [, session, ...rest] = argv;
    const { flags } = parseArgs(rest);
    await runDaemon(session, {
      cdpEndpoint: flags.cdp as string | undefined,
      headful: !!flags.headful,
      userDataDir: flags.profile as string | undefined,
      executable: flags.chrome as string | undefined,
      block: typeof flags.block === "string" ? flags.block.split(",") : [],
      proxy: flags.proxy as string | undefined,
      idleMinutes: flags.idle !== undefined ? Number(flags.idle) : undefined,
    });
    return;
  }

  // Global options come before the command.
  let session = process.env.MONAD_SESSION || "default";
  const launch: string[] = [];
  while (argv[0]?.startsWith("--")) {
    const [k, v] = argv[0].slice(2).split("=", 2);
    if (k === "session") { session = v ?? argv[1]; argv = argv.slice(v ? 1 : 2); continue; }
    if (LAUNCH_FLAGS.includes(k)) {
      if (k === "headful") { launch.push("--headful"); argv = argv.slice(1); }
      else { launch.push(`--${k}`, v ?? argv[1]); argv = argv.slice(v ? 1 : 2); }
      continue;
    }
    if (k === "help") break;
    break;
  }
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(helpText()); return; }
  if (cmd === "--version" || cmd === "version") { console.log("monad-browser 0.1.0-alpha.0"); return; }

  const alive = async () => { try { await request(session, ["status"], 3000); return true; } catch { return false; } };
  if (cmd === "start") {
    const rest = argv.slice(1);
    if (await alive()) { console.log(`already running (session ${session})`); return; }
    await startDaemon(session, [...launch, ...rest]);
    console.log(`ok started session ${session}`);
    return;
  }
  if (cmd === "stop" || cmd === "status") {
    if (!(process.platform === "win32" || existsSync(socketPath(session))) || !(await alive())) { console.log(cmd === "stop" ? "not running" : "stopped"); return; }
  } else if (!(await alive())) {
    await startDaemon(session, launch);
  }
  const res = await request(session, argv);
  if (res.ok) { if (res.out) process.stdout.write(res.out.endsWith("\n") ? res.out : res.out + "\n"); }
  else { process.stderr.write(`error: ${res.error}\n`); process.exitCode = 1; }
}

main().catch((e) => { process.stderr.write(`error: ${e?.message ?? e}\n`); process.exit(1); });
