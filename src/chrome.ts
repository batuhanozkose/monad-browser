// Find and launch a local Chrome/Chromium in headless mode, or attach to a running one.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
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
  args.push(`--proxy-bypass-list=${["localhost", "127.0.0.1", "[::1]", ...(noProxy ? noProxy.split(",").map((s) => s.trim()).filter(Boolean) : [])].join(";")}`);
  return { args, relay };
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/** A path as given, or a bare command resolved through PATH (PATHEXT on Windows). */
function resolveExecutable(nameOrPath: string): string | undefined {
  if (isFile(nameOrPath)) return nameOrPath;
  if (/[\\/]/.test(nameOrPath)) return undefined;
  const exts = platform() === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, nameOrPath.toLowerCase().endsWith(ext.toLowerCase()) ? nameOrPath : nameOrPath + ext);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

/** Candidate Chrome/Chromium/Edge binaries for a platform, without touching the filesystem. */
export function chromeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (platform === "win32") {
    // PROGRAMFILES etc. are normally set, but a stripped-down service environment may omit them;
    // never build a literal "undefined\Google\..." path.
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.PROGRAMW6432, env.LOCALAPPDATA]
      .filter((p): p is string => !!p);
    return [...new Set(roots.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Google", "Chrome Beta", "Application", "chrome.exe"),
      join(root, "Google", "Chrome SxS", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]))];
  }
  return [
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable", "/snap/bin/chromium", "/opt/google/chrome/chrome",
    "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge",
    join(homedir(), "chromium-root/usr/lib/chromium/chromium"),
  ];
}

export function findChrome(): string | undefined {
  const env = process.env.MONAD_CHROME || process.env.CHROME_PATH;
  if (env) {
    const found = resolveExecutable(env);
    if (found) return found;
  }
  return chromeCandidates(platform()).find(isFile);
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

  const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"], detached: false, windowsHide: true });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not expose DevTools in 20s.\n${buf.slice(-2000)}`)), 20_000);
    // A bad MONAD_CHROME (not executable, deleted after discovery) emits "error" instead of "exit";
    // without this listener it would crash the daemon as an unhandled event.
    proc.once("error", (e) => { clearTimeout(timer); reject(e); });
    proc.stderr?.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (code ${code}).\n${buf.slice(-2000)}`)); });
  });
  proc.stderr?.resume();
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
  // Windows keeps a lock briefly after Chrome exits; retry instead of leaking the profile.
  if (dir) try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
}

/** Stop Chrome and, on Windows, its whole process tree (renderers, GPU, crashpad). */
export function killChrome(proc: ChildProcess) {
  if (proc.exitCode !== null) return;
  if (process.platform === "win32" && proc.pid) {
    try {
      const r = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      if (!r.error && r.status === 0) return;
    } catch { /* fall back to proc.kill */ }
  }
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
}

export function readDevToolsActivePort(userDataDir: string): string | undefined {
  try {
    // Chrome writes CRLF on Windows; a stray \r corrupts the DevTools path.
    const [port, path] = readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
    return `ws://127.0.0.1:${port}${path}`;
  } catch { return undefined; }
}
