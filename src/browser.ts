// Browser session: one CDP connection, a current tab, refs, and the action primitives.
import { CDP } from "./cdp.js";
import { launchChrome, resolveCdpEndpoint, cleanupProfile, type LaunchedChrome } from "./chrome.js";
import { renderDiff } from "./diff.js";
import { takeSnapshot, newRefTable, elKey, type El, type RefTable, type SnapshotOptions } from "./snapshot.js";
import { KEYS, modifierBit } from "./keys.js";

export type BrowserOptions = {
  cdpEndpoint?: string; executable?: string; userDataDir?: string; headful?: boolean;
  block?: string[]; // resource types to block: image, font, media, stylesheet
  proxy?: string;
};

type Tab = {
  targetId: string; sessionId: string; refs: RefTable; inflight: Map<string, number>; lastNet: number; url: string; title: string;
  mainFrame?: string; navAt: number; loadAt: number; fullLoadAt: number;
  oopifs: Map<string, string>; // out-of-process iframe frameId → its CDP session
  last?: { key: string; lines: string[] };
};

const RESOURCE_TYPES: Record<string, string> = { image: "Image", font: "Font", media: "Media", stylesheet: "Stylesheet", css: "Stylesheet" };

const STALE_MS = 2000;
const DOM_TYPES = new Set(["Document", "Script", "XHR", "Fetch", "Stylesheet"]);

export class Browser {
  cdp!: CDP;
  private chrome?: LaunchedChrome;
  private tabs = new Map<string, Tab>();
  current?: Tab;
  private blockTypes: string[] = [];
  private dialogs: string[] = [];
  console: string[] = [];
  actionTimeout = Number(process.env.MONAD_ACTION_TIMEOUT ?? 5000);

  constructor(private opts: BrowserOptions = {}) {}

  async start() {
    let ws: string;
    if (this.opts.cdpEndpoint) ws = await resolveCdpEndpoint(this.opts.cdpEndpoint);
    else {
      this.chrome = await launchChrome({ executable: this.opts.executable, userDataDir: this.opts.userDataDir, headful: this.opts.headful, proxy: this.opts.proxy });
      ws = this.chrome.wsUrl;
    }
    this.cdp = await CDP.connect(ws);
    this.setBlock(this.opts.block ?? []);
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

  /** Fetch domain only when needed: resource blocking and/or proxy auth. Otherwise requests never pause. */
  private fetchSetup(sessionId: string) {
    const patterns = this.blockTypes.map((resourceType) => ({ resourceType, requestStage: "Request" }));
    if (!patterns.length) return Promise.resolve();
    return this.cdp.send("Fetch.enable", { patterns }, sessionId);
  }

  private async attach(targetId: string): Promise<Tab> {
    const existing = this.tabs.get(targetId);
    if (existing) return existing;
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const tab: Tab = { targetId, sessionId, refs: newRefTable(), inflight: new Map(), lastNet: Date.now(), url: "", title: "", navAt: 0, loadAt: 0, fullLoadAt: 0, oopifs: new Map() };
    this.tabs.set(targetId, tab);
    const s = sessionId;
    const on = (ev: string, fn: (p: any) => void) => this.cdp.on(ev, (p, sid) => { if (sid === s) fn(p); });
    on("Network.requestWillBeSent", (p) => {
      const now = Date.now();
      // A new top-level document cancels the old page's loads; their loadingFinished/Failed may never arrive.
      if (p.type === "Document" && p.requestId === p.loaderId && !p.redirectResponse && p.frameId === tab.targetId) tab.inflight.clear();
      // Only loads that can still change the DOM gate settling; images, fonts, media and beacons do not.
      if (DOM_TYPES.has(p.type)) tab.inflight.set(p.requestId, now);
      if (DOM_TYPES.has(p.type)) tab.lastNet = now;
    });
    const done = (p: any) => { if (tab.inflight.delete(p.requestId)) tab.lastNet = Date.now(); };
    on("Network.loadingFinished", done);
    on("Network.loadingFailed", done);
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
      this.dialogs.push(`${p.type}: ${p.message}`);
      // Never let a dialog wedge the agent: accept by default (prompt gets its default text).
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
      this.fetchSetup(s),
    ]);
    await this.cdp.send("Runtime.runIfWaitingForDebugger", {}, s).catch(() => {});
    const { targetInfo } = await this.cdp.send("Target.getTargetInfo", { targetId });
    tab.url = targetInfo.url; tab.title = targetInfo.title;
    return tab;
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
    tab.refs = newRefTable();
    return this.info();
  }

  async info() {
    const r = await this.evaluate("({url: location.href, title: document.title})");
    return r as { url: string; title: string };
  }

  async evaluate(expression: string, awaitPromise = true) {
    // `return …` → async function body; a lone `await` expression → async arrow; anything else is evaluated
    // as-is (statements evaluate to their last expression, like the devtools console).
    const src = /\breturn\b/.test(expression) ? `(async () => { ${expression} })()`
      : /\bawait\b/.test(expression) && !/;\s*\S/.test(expression) ? `(async () => (${expression.replace(/;\s*$/, "")}))()`
      : /\bawait\b/.test(expression) ? `(async () => { ${expression} })()`
      : expression;
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
    let applied = 0;
    for (const o of state.origins ?? []) {
      const js = `(() => { if (location.origin !== ${JSON.stringify(o.origin)}) return false; for (const [k, v] of Object.entries(${JSON.stringify(o.local ?? {})})) localStorage.setItem(k, v); for (const [k, v] of Object.entries(${JSON.stringify(o.session ?? {})})) sessionStorage.setItem(k, v); return true; })()`;
      await this.send("Page.addScriptToEvaluateOnNewDocument", { source: js });
      const r: any = await this.send("Runtime.evaluate", { expression: js, returnByValue: true }).catch(() => null);
      if (r?.result?.value === true) applied++;
    }
    return { cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0, applied };
  }

  /** Snapshot; with `diff`, only lines that changed since this tab's previous snapshot of the same page. */
  async snapshot(opts: SnapshotOptions & { diff?: boolean } = {}) {
    const tab = this.tab();
    const res = await takeSnapshot(this.cdp, tab.sessionId, tab.refs, opts, tab.oopifs);
    const { url, title } = await this.info();
    const extra: string[] = [];
    if (this.dialogs.length) extra.push(`dialogs: ${this.dialogs.splice(0).join(" | ")}`);
    const head = `# ${title} — ${url}\n${extra.length ? extra.join("\n") + "\n" : ""}`;
    const key = `${url}|${opts.interactive ? "i" : "f"}`;
    const lines = res.text.split("\n");
    const prev = tab.last?.key === key ? tab.last.lines : undefined;
    tab.last = { key, lines };
    if (opts.diff && prev) {
      const d = renderDiff(prev, lines);
      if (!d.added && !d.removed) return `${head}(no changes since last snapshot)`;
      if (d.text.length < res.text.length * 0.7)
        return `${head}(diff vs last snapshot: +${d.added} -${d.removed}, ${d.same} unchanged)\n${d.text}`;
    }
    return head + res.text;
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
      const pick = healed.length === 1 ? healed[0] : healed.length > 1 && ref.ord !== undefined ? healed[ref.ord] : undefined;
      if (pick !== undefined) {
        tab.refs.byBackend.delete(elKey(ref.el));
        ref.el = top(pick);
        tab.refs.byBackend.set(elKey(ref.el), n);
        return ref.el;
      }
      throw new Error(`@${n} (${ref.role} "${ref.name}") is gone from the page — take a fresh snapshot`);
    }
    if (t.startsWith("text=")) {
      const ids = await this.queryAX(t.slice(5));
      if (!ids.length) throw new Error(`no element named "${t.slice(5)}"`);
      return top(ids[0]);
    }
    const rm = /^role=([\w-]+)(?::(.+))?$/.exec(t);
    if (rm) {
      const ids = await this.queryAX(rm[2], rm[1]);
      if (!ids.length) throw new Error(`no ${rm[1]}${rm[2] ? ` named "${rm[2]}"` : ""}`);
      return top(ids[0]);
    }
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector: t });
    if (!nodeId) throw new Error(`no element matches selector: ${t}`);
    const { node } = await this.send("DOM.describeNode", { nodeId });
    return top(node.backendNodeId);
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

  /** Accessible-name (+ role) lookup over the whole document, visible nodes first. */
  private async queryAX(name?: string, role?: string): Promise<number[]> {
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const params: any = { backendNodeId: root.backendNodeId };
    if (name) params.accessibleName = name;
    if (role) params.role = role;
    const { nodes } = await this.send("Accessibility.queryAXTree", params);
    const ids: number[] = nodes.filter((n: any) => !n.ignored && n.backendDOMNodeId).map((n: any) => n.backendDOMNodeId);
    const visible: number[] = [];
    for (const id of ids) { try { const { quads } = await this.send("DOM.getContentQuads", { backendNodeId: id }); if (quads?.length) visible.push(id); } catch { /* hidden */ } }
    return visible.length ? visible : ids;
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
      const { quads } = await this.cdp.send<any>("DOM.getContentQuads", { backendNodeId: el.bid }, el.sid);
      if (!quads?.length) return null;
      // Largest quad wins (wrapped inline links have several).
      let best = quads[0], area = 0;
      for (const q of quads) { const a = Math.abs((q[2] - q[0]) * (q[5] - q[1])); if (a > area) { area = a; best = q; } }
      if (area < 1) return null;
      const off = el.sid === this.tab().sessionId ? { x: 0, y: 0 } : await this.rootOffset(el);
      return { x: (best[0] + best[2] + best[4] + best[6]) / 4 + off.x, y: (best[1] + best[3] + best[5] + best[7]) / 4 + off.y };
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
    // A page still loading scripts may be about to hydrate (and replace) the target: give it up to 500 ms of quiet first.
    await this.networkIdle(50, 500);
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
        if (/is gone from the page|unknown ref/.test(reason)) throw e;
        if (!verify) { verify = true; continue; }
      }
      if (Date.now() > end) throw new Error(`${target}: ${reason} (waited ${opts.timeoutMs ?? this.actionTimeout} ms)`);
      await sleep(reason === "still moving" ? 0 : 50);
    }
  }

  async click(target: string, opts: { button?: "left" | "right" | "middle"; count?: number; timeoutMs?: number } = {}) {
    const { x, y } = await this.actionable(target, { timeoutMs: opts.timeoutMs });
    const button = opts.button ?? "left";
    const clickCount = opts.count ?? 1;
    const before = Date.now();
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (let i = 1; i <= clickCount; i++) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i });
    }
    await this.settle(before);
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
        tab.refs = newRefTable();
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
    const text = modifiers & ~8 ? undefined : def.text; // no text when Ctrl/Alt/Meta held
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text, unmodifiedText: text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
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

  async screenshot(opts: { fullPage?: boolean; target?: string; format?: "png" | "jpeg"; quality?: number } = {}) {
    const params: any = { format: opts.format ?? "png", captureBeyondViewport: !!opts.fullPage };
    if (opts.format === "jpeg") params.quality = opts.quality ?? 70;
    if (opts.target) {
      const id = await this.resolve(opts.target);
      await this.scrollIntoView(id);
      const { model } = await this.cdp.send<any>("DOM.getBoxModel", { backendNodeId: id.bid }, id.sid);
      const off = id.sid === this.tab().sessionId ? { x: 0, y: 0 } : await this.rootOffset(id);
      const xs = model.border.filter((_: number, i: number) => i % 2 === 0).map((v: number) => v + off.x), ys = model.border.filter((_: number, i: number) => i % 2 === 1).map((v: number) => v + off.y);
      params.clip = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), scale: 1 };
    } else if (opts.fullPage) {
      const m = await this.send("Page.getLayoutMetrics");
      const size = m.cssContentSize ?? m.contentSize;
      params.clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 16384), scale: 1 };
    }
    const { data } = await this.send("Page.captureScreenshot", params);
    return Buffer.from(data, "base64");
  }

  async text(target?: string, max = 4000) {
    const expr = target ? null : `document.body ? document.body.innerText : ''`;
    const t = target
      ? await this.callOn(await this.resolve(target), "function(){ return this.innerText ?? this.textContent ?? ''; }")
      : await this.evaluate(expr!);
    const s = String(t ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
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
      await new Promise((r) => { const t = setTimeout(() => { this.chrome!.proc!.kill("SIGKILL"); r(null); }, 2000); this.chrome!.proc!.once("exit", () => { clearTimeout(t); r(null); }); });
    }
    this.chrome?.relay?.close();
    if (this.chrome?.ephemeral) cleanupProfile(this.chrome.userDataDir);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
