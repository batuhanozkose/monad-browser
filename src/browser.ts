// Browser session: one CDP connection, a current tab, refs, and the action primitives.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CDP } from "./cdp.js";
import { launchChrome, resolveCdpEndpoint, cleanupProfile, killChrome, type LaunchedChrome } from "./chrome.js";
import { renderDiff, treeChange, matchGlob, type TreeChange } from "./diff.js";
import { takeSnapshot, newRefTable, elKey, DEFAULT_MAX_LINES, type El, type RefTable, type SnapshotOptions } from "./snapshot.js";
import { KEYS, modifierBit } from "./keys.js";
import { VERSION } from "./version.js";

/**
 * Does `code` parse when wrapped this way? `new Function` only compiles — it is never
 * called — and it runs here in the daemon rather than in the page, so page CSP does not
 * apply. The parser is the same one the page will use.
 */
function parsesAs(code: string, wrap: (s: string) => string): boolean {
  if (!code) return false;
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return ${wrap(code)}`);
    return true;
  } catch {
    return false;
  }
}

/** A single expression, e.g. `[1,2].map(function(n){return n*2})`. */
const isExpression = (code: string) => parsesAs(code, (s) => `(${s}\n)`);

/** An expression using top-level `await`, which only parses inside an async function. */
const isAsyncExpression = (code: string) => parsesAs(code, (s) => `(async () => (${s}\n))`);

export type BrowserOptions = {
  cdpEndpoint?: string; executable?: string; userDataDir?: string; headful?: boolean;
  block?: string[]; // resource types to block: image, font, media, stylesheet
  proxy?: string;
  headers?: Record<string, string>; // extra HTTP headers for every request
  userAgent?: string;
  ignoreHttpsErrors?: boolean;
  initScripts?: string[]; // page JS run before the first navigation, on every document
  downloadPath?: string; // default directory for `download`
  colorScheme?: "dark" | "light" | "no-preference";
  viewport?: { width: number; height: number; scale?: number };
  autoDialog?: boolean; // accept alert/confirm/prompt automatically (default true)
  extraArgs?: string[];
};

/** A searchable document: a session, plus a frameId for same-process child frames, plus its <iframe> owner chain. */
type DocRef = { sid: string; frameId?: string; owner?: El };

/** One request seen by Network.*; kept compact because `network requests` is a debugging surface. */
export type NetRequest = {
  id: string; url: string; method: string; type: string; ts: number;
  status?: number; mime?: string; size?: number; failed?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
};

/** A Fetch-domain route: abort or fulfill matching requests. */
export type Route = {
  pattern: string; abort?: boolean; body?: string; status?: number;
  contentType?: string; resourceTypes?: string[];
};

type Tab = {
  targetId: string; sessionId: string; refs: RefTable; inflight: Map<string, number>; lastNet: number; url: string; title: string;
  mainFrame?: string; navAt: number; loadAt: number; fullLoadAt: number;
  oopifs: Map<string, string>; // out-of-process iframe frameId → its CDP session
  last?: { key: string; lines: string[]; rev: number };
  rev: number; // snapshot revision for this tab
  lastShotHash?: string;
  requests: Map<string, NetRequest>;
  routes: Route[];
  fetchEnabled: boolean; // Fetch domain is enabled only while block types or routes exist
  storageScripts: string[]; // Page.addScriptToEvaluateOnNewDocument ids from state load, so a reload can replace them
  cache?: { at: number; version: string; sig: string; text: string }; // last snapshot + the page version it was taken at
};

const RESOURCE_TYPES: Record<string, string> = { image: "Image", font: "Font", media: "Media", stylesheet: "Stylesheet", css: "Stylesheet" };

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const PIXEL_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36";

/** A small, dependency-free device table for screenshots and responsive checks. */
const DEVICES: Record<string, { width: number; height: number; scale: number; mobile: boolean; userAgent?: string }> = {
  desktop: { width: 1280, height: 800, scale: 1, mobile: false },
  "iphone 15": { width: 393, height: 852, scale: 3, mobile: true, userAgent: IPHONE_UA },
  "iphone se": { width: 375, height: 667, scale: 2, mobile: true, userAgent: IPHONE_UA },
  "pixel 7": { width: 412, height: 915, scale: 2.625, mobile: true, userAgent: PIXEL_UA },
  ipad: { width: 820, height: 1180, scale: 2, mobile: true, userAgent: IPHONE_UA },
};

const STALE_MS = 2000;
const DOM_TYPES = new Set(["Document", "Script", "XHR", "Fetch", "Stylesheet"]);

const normText = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** 0 = disabled. Set MONAD_SNAPSHOT_CACHE_MS or pass `snapshot --cache-ms N` to reuse a recent snapshot. */
const snapshotCacheMs = () => { const n = Number(process.env.MONAD_SNAPSHOT_CACHE_MS ?? 0); return Number.isFinite(n) && n > 0 ? n : 0; };

/** Blank out string literals and comments so keyword probes don't fire inside them. */
const stripLiterals = (s: string) => s
  .replace(/`(?:\\.|[^`\\])*`/g, "``")
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ");

export class Browser {
  cdp!: CDP;
  private chrome?: LaunchedChrome;
  private tabs = new Map<string, Tab>();
  current?: Tab;
  private blockTypes: string[] = [];
  private dialogs: string[] = [];
  pendingDialog?: { type: string; message: string; defaultPrompt?: string; sessionId: string };
  private mouseAt = { x: 0, y: 0 };
  private traceActive = false;
  /** Path given to `network har start`, reused by `network har stop` when it has none. */
  harPath?: string;
  console: string[] = [];
  actionTimeout = Number(process.env.MONAD_ACTION_TIMEOUT ?? 5000);

  constructor(private opts: BrowserOptions = {}) {}

  get defaultDownloadPath() { return this.opts.downloadPath; }
  cdpUrl() { return this.chrome?.wsUrl ?? this.opts.cdpEndpoint ?? ""; }
  lastSnapshotMeta() { const last = this.tab().last; return last ? { lines: last.lines, key: last.key, rev: last.rev } : undefined; }

  async start() {
    let ws: string;
    if (this.opts.cdpEndpoint) ws = await resolveCdpEndpoint(this.opts.cdpEndpoint);
    else {
      this.chrome = await launchChrome({
        executable: this.opts.executable, userDataDir: this.opts.userDataDir, headful: this.opts.headful,
        proxy: this.opts.proxy, extraArgs: this.opts.extraArgs,
      });
      ws = this.chrome.wsUrl;
    }
    this.cdp = await CDP.connect(ws);
    this.setBlock(this.opts.block ?? []);
    if (this.opts.downloadPath)
      await this.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: this.opts.downloadPath, eventsEnabled: true }).catch(() => {});
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    this.cdp.on("Target.targetDestroyed", ({ targetId }) => {
      this.tabs.delete(targetId);
      if (this.current?.targetId === targetId) this.current = [...this.tabs.values()].at(-1);
    });
    this.cdp.on("Target.targetInfoChanged", ({ targetInfo }) => {
      const t = this.tabs.get(targetInfo.targetId);
      if (t) { t.url = targetInfo.url; t.title = targetInfo.title; }
    });
    // Popups / new tabs opened by the page become current automatically.
    this.cdp.on("Target.targetCreated", async ({ targetInfo }) => {
      if (targetInfo.type === "page" && targetInfo.openerId && !this.tabs.has(targetInfo.targetId)) {
        try { this.current = await this.attach(targetInfo.targetId); } catch { /* raced with close */ }
      }
    });
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    const page = targetInfos.find((t: any) => t.type === "page" && !t.url.startsWith("devtools://"));
    this.current = page ? await this.attach(page.targetId) : await this.newTab();
  }

  setBlock(types: string[]) {
    this.blockTypes = types.map((t) => RESOURCE_TYPES[t.toLowerCase()] ?? t).filter(Boolean);
  }

  /** Fetch domain only when needed: resource blocking and/or a network route. Otherwise requests never pause. */
  private fetchPatterns(tab: Tab) {
    const patterns: any[] = this.blockTypes.map((resourceType) => ({ resourceType, requestStage: "Request" }));
    for (const r of tab.routes) patterns.push({ urlPattern: r.pattern || "*", requestStage: "Request" });
    return patterns;
  }

  private async refreshFetch(tab: Tab) {
    const patterns = this.fetchPatterns(tab);
    if (patterns.length) {
      await this.cdp.send("Fetch.enable", { patterns }, tab.sessionId).catch(() => {});
      tab.fetchEnabled = true;
    } else if (tab.fetchEnabled) {
      await this.cdp.send("Fetch.disable", {}, tab.sessionId).catch(() => {});
      tab.fetchEnabled = false;
    }
  }

  private async attach(targetId: string): Promise<Tab> {
    const existing = this.tabs.get(targetId);
    if (existing) return existing;
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const tab: Tab = {
      targetId, sessionId, refs: newRefTable(), inflight: new Map(), lastNet: Date.now(), url: "", title: "",
      navAt: 0, loadAt: 0, fullLoadAt: 0, oopifs: new Map(), rev: 0, requests: new Map(), routes: [], fetchEnabled: false, storageScripts: [],
    };
    this.tabs.set(targetId, tab);
    const s = sessionId;
    const on = (ev: string, fn: (p: any) => void) => this.cdp.on(ev, (p, sid) => { if (sid === s) fn(p); });
    on("Network.requestWillBeSent", (p) => {
      const now = Date.now();
      // A new top-level document cancels the old page's loads; their loadingFinished/Failed may never arrive.
      if (p.type === "Document" && p.requestId === p.loaderId && !p.redirectResponse && (!tab.mainFrame || p.frameId === tab.mainFrame)) tab.inflight.clear();
      // Only loads that can still change the DOM gate settling; images, fonts, media and beacons do not.
      if (DOM_TYPES.has(p.type)) tab.inflight.set(p.requestId, now);
      if (DOM_TYPES.has(p.type)) tab.lastNet = now;
      tab.requests.set(p.requestId, {
        id: p.requestId, url: p.request.url, method: p.request.method, type: p.type, ts: now,
        requestHeaders: p.request.headers,
      });
      if (tab.requests.size > 500) { const oldest = tab.requests.keys().next().value; if (oldest) tab.requests.delete(oldest); }
    });
    on("Network.responseReceived", (p) => {
      const r = tab.requests.get(p.requestId);
      if (r) { r.status = p.response.status; r.mime = p.response.mimeType; r.responseHeaders = p.response.headers; }
    });
    const done = (p: any) => {
      if (tab.inflight.delete(p.requestId)) tab.lastNet = Date.now();
      const r = tab.requests.get(p.requestId);
      if (r && typeof p.encodedDataLength === "number") r.size = p.encodedDataLength;
    };
    on("Network.loadingFinished", done);
    on("Network.loadingFailed", (p) => {
      done(p);
      const r = tab.requests.get(p.requestId);
      if (r) r.failed = p.errorText ?? "failed";
    });
    on("Page.frameNavigated", (p) => { if (!p.frame.parentId) { tab.url = p.frame.url; tab.mainFrame = p.frame.id; } });
    on("Page.frameRequestedNavigation", (p) => { if (!tab.mainFrame || p.frameId === tab.mainFrame) tab.navAt = Date.now(); });
    on("Page.frameStartedLoading", (p) => { if (!tab.mainFrame || p.frameId === tab.mainFrame) tab.navAt = Date.now(); });
    // Ready = DOM parsed (DOMContentLoaded) plus a quiet window for scripts/XHR; images and fonts are not waited for.
    on("Page.lifecycleEvent", (p) => {
      if (tab.mainFrame && p.frameId !== tab.mainFrame) return;
      if (p.name === "DOMContentLoaded") tab.loadAt = Date.now();
      else if (p.name === "load") tab.fullLoadAt = Date.now();
    });
    on("Page.navigatedWithinDocument", (p) => { if (!tab.mainFrame || p.frameId === tab.mainFrame) tab.url = p.url; });
    on("Page.javascriptDialogOpening", async (p) => {
      // Never let a dialog wedge the agent: accept by default (prompt gets its default text).
      // `--no-auto-dialog` leaves it open so the agent can inspect and answer it.
      if (this.opts.autoDialog === false) {
        this.pendingDialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt, sessionId: s };
        return;
      }
      this.dialogs.push(`${p.type}: ${p.message}`);
      try { await this.cdp.send("Page.handleJavaScriptDialog", { accept: true, promptText: p.defaultPrompt ?? "" }, s); } catch { /* gone */ }
    });
    on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error" || p.type === "warning") {
        const msg = (p.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ");
        this.console.push(`${p.type}: ${msg}`.slice(0, 300));
        if (this.console.length > 50) this.console.shift();
      }
    });
    on("Runtime.exceptionThrown", (p) => { this.console.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`.slice(0, 300)); });
    on("Fetch.requestPaused", (p) => {
      const route = [...tab.routes].reverse().find((r) =>
        matchGlob(p.request.url, r.pattern) && (!r.resourceTypes?.length || r.resourceTypes.includes(p.resourceType)));
      if (route?.abort) {
        this.cdp.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Aborted" }, s).catch(() => {});
        return;
      }
      if (route && route.body !== undefined) {
        this.cdp.send("Fetch.fulfillRequest", {
          requestId: p.requestId,
          responseCode: route.status ?? 200,
          responseHeaders: [{ name: "Content-Type", value: route.contentType ?? "application/json" }],
          body: Buffer.from(route.body, "utf8").toString("base64"),
        }, s).catch(() => {});
        return;
      }
      const block = this.blockTypes.includes(p.resourceType);
      const cmd = block ? this.cdp.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, s)
                        : this.cdp.send("Fetch.continueRequest", { requestId: p.requestId }, s);
      cmd.catch(() => {});
    });
    this.watchFrames(tab, s);
    await Promise.all([
      this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, s).catch(() => {}),
      this.cdp.send("Page.enable", {}, s),
      this.cdp.send("Runtime.enable", {}, s),
      this.cdp.send("Network.enable", {}, s),
      this.cdp.send("DOM.enable", {}, s),
      this.cdp.send("Accessibility.enable", {}, s),
      this.cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, s),
      this.refreshFetch(tab),
    ]);
    await this.cdp.send("Runtime.runIfWaitingForDebugger", {}, s).catch(() => {});
    const { targetInfo } = await this.cdp.send("Target.getTargetInfo", { targetId });
    tab.url = targetInfo.url; tab.title = targetInfo.title;
    await this.applyTabOptions(tab);
    return tab;
  }

  /** Apply session-wide options that CDP scopes to one page session. */
  private async applyTabOptions(tab: Tab) {
    const s = tab.sessionId;
    if (this.opts.headers && Object.keys(this.opts.headers).length)
      await this.cdp.send("Network.setExtraHTTPHeaders", { headers: this.opts.headers }, s).catch(() => {});
    if (this.opts.userAgent)
      await this.cdp.send("Network.setUserAgentOverride", { userAgent: this.opts.userAgent }, s).catch(() => {});
    if (this.opts.ignoreHttpsErrors)
      await this.cdp.send("Security.setIgnoreCertificateErrors", { ignore: true }, s).catch(() => {});
    if (this.opts.colorScheme && this.opts.colorScheme !== "no-preference")
      await this.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: this.opts.colorScheme }] }, s).catch(() => {});
    if (this.opts.viewport) {
      // `setViewport` targets the current tab; during attach the new tab is not current yet.
      await this.cdp.send("Emulation.setDeviceMetricsOverride", {
        width: this.opts.viewport.width, height: this.opts.viewport.height,
        deviceScaleFactor: this.opts.viewport.scale ?? 1, mobile: false,
      }, s).catch(() => {});
    }
    for (const file of this.opts.initScripts ?? []) {
      try {
        const { readFileSync } = await import("node:fs");
        await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(file, "utf8") }, s);
      } catch { /* missing init script is reported by the launcher, not fatal here */ }
    }
  }

  /** Cross-origin iframes live in their own renderer: attach to each (recursively) so snapshots and refs reach inside. */
  private watchFrames(tab: Tab, parentSid: string) {
    this.cdp.on("Target.attachedToTarget", async (p, sid) => {
      if (sid !== parentSid || p.targetInfo?.type !== "iframe") return;
      const child = p.sessionId as string;
      tab.oopifs.set(p.targetInfo.targetId, child);
      this.watchFrames(tab, child);
      await Promise.all([
        this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child),
        this.cdp.send("DOM.enable", {}, child),
        this.cdp.send("Accessibility.enable", {}, child),
        this.cdp.send("Page.enable", {}, child),
      ]).catch(() => {});
      this.cdp.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
    });
    this.cdp.on("Target.detachedFromTarget", (p, sid) => {
      if (sid !== parentSid) return;
      for (const [f, c] of tab.oopifs) if (c === p.sessionId) tab.oopifs.delete(f);
    });
  }

  async newTab(url = "about:blank"): Promise<Tab> {
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
    this.current = await this.attach(targetId);
    if (url !== "about:blank") await this.goto(url);
    return this.current;
  }

  private tab(): Tab {
    if (!this.current) throw new Error("No open tab");
    return this.current;
  }
  send<T = any>(method: string, params: object = {}) { return this.cdp.send<T>(method, params, this.tab().sessionId); }

  /** Wait until no tracked requests are in flight for `idleMs`, capped at `timeoutMs`. */
  /** After DOMContentLoaded: done at the load event or at 50 ms of script/XHR quiet, whichever comes first (cap 1 s). */
  private async pageReady(navStart: number) {
    const tab = this.tab();
    const end = Date.now() + 1000;
    while (Date.now() < end) {
      if (tab.fullLoadAt >= navStart) return;
      if (await this.networkIdle(50, 0)) return;
      await sleep(10);
    }
  }

  async networkIdle(idleMs = 400, timeoutMs = 5000, since = 0) {
    const tab = this.tab();
    const end = Date.now() + timeoutMs;
    while (true) {
      // Requests pending for > STALE_MS are long-polls, beacons or leaked ids: they never block settling.
      const now = Date.now();
      let active = 0;
      for (const [id, t] of tab.inflight) { if (now - t > 30_000) tab.inflight.delete(id); else if (now - t < STALE_MS) active++; }
      // Traffic that predates the action (since) needs no quiet window of its own.
      if (active === 0 && (tab.lastNet < since || now - tab.lastNet >= idleMs)) return true;
      if (now >= end) return false;
      await sleep(15);
    }
  }

  async goto(url: string, opts: { timeoutMs?: number } = {}) {
    if (!/^([a-z][a-z0-9+.-]*:\/\/|about:|data:|file:|javascript:|blob:)/i.test(url)) url = (/^(localhost|127\.|\[::1\])/.test(url) ? "http://" : "https://") + url;
    const tab = this.tab();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const since = Date.now();
    const res = await this.send("Page.navigate", { url });
    if (res.errorText) throw new Error(`navigation failed: ${res.errorText} (${url})`);
    const end = since + timeoutMs;
    while (res.loaderId && tab.loadAt < since && Date.now() < end) await sleep(10);
    await this.pageReady(since);
    tab.refs = newRefTable(); tab.last = undefined;
    return this.info();
  }

  async info() {
    // A renderer paused on alert/confirm/prompt cannot evaluate JS; the event-maintained
    // tab fields are still current, so callers (click, wait, snapshots) do not block.
    if (this.pendingDialog) return { url: this.tab().url, title: this.tab().title };
    const r = await this.evaluate("({url: location.href, title: document.title})");
    return r as { url: string; title: string };
  }

  async evaluate(expression: string, awaitPromise = true) {
    // Is this a single expression or a statement list? Ask the parser, not a regex.
    // A `/return/` test cannot tell a top-level `return` (which needs a function body)
    // from one inside a nested callback (which is just part of an expression), and
    // misreading the second case wraps the expression in a body: the value is
    // discarded, the call still succeeds, and the caller gets `undefined`.
    // The keyword probes for the fallback run on a copy with strings/comments stripped.
    const code = expression.trim();
    const bare = stripLiterals(code);
    const src = isExpression(code)
      ? code
      : isAsyncExpression(code) ? `(async () => (${code.replace(/;\s*$/, "")}))()`
      : /\bawait\b/.test(bare) || /\breturn\b/.test(bare) ? `(async () => { ${code} })()`
      : code; // a statement list: leave it be so the console-style completion value survives
    const r: any = await this.send("Runtime.evaluate", { expression: src, awaitPromise, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }

  /** Cookies (all origins) + localStorage/sessionStorage of the current origin, as JSON. */
  async saveState() {
    const { cookies } = await this.send("Network.getAllCookies", {});
    const storage = await this.evaluate(`({ origin: location.origin, local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)) })`).catch(() => null);
    return { version: 1, savedAt: new Date().toISOString(), cookies, origins: storage && storage.origin !== "null" ? [storage] : [] };
  }

  /** Restore saved state: cookies now; storage for each origin is written when that origin is open (and right now if it is). */
  async loadState(state: { cookies?: any[]; origins?: { origin: string; local?: Record<string, string>; session?: Record<string, string> }[] }) {
    if (state.cookies?.length) {
      const cookies = state.cookies.map(({ size, session, ...c }: any) => (session || c.expires < 0 ? { ...c, expires: undefined } : c));
      await this.send("Network.setCookies", { cookies });
    }
    const tab = this.tab();
    // A second state load must replace the first, not stack another set of new-document scripts on the tab.
    for (const id of tab.storageScripts) await this.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: id }, tab.sessionId).catch(() => {});
    tab.storageScripts = [];
    let applied = 0;
    for (const o of state.origins ?? []) {
      const js = `(() => { if (location.origin !== ${JSON.stringify(o.origin)}) return false; for (const [k, v] of Object.entries(${JSON.stringify(o.local ?? {})})) localStorage.setItem(k, v); for (const [k, v] of Object.entries(${JSON.stringify(o.session ?? {})})) sessionStorage.setItem(k, v); return true; })()`;
      const added: any = await this.send("Page.addScriptToEvaluateOnNewDocument", { source: js }).catch(() => null);
      if (added?.identifier) tab.storageScripts.push(added.identifier);
      const r: any = await this.send("Runtime.evaluate", { expression: js, returnByValue: true }).catch(() => null);
      if (r?.result?.value === true) applied++;
    }
    return { cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0, applied };
  }

  /**
   * Snapshot; with `diff`, only lines that changed since this tab's previous snapshot of the same
   * page and option set. `full` forces a full snapshot and resets the baseline; `json` returns the
   * compact machine-applicable form (`full` | `unchanged` | `delta` + revision).
   */
  async snapshot(opts: SnapshotOptions & { diff?: boolean; full?: boolean; json?: boolean; cacheMs?: number } = {}) {
    const tab = this.tab();
    if (this.pendingDialog) return `dialog pending: ${this.pendingDialog.type}: ${this.pendingDialog.message} — use mb dialog accept|dismiss`;
    const ttl = opts.diff || opts.json || opts.full ? 0 : opts.cacheMs ?? snapshotCacheMs();
    const sig = JSON.stringify([!!opts.interactive, opts.maxText ?? 80, opts.maxLines ?? DEFAULT_MAX_LINES, opts.compact ?? null, opts.maxInline ?? null, opts.maxProse ?? null]);
    // Serve the last snapshot when the page version is unchanged; the MutationObserver has already seen
    // every prior mutation by the time this command runs, so an unchanged version means an unchanged page.
    if (ttl > 0 && tab.cache && tab.cache.sig === sig && !this.dialogs.length && Date.now() - tab.cache.at < ttl) {
      const version = await this.docVersion();
      if (version !== undefined && version === tab.cache.version) return tab.cache.text;
    }
    const res = await takeSnapshot(this.cdp, tab.sessionId, tab.refs, opts, tab.oopifs);
    const { url, title } = await this.info();
    const extra: string[] = [];
    if (this.dialogs.length) extra.push(`dialogs: ${this.dialogs.splice(0).join(" | ")}`);
    const head = `# ${title} — ${url}\n${extra.length ? extra.join("\n") + "\n" : ""}`;
    // Every option that changes the rendered tree belongs in the key: a snapshot taken with
    // --max-text 20 is not a baseline for one taken with the default.
    const key = JSON.stringify([
      url, !!opts.interactive, opts.maxText ?? 80, opts.maxLines ?? DEFAULT_MAX_LINES,
      opts.compact ?? null, opts.maxInline ?? null, opts.maxProse ?? null,
    ]);
    const lines = res.text.split("\n");
    const prev = !opts.full && tab.last?.key === key ? tab.last : undefined;
    const rev = ++tab.rev;
    tab.last = { key, lines, rev };
    if (opts.diff && prev) {
      const d = renderDiff(prev.lines, lines);
      if (!d.added && !d.removed) {
        if (opts.json) return JSON.stringify({ kind: "unchanged", revision: rev });
        return `unchanged rev ${rev}${extra.length ? `\n${extra.join("\n")}` : ""}`;
      }
      if (d.text.length < res.text.length * 0.7) {
        if (opts.json) {
          const change: TreeChange = treeChange(prev.lines, lines);
          const delta = JSON.stringify({ kind: "delta", baseRevision: prev.rev, revision: rev, treeChange: change });
          // The splice is contiguous, so two distant edits can be much larger than the Myers
          // text diff. Fall back to a full tree when the patch would not save space.
          if (delta.length < res.text.length * 0.7) return delta;
        } else {
          return `${head}(diff rev ${prev.rev}→${rev}: +${d.added} -${d.removed}, ${d.same} unchanged)\n${d.text}`;
        }
      }
    }
    if (opts.json) return JSON.stringify({ kind: "full", revision: rev, tree: res.text });
    const out = head + res.text;
    if (ttl > 0) {
      const version = await this.docVersion();
      if (version !== undefined) tab.cache = { at: Date.now(), version, sig, text: out };
    }
    return out;
  }

  /** Raw snapshot text with no header or diff bookkeeping (used by `diff url` and baseline diffs). */
  async snapshotText(opts: SnapshotOptions = {}): Promise<string> {
    const tab = this.tab();
    return (await takeSnapshot(this.cdp, tab.sessionId, tab.refs, opts, tab.oopifs)).text;
  }

  /** Cheap page fingerprint: the URL plus a MutationObserver counter installed once per document. */
  private async docVersion(): Promise<string | undefined> {
    try {
      const v = await this.evaluate(`
        if (!window.__monadObs) {
          const o = { n: 0, id: Math.random().toString(36).slice(2), mo: new MutationObserver(() => { o.n++; }) };
          o.mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          window.__monadObs = o;
        }
        // id is fresh per document, so a reload of the same URL is never mistaken for the cached one.
        return location.href + "|" + window.__monadObs.id + "|" + window.__monadObs.n;
      `);
      return typeof v === "string" ? v : undefined;
    } catch { return undefined; }
  }

  /**
   * Resolve a target to a backendNodeId. Accepts `@N` refs, `text=Label`, `role=button[:name]`, or CSS.
   * Refs self-heal: if the ref'd node was re-rendered, it is re-found by its role + accessible name.
   */
  async resolve(target: string, verify = true): Promise<El> {
    const tab = this.tab();
    const top = (bid: number): El => ({ sid: tab.sessionId, bid });
    const t = target.trim();
    const m = /^@?e?(\d+)$/.exec(t);
    if (m) {
      const n = Number(m[1]);
      const ref = tab.refs.byRef.get(n);
      if (!ref) throw new Error(`unknown ref @${n} — take a fresh snapshot`);
      if (!verify || await this.isAttached(ref.el)) return ref.el;
      // Self-heal by role + name (top document only).
      let healed = ref.name && !ref.el.owner ? await this.queryAX(ref.name, ref.role === "clickable" ? undefined : ref.role) : [];
      // Hydration often upgrades a text field's role (searchbox → combobox): try its siblings in the family.
      const TEXT_ROLES = ["textbox", "searchbox", "combobox"];
      if (!healed.length && ref.name && !ref.el.owner && TEXT_ROLES.includes(ref.role))
        for (const r of TEXT_ROLES) if (r !== ref.role && (healed = await this.queryAX(ref.name, r)).length) break;
      // One match: that is it. Several (a re-render can duplicate names): the same position among them as at snapshot time.
      const pick = healed.length === 1 ? healed[0] : healed.length > 1 ? healed[Math.min(ref.ord ?? 0, healed.length - 1)] : undefined;
      if (pick !== undefined) {
        tab.refs.byBackend.delete(elKey(ref.el));
        ref.el = top(pick);
        tab.refs.byBackend.set(elKey(ref.el), n);
        return ref.el;
      }
      throw new Error(`@${n} (${ref.role} "${ref.name}") is gone from the page — take a fresh snapshot`);
    }
    // Name/role/CSS targets search the top document first (the common case, no frame discovery),
    // then every same-process and out-of-process frame.
    const topDoc: DocRef = { sid: tab.sessionId };
    const loc = /^(label|placeholder|alt|title|testid|nth)=([\s\S]+)$/.exec(t);
    if (loc) {
      const hit = await this.findByLocator(loc[1], loc[2], topDoc);
      if (!hit) throw new Error(`no element matches ${loc[1]}=${loc[2]}`);
      return hit;
    }
    if (t.startsWith("text~=")) {
      const name = t.slice(6);
      const hit = await this.findInFrames(name, undefined, topDoc, true);
      if (!hit) throw new Error(`no element containing "${name}"`);
      return hit;
    }
    if (t.startsWith("text=")) {
      const name = t.slice(5);
      const hit = await this.findInFrames(name, undefined, topDoc);
      if (!hit) throw new Error(`no element named "${name}"`);
      return hit;
    }
    const rm = /^role=([\w-]+)(?::(.+))?$/.exec(t);
    if (rm) {
      const hit = await this.findInFrames(rm[2], rm[1], topDoc);
      if (!hit) throw new Error(`no ${rm[1]}${rm[2] ? ` named "${rm[2]}"` : ""}`);
      return hit;
    }
    const topBid = await this.queryCss(t, topDoc);
    if (topBid !== undefined) return top(topBid);
    for (const d of await this.frameDocs()) {
      if (d.sid === tab.sessionId && d.frameId === undefined) continue; // top already tried
      const bid = await this.queryCss(t, d);
      if (bid !== undefined) return this.elFor(bid, d);
    }
    throw new Error(`no element matches selector: ${t}`);
  }

  private elFor(bid: number, d: DocRef): El { return { sid: d.sid, bid, owner: d.owner }; }

  /** Query the top document, then fall back to every frame document. */
  private async findInFrames(name: string | undefined, role: string | undefined, topDoc: DocRef, fuzzy = false): Promise<El | undefined> {
    const topIds = await this.queryAX(name, role, topDoc, fuzzy);
    if (topIds.length) return this.elFor(topIds[0], topDoc);
    for (const d of await this.frameDocs()) {
      if (d.sid === topDoc.sid && d.frameId === undefined) continue; // already tried
      const ids = await this.queryAX(name, role, d, fuzzy);
      if (ids.length) return this.elFor(ids[0], d);
    }
    return undefined;
  }

  /** `label=`, `placeholder=`, `alt=`, `title=`, `testid=` and `nth=N:selector` targets, across frames. */
  private async findByLocator(kind: string, value: string, topDoc: DocRef): Promise<El | undefined> {
    let expr: string;
    if (kind === "nth") {
      const m = /^(-?\d+):([\s\S]+)$/.exec(value);
      if (!m) throw new Error(`usage: nth=<index>:<css selector>`);
      const n = Number(m[1]);
      const index = n < 0 ? `a.length + (${n})` : String(n);
      expr = `(() => { const a = document.querySelectorAll(${JSON.stringify(m[2])}); return a[${index}] ?? null; })()`;
    } else if (kind === "label") {
      expr = `(() => {
        const v = ${JSON.stringify(value)};
        const norm = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim();
        const all = [...document.querySelectorAll('label')];
        const hit = all.find(e => norm(e) === v) || all.find(e => norm(e).includes(v));
        if (!hit) return null;
        if (hit.control) return hit.control;
        if (hit.htmlFor) return document.getElementById(hit.htmlFor) || hit;
        return hit.querySelector('input,select,textarea,button') || hit;
      })()`;
    } else {
      const attr = kind === "testid" ? "data-testid" : kind;
      expr = `(() => {
        const v = ${JSON.stringify(value)};
        const all = [...document.querySelectorAll(${JSON.stringify("[" + attr + "]")})];
        const hit = all.find(e => e.getAttribute(${JSON.stringify(attr)}) === v) || all.find(e => (e.getAttribute(${JSON.stringify(attr)}) || '').includes(v));
        if (!hit) return null;
        return hit;
      })()`;
    }
    const docs = [topDoc, ...(await this.frameDocs())];
    for (const d of docs) {
      if (d.sid === topDoc.sid && d.frameId === undefined && d !== topDoc) continue;
      const bid = await this.queryExpr(expr, d);
      if (bid !== undefined) return this.elFor(bid, d);
    }
    return undefined;
  }

  /**
   * Every document a target can live in: the top document, same-process child frames (a `frameId` within
   * the tab session), and out-of-process frames (their own session). Each carries the `<iframe>` owner chain
   * so clicks and fills inside a frame land at the right page coordinates.
   */
  private async frameDocs(): Promise<DocRef[]> {
    const tab = this.tab();
    const mainSid = tab.sessionId;
    const docs: DocRef[] = [{ sid: mainSid }];
    const sessionOwner = new Map<string, El | undefined>([[mainSid, undefined]]);
    const seenFrames = new Set<string>();
    const visit = async (sid: string, tree: any, owner: El | undefined, depth: number) => {
      if (depth > 4) return;
      for (const child of tree?.childFrames ?? []) {
        const fid = child.frame.id as string;
        if (seenFrames.has(fid)) continue;
        seenFrames.add(fid);
        let bid = 0;
        try { ({ backendNodeId: bid } = await this.cdp.send<any>("DOM.getFrameOwner", { frameId: fid }, sid)); } catch { /* detached mid-resolve */ }
        const childOwner: El = { sid, bid, owner };
        const oopSid = tab.oopifs.get(fid);
        if (oopSid) {
          sessionOwner.set(oopSid, childOwner);
          docs.push({ sid: oopSid, owner: childOwner });
          const t = await this.cdp.send<any>("Page.getFrameTree", {}, oopSid).catch(() => null);
          await visit(oopSid, t?.frameTree, childOwner, depth + 1);
        } else {
          docs.push({ sid, frameId: fid, owner: childOwner });
          await visit(sid, child, childOwner, depth + 1);
        }
      }
    };
    const mainTree = await this.cdp.send<any>("Page.getFrameTree", {}, mainSid).catch(() => null);
    await visit(mainSid, mainTree?.frameTree, undefined, 0);
    // Cross-origin frames are sometimes absent from their parent's frame tree: locate the hosting <iframe>
    // in whichever session can resolve it (same trick the snapshot uses).
    for (const [fid, oopSid] of tab.oopifs) {
      if (seenFrames.has(fid)) continue;
      seenFrames.add(fid);
      let hostSid: string | undefined;
      let bid = 0;
      for (const cand of [mainSid, ...sessionOwner.keys()]) {
        try { const r = await this.cdp.send<any>("DOM.getFrameOwner", { frameId: fid }, cand); if (r?.backendNodeId) { hostSid = cand; bid = r.backendNodeId; break; } } catch { /* not in this session */ }
      }
      const owner: El | undefined = hostSid ? { sid: hostSid, bid, owner: sessionOwner.get(hostSid) } : undefined;
      sessionOwner.set(oopSid, owner);
      docs.push({ sid: oopSid, owner });
      const t = await this.cdp.send<any>("Page.getFrameTree", {}, oopSid).catch(() => null);
      await visit(oopSid, t?.frameTree, owner, 1);
    }
    return docs;
  }

  private async isAttached(el: El) {
    try {
      const { object } = await this.cdp.send("DOM.resolveNode", { backendNodeId: el.bid }, el.sid);
      if (!object?.objectId) return false;
      const r: any = await this.cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){return this.isConnected}", returnByValue: true }, el.sid);
      this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, el.sid).catch(() => {});
      return r.result?.value === true;
    } catch { return false; }
  }

  /** Accessible-name (+ role) lookup in one document, visible nodes first. `fuzzy` matches substrings. */
  private async queryAX(name?: string, role?: string, doc: DocRef = { sid: this.tab().sessionId }, fuzzy = false): Promise<number[]> {
    let nodes: any[];
    if (doc.frameId || fuzzy) {
      // queryAXTree cannot be scoped to a frame; getFullAXTree can, so fetch and filter locally.
      const r = await this.cdp.send<any>("Accessibility.getFullAXTree", doc.frameId ? { frameId: doc.frameId } : {}, doc.sid);
      const want = name === undefined ? undefined : normText(name);
      nodes = (r.nodes ?? []).filter((n: any) => {
        const got = normText(n.name?.value);
        return (role === undefined || (n.role?.value ?? "").toLowerCase() === role.toLowerCase()) &&
          (want === undefined || (fuzzy ? got.toLowerCase().includes(want.toLowerCase()) : got === want));
      });
    } else {
      const params: any = {};
      const { root } = await this.cdp.send<any>("DOM.getDocument", { depth: 0 }, doc.sid);
      params.backendNodeId = root.backendNodeId;
      if (name) params.accessibleName = name;
      if (role) params.role = role;
      nodes = (await this.cdp.send<any>("Accessibility.queryAXTree", params, doc.sid)).nodes ?? [];
    }
    // AX trees contain non-element nodes (StaticText/InlineTextBox/LineBreak). They have layout quads, so the
    // visibility filter below kept them, and callOn() then acted on a Text node (no getClientRects).
    const NON_ELEMENT = new Set(["StaticText", "InlineTextBox", "LineBreak", "none", "presentation"]);
    const ids: number[] = nodes
      .filter((n: any) => !n.ignored && n.backendDOMNodeId && !NON_ELEMENT.has(n.role?.value ?? ""))
      .map((n: any) => n.backendDOMNodeId);
    const visible: number[] = [];
    for (const id of ids) { try { const { quads } = await this.cdp.send<any>("DOM.getContentQuads", { backendNodeId: id }, doc.sid); if (quads?.length) visible.push(id); } catch { /* hidden */ } }
    return visible.length ? visible : ids;
  }

  /** Evaluate an expression that returns an element, and return its backendNodeId (isolated world for frames). */
  private async queryExpr(expr: string, doc: DocRef): Promise<number | undefined> {
    let contextId: number | undefined;
    if (doc.frameId) {
      const w = await this.cdp.send<any>("Page.createIsolatedWorld", { frameId: doc.frameId, worldName: "monad-resolve" }, doc.sid).catch(() => null);
      contextId = w?.executionContextId;
      if (!contextId) return undefined;
    }
    const r: any = await this.cdp.send<any>("Runtime.evaluate", { expression: expr, contextId, returnByValue: false }, doc.sid).catch(() => null);
    const objectId = r?.result?.objectId;
    if (!objectId) return undefined;
    try {
      // describeNode takes an objectId directly and works for objects from an isolated world.
      const { node } = await this.cdp.send<any>("DOM.describeNode", { objectId }, doc.sid);
      return node?.backendNodeId;
    } catch { return undefined; }
    finally { this.cdp.send("Runtime.releaseObject", { objectId }, doc.sid).catch(() => {}); }
  }

  /** `document.querySelector` in one document, returned as a backendNodeId. */
  private queryCss(selector: string, doc: DocRef): Promise<number | undefined> {
    return this.queryExpr(`document.querySelector(${JSON.stringify(selector)})`, doc);
  }

  /**
   * Input events can block their CDP response while a JavaScript dialog is open (the renderer is
   * paused). A short timeout keeps a dialog from wedging the command; the event itself was
   * delivered, and `dialog status`/`accept` can proceed.
   */
  private async sendInput(method: string, params: any, timeoutMs = 2000) {
    try { await this.cdp.send(method, params, this.tab().sessionId, timeoutMs); }
    catch (e) {
      if (this.pendingDialog) return;
      throw e;
    }
  }

  private async objectId(el: El) {
    const { object } = await this.cdp.send("DOM.resolveNode", { backendNodeId: el.bid }, el.sid);
    if (!object?.objectId) throw new Error("element is no longer attached — take a fresh snapshot");
    return object.objectId as string;
  }

  async callOn(el: El, fn: string, args: unknown[] = []) {
    const objectId = await this.objectId(el);
    const r: any = await this.cdp.send("Runtime.callFunctionOn", {
      objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true,
    }, el.sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }

  /** Page offset of the viewport that `el`'s session reports coordinates in (non-zero only inside out-of-process iframes). */
  private async rootOffset(el: El): Promise<{ x: number; y: number }> {
    let o = el.owner;
    while (o && o.sid === el.sid) o = o.owner;
    return o ? this.contentOrigin(o) : { x: 0, y: 0 };
  }
  /** Page coordinates of an <iframe> element's content box: where its document's viewport starts. */
  private async contentOrigin(frameEl: El): Promise<{ x: number; y: number }> {
    const { model } = await this.cdp.send<any>("DOM.getBoxModel", { backendNodeId: frameEl.bid }, frameEl.sid);
    const off = await this.rootOffset(frameEl);
    return { x: model.content[0] + off.x, y: model.content[1] + off.y };
  }
  private async scrollIntoView(el: El) {
    const chain: El[] = [];
    for (let o = el.owner; o; o = o.owner) chain.unshift(o);
    for (const e of [...chain, el]) await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: e.bid }, e.sid).catch(() => {});
  }

  private async quadCenter(el: El): Promise<{ x: number; y: number } | null> {
    try {
      const box = await this.quadBox(el);
      return box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : null;
    } catch { return null; }
  }

  /** Bounding box of an element in the top document's viewport coordinates. */
  private async quadBox(el: El): Promise<{ x: number; y: number; w: number; h: number } | null> {
    try {
      const { quads } = await this.cdp.send<any>("DOM.getContentQuads", { backendNodeId: el.bid }, el.sid);
      if (!quads?.length) return null;
      // Largest quad wins (wrapped inline links have several).
      let best = quads[0], area = 0;
      for (const q of quads) { const a = Math.abs((q[2] - q[0]) * (q[5] - q[1])); if (a > area) { area = a; best = q; } }
      if (area < 1) return null;
      const xs = [best[0], best[2], best[4], best[6]], ys = [best[1], best[3], best[5], best[7]];
      const off = el.sid === this.tab().sessionId ? { x: 0, y: 0 } : await this.rootOffset(el);
      return {
        x: Math.min(...xs) + off.x, y: Math.min(...ys) + off.y,
        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
      };
    } catch { return null; }
  }

  private async center(el: El): Promise<{ x: number; y: number }> {
    await this.scrollIntoView(el);
    for (let i = 0; i < 20; i++) {
      const c = await this.quadCenter(el);
      if (c) return c;
      await sleep(100);
    }
    throw new Error("element is not visible (no layout box)");
  }

  /**
   * Auto-wait until the element can receive input: attached, visible, stable (not animating),
   * enabled, and not covered by another element at its center. Returns the point to act on.
   */
  async actionable(target: string, opts: { timeoutMs?: number; enabled?: boolean; hitTest?: boolean } = {}): Promise<{ id: El; x: number; y: number }> {
    const end = Date.now() + (opts.timeoutMs ?? this.actionTimeout);
    let reason = "not found";
    let scrolled = false;
    // A page still loading scripts may be about to hydrate (and replace) the target: give it up to 500 ms of quiet
    // first. Returns immediately when already idle; on very chatty pages set MONAD_PRE_ACTION_QUIET_MS=0 to opt out.
    await this.networkIdle(50, Number(process.env.MONAD_PRE_ACTION_QUIET_MS ?? 500));
    let goneSince: number | undefined;
    let verify = false; // refs are trusted first (saves two round trips); a detached node takes the self-healing path
    while (true) {
      try {
        const id = await this.resolve(target, verify);
        if (!scrolled) { await this.scrollIntoView(id); scrolled = true; }
        // One round trip does every check in the element's own document and returns the point to act on
        // (viewport coordinates of that document). Stability: only elements with running animations wait a frame.
        const r = await this.callOn(id, `async function(hit, needEnabled){
          const el = this;
          if (!el.isConnected) return { s: 'detached' };
          const run = (el.ownerDocument.getAnimations?.() ?? []).filter(a => a.playState === 'running' && a.effect?.target && (a.effect.target === el || a.effect.target.contains?.(el)));
          if (run.length) await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          let best = null, area = 0;
          for (const q of el.getClientRects()) { const a = q.width * q.height; if (a > area) { area = a; best = q; } }
          if (!best || area < 1) return { s: 'not visible' };
          const x = best.left + best.width / 2, y = best.top + best.height / 2;
          if (needEnabled && (el.disabled || el.closest('[aria-disabled="true"],fieldset[disabled]'))) return { s: 'disabled' };
          const st = getComputedStyle(el);
          if (st.visibility === 'hidden' || st.pointerEvents === 'none') return { s: 'not interactable (' + (st.visibility === 'hidden' ? 'hidden' : 'pointer-events:none') + ')' };
          if (run.length) return { s: 'still moving', x, y };
          if (!hit) return { s: 'ok', x, y };
          let e = el.ownerDocument.elementFromPoint(x, y);
          while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(x, y); if (!inner || inner === e) break; e = inner; }
          if (!e || el === e || el.contains(e) || e.contains(el)) return { s: 'ok', x, y };
          if (el.labels && [...el.labels].some(l => l === e || l.contains(e))) return { s: 'ok', x, y };
          const d = e.closest('[role],button,a,input,dialog') || e;
          return { s: 'covered by ' + d.tagName.toLowerCase() + (d.id ? '#' + d.id : '') + (d.className && typeof d.className === 'string' ? '.' + d.className.trim().split(/\\s+/)[0] : '') + ' "' + (d.innerText || '').trim().slice(0, 40) + '"' };
        }`, [opts.hitTest !== false, opts.enabled !== false]);
        if (r?.s === "ok") {
          const org = id.owner ? await this.contentOrigin(id.owner) : { x: 0, y: 0 };
          return { id, x: r.x + org.x, y: r.y + org.y };
        }
        reason = r?.s ?? "not found";
        if (reason === "detached" && !verify) { verify = true; scrolled = false; continue; }
        if (reason === "not visible" || reason === "detached") scrolled = false;
      } catch (e: any) {
        reason = e?.message ?? String(e);
        if (/unknown ref/.test(reason)) throw e;
        // A ref whose node vanished may be mid re-render (e.g. a lazily hydrated widget): keep healing, but not for long.
        if (/is gone from the page/.test(reason) && Date.now() > Math.min(end, goneSince ??= Date.now() + 2000)) throw e;
        if (!verify) { verify = true; continue; }
      }
      if (Date.now() > end) throw new Error(`${target}: ${reason} (waited ${opts.timeoutMs ?? this.actionTimeout} ms)`);
      await sleep(reason === "still moving" ? 0 : 50);
    }
  }

  async click(target: string, opts: { button?: "left" | "right" | "middle"; count?: number; timeoutMs?: number; newTab?: boolean } = {}) {
    const { id, x, y } = await this.actionable(target, { timeoutMs: opts.timeoutMs });
    const button = opts.button ?? "left";
    const clickCount = opts.count ?? 1;
    const before = Date.now();
    const tabsBefore = this.tabs.size;
    // Ctrl-click is not reliable for every scheme (file:, buttons that open popups). For a real
    // link, open the href as a target directly; otherwise fall back to a modified click.
    if (opts.newTab) {
      const href = await this.callOn(id, "function(){ const a = this.closest && this.closest('a'); return a ? a.href : ''; }").catch(() => "");
      if (typeof href === "string" && href && !href.startsWith("javascript:")) {
        const { targetId } = await this.cdp.send("Target.createTarget", { url: href });
        this.current = await this.attach(targetId);
        await this.pageReady(Date.now());
        return;
      }
    }
    // Ctrl-click (Meta on macOS) asks the page/browser to open the link in a new tab.
    const modifiers = opts.newTab ? (process.platform === "darwin" ? 4 : 2) : 0;
    await this.sendInput("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await this.sendInput("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers });
      await this.sendInput("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers });
    }
    await this.settle(before);
    if (opts.newTab) {
      for (let i = 0; i < 40 && this.tabs.size <= tabsBefore; i++) await sleep(50);
    }
  }

  /**
   * After an action: if it started a main-frame navigation (now or within the quiet window), wait for the new
   * document's DOMContentLoaded plus a short quiet window; otherwise wait until the action's own traffic settles.
   * An action that causes nothing returns after one 10 ms tick: navigations an input starts are reported before the input command returns.
   */
  async settle(since: number) {
    const tab = this.tab();
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      await sleep(10);
      if (tab.navAt >= since) {
        const navEnd = Date.now() + 15_000;
        while (tab.loadAt < tab.navAt && Date.now() < navEnd) await sleep(10);
        tab.refs = newRefTable(); tab.last = undefined;
        await this.pageReady(tab.navAt);
        return;
      }
      const now = Date.now();
      let active = 0;
      for (const [, t] of tab.inflight) if (t >= since && now - t < STALE_MS) active++;
      const last = Math.max(since, tab.lastNet);
      if (active === 0 && now - last >= (tab.lastNet >= since ? 150 : 0)) return;
    }
  }

  async fill(target: string, text: string, attempt = 0): Promise<unknown> {
    const before = Date.now();
    const { id } = await this.actionable(target, { hitTest: false });
    const kind = await this.callOn(id, `function(){
      const el = this;
      if (el.tagName === 'SELECT') return 'select';
      el.focus();
      if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.select?.();
        const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'input';
      }
      if (el.isContentEditable) { document.execCommand('selectAll'); document.execCommand('delete'); return 'editable'; }
      return 'other';
    }`);
    if (kind === "select") return this.select(target, [text]);
    if (text) await this.send("Input.insertText", { text });
    await this.callOn(id, `function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }`).catch(() => {});
    await this.networkIdle(150, 1500, before);
    // Hydrating pages may swap the input for a new one right after we typed: verify, and refill the (healed) ref once.
    if (kind === "input" && attempt < 2) {
      const ok = await this.callOn(id, "function(v){ return this.isConnected && this.value === v; }", [text]).catch(() => false);
      if (!ok) {
        await sleep(50);
        // If the healed field already carries the text (frameworks copy it over), leave it.
        const healed = await this.resolve(target).catch(() => null);
        if (healed && await this.callOn(healed, "function(v){ return this.value === v; }", [text]).catch(() => false)) return;
        return this.fill(target, text, attempt + 1);
      }
    }
  }

  /**
   * Press Enter in a field, as a user submitting it. Widgets sometimes swallow that Enter (autocomplete menus):
   * if nothing navigated within 500 ms and the field sits in a real <form action>, submit that form.
   */
  async submit(target: string) {
    const tab = this.tab();
    const before = Date.now();
    await this.press("Enter");
    if (tab.navAt >= before) return;
    const end = Date.now() + 500;
    while (Date.now() < end && tab.navAt < before) await sleep(20);
    if (tab.navAt >= before) { await this.settle(before); return; }
    const el = await this.resolve(target).catch(() => null);
    const sent = el && await this.callOn(el, "function(){ const f = this.form; if (!f || !f.getAttribute('action')) return false; f.requestSubmit(); return true; }").catch(() => false);
    if (sent) await this.settle(before);
  }

  async type(text: string, target?: string) {
    if (target) { const id = await this.resolve(target); await this.callOn(id, "function(){ this.focus(); }"); }
    await this.send("Input.insertText", { text });
  }

  async select(target: string, values: string[]) {
    const id = await this.resolve(target);
    const picked = await this.callOn(id, `function(vals){
      if (this.tagName !== 'SELECT') throw new Error('not a <select>');
      const out = [];
      for (const o of this.options) { const hit = vals.includes(o.value) || vals.includes(o.label) || vals.includes(o.text.trim()); o.selected = hit; if (hit) out.push(o.label); }
      this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }));
      return out;
    }`, [values]);
    if (!picked?.length) throw new Error(`no option matches ${JSON.stringify(values)}`);
    return picked;
  }

  async press(combo: string) {
    const parts = combo.split("+");
    const keyName = parts.pop()!;
    const modifiers = parts.reduce((m, p) => m | modifierBit(p), 0);
    const def = KEYS[keyName] ?? (keyName.length === 1 ? { key: keyName, code: `Key${keyName.toUpperCase()}`, keyCode: keyName.toUpperCase().charCodeAt(0), text: keyName } : undefined);
    if (!def) throw new Error(`unknown key: ${keyName}`);
    const before = Date.now();
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers };
    let text = modifiers & ~8 ? undefined : def.text; // no text when Ctrl/Alt/Meta held
    if (text && modifiers & 8 && keyName.length === 1 && /[a-z]/.test(keyName)) text = keyName.toUpperCase();
    await this.sendInput("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text, unmodifiedText: text });
    await this.sendInput("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await this.settle(before);
  }

  async hover(target: string) {
    const { x, y } = await this.actionable(target, { enabled: false });
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async scroll(dir: string, amount = 600, target?: string) {
    let x = 640, y = 400;
    if (target) ({ x, y } = await this.center(await this.resolve(target)));
    const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
    const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
    await sleep(150);
  }

  async screenshot(opts: { fullPage?: boolean; target?: string; format?: "png" | "jpeg"; quality?: number; ifChanged?: boolean } = {}): Promise<Buffer | null> {
    const tab = this.tab();
    const params: any = { format: opts.format ?? "png", captureBeyondViewport: !!opts.fullPage };
    if (opts.format === "jpeg") params.quality = opts.quality ?? 70;
    if (opts.target) {
      const id = await this.resolve(opts.target);
      await this.scrollIntoView(id);
      const { model } = await this.cdp.send<any>("DOM.getBoxModel", { backendNodeId: id.bid }, id.sid);
      const off = id.sid === tab.sessionId ? { x: 0, y: 0 } : await this.rootOffset(id);
      const xs = model.border.filter((_: number, i: number) => i % 2 === 0).map((v: number) => v + off.x), ys = model.border.filter((_: number, i: number) => i % 2 === 1).map((v: number) => v + off.y);
      params.clip = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), scale: 1 };
    } else if (opts.fullPage) {
      const m = await this.send("Page.getLayoutMetrics");
      const size = m.cssContentSize ?? m.contentSize;
      params.clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 16384), scale: 1 };
    }
    const { data } = await this.send("Page.captureScreenshot", params);
    const buf = Buffer.from(data, "base64");
    if (opts.ifChanged) {
      const hash = createHash("sha256").update(buf).digest("hex");
      if (hash === tab.lastShotHash) return null;
      tab.lastShotHash = hash;
    }
    return buf;
  }

  async text(target?: string, max = 4000) {
    const expr = target ? null : `document.body ? document.body.innerText : ''`;
    const t = target
      ? await this.callOn(await this.resolve(target), "function(){ return this.innerText ?? this.textContent ?? ''; }")
      : await this.evaluate(expr!);
    const s = String(t ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
  }

  // ---- targeted queries -------------------------------------------------

  async getHtml(target: string) {
    return String(await this.callOn(await this.resolve(target), "function(){ return this.innerHTML ?? ''; }") ?? "");
  }

  /**
   * Render a URL in a throwaway tab and return its outer HTML, then restore the previous tab.
   * Used by `--render` watchers so a background check never steals the user's active tab.
   */
  async renderHtml(url: string): Promise<string> {
    const previous = this.current;
    const tab = await this.newTab();
    try {
      await this.goto(url);
      await this.networkIdle(300, 3000).catch(() => {});
      const html = await this.evaluate("document.documentElement ? document.documentElement.outerHTML : ''");
      return String(html ?? "");
    } finally {
      if (this.tabs.has(tab.targetId)) {
        this.current = tab;
        await this.closeTab().catch(() => {});
      }
      if (previous && this.tabs.has(previous.targetId)) {
        this.current = previous;
        await this.cdp.send("Target.activateTarget", { targetId: previous.targetId }).catch(() => {});
      }
    }
  }

  async getValue(target: string) {
    return String(await this.callOn(await this.resolve(target), "function(){ return this.value ?? this.getAttribute('value') ?? ''; }") ?? "");
  }

  async getAttr(target: string, name: string) {
    const v = await this.callOn(await this.resolve(target), "function(n){ return this.getAttribute(n); }", [name]);
    return v === undefined ? null : String(v);
  }

  async getCount(selector: string) {
    return Number(await this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)) || 0;
  }

  async getBox(target: string) {
    const id = await this.resolve(target);
    const { model } = await this.cdp.send<any>("DOM.getBoxModel", { backendNodeId: id.bid }, id.sid);
    const off = id.sid === this.tab().sessionId ? { x: 0, y: 0 } : await this.rootOffset(id);
    return { x: model.border[0] + off.x, y: model.border[1] + off.y, width: model.width, height: model.height };
  }

  async getStyles(target: string, props = ["display", "visibility", "opacity", "color", "backgroundColor", "fontSize", "fontWeight", "position", "cursor"]) {
    const id = await this.resolve(target);
    return await this.callOn(id, `function(props){ const s = getComputedStyle(this); return Object.fromEntries(props.map(p => [p, s.getPropertyValue(p)])); }`, [props]) as Record<string, string>;
  }

  async isVisible(target: string) {
    try {
      return !!(await this.callOn(await this.resolve(target), `function(){
        const s = getComputedStyle(this), r = this.getBoundingClientRect();
        return this.isConnected && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      }`));
    } catch { return false; }
  }

  async isEnabled(target: string) {
    return !(await this.callOn(await this.resolve(target), `function(){
      return !!(this.disabled || this.closest('[aria-disabled="true"],fieldset[disabled]'));
    }`));
  }

  async isChecked(target: string) {
    return !!(await this.callOn(await this.resolve(target), "function(){ return !!this.checked; }"));
  }

  async setChecked(target: string, checked: boolean) {
    const { id } = await this.actionable(target, { hitTest: false });
    const state = await this.callOn(id, "function(){ return { on: !!this.checked, type: (this.type || '').toLowerCase(), tag: this.tagName }; }") as any;
    if (!checked && state.tag === "INPUT" && state.type === "radio" && state.on)
      throw new Error("a radio button cannot be unchecked");
    if (state.on !== checked) await this.click(target);
    else await this.networkIdle(50, 200);
  }

  async focus(target: string) {
    const { id } = await this.actionable(target, { enabled: false, hitTest: false });
    await this.callOn(id, "function(){ this.focus(); }");
  }

  async scrollIntoViewTarget(target: string) {
    await this.scrollIntoView(await this.resolve(target));
  }

  async highlight(target: string) {
    const id = await this.resolve(target);
    await this.callOn(id, "function(){ this.style.outline = '2px solid #ff00ff'; this.style.outlineOffset = '1px'; }");
  }

  async upload(target: string, files: string[]) {
    const id = await this.resolve(target);
    await this.cdp.send("DOM.setFileInputFiles", { files, backendNodeId: id.bid }, id.sid);
    return files;
  }

  async download(target: string, dir: string, timeoutMs = 30_000) {
    mkdirSync(dir, { recursive: true });
    await this.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
    let filename = "";
    let guid = "";
    let cleanup = () => {};
    const done = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`download did not finish in ${timeoutMs} ms`)); }, timeoutMs);
      // Browser.downloadWillBegin is browser-wide; take the download this click started (the first
      // event) and ignore another tab's. A frameId filter misses downloads that start in a child
      // frame, which then fell back to the GUID instead of the suggested file name.
      const offBegin = this.cdp.on("Browser.downloadWillBegin", (p: any) => {
        if (guid && p.guid !== guid) return;
        guid = p.guid;
        filename = p.suggestedFilename || filename;
      });
      const offProgress = this.cdp.on("Browser.downloadProgress", (p: any) => {
        if (guid && p.guid !== guid) return;
        if (p.state === "completed") { cleanup(); resolve(join(dir, filename || p.guid)); }
        else if (p.state === "canceled") { cleanup(); reject(new Error("download canceled")); }
      });
      cleanup = () => { clearTimeout(timer); offBegin(); offProgress(); };
    });
    try {
      await this.click(target);
      return await done;
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  async pdf(opts: { landscape?: boolean; printBackground?: boolean; scale?: number } = {}) {
    const { data } = await this.send("Page.printToPDF", {
      printBackground: opts.printBackground ?? true, landscape: !!opts.landscape,
      scale: opts.scale ?? 1, preferCSSPageSize: true,
    });
    return Buffer.from(data, "base64");
  }

  async drag(source: string, target: string) {
    const a = await this.actionable(source);
    const b = await this.center(await this.resolve(target));
    const before = Date.now();
    await this.sendInput("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
    await this.sendInput("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++)
      await this.sendInput("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps, button: "left", buttons: 1 });
    await this.sendInput("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
    await this.settle(before);
  }

  /** Real per-character keystrokes (as opposed to `type`, which inserts text in one event). */
  async typeKeys(text: string) {
    for (const ch of text) {
      if (ch === "\n") { await this.keyDown("Enter"); await this.keyUp("Enter"); continue; }
      const code = ch === " " ? "Space" : /[a-zA-Z0-9]/.test(ch) ? (/[a-z]/.test(ch) ? `Key${ch.toUpperCase()}` : /[A-Z]/.test(ch) ? `Key${ch}` : `Digit${ch}`) : "";
      const vk = ch.toUpperCase().charCodeAt(0);
      await this.sendInput("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch, code, windowsVirtualKeyCode: vk });
      await this.sendInput("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk });
    }
  }

  private keyBase(combo: string) {
    const parts = combo.split("+");
    const keyName = parts.pop()!;
    const modifiers = parts.reduce((m, p) => m | modifierBit(p), 0);
    const def = KEYS[keyName] ?? (keyName.length === 1 ? { key: keyName, code: `Key${keyName.toUpperCase()}`, keyCode: keyName.toUpperCase().charCodeAt(0), text: keyName } : undefined);
    if (!def) throw new Error(`unknown key: ${keyName}`);
    let text = modifiers & ~8 ? undefined : def.text;
    if (text && modifiers & 8 && keyName.length === 1 && /[a-z]/.test(keyName)) text = keyName.toUpperCase();
    return { base: { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers }, text };
  }

  async keyDown(combo: string) {
    const { base, text } = this.keyBase(combo);
    await this.sendInput("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text, unmodifiedText: text });
  }

  async keyUp(combo: string) {
    const { base } = this.keyBase(combo);
    await this.sendInput("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async mouseMove(x: number, y: number) {
    this.mouseAt = { x, y };
    await this.sendInput("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }
  async mouseDown(button: "left" | "right" | "middle" = "left") {
    await this.sendInput("Input.dispatchMouseEvent", { type: "mousePressed", ...this.mouseAt, button, buttons: 1, clickCount: 1 });
  }
  async mouseUp(button: "left" | "right" | "middle" = "left") {
    await this.sendInput("Input.dispatchMouseEvent", { type: "mouseReleased", ...this.mouseAt, button, buttons: 0, clickCount: 1 });
  }
  async mouseWheel(deltaX: number, deltaY: number) {
    await this.sendInput("Input.dispatchMouseEvent", { type: "mouseWheel", ...this.mouseAt, deltaX, deltaY });
  }

  // ---- emulation, cookies, storage, network ------------------------------

  async setViewport(width: number, height: number, scale = 1, mobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });
  }

  async setDevice(name: string) {
    const key = Object.keys(DEVICES).find((k) => k.toLowerCase() === name.toLowerCase());
    const d = key ? DEVICES[key] : undefined;
    if (!d) throw new Error(`unknown device: ${name} (known: ${Object.keys(DEVICES).join(", ")})`);
    await this.setViewport(d.width, d.height, d.scale, d.mobile);
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: d.mobile, maxTouchPoints: d.mobile ? 5 : 1 }).catch(() => {});
    if (d.userAgent) await this.send("Network.setUserAgentOverride", { userAgent: d.userAgent }).catch(() => {});
  }

  async setMedia(opts: { colorScheme?: "dark" | "light" | "no-preference"; reducedMotion?: boolean }) {
    const features: any[] = [];
    if (opts.colorScheme) features.push({ name: "prefers-color-scheme", value: opts.colorScheme });
    if (opts.reducedMotion !== undefined) features.push({ name: "prefers-reduced-motion", value: opts.reducedMotion ? "reduce" : "no-preference" });
    await this.send("Emulation.setEmulatedMedia", { features });
  }

  async setOffline(offline: boolean) {
    await this.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }

  async setHeaders(headers: Record<string, string>) {
    await this.send("Network.setExtraHTTPHeaders", { headers });
  }

  async setGeo(latitude: number, longitude: number, accuracy = 1) {
    await this.send("Emulation.setGeolocationOverride", { latitude, longitude, accuracy });
    try {
      const { url } = await this.info();
      const origin = new URL(url).origin;
      if (origin !== "null") await this.cdp.send("Browser.grantPermissions", { permissions: ["geolocation"], origin });
    } catch { /* file:// and opaque origins cannot be granted */ }
  }

  async cookies(url?: string): Promise<any[]> {
    const r: any = url ? await this.send("Network.getCookies", { urls: [url] }) : await this.send("Network.getAllCookies");
    return r.cookies ?? [];
  }

  async setCookie(cookie: Record<string, unknown>) {
    const r: any = await this.send("Network.setCookie", cookie);
    if (r.success === false) throw new Error("cookie rejected by the browser");
  }

  async clearCookies(url?: string) {
    if (!url) return void await this.send("Network.clearBrowserCookies");
    for (const c of await this.cookies(url)) await this.send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path });
  }

  async storage(kind: "local" | "session") {
    const obj = kind === "local" ? "localStorage" : "sessionStorage";
    return await this.evaluate(`Object.fromEntries(Object.entries(${obj}))`) as Record<string, string>;
  }

  async setStorage(kind: "local" | "session", key: string, value: string) {
    const obj = kind === "local" ? "localStorage" : "sessionStorage";
    await this.evaluate(`${obj}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  }

  async clearStorage(kind: "local" | "session") {
    const obj = kind === "local" ? "localStorage" : "sessionStorage";
    await this.evaluate(`${obj}.clear()`);
  }

  networkRequests(filter?: string): NetRequest[] {
    const list = [...this.tab().requests.values()];
    return filter ? list.filter((r) => r.url.includes(filter)) : list;
  }

  clearNetwork() { this.tab().requests.clear(); }

  /** A compact HAR 1.2 export of the requests seen on this tab (no bodies). */
  networkHar() {
    const headers = (h?: Record<string, string>) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value: String(value) }));
    const entries = [...this.tab().requests.values()].map((r) => ({
      startedDateTime: new Date(r.ts).toISOString(),
      time: 0,
      request: {
        method: r.method, url: r.url, httpVersion: "HTTP/1.1",
        headers: headers(r.requestHeaders), queryString: [], cookies: [], headersSize: -1, bodySize: -1,
      },
      response: {
        status: r.status ?? 0, statusText: "", httpVersion: "HTTP/1.1",
        headers: headers(r.responseHeaders), cookies: [],
        content: { size: r.size ?? 0, mimeType: r.mime ?? "" },
        redirectURL: "", headersSize: -1, bodySize: r.size ?? -1,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    }));
    return {
      log: {
        version: "1.2",
        creator: { name: "monad-browser", version: VERSION },
        entries,
      },
    };
  }

  async route(route: Route) {
    const tab = this.tab();
    tab.routes.push(route);
    await this.refreshFetch(tab);
  }

  async unroute(pattern?: string) {
    const tab = this.tab();
    tab.routes = pattern ? tab.routes.filter((r) => r.pattern !== pattern) : [];
    await this.refreshFetch(tab);
  }

  async traceStart() {
    if (this.traceActive) throw new Error("a trace is already running");
    await this.send("Tracing.start", {
      categories: "devtools.timeline,disabled-by-default-devtools.timeline",
      transferMode: "ReturnAsStream",
    });
    this.traceActive = true;
  }

  async traceStop(path: string) {
    if (!this.traceActive) throw new Error("no trace is running");
    const done = this.cdp.waitFor("Tracing.tracingComplete", { timeoutMs: 30_000 });
    await this.send("Tracing.end");
    const { stream } = await done;
    this.traceActive = false;
    if (!stream) throw new Error("Chrome did not return a trace stream");
    const chunks: Buffer[] = [];
    while (true) {
      // The stream is owned by the page session that started Tracing.
      const r: any = await this.send("IO.read", { handle: stream, size: 1 << 20 });
      chunks.push(Buffer.from(r.data, r.base64Encoded ? "base64" : "utf8"));
      if (r.eof) break;
    }
    await this.send("IO.close", { handle: stream }).catch(() => {});
    writeFileSync(path, Buffer.concat(chunks));
    return path;
  }

  // ---- dialogs ----------------------------------------------------------

  dialogStatus() { return this.pendingDialog; }

  async dialogAccept(promptText?: string) {
    const d = this.pendingDialog;
    if (!d) throw new Error("no JavaScript dialog is open");
    await this.cdp.send("Page.handleJavaScriptDialog", { accept: true, promptText: promptText ?? d.defaultPrompt ?? "" }, d.sessionId);
    this.pendingDialog = undefined;
  }

  async dialogDismiss() {
    const d = this.pendingDialog;
    if (!d) throw new Error("no JavaScript dialog is open");
    await this.cdp.send("Page.handleJavaScriptDialog", { accept: false }, d.sessionId);
    this.pendingDialog = undefined;
  }

  // ---- screenshots ------------------------------------------------------

  /** Viewport screenshot with numbered labels for every visible ref; returns the legend too. */
  async annotatedScreenshot(opts: { target?: string; format?: "png" | "jpeg"; quality?: number } = {}) {
    const tab = this.tab();
    const items: { ref: number; role: string; name: string; x: number; y: number }[] = [];
    for (const [ref, entry] of tab.refs.byRef) {
      const b = await this.quadBox(entry.el);
      // Just above the top-left corner: a badge over the middle covers the control's own label.
      if (b) items.push({ ref, role: entry.role, name: entry.name, x: Math.max(2, b.x), y: Math.max(14, b.y) });
    }
    const capped = items.slice(0, 100);
    const html = capped.map((i) =>
      `<span style="position:fixed;left:${i.x}px;top:${i.y}px;transform:translate(0,-100%);` +
      `background:#ff0;color:#000;border:1px solid #000;border-radius:2px;font:11px/1.2 monospace;padding:1px 3px;z-index:2147483647">${i.ref}</span>`).join("");
    await this.evaluate(`(() => {
      document.getElementById('__monad_annot')?.remove();
      const d = document.createElement('div');
      d.id = '__monad_annot';
      d.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      d.innerHTML = ${JSON.stringify(html)};
      document.documentElement.appendChild(d);
      return true;
    })()`);
    try {
      const buf = await this.screenshot({ ...opts, ifChanged: false });
      if (!buf) throw new Error("screenshot failed");
      const legend = capped.map((i) => `[${i.ref}] @${i.ref} ${i.role}${i.name ? ` "${i.name}"` : ""}`);
      if (items.length > capped.length) legend.push(`… ${items.length - capped.length} more`);
      return { buffer: buf, legend };
    } finally {
      await this.evaluate("document.getElementById('__monad_annot')?.remove()").catch(() => {});
    }
  }

  async back() { const b = Date.now(); await this.evaluate("history.back()"); await this.settle(b); }
  async forward() { const b = Date.now(); await this.evaluate("history.forward()"); await this.settle(b); }
  async reload() { const b = Date.now(); await this.send("Page.reload", {}); await this.settle(b); }

  listTabs() {
    return [...this.tabs.values()].map((t, i) => `${t === this.current ? "*" : " "} [${i}] ${t.title || "(untitled)"} — ${t.url}`).join("\n");
  }
  async switchTab(index: number) {
    const t = [...this.tabs.values()][index];
    if (!t) throw new Error(`no tab ${index}`);
    this.current = t;
    await this.cdp.send("Target.activateTarget", { targetId: t.targetId }).catch(() => {});
  }
  async closeTab(index?: number) {
    const t = index === undefined ? this.current : [...this.tabs.values()][index];
    if (!t) throw new Error("no such tab");
    await this.cdp.send("Target.closeTarget", { targetId: t.targetId });
    this.tabs.delete(t.targetId);
    if (this.current === t) this.current = [...this.tabs.values()].at(-1);
    if (!this.current) await this.newTab();
  }

  async close() {
    try { if (this.chrome?.proc) await this.cdp.send("Browser.close").catch(() => {}); } catch { /* ignore */ }
    this.cdp?.close();
    if (this.chrome?.proc && this.chrome.proc.exitCode === null) {
      await new Promise((r) => { const t = setTimeout(() => { killChrome(this.chrome!.proc!); r(null); }, 2000); this.chrome!.proc!.once("exit", () => { clearTimeout(t); r(null); }); });
    }
    this.chrome?.relay?.close();
    if (this.chrome?.ephemeral) cleanupProfile(this.chrome.userDataDir);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
