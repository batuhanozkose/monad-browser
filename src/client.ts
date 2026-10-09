// Client side of the daemon protocol, shared by the CLI and the MCP server.
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { socketPath, stateDir, type Response } from "./daemon.js";

const cliPath = () => new URL("./cli.js", import.meta.url).pathname;

export function request(session: string, argv: string[], timeoutMs = 120_000): Promise<Response> {
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

export async function startDaemon(session: string, launchArgv: string[]) {
  mkdirSync(stateDir(), { recursive: true });
  const log = openSync(join(stateDir(), `${session}.log`), "a");
  const self = cliPath();
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


/** Send argv to the session daemon, starting it first if needed. */
export async function call(session: string, argv: string[], launch: string[] = [], timeoutMs = 120_000): Promise<Response> {
  const up = existsSync(socketPath(session)) && (await request(session, ["status"], 3000).then(() => true, () => false));
  if (!up) await startDaemon(session, launch);
  return request(session, argv, timeoutMs);
}
