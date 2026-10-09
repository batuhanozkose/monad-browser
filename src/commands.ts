// Command table shared by the daemon (and later MCP). Each command returns compact text.
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import type { Browser } from "./browser.js";
import { runScript, RUN_HELP } from "./run.js";

export type Ctx = { browser: Browser; cwd: string };
type Flags = Record<string, string | boolean>;
type Cmd = { usage: string; run: (ctx: Ctx, args: string[], flags: Flags) => Promise<string> };

export function parseArgs(argv: string[]): { args: string[]; flags: Flags } {
  const args: string[] = [], flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { args.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (BOOL_FLAGS.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith("-")) flags[k] = true;
      else flags[k] = argv[++i];
    } else if (/^-[a-zA-Z]$/.test(a)) flags[SHORT[a[1]] ?? a[1]] = true;
    else args.push(a);
  }
  return { args, flags };
}
const BOOL_FLAGS = new Set(["full", "interactive", "json", "no-snapshot", "snapshot", "headful", "diff"]);
const SHORT: Record<string, string> = { i: "interactive", f: "full", s: "snapshot", d: "diff" };

const need = (args: string[], n: number, usage: string) => { if (args.length < n) throw new Error(`usage: ${usage}`); };
const num = (v: unknown, d: number) => (v === undefined || v === true ? d : Number(v));

async function maybeSnap(ctx: Ctx, flags: Flags, msg: string) {
  if (!flags.snapshot) return msg;
  return `${msg}\n${await ctx.browser.snapshot({ interactive: !!flags.interactive, diff: !flags.full })}`;
}

export const COMMANDS: Record<string, Cmd> = {
  run: {
    usage: RUN_HELP,
    async run(ctx, args, flags) {
      const code = typeof flags.f === "string" ? readFileSync(resolvePath(ctx.cwd, flags.f), "utf8")
        : typeof flags.file === "string" ? readFileSync(resolvePath(ctx.cwd, flags.file), "utf8") : args.join(" ");
      if (!code.trim()) throw new Error(`usage: ${this.usage}`);
      return runScript(ctx.browser, code, ctx.cwd, num(flags.timeout, 120_000));
    },
  },
  open: {
    usage: "open <url> [-s] [-i]   navigate the current tab (alias: goto)",
    async run(ctx, args, flags) {
      need(args, 1, this.usage);
      const { url, title } = await ctx.browser.goto(args[0]);
      return maybeSnap(ctx, flags, `ok ${title ? `"${title}" ` : ""}${url}`);
    },
  },
  snapshot: {
    usage: "snapshot [-i] [-d] [--max-lines N] [--max-text N]   accessibility snapshot with @refs (-i: interactive only, -d: only what changed)",
    async run(ctx, _a, flags) {
      return ctx.browser.snapshot({ interactive: !!flags.interactive, diff: !!flags.diff, maxLines: num(flags["max-lines"], 400), maxText: num(flags["max-text"], 80) });
    },
  },
  click: {
    usage: "click <@ref|selector> [--button right] [--count 2] [-s]",
    async run(ctx, args, flags) {
      need(args, 1, this.usage);
      await ctx.browser.click(args[0], { button: (flags.button as any) || "left", count: num(flags.count, 1) });
      const { url } = await ctx.browser.info();
      return maybeSnap(ctx, flags, `ok clicked ${args[0]} — ${url}`);
    },
  },
  fill: {
    usage: "fill <@ref|selector> <text> [-s]   clear and type into an input",
    async run(ctx, args, flags) {
      need(args, 2, this.usage);
      await ctx.browser.fill(args[0], args.slice(1).join(" "));
      return maybeSnap(ctx, flags, `ok filled ${args[0]}`);
    },
  },
  type: {
    usage: "type <text> [--into @ref]   insert text at the focused element",
    async run(ctx, args, flags) {
      need(args, 1, this.usage);
      await ctx.browser.type(args.join(" "), typeof flags.into === "string" ? flags.into : undefined);
      return "ok typed";
    },
  },
  press: {
    usage: "press <key>   e.g. Enter, Tab, Escape, Control+a, Shift+Tab",
    async run(ctx, args, flags) {
      need(args, 1, this.usage);
      await ctx.browser.press(args[0]);
      const { url } = await ctx.browser.info();
      return maybeSnap(ctx, flags, `ok pressed ${args[0]} — ${url}`);
    },
  },
  select: {
    usage: "select <@ref|selector> <value...>   choose <select> option(s) by value or label",
    async run(ctx, args) {
      need(args, 2, this.usage);
      const picked = await ctx.browser.select(args[0], args.slice(1));
      return `ok selected ${picked.join(", ")}`;
    },
  },
  hover: { usage: "hover <@ref|selector>", async run(ctx, args) { need(args, 1, this.usage); await ctx.browser.hover(args[0]); return "ok"; } },
  scroll: {
    usage: "scroll [down|up|left|right] [px] [--on @ref]",
    async run(ctx, args, flags) {
      await ctx.browser.scroll(args[0] ?? "down", num(args[1], 600), typeof flags.on === "string" ? flags.on : undefined);
      const pos = await ctx.browser.evaluate("({y: Math.round(scrollY), h: document.documentElement.scrollHeight, vh: innerHeight})");
      return `ok scrollY=${pos.y}/${Math.max(0, pos.h - pos.vh)}`;
    },
  },
  eval: {
    usage: "eval <js>   evaluate in the page (top-level await/return allowed); prints JSON",
    async run(ctx, args) {
      need(args, 1, this.usage);
      const v = await ctx.browser.evaluate(args.join(" "));
      return v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v);
    },
  },
  text: {
    usage: "text [@ref|selector] [--max N]   visible text of the page or an element",
    async run(ctx, args, flags) { return ctx.browser.text(args[0], num(flags.max, 4000)); },
  },
  screenshot: {
    usage: "screenshot [path] [--full] [--on @ref] [--jpeg]",
    async run(ctx, args, flags) {
      const jpeg = !!flags.jpeg;
      const buf = await ctx.browser.screenshot({ fullPage: !!flags.full, target: typeof flags.on === "string" ? flags.on : undefined, format: jpeg ? "jpeg" : "png" });
      const out = resolvePath(ctx.cwd, args[0] ?? `screenshot-${Date.now()}.${jpeg ? "jpg" : "png"}`);
      writeFileSync(out, buf);
      return `ok ${out} (${Math.round(buf.length / 1024)} KB)`;
    },
  },
  back: { usage: "back", async run(ctx) { await ctx.browser.back(); return `ok ${(await ctx.browser.info()).url}`; } },
  forward: { usage: "forward", async run(ctx) { await ctx.browser.forward(); return `ok ${(await ctx.browser.info()).url}`; } },
  reload: { usage: "reload", async run(ctx) { await ctx.browser.reload(); return `ok ${(await ctx.browser.info()).url}`; } },
  wait: {
    usage: "wait <ms|selector|--idle|--text T>   wait for time, an element, network idle, or text",
    async run(ctx, args, flags) {
      const b = ctx.browser;
      const timeout = num(flags.timeout, 10_000);
      if (flags.idle) return (await b.networkIdle(500, timeout)) ? "ok idle" : "timeout (still loading)";
      if (typeof flags.text === "string") {
        const ok = await b.evaluate(`new Promise(r => { const t = ${JSON.stringify(flags.text)}; const end = Date.now() + ${timeout}; (function f(){ if (document.body && document.body.innerText.includes(t)) return r(true); if (Date.now() > end) return r(false); setTimeout(f, 100); })(); })`);
        return ok ? "ok" : `timeout: text not found`;
      }
      need(args, 1, this.usage);
      if (/^\d+$/.test(args[0])) { await new Promise((r) => setTimeout(r, Number(args[0]))); return "ok"; }
      const ok = await b.evaluate(`new Promise(r => { const s = ${JSON.stringify(args[0])}; const end = Date.now() + ${timeout}; (function f(){ const e = document.querySelector(s); if (e && e.getClientRects().length) return r(true); if (Date.now() > end) return r(false); setTimeout(f, 100); })(); })`);
      return ok ? "ok" : `timeout: ${args[0]} not visible`;
    },
  },
  state: {
    usage: "state save <file> | state load <file>   cookies + storage (log in once, reuse everywhere)",
    async run(ctx, args) {
      need(args, 2, this.usage);
      const file = resolvePath(ctx.cwd, args[1]);
      if (args[0] === "save") {
        const st = await ctx.browser.saveState();
        writeFileSync(file, JSON.stringify(st, null, 1), { mode: 0o600 });
        return `ok saved ${st.cookies.length} cookies, ${st.origins.length} origin storage → ${file}`;
      }
      if (args[0] === "load") {
        const r = await ctx.browser.loadState(JSON.parse(readFileSync(file, "utf8")));
        return `ok loaded ${r.cookies} cookies, storage for ${r.origins} origin(s)${r.applied ? " (applied to current page)" : " (applied when the origin is opened)"}`;
      }
      throw new Error(`usage: ${this.usage}`);
    },
  },
  tabs: { usage: "tabs   list tabs", async run(ctx) { return ctx.browser.listTabs(); } },
  tab: {
    usage: "tab <index> | tab new [url] | tab close [index]",
    async run(ctx, args) {
      need(args, 1, this.usage);
      if (args[0] === "new") { await ctx.browser.newTab(args[1]); return ctx.browser.listTabs(); }
      if (args[0] === "close") { await ctx.browser.closeTab(args[1] === undefined ? undefined : Number(args[1])); return ctx.browser.listTabs(); }
      await ctx.browser.switchTab(Number(args[0]));
      return ctx.browser.listTabs();
    },
  },
  console: { usage: "console   recent page errors/warnings", async run(ctx) { return ctx.browser.console.splice(0).join("\n") || "(empty)"; } },
  block: {
    usage: "block <image,font,media,stylesheet|none>   block resource types (applies to new tabs)",
    async run(ctx, args) { ctx.browser.setBlock(!args[0] || args[0] === "none" ? [] : args[0].split(",")); return "ok"; },
  },
  url: { usage: "url", async run(ctx) { const i = await ctx.browser.info(); return `${i.title} — ${i.url}`; } },
  cdp: {
    usage: "cdp <Domain.method> [json-params]   raw CDP on the current tab",
    async run(ctx, args) { need(args, 1, this.usage); return JSON.stringify(await ctx.browser.send(args[0], args[1] ? JSON.parse(args.slice(1).join(" ")) : {})); },
  },
};
COMMANDS.goto = COMMANDS.open;
COMMANDS.navigate = COMMANDS.open;
COMMANDS.snap = COMMANDS.snapshot;
COMMANDS.js = COMMANDS.eval;

export function helpText() {
  const seen = new Set<Cmd>();
  const lines = ["monad-browser — headless browser for agents", "", "usage: mb [--session NAME] <command> [args]", "", "commands:"];
  for (const c of Object.values(COMMANDS)) { if (seen.has(c)) continue; seen.add(c); lines.push(`  ${c.usage}`); }
  lines.push("  start [--cdp URL|PORT] [--headful] [--profile DIR] [--block image,font]   start daemon explicitly", "  stop [--all] | status | sessions   (each --session NAME is its own browser; --profile DIR persists it)");
  lines.push("", "refs: snapshot assigns @N to interactive elements; refs stay stable while the element lives.");
  return lines.join("\n");
}

export async function dispatch(ctx: Ctx, argv: string[]): Promise<string> {
  const [name, ...rest] = argv;
  const cmd = COMMANDS[name];
  if (!cmd) throw new Error(`unknown command: ${name}\n\n${helpText()}`);
  const { args, flags } = parseArgs(rest);
  return cmd.run(ctx, args, flags);
}
