// Help is layered: a 13-line command map for `mb --help`, the full grouped list
// for `mb help --all`, and a command page with flags/examples for `mb <cmd> --help`.
// Plain output is the same text without SGR; pipes and CI never see ANSI.
import { COMMANDS, EXTRA_USAGE } from "./commands.js";
import { WATCH_HELP } from "./watch-usage.js";
import { paint, type Ui } from "./ui/color.js";
import { padEnd, stringWidth, wrap } from "./ui/width.js";

type Group = { title: string; rows: [string, string][] };
type Seg = { text: string; style?: string };

const GROUPS: Group[] = [
  {
    title: "PAGE",
    rows: [
      ["open", "navigate the current tab"],
      ["snapshot", "accessibility tree with @refs"],
      ["click", "click a ref or selector"],
      ["fill", "clear and type into an input"],
      ["type", "insert text at the focused element"],
      ["press", "press a key"],
      ["select", "choose <select> options"],
      ["check", "check a checkbox or radio"],
      ["uncheck", "uncheck a checkbox"],
      ["hover", "move the pointer over a target"],
      ["scroll", "scroll the page or an element"],
      ["scrollintoview", "scroll a target into view"],
      ["focus", "focus a target"],
      ["drag", "drag a source to a target"],
      ["upload", "set files on a file input"],
      ["download", "click a download link"],
      ["pdf", "print the page to PDF"],
    ],
  },
  {
    title: "INSPECT",
    rows: [
      ["text", "visible text of the page or element"],
      ["read", "markdown/text without Chrome"],
      ["get", "one value: text, html, value, attr, box"],
      ["is", "visible, enabled or checked"],
      ["find", "semantic locator + action"],
      ["eval", "evaluate JS in the page"],
      ["run", "one-turn multi-step plan"],
      ["console", "recent page errors and warnings"],
      ["network", "requests, routes and HAR"],
      ["cookies", "read, set or clear cookies"],
      ["storage", "localStorage / sessionStorage"],
      ["dialog", "status, accept or dismiss dialogs"],
      ["cdp", "raw CDP on the current tab"],
      ["diff", "snapshot vs baseline, or two URLs"],
      ["tabs", "list tabs"],
      ["tab", "switch, open or close a tab"],
      ["url", "current title and URL"],
    ],
  },
  {
    title: "EMULATE",
    rows: [
      ["set", "viewport, device, media, offline, headers, geo"],
      ["block", "block resource types for new tabs"],
      ["screenshot", "PNG/JPEG of the viewport, page or element"],
      ["state", "save/load cookies + storage"],
    ],
  },
  {
    title: "WATCH",
    rows: [
      ["watch add", "create a page / RSS / release watcher"],
      ["watch list", "watchers, next check and last error"],
      ["watch check", "check now; print only fired watchers"],
      ["watch remove", "delete a watcher and its logs"],
      ["watch logs", "recent fired/error/baseline events"],
      ["watch run", "foreground loop for CI/systemd"],
    ],
  },
  {
    title: "DEBUG",
    rows: [
      ["profiler", "CPU profile"],
      ["trace", "DevTools trace"],
      ["keyboard", "type or insert text"],
      ["keydown", "raw key down"],
      ["keyup", "raw key up"],
      ["mouse", "move, down, up, wheel"],
    ],
  },
  {
    title: "DAEMON",
    rows: [
      ["start", "start the daemon explicitly"],
      ["stop", "stop the current session (or all)"],
      ["status", "show the current session status"],
      ["sessions", "list running sessions"],
      ["doctor", "diagnose Chrome, state and config"],
      ["mcp", "run as an MCP server over stdio"],
      ["skills", "version-matched agent skills"],
      ["install-skill", "write SKILL.md for coding agents"],
    ],
  },
];

const SUMMARY: Record<string, string> = Object.fromEntries(GROUPS.flatMap((g) => g.rows));

const ALIASES: Record<string, string> = {
  goto: "open", navigate: "open", snap: "snapshot", js: "eval", scrollinto: "scrollintoview", key: "press",
};
const CANONICAL = new Set([...Object.keys(COMMANDS), ...Object.keys(EXTRA_USAGE), "help", "version"]);
for (const a of Object.keys(ALIASES)) CANONICAL.delete(a);

const EXAMPLES: Record<string, string[]> = {
  open: ["mb open example.com", "mb open example.com -s"],
  snapshot: ["mb snapshot -i", "mb snapshot -d"],
  click: ["mb click @7", "mb click @7 -s", "mb click 'text=Sign in'"],
  fill: ["mb fill @3 'Ada Lovelace'", "mb fill @3 'Ada' --submit"],
  type: ["mb type 'hello'", "mb type 'hello' --into @3"],
  press: ["mb press Enter", "mb press Control+a"],
  select: ["mb select @4 'Pro'"],
  check: ["mb check @5"],
  uncheck: ["mb uncheck @5"],
  hover: ["mb hover @7"],
  scroll: ["mb scroll down 600", "mb scroll down 300 --on @4"],
  scrollintoview: ["mb scrollintoview @12"],
  focus: ["mb focus @3"],
  drag: ["mb drag @1 @2"],
  upload: ["mb upload @3 ./file.pdf"],
  download: ["mb download @4 ./downloads"],
  pdf: ["mb pdf page.pdf", "mb pdf page.pdf --landscape"],
  text: ["mb text", "mb text @7 --max 2000"],
  read: ["mb read https://example.com", "mb read --outline"],
  get: ["mb get value @3", "mb get attr @3 href"],
  is: ["mb is visible @3"],
  find: ["mb find role button click --name Submit", "mb find label Email fill 'a@b.com'"],
  eval: ["mb eval 'return document.title'"],
  run: ["mb run 'await goto(\"example.com\"); return await title()'"],
  console: ["mb console"],
  network: ["mb network requests --filter api", "mb network route '**/api' --abort"],
  cookies: ["mb cookies", "mb cookies set session abc --url https://example.com"],
  storage: ["mb storage local", "mb storage local set theme dark"],
  dialog: ["mb dialog status", "mb dialog accept"],
  cdp: ["mb cdp Runtime.evaluate '{\"expression\":\"1+1\"}'"],
  diff: ["mb diff snapshot", "mb diff url https://a.example https://b.example"],
  tabs: ["mb tabs"],
  tab: ["mb tab new https://example.com", "mb tab close 0"],
  url: ["mb url"],
  set: ["mb set viewport 390 844", "mb set media dark"],
  block: ["mb block image,font", "mb block none"],
  screenshot: ["mb screenshot page.png", "mb screenshot page.png --full --annotate"],
  state: ["mb state save auth.json", "mb state load auth.json"],
  "watch add": ["mb watch add https://example.com/status --extract 'css:#status' --condition 'contains \"down\"' --every 5m"],
  "watch list": ["mb watch list", "mb watch list --json"],
  "watch check": ["mb watch check all"],
  "watch remove": ["mb watch remove status"],
  "watch logs": ["mb watch logs", "mb watch logs status"],
  "watch run": ["mb watch run"],
  profiler: ["mb profiler start", "mb profiler stop profile.json"],
  trace: ["mb trace start", "mb trace stop trace.json"],
  keyboard: ["mb keyboard type 'hello'", "mb keyboard inserttext 'hello'"],
  keydown: ["mb keydown Shift"],
  keyup: ["mb keyup Shift"],
  mouse: ["mb mouse move 100 200", "mb mouse wheel 300"],
  start: ["mb start", "mb start --headful"],
  stop: ["mb stop", "mb stop --all"],
  status: ["mb status"],
  sessions: ["mb sessions"],
  doctor: ["mb doctor", "mb doctor --fix"],
  mcp: ["mb mcp"],
  skills: ["mb skills list", "mb skills get core"],
  "install-skill": ["mb install-skill --project"],
  watch: ["mb watch add https://example.com/status --every 5m", "mb watch list"],
};

const FLAG_DESC: Record<string, string> = {
  "interactive": "interactive elements only",
  "full": "full snapshot / reset the diff baseline",
  "snapshot": "print a snapshot or diff after the action",
  "diff": "only what changed",
  "baseline": "compare with a saved snapshot file",
  "timeout": "timeout in milliseconds",
  "file": "read the script from a file",
  "props": "comma-separated CSS properties",
  "max": "maximum characters to return",
  "name": "accessible name filter",
  "exact": "exact text match",
  "button": "mouse button (left, right, middle)",
  "count": "click count",
  "new-tab": "open the target in a new tab",
  "submit": "press Enter after filling",
  "into": "target ref for type",
  "max-lines": "maximum snapshot lines",
  "max-text": "maximum text length per node",
  "cache": "reuse the last snapshot while unchanged",
  "cache-ms": "snapshot cache TTL in milliseconds",
  "json": "machine-readable output",
  "on": "target element",
  "jpeg": "JPEG instead of PNG",
  "format": "image format",
  "quality": "JPEG quality",
  "annotate": "draw refs on the screenshot",
  "if-changed": "only write when the image changed",
  "dir": "output directory",
  "landscape": "landscape PDF",
  "no-print-background": "omit the page background",
  "raw": "raw HTML",
  "require-md": "fail unless markdown is available",
  "outline": "headings only",
  "filter": "keep matching sections or requests",
  "llms": "read an llms.txt index or full text",
  "url": "URL filter or cookie URL",
  "domain": "cookie domain",
  "path": "cookie path",
  "httpOnly": "mark the cookie HttpOnly",
  "secure": "mark the cookie Secure",
  "sameSite": "cookie SameSite policy",
  "expires": "cookie expiry (Unix seconds)",
  "clear": "clear after reading",
  "abort": "abort matching requests",
  "body": "response body",
  "status": "response status",
  "content-type": "response content type",
  "resource-type": "resource types to match",
  "scale": "device scale factor",
  "mobile": "mobile viewport",
  "reduced-motion": "prefer reduced motion",
  "no-reduced-motion": "disable reduced motion",
  "headers": "request headers as JSON",
  "geo": "geolocation latitude/longitude",
  "accuracy": "geolocation accuracy",
  "fix": "remove stale state files",
  "all": "all sessions or all watchers",
  "project": "install into the project",
  "print": "print instead of writing",
  "session": "session name",
  "profile": "Chrome profile directory",
  "cdp": "attach to an existing Chrome",
  "headful": "show the browser window",
  "block": "block resource types",
  "chrome": "Chrome executable",
  "idle": "idle timeout in minutes",
  "proxy": "proxy URL",
  "user-agent": "User-Agent override",
  "ignore-https-errors": "ignore TLS errors",
  "init-script": "run a script on every page",
  "download-path": "download directory",
  "color-scheme": "preferred color scheme",
  "viewport": "viewport WxH",
  "extension": "load an extension",
  "args": "extra Chrome args",
  "no-auto-dialog": "do not auto-accept dialogs",
  "watch-only": "start without Chrome",
  "render": "render with Chrome",
  "notify": "POST to the notify URL on fire",
  "exec": "run a command on fire",
  "kind": "page, rss or release",
  "extract": "text, css:<selector>, json:<path>",
  "condition": "condition expression",
  "every": "check interval",
  "help": "show this help",
};

const SHORT_TO_LONG: Record<string, string> = { i: "interactive", d: "diff", s: "snapshot", f: "full", b: "baseline" };
const LONG_TO_SHORT: Record<string, string> = Object.fromEntries(Object.entries(SHORT_TO_LONG).map(([k, v]) => [v, k]));
const TARGET_COMMANDS = new Set([
  "click", "fill", "hover", "check", "uncheck", "focus", "scrollintoview", "highlight",
  "upload", "download", "drag", "get", "is", "find", "type", "screenshot", "scroll",
]);
const POWER_SHELL_NOTE = "PowerShell: a bare @12 is splatting. Write '@12' or the plain number 12.";

const plain = (segs: Seg[]) => segs.map((s) => s.text).join("");
const asciiUiText = (s: string) => s
  .replaceAll("…", "...")
  .replaceAll("→", "->")
  .replaceAll("—", "-")
  .replaceAll("·", "-");
const seg = (text: string, style?: string): Seg => ({ text, style });
const render = (ui: Ui | undefined, segs: Seg[]) =>
  segs.map((s) => (s.style && ui ? paint(ui, s.text, s.style as any) : s.text)).join("");
const gap = (left: string, right: string, width: number) =>
  " ".repeat(Math.max(1, width - stringWidth(left) - stringWidth(right)));

function canonical(name: string): string {
  return ALIASES[name] ?? name;
}

export function commandNames(): string[] {
  return [...CANONICAL].sort();
}

export function usageLine(name: string): string | undefined {
  const n = canonical(name);
  if (n === "watch") return WATCH_HELP;
  const usage = COMMANDS[n]?.usage ?? EXTRA_USAGE[n];
  return usage ? `usage: mb ${usage}` : undefined;
}

type FlagRow = { label: string; desc: string };
function flagsFor(name: string): FlagRow[] {
  const usage = usageLine(name);
  if (!usage) return [];
  const first = usage.split("\n")[0];
  const syntax = first.split(/\s{3,}/)[0];
  const rows: FlagRow[] = [];
  const seen = new Set<string>();
  for (const m of syntax.matchAll(/(--[a-z][\w-]*|-[a-zA-Z])(?:\s+([^\s\]]+))?/g)) {
    const flag = m[1];
    let value: string | undefined = m[2];
    if (value && (value.startsWith("[") || value.startsWith("-") || value === "|")) value = undefined;
    const key = flag.startsWith("--") ? flag.slice(2) : (SHORT_TO_LONG[flag.slice(1)] ?? flag);
    if (seen.has(key)) continue;
    seen.add(key);
    const short = LONG_TO_SHORT[key];
    const names = [short ? `-${short}` : undefined, `--${key}`].filter(Boolean).join(", ");
    const label = value ? `${names} ${value}` : names;
    const desc = FLAG_DESC[key] ?? FLAG_DESC[flag] ?? "see the usage line above";
    rows.push({ label, desc });
  }
  return rows;
}

function topHelpWide(ui?: Ui): string {
  const width = Math.max(76, ui?.width ?? 80);
  const dot = ui?.glyphs.dot ?? "·";
  const arrow = ui?.glyphs.arrow ?? "→";
  const headerLeft = [seg("mb", "brand"), seg(` ${dot} headless browser for agents`, "muted")];
  const headerRight = [seg("usage: mb [--session NAME] <command> [args]", "dim")];
  const lines: Seg[][] = [
    [...headerLeft, seg(gap(plain(headerLeft), plain(headerRight), width)), ...headerRight],
    [],
    [seg("TRY", "section"), seg(`       mb open example.com  ${dot}  mb snapshot -i  ${dot}  mb click @7 -s`, "cmd")],
    [seg("PAGE", "section"), seg("      open snapshot click fill type press select check uncheck", "text")],
    [seg("          hover scroll scrollintoview focus drag upload download pdf", "text")],
    [seg("INSPECT", "section"), seg("   text read get is find eval run console network cookies", "text")],
    [seg("          storage dialog cdp diff tabs tab url", "text")],
    [seg("EMULATE", "section"), seg("   set block screenshot state", "text")],
    [seg("WATCH", "section"), seg("     watch add list check remove logs run", "text")],
    [seg("DEBUG", "section"), seg("     profiler trace keyboard keydown keyup mouse", "text")],
    [seg("DAEMON", "section"), seg("    start stop status sessions doctor mcp skills install-skill", "text")],
    [],
    [seg(`          mb <command> --help for flags ${dot} mb help --all for details`, "dim")],
  ];
  return lines.map((l) => render(ui, l)).join("\n");
}

function topHelpNarrow(ui?: Ui): string {
  const width = ui?.width ?? 60;
  const dot = ui?.glyphs.dot ?? "·";
  const out: string[] = [
    `${ui ? paint(ui, "mb", "brand") : "mb"} ${dot} headless browser for agents`,
    `${ui ? paint(ui, "usage:", "accent") : "usage:"} mb [--session NAME] <command> [args]`,
    "",
    `${ui ? paint(ui, "TRY", "section") : "TRY"}`,
    "  mb open example.com",
    "  mb snapshot -i",
    "  mb click @7 -s",
    "",
  ];
  for (const g of GROUPS) {
    if (g.title === "WATCH") {
      out.push(`${ui ? paint(ui, "WATCH", "section") : "WATCH"}`);
      out.push("  watch add list check remove logs run");
      out.push("");
      continue;
    }
    out.push(`${ui ? paint(ui, g.title, "section") : g.title}`);
    const names = g.rows.map((r) => r[0]).join(" ");
    for (const line of wrap(names, { width, indent: "  ", hanging: "  " })) out.push(line);
    out.push("");
  }
  out.push(`${ui ? paint(ui, `mb <command> --help for flags ${dot} mb help --all for details`, "dim") : `mb <command> --help for flags ${dot} mb help --all for details`}`);
  return out.join("\n");
}

export function topHelp(ui?: Ui): string {
  const text = (ui?.width ?? 80) < 64 ? topHelpNarrow(ui) : topHelpWide(ui);
  return ui?.unicode ? text : asciiUiText(text);
}

export function allHelp(ui?: Ui): string {
  const width = Math.max(40, ui?.width ?? 80);
  const out: string[] = [];
  out.push(`${ui ? paint(ui, "mb", "brand") : "mb"} · all commands`);
  out.push(`${ui ? paint(ui, "usage:", "accent") : "usage:"} mb [--session NAME] <command> [args]`);
  for (const g of GROUPS) {
    out.push("");
    out.push(ui ? paint(ui, g.title, "section") : g.title);
    for (const [name, desc] of g.rows) {
      if (width >= 64) {
        out.push(`  ${ui ? paint(ui, padEnd(name, 22), "cmd") : padEnd(name, 22)}  ${ui ? paint(ui, desc, "muted") : desc}`);
      } else {
        out.push(`  ${ui ? paint(ui, name, "cmd") : name}`);
        for (const line of wrap(desc, { width: width - 4, indent: "    ", hanging: "    " })) out.push(line);
      }
    }
  }
  out.push("");
  const dot = ui?.glyphs.dot ?? "·";
  const arrow = ui?.glyphs.arrow ?? "→";
  const aliases = `aliases: goto, navigate ${arrow} open ${dot} snap ${arrow} snapshot ${dot} js ${arrow} eval ${dot} scrollinto ${arrow} scrollintoview ${dot} key ${arrow} press`;
  for (const line of wrap(aliases, { width, indent: "", hanging: "" })) out.push(ui ? paint(ui, line, "dim") : line);
  for (const line of wrap(POWER_SHELL_NOTE, { width, indent: "", hanging: "" })) out.push(ui ? paint(ui, line, "dim") : line);
  const text = out.join("\n");
  return ui?.unicode ? text : asciiUiText(text);
}

function colorWatchHelp(text: string, ui?: Ui, width = 80): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (stringWidth(line) <= width) { lines.push(line); continue; }
    const lead = line.match(/^\s*/)?.[0] ?? "";
    const table = /^(\s{2,}\S.*?)(\s{3,})(\S.*)$/.exec(line);
    if (table && stringWidth(table[1]) < width - 12) {
      const prefix = table[1] + table[2];
      const room = Math.max(12, width - stringWidth(prefix));
      const desc = wrap(table[3], { width: room, indent: "", hanging: "" });
      lines.push(prefix + desc[0]);
      for (const d of desc.slice(1)) lines.push(" ".repeat(stringWidth(prefix)) + d);
    } else {
      lines.push(...wrap(line, { width, indent: lead, hanging: lead + "  " }));
    }
  }
  if (!ui) return lines.join("\n");
  return lines.map((line) => {
    if (line.startsWith("usage:")) return paint(ui, "usage:", "accent") + line.slice(6);
    if (/^(commands|conditions|state):/.test(line)) return paint(ui, line, "section");
    const m = /^  ([a-z][\w -]*?)(\s{2,})(.*)$/.exec(line);
    if (m) return `  ${paint(ui, m[1], "cmd")}${m[2]}${paint(ui, m[3], "muted")}`;
    return line;
  }).join("\n");
}

export function commandHelp(name: string, ui?: Ui): string | undefined {
  const n = canonical(name);
  if (n === "watch") {
    const text = colorWatchHelp(WATCH_HELP, ui, Math.max(40, ui?.width ?? 80));
    return ui?.unicode ? text : asciiUiText(text);
  }
  if (n === "help") return topHelp(ui);
  if (n === "version") return "usage: mb --version";
  const usage = usageLine(n);
  if (!usage) return undefined;
  const width = Math.max(40, ui?.width ?? 80);
  const out: string[] = [];
  const [firstUsage, ...usageRest] = usage.split("\n");
  const split = firstUsage.split(/\s{3,}/);
  const syntax = split[0];
  const inlineDesc = split.slice(1).join(" ").trim();
  const usageLines = wrap(syntax, { width, indent: "", hanging: "  " });
  out.push((ui ? paint(ui, "usage:", "accent") : "usage:") + usageLines[0].slice(6));
  for (const line of usageLines.slice(1)) out.push(ui ? paint(ui, line, "muted") : line);
  for (const line of usageRest) {
    for (const wrapped of wrap(line, { width, indent: line.match(/^\s*/)?.[0] ?? "", hanging: (line.match(/^\s*/)?.[0] ?? "") + "  " })) {
      out.push(ui ? paint(ui, wrapped, "muted") : wrapped);
    }
  }
  out.push("");
  const summary = inlineDesc || SUMMARY[n] || "monad-browser command";
  for (const line of wrap(summary, { width, indent: "", hanging: "" })) out.push(line);
  if (ALIASES[name]) out.push(`${ui ? paint(ui, "alias:", "accent") : "alias:"} ${name} ${ui?.glyphs.arrow ?? "→"} ${n}`);

  const flags = n === "run" ? [] : flagsFor(n);
  out.push("");
  out.push(ui ? paint(ui, "FLAGS", "section") : "FLAGS");
  if (!flags.length) out.push("  none");
  else {
    for (const f of flags) {
      const left = `  ${f.label}`;
      if (width >= 72 && stringWidth(left) + 2 + stringWidth(f.desc) <= width) {
        out.push(`${ui ? paint(ui, left, "cmd") : left}${" ".repeat(Math.max(2, 26 - stringWidth(left)))}${ui ? paint(ui, f.desc, "muted") : f.desc}`);
      } else {
        out.push(ui ? paint(ui, left, "cmd") : left);
        for (const line of wrap(f.desc, { width: width - 4, indent: "    ", hanging: "    " })) out.push(line);
      }
    }
  }

  const examples = EXAMPLES[n] ?? [];
  out.push("");
  out.push(ui ? paint(ui, "EXAMPLES", "section") : "EXAMPLES");
  if (!examples.length) out.push(`  mb ${n}`);
  else for (const ex of examples) out.push(`  ${ui ? paint(ui, ex, "cmd") : ex}`);

  if (TARGET_COMMANDS.has(n)) {
    out.push("");
    out.push(ui ? paint(ui, "NOTE", "section") : "NOTE");
    for (const line of wrap("  " + POWER_SHELL_NOTE, { width, indent: "  ", hanging: "  " })) out.push(line);
  }
  const text = out.join("\n");
  return ui?.unicode ? text : asciiUiText(text);
}
