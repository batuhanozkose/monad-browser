// Information retention: what share of the page's visible paragraph/list/cell text survives into the snapshot?
import { relay, fixtures, sh, CHROME, PROXY, BIN } from "./common.mjs";
await relay(); await fixtures();
const MB = new URL("../dist/cli.js", import.meta.url).pathname;
const menv = { MONAD_CHROME: CHROME, MONAD_NO_SANDBOX: "1", MONAD_PROXY: PROXY, MONAD_SESSION: "fid" };
const aenv = { AGENT_BROWSER_EXECUTABLE_PATH: CHROME, AGENT_BROWSER_ARGS: "--no-sandbox", AGENT_BROWSER_PROXY: PROXY, AGENT_BROWSER_SESSION: "fid" };
const m = (...a) => sh(process.execPath, [MB, ...a], { env: menv });
const ab = (...a) => sh(BIN + "agent-browser", a, { env: aenv });
const P = { hn: "https://news.ycombinator.com/", books: "https://books.toscrape.com/", mdn: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/select", wiki: "https://en.wikipedia.org/wiki/Gaziantep" };
// Format-neutral text: drop refs, role words and punctuation so "[ilreb]@12" and 'link "ilreb" [ref=e5]' compare equal.
const ROLES = /\b(statictext|link|generic|button|textbox|searchbox|combobox|checkbox|heading|paragraph|listitem|list|cell|row|rowgroup|table|columnheader|rowheader|img|image|navigation|main|banner|contentinfo|region|group|article|separator|option|menuitem|text|level|ref|url|cursor|pointer|clickable|onclick|emphasis|strong|code|term|definition|figure|caption|superscript|subscript|insertion|deletion|labeltext|inlinetextbox|linebreak|root|webarea|tab|tablist|tabpanel|dialog|form|note|complementary|search|status|time|mark|blockquote|sectionheader|sectionfooter|section|none|presentation)\b/g;
const norm = (s) => s.toLowerCase().replace(/@\d+|\bref=\w+|\buid=\S+|\be\d+\b/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(ROLES, " ").replace(/\s+/g, " ").trim();
const PROBE = `[...document.querySelectorAll('p, li, td, h1, h2, h3, a')].filter(e => e.offsetParent && !e.closest('nav,footer,[role=navigation],.mw-jump-link')).map(e => e.innerText.trim().replace(/\\s+/g,' ')).filter(t => t.length >= 25).map(t => t.slice(0, 40)).join('\\n')`;
const res = {};
for (const [p, u] of Object.entries(P)) {
  await m("open", u); await ab("open", u);
  const probes = [...new Set((await m("eval", PROBE)).out.split("\n").map(s => s.trim()).filter(s => s.length >= 25))];
  const ms = { def: norm((await m("snapshot")).out), unc: norm((await m("snapshot", "--max-lines", "1000000", "--max-text", "1000000")).out) };
  const as = { full: norm((await ab("snapshot")).out), i: norm((await ab("snapshot", "-i")).out) };
  const pct = (txt) => Math.round(100 * probes.filter((x) => txt.includes(norm(x).split(' ').slice(0, -1).join(' '))).length / probes.length);
  res[p] = { probes: probes.length, monadDefault: pct(ms.def), monadUncapped: pct(ms.unc), abFull: pct(as.full), abI: pct(as.i) };
  console.log(p, JSON.stringify(res[p]));
}
(await import("node:fs")).writeFileSync("results/fidelity.json", JSON.stringify(res));
await m("stop"); await ab("close"); process.exit(0);
