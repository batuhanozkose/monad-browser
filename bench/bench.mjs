// Usage: node bench.mjs <tool> [--skip-pages]  → results/<tool>.json
import { relay, fixtures, FIX, tok, median } from "./common.mjs";
import * as A from "./adapters.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const TOOLS = { monad: A.monadCli, "monad-mcp": A.monadMcp, ab: A.agentBrowser, pwcli: A.playwrightCli, pwmcp: A.playwrightMcp, cdt: A.chromeDevtoolsMcp };
const key = process.argv[2];
const ad = TOOLS[key]();
await relay(); await fixtures();
const PAGES = {
  form: `${FIX}/form.html`,
  example: "https://example.com/",
  hn: "https://news.ycombinator.com/",
  wiki: "https://en.wikipedia.org/wiki/Gaziantep",
  books: "https://books.toscrape.com/",
  mdn: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/select",
};
const res = { tool: ad.name, key, at: new Date().toISOString(), pages: {}, tasks: {}, latency: {} };
const log = (...a) => console.error(`[${key}]`, ...a);

// 1. cold start (launch + first navigation)
let r = await ad.start();
res.coldStartMs = Math.round(r.ms);
log("cold", res.coldStartMs);
if (ad.tools) { const t = ad.tools(); res.mcp = { tools: t.length, schemaTokens: tok(JSON.stringify(t.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))) }; }

// 2. snapshot size + latency per page
if (!process.argv.includes("--skip-pages")) for (const [p, url] of Object.entries(PAGES)) {
  const o = await ad.open(url);
  const snaps = [];
  for (let i = 0; i < 3; i++) snaps.push(await ad.snap("full"));
  const full = snaps[2].out;
  const entry = { openMs: Math.round(o.ms), openOutTokens: tok(o.out), snapMs: Math.round(median(snaps.map((s) => s.ms))), bytes: Buffer.byteLength(full), tokens: tok(full) };
  if (key === "monad" || key === "ab" || key === "monad-mcp") { const i = await ad.snap("i"); entry.iBytes = Buffer.byteLength(i.out); entry.iTokens = tok(i.out); }
  res.pages[p] = entry;
  log(p, JSON.stringify(entry));
}

// 3. warm latency
{
  const opens = [], clicks = [];
  for (let i = 0; i < 3; i++) opens.push((await ad.open(PAGES.form)).ms);
  await ad.open(PAGES.form);
  const s = await ad.snap(ad.snapMode ?? "full");
  const ref = ad.find(s.out, "checkbox", "I agree");
  for (let i = 0; i < 5; i++) clicks.push((await ad.click(ref)).ms);
  res.latency = { openFormMs: Math.round(median(opens)), clickMs: Math.round(median(clicks)), clickRef: ref };
  log("latency", JSON.stringify(res.latency));
}

// 4. agent-style tasks, step by step: count calls and every token the agent reads
async function task(name, body) {
  const ctx = { calls: 0, outTok: 0, inTok: 0, ms: 0, mem: [], trace: [] };
  const act = async (fn, args, { nav = false } = {}) => {
    const r = await ad[fn](...args);
    ctx.calls += r.calls ?? 1; ctx.outTok += tok(r.out); ctx.inTok += tok(JSON.stringify(args)) + 8; ctx.ms += r.ms;
    if (nav || fn === "open") ctx.mem = [];
    ctx.mem.unshift(r.out);
    ctx.trace.push(`${fn}(${args.map(String).join(", ").slice(0, 40)}) ${Math.round(r.ms)}ms ${tok(r.out)}tok`);
    return r;
  };
  const need = async (role, nm) => {
    for (const m of ctx.mem) { const f = ad.find(m, role, nm); if (f) return f; }
    for (let attempt = 0; attempt < 2; attempt++) {  // a real agent re-snapshots once if the page was still loading
      await act("snap", [ad.snapMode ?? "full"]);
      const f = ad.find(ctx.mem[0], role, nm);
      if (f) return f;
      ctx.retries = (ctx.retries ?? 0) + 1;
    }
    throw new Error(`no ${role} ${nm}`);
  };
  const observe = async () => { if (!ad.actionsReturnPage) await act("snap", [ad.snapMode ?? "full"]); };
  let ok = false, err;
  try { ok = await body({ act, need, observe, ctx }); } catch (e) { err = String(e?.message ?? e); }
  res.tasks[name] = { ok, calls: ctx.calls, outTokens: ctx.outTok, inTokens: ctx.inTok, ms: Math.round(ctx.ms), retries: ctx.retries ?? 0, err, trace: ctx.trace };
  log("task", name, ok, ctx.calls, ctx.outTok, Math.round(ctx.ms), err ?? "");
}

await task("form", async ({ act, need, ctx }) => {
  await act("open", [PAGES.form]);
  await act("fill", [await need("textbox", "Name"), "Ada"]);
  await act("select", [await need("combobox", "Plan"), "Pro"]);
  await act("click", [await need("checkbox", "I agree")]);
  await act("click", [await need("button", "Submit")]);
  if (!/Hello Ada \/ pro \/ true/.test(ctx.mem[0])) await act("snap", [ad.snapMode ?? "full"]);
  if (!/Hello Ada \/ pro \/ true/.test(ctx.mem[0]) && ad.snapMode) await act("snap", ["full"]);
  return /Hello Ada \/ pro \/ true/.test(ctx.mem[0]);
});
await task("hn-comments", async ({ act, need, observe }) => {
  await act("open", [PAGES.hn]);
  await act("click", [await need("link", /^\d+\s*comments?$/)], { nav: true });
  await observe();
  return /item\?id=/.test(await ad.url());
});
await task("books-paginate", async ({ act, need, observe }) => {
  await act("open", [PAGES.books]);
  await act("click", [await need("link", "Mystery")], { nav: true });
  await act("click", [await need("link", "next")], { nav: true });
  await observe();
  return /mystery_3\/page-2/.test(await ad.url());
});
await task("wiki-search", async ({ act, need, observe }) => {
  await act("open", ["https://en.wikipedia.org/wiki/Special:Search"]);
  await act("fillSubmit", [await need("searchbox", /^Search Wikipedia$/), "Gaziantep"], { nav: true });
  await observe();
  return /\/wiki\/Gaziantep/.test(await ad.url());
});

await ad.stop();
mkdirSync("results", { recursive: true });
if (process.argv.includes("--skip-pages")) { try { const prev = JSON.parse((await import("node:fs")).readFileSync(`results/${key}.json`, "utf8")); res.pages = prev.pages; } catch {} }
writeFileSync(`results/${key}.json`, JSON.stringify(res, null, 1));
log("done");
process.exit(0);
