// Unit tests for the pure helpers: the Myers diff and the argv parser. No Chrome needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, renderDiff } from "../dist/diff.js";
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
