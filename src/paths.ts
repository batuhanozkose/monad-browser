// Tiny module shared by the thin client and the daemon: keep it import-free so `mb` starts fast.
import { homedir } from "node:os";
import { join } from "node:path";

export const stateDir = () => process.env.MONAD_HOME || join(homedir(), ".monad-browser");
export const socketPath = (session: string) =>
  process.platform === "win32" ? `\\\\.\\pipe\\monad-browser-${session}` : join(stateDir(), `${session}.sock`);

export type Request = { argv: string[]; cwd: string };
export type Response = { ok: boolean; out?: string; error?: string; ms?: number };
