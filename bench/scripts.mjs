// Script mode: the whole task in ONE agent tool call. Usage: node scripts.mjs <tool>
import { relay, fixtures, FIX, tok, median, sh, BIN } from "./common.mjs";
import * as A from "./adapters.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
await relay(); await fixtures();
const key = process.argv[2];
const F = `${FIX}/form.html`, B = "https://books.toscrape.com/";
const TITLES = `[...document.querySelectorAll('h3 a')].slice(0,3).map(a=>a.title)`;
const S = {
  monad: {
    ad: A.monadCli,
    form: `await goto("${F}"); await fill("#name","Ada"); await select("#plan","pro"); await click("#agree"); await click("text=Submit"); return await text("#out")`,
    books: `await goto("${B}"); await click("text=Mystery"); await click("text=next"); return { url: await url(), titles: await js(\`${TITLES}\`) }`,
    exec: (ad, code) => ad.script(code),
  },
  ab: {
    ad: A.agentBrowser,
    form: [`open ${F}`, `fill #name Ada`, `select #plan pro`, `check #agree`, `find text Submit click --exact`, `get text #out`],
    books: [`open ${B}`, `find text Mystery click --exact`, `wait --load load`, `find text next click --exact`, `wait --load load`, `get url`, `eval "JSON.stringify(${TITLES})"`],
    exec: (ad, cmds) => ad.script(cmds),
  },
  pwcli: {
    ad: A.playwrightCli,
    form: `async page => { await page.goto("${F}"); await page.fill("#name","Ada"); await page.selectOption("#plan","pro"); await page.check("#agree"); await page.click("text=Submit"); return await page.textContent("#out"); }`,
    books: `async page => { await page.goto("${B}"); await page.click("text=Mystery"); await page.click("text=next"); return { url: page.url(), titles: await page.evaluate(() => ${TITLES}) }; }`,
    exec: (ad, code) => ad.script(code),
  },
  pwmcp: {
    ad: A.playwrightMcp,
    form: `async (page) => { await page.goto("${F}"); await page.fill("#name","Ada"); await page.selectOption("#plan","pro"); await page.check("#agree"); await page.click("text=Submit"); return await page.textContent("#out"); }`,
    books: `async (page) => { await page.goto("${B}"); await page.click("text=Mystery"); await page.click("text=next"); return { url: page.url(), titles: await page.evaluate(() => ${TITLES}) }; }`,
    exec: (ad, code) => ad.script(code),
  },
  dev: {
    ad: A.devBrowser,
    form: `const page = await browser.getPage("main"); await page.goto("${F}"); await page.fill("#name","Ada"); await page.selectOption("#plan","pro"); await page.check("#agree"); await page.click("text=Submit"); console.log(await page.textContent("#out"));`,
    books: `const page = await browser.getPage("main"); await page.goto("${B}"); await page.click("text=Mystery"); await page.click("text=next"); console.log(JSON.stringify({ url: page.url(), titles: await page.evaluate(() => ${TITLES}) }));`,
    exec: (ad, code) => ad.script(code),
  },
};
const s = S[key], ad = s.ad();
const res = { key, tool: ad.name, tasks: {} };
const st = await ad.start();
res.coldStartMs = Math.round(st.ms);
for (const t of ["form", "books"]) {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await s.exec(ad, s[t]));
  const last = runs[2];
  const ok = t === "form" ? /Hello Ada \/ pro \/ true/.test(last.out) : /page-2\.html/.test(last.out) && /title|\[/.test(last.out);
  const input = typeof s[t] === "string" ? s[t] : s[t].join("\n");
  res.tasks[t] = { ok, calls: 1, ms: Math.round(median(runs.map((r) => r.ms))), inTokens: tok(input), outTokens: tok(last.out), out: (last.out + (last.err ?? "")).slice(0, 400) };
  console.error(`[${key}]`, t, JSON.stringify(res.tasks[t]));
}
await ad.stop();
mkdirSync("results", { recursive: true });
writeFileSync(`results/script-${key}.json`, JSON.stringify(res, null, 1));
process.exit(0);
