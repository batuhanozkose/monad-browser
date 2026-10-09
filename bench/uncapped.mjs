import { relay, fixtures, FIX, tok, sh, CHROME, PROXY } from "./common.mjs";
await relay(); await fixtures();
const MB = new URL("../dist/cli.js", import.meta.url).pathname;
const env = { MONAD_CHROME: CHROME, MONAD_NO_SANDBOX: "1", MONAD_PROXY: PROXY, MONAD_SESSION: "unc" };
const run = (...a) => sh(process.execPath, [MB, ...a], { env });
const P = { form: `${FIX}/form.html`, example: "https://example.com/", hn: "https://news.ycombinator.com/", books: "https://books.toscrape.com/", mdn: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/select", wiki: "https://en.wikipedia.org/wiki/Gaziantep" };
const out = {};
for (const [p, u] of Object.entries(P)) {
  await run("open", u);
  const a = await run("snapshot", "--max-lines", "1000000", "--max-text", "1000000");
  const b = await run("snapshot", "--max-lines", "1000000");
  out[p] = { uncapped: tok(a.out), lines: a.out.split("\n").length, textCap80: tok(b.out), ms: Math.round(a.ms) };
  console.log(p, JSON.stringify(out[p]));
}
(await import("node:fs")).writeFileSync("results/monad-uncapped.json", JSON.stringify(out));
await run("stop"); process.exit(0);
