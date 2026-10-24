// Tiny module shared by the thin client and the daemon: no project imports, so `mb` starts fast.
import { homedir } from "node:os";
import { join } from "node:path";

export const stateDir = () => process.env.MONAD_HOME || join(homedir(), ".monad-browser");

/** Windows named pipes are machine-global, so mix the state directory into the name: two users
 * (or two MONAD_HOME values) must never share a session. */
function dirTag(dir: string): string {
  let h = 2166136261;
  for (let i = 0; i < dir.length; i++) { h ^= dir.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function socketPathFor(platform: NodeJS.Platform, dir: string, session: string): string {
  return platform === "win32"
    ? String.raw`\\.\pipe\monad-browser-${dirTag(dir)}-${session}`
    : join(dir, `${session}.sock`);
}

export const socketPath = (session: string) => socketPathFor(process.platform, stateDir(), session);

/** Session names become file and pipe names; reject separators, control characters and the
 * characters Windows forbids. Spaces and Unicode are fine on both platforms. */
export function assertSession(session: string) {
  if (!session || /[\\/:*?"<>|\x00-\x1f]/.test(session))
    throw new Error(`invalid session name: ${session} (cannot contain \\ / : * ? " < > | or control characters)`);
}

export type Request = { argv: string[]; cwd: string };
export type Response = { ok: boolean; out?: string; error?: string; ms?: number };
