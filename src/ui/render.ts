// TTY renderer for snapshots, diffs, action receipts, errors and doctor.
// It consumes the existing plain strings, so the daemon, MCP and every pipe keep
// their exact output; only the CLI's terminal path calls into this file.
import type { DoctorReport } from "../doctor.js";
import { formatMs, paint, replaceGlyphs, type StyleName, type Ui } from "./color.js";
import { padEnd, stringWidth, truncate, wrap, wrapTreeLine } from "./width.js";

type Header = { title: string; url: string };

const ROLE_RE = /^(banner|main|nav|navigation|heading|form|table|row|complementary|contentinfo|text|textbox|combobox|checkbox|button|link|clickable|list|listitem|paragraph|region|article|img|image|dialog|status|search|tab|tablist|menuitem|option|switch|slider|radio|rowgroup|cell)\b/;

function headerOf(line: string): Header | undefined {
  const m = /^# (.*) — (https?:\/\/\S+)$/.exec(line);
  return m ? { title: m[1], url: m[2] } : undefined;
}

function gap(left: string, right: string, width: number): string {
  return " ".repeat(Math.max(1, width - stringWidth(left) - stringWidth(right)));
}

/** Paint refs, URLs, roles, quoted names and state blocks inside one line. */
function styleInline(text: string, ui: Ui, base?: StyleName, heading = false): string {
  const out: string[] = [];
  const re = /(\[[^\]]*\]@\d+)|(@\d+)|(value="[^"]*")|("(?:[^"\\]|\\.)*")|(\[[^\]]*\])|(https?:\/\/[^\s)]+)|(\b(?:banner|main|nav|navigation|heading|form|table|row|complementary|contentinfo|text|textbox|combobox|checkbox|button|link|clickable|list|listitem|paragraph|region|article|img|image|dialog|status|search|tab|tablist|menuitem|option|switch|slider|radio|rowgroup|cell)\b)|(…)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const plain = (s: string) => (base ? paint(ui, s, base) : s);
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(plain(text.slice(last, m.index)));
    if (m[1]) {
      const [inside, ref] = m[1].split("]@");
      const inner = inside.slice(1);
      const first = inner.split(" ")[0];
      if (ROLE_RE.test(first)) {
        out.push(plain("["));
        out.push(paint(ui, first, "role"));
        if (inner.length > first.length) out.push(plain(inner.slice(first.length)));
        out.push(plain("]"));
      } else {
        out.push(plain("[" + inner + "]"));
      }
      out.push(paint(ui, "@" + ref, "ref"));
    } else if (m[2]) {
      out.push(paint(ui, m[2], "ref"));
    } else if (m[3]) {
      const [k, v] = m[3].split("=");
      out.push(paint(ui, k + "=", "dim"));
      const num = /^\d[\d,.]*$/.test(v.slice(1, -1));
      out.push(num ? paint(ui, v, "num") : plain(v));
    } else if (m[4]) {
      out.push(heading ? paint(ui, m[4], "title") : plain(m[4]));
    } else if (m[5]) {
      const inner = m[5].slice(1, -1);
      out.push(paint(ui, m[5], /^(level|checked|selected|expanded|pressed|disabled|required|invalid|readonly|focused)=/.test(inner) ? "state" : "dim"));
    } else if (m[6]) {
      out.push(paint(ui, m[6], "url"));
    } else if (m[7]) {
      out.push(paint(ui, m[7], "role"));
    } else if (m[8]) {
      out.push(paint(ui, m[8], "dim"));
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(plain(text.slice(last)));
  return out.join("");
}

function styleTreeLine(raw: string, ui: Ui): string {
  const lead = raw.match(/^\s*/)?.[0] ?? "";
  const body = raw.slice(lead.length);
  if (body.startsWith("- ")) {
    const rest = body.slice(2);
    return paint(ui, lead, "dim") + paint(ui, "-", "dim") + " " + styleInline(rest, ui, undefined, /^heading\b/.test(rest));
  }
  return paint(ui, lead, "dim") + styleInline(body, ui);
}

function stripTreeDash(s: string): string {
  const m = /^(\s*)- (.*)$/.exec(s);
  return m ? m[1] + m[2] : s;
}

function wordDiff(a: string, b: string): { a: [string, boolean][]; b: [string, boolean][] } {
  const aw = a.split(/(\s+)/);
  const bw = b.split(/(\s+)/);
  const n = aw.length, m = bw.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = aw[i] === bw[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const aOut: [string, boolean][] = [], bOut: [string, boolean][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aw[i] === bw[j]) { aOut.push([aw[i], false]); bOut.push([bw[j], false]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { aOut.push([aw[i++], true]); }
    else { bOut.push([bw[j++], true]); }
  }
  while (i < n) aOut.push([aw[i++], true]);
  while (j < m) bOut.push([bw[j++], true]);
  return { a: aOut, b: bOut };
}

function styleChangedWords(words: [string, boolean][], ui: Ui, base: StyleName, hl: StyleName): string {
  return words.map(([w, changed]) => {
    if (/^\s+$/.test(w)) return w;
    // Refs and URLs keep their semantic color in both halves of the diff.
    return styleInline(w, ui, changed ? hl : base);
  }).join("");
}

export type SnapshotOptions = { width?: number; showFooter?: boolean };

export function renderSnapshot(text: string, ui: Ui, opts: SnapshotOptions = {}): string {
  const lines = text.split("\n");
  const header = headerOf(lines[0] ?? "");
  const body = header ? lines.slice(1) : lines;
  const width = Math.min(opts.width ?? ui.width, 100);
  const refs = new Set([...text.matchAll(/@(\d+)/g)].map((m) => m[1]));
  const out: string[] = [];

  if (header) {
    const meta = `${body.length} line${body.length === 1 ? "" : "s"} ${ui.glyphs.dot} ${refs.size} ref${refs.size === 1 ? "" : "s"}`;
    out.push(paint(ui, truncate(header.title, width, ui.glyphs.ellipsis), "title"));
    const url = width >= 60
      ? truncate(header.url, Math.max(20, width - stringWidth(meta) - 2), ui.glyphs.ellipsis)
      : truncate(header.url, width, ui.glyphs.ellipsis);
    if (width >= 60 && stringWidth(url) + 2 + stringWidth(meta) <= width) {
      out.push(paint(ui, url, "url") + gap(url, meta, width) + paint(ui, meta, "dim"));
    } else {
      out.push(paint(ui, url, "url"));
      out.push(paint(ui, meta, "dim"));
    }
    out.push(paint(ui, ui.glyphs.rule.repeat(width), "border"));
  }

  for (const raw0 of body) {
    const raw = ui.unicode ? raw0 : raw0.replaceAll("…", ui.glyphs.ellipsis);
    if (!raw) { out.push(""); continue; }
    if (/^… \d+ more lines/.test(raw)) {
      out.push(paint(ui, truncate(raw, width, ui.glyphs.ellipsis), "dim"));
      continue;
    }
    for (const line of wrapTreeLine(raw, width)) out.push(styleTreeLine(line, ui));
  }

  if (opts.showFooter !== false && refs.size && width >= 60) {
    const first = refs.values().next().value as string;
    out.push("");
    out.push(paint(ui, `mb click @${first} -s`, "cmd") + paint(ui, " to act", "dim"));
  }
  return out.join("\n");
}

export type DiffOptions = { showTitle?: boolean; width?: number };

function diffMeta(line: string): { added: number; removed: number; same: number; rev?: [string, string] } | undefined {
  const m = /\+(\d+) -(\d+), (\d+) unchanged/.exec(line);
  if (!m) return undefined;
  const rev = /rev (\d+)→(\d+)/.exec(line);
  return { added: Number(m[1]), removed: Number(m[2]), same: Number(m[3]), rev: rev ? [rev[1], rev[2]] : undefined };
}

export function renderDiff(text: string, ui: Ui, opts: DiffOptions = {}): string {
  const lines = text.split("\n");
  const width = Math.min(opts.width ?? ui.width, 100);
  const out: string[] = [];
  let i = 0;
  let header: Header | undefined;
  if (lines[0]?.startsWith("# ")) { header = headerOf(lines[0]); i = 1; }
  let meta = lines[i]?.startsWith("(diff ") ? diffMeta(lines[i]) : undefined;
  if (meta) i++;
  if (!meta && /^\+\d+ -\d+, \d+ unchanged$/.test(lines[i] ?? "")) { meta = diffMeta(lines[i]); i++; }
  const noChanges = /^no changes$/.test(lines[i] ?? "");
  const unchanged = /^unchanged rev \d+$/.test(lines[i] ?? "");

  if (opts.showTitle !== false && header) {
    out.push(paint(ui, truncate(header.title, width, ui.glyphs.ellipsis), "title"));
    out.push(paint(ui, truncate(header.url, width, ui.glyphs.ellipsis), "url"));
  }
  if (meta) {
    const stats = `${paint(ui, `+${meta.added}`, "add")} ${paint(ui, `${ui.unicode ? "−" : "-"}${meta.removed}`, "del")}  ${paint(ui, `${meta.same} unchanged`, "dim")}`;
    const rev = meta.rev ? paint(ui, `rev ${meta.rev[0]}${ui.glyphs.arrow}${meta.rev[1]}`, "dim") : "";
    if (width < 60) {
      out.push(paint(ui, "diff", "accent") + "  " + stats);
      if (rev) out.push(rev);
    } else {
      out.push(paint(ui, "diff", "accent") + "  " + (rev ? rev + "  " : "") + stats);
    }
    out.push(paint(ui, ui.glyphs.rule.repeat(width), "border"));
  } else if (noChanges) {
    out.push(paint(ui, "no changes", "dim"));
    i++;
  } else if (unchanged) {
    out.push(paint(ui, lines[i], "dim"));
    i++;
  }

  const body = lines.slice(i);
  for (let n = 0; n < body.length; n++) {
    const raw = body[n];
    if (!raw) { out.push(""); continue; }
    if (raw.startsWith("-") && body[n + 1]?.startsWith("+") && !raw.startsWith("---")) {
      const a = truncate(stripTreeDash(raw.slice(1)), width - 2, ui.glyphs.ellipsis);
      const b = truncate(stripTreeDash(body[n + 1].slice(1)), width - 2, ui.glyphs.ellipsis);
      const wd = wordDiff(a, b);
      out.push(paint(ui, "-", "del") + (a.startsWith(" ") ? "" : " ") + styleChangedWords(wd.a, ui, "delText", "delHl"));
      out.push(paint(ui, "+", "add") + (b.startsWith(" ") ? "" : " ") + styleChangedWords(wd.b, ui, "addText", "addHl"));
      n++;
      continue;
    }
    if (raw.startsWith("+")) {
      const body = truncate(stripTreeDash(raw.slice(1)), width - 2, ui.glyphs.ellipsis);
      out.push(paint(ui, "+", "add") + (body.startsWith(" ") ? "" : " ") + styleInline(body, ui, "addText"));
    } else if (raw.startsWith("-")) {
      const body = truncate(stripTreeDash(raw.slice(1)), width - 2, ui.glyphs.ellipsis);
      out.push(paint(ui, "-", "del") + (body.startsWith(" ") ? "" : " ") + styleInline(body, ui, "delText"));
    } else {
      out.push(styleTreeLine(truncate(raw, width, ui.glyphs.ellipsis), ui));
    }
  }
  return out.join("\n");
}

function styleActionBody(body: string, ui: Ui): string {
  const m = /^(\S+)(.*)$/.exec(body);
  if (!m) return body;
  const head = paint(ui, m[1], "ok");
  return head + styleInline(m[2], ui);
}

function actionReceipt(first: string, ui: Ui, ms?: number): string {
  let body = first.replace(/^ok\s+/, "");
  const opened = /^"([^"]*)"\s+(https?:\/\/\S+)$/.exec(body);
  if (opened) body = `opened "${opened[1]}" ${ui.glyphs.dot} ${opened[2]}`;
  else if (/^https?:\/\/\S+$/.test(body)) body = `opened ${body}`;
  else body = body.replace(/\s+—\s+/g, ` ${ui.glyphs.dot} `);
  const timing = formatMs(ms);
  const prefix = ui.unicode ? paint(ui, ui.glyphs.ok, "ok") + " " : paint(ui, "ok", "ok") + " ";
  return prefix + styleActionBody(body, ui) + (timing ? " " + paint(ui, `· ${timing}`, "dim") : "");
}

export function renderAction(text: string, ui: Ui, ms?: number): string {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  if (!first.startsWith("ok ")) return text;
  const receipt = actionReceipt(first, ui, ms);
  const rest = lines.slice(1).join("\n").trim();
  if (!rest) return receipt;
  if (rest.startsWith("# ") && rest.includes("(diff ")) return receipt + "\n\n" + renderDiff(rest, ui, { showTitle: false });
  if (rest.startsWith("# ")) return receipt + "\n\n" + renderSnapshot(rest, ui);
  if (rest.startsWith("(diff ") || /^\+\d+ -\d+, \d+ unchanged/.test(rest) || /^no changes$/.test(rest) || /^unchanged rev \d+$/.test(rest)) {
    return receipt + "\n\n" + renderDiff(rest, ui, { showTitle: false });
  }
  return receipt;
}

const ACTION_COMMANDS = new Set([
  "open", "click", "fill", "type", "press", "select", "check", "uncheck", "hover", "scroll",
  "scrollintoview", "focus", "highlight", "drag", "upload", "download", "pdf", "screenshot",
  "back", "forward", "reload", "wait", "state", "set", "block", "cookies", "storage",
  "network", "dialog", "profiler", "trace", "keyboard", "keydown", "keyup", "mouse", "find",
]);

export function renderOutput(cmd: string, argv: string[], text: string, ui: Ui, ms?: number): string {
  if (!text.trim()) return text;
  if (text.startsWith("# ")) return text.includes("(diff ") ? renderDiff(text, ui) : renderSnapshot(text, ui);
  if (text.startsWith("(diff ") || /^\+\d+ -\d+, \d+ unchanged/.test(text) || /^no changes$/.test(text) || /^unchanged rev \d+$/.test(text)) {
    return renderDiff(text, ui);
  }
  if (text.startsWith("ok ") && ACTION_COMMANDS.has(cmd)) {
    if (cmd === "find" && argv[3] === "text") return text;
    return renderAction(text, ui, ms);
  }
  return text;
}

const ERROR_HINT: [RegExp, string][] = [
  [/unknown ref|stale ref/i, "The page changed since your last snapshot."],
  [/no previous snapshot/i, "Take a snapshot first, or pass --baseline."],
  [/unknown flag/i, "That flag is not recognized."],
  [/Chrome|Chromium/i, "Chrome was not found."],
  [/not visible|not found|no element|timeout|covered/i, "The target may have moved or the page is still loading."],
  [/no such file/i, "The file path does not exist."],
  [/not a local launch|cdp/i, "This session is not a local Chrome launch."],
];

function nextCommand(cmd: string | undefined, text: string): string {
  if (/unknown command/i.test(text)) return "mb help --all";
  if (/unknown ref|stale ref|no previous snapshot|timeout|not visible|not found|no element|covered/i.test(text)) return "mb snapshot";
  if (/unknown flag|usage:/i.test(text)) return cmd ? `mb ${cmd} --help` : "mb help --all";
  if (/Chrome|Chromium/i.test(text)) return "mb doctor";
  if (/no such file/i.test(text)) return cmd ? `mb ${cmd} --help` : "mb help --all";
  return cmd ? `mb ${cmd} --help` : "mb help --all";
}

export function renderError(cmd: string | undefined, message: string, ui: Ui): string {
  const raw = message.split("\n").filter((l) => l.length > 0);
  let msg = raw[0] ?? "unknown error";
  let hint = raw.slice(1).join(" ").trim();
  // Usage errors arrive as `usage: …` followed by the real reason. Show the reason
  // first and let `mb <cmd> --help` carry the syntax; a wall of usage text is not
  // a useful error message.
  if (msg.startsWith("usage:") && raw[1]) {
    const parts = raw[1].split(" — ");
    msg = parts[0];
    hint = parts.slice(1).join(" — ");
  }
  const dash = msg.indexOf(" — ");
  if (dash >= 0) { hint = hint || msg.slice(dash + 3); msg = msg.slice(0, dash); }
  if (/PowerShell/i.test(hint)) hint = "PowerShell drops a bare @ref; write '@12' or 12.";
  if (!hint) hint = ERROR_HINT.find(([re]) => re.test(msg))?.[1] ?? "Run the command again, or ask for help.";
  hint = replaceGlyphs(hint, ui);
  if (hint && !/[.!?)]$/.test(hint)) hint += ".";
  if (hint) hint = hint.charAt(0).toUpperCase() + hint.slice(1);
  const next = nextCommand(cmd, `${msg} ${hint}`);
  const width = Math.max(40, ui.width);
  const label = ui.unicode ? `${ui.glyphs.fail} error` : "error:";
  const indent = " ".repeat(stringWidth(label) + 2);
  const msgLines = wrap(msg, { width: width - stringWidth(label) - 1, indent: "", hanging: "" });
  const hintLines = wrap(hint, { width: width - stringWidth(indent), indent: "", hanging: "" });
  const nextLines = wrap(`${ui.glyphs.arrow} ${next}`, { width: width - stringWidth(indent), indent: "", hanging: "" });
  const out = [paint(ui, label, "del") + " " + paint(ui, msgLines[0], "text")];
  for (const line of msgLines.slice(1)) out.push(indent + paint(ui, line, "text"));
  for (const line of hintLines) out.push(indent + paint(ui, line, "muted"));
  for (const line of nextLines) out.push(indent + paint(ui, line, "cmd"));
  return out.join("\n");
}

export function renderDoctor(report: DoctorReport, ui: Ui): string {
  const width = Math.min(ui.width, 100);
  const summaryBits = [`${report.summary.pass} passed`, `${report.summary.info} note${report.summary.info === 1 ? "" : "s"}`];
  if (report.summary.fail) summaryBits.push(`${report.summary.fail} failed`);
  const summary = summaryBits.join(` ${ui.glyphs.dot} `);
  const out: string[] = [];
  const title = "monad-browser doctor";
  if (width >= 60 && stringWidth(title) + 2 + stringWidth(summary) <= width) {
    out.push(paint(ui, title, "title") + gap(title, summary, width) + paint(ui, summary, report.summary.fail ? "del" : "dim"));
  } else {
    out.push(paint(ui, title, "title"));
    out.push(paint(ui, summary, report.summary.fail ? "del" : "dim"));
  }
  out.push(paint(ui, ui.glyphs.rule.repeat(width), "border"));
  for (const c of report.checks) {
    const word = c.status === "pass" ? "PASS" : c.status === "info" ? "INFO" : "FAIL";
    const style: StyleName = c.status === "pass" ? "ok" : c.status === "info" ? "muted" : "del";
    if (width >= 70) {
      out.push(paint(ui, word, style) + "  " + paint(ui, padEnd(c.label, 20), "label") + "  " + paint(ui, truncate(c.value, width - 29, ui.glyphs.ellipsis), "text"));
      if (c.detail && width >= 80) out.push("      " + paint(ui, truncate(c.detail, width - 6, ui.glyphs.ellipsis), "dim"));
    } else {
      out.push(paint(ui, word, style) + "  " + paint(ui, c.label, "label"));
      for (const line of wrap(c.value, { width: width - 6, indent: "      ", hanging: "      " })) out.push(paint(ui, line, "text"));
      if (c.detail) for (const line of wrap(c.detail, { width: width - 6, indent: "      ", hanging: "      " })) out.push(paint(ui, line, "dim"));
    }
  }
  out.push("");
  const failed = report.checks.find((c) => c.status === "fail");
  if (failed?.label === "Chrome") out.push(paint(ui, "→ install Chrome or set MONAD_CHROME", "cmd"));
  else if (failed?.label === "Node") out.push(paint(ui, "→ upgrade Node to 22 or newer", "cmd"));
  else out.push(paint(ui, "→ mb start", "cmd") + paint(ui, " to launch a browser", "muted"));
  return out.join("\n");
}

export function renderSessions(text: string, ui: Ui): string {
  if (!text || /^no sessions running$/.test(text)) return paint(ui, "no sessions running", "dim");
  return text.split("\n").map((line) => {
    const m = /^(\S+)\t(.*)$/.exec(line);
    if (!m) return line;
    return paint(ui, m[1], "cmd") + "  " + styleInline(m[2], ui);
  }).join("\n");
}

export function renderPlain(text: string, ui: Ui): string {
  return replaceGlyphs(text, ui);
}
