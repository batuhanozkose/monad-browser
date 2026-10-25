// `mb watch …` lives in the CLI process, not the daemon: list/logs/remove and the default
// Chrome-less fetch must work without a browser. The daemon only hosts the timer; `watch run`
// is the foreground alternative.
import { parseArgs } from "./commands.js";
import type { Browser } from "./browser.js";
import { WATCH_HELP } from "./watch-usage.js";
import {
  addWatch, checkWatches, formatCheckError, formatDuration, formatFire, iso,
  publicEvent, publicOutcome, publicWatch, readLogs, readWatchFile, removeWatch,
  runWatchForeground, type CheckOutcome, type Watch,
} from "./watch.js";

export type WatchCommandResult = { out?: string; startDaemon?: boolean; exitCode?: number };

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (v === true) throw new Error(`--${key} needs a value`);
  return String(v);
}

function lazyRenderer() {
  let browser: Browser | undefined;
  let starting: Promise<void> | undefined;
  return {
    async render(url: string): Promise<string> {
      if (!browser) {
        const { Browser } = await import("./browser.js");
        browser = new Browser({});
        starting = browser.start();
      }
      await starting;
      return browser!.renderHtml(url);
    },
    async close() {
      const b = browser;
      browser = undefined;
      starting = undefined;
      await b?.close();
    },
  };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function listText(watches: Watch[]): string {
  if (!watches.length) return "no watchers";
  return watches.map((w) => {
    const bits = [w.name, w.kind, `every ${formatDuration(w.everySeconds * 1000)}`, `next ${iso(w.nextCheckAt)}`];
    if (w.render) bits.push("render");
    if (w.exec) bits.push("exec");
    if (w.notify) bits.push("notify");
    bits.push(w.lastError ? `error ${oneLine(w.lastError)}` : "ok");
    let line = bits.join("  ");
    line += `\n  source: ${w.source}`;
    if (w.lastError) line += `\n  last error: ${oneLine(w.lastError)}${w.lastErrorAt ? ` (${iso(w.lastErrorAt)})` : ""}`;
    if (w.lastFiredAt) line += `\n  last fired: ${iso(w.lastFiredAt)} (${w.totalFires} total)`;
    return line;
  }).join("\n");
}

function logsText(events: { name: string; event: { at: number; kind: string; summary: string; error?: string } }[]): string {
  if (!events.length) return "(no events)";
  return events.map(({ name, event }) => {
    const head = `[${iso(event.at)}] ${name} ${event.kind}`;
    const body = event.error ?? event.summary;
    return body ? `${head}\n${body.split("\n").map((l) => `  ${l}`).join("\n")}` : head;
  }).join("\n");
}

function addText(w: Watch, outcome: CheckOutcome): string {
  const status = outcome.ok ? "baseline set" : `first check failed: ${oneLine(outcome.error ?? "unknown error")}`;
  return `ok watching ${w.name} every ${formatDuration(w.everySeconds * 1000)} (${status})\n  source: ${w.source}`;
}

function checkText(result: { fired: CheckOutcome[] }): string {
  return result.fired.map(formatFire).join("\n\n");
}

export async function runWatchCommand(argv: string[], opts: { cwd: string }): Promise<WatchCommandResult> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub) throw new Error(WATCH_HELP);
  const { args, flags } = parseArgs(rest);
  const json = !!flags.json;

  if (sub === "add") {
    const source = args[0];
    if (!source) throw new Error(`usage: mb watch add <url|owner/repo> --every <duration>\n\n${WATCH_HELP}`);
    const every = str(flags, "every");
    if (!every) throw new Error("--every is required (for example --every 5m)");
    const kind = str(flags, "kind");
    if (kind && kind !== "page" && kind !== "rss" && kind !== "release")
      throw new Error("--kind must be page, rss or release");
    const renderer = lazyRenderer();
    try {
      const result = await addWatch({
        source,
        kind: kind as "page" | "rss" | "release" | undefined,
        extract: str(flags, "extract"),
        condition: str(flags, "condition"),
        every,
        name: str(flags, "name"),
        render: !!flags.render,
        exec: str(flags, "exec"),
        notify: !!flags.notify,
        cwd: opts.cwd,
      }, { render: renderer.render });
      const out = json
        ? JSON.stringify({ watch: publicWatch(result.watch), check: publicOutcome(result.outcome) })
        : addText(result.watch, result.outcome);
      return { out, startDaemon: true };
    } finally {
      await renderer.close();
    }
  }

  if (sub === "list") {
    if (args.length) throw new Error("usage: mb watch list [--json]");
    const { file, warning } = readWatchFile();
    if (warning) process.stderr.write(`warning: ${warning}\n`);
    const out = json ? JSON.stringify({ watches: file.watches.map(publicWatch) }) : listText(file.watches);
    return { out };
  }

  if (sub === "check") {
    if (args.length > 1) throw new Error("usage: mb watch check [name|all] [--json]");
    const target = args[0] ?? "all";
    const renderer = lazyRenderer();
    try {
      const result = await checkWatches(target, { render: renderer.render });
      if (json) {
        const out = JSON.stringify({
          checked: result.checked,
          fired: result.fired.map(publicOutcome),
          errors: result.errors.map(publicOutcome),
          skipped: result.skipped,
        });
        return { out, exitCode: result.errors.length ? 1 : 0 };
      }
      for (const e of result.errors) process.stderr.write(formatCheckError(e) + "\n");
      if (result.skipped.length) process.stderr.write(`already checking: ${result.skipped.join(", ")}\n`);
      return { out: checkText(result), exitCode: result.errors.length ? 1 : 0 };
    } finally {
      await renderer.close();
    }
  }

  if (sub === "remove") {
    if (args.length !== 1) throw new Error("usage: mb watch remove <name>");
    const removed = await removeWatch(args[0]);
    return { out: json ? JSON.stringify({ removed: removed.name }) : `ok removed ${removed.name}` };
  }

  if (sub === "logs") {
    if (args.length > 1) throw new Error("usage: mb watch logs [name] [--json]");
    const { events, warning } = readLogs(args[0]);
    if (warning) process.stderr.write(`warning: ${warning}\n`);
    const out = json
      ? JSON.stringify({ events: events.map((e) => publicEvent(e.name, e.event)) })
      : logsText(events);
    return { out };
  }

  if (sub === "run") {
    if (args.length) throw new Error("usage: mb watch run [--json]");
    const renderer = lazyRenderer();
    try {
      const code = await runWatchForeground({ json, render: renderer.render });
      return { exitCode: code };
    } finally {
      await renderer.close();
    }
  }

  throw new Error(WATCH_HELP);
}
