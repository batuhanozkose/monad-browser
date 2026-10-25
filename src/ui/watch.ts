// TTY rendering for `mb watch` list/check/logs/add/fire. The plain strings in
// watch-cli stay the contract for pipes and --json; this file is only called
// when the CLI has a terminal.
import { describeCondition, formatDuration, type CheckOutcome, type Watch } from "../watch.js";
import { paint, type StyleName, type Ui } from "./color.js";
import { padEnd, stringWidth, truncate, wrap } from "./width.js";

type LogEvent = { name: string; event: { at: number; kind: string; summary: string; error?: string } };

function stamp(iso: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function nextLabel(iso: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const ms = t - Date.now();
  if (ms <= 0) return "due";
  return `in ${formatDuration(ms)}`;
}

function label(ui: Ui, text: string, width = 9): string {
  return paint(ui, padEnd(text, width), "dim");
}

function styleValue(value: string, ui: Ui): string {
  const one = value.replace(/\s+/g, " ").trim();
  const clipped = truncate(one, Math.max(20, ui.width - 14), ui.glyphs.ellipsis);
  return clipped.replace(/(\d[\d,.]*)/g, (m) => paint(ui, m, "num"));
}

function styleDiffLine(line: string, ui: Ui): string {
  if (line.startsWith("+")) return paint(ui, "+", "add") + " " + paint(ui, line.slice(1).trim(), "addText");
  if (line.startsWith("-")) return paint(ui, "-", "del") + " " + paint(ui, line.slice(1).trim(), "delText");
  const arrow = line.indexOf(" → ");
  if (arrow >= 0) {
    return styleValue(line.slice(0, arrow), ui) + " " + paint(ui, ui.glyphs.arrow, "dim") + " " + styleValue(line.slice(arrow + 3), ui);
  }
  return styleValue(line, ui);
}

function block(value: string, ui: Ui, maxLines = 5): string[] {
  const lines = value.split("\n").filter((l) => l.length > 0);
  const out = lines.slice(0, maxLines).map((l) => styleDiffLine(l, ui));
  if (lines.length > maxLines) out.push(paint(ui, ui.glyphs.ellipsis + ` ${lines.length - maxLines} more lines`, "dim"));
  return out;
}

export function renderWatchList(watches: Watch[], ui: Ui): string {
  if (!watches.length) {
    return paint(ui, "no watchers", "dim") + "\n" + paint(ui, `${ui.glyphs.arrow} mb watch add <url> --every 5m`, "cmd");
  }
  const out: string[] = [];
  for (const w of watches) {
    const status = w.lastError ? "error" : "ok";
    const statusStyle: StyleName = w.lastError ? "del" : "ok";
    const head = `${paint(ui, w.lastError ? ui.glyphs.fail : ui.glyphs.ok, statusStyle)} ${paint(ui, w.name, "title")}`;
    if (ui.width >= 70) {
      const bits = `${paint(ui, w.kind, "role")} ${ui.glyphs.dot} every ${formatDuration(w.everySeconds * 1000)} ${ui.glyphs.dot} next ${nextLabel(w.nextCheckAt)}`;
      out.push(head + "  " + bits + "  " + paint(ui, status, statusStyle));
    } else {
      out.push(head);
      out.push(`  ${paint(ui, w.kind, "role")} ${ui.glyphs.dot} every ${formatDuration(w.everySeconds * 1000)} ${ui.glyphs.dot} next ${nextLabel(w.nextCheckAt)} ${ui.glyphs.dot} ${paint(ui, status, statusStyle)}`);
    }
    out.push(`  ${label(ui, "source")}${paint(ui, truncate(w.source, Math.max(20, ui.width - 12), ui.glyphs.ellipsis), "url")}`);
    if (w.lastError) out.push(`  ${label(ui, "error")}${paint(ui, truncate(w.lastError, Math.max(20, ui.width - 12), ui.glyphs.ellipsis), "del")}`);
    if (w.lastFiredAt) out.push(`  ${label(ui, "last")}${paint(ui, `fired ${stamp(w.lastFiredAt)} (${w.totalFires} total)`, "dim")}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

export function renderWatchFire(o: CheckOutcome, ui: Ui): string {
  const head = `${paint(ui, ui.glyphs.ok, "ok")} ${paint(ui, o.name, "title")} fired  ${paint(ui, stamp(o.at), "dim")}  (${describeCondition(o.condition)})`;
  const out = [head, `  ${label(ui, "source")}${paint(ui, truncate(o.source, Math.max(20, ui.width - 12), ui.glyphs.ellipsis), "url")}`];
  if (o.diff) {
    const diffLines = block(o.diff, ui, 6);
    out.push(`  ${label(ui, "diff")}${diffLines[0] ?? ""}`);
    for (const line of diffLines.slice(1)) out.push(`  ${" ".repeat(9)}${line}`);
  }
  for (const [name, value] of [["was", o.previous], ["now", o.next]] as const) {
    if (!value) continue;
    const lines = block(value, ui, 4);
    out.push(`  ${label(ui, name)}${lines[0] ?? ""}`);
    for (const line of lines.slice(1)) out.push(`  ${" ".repeat(9)}${line}`);
  }
  return out.join("\n");
}

export function renderWatchError(o: CheckOutcome, ui: Ui): string {
  return `${paint(ui, ui.glyphs.fail, "del")} ${paint(ui, o.name, "title")} error: ${paint(ui, o.error ?? "check failed", "del")} ${paint(ui, `(next ${nextLabel(o.nextCheckAt)})`, "dim")}`;
}

export function renderWatchLogs(events: LogEvent[], ui: Ui): string {
  if (!events.length) return paint(ui, "(no events)", "dim");
  const out: string[] = [];
  for (const { name, event } of events) {
    const style: StyleName = event.kind === "fired" ? "ok" : event.kind === "error" ? "del" : event.kind === "baseline" ? "accent" : "dim";
    out.push(`${paint(ui, `[${stamp(new Date(event.at).toISOString())}]`, "dim")} ${paint(ui, name, "title")} ${paint(ui, event.kind, style)}`);
    const body = event.error ?? event.summary;
    if (body) {
      const lines = block(body, ui, 6);
      for (const line of lines) out.push(`  ${line}`);
    }
  }
  return out.join("\n");
}

export function renderWatchAdd(w: Watch, outcome: CheckOutcome, ui: Ui): string {
  const ok = outcome.ok;
  const status = ok ? "baseline set" : `first check failed: ${outcome.error ?? "unknown error"}`;
  const head = `${paint(ui, ok ? ui.glyphs.ok : ui.glyphs.warn, ok ? "ok" : "warn")} ${paint(ui, "watching", "ok")} ${paint(ui, w.name, "title")} ${ui.glyphs.dot} every ${formatDuration(w.everySeconds * 1000)} ${ui.glyphs.dot} ${paint(ui, status, ok ? "dim" : "warn")}`;
  return `${head}\n  ${label(ui, "source")}${paint(ui, truncate(w.source, Math.max(20, ui.width - 12), ui.glyphs.ellipsis), "url")}`;
}

export function renderWatchRemove(name: string, ui: Ui): string {
  return `${paint(ui, ui.glyphs.ok, "ok")} removed ${paint(ui, name, "title")}`;
}

export function renderWatchRunStart(count: number, ui: Ui): string {
  return paint(ui, `watching ${count} watcher${count === 1 ? "" : "s"} · Ctrl-C to stop`, "dim");
}
