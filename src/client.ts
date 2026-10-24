// Client side of the daemon protocol, shared by the CLI and the MCP server.
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { openSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { socketPath, stateDir, type Response } from "./paths.js";

const cliPath = () => fileURLToPath(new URL("./cli.js", import.meta.url));

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
  const logPath = join(stateDir(), `${session}.log`);
  const log = openSync(logPath, "a");
  const self = cliPath();
  const child = spawn(process.execPath, [self, "__daemon", session, ...launchArgv], {
    detached: true, stdio: ["ignore", log, log, "ipc"], env: process.env, windowsHide: true,
  });
  const tail = () => {
    try { return readFileSync(logPath, "utf8").trim().split("\n").slice(-25).join("\n"); }
    catch { return ""; }
  };
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`daemon did not start in 60s — see ${logPath}${tail() ? `\n${tail()}` : ""}`)), 60_000);
    child.once("message", () => { clearTimeout(t); resolve(); });
    child.once("error", (e) => { clearTimeout(t); reject(e); });
    child.once("exit", (code) => {
      clearTimeout(t);
      // 0 means another daemon won the session lock; the caller reconnects to it.
      if (code === 0) resolve();
      else reject(new Error(`daemon exited (${code}) — see ${logPath}${tail() ? `\n${tail()}` : ""}`));
    });
  });
  child.disconnect();
  child.unref();
}


/** Send argv to the session daemon, starting it first if needed. */
export async function call(session: string, argv: string[], launch: string[] = [], timeoutMs = 120_000): Promise<Response> {
  // Optimistic: one round trip when the daemon is up; start it only if nobody is listening.
  try { return await request(session, argv, timeoutMs); }
  catch (e) { if (!notListening(e)) throw e; }
  await startDaemon(session, launch);
  return request(session, argv, timeoutMs);
}

export const notListening = (e: any) => ["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(e?.code);
