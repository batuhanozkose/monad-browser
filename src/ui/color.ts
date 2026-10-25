// Terminal capability detection and the 16-color semantic palette.
// The renderer never emits 256/truecolor codes: the user's terminal theme owns the
// exact hues, and 16-color SGR works in Windows Terminal, conhost, cmd, pwsh and POSIX.
import type { Glyphs } from "./glyphs.js";
import { glyphsFor } from "./glyphs.js";

export type Ui = {
  color: boolean;
  unicode: boolean;
  width: number;
  glyphs: Glyphs;
};

export type UiEnv = Record<string, string | undefined>;

const clampWidth = (n: number) => Math.max(40, Math.min(Number.isFinite(n) ? n : 80, 120));

const truthy = (v: string | undefined) =>
  v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/**
 * Decide how to render a stream. `undefined` means "leave the plain contract alone":
 * pipes, CI, TERM=dumb and --json must not gain a single byte.
 */
export function uiFor(stream: NodeJS.WriteStream, env: UiEnv = process.env): Ui | undefined {
  const tty = !!stream.isTTY;
  const forced = truthy(env.FORCE_COLOR);
  if (!tty && !forced) return undefined;
  if (env.TERM === "dumb") return undefined;
  if ((env.CI === "true" || env.CI === "1") && !forced) return undefined;

  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const color = !noColor && (tty || forced);
  const unicode = unicodeAllowed(env);
  const width = clampWidth(Number(env.MB_WIDTH) || stream.columns || 80);
  return { color, unicode, width, glyphs: glyphsFor(unicode) };
}

export function unicodeAllowed(env: UiEnv = process.env): boolean {
  if (truthy(env.MB_ASCII) || env.MB_UNICODE === "0") return false;
  if (env.MB_UNICODE === "1") return true;
  if (process.platform === "win32") {
    // Legacy conhost/cmd can be on CP437/CP1252. Windows Terminal and VS Code's
    // integrated terminal advertise themselves; otherwise use the ASCII set.
    return Boolean(env.WT_SESSION) || env.TERM_PROGRAM === "vscode";
  }
  return true;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** SGR styles. All are 16-color / attributes; no 256 or truecolor codes. */
const SGR: Record<string, string> = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  ref: "\x1b[36m",          // cyan
  url: "\x1b[34m",          // blue
  num: "\x1b[35m",          // magenta
  ok: "\x1b[32m",           // green
  err: "\x1b[31m",          // red
  warn: "\x1b[33m",         // yellow
  accent: "\x1b[34;1m",     // bold blue
  cmd: "\x1b[35;1m",        // bold magenta
  role: "\x1b[90m",         // bright black
  muted: "\x1b[90m",
  state: "\x1b[33m",
  border: "\x1b[90m",
  title: "\x1b[1m",
  brand: "\x1b[34;1m",
  section: "\x1b[34;1m",
  text: "",
  label: "",
  add: "\x1b[32;1m",
  del: "\x1b[31;1m",
  addText: "\x1b[32m",
  delText: "\x1b[31m",
  addHl: "\x1b[32;1m",
  delHl: "\x1b[31;1m",
};

export type StyleName = keyof typeof SGR;

export function paint(ui: Ui, text: string, style: StyleName): string {
  if (!ui.color || !text) return text;
  const code = SGR[style];
  return code ? `${code}${text}${SGR.reset}` : text;
}

/** Paint only when the text is non-empty, avoiding stray reset sequences. */
export function maybe(ui: Ui, text: string, style: StyleName): string {
  return text ? paint(ui, text, style) : "";
}

export function formatMs(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function replaceGlyphs(text: string, ui: Ui): string {
  if (ui.unicode) return text;
  return text
    .replaceAll("…", ui.glyphs.ellipsis)
    .replaceAll("→", ui.glyphs.arrow)
    .replaceAll("—", "-")
    .replaceAll("·", ui.glyphs.dot);
}
