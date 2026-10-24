// Command table shared by the daemon (and later MCP). Each command returns compact text.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Browser } from "./browser.js";
import { matchGlob, renderDiff } from "./diff.js";
import { filterSections, htmlToText, outlineMarkdown } from "./read.js";
import { DEFAULT_MAX_LINES } from "./snapshot.js";
import { runScript, RUN_HELP } from "./run.js";

export type Ctx = { browser: Browser; cwd: string; signal?: AbortSignal };
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
const BOOL_FLAGS = new Set([
  "full", "interactive", "json", "no-snapshot", "snapshot", "headful", "diff", "submit", "cache",
  "annotate", "if-changed", "raw", "require-md", "outline", "abort", "landscape", "print-background",
  "mobile", "exact", "reduced-motion", "no-reduced-motion", "http-only", "secure", "clear", "new-tab",
  "fix", "help", "all", "save", "load",
]);
const SHORT: Record<string, string> = { i: "interactive", f: "full", s: "snapshot", d: "diff", b: "baseline" };

const need = (args: string[], n: number, usage: string) => { if (args.length < n) throw new Error(`usage: ${usage}`); };
const num = (v: unknown, d: number) => (v === undefined || v === true ? d : Number(v));
const jsonOut = (v: unknown) => JSON.stringify(v);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function maybeSnap(ctx: Ctx, flags: Flags, msg: string) {
  if (!flags.snapshot) return msg;
  return `${msg}\n${await ctx.browser.snapshot({ interactive: !!flags.interactive, diff: !flags.full, full: !!flags.full, json: !!flags.json })}`;
}

function cookieLine(c: any): string {
  const bits = [`${c.name}=${c.value}`, `domain=${c.domain}`, `path=${c.path}`];
  if (c.expires && c.expires > 0) bits.push(`expires=${new Date(c.expires * 1000).toISOString()}`);
  if (c.httpOnly) bits.push("httpOnly");
  if (c.secure) bits.push("secure");
  if (c.sameSite) bits.push(`sameSite=${c.sameSite}`);
  return bits.join(" ");
}

function requestLine(r: any): string {
  const status = r.failed ? `ERR(${r.failed})` : r.status ?? "…";
  const size = typeof r.size === "number" ? `${r.size}B` : "-";
  return `${String(r.method).padEnd(6)} ${String(status).padEnd(4)} ${String(r.type).padEnd(10)} ${size.padStart(7)} ${r.url}`;
}

export const COMMANDS: Record<string, Cmd> = {
  run: {
    usage: RUN_HELP,
    async run(ctx, args, flags) {
      const code = typeof flags.f === "string" ? readFileSync(resolvePath(ctx.cwd, flags.f), "utf8")
        : typeof flags.file === "string" ? readFileSync(resolvePath(ctx.cwd, flags.file), "utf8") : args.join(" ");
      if (!code.trim()) throw new Error(`usage: ${this.usage}`);
      return runScript(ctx.browser, code, ctx.cwd, num(flags.timeout, 120_000), ctx.signal);
    },
  },
  open: {
    usage: "open <url> [-s] [-i]   navigate the current tab (aliases: goto, navigate)",
    async run(ctx, args, flags) {
      need(args, 1, this.usage);
      const { url, title } = await ctx.browser.goto(args[0]);
      return maybeSnap(ctx, flags, `ok ${title ? `"${title}" ` : ""}${url}`);
    },
  },
  snapshot: {
    usage: "snapshot [-i] [-d] [--full] [--json] [--max-lines N] [--max-text N] [--cache] [--cache-ms N]   accessibility snapshot with @refs (-i: interactive only, -d: only what changed, --full: reset the diff baseline, --json: compact patch)",
    async run(ctx, _a, flags) {
      return ctx.browser.snapshot({
        interactive: !!flags.interactive, diff: !!flags.diff, full: !!flags.full, json: !!flags.json,
        maxLines: num(flags["max-lines"], DEFAULT_MAX_LINES), maxText: num(flags["max-text"], 80),
        cacheMs: flags.cache || flags["cache-ms"] !== undefined ? num(flags["cache-ms"], 500) : undefined,
      });
    },
  },
  click: {
    usage: "click <@ref|selector> [--button right] [--count 2] [--new-tab] [-s]",
    async run(ctx, args, flags) {
      need(args, 1, this.usage);
      await ctx.browser.click(args[0], { button: (flags.button as any) || "left", count: num(flags.count, 1), newTab: !!flags["new-tab"] });
      const { url } = await ctx.browser.info();
      return maybeSnap(ctx, flags, `ok clicked ${args[0]} — ${url}`);
    },
  },
  fill: {
    usage: "fill <@ref|selector> <text> [--submit] [-s]   clear and type into an input (--submit presses Enter)",
    async run(ctx, args, flags) {
      need(args, 2, this.usage);
      await ctx.browser.fill(args[0], args.slice(1).join(" "));
      if (flags.submit) await ctx.browser.submit(args[0]);
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
    usage: "press <key> [-s]   e.g. Enter, Tab, Escape, Control+a, Shift+Tab",
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
    usage: "screenshot [path] [--full] [--on @ref] [--jpeg] [--format png|jpeg] [--quality N] [--annotate] [--if-changed] [--dir D]",
    async run(ctx, args, flags) {
      if (flags.annotate && flags["if-changed"]) throw new Error("--annotate and --if-changed cannot be combined");
      const jpeg = !!flags.jpeg || flags.format === "jpeg" || (!flags.format && process.env.MONAD_SCREENSHOT_FORMAT === "jpeg");
      const format = jpeg ? "jpeg" : "png";
      const quality = flags.quality !== undefined ? num(flags.quality, 70)
        : process.env.MONAD_SCREENSHOT_QUALITY ? Number(process.env.MONAD_SCREENSHOT_QUALITY) : undefined;
      const target = typeof flags.on === "string" ? flags.on : undefined;
      const dir = typeof flags.dir === "string" ? resolvePath(ctx.cwd, flags.dir)
        : process.env.MONAD_SCREENSHOT_DIR ? resolvePath(ctx.cwd, process.env.MONAD_SCREENSHOT_DIR) : ctx.cwd;
      const name = args[0] ?? `screenshot-${Date.now()}.${jpeg ? "jpg" : "png"}`;
      const out = resolvePath(dir, name);
      if (flags.annotate) {
        if (flags.full) throw new Error("--annotate supports viewport or element screenshots, not --full");
        const shot = await ctx.browser.annotatedScreenshot({ target, format, quality });
        mkdirSync(dir, { recursive: true });
        writeFileSync(out, shot.buffer);
        return `ok ${out} (${Math.round(shot.buffer.length / 1024)} KB)\n${shot.legend.join("\n")}`;
      }
      const buf = await ctx.browser.screenshot({ fullPage: !!flags.full, target, format, quality, ifChanged: !!flags["if-changed"] });
      if (!buf) return "unchanged";
      mkdirSync(dir, { recursive: true });
      writeFileSync(out, buf);
      return `ok ${out} (${Math.round(buf.length / 1024)} KB)`;
    },
  },
  back: { usage: "back", async run(ctx) { await ctx.browser.back(); return `ok ${(await ctx.browser.info()).url}`; } },
  forward: { usage: "forward", async run(ctx) { await ctx.browser.forward(); return `ok ${(await ctx.browser.info()).url}`; } },
  reload: { usage: "reload", async run(ctx) { await ctx.browser.reload(); return `ok ${(await ctx.browser.info()).url}`; } },
  wait: {
    usage: "wait <ms|selector|--idle|--text T|--url GLOB|--fn JS|--state hidden>   wait for time, an element, network idle, text, URL, JS, or disappearance",
    async run(ctx, args, flags) {
      const b = ctx.browser;
      const timeout = num(flags.timeout, 10_000);
      const end = Date.now() + timeout;
      if (flags.idle) return (await b.networkIdle(500, timeout)) ? "ok idle" : "timeout (still loading)";
      if (typeof flags.text === "string") {
        while (Date.now() < end) {
          const hit = await b.evaluate(`document.body ? document.body.innerText.includes(${JSON.stringify(flags.text)}) : false`).catch(() => false);
          if (hit) return "ok";
          await pause(100);
        }
        return "timeout: text not found";
      }
      if (typeof flags.url === "string") {
        while (Date.now() < end) {
          const { url } = await b.info();
          if (matchGlob(url, flags.url)) return `ok ${url}`;
          await pause(100);
        }
        return `timeout: URL did not match ${flags.url}`;
      }
      if (typeof flags.fn === "string") {
        while (Date.now() < end) {
          if (await b.evaluate(flags.fn).catch(() => false)) return "ok";
          await pause(100);
        }
        return "timeout: expression stayed false";
      }
      need(args, 1, this.usage);
      if (/^\d+$/.test(args[0])) { await pause(Number(args[0])); return "ok"; }
      const hidden = flags.state === "hidden";
      while (Date.now() < end) {
        const visible = await b.isVisible(args[0]).catch(() => false);
        if (hidden ? !visible : visible) return "ok";
        await pause(100);
      }
      return hidden ? `timeout: ${args[0]} is still visible` : `timeout: ${args[0]} not visible`;
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
  read: {
    usage: "read [url] [--raw] [--require-md] [--outline] [--filter T] [--llms index|full] [--timeout ms]   read a page as markdown/text (URL reads do not launch Chrome)",
    async run(ctx, args, flags) {
      const opts = {
        raw: !!flags.raw, requireMd: !!flags["require-md"], outline: !!flags.outline,
        filter: typeof flags.filter === "string" ? flags.filter : undefined,
        llms: (flags.llms === "index" || flags.llms === "full" ? flags.llms : undefined) as "index" | "full" | undefined,
        timeoutMs: num(flags.timeout, 10_000),
      };
      if (opts.llms && !args[0]) throw new Error("--llms needs a URL");
      if (args[0]) {
        const { readUrl } = await import("./read.js");
        return readUrl(args[0], opts);
      }
      if (opts.requireMd) throw new Error("--require-md needs a URL");
      const html = String(await ctx.browser.evaluate("document.documentElement ? document.documentElement.outerHTML : ''"));
      if (opts.raw) return html;
      if (opts.outline) return htmlToText(html, { outline: true });
      const text = htmlToText(html);
      return opts.filter ? filterSections(text, opts.filter) : text;
    },
  },
  get: {
    usage: "get <text|html|value|attr|title|url|cdp-url|count|box|styles> [target] [name] [--props a,b] [--max N]",
    async run(ctx, args, flags) {
      need(args, 1, this.usage);
      const b = ctx.browser;
      const what = args[0];
      if (what === "title") return (await b.info()).title;
      if (what === "url") return (await b.info()).url;
      if (what === "cdp-url") return b.cdpUrl() || "(not a local launch)";
      if (what === "count") { need(args, 2, this.usage); return String(await b.getCount(args[1])); }
      need(args, 2, this.usage);
      switch (what) {
        case "text": return b.text(args[1], num(flags.max, 4000));
        case "html": return b.getHtml(args[1]);
        case "value": return b.getValue(args[1]);
        case "attr": need(args, 3, this.usage); return (await b.getAttr(args[1], args[2])) ?? "";
        case "box": return jsonOut(await b.getBox(args[1]));
        case "styles": {
          const props = typeof flags.props === "string" ? flags.props.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
          return jsonOut(await b.getStyles(args[1], props));
        }
        default: throw new Error(`unknown get target: ${what}`);
      }
    },
  },
  is: {
    usage: "is <visible|enabled|checked> <target>",
    async run(ctx, args) {
      need(args, 2, this.usage);
      const b = ctx.browser;
      if (args[0] === "visible") return String(await b.isVisible(args[1]));
      if (args[0] === "enabled") return String(await b.isEnabled(args[1]));
      if (args[0] === "checked") return String(await b.isChecked(args[1]));
      throw new Error(`usage: ${this.usage}`);
    },
  },
  find: {
    usage: "find <role|text|label|placeholder|alt|title|testid|first|last|nth> <value> <click|fill|check|uncheck|hover|text|focus> [text] [--name N] [--exact]",
    async run(ctx, args, flags) {
      need(args, 3, this.usage);
      const [loc, value, action, ...rest] = args;
      let target: string;
      let act = action;
      let extra = rest;
      if (loc === "role") target = `role=${value}${typeof flags.name === "string" ? `:${flags.name}` : ""}`;
      else if (loc === "text") target = `${flags.exact ? "text=" : "text~="}${value}`;
      else if (["label", "placeholder", "alt", "title", "testid"].includes(loc)) target = `${loc}=${value}`;
      else if (loc === "first") target = `nth=0:${value}`;
      else if (loc === "last") target = `nth=-1:${value}`;
      else if (loc === "nth") {
        need(args, 4, this.usage);
        target = `nth=${value}:${action}`;
        act = rest[0];
        extra = rest.slice(1);
      } else throw new Error(`unknown locator: ${loc}`);
      const b = ctx.browser;
      if (act === "click") { await b.click(target); return maybeSnap(ctx, flags, `ok clicked ${target}`); }
      if (act === "fill") { need([act, ...extra], 2, this.usage); await b.fill(target, extra.join(" ")); return maybeSnap(ctx, flags, `ok filled ${target}`); }
      if (act === "check" || act === "uncheck") { await b.setChecked(target, act === "check"); return maybeSnap(ctx, flags, `ok ${act}ed ${target}`); }
      if (act === "hover") { await b.hover(target); return "ok"; }
      if (act === "focus") { await b.focus(target); return "ok"; }
      if (act === "text") return b.text(target, num(flags.max, 4000));
      throw new Error(`unknown find action: ${act}`);
    },
  },
  check: {
    usage: "check <target> [-s]",
    async run(ctx, args, flags) { need(args, 1, this.usage); await ctx.browser.setChecked(args[0], true); return maybeSnap(ctx, flags, `ok checked ${args[0]}`); },
  },
  uncheck: {
    usage: "uncheck <target> [-s]",
    async run(ctx, args, flags) { need(args, 1, this.usage); await ctx.browser.setChecked(args[0], false); return maybeSnap(ctx, flags, `ok unchecked ${args[0]}`); },
  },
  focus: { usage: "focus <target>", async run(ctx, args) { need(args, 1, this.usage); await ctx.browser.focus(args[0]); return "ok"; } },
  scrollintoview: { usage: "scrollintoview <target>", async run(ctx, args) { need(args, 1, this.usage); await ctx.browser.scrollIntoViewTarget(args[0]); return "ok"; } },
  highlight: { usage: "highlight <target>", async run(ctx, args) { need(args, 1, this.usage); await ctx.browser.highlight(args[0]); return "ok"; } },
  upload: {
    usage: "upload <target> <file...>",
    async run(ctx, args) {
      need(args, 2, this.usage);
      const files = args.slice(1).map((f) => resolvePath(ctx.cwd, f));
      for (const f of files) if (!existsSync(f)) throw new Error(`no such file: ${f}`);
      await ctx.browser.upload(args[0], files);
      return `ok uploaded ${files.length} file(s)`;
    },
  },
  download: {
    usage: "download <target> [dir] [--timeout ms]",
    async run(ctx, args, flags) {
      need(args, 1, this.usage);
      const dir = resolvePath(ctx.cwd, args[1] ?? ctx.browser.defaultDownloadPath ?? "downloads");
      const path = await ctx.browser.download(args[0], dir, num(flags.timeout, 30_000));
      return `ok ${path}`;
    },
  },
  pdf: {
    usage: "pdf [path] [--landscape] [--no-print-background]",
    async run(ctx, args, flags) {
      const out = resolvePath(ctx.cwd, args[0] ?? `page-${Date.now()}.pdf`);
      const buf = await ctx.browser.pdf({ landscape: !!flags.landscape, printBackground: !flags["no-print-background"] });
      writeFileSync(out, buf);
      return `ok ${out} (${Math.round(buf.length / 1024)} KB)`;
    },
  },
  drag: { usage: "drag <source> <target>", async run(ctx, args) { need(args, 2, this.usage); await ctx.browser.drag(args[0], args[1]); return "ok"; } },
  keyboard: {
    usage: "keyboard type <text> | keyboard inserttext <text>",
    async run(ctx, args) {
      need(args, 2, this.usage);
      const text = args.slice(1).join(" ");
      if (args[0] === "type") { await ctx.browser.typeKeys(text); return "ok"; }
      if (args[0] === "inserttext") { await ctx.browser.type(text); return "ok"; }
      throw new Error(`usage: ${this.usage}`);
    },
  },
  keydown: { usage: "keydown <key>", async run(ctx, args) { need(args, 1, this.usage); await ctx.browser.keyDown(args[0]); return "ok"; } },
  keyup: { usage: "keyup <key>", async run(ctx, args) { need(args, 1, this.usage); await ctx.browser.keyUp(args[0]); return "ok"; } },
  mouse: {
    usage: "mouse move <x> <y> | down [button] | up [button] | wheel <dy> [dx]",
    async run(ctx, args) {
      need(args, 1, this.usage);
      const b = ctx.browser;
      if (args[0] === "move") { need(args, 3, this.usage); await b.mouseMove(num(args[1], 0), num(args[2], 0)); return "ok"; }
      if (args[0] === "down") { await b.mouseDown((args[1] as any) || "left"); return "ok"; }
      if (args[0] === "up") { await b.mouseUp((args[1] as any) || "left"); return "ok"; }
      if (args[0] === "wheel") { need(args, 2, this.usage); await b.mouseWheel(num(args[2], 0), num(args[1], 0)); return "ok"; }
      throw new Error(`usage: ${this.usage}`);
    },
  },
  set: {
    usage: "set viewport <w> <h> [--scale n] [--mobile] | set device <name> | set media [dark|light] [--reduced-motion] | set offline [on|off] | set headers <json> | set geo <lat> <lng>",
    async run(ctx, args, flags) {
      need(args, 1, this.usage);
      const b = ctx.browser;
      const sub = args[0];
      if (sub === "viewport") { need(args, 3, this.usage); await b.setViewport(num(args[1], 1280), num(args[2], 800), num(flags.scale, 1), !!flags.mobile); return "ok"; }
      if (sub === "device") { need(args, 2, this.usage); await b.setDevice(args[1]); return "ok"; }
      if (sub === "media") {
        const scheme = args[1] === "dark" || args[1] === "light" ? args[1] : undefined;
        await b.setMedia({ colorScheme: scheme, reducedMotion: flags["reduced-motion"] ? true : flags["no-reduced-motion"] ? false : undefined });
        return "ok";
      }
      if (sub === "offline") { await b.setOffline(args[1] !== "off"); return `ok offline=${args[1] !== "off"}`; }
      if (sub === "headers") { need(args, 2, this.usage); await b.setHeaders(JSON.parse(args[1])); return "ok"; }
      if (sub === "geo") { need(args, 3, this.usage); await b.setGeo(num(args[1], 0), num(args[2], 0), num(flags.accuracy, 1)); return "ok"; }
      throw new Error(`usage: ${this.usage}`);
    },
  },
  cookies: {
    usage: "cookies [get] [--url U] | cookies set <name> <value> [--url U] [--domain D] [--path P] [--httpOnly] [--secure] [--sameSite S] [--expires N] | cookies clear [--url U]",
    async run(ctx, args, flags) {
      const b = ctx.browser;
      const sub = args[0] ?? "get";
      const url = typeof flags.url === "string" ? flags.url : undefined;
      if (sub === "set") {
        need(args, 3, this.usage);
        const cookie: any = { name: args[1], value: args[2] };
        if (url) cookie.url = url;
        else if (typeof flags.domain === "string") cookie.domain = flags.domain;
        else cookie.url = (await b.info()).url;
        if (typeof flags.path === "string") cookie.path = flags.path;
        if (flags["http-only"] || flags.httpOnly) cookie.httpOnly = true;
        if (flags.secure) cookie.secure = true;
        if (typeof flags.sameSite === "string") cookie.sameSite = flags.sameSite;
        if (flags.expires !== undefined) cookie.expires = num(flags.expires, 0);
        await b.setCookie(cookie);
        return "ok cookie set";
      }
      if (sub === "clear") { await b.clearCookies(url); return "ok cookies cleared"; }
      const list = await b.cookies(url);
      return list.length ? list.map(cookieLine).join("\n") : "(no cookies)";
    },
  },
  storage: {
    usage: "storage local|session [get <key> | set <key> <value> | clear]",
    async run(ctx, args) {
      need(args, 1, this.usage);
      const kind = args[0] === "session" ? "session" : "local";
      const sub = args[1] ?? "get";
      const b = ctx.browser;
      if (sub === "clear") { await b.clearStorage(kind); return `ok ${kind}Storage cleared`; }
      if (sub === "set") { need(args, 4, this.usage); await b.setStorage(kind, args[2], args[3]); return "ok"; }
      const all = await b.storage(kind);
      if (args[2]) {
        if (!(args[2] in all)) throw new Error(`no ${kind}Storage key: ${args[2]}`);
        return all[args[2]];
      }
      return jsonOut(all);
    },
  },
  network: {
    usage: "network requests [--filter S] [--clear] | network clear | network har start|stop [path] | network route <pattern> [--abort|--body JSON] [--status N] [--content-type T] [--resource-type CSV] | network unroute [pattern]",
    async run(ctx, args, flags) {
      const b = ctx.browser;
      const sub = args[0] ?? "requests";
      if (sub === "clear") { b.clearNetwork(); return "ok cleared"; }
      if (sub === "har") {
        const action = args[1] ?? "start";
        if (action === "start") {
          b.clearNetwork();
          b.harPath = args[2] ? resolvePath(ctx.cwd, args[2]) : undefined;
          return "ok HAR started";
        }
        if (action === "stop") {
          const har = b.networkHar();
          const out = resolvePath(ctx.cwd, args[2] ?? b.harPath ?? `network-${Date.now()}.har`);
          writeFileSync(out, JSON.stringify(har, null, 1));
          b.harPath = undefined;
          return `ok ${out} (${har.log.entries.length} entries)`;
        }
        throw new Error(`usage: ${this.usage}`);
      }
      if (sub === "route") {
        need(args, 2, this.usage);
        const route: any = { pattern: args[1] };
        if (flags.abort) route.abort = true;
        if (typeof flags.body === "string") route.body = flags.body;
        if (flags.status !== undefined) route.status = num(flags.status, 200);
        if (typeof flags["content-type"] === "string") route.contentType = flags["content-type"];
        if (typeof flags["resource-type"] === "string") route.resourceTypes = flags["resource-type"].split(",").map((s) => s.trim()).filter(Boolean);
        await b.route(route);
        return `ok route ${args[1]}${route.abort ? " (abort)" : ""}`;
      }
      if (sub === "unroute") { await b.unroute(args[1]); return "ok unroute"; }
      const list = b.networkRequests(typeof flags.filter === "string" ? flags.filter : undefined);
      const out = list.length ? list.map(requestLine).join("\n") : "(no requests)";
      if (flags.clear) b.clearNetwork();
      return out;
    },
  },
  dialog: {
    usage: "dialog status | dialog accept [text] | dialog dismiss",
    async run(ctx, args) {
      const sub = args[0] ?? "status";
      const b = ctx.browser;
      if (sub === "status") { const d = b.dialogStatus(); return d ? `${d.type}: ${d.message}` : "no dialog"; }
      if (sub === "accept") { await b.dialogAccept(args[1]); return "ok accepted"; }
      if (sub === "dismiss") { await b.dialogDismiss(); return "ok dismissed"; }
      throw new Error(`usage: ${this.usage}`);
    },
  },
  diff: {
    usage: "diff snapshot [--baseline FILE] [-i] | diff url <u1> <u2> [-i]",
    async run(ctx, args, flags) {
      const b = ctx.browser;
      const sub = args[0];
      const opts = { interactive: !!flags.interactive };
      const render = (before: string[], after: string[]) => {
        const d = renderDiff(before, after);
        return d.added || d.removed ? `+${d.added} -${d.removed}, ${d.same} unchanged\n${d.text}` : "no changes";
      };
      if (sub === "snapshot") {
        // With no explicit -i/--full, compare in the same mode as the last snapshot.
        const meta = typeof flags.baseline === "string" ? undefined : b.lastSnapshotMeta();
        if (flags.interactive === undefined && meta) {
          try { opts.interactive = !!JSON.parse(meta.key)[1]; } catch { /* keep the default */ }
        }
        const after = (await b.snapshotText(opts)).split("\n");
        let before: string[] | undefined;
        if (typeof flags.baseline === "string") {
          before = readFileSync(resolvePath(ctx.cwd, flags.baseline), "utf8").split("\n");
          // A saved `mb snapshot` includes the "# title — url" header; the tree comparison does not.
          if (before[0]?.startsWith("# ") && before[0].includes(" — ")) before.shift();
        } else {
          before = meta?.lines;
        }
        if (!before) throw new Error("no previous snapshot — take one or pass --baseline <file>");
        return render(before, after);
      }
      if (sub === "url") {
        need(args, 3, this.usage);
        await b.goto(args[1]);
        const before = (await b.snapshotText(opts)).split("\n");
        await b.goto(args[2]);
        const after = (await b.snapshotText(opts)).split("\n");
        return render(before, after);
      }
      throw new Error(`usage: ${this.usage}`);
    },
  },
  profiler: {
    usage: "profiler start | profiler stop [path]",
    async run(ctx, args) {
      need(args, 1, this.usage);
      const b = ctx.browser;
      if (args[0] === "start") { await b.send("Profiler.enable"); await b.send("Profiler.start"); return "ok profiling"; }
      if (args[0] === "stop") {
        const { profile } = await b.send<any>("Profiler.stop");
        const out = resolvePath(ctx.cwd, args[1] ?? `profile-${Date.now()}.json`);
        writeFileSync(out, JSON.stringify(profile));
        return `ok ${out}`;
      }
      throw new Error(`usage: ${this.usage}`);
    },
  },
  trace: {
    usage: "trace start | trace stop [path]",
    async run(ctx, args) {
      need(args, 1, this.usage);
      const b = ctx.browser;
      if (args[0] === "start") { await b.traceStart(); return "ok tracing"; }
      if (args[0] === "stop") {
        const out = resolvePath(ctx.cwd, args[1] ?? `trace-${Date.now()}.json`);
        await b.traceStop(out);
        return `ok ${out}`;
      }
      throw new Error(`usage: ${this.usage}`);
    },
  },
};
COMMANDS.goto = COMMANDS.open;
COMMANDS.navigate = COMMANDS.open;
COMMANDS.snap = COMMANDS.snapshot;
COMMANDS.js = COMMANDS.eval;
COMMANDS.scrollinto = COMMANDS.scrollintoview;
COMMANDS.key = COMMANDS.press;

export const EXTRA_USAGE: Record<string, string> = {
  start: "start [--cdp URL|PORT] [--headful] [--profile DIR] [--block image,font]   start daemon explicitly (each --session NAME is its own browser; --profile DIR persists it)",
  mcp: "mcp   run as an MCP server over stdio (same warm browser as the CLI)",
  doctor: "doctor [--fix]   diagnose Chrome, state directory and config (no browser)",
  skills: "skills list | skills get <name> | skills path [name]   version-matched agent skills",
  "install-skill": "install-skill [--project | --dir DIR | --print]   install SKILL.md for coding agents",
  stop: "stop [--all]   stop the current session (or all)",
  status: "status   show the current session status",
  sessions: "sessions   list running sessions",
};

/** Usage for a command (including special-cased ones), so `<cmd> --help` never runs the command. */
export function usageFor(name: string): string | undefined {
  const usage = COMMANDS[name]?.usage ?? EXTRA_USAGE[name];
  return usage ? `usage: mb ${usage}` : undefined;
}

export function helpText() {
  const seen = new Set<Cmd>();
  const lines = ["monad-browser — headless browser for agents", "", "usage: mb [--session NAME] <command> [args]", "", "commands:"];
  for (const c of Object.values(COMMANDS)) { if (seen.has(c)) continue; seen.add(c); lines.push(`  ${c.usage}`); }
  for (const usage of new Set(Object.values(EXTRA_USAGE))) lines.push(`  ${usage}`);
  lines.push("", "aliases: goto, navigate → open · snap → snapshot · js → eval · scrollinto → scrollintoview · key → press");
  lines.push("refs: snapshot assigns @N to interactive elements; refs stay stable while the element lives.");
  return lines.join("\n");
}

export async function dispatch(ctx: Ctx, argv: string[]): Promise<string> {
  const [name, ...rest] = argv;
  const cmd = COMMANDS[name];
  if (!cmd) throw new Error(`unknown command: ${name}\n\n${helpText()}`);
  const { args, flags } = parseArgs(rest);
  if (flags.help) return `usage: mb ${cmd.usage}`;
  return cmd.run(ctx, args, flags);
}
