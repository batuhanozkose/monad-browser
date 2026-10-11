// Warm daemon: owns one Browser per session, serves newline-delimited JSON over a unix socket.
import { createServer, type Socket } from "node:net";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Browser, type BrowserOptions } from "./browser.js";
import { dispatch } from "./commands.js";

import { stateDir, socketPath, type Request, type Response } from "./paths.js";
export { stateDir, socketPath };
export type { Request, Response } from "./paths.js";


export async function runDaemon(session: string, opts: BrowserOptions & { idleMinutes?: number }) {
  mkdirSync(stateDir(), { recursive: true });
  const sock = socketPath(session);
  if (existsSync(sock)) rmSync(sock, { force: true });

  const browser = new Browser(opts);
  await browser.start();
  let queue: Promise<unknown> = Promise.resolve(); // commands run strictly in order
  let idleTimer: NodeJS.Timeout | undefined;
  const idleMs = (opts.idleMinutes ?? Number(process.env.MONAD_IDLE_MINUTES ?? 30)) * 60_000;

  const shutdown = async (code = 0) => {
    server.close();
    await browser.close().catch(() => {});
    rmSync(sock, { force: true });
    rmSync(join(stateDir(), `${session}.pid`), { force: true });
    process.exit(code);
  };
  const bump = () => { if (idleTimer) clearTimeout(idleTimer); if (idleMs > 0) idleTimer = setTimeout(() => shutdown(0), idleMs); };
  browser.cdp.on("__close", () => shutdown(1)); // browser died → daemon exits, next call relaunches

  const handle = (socket: Socket, line: string) => {
    let req: Request;
    try { req = JSON.parse(line); } catch { socket.end(JSON.stringify({ ok: false, error: "bad request" }) + "\n"); return; }
    bump();
    // If the client hangs up while its command is queued or running, abort it and drop the response.
    const ac = new AbortController();
    socket.on("close", () => ac.abort());
    queue = queue.then(async () => {
      if (ac.signal.aborted) return;
      const t0 = Date.now();
      let res: Response;
      if (req.argv[0] === "stop") {
        socket.end(JSON.stringify({ ok: true, out: "ok stopped" }) + "\n");
        return shutdown(0);
      }
      if (req.argv[0] === "status") res = { ok: true, out: `running session=${session} pid=${process.pid}\n${browser.listTabs()}` };
      else {
        try { res = { ok: true, out: await dispatch({ browser, cwd: req.cwd, signal: ac.signal }, req.argv) }; }
        catch (e: any) { res = { ok: false, error: e?.message ?? String(e) }; }
      }
      res.ms = Date.now() - t0;
      if (socket.destroyed) return;
      socket.end(JSON.stringify(res) + "\n");
    });
  };

  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i >= 0) { handle(socket, buf.slice(0, i)); buf = ""; }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(sock, r));
  writeFileSync(join(stateDir(), `${session}.pid`), String(process.pid));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  bump();
  process.send?.("ready");
}
