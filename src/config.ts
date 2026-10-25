// Config files are optional: user defaults, then a project file, then an explicit --config.
// Environment variables and CLI flags still win over all of them.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Config = {
  chrome?: string;
  headful?: boolean;
  idleMinutes?: number;
  block?: string[];
  proxy?: string;
  noSandbox?: boolean;
  snapshotCacheMs?: number;
  actionTimeout?: number;
  headers?: Record<string, string>;
  userAgent?: string;
  ignoreHttpsErrors?: boolean;
  initScripts?: string[];
  downloadPath?: string;
  colorScheme?: "dark" | "light" | "no-preference";
  viewport?: { width: number; height: number; scale?: number };
  autoDialog?: boolean;
  extraArgs?: string[];
  screenshotDir?: string;
  screenshotFormat?: "png" | "jpeg";
  screenshotQuality?: number;
  watchNotifyUrl?: string;
};

function readJson(path: string, explicit: boolean): Config {
  if (!existsSync(path)) {
    if (explicit) throw new Error(`config file not found: ${path}`);
    return {};
  }
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (e: any) { throw new Error(`invalid JSON in ${path}: ${e?.message ?? e}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`config must be an object: ${path}`);
  const out: Config = {};
  const str = (v: unknown) => typeof v === "string" ? v : undefined;
  const bool = (v: unknown) => typeof v === "boolean" ? v : undefined;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
  out.chrome = str(parsed.chrome);
  out.headful = bool(parsed.headful);
  out.idleMinutes = num(parsed.idleMinutes);
  out.block = Array.isArray(parsed.block) ? parsed.block.filter((x: unknown) => typeof x === "string") : str(parsed.block)?.split(",").map((s) => s.trim()).filter(Boolean);
  out.proxy = str(parsed.proxy);
  out.noSandbox = bool(parsed.noSandbox);
  out.snapshotCacheMs = num(parsed.snapshotCacheMs);
  out.actionTimeout = num(parsed.actionTimeout);
  out.headers = parsed.headers && typeof parsed.headers === "object" && !Array.isArray(parsed.headers) ? parsed.headers : undefined;
  out.userAgent = str(parsed.userAgent);
  out.ignoreHttpsErrors = bool(parsed.ignoreHttpsErrors);
  out.initScripts = Array.isArray(parsed.initScripts) ? parsed.initScripts.filter((x: unknown) => typeof x === "string") : undefined;
  out.downloadPath = str(parsed.downloadPath);
  out.colorScheme = ["dark", "light", "no-preference"].includes(parsed.colorScheme) ? parsed.colorScheme : undefined;
  if (parsed.viewport && typeof parsed.viewport === "object") {
    const scale = num(parsed.viewport.scale);
    out.viewport = {
      width: num(parsed.viewport.width) ?? 1280,
      height: num(parsed.viewport.height) ?? 800,
      ...(scale !== undefined ? { scale } : {}),
    };
  }
  out.autoDialog = bool(parsed.autoDialog);
  out.extraArgs = Array.isArray(parsed.args) ? parsed.args.filter((x: unknown) => typeof x === "string")
    : str(parsed.args)?.split(",").map((s) => s.trim()).filter(Boolean);
  out.screenshotDir = str(parsed.screenshotDir);
  out.screenshotFormat = parsed.screenshotFormat === "jpeg" || parsed.screenshotFormat === "png" ? parsed.screenshotFormat : undefined;
  out.screenshotQuality = num(parsed.screenshotQuality);
  out.watchNotifyUrl = str(parsed.watchNotifyUrl);
  return out;
}

export function loadConfig(cwd = process.cwd(), explicit?: string): Config {
  const user = readJson(join(homedir(), ".monad-browser", "config.json"), false);
  const project = readJson(resolve(cwd, "monad-browser.json"), false);
  const extra = explicit ? readJson(resolve(cwd, explicit), true) : {};
  const cfg: Config = { ...user, ...project, ...extra };

  const env = process.env;
  if (env.MONAD_CHROME) cfg.chrome = env.MONAD_CHROME;
  if (env.MONAD_HEADFUL === "1" || env.MONAD_HEADFUL === "true") cfg.headful = true;
  if (env.MONAD_IDLE_MINUTES) cfg.idleMinutes = Number(env.MONAD_IDLE_MINUTES);
  if (env.MONAD_SNAPSHOT_CACHE_MS) cfg.snapshotCacheMs = Number(env.MONAD_SNAPSHOT_CACHE_MS);
  if (env.MONAD_ACTION_TIMEOUT) cfg.actionTimeout = Number(env.MONAD_ACTION_TIMEOUT);
  if (env.MONAD_NO_SANDBOX === "1") cfg.noSandbox = true;
  if (env.MONAD_PROXY) cfg.proxy = env.MONAD_PROXY;
  if (env.MONAD_SCREENSHOT_DIR) cfg.screenshotDir = env.MONAD_SCREENSHOT_DIR;
  if (env.MONAD_DOWNLOAD_PATH) cfg.downloadPath = env.MONAD_DOWNLOAD_PATH;
  if (env.MONAD_WATCH_NOTIFY_URL) cfg.watchNotifyUrl = env.MONAD_WATCH_NOTIFY_URL;
  return cfg;
}
