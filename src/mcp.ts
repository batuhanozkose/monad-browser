// MCP server over stdio (newline-delimited JSON-RPC 2.0). Tools forward to the same warm session daemon
// the CLI uses, so an agent can mix MCP calls and shell `mb` calls on one browser.
import { createInterface } from "node:readline";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "./client.js";
import { RUN_HELP } from "./run.js";

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  argv: (a: any) => string[];
  image?: boolean;
};

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const T = "Target: @N ref from a snapshot, text=Label, role=button:Name, or CSS.";

export const TOOLS: Tool[] = [
  {
    name: "browser_run",
    description: `Run a multi-step browser plan in one call (async JS). Only log()/return output comes back.\n${RUN_HELP.split("\n").slice(1, 4).join("\n")}`,
    inputSchema: obj({ code: str("async JS, e.g. await goto('x.com'); await click('text=Login'); return await snapshot()") }, ["code"]),
    argv: (a) => ["run", "--", a.code],
  },
  {
    name: "browser_open",
    description: "Navigate the current tab and return the page snapshot.",
    inputSchema: obj({ url: str("URL or host") }, ["url"]),
    argv: (a) => ["open", a.url, "-s"],
  },
  {
    name: "browser_snapshot",
    description: "Accessibility snapshot with @N refs. diff=true returns only what changed since the last one; full=true resets the diff baseline; json=true returns a compact full/unchanged/delta patch with revisions.",
    inputSchema: obj({
      interactive: { type: "boolean", description: "only interactive elements" },
      diff: { type: "boolean" },
      full: { type: "boolean" },
      json: { type: "boolean" },
    }),
    argv: (a) => ["snapshot", ...(a.interactive ? ["-i"] : []), ...(a.diff ? ["-d"] : []), ...(a.full ? ["--full"] : []), ...(a.json ? ["--json"] : [])],
  },
  {
    name: "browser_read",
    description: "Read a URL as markdown/text without launching Chrome, or the active tab's readable text. Prefers markdown/llms.txt and strips navigation from HTML.",
    inputSchema: obj({
      url: str("optional URL; omit to read the active tab"),
      outline: { type: "boolean", description: "headings only" },
      filter: str("keep sections containing this text"),
      raw: { type: "boolean", description: "return the response body unchanged" },
    }),
    argv: (a) => ["read", ...(a.url ? [a.url] : []), ...(a.outline ? ["--outline"] : []), ...(a.filter ? ["--filter", a.filter] : []), ...(a.raw ? ["--raw"] : [])],
  },
  {
    name: "browser_get",
    description: "Read one value from the page instead of a whole snapshot: text, html, value, attr, title, url, count, box, or styles.",
    inputSchema: obj({
      what: { type: "string", enum: ["text", "html", "value", "attr", "title", "url", "count", "box", "styles"] },
      target: str("optional @N/selector for element queries"),
      name: str("attribute name for attr"),
    }, ["what"]),
    argv: (a) => ["get", a.what, ...(a.target ? [a.target] : []), ...(a.name ? [a.name] : [])],
  },
  {
    name: "browser_find",
    description: "Semantic locator: find by role, text, label, placeholder, alt, title, testid, first, last, or nth and act (click/fill/check/uncheck/hover/text/focus).",
    inputSchema: obj({
      locator: { type: "string", enum: ["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"] },
      value: str("locator value"),
      action: { type: "string", enum: ["click", "fill", "check", "uncheck", "hover", "text", "focus"] },
      text: str("value for fill"),
      name: str("accessible-name filter for role"),
    }, ["locator", "value", "action"]),
    argv: (a) => ["find", a.locator, a.value, a.action, ...(a.text !== undefined ? [a.text] : []), ...(a.name ? ["--name", a.name] : [])],
  },
  {
    name: "browser_check",
    description: "Check or uncheck a checkbox/radio (checked=false unchecks).",
    inputSchema: obj({ target: str("element"), checked: { type: "boolean" } }, ["target"]),
    argv: (a) => [a.checked === false ? "uncheck" : "check", a.target],
  },
  {
    name: "browser_click",
    description: `Click (auto-waits until actionable) and return what changed. ${T}`,
    inputSchema: obj({ target: str("element"), double: { type: "boolean" } }, ["target"]),
    argv: (a) => ["click", a.target, ...(a.double ? ["--count", "2"] : []), "-s"],
  },
  {
    name: "browser_fill",
    description: `Clear and fill a field; submit=true presses Enter. Returns what changed. ${T}`,
    inputSchema: obj({ target: str("field"), text: str("value"), submit: { type: "boolean" } }, ["target", "text"]),
    argv: (a) => ["fill", a.target, a.text, ...(a.submit ? ["--submit"] : []), "-s"],
  },
  {
    name: "browser_press",
    description: "Press a key or chord (Enter, Tab, Escape, Control+a) and return what changed.",
    inputSchema: obj({ key: str("key") }, ["key"]),
    argv: (a) => ["press", a.key, "-s"],
  },
  {
    name: "browser_select",
    description: `Choose option(s) in a <select>. ${T}`,
    inputSchema: obj({ target: str("select"), values: { type: "array", items: { type: "string" } } }, ["target", "values"]),
    argv: (a) => ["select", a.target, ...a.values, "-s"],
  },
  {
    name: "browser_text",
    description: "Visible text of the page or one element (for reading content).",
    inputSchema: obj({ target: str("optional element") }),
    argv: (a) => ["text", ...(a.target ? [a.target] : [])],
  },
  {
    name: "browser_screenshot",
    description: "Screenshot of the viewport (or full page) as an image.",
    inputSchema: obj({ full: { type: "boolean" } }),
    argv: (a) => ["screenshot", a.__path, "--jpeg", ...(a.full ? ["--full"] : [])],
    image: true,
  },
  {
    name: "browser_command",
    description: "Any monad-browser CLI command as argv, e.g. [\"tabs\"], [\"back\"], [\"cookies\"], [\"network\",\"requests\"], [\"set\",\"viewport\",\"390\",\"844\"], [\"upload\",\"@3\",\"a.pdf\"], [\"pdf\",\"out.pdf\"], [\"diff\",\"snapshot\"].",
    inputSchema: obj({ argv: { type: "array", items: { type: "string" } } }, ["argv"]),
    argv: (a) => a.argv,
  },
];

export async function runMcp(session: string, launch: string[]) {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin });
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    chain = chain.then(async () => { await handle(msg); }).catch(() => {});
  });
  rl.on("close", () => chain.then(() => process.exit(0)));

  async function handle(msg: any) {
    const { id, method, params } = msg;
    const reply = (result: unknown) => id !== undefined && send({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "monad-browser", version: "0.1.0-alpha.0" },
          instructions: "Headless browser. Prefer browser_run for multi-step work and browser_read for docs/articles. Actions return only what changed on the page; browser_get/browser_find avoid full snapshots.",
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return fail(-32602, `unknown tool: ${params?.name}`);
        const args = { ...(params.arguments ?? {}) };
        if (tool.image) args.__path = join(tmpdir(), `monad-shot-${process.pid}-${Date.now()}.jpg`);
        try {
          const res = await call(session, tool.argv(args), launch, tool.name === "browser_run" ? 600_000 : 120_000);
          if (!res.ok) return reply({ content: [{ type: "text", text: res.error ?? "error" }], isError: true });
          if (tool.image) {
            const data = readFileSync(args.__path).toString("base64");
            rmSync(args.__path, { force: true });
            return reply({ content: [{ type: "image", data, mimeType: "image/jpeg" }] });
          }
          return reply({ content: [{ type: "text", text: res.out ?? "ok" }] });
        } catch (e: any) {
          return reply({ content: [{ type: "text", text: e?.message ?? String(e) }], isError: true });
        }
      }
      default:
        if (id !== undefined) return fail(-32601, `method not found: ${method}`);
    }
  }
}
