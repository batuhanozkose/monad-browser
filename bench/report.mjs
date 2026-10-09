// Aggregate results/*.json into BENCHMARK.md tables.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
const load = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
const KEYS = ["monad", "monad-mcp", "ab", "pwcli", "pwmcp", "cdt"];
const R = Object.fromEntries(KEYS.map((k) => [k, load(`results/${k}.json`)]).filter(([, v]) => v));
if (R.pwcli && !Object.keys(R.pwcli.pages ?? {}).length) R.pwcli.pages = load("results/pwcli.pages.json");
const S = Object.fromEntries(["monad", "ab", "pwcli", "pwmcp", "dev"].map((k) => [k, load(`results/script-${k}.json`)]).filter(([, v]) => v));
const NAME = { monad: "monad CLI", "monad-mcp": "monad MCP", ab: "agent-browser", pwcli: "Playwright CLI", pwmcp: "Playwright MCP", cdt: "Chrome DevTools MCP", dev: "dev-browser" };
const k = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const row = (cells) => `| ${cells.join(" | ")} |`;
const table = (head, rows) => [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");
const PAGES = ["form", "example", "hn", "books", "mdn", "wiki"];
let md = "";

md += "### Snapshot size (o200k tokens, full page)\n\n" + table(["Page", ...Object.keys(R).map((x) => NAME[x])],
  PAGES.map((p) => [p, ...Object.keys(R).map((x) => { const e = R[x].pages?.[p]; return e ? k(e.tokens) : "–"; })]));
const tot = (x, f) => PAGES.reduce((a, p) => a + (R[x].pages?.[p]?.[f] ?? 0), 0);
md += "\n" + row(["**Total**", ...Object.keys(R).map((x) => `**${k(tot(x, "tokens"))}**`)]) + "\n";
md += "\n### Interactive-only snapshot (tokens)\n\n" + table(["Page", "monad -i", "agent-browser -i"], PAGES.map((p) => [p, k(R.monad?.pages?.[p]?.iTokens ?? 0), k(R.ab?.pages?.[p]?.iTokens ?? 0)]));
md += "\n" + row(["**Total**", `**${k(tot("monad", "iTokens"))}**`, `**${k(tot("ab", "iTokens"))}**`]) + "\n";

md += "\n### Latency (ms, warm, median)\n\n" + table(["Tool", "Cold start", "open (local)", "click", "snapshot HN", "snapshot Wikipedia"],
  Object.keys(R).map((x) => [NAME[x], R[x].coldStartMs, R[x].latency.openFormMs, R[x].latency.clickMs, R[x].pages?.hn?.snapMs ?? "–", R[x].pages?.wiki?.snapMs ?? "–"]));

const TASKS = ["form", "hn-comments", "books-paginate", "wiki-search"];
md += "\n### Agent tasks, step by step (success · tool calls · tokens read · wall ms)\n\n" + table(["Tool", ...TASKS, "Total tokens", "Total calls"],
  Object.keys(R).map((x) => [NAME[x], ...TASKS.map((t) => { const e = R[x].tasks[t]; return `${e.ok ? "✓" : "✗"} ${e.calls} · ${k(e.outTokens)} · ${e.ms}`; }),
    k(TASKS.reduce((a, t) => a + R[x].tasks[t].outTokens, 0)), TASKS.reduce((a, t) => a + R[x].tasks[t].calls, 0)]));

md += "\n### Script mode, whole task in one call (success · ms · tokens in/out)\n\n" + table(["Tool", "form", "books-paginate"],
  Object.keys(S).map((x) => [NAME[x], ...["form", "books"].map((t) => { const e = S[x].tasks[t]; return `${e.ok ? "✓" : "✗"} ${e.ms} · ${e.inTokens}/${e.outTokens}`; })]));

md += "\n### MCP tool-definition cost (tokens loaded into every request)\n\n" + table(["Server", "Tools", "Schema tokens"],
  Object.keys(R).filter((x) => R[x].mcp).map((x) => [NAME[x], R[x].mcp.tools, k(R[x].mcp.schemaTokens)]));
writeFileSync("results/tables.md", md);
console.log(md);
