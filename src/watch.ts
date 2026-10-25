// Watchers: page / RSS / GitHub release sources, condition-gated wakeups, backoff and a timer
// that lives in the session daemon (or in `mb watch run` for CI/systemd). Zero runtime deps.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diffLines, renderDiff } from "./diff.js";
import { stateDir } from "./paths.js";
import { extractCss, extractText, parseSelector } from "./watch-html.js";
import { feedValue, parseFeed } from "./watch-feed.js";

export type WatchKind = "page" | "rss" | "release";
export type ExtractMode = "text" | "css" | "json";
export type Extract = { mode: ExtractMode; selector?: string; path?: string };
export type ConditionOp = "changed" | "contains" | "not-contains" | "matches" | "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
export type Condition = { op: ConditionOp; value?: string; flags?: string };
export type WatchEvent = { at: number; kind: "fired" | "error" | "baseline" | "hook-error"; summary: string; error?: string };

export type Watch = {
  name: string;
  kind: WatchKind;
  source: string;
  repo?: string;
  extract: Extract;
  condition: Condition;
  everySeconds: number;
  render: boolean;
  exec?: string;
  notify: boolean;
  cwd: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastCheckAt?: number;
  nextCheckAt: number;
  checkingUntil?: number;
  lastValue: string;
  lastHash: string;
  lastError?: string;
  lastErrorAt?: number;
  consecutiveErrors: number;
  lastFiredAt?: number;
  totalFires: number;
  events: WatchEvent[];
};

export type WatchFile = { version: 1; watches: Watch[] };
export type RenderFn = (url: string) => Promise<string>;
export type WatchCheckOptions = { render?: RenderFn; now?: number };
export type CheckOutcome = {
  name: string;
  kind: WatchKind;
  source: string;
  condition: Condition;
  at: number;
  ok: boolean;
  fired: boolean;
  changed: boolean;
  previous: string;
  next: string;
  diff: string;
  error?: string;
  nextCheckAt: number;
  backoffMs: number;
  retryAfterMs?: number;
  hookErrors?: string[];
};

export const WATCH_TICK_MS = 5_000;
export const WATCH_LEASE_MS = 5 * 60_000;
export const MAX_VALUE_BYTES = 8 * 1024;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_EVENTS = 200;
export const MAX_BACKOFF_MS = 24 * 3600_000;
export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 30 * 24 * 3600;

const PAGE_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5";
const FEED_ACCEPT = "application/atom+xml,application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5";
const CONDITION_OPS = new Set<ConditionOp>(["changed", "contains", "not-contains", "matches", "gt", "gte", "lt", "lte", "eq", "neq"]);
const NUM_RE = /-?\d[\d,]*(?:\.\d+)?/;

export const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const watchFile = () => join(stateDir(), "watches.json");
export const watchLockFile = () => join(stateDir(), "watches.lock");

// ---- values and conditions -----------------------------------------------------------------

/** First number in a value: "Price: 1,299.50 USD" -> 1299.5. */
export function firstNumber(s: string): number | undefined {
  const m = NUM_RE.exec(s);
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function unquote(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const q = s[0];
    const inner = s.slice(1, -1);
    return q === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  if (s.startsWith('"') || s.startsWith("'")) throw new Error(`unterminated quote in condition: ${raw}`);
  return s;
}

export function parseCondition(raw: string): Condition {
  const s = raw.trim();
  if (!s || /^changed$/i.test(s)) return { op: "changed" };
  if (/^(contains|not[-_]contains|matches)$/i.test(s)) throw new Error(`${s} needs a value`);
  const text = /^(not[-_]contains|contains|matches)\s+([\s\S]+)$/i.exec(s);
  if (text) {
    const op = text[1].toLowerCase().replace("_", "-") as "contains" | "not-contains" | "matches";
    const rest = text[2].trim();
    if (!rest) throw new Error(`${op} needs a value`);
    if (op === "matches") {
      const m = /^\/((?:\\.|[^/])+)\/([a-z]*)$/i.exec(rest);
      if (!m) throw new Error('matches needs /regex/ (for example: matches /out of stock/i)');
      const flags = m[2].toLowerCase();
      if (/[^imsu]/.test(flags)) throw new Error(`unsupported regex flags: ${flags} (use i, m, s or u)`);
      try { new RegExp(m[1], flags); } catch (e: any) { throw new Error(`invalid regex: ${e?.message ?? e}`); }
      return { op, value: m[1], flags };
    }
    const value = unquote(rest);
    if (!value) throw new Error(`${op} needs a value`);
    return { op, value };
  }
  const cmp = /^(>=|<=|==|!=|>|<)\s*(.+)$/.exec(s);
  if (cmp) {
    const op: ConditionOp = cmp[1] === ">" ? "gt" : cmp[1] === ">=" ? "gte" : cmp[1] === "<" ? "lt" : cmp[1] === "<=" ? "lte" : cmp[1] === "==" ? "eq" : "neq";
    const value = cmp[2].trim();
    if (!value) throw new Error(`${cmp[1]} needs a value`);
    if ((op === "gt" || op === "gte" || op === "lt" || op === "lte") && firstNumber(value) === undefined)
      throw new Error(`${cmp[1]} needs a number, got "${value}"`);
    return { op, value };
  }
  throw new Error(`invalid condition: ${raw}\nconditions: changed | contains "x" | not-contains "x" | matches /re/ | > 10 | < 5 | == 0`);
}

export function describeCondition(c: Condition): string {
  switch (c.op) {
    case "changed": return "content changed";
    case "contains": return `contains "${c.value ?? ""}"`;
    case "not-contains": return `no longer contains "${c.value ?? ""}"`;
    case "matches": return `matches /${c.value ?? ""}/${c.flags ?? ""}`;
    case "gt": return `> ${c.value}`;
    case "gte": return `>= ${c.value}`;
    case "lt": return `< ${c.value}`;
    case "lte": return `<= ${c.value}`;
    case "eq": return `== ${c.value}`;
    case "neq": return `!= ${c.value}`;
  }
}

/** Does the condition hold for a value? `changed` is handled by shouldFire. */
export function conditionHolds(c: Condition, value: string): boolean {
  switch (c.op) {
    case "changed": return true;
    case "contains": return value.toLowerCase().includes((c.value ?? "").toLowerCase());
    case "not-contains": return !value.toLowerCase().includes((c.value ?? "").toLowerCase());
    case "matches": return new RegExp(c.value ?? "", c.flags ?? "").test(value);
    case "gt": { const a = firstNumber(value), b = firstNumber(c.value ?? ""); return a !== undefined && b !== undefined && a > b; }
    case "gte": { const a = firstNumber(value), b = firstNumber(c.value ?? ""); return a !== undefined && b !== undefined && a >= b; }
    case "lt": { const a = firstNumber(value), b = firstNumber(c.value ?? ""); return a !== undefined && b !== undefined && a < b; }
    case "lte": { const a = firstNumber(value), b = firstNumber(c.value ?? ""); return a !== undefined && b !== undefined && a <= b; }
    case "eq": {
      const want = firstNumber(c.value ?? "");
      const got = firstNumber(value);
      if (want !== undefined && got !== undefined) return got === want;
      return value.trim().toLowerCase() === (c.value ?? "").trim().toLowerCase();
    }
    case "neq": return !conditionHolds({ op: "eq", value: c.value }, value);
  }
}

/** Lines present in newVal but not oldVal (feeds wake on new entries only). */
export function addedLines(oldVal: string, newVal: string): string[] {
  return diffLines(oldVal.split("\n"), newVal.split("\n")).filter((o) => o.t === "+").map((o) => o.line);
}

/** Fire on the transition into the condition, never on every interval. */
export function shouldFire(kind: WatchKind, c: Condition, changed: boolean, oldVal: string, newVal: string): boolean {
  if (!changed) return false;
  if (c.op === "changed") return true;
  if (kind !== "page" && (c.op === "contains" || c.op === "not-contains" || c.op === "matches")) {
    return addedLines(oldVal, newVal).some((line) => conditionHolds(c, line));
  }
  return conditionHolds(c, newVal) && !conditionHolds(c, oldVal);
}

// ---- diff and normalisation ----------------------------------------------------------------

/** Cut a string to at most n UTF-8 bytes without splitting a rune. */
export function truncateBytes(s: string, n: number): string {
  if (Buffer.byteLength(s) <= n) return s;
  const mark = "\n… (truncated)";
  const budget = Math.max(0, n - Buffer.byteLength(mark));
  let cut = Math.min(s.length, budget);
  while (cut > 0 && Buffer.byteLength(s.slice(0, cut)) > budget) cut--;
  if (cut > 0 && /[\uD800-\uDBFF]/.test(s[cut - 1])) cut--;
  return s.slice(0, cut) + mark;
}

/** Collapse layout whitespace and drop empty lines so only content changes count. */
export function normalizeValue(s: string): string {
  const lines = s.replace(/\r\n?/g, "\n").split("\n")
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean);
  return truncateBytes(lines.join("\n"), MAX_VALUE_BYTES);
}

/** A compact change description: old -> new for one-liners, +/- lines otherwise. */
export function diffValues(kind: WatchKind, oldVal: string, newVal: string, maxBytes = 4096): string {
  let out: string;
  if (!oldVal.includes("\n") && !newVal.includes("\n")) {
    out = `${oldVal || "(empty)"} → ${newVal || "(empty)"}`;
  } else if (kind !== "page") {
    const added = addedLines(oldVal, newVal);
    out = added.length ? added.map((l) => `+ ${l}`).join("\n") : "(no new entries)";
  } else {
    const d = renderDiff(oldVal.split("\n"), newVal.split("\n"));
    out = d.text || "(lines reordered)";
  }
  return truncateBytes(out, maxBytes);
}

/** interval × 2^errors, capped at 24h. */
export function backoffMs(intervalMs: number, errors: number, capMs = MAX_BACKOFF_MS): number {
  let d = Math.max(1000, intervalMs);
  for (let i = 0; i < Math.max(0, errors) && d < capMs; i++) d *= 2;
  return Math.min(d, capMs);
}

export const hashValue = (v: string) => createHash("sha256").update(v).digest("hex");

// ---- JSON paths ----------------------------------------------------------------------------

type JsonStep = { key: string } | { index: number };

export function parseJsonPath(raw: string): JsonStep[] {
  let p = raw.trim();
  if (!p) throw new Error("json path is empty");
  if (p.startsWith("$")) p = p.slice(1);
  if (p.startsWith(".")) p = p.slice(1);
  if (!p) throw new Error("json path is empty");
  const steps: JsonStep[] = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] === ".") {
      if (i === 0 || i === p.length - 1 || p[i + 1] === ".") throw new Error(`json path ${raw}: empty key`);
      i++;
      continue;
    }
    if (p[i] === "[") {
      const end = p.indexOf("]", i);
      if (end < 0) throw new Error(`json path ${raw}: missing ]`);
      const n = Number(p.slice(i + 1, end));
      if (!Number.isInteger(n) || n < 0) throw new Error(`json path ${raw}: index must be a non-negative integer`);
      steps.push({ index: n });
      i = end + 1;
      continue;
    }
    if (p[i] === "]") throw new Error(`json path ${raw}: unexpected ]`);
    let j = i;
    while (j < p.length && p[j] !== "." && p[j] !== "[" && p[j] !== "]") j++;
    steps.push({ key: p.slice(i, j) });
    i = j;
    if (steps.length > 32) throw new Error(`json path ${raw}: more than 32 steps`);
  }
  return steps;
}

/** Render a JSON value as text: strings as-is, scalars as their JSON form, objects as compact JSON. */
export function extractJson(body: string, path: string): string {
  const steps = parseJsonPath(path);
  let doc: any;
  try { doc = JSON.parse(body); } catch (e: any) { throw new Error(`response is not JSON: ${e?.message ?? e}`); }
  let cur: any = doc;
  for (const step of steps) {
    if ("index" in step) {
      if (!Array.isArray(cur)) throw new Error(`json path ${path}: [${step.index}] is not an array`);
      if (step.index >= cur.length) throw new Error(`json path ${path}: index ${step.index} out of range (length ${cur.length})`);
      cur = cur[step.index];
    } else {
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) throw new Error(`json path ${path}: "${step.key}" is not an object`);
      if (!(step.key in cur)) throw new Error(`json path ${path}: no such key "${step.key}"`);
      cur = cur[step.key];
    }
  }
  if (typeof cur === "string") return cur;
  if (cur === null) return "null";
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
  return JSON.stringify(cur);
}

// ---- validation and naming -----------------------------------------------------------------

export function parseDuration(raw: string): number {
  const s = raw.trim().toLowerCase();
  if (!s) throw new Error("--every needs a duration such as 30s, 5m, 1h or 1d");
  let ms: number;
  if (/^\d+$/.test(s)) ms = Number(s) * 1000;
  else {
    const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
    if (!m || !m.slice(1).some(Boolean)) throw new Error(`invalid duration: ${raw} (use 30s, 5m, 1h or 1d)`);
    ms = (Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)) * 1000;
  }
  if (!Number.isFinite(ms) || ms < 1000) throw new Error("--every must be at least 1s");
  if (ms > MAX_INTERVAL_SECONDS * 1000) throw new Error("--every must be at most 30d");
  return ms;
}

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec >= 86400 && sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${sec}s`;
}

export function validateName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error("watch name is empty");
  if (name.length > 80) throw new Error("watch name is longer than 80 characters");
  if (/[\n\r"]/.test(name)) throw new Error("watch name must be one line without quotes");
  return name;
}

export function normalizeHttpUrl(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error("source is required");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\])/.test(s) ? "http://" : "https://") + s;
  let u: URL;
  try { u = new URL(s); } catch { throw new Error(`invalid URL: ${raw}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("watch URL must be http(s)");
  if (u.username || u.password) throw new Error("watch URL must not contain credentials");
  u.hash = "";
  return u.href;
}

export function normalizeRepo(raw: string): string {
  let s = raw.trim();
  for (const p of ["https://github.com/", "http://github.com/", "https://www.github.com/", "github.com/"]) {
    if (s.toLowerCase().startsWith(p)) { s = s.slice(p.length); break; }
  }
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = s.split("/");
  if (parts.length > 2) s = `${parts[0]}/${parts[1]}`;
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(s) || s.includes(".."))
    throw new Error("repo must be owner/name (for example golang/go)");
  return s;
}

export const releasesFeedUrl = (repo: string) => `https://github.com/${repo}/releases.atom`;

export function inferKind(source: string): WatchKind {
  const s = source.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return "release";
  if (/\.(xml|atom|rss)(?:[?#]|$)/i.test(s) || /\/(feed|rss|atom)(?:[?#/]|$)/i.test(s)) return "rss";
  return "page";
}

export function parseExtract(raw: string | undefined, kind: WatchKind): Extract {
  const s = (raw ?? "text").trim();
  if (kind !== "page") {
    if (s && s !== "text") throw new Error("--extract applies to --kind page; feeds are watched as title — link lines");
    return { mode: "text" };
  }
  if (!s || s === "text") return { mode: "text" };
  if (s.startsWith("css:")) {
    const selector = s.slice(4).trim();
    if (!selector) throw new Error("--extract css: needs a selector");
    parseSelector(selector);
    return { mode: "css", selector };
  }
  if (s.startsWith("json:")) {
    const path = s.slice(5).trim();
    if (!path) throw new Error("--extract json: needs a path");
    parseJsonPath(path);
    return { mode: "json", path };
  }
  throw new Error("--extract must be text, css:<selector> or json:<path>");
}

export function deriveName(kind: WatchKind, source: string, extract: Extract): string {
  let base: string;
  if (kind === "release") {
    base = source.replace(/^https?:\/\/github\.com\//i, "").replace(/\/releases\.atom$/i, "").replace(/\//g, "-") + "-releases";
  } else {
    const u = new URL(source);
    base = `${u.hostname}${u.pathname}`;
    if (u.search) base += `-${u.search}`;
  }
  if (extract.mode === "css") base += `-css-${extract.selector}`;
  if (extract.mode === "json") base += `-json-${extract.path}`;
  base = base.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (base || "watch").slice(0, 60);
}

// ---- state ---------------------------------------------------------------------------------

const emptyFile = (): WatchFile => ({ version: 1, watches: [] });

function backupCorrupt(path: string): string | undefined {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dest = `${path}.corrupt-${stamp}`;
  for (let i = 1; existsSync(dest); i++) dest = `${path}.corrupt-${stamp}-${i}`;
  try { renameSync(path, dest); return dest; } catch { return undefined; }
}

function isEvent(raw: any): raw is WatchEvent {
  return !!raw && typeof raw === "object" && typeof raw.at === "number" && typeof raw.kind === "string"
    && ["fired", "error", "baseline", "hook-error"].includes(raw.kind) && typeof raw.summary === "string"
    && (raw.error === undefined || typeof raw.error === "string");
}

function normalizeWatch(raw: any): Watch | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return undefined;
  const kind: WatchKind | undefined = raw.kind === "page" || raw.kind === "rss" || raw.kind === "release" ? raw.kind : undefined;
  if (!kind) return undefined;
  const source = typeof raw.source === "string" ? raw.source : "";
  if (!source) return undefined;
  const e = raw.extract;
  if (!e || typeof e !== "object") return undefined;
  const mode = e.mode;
  if (mode !== "text" && mode !== "css" && mode !== "json") return undefined;
  const extract: Extract = { mode };
  if (mode === "css") {
    if (typeof e.selector !== "string" || !e.selector) return undefined;
    try { parseSelector(e.selector); } catch { return undefined; }
    extract.selector = e.selector;
  }
  if (mode === "json") {
    if (typeof e.path !== "string" || !e.path) return undefined;
    try { parseJsonPath(e.path); } catch { return undefined; }
    extract.path = e.path;
  }
  const c = raw.condition;
  if (!c || typeof c !== "object" || !CONDITION_OPS.has(c.op)) return undefined;
  const condition: Condition = { op: c.op };
  if (typeof c.value === "string") condition.value = c.value;
  if (typeof c.flags === "string") condition.flags = c.flags;
  if ((condition.op === "contains" || condition.op === "not-contains") && !condition.value) return undefined;
  if (condition.op === "matches") {
    try { new RegExp(condition.value ?? "", condition.flags ?? ""); } catch { return undefined; }
  }
  const everySeconds = Number(raw.everySeconds);
  if (!Number.isFinite(everySeconds) || everySeconds < MIN_INTERVAL_SECONDS || everySeconds > MAX_INTERVAL_SECONDS) return undefined;
  const events = Array.isArray(raw.events) ? raw.events.filter(isEvent).slice(0, MAX_EVENTS) : [];
  return {
    name, kind, source,
    repo: typeof raw.repo === "string" ? raw.repo : undefined,
    extract, condition, everySeconds,
    render: !!raw.render,
    exec: typeof raw.exec === "string" && raw.exec.trim() ? raw.exec : undefined,
    notify: !!raw.notify,
    cwd: typeof raw.cwd === "string" && raw.cwd ? raw.cwd : process.cwd(),
    enabled: raw.enabled !== false,
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
    lastCheckAt: Number.isFinite(raw.lastCheckAt) ? Number(raw.lastCheckAt) : undefined,
    nextCheckAt: Number.isFinite(raw.nextCheckAt) ? Number(raw.nextCheckAt) : Date.now(),
    checkingUntil: Number.isFinite(raw.checkingUntil) ? Number(raw.checkingUntil) : undefined,
    lastValue: typeof raw.lastValue === "string" ? raw.lastValue : "",
    lastHash: typeof raw.lastHash === "string" ? raw.lastHash : "",
    lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
    lastErrorAt: Number.isFinite(raw.lastErrorAt) ? Number(raw.lastErrorAt) : undefined,
    consecutiveErrors: Number.isFinite(raw.consecutiveErrors) ? Math.max(0, Number(raw.consecutiveErrors)) : 0,
    lastFiredAt: Number.isFinite(raw.lastFiredAt) ? Number(raw.lastFiredAt) : undefined,
    totalFires: Number.isFinite(raw.totalFires) ? Math.max(0, Number(raw.totalFires)) : 0,
    events,
  };
}

/** Read watches.json. A corrupt file is moved aside, never thrown at the caller. */
export function readWatchFile(): { file: WatchFile; warning?: string } {
  const path = watchFile();
  if (!existsSync(path)) return { file: emptyFile() };
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (e: any) { return { file: emptyFile(), warning: `could not read ${path}: ${e?.message ?? e}` }; }
  if (!raw.trim()) return { file: emptyFile() };
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch {
    const dest = backupCorrupt(path);
    return { file: emptyFile(), warning: `watch state was not valid JSON${dest ? `; moved it to ${dest}` : ""}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.watches)
    || (parsed.version !== undefined && parsed.version !== 1)) {
    const dest = backupCorrupt(path);
    return { file: emptyFile(), warning: `watch state has an unsupported shape${dest ? `; moved it to ${dest}` : ""}` };
  }
  const watches: Watch[] = [];
  let bad = 0;
  for (const item of parsed.watches) {
    const w = normalizeWatch(item);
    if (w) watches.push(w);
    else bad++;
  }
  return {
    file: { version: 1, watches },
    warning: bad ? `ignored ${bad} invalid watcher(s) in ${path}` : undefined,
  };
}

export function writeWatchFile(file: WatchFile) {
  const path = watchFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.watches.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const data = JSON.stringify({ version: 1, watches: file.watches }, null, 2) + "\n";
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w", 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try { renameSync(tmp, path); }
    catch (e: any) {
      // Windows may refuse to replace an existing file with rename; this fallback is not atomic,
      // but the temp file is already fully written and the window is tiny.
      if (process.platform === "win32" && (e?.code === "EEXIST" || e?.code === "EPERM")) {
        rmSync(path, { force: true });
        renameSync(tmp, path);
      } else throw e;
    }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; }
}

function lockIsStale(path: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw?.pid === "number" && pidAlive(raw.pid)) return false;
    return true;
  } catch {
    try { return Date.now() - statSync(path).mtimeMs > 60_000; }
    catch { return true; }
  }
}

async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = watchLockFile();
  mkdirSync(dirname(lock), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let acquired = false;
  for (let i = 0; i < 200; i++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
      closeSync(fd);
      acquired = true;
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      if (lockIsStale(lock)) { rmSync(lock, { force: true }); continue; }
      await sleep(25);
    }
  }
  if (!acquired) throw new Error(`watch state is locked (${lock}); remove it if no mb process is running`);
  try {
    return await fn();
  } finally {
    try {
      const raw = JSON.parse(readFileSync(lock, "utf8"));
      if (raw?.token === token) rmSync(lock, { force: true });
    } catch { /* the lock may already be gone */ }
  }
}

/** Serialize a read-modify-write of watches.json across processes. */
export async function mutateWatchFile<T>(fn: (file: WatchFile) => T | Promise<T>): Promise<T> {
  return withStateLock(async () => {
    const { file } = readWatchFile();
    const result = await fn(file);
    writeWatchFile(file);
    return result;
  });
}

export function hasEnabledWatches(): boolean {
  try { return readWatchFile().file.watches.some((w) => w.enabled); }
  catch { return false; }
}

// ---- fetching ------------------------------------------------------------------------------

export class WatchFetchError extends Error {
  status?: number;
  retryAfterMs?: number;
  constructor(message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "WatchFetchError";
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const sec = Number(value);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function fetchBody(url: string, accept: string, timeoutMs = 20_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: accept, "User-Agent": "monad-browser watch" },
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok) {
      if (res.body) await res.body.cancel().catch(() => {});
      throw new WatchFetchError(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`, {
        status: res.status,
        retryAfterMs: retryAfter(res.headers.get("retry-after")),
      });
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          throw new WatchFetchError(`response is larger than ${MAX_BODY_BYTES} bytes`);
        }
        chunks.push(value);
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_BODY_BYTES) throw new WatchFetchError(`response is larger than ${MAX_BODY_BYTES} bytes`);
      chunks.push(buf);
    }
    return {
      body: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"),
      contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
      finalUrl: res.url || url,
      status: res.status,
    };
  } catch (e: any) {
    if (e instanceof WatchFetchError) throw e;
    if (e?.name === "AbortError") throw new WatchFetchError(`timed out after ${timeoutMs} ms`);
    throw new WatchFetchError(e?.cause?.message ?? e?.message ?? String(e));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWatchValue(w: Watch, opts: WatchCheckOptions = {}): Promise<string> {
  if (w.kind === "page" && w.render) {
    if (!opts.render) throw new WatchFetchError("this watcher needs --render, but no browser is available");
    const html = await opts.render(w.source);
    if (!html.trim()) throw new WatchFetchError("rendered page is empty");
    if (w.extract.mode === "css") return normalizeValue(extractCss(html, w.extract.selector!));
    if (w.extract.mode === "json") return truncateBytes(extractJson(html, w.extract.path!), MAX_VALUE_BYTES);
    return normalizeValue(extractText(html, "text/html"));
  }
  const res = await fetchBody(w.source, w.kind === "page" ? PAGE_ACCEPT : FEED_ACCEPT);
  if (w.kind === "rss" || w.kind === "release") return normalizeValue(feedValue(parseFeed(res.body)));
  if (w.extract.mode === "css") return normalizeValue(extractCss(res.body, w.extract.selector!));
  if (w.extract.mode === "json") return truncateBytes(extractJson(res.body, w.extract.path!), MAX_VALUE_BYTES);
  return normalizeValue(extractText(res.body, res.contentType));
}

// ---- checking and state updates ------------------------------------------------------------

function errorOutcome(w: Watch, at: number, message: string): CheckOutcome {
  const delay = backoffMs(w.everySeconds * 1000, w.consecutiveErrors + 1);
  return {
    name: w.name, kind: w.kind, source: w.source, condition: w.condition, at,
    ok: false, fired: false, changed: false, previous: w.lastValue, next: "", diff: "",
    error: message, nextCheckAt: at + delay, backoffMs: delay,
  };
}

export async function checkWatch(w: Watch, opts: WatchCheckOptions = {}): Promise<CheckOutcome> {
  const at = opts.now ?? Date.now();
  try {
    const next = await fetchWatchValue(w, opts);
    const nextHash = hashValue(next);
    const first = !w.lastHash;
    const changed = !first && nextHash !== w.lastHash;
    const fired = !first && shouldFire(w.kind, w.condition, changed, w.lastValue, next);
    return {
      name: w.name, kind: w.kind, source: w.source, condition: w.condition, at,
      ok: true, fired, changed, previous: w.lastValue, next,
      diff: fired ? diffValues(w.kind, w.lastValue, next) : "",
      nextCheckAt: at + w.everySeconds * 1000, backoffMs: 0,
    };
  } catch (e: any) {
    const errs = w.consecutiveErrors + 1;
    const delay = Math.min(MAX_BACKOFF_MS, Math.max(backoffMs(w.everySeconds * 1000, errs), e?.retryAfterMs ?? 0));
    return {
      name: w.name, kind: w.kind, source: w.source, condition: w.condition, at,
      ok: false, fired: false, changed: false, previous: w.lastValue, next: "", diff: "",
      error: e?.message ?? String(e), nextCheckAt: at + delay, backoffMs: delay, retryAfterMs: e?.retryAfterMs,
    };
  }
}

function addEvent(w: Watch, event: WatchEvent) {
  w.events.unshift(event);
  if (w.events.length > MAX_EVENTS) w.events.length = MAX_EVENTS;
}

/** Persist one check result: baseline, value, fire counters, error/backoff and logs. */
export async function applyOutcome(outcome: CheckOutcome): Promise<Watch | undefined> {
  return mutateWatchFile((file) => {
    const w = file.watches.find((x) => x.name === outcome.name);
    if (!w) return undefined;
    w.checkingUntil = undefined;
    w.updatedAt = outcome.at;
    w.lastCheckAt = outcome.at;
    if (!outcome.ok) {
      w.consecutiveErrors += 1;
      w.lastError = truncateBytes(outcome.error ?? "check failed", 512);
      w.lastErrorAt = outcome.at;
      w.nextCheckAt = outcome.nextCheckAt;
      addEvent(w, { at: outcome.at, kind: "error", summary: "", error: w.lastError });
      return w;
    }
    const first = !w.lastHash;
    w.consecutiveErrors = 0;
    w.lastError = undefined;
    w.lastErrorAt = undefined;
    w.lastValue = truncateBytes(outcome.next, MAX_VALUE_BYTES);
    w.lastHash = hashValue(w.lastValue);
    w.nextCheckAt = outcome.nextCheckAt;
    if (first) {
      addEvent(w, { at: outcome.at, kind: "baseline", summary: "baseline set" });
    } else if (outcome.fired) {
      w.lastFiredAt = outcome.at;
      w.totalFires += 1;
      addEvent(w, { at: outcome.at, kind: "fired", summary: truncateBytes(outcome.diff, 4096) });
    }
    for (const err of outcome.hookErrors ?? []) {
      w.lastError = truncateBytes(`hook: ${err}`, 512);
      w.lastErrorAt = outcome.at;
      addEvent(w, { at: outcome.at, kind: "hook-error", summary: "", error: w.lastError });
    }
    return w;
  });
}

export async function checkAndApply(w: Watch, opts: WatchCheckOptions = {}): Promise<CheckOutcome> {
  const outcome = await checkWatch(w, opts);
  if (outcome.fired) outcome.hookErrors = await runHooks(w, outcome);
  await applyOutcome(outcome);
  return outcome;
}

export async function claimDueWatches(now = Date.now(), limit = 4): Promise<Watch[]> {
  return mutateWatchFile((file) => {
    const claimed: Watch[] = [];
    for (const w of file.watches) {
      if (!w.enabled) continue;
      if (w.checkingUntil && w.checkingUntil > now) continue;
      if (w.nextCheckAt > now) continue;
      w.checkingUntil = now + WATCH_LEASE_MS;
      w.nextCheckAt = now + WATCH_LEASE_MS;
      w.updatedAt = now;
      claimed.push(structuredClone(w));
      if (claimed.length >= limit) break;
    }
    return claimed;
  });
}

export async function claimWatches(names: string[], now = Date.now()): Promise<{ claimed: Watch[]; skipped: string[]; missing: string[] }> {
  return mutateWatchFile((file) => {
    const wanted = new Set(names);
    const claimed: Watch[] = [];
    const skipped: string[] = [];
    const found = new Set<string>();
    for (const w of file.watches) {
      if (!wanted.has(w.name)) continue;
      found.add(w.name);
      if (w.checkingUntil && w.checkingUntil > now) { skipped.push(w.name); continue; }
      w.checkingUntil = now + WATCH_LEASE_MS;
      w.nextCheckAt = now + WATCH_LEASE_MS;
      w.updatedAt = now;
      claimed.push(structuredClone(w));
    }
    return { claimed, skipped, missing: names.filter((n) => !found.has(n)) };
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export type CheckManyResult = { checked: number; fired: CheckOutcome[]; errors: CheckOutcome[]; skipped: string[] };

/** Manually check one watcher or all enabled watchers, regardless of their next due time. */
export async function checkWatches(target: string, opts: WatchCheckOptions = {}): Promise<CheckManyResult> {
  const { file } = readWatchFile();
  const selected = target === "all" ? file.watches.filter((w) => w.enabled) : file.watches.filter((w) => w.name === target);
  if (!selected.length) throw new Error(target === "all" ? "no watchers" : `no watcher named ${target}`);
  const claim = await claimWatches(selected.map((w) => w.name), opts.now);
  if (target !== "all" && claim.skipped.length)
    throw new Error(`watch ${target} is already being checked; try again in a moment`);
  const outcomes = await mapLimit(claim.claimed, 4, async (w) => {
    try { return await checkAndApply(w, opts); }
    catch (e: any) {
      const failed = errorOutcome(w, Date.now(), e?.message ?? String(e));
      await applyOutcome(failed).catch(() => {});
      return failed;
    }
  });
  return {
    checked: claim.claimed.length,
    fired: outcomes.filter((o) => o.fired),
    errors: outcomes.filter((o) => !o.ok),
    skipped: claim.skipped,
  };
}

// ---- adding and removing -------------------------------------------------------------------

export type AddWatchOptions = {
  source: string;
  kind?: WatchKind;
  extract?: string;
  condition?: string;
  every: string;
  name?: string;
  render?: boolean;
  exec?: string;
  notify?: boolean;
  cwd?: string;
};

export async function addWatch(opts: AddWatchOptions, checkOpts: WatchCheckOptions = {}): Promise<{ watch: Watch; outcome: CheckOutcome }> {
  const everySeconds = Math.round(parseDuration(opts.every) / 1000);
  const kind = opts.kind ?? inferKind(opts.source);
  const repo = kind === "release" ? normalizeRepo(opts.source) : undefined;
  const source = repo ? releasesFeedUrl(repo) : normalizeHttpUrl(opts.source);
  const extract = parseExtract(opts.extract, kind);
  const condition = parseCondition(opts.condition ?? "changed");
  if (kind !== "page" && opts.render) throw new Error("--render only applies to --kind page");
  if (opts.exec !== undefined) {
    const argv = splitCommand(opts.exec);
    if (!argv.length) throw new Error("--exec command is empty");
  }
  if (opts.notify && !notifyUrl()) throw new Error("--notify needs MONAD_WATCH_NOTIFY_URL or watchNotifyUrl in config");
  const requested = opts.name?.trim();
  if (requested) validateName(requested);
  const now = Date.now();
  const baseName = requested || deriveName(kind, source, extract);
  const w: Watch = {
    name: baseName, kind, source, repo, extract, condition, everySeconds,
    render: !!opts.render, exec: opts.exec?.trim() || undefined, notify: !!opts.notify,
    cwd: opts.cwd || process.cwd(), enabled: true, createdAt: now, updatedAt: now,
    nextCheckAt: now + WATCH_LEASE_MS, checkingUntil: now + WATCH_LEASE_MS,
    lastValue: "", lastHash: "", consecutiveErrors: 0, totalFires: 0, events: [],
  };
  const stored = await mutateWatchFile((file) => {
    let name = baseName;
    if (file.watches.some((x) => x.name === name)) {
      if (requested) throw new Error(`a watcher named "${name}" already exists`);
      let n = 2;
      while (file.watches.some((x) => x.name === `${baseName}-${n}`)) n++;
      name = `${baseName}-${n}`;
    }
    w.name = name;
    file.watches.push(w);
    return structuredClone(w);
  });
  let outcome: CheckOutcome;
  try {
    outcome = await checkAndApply(stored, checkOpts);
  } catch (e: any) {
    outcome = errorOutcome(stored, Date.now(), e?.message ?? String(e));
    await applyOutcome(outcome).catch(() => {});
  }
  const updated = readWatchFile().file.watches.find((x) => x.name === stored.name) ?? stored;
  return { watch: updated, outcome };
}

export async function removeWatch(name: string): Promise<Watch> {
  return mutateWatchFile((file) => {
    const at = file.watches.findIndex((w) => w.name === name);
    if (at < 0) throw new Error(`no watcher named ${name}`);
    return file.watches.splice(at, 1)[0];
  });
}

export type LogsResult = { events: { name: string; event: WatchEvent }[]; warning?: string };

export function readLogs(name?: string): LogsResult {
  const { file, warning } = readWatchFile();
  const watches = name ? file.watches.filter((w) => w.name === name) : file.watches;
  if (name && !watches.length) throw new Error(`no watcher named ${name}`);
  const events = watches.flatMap((w) => w.events.map((event) => ({ name: w.name, event })))
    .sort((a, b) => b.event.at - a.event.at);
  return { events, warning };
}

// ---- hooks ---------------------------------------------------------------------------------

export function notifyUrl(): string | undefined {
  return process.env.MONAD_WATCH_NOTIFY_URL?.trim() || undefined;
}

/** Split a command line into argv without a shell. Quotes group; backslashes stay literal. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "", quote = "";
  const s = command.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && (s[i + 1] === '"' || s[i + 1] === "\\")) { cur += s[++i]; continue; }
      if (ch === quote) { quote = ""; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (quote) throw new Error("unterminated quote in --exec command");
  if (cur) out.push(cur);
  return out;
}

export async function runExec(command: string, cwd: string, timeoutMs = 30_000): Promise<void> {
  const argv = splitCommand(command);
  if (!argv.length) throw new Error("exec command is empty");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => { if (stderr.length < 2048) stderr += String(d); });
    child.stdout?.resume();
    const timer = setTimeout(() => { child.kill(); reject(new Error(`exec timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exec exited ${code ?? signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function asciiHeader(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?");
}

export async function runNotify(w: Watch, outcome: CheckOutcome, url = notifyUrl()): Promise<void> {
  if (!url) throw new Error("notify URL is not configured (MONAD_WATCH_NOTIFY_URL)");
  const body = `${w.name} fired (${describeCondition(w.condition)})\n${w.source}\n\n${outcome.diff}\n\nprevious: ${outcome.previous}\nnext: ${outcome.next}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8", "Title": asciiHeader(`watch: ${w.name}`), "Tags": "eyes" },
      body: truncateBytes(body, 3500),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`notify returned HTTP ${res.status}`);
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("notify timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function runHooks(w: Watch, outcome: CheckOutcome): Promise<string[]> {
  const errors: string[] = [];
  if (w.exec) {
    try { await runExec(w.exec, w.cwd); }
    catch (e: any) { errors.push(`exec: ${e?.message ?? e}`); }
  }
  if (w.notify) {
    try { await runNotify(w, outcome); }
    catch (e: any) { errors.push(`notify: ${e?.message ?? e}`); }
  }
  return errors;
}

// ---- scheduler and foreground loop ---------------------------------------------------------

export type SchedulerOptions = {
  render?: RenderFn;
  onTick?: (active: boolean) => void;
  log?: (message: string) => void;
};

/** Start the daemon-side timer. It reads watches.json every tick, so CLI changes are live. */
export function startWatchScheduler(opts: SchedulerOptions = {}) {
  let stopped = false, running = false;
  const log = opts.log ?? (() => {});
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const active = hasEnabledWatches();
      opts.onTick?.(active);
      if (!active) return;
      const due = await claimDueWatches();
      await mapLimit(due, 4, async (w) => {
        try { await checkAndApply(w, { render: opts.render }); }
        catch (e: any) { log(`${w.name}: ${e?.message ?? e}`); }
      });
    } catch (e: any) {
      log(`scheduler: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, WATCH_TICK_MS);
  timer.unref?.();
  void tick();
  return { stop() { stopped = true; clearInterval(timer); }, tick };
}

export type ForegroundOptions = {
  json?: boolean;
  render?: RenderFn;
  signal?: AbortSignal;
  pollMs?: number;
  /** TTY formatters; undefined keeps the plain contract. */
  format?: (o: CheckOutcome) => string;
  formatError?: (o: CheckOutcome) => string;
  formatStatus?: (s: string) => string;
};

/** Foreground loop for CI/systemd. Prints only fired events (JSONL with --json). */
export async function runWatchForeground(opts: ForegroundOptions = {}): Promise<number> {
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  const linkSignal = () => opts.signal?.addEventListener("abort", onSignal, { once: true });
  linkSignal();
  if (opts.signal?.aborted) ac.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  if (process.platform === "win32") process.once("SIGBREAK", onSignal);
  const wait = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    ac.signal.addEventListener("abort", onAbort, { once: true });
    function done() {
      clearTimeout(timer);
      ac.signal.removeEventListener("abort", onAbort);
      resolve();
    }
  });
  const stderr = (s: string) => process.stderr.write(s.endsWith("\n") ? s : s + "\n");
  const stdout = (s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
  const say = (s: string) => stderr(opts.formatStatus ? opts.formatStatus(s) : s);
  const show = (o: CheckOutcome) => {
    if (o.fired) {
      if (opts.json) stdout(JSON.stringify(publicOutcome(o)));
      else stdout(opts.format ? opts.format(o) : formatFire(o));
    } else if (!o.ok) {
      if (opts.json) stdout(JSON.stringify(publicOutcome(o)));
      else stderr(opts.formatError ? opts.formatError(o) : formatCheckError(o));
    }
  };
  try {
    const { file, warning } = readWatchFile();
    if (warning) say(`warning: ${warning}`);
    const active = file.watches.filter((w) => w.enabled).length;
    if (!active) { say("no watchers"); return 0; }
    say(`watching ${active} watcher(s) — Ctrl-C to stop`);
    while (!ac.signal.aborted) {
      if (!hasEnabledWatches()) { say("no watchers left; stopping"); break; }
      let due: Watch[] = [];
      try { due = await claimDueWatches(); }
      catch (e: any) { say(`watch: ${e?.message ?? e}`); }
      for (const w of due) {
        if (ac.signal.aborted) break;
        try { show(await checkAndApply(w, { render: opts.render })); }
        catch (e: any) { say(`watch ${w.name}: ${e?.message ?? e}`); }
      }
      if (!ac.signal.aborted) await wait(opts.pollMs ?? 1000);
    }
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (process.platform === "win32") process.off("SIGBREAK", onSignal);
    opts.signal?.removeEventListener("abort", onSignal);
  }
}

// ---- output --------------------------------------------------------------------------------

function valueBlock(label: string, value: string): string {
  const v = truncateBytes(value, 2000);
  if (!v) return `${label}: (empty)`;
  if (!v.includes("\n")) return `${label}: ${v}`;
  return `${label}:\n${v.split("\n").map((l) => `  ${l}`).join("\n")}`;
}

export function formatFire(o: CheckOutcome): string {
  const lines = [`[${iso(o.at)}] ${o.name} fired (${describeCondition(o.condition)})`, `source: ${o.source}`];
  if (o.diff) lines.push(o.diff);
  lines.push(valueBlock("previous", o.previous), valueBlock("next", o.next));
  return lines.join("\n");
}

export function formatCheckError(o: CheckOutcome): string {
  return `[${iso(o.at)}] ${o.name} error: ${o.error ?? "check failed"} (next check ${iso(o.nextCheckAt)})`;
}

export function publicOutcome(o: CheckOutcome) {
  return {
    type: o.ok ? (o.fired ? "fired" : "unchanged") : "error",
    name: o.name, kind: o.kind, source: o.source, condition: describeCondition(o.condition),
    at: iso(o.at), fired: o.fired, changed: o.changed, diff: o.diff,
    previous: o.previous, next: o.next, error: o.error ?? null, nextCheckAt: iso(o.nextCheckAt),
  };
}

export function publicWatch(w: Watch) {
  return {
    name: w.name, kind: w.kind, source: w.source, repo: w.repo ?? null,
    extract: w.extract, condition: w.condition, everySeconds: w.everySeconds,
    every: formatDuration(w.everySeconds * 1000), render: w.render,
    exec: !!w.exec, notify: w.notify, enabled: w.enabled,
    createdAt: iso(w.createdAt), updatedAt: iso(w.updatedAt),
    lastCheckAt: w.lastCheckAt ? iso(w.lastCheckAt) : null,
    nextCheckAt: iso(w.nextCheckAt),
    lastError: w.lastError ?? null, lastErrorAt: w.lastErrorAt ? iso(w.lastErrorAt) : null,
    consecutiveErrors: w.consecutiveErrors,
    lastFiredAt: w.lastFiredAt ? iso(w.lastFiredAt) : null,
    totalFires: w.totalFires, lastValue: w.lastValue,
  };
}

export function publicEvent(name: string, event: WatchEvent) {
  return { name, at: iso(event.at), kind: event.kind, summary: event.summary, error: event.error ?? null };
}
