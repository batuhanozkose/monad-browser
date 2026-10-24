// Unit tests for the pure helpers: the Myers diff and the argv parser. No Chrome needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTreeChange, diffLines, globToRegExp, matchGlob, renderDiff, treeChange } from "../dist/diff.js";
import { filterSections, htmlToText, outlineMarkdown } from "../dist/read.js";
import { parseArgs } from "../dist/commands.js";

test("diffLines finds equal, removed and added runs", () => {
  const ops = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
  const removed = ops.filter((o) => o.t === "-").map((o) => o.line);
  const added = ops.filter((o) => o.t === "+").map((o) => o.line);
  const same = ops.filter((o) => o.t === "=").map((o) => o.line);
  assert.deepEqual(removed, ["b"]);
  assert.deepEqual(added.sort(), ["e", "x"]);
  assert.deepEqual(same, ["a", "c", "d"]);
});

test("diffLines is empty for identical input", () => {
  const ops = diffLines(["a", "b"], ["a", "b"]);
  assert.ok(ops.every((o) => o.t === "="));
});

test("renderDiff reports counts and marks lines", () => {
  const d = renderDiff(["a", "b", "c"], ["a", "c", "d"]);
  assert.equal(d.removed, 1);
  assert.equal(d.added, 1);
  assert.equal(d.same, 2);
  assert.match(d.text, /^- b$/m);
  assert.match(d.text, /^\+ d$/m);
});

test("renderDiff keeps the nearest unchanged ancestor as context", () => {
  const d = renderDiff(
    ["- list", "  - row", "    - [ok]@1"],
    ["- list", "  - row", "    - [changed]@1"],
  );
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.match(d.text, /- row/); // nearest less-indented ancestor, not the root
  assert.doesNotMatch(d.text, /- list/);
});

test("treeChange + applyTreeChange reconstruct the new tree", () => {
  const cases = [
    [["a", "b", "c"], ["a", "x", "c"]],
    [["a", "b"], ["a", "b", "c"]],
    [["a", "b", "c"], ["a", "c"]],
    [["a", "b", "c", "d", "e"], ["a", "X", "c", "d", "Y"]],
    [[], ["a"]],
    [["a"], []],
  ];
  for (const [before, after] of cases) {
    const change = treeChange(before, after);
    assert.deepEqual(applyTreeChange(before, change), after);
  }
  // The splice is contiguous: two distant changes cover the middle, which is why the text
  // diff (Myers) is used for humans and the JSON patch falls back to full when it is large.
  const scattered = treeChange(["a", "b", "c", "d"], ["A", "b", "c", "D"]);
  assert.equal(scattered.startLine, 0);
  assert.equal(scattered.deleteCount, 4);
});

test("globToRegExp matches URL globs and plain strings match as substrings", () => {
  assert.ok(globToRegExp("**/api").test("https://x.test/v1/api"));
  assert.ok(!globToRegExp("**/api").test("https://x.test/v1/apis"));
  assert.ok(globToRegExp("*.example.com").test("a.example.com"));
  assert.ok(!globToRegExp("*.example.com").test("example.com"));
  assert.ok(matchGlob("https://x.test/a/b", "**/b"));
  assert.ok(matchGlob("https://x.test/a/b", "a/b"));
  assert.ok(!matchGlob("https://x.test/a/b", "c"));
});

test("htmlToText strips chrome, keeps structure and decodes entities", () => {
  const html = `<html><body><nav><a href="/x">Nav</a></nav><main>
    <h1>Title &amp; More</h1><p>Hello <strong>world</strong>.</p>
    <ul><li>one</li><li>two</li></ul>
    <pre><code>const x = 1;</code></pre>
    <a href="/docs">Docs</a>
  </main><footer>Footer</footer></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /^# Title & More/m);
  assert.match(text, /Hello \*\*world\*\*\./);
  assert.match(text, /- one/);
  assert.match(text, /```/);
  assert.match(text, /\[Docs\]\(\/docs\)/);
  assert.doesNotMatch(text, /Nav/);
  assert.doesNotMatch(text, /Footer/);
  assert.equal(htmlToText(html, { outline: true }), "# Title & More");
});

test("filterSections keeps matching markdown sections and outlineMarkdown lists headings", () => {
  const md = "# Alpha\none\n## Beta\ntwo\n## Gamma\nthree";
  assert.equal(filterSections(md, "Beta"), "## Beta\ntwo");
  assert.equal(outlineMarkdown(md), "# Alpha\n## Beta\n## Gamma");
});

test("parseArgs handles short flags, values and --", () => {
  assert.deepEqual(parseArgs(["-s"]).flags.snapshot, true);
  assert.deepEqual(parseArgs(["-i", "-d"]).flags, { interactive: true, diff: true });
  assert.equal(parseArgs(["--max-lines", "5"]).flags["max-lines"], "5");
  assert.equal(parseArgs(["--max-lines=5"]).flags["max-lines"], "5");
  assert.deepEqual(parseArgs(["--", "-x", "y"]).args, ["-x", "y"]);
});

test("parseArgs treats declared booleans as flags, not values", () => {
  const { args, flags } = parseArgs(["--interactive", "example.com"]);
  assert.equal(flags.interactive, true);
  assert.deepEqual(args, ["example.com"]);
});

test("loadConfig merges a project config and normalizes arrays", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mb-cfg-"));
  writeFileSync(join(dir, "monad-browser.json"), JSON.stringify({
    idleMinutes: 7, block: ["image"], viewport: { width: 390, height: 844 },
    initScripts: ["a.js", "b.js"], headers: { "X-Test": "1" },
  }));
  const { loadConfig } = await import("../dist/config.js");
  const cfg = loadConfig(dir);
  assert.equal(cfg.idleMinutes, 7);
  assert.deepEqual(cfg.block, ["image"]);
  assert.deepEqual(cfg.viewport, { width: 390, height: 844 });
  assert.deepEqual(cfg.initScripts, ["a.js", "b.js"]);
  assert.deepEqual(cfg.headers, { "X-Test": "1" });
});

test("parseArgs accepts the new diff/query/wait flags", () => {
  assert.deepEqual(parseArgs(["--full", "--json"]).flags, { full: true, json: true });
  assert.deepEqual(parseArgs(["--annotate", "--if-changed"]).flags, { annotate: true, "if-changed": true });
  assert.equal(parseArgs(["--url", "**/dash"]).flags.url, "**/dash");
  assert.equal(parseArgs(["--fn", "window.ready === true"]).flags.fn, "window.ready === true");
  assert.equal(parseArgs(["--state", "hidden", "#x"]).flags.state, "hidden");
  assert.equal(parseArgs(["--body", '{"ok":true}']).flags.body, '{"ok":true}');
});
