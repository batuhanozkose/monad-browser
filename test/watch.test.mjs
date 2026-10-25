// Watch unit tests: conditions, extraction, feeds, JSON paths, diff, backoff and state.
// No Chrome and no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backoffMs, conditionHolds, deriveName, diffValues, extractJson, formatDuration, hashValue,
  inferKind, normalizeHttpUrl, normalizeRepo, parseCondition, parseDuration, parseJsonPath,
  publicOutcome, publicWatch, readWatchFile, releasesFeedUrl, shouldFire, splitCommand,
  truncateBytes, watchFile, writeWatchFile, mutateWatchFile,
} from "../dist/watch.js";
import { extractCss, extractText, parseHtml, querySelectorAll } from "../dist/watch-html.js";
import { feedValue, parseFeed } from "../dist/watch-feed.js";

test("condition parser accepts the documented syntax", () => {
  assert.deepEqual(parseCondition("changed"), { op: "changed" });
  assert.deepEqual(parseCondition(""), { op: "changed" });
  assert.deepEqual(parseCondition('contains "DOWN"'), { op: "contains", value: "DOWN" });
  assert.deepEqual(parseCondition("contains 'maintenance'"), { op: "contains", value: "maintenance" });
  assert.deepEqual(parseCondition("not-contains sold out"), { op: "not-contains", value: "sold out" });
  assert.deepEqual(parseCondition("not_contains sold out"), { op: "not-contains", value: "sold out" });
  assert.deepEqual(parseCondition("matches /out of stock/i"), { op: "matches", value: "out of stock", flags: "i" });
  assert.deepEqual(parseCondition("> 10"), { op: "gt", value: "10" });
  assert.deepEqual(parseCondition(">= 1,250.5"), { op: "gte", value: "1,250.5" });
  assert.deepEqual(parseCondition("< 5"), { op: "lt", value: "5" });
  assert.deepEqual(parseCondition("<= 5"), { op: "lte", value: "5" });
  assert.deepEqual(parseCondition("== 0"), { op: "eq", value: "0" });
  assert.deepEqual(parseCondition("!= 0"), { op: "neq", value: "0" });
  assert.deepEqual(parseCondition("== closed"), { op: "eq", value: "closed" });
  assert.throws(() => parseCondition("contains"), /needs a value/);
  assert.throws(() => parseCondition("matches /[/"), /invalid regex/);
  assert.throws(() => parseCondition("> abc"), /needs a number/);
  assert.throws(() => parseCondition("sometimes"), /invalid condition/);
});

test("conditionHolds compares text and the first number", () => {
  assert.equal(conditionHolds(parseCondition('contains "down"'), "API DOWN"), true);
  assert.equal(conditionHolds(parseCondition('not-contains "down"'), "all up"), true);
  assert.equal(conditionHolds(parseCondition("matches /^v\\d+/"), "v1.2.3"), true);
  assert.equal(conditionHolds(parseCondition("> 100"), "Price 1,250.00 USD"), true);
  assert.equal(conditionHolds(parseCondition("> 100"), "Price 99"), false);
  assert.equal(conditionHolds(parseCondition("< 50"), "45 USD"), true);
  assert.equal(conditionHolds(parseCondition("== 0"), "0 items"), true);
  assert.equal(conditionHolds(parseCondition("== closed"), "Closed"), true);
  assert.equal(conditionHolds(parseCondition("!= 0"), "1"), true);
  assert.equal(conditionHolds(parseCondition("> 10"), "no digits"), false);
});

test("shouldFire fires on the transition, not every interval", () => {
  const contains = parseCondition('contains "down"');
  assert.equal(shouldFire("page", parseCondition("changed"), true, "a", "b"), true);
  assert.equal(shouldFire("page", parseCondition("changed"), false, "a", "a"), false);
  assert.equal(shouldFire("page", contains, true, "all up", "api down"), true);
  assert.equal(shouldFire("page", contains, true, "api down", "api down now"), false);
  assert.equal(shouldFire("page", contains, true, "all up", "all up!"), false);
  assert.equal(shouldFire("page", parseCondition('not-contains "sold out"'), true, "Sold out", "In stock"), true);
  assert.equal(shouldFire("page", parseCondition("> 100"), true, "99", "1,250"), true);
  assert.equal(shouldFire("page", parseCondition("> 100"), true, "150", "160"), false);
  assert.equal(shouldFire("page", parseCondition("== 3"), true, "2", "3"), true);
  // Feeds only look at new entries, so an old matching entry does not keep firing.
  assert.equal(shouldFire("rss", parseCondition('contains "security"'), true, "Old security fix", "New security release\nOld security fix"), true);
  assert.equal(shouldFire("rss", parseCondition('contains "security"'), true, "Old security fix", "Docs update\nOld security fix"), false);
});

test("text extraction strips chrome, scripts and markdown formatting", () => {
  const html = `<html><head><title>x</title><style>.a{}</style></head><body>
    <nav><a href="/x">Nav</a></nav><main><h1>Status &amp; More</h1>
    <p>All systems <b>operational</b>.</p><ul><li>one</li><li>two</li></ul>
    <a href="/docs">Docs</a><pre><code>const x = 1;</code></pre></main>
    <footer>Footer</footer><script>var a = 1</script></body></html>`;
  const text = extractText(html, "text/html; charset=utf-8");
  assert.match(text, /^Status & More$/m);
  assert.match(text, /All systems operational\./);
  assert.match(text, /^one$/m);
  assert.match(text, /Docs/);
  assert.match(text, /const x = 1/);
  assert.doesNotMatch(text, /Nav|Footer|var a|\*\*/);
  assert.equal(extractText("  up \r\n\r\n  and   running ", "text/plain"), "up\nand running");
});

test("CSS extraction supports the selectors watchers need", () => {
  const html = `<html><body>
    <div id="status"> All systems <b>operational</b> </div>
    <ul><li class="r" data-kind="release">v1.2</li><li class="r">v1.3</li></ul>
    <div class="x"><p>One</p><p>Two</p></div>
    <a href="/docs">Docs</a><a href="/api">API</a>
  </body></html>`;
  assert.equal(extractCss(html, "#status"), "All systems operational");
  assert.equal(extractCss(html, "li.r"), "v1.2\nv1.3");
  assert.equal(extractCss(html, "ul li"), "v1.2\nv1.3");
  assert.equal(extractCss(html, "li:first-child"), "v1.2");
  assert.equal(extractCss(html, "li:last-child"), "v1.3");
  assert.equal(extractCss(html, "li:nth-child(2)"), "v1.3");
  assert.equal(extractCss(html, "div.x > p"), "One\nTwo");
  assert.equal(extractCss(html, "p + p"), "Two");
  assert.equal(extractCss(html, "li[data-kind=release]"), "v1.2");
  assert.equal(extractCss(html, 'a[href^="/api"]'), "API");
  assert.equal(extractCss(html, "h1, #status"), "All systems operational");
  assert.throws(() => extractCss(html, ".missing"), /matched nothing/);
  assert.throws(() => extractCss(html, "div[["), /invalid CSS/);
  assert.equal(querySelectorAll(parseHtml(html), "li").length, 2);
});

test("JSON paths select keys and array indexes", () => {
  const doc = JSON.stringify({ data: { items: [{ price: 12.5, name: "a" }, { price: 7 }] }, ok: true, list: [1, 2], nil: null });
  assert.equal(extractJson(doc, "data.items[0].price"), "12.5");
  assert.equal(extractJson(doc, "$.data.items[1].price"), "7");
  assert.equal(extractJson(doc, "data.items[0].name"), "a");
  assert.equal(extractJson(doc, "ok"), "true");
  assert.equal(extractJson(doc, "list"), "[1,2]");
  assert.equal(extractJson(doc, "nil"), "null");
  assert.throws(() => extractJson(doc, "data.items[5].price"), /out of range/);
  assert.throws(() => extractJson(doc, "data.missing"), /no such key/);
  assert.throws(() => extractJson(doc, "data..items"), /empty key/);
  assert.throws(() => extractJson(doc, "data.items[x]"), /non-negative integer/);
  assert.throws(() => extractJson(doc, ""), /empty/);
  assert.throws(() => extractJson("<html>", "a"), /not JSON/);
  assert.deepEqual(parseJsonPath("data.items[0].price"), [{ key: "data" }, { key: "items" }, { index: 0 }, { key: "price" }]);
});

test("RSS, Atom and RDF feeds parse into stable title — link lines", () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Blog</title>
    <item><title>Second  post</title><link>https://b.example/2</link><guid>id-2</guid></item>
    <item><title>First post</title><link>https://b.example/1</link></item>
    </channel></rss>`;
  const entries = parseFeed(rss);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { id: "id-2", title: "Second post", link: "https://b.example/2" });
  assert.equal(entries[1].id, "https://b.example/1");
  assert.equal(feedValue(entries), "Second post — https://b.example/2\nFirst post — https://b.example/1");
  assert.equal(parseFeed(rss, 1).length, 1);

  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>R</title>
    <entry><id>tag:github.com,2008:Repository/1/v1.2.0</id><title>v1.2.0</title>
    <link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v1.2.0"/></entry></feed>`;
  const a = parseFeed(atom);
  assert.equal(a[0].title, "v1.2.0");
  assert.equal(a[0].link, "https://github.com/o/r/releases/tag/v1.2.0");

  const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <item rdf:about="https://x/1"><title>One</title><link>https://x/1</link></item></rdf:RDF>`;
  assert.deepEqual(parseFeed(rdf)[0], { id: "https://x/1", title: "One", link: "https://x/1" });
  assert.throws(() => parseFeed("<html><body>x</body></html>"), /not an RSS or Atom feed/);
  assert.throws(() => parseFeed("not xml"), /not an RSS or Atom feed/);
});

test("diffValues shows single-line changes, page hunks and new feed entries", () => {
  assert.equal(diffValues("page", "up", "down"), "up → down");
  assert.equal(diffValues("page", "", "down"), "(empty) → down");
  const page = diffValues("page", "a\nb\nc", "a\nc\nd");
  assert.match(page, /^- b$/m);
  assert.match(page, /^\+ d$/m);
  assert.equal(diffValues("rss", "x — u1", "y — u2\nx — u1"), "+ y — u2");
  assert.equal(diffValues("rss", "x — u1\nz", "x — u1\nz"), "(no new entries)");
  const long = diffValues("page", "a", "a\n" + "ş".repeat(5000));
  assert.ok(Buffer.byteLength(long) <= 4096);
  assert.match(long, /truncated/);
  assert.doesNotMatch(long, /\uFFFD/);
  assert.equal(truncateBytes("ş".repeat(5000), 100).startsWith("ş"), true);
  assert.doesNotMatch(truncateBytes("ş".repeat(5000), 100), /\uFFFD/);
});

test("backoff doubles and caps at 24 hours", () => {
  assert.equal(backoffMs(60_000, 0), 60_000);
  assert.equal(backoffMs(60_000, 1), 120_000);
  assert.equal(backoffMs(60_000, 3), 480_000);
  assert.equal(backoffMs(60_000, 100), 24 * 3600_000);
  assert.equal(backoffMs(1_000, 100), 24 * 3600_000);
});

test("durations, names and repository sources normalize", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("90"), 90_000);
  assert.throws(() => parseDuration("0"), /at least 1s/);
  assert.throws(() => parseDuration("1w"), /invalid duration/);
  assert.equal(formatDuration(30_000), "30s");
  assert.equal(formatDuration(300_000), "5m");
  assert.equal(formatDuration(90_000), "1m30s");
  assert.equal(formatDuration(86_400_000), "1d");

  assert.equal(normalizeRepo("https://github.com/golang/go/releases"), "golang/go");
  assert.equal(normalizeRepo("github.com/golang/go.git"), "golang/go");
  assert.throws(() => normalizeRepo("not a repo"), /owner\/name/);
  assert.equal(releasesFeedUrl("golang/go"), "https://github.com/golang/go/releases.atom");
  assert.equal(inferKind("golang/go"), "release");
  assert.equal(inferKind("https://example.com/feed.xml"), "rss");
  assert.equal(inferKind("https://example.com/news"), "page");
  assert.equal(normalizeHttpUrl("example.com/x"), "https://example.com/x");
  assert.equal(normalizeHttpUrl("localhost:3000/x"), "http://localhost:3000/x");
  assert.throws(() => normalizeHttpUrl("ftp://example.com"), /http/);
  assert.equal(deriveName("release", "https://github.com/o/r/releases.atom", { mode: "text" }), "o-r-releases");
  assert.equal(deriveName("page", "https://example.com/status", { mode: "css", selector: "#state" }), "example-com-status-css-state");
});

test("splitCommand keeps quotes and Windows backslashes literal", () => {
  assert.deepEqual(splitCommand(`node "a b.mjs" --x`), ["node", "a b.mjs", "--x"]);
  assert.deepEqual(splitCommand(`C:\\tools\\mb.exe --flag`), ["C:\\tools\\mb.exe", "--flag"]);
  assert.deepEqual(splitCommand(`node -e "console.log(1)"`), ["node", "-e", "console.log(1)"]);
  assert.deepEqual(splitCommand(`node "a\\"b"`), ["node", 'a"b']);
  assert.throws(() => splitCommand(`node "unterminated`), /unterminated quote/);
});

test("state writes atomically, tolerates corruption and keeps MONAD_HOME", () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-watch-"));
  const old = process.env.MONAD_HOME;
  process.env.MONAD_HOME = dir;
  try {
    const now = Date.now();
    const watch = {
      name: "status", kind: "page", source: "https://example.com/", extract: { mode: "text" },
      condition: { op: "changed" }, everySeconds: 300, render: false, notify: false,
      cwd: dir, enabled: true, createdAt: now, updatedAt: now, nextCheckAt: now + 300_000,
      lastValue: "up", lastHash: hashValue("up"), consecutiveErrors: 0, totalFires: 0, events: [],
    };
    writeWatchFile({ version: 1, watches: [watch] });
    assert.equal(watchFile(), join(dir, "watches.json"));
    assert.equal(readWatchFile().file.watches.length, 1);
    assert.equal(readWatchFile().file.watches[0].lastValue, "up");
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
    assert.equal(publicWatch(readWatchFile().file.watches[0]).every, "5m");
    assert.equal(publicOutcome({
      name: "status", kind: "page", source: "https://example.com/", condition: { op: "changed" },
      at: now, ok: true, fired: true, changed: true, previous: "up", next: "down", diff: "up → down",
      nextCheckAt: now + 300_000, backoffMs: 0,
    }).type, "fired");

    writeFileSync(watchFile(), "{not json");
    const corrupt = readWatchFile();
    assert.equal(corrupt.file.watches.length, 0);
    assert.match(corrupt.warning, /not valid JSON/);
    assert.ok(readdirSync(dir).some((f) => f.includes(".corrupt-")));

    // Invalid entries are ignored, valid ones survive.
    writeFileSync(watchFile(), JSON.stringify({ version: 1, watches: [watch, { name: "" }] }));
    const partial = readWatchFile();
    assert.equal(partial.file.watches.length, 1);
    assert.match(partial.warning, /ignored 1 invalid/);

    // A newer version is moved aside instead of being overwritten.
    writeFileSync(watchFile(), JSON.stringify({ version: 2, watches: [] }));
    const future = readWatchFile();
    assert.equal(future.file.watches.length, 0);
    assert.match(future.warning, /unsupported shape/);
    assert.ok(readdirSync(dir).some((f) => f.includes(".corrupt-")));
  } finally {
    if (old === undefined) delete process.env.MONAD_HOME;
    else process.env.MONAD_HOME = old;
  }
});

test("state file is valid JSON with a stable version", () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-watch-json-"));
  const old = process.env.MONAD_HOME;
  process.env.MONAD_HOME = dir;
  try {
    writeWatchFile({ version: 1, watches: [] });
    const parsed = JSON.parse(readFileSync(watchFile(), "utf8"));
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.watches, []);
  } finally {
    if (old === undefined) delete process.env.MONAD_HOME;
    else process.env.MONAD_HOME = old;
  }
});

test("mutateWatchFile serializes concurrent writers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-watch-lock-"));
  const old = process.env.MONAD_HOME;
  process.env.MONAD_HOME = dir;
  try {
    const add = (name) => mutateWatchFile((file) => {
      file.watches.push({ name, kind: "page", source: "https://example.com/", extract: { mode: "text" }, condition: { op: "changed" }, everySeconds: 300 });
    });
    await Promise.all([add("a"), add("b"), add("c")]);
    assert.deepEqual(readWatchFile().file.watches.map((w) => w.name).sort(), ["a", "b", "c"]);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".lock")).length, 0);
  } finally {
    if (old === undefined) delete process.env.MONAD_HOME;
    else process.env.MONAD_HOME = old;
  }
});
