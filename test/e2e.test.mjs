// End-to-end against local fixtures. Skips when no Chrome is available.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { findChrome } from "../dist/chrome.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
const F = pathToFileURL(join(here, "fixtures")).href;
const env = { ...process.env, MONAD_SESSION: `test-${process.pid}`, MONAD_NO_SANDBOX: "1" };
const mb = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8" }).trim();
const skip = !findChrome() && "no Chrome found";

before(() => { if (!skip) mb("open", `${F}/form.html`); });
after(() => { if (!skip) mb("stop"); });

test("snapshot is compact and refs are stable", { skip }, () => {
  const a = mb("snapshot");
  assert.match(a, /nav: \[Home\]@1 \[Next page\]@2/);
  assert.match(a, /\[textbox Name\]@3/);
  assert.doesNotMatch(a, /Hidden button/);
  assert.match(a, /clickable "Open card" @7/);
  assert.equal(mb("snapshot"), a);
});

test("run executes a multi-step plan in one call", { skip }, () => {
  const out = mb("run", `await fill("@3", "Ada"); await select("role=combobox:Plan", "Pro"); await click("text=I agree"); await click("role=button:Submit"); return await text("#out")`);
  assert.equal(out, "Hello Ada / pro / true");
});

test("refs self-heal after re-render", { skip }, () => {
  mb("eval", `const b=document.querySelector("form button"); b.replaceWith(b.cloneNode(true)); return 1`);
  assert.match(mb("click", "@6"), /ok clicked/);
});

test("covered elements report the cover", { skip }, () => {
  mb("eval", `const o=document.createElement("div");o.id="cover";o.style="position:fixed;inset:0";document.body.append(o);return 1`);
  assert.throws(() => mb("run", `await click("@6", {timeout: 300})`), /covered by div#cover/);
  mb("eval", `document.getElementById("cover").remove(); return 1`);
});

test("navigation via click settles quickly", { skip }, () => {
  const t = Date.now();
  mb("click", "@2");
  assert.ok(Date.now() - t < 3000);
  assert.match(mb("url"), /^Next/);
});
