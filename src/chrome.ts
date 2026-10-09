// Find and launch a local Chrome/Chromium in headless mode, or attach to a running one.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { startProxyRelay } from "./proxy-relay.js";

export type ProxyAuth = { username: string; password: string };
export type LaunchedChrome = { wsUrl: string; proc?: ChildProcess; userDataDir?: string; ephemeral: boolean; relay?: Server };

/** Read proxy from --proxy or HTTPS_PROXY/HTTP_PROXY; Chrome can't take credentials in a flag, so split them out. */
export async function proxyConfig(explicit?: string): Promise<{ args: string[]; relay?: Server }> {
  const raw = explicit || process.env.MONAD_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return { args: [] };
  let u: URL;
  try { u = new URL(raw.includes("://") ? raw : `http://${raw}`); } catch { return { args: [] }; }
  let relay: Server | undefined;
  let server = `${u.protocol}//${u.host}`;
  if (u.username && u.protocol.startsWith("http")) {
    const r = await startProxyRelay({ host: u.hostname, port: Number(u.port || 80), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
    relay = r.server;
    server = `http://127.0.0.1:${r.port}`;
  }
  const args = [`--proxy-server=${server}`];
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  args.push(`--proxy-bypass-list=${["<-loopback>", ...(noProxy ? noProxy.split(",").map((s) => s.trim()).filter(Boolean) : [])].join(";")}`);
  return { args, relay };
}

export function findChrome(): string | undefined {
  const env = process.env.MONAD_CHROME || process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const candidates =
    platform() === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
      : platform() === "win32"
        ? [
            `${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe`,
          ]
        : [
            "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable", "/snap/bin/chromium", "/opt/google/chrome/chrome",
            join(homedir(), "chromium-root/usr/lib/chromium/chromium"),
          ];
  return candidates.find((p) => p && existsSync(p));
}

export const DEFAULT_ARGS = [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-breakpad",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio",
  "--password-store=basic",
  "--use-mock-keychain",
  "--hide-scrollbars",
  "--disable-features=Translate,MediaRouter,OptimizationHints,AcceptCHFrame",
  "--window-size=1280,800",
];

export async function launchChrome(opts: { executable?: string; userDataDir?: string; headful?: boolean; extraArgs?: string[]; proxy?: string } = {}): Promise<LaunchedChrome> {
  const exe = opts.executable || findChrome();
  if (!exe) throw new Error("No Chrome/Chromium found. Set MONAD_CHROME=/path/to/chrome or use --cdp <ws-url>.");
  const ephemeral = !opts.userDataDir;
  const userDataDir = opts.userDataDir || mkdtempSync(join(tmpdir(), "monad-browser-"));
  const args = DEFAULT_ARGS.filter((a) => !(opts.headful && a.startsWith("--headless")));
  const proxy = await proxyConfig(opts.proxy);
  args.push(...proxy.args);
  args.push(`--user-data-dir=${userDataDir}`, "--remote-debugging-port=0", ...(opts.extraArgs ?? []));
  // Containers usually run as root or without user namespaces.
  if (process.env.MONAD_NO_SANDBOX === "1" || process.getuid?.() === 0 || existsSync("/.dockerenv") || process.env.E2B_SANDBOX)
    args.push("--no-sandbox");
  args.push("about:blank");

  const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"], detached: false });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not expose DevTools in 20s.\n${buf.slice(-2000)}`)), 20_000);
    proc.stderr!.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (code ${code}).\n${buf.slice(-2000)}`)); });
  });
  proc.stderr!.resume();
  return { wsUrl, proc, userDataDir, ephemeral, relay: proxy.relay };
}

/** Accept ws://… directly, or http://host:port / a port number, and resolve the browser ws URL. */
export async function resolveCdpEndpoint(endpoint: string): Promise<string> {
  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) return endpoint;
  const base = /^\d+$/.test(endpoint) ? `http://127.0.0.1:${endpoint}` : endpoint.replace(/\/$/, "");
  const res = await fetch(`${base}/json/version`);
  const j: any = await res.json();
  if (!j.webSocketDebuggerUrl) throw new Error(`No webSocketDebuggerUrl at ${base}`);
  return j.webSocketDebuggerUrl;
}

export function cleanupProfile(dir?: string) {
  if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

export function readDevToolsActivePort(userDataDir: string): string | undefined {
  try {
    const [port, path] = readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8").trim().split("\n");
    return `ws://127.0.0.1:${port}${path}`;
  } catch { return undefined; }
}
