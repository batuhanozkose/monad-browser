#!/usr/bin/env node
// Thin client: forwards argv to the session daemon, starting it on first use.
import { existsSync, readdirSync } from "node:fs";
import { socketPath, stateDir, runDaemon } from "./daemon.js";
import { request, startDaemon } from "./client.js";
import { helpText, parseArgs } from "./commands.js";

const LAUNCH_FLAGS = ["cdp", "headful", "profile", "block", "chrome", "idle", "proxy"];

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

  if (cmd === "mcp") { const { runMcp } = await import("./mcp.js"); await runMcp(session, launch); return; }
  if (cmd === "install-skill") { const { installSkill } = await import("./skill.js"); console.log(installSkill(argv.slice(1))); return; }
  if (cmd === "sessions") { console.log(await listSessions()); return; }
  if (cmd === "stop" && argv[1] === "--all") {
    for (const s of await liveSessions()) { await request(s, ["stop"], 5000).catch(() => {}); console.log(`ok stopped ${s}`); }
    return;
  }
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
  if (cmd === "run" && (argv[1] === "-" || (argv.length === 1 && !process.stdin.isTTY))) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    argv = ["run", "--", Buffer.concat(chunks).toString("utf8")];
  }
  const res = await request(session, argv, cmd === "run" ? 600_000 : 120_000);
  if (res.ok) { if (res.out) process.stdout.write(res.out.endsWith("\n") ? res.out : res.out + "\n"); }
  else { process.stderr.write(`error: ${res.error}\n`); process.exitCode = 1; }
}

main().catch((e) => { process.stderr.write(`error: ${e?.message ?? e}\n`); process.exit(1); });
