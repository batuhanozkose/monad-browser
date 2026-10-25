// Warm daemon: owns one Browser per session, serves newline-delimited JSON over a local socket
// (unix socket on Linux/macOS, named pipe on Windows).
import { createServer, connect, type Server, type Socket } from "node:net";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, type BrowserOptions } from "./browser.js";
import { dispatch } from "./commands.js";
import { hasEnabledWatches, startWatchScheduler } from "./watch.js";
import { assertSession, stateDir, socketPath, type Request, type Response } from "./paths.js";

export { stateDir, socketPath };
export type { Request, Response } from "./paths.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Is another daemon already serving this session? A pid file alone is not enough: PIDs are reused. */
function sessionAlive(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(sock);
    let done = false;
    const finish = (alive: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(alive);
    };
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
    setTimeout(() => finish(false), 500).unref();
  });
}

/**
 * Take the per-session pid file atomically. On unix a second bind() fails with EADDRINUSE, but
 * Windows named pipes happily accept several servers on one name, so this lock is what keeps a
 * client race from starting two daemons that split requests between them.
 */
async function acquireSession(sock: string, pidFile: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(pidFile, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      if (await sessionAlive(sock)) return false;
      let pid = 0;
      try { pid = Number(readFileSync(pidFile, "utf8").trim()); } catch { /* gone */ }
      if (pidAlive(pid)) {
        // The owner may still be launching Chrome (its own timeout is 40 s); wait for its socket
        // before calling it stale, but stop early if it dies.
        for (let i = 0; i < 550 && pidAlive(pid) && !(await sessionAlive(sock)); i++) await sleep(100);
        if (await sessionAlive(sock)) return false;
      }
      rmSync(pidFile, { force: true }); // stale pid: the daemon is gone
    }
  }
  return false;
}

export async function runDaemon(session: string, opts: BrowserOptions & { idleMinutes?: number; watchOnly?: boolean }) {
  assertSession(session);
  mkdirSync(stateDir(), { recursive: true });
  const sock = socketPath(session);
  const pidFile = join(stateDir(), `${session}.pid`);
  if (!(await acquireSession(sock, pidFile))) {
    // Another daemon owns the session. The client that spawned us only waits for "ready".
    process.send?.("ready");
    process.exit(0);
  }

  const cleanup = () => {
    // Named pipes disappear with their server; unlink only real unix sockets.
    if (process.platform !== "win32") { try { rmSync(sock, { force: true }); } catch { /* ignore */ } }
    try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
  };
  process.once("exit", cleanup); // also covers a crash before shutdown() is installed

  const browser = new Browser(opts);
  let server: Server | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let scheduler: { stop(): void } | undefined;
  let browserStarted = false;
  let closed = false;

  const shutdown = async (code = 0) => {
    if (closed) return;
    closed = true;
    scheduler?.stop();
    server?.close();
    await browser.close().catch(() => {});
    cleanup();
    process.exit(code);
  };

  try {
    // A stale socket file from a killed daemon would make listen() fail on unix.
    if (process.platform !== "win32") { try { rmSync(sock, { force: true }); } catch { /* ignore */ } }
    let queue: Promise<unknown> = Promise.resolve(); // commands run strictly in order
    const idleMs = (opts.idleMinutes ?? Number(process.env.MONAD_IDLE_MINUTES ?? 30)) * 60_000;
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };
    const scheduleIdle = () => {
      if (closed || idleTimer || idleMs <= 0) return;
      idleTimer = setTimeout(() => shutdown(0), idleMs);
    };
    // Watchers must outlive CLI calls: while one exists the daemon never idles out.
    const bump = () => {
      if (hasEnabledWatches()) { clearIdle(); return; }
      clearIdle();
      scheduleIdle();
    };
    const startBrowser = async () => {
      if (browserStarted) return;
      await browser.start();
      browserStarted = true;
      browser.cdp.on("__close", () => shutdown(1)); // browser died → daemon exits, next call relaunches
      bump();
    };
    if (!opts.watchOnly) await startBrowser();

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
        if (req.argv[0] === "status") {
          const out = browserStarted
            ? `running session=${session} pid=${process.pid}\n${browser.listTabs()}`
            : `running session=${session} pid=${process.pid} (watch-only; Chrome starts on the first browser command)`;
          res = { ok: true, out };
        } else {
          try {
            await startBrowser();
            res = { ok: true, out: await dispatch({ browser, cwd: req.cwd, signal: ac.signal }, req.argv) };
          } catch (e: any) { res = { ok: false, error: e?.message ?? String(e) }; }
        }
        res.ms = Date.now() - t0;
        if (socket.destroyed) return;
        socket.end(JSON.stringify(res) + "\n");
        bump();
      });
    };

    server = createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        const i = buf.indexOf("\n");
        if (i >= 0) { handle(socket, buf.slice(0, i)); buf = ""; }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(sock, () => { server!.off("error", reject); resolve(); });
    });

    // A render check must not interleave with a user command: it opens and closes a tab.
    const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
      const p = queue.then(fn);
      queue = p.then(() => undefined, () => undefined);
      return p;
    };
    scheduler = startWatchScheduler({
      render: (url) => exclusive(async () => { await startBrowser(); return browser.renderHtml(url); }),
      onTick: (active) => { if (active) clearIdle(); else scheduleIdle(); },
      log: (message) => process.stderr.write(`watch: ${message}\n`),
    });

    process.on("SIGTERM", () => shutdown(0));
    process.on("SIGINT", () => shutdown(0));
    if (process.platform === "win32") process.on("SIGBREAK", () => shutdown(0));
    bump();
    process.send?.("ready");
  } catch (e) {
    scheduler?.stop();
    await browser.close().catch(() => {});
    cleanup();
    throw e;
  }
}
