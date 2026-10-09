// Browser session: one CDP connection, a current tab, refs, and the action primitives.
import { CDP } from "./cdp.js";
import { launchChrome, resolveCdpEndpoint, cleanupProfile, type LaunchedChrome } from "./chrome.js";
import { renderDiff } from "./diff.js";
import { takeSnapshot, newRefTable, type RefTable, type SnapshotOptions } from "./snapshot.js";
import { KEYS, modifierBit } from "./keys.js";

export type BrowserOptions = {
  cdpEndpoint?: string; executable?: string; userDataDir?: string; headful?: boolean;
  block?: string[]; // resource types to block: image, font, media, stylesheet
  proxy?: string;
};

type Tab = {
  targetId: string; sessionId: string; refs: RefTable; inflight: Set<string>; lastNet: number; url: string; title: string;
  mainFrame?: string; navAt: number; loadAt: number;
  last?: { key: string; lines: string[] };
};

const RESOURCE_TYPES: Record<string, string> = { image: "Image", font: "Font", media: "Media", stylesheet: "Stylesheet", css: "Stylesheet" };

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
    const tab: Tab = { targetId, sessionId, refs: newRefTable(), inflight: new Set(), lastNet: Date.now(), url: "", title: "", navAt: 0, loadAt: 0 };
    this.tabs.set(targetId, tab);
    const s = sessionId;
    const on = (ev: string, fn: (p: any) => void) => this.cdp.on(ev, (p, sid) => { if (sid === s) fn(p); });
    on("Network.requestWillBeSent", (p) => { if (p.type !== "WebSocket" && p.type !== "EventSource") tab.inflight.add(p.requestId); tab.lastNet = Date.now(); });
    const done = (p: any) => { tab.inflight.delete(p.requestId); tab.lastNet = Date.now(); };
    on("Network.loadingFinished", done);
    on("Network.loadingFailed", done);
    on("Page.frameNavigated", (p) => { if (!p.frame.parentId) { tab.url = p.frame.url; tab.mainFrame = p.frame.id; } });
    on("Page.frameRequestedNavigation", (p) => { if (!tab.mainFrame || p.frameId === tab.mainFrame) tab.navAt = Date.now(); });
    on("Page.frameStartedLoading", (p) => { if (!tab.mainFrame || p.frameId === tab.mainFrame) tab.navAt = Date.now(); });
    on("Page.lifecycleEvent", (p) => { if (p.name === "load" && (!tab.mainFrame || p.frameId === tab.mainFrame)) tab.loadAt = Date.now(); });
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
    await Promise.all([
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
  async networkIdle(idleMs = 400, timeoutMs = 5000) {
    const tab = this.tab();
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (tab.inflight.size === 0 && Date.now() - tab.lastNet >= idleMs) return true;
      await sleep(50);
    }
    return false;
  }

  async goto(url: string, opts: { timeoutMs?: number } = {}) {
    if (!/^([a-z][a-z0-9+.-]*:\/\/|about:|data:|file:|javascript:|blob:)/i.test(url)) url = (/^(localhost|127\.|\[::1\])/.test(url) ? "http://" : "https://") + url;
    const tab = this.tab();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const since = Date.now();
    const res = await this.send("Page.navigate", { url });
    if (res.errorText) throw new Error(`navigation failed: ${res.errorText} (${url})`);
    const end = since + timeoutMs;
    while (res.loaderId && tab.loadAt < since && Date.now() < end) await sleep(20);
    await this.networkIdle(250, 4000);
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

  /** Snapshot; with `diff`, only lines that changed since this tab's previous snapshot of the same page. */
  async snapshot(opts: SnapshotOptions & { diff?: boolean } = {}) {
    const tab = this.tab();
    const res = await takeSnapshot(this.cdp, tab.sessionId, tab.refs, opts);
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
  async resolve(target: string): Promise<number> {
    const tab = this.tab();
    const t = target.trim();
    const m = /^@?e?(\d+)$/.exec(t);
    if (m) {
      const n = Number(m[1]);
      const ref = tab.refs.byRef.get(n);
      if (!ref) throw new Error(`unknown ref @${n} — take a fresh snapshot`);
      if (await this.isAttached(ref.backendNodeId)) return ref.backendNodeId;
      const healed = ref.name ? await this.queryAX(ref.name, ref.role === "clickable" ? undefined : ref.role) : [];
      if (healed.length === 1) {
        tab.refs.byBackend.delete(ref.backendNodeId);
        ref.backendNodeId = healed[0];
        tab.refs.byBackend.set(healed[0], n);
        return healed[0];
      }
      throw new Error(`@${n} (${ref.role} "${ref.name}") is gone from the page — take a fresh snapshot`);
    }
    if (t.startsWith("text=")) {
      const ids = await this.queryAX(t.slice(5));
      if (!ids.length) throw new Error(`no element named "${t.slice(5)}"`);
      return ids[0];
    }
    const rm = /^role=([\w-]+)(?::(.+))?$/.exec(t);
    if (rm) {
      const ids = await this.queryAX(rm[2], rm[1]);
      if (!ids.length) throw new Error(`no ${rm[1]}${rm[2] ? ` named "${rm[2]}"` : ""}`);
      return ids[0];
    }
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector: t });
    if (!nodeId) throw new Error(`no element matches selector: ${t}`);
    const { node } = await this.send("DOM.describeNode", { nodeId });
    return node.backendNodeId;
  }

  private async isAttached(backendNodeId: number) {
    try {
      const { object } = await this.send("DOM.resolveNode", { backendNodeId });
      if (!object?.objectId) return false;
      const r: any = await this.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){return this.isConnected}", returnByValue: true });
      this.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
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

  private async objectId(backendNodeId: number) {
    const { object } = await this.send("DOM.resolveNode", { backendNodeId });
    if (!object?.objectId) throw new Error("element is no longer attached — take a fresh snapshot");
    return object.objectId as string;
  }

  async callOn(backendNodeId: number, fn: string, args: unknown[] = []) {
    const objectId = await this.objectId(backendNodeId);
    const r: any = await this.send("Runtime.callFunctionOn", {
      objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }

  private async quadCenter(backendNodeId: number): Promise<{ x: number; y: number } | null> {
    try {
      const { quads } = await this.send("DOM.getContentQuads", { backendNodeId });
      if (!quads?.length) return null;
      // Largest quad wins (wrapped inline links have several).
      let best = quads[0], area = 0;
      for (const q of quads) { const a = Math.abs((q[2] - q[0]) * (q[5] - q[1])); if (a > area) { area = a; best = q; } }
      if (area < 1) return null;
      return { x: (best[0] + best[2] + best[4] + best[6]) / 4, y: (best[1] + best[3] + best[5] + best[7]) / 4 };
    } catch { return null; }
  }

  private async center(backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      const c = await this.quadCenter(backendNodeId);
      if (c) return c;
      await sleep(100);
    }
    throw new Error("element is not visible (no layout box)");
  }

  /**
   * Auto-wait until the element can receive input: attached, visible, stable (not animating),
   * enabled, and not covered by another element at its center. Returns the point to act on.
   */
  async actionable(target: string, opts: { timeoutMs?: number; enabled?: boolean; hitTest?: boolean } = {}): Promise<{ id: number; x: number; y: number }> {
    const end = Date.now() + (opts.timeoutMs ?? this.actionTimeout);
    let reason = "not found";
    let last: { x: number; y: number } | null = null;
    let scrolled = false;
    while (true) {
      try {
        const id = await this.resolve(target);
        if (!scrolled) { await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: id }).catch(() => {}); scrolled = true; }
        const c = await this.quadCenter(id);
        if (!c) { reason = "not visible"; scrolled = false; }
        else if (!last || Math.abs(last.x - c.x) > 0.5 || Math.abs(last.y - c.y) > 0.5) { reason = "still moving"; last = c; await sleep(30); continue; }
        else {
          const state = await this.callOn(id, `function(x, y, hit, needEnabled){
            const el = this;
            if (needEnabled && (el.disabled || el.closest('[aria-disabled="true"],fieldset[disabled]'))) return 'disabled';
            const st = getComputedStyle(el);
            if (st.visibility === 'hidden' || st.pointerEvents === 'none') return 'not interactable (' + (st.visibility === 'hidden' ? 'hidden' : 'pointer-events:none') + ')';
            if (!hit) return 'ok';
            let e = document.elementFromPoint(x, y);
            while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(x, y); if (!inner || inner === e) break; e = inner; }
            if (!e || el === e || el.contains(e) || e.contains(el)) return 'ok';
            const lab = el.labels && [...el.labels].some(l => l === e || l.contains(e));
            if (lab) return 'ok';
            const d = e.closest('[role],button,a,input,dialog') || e;
            return 'covered by ' + d.tagName.toLowerCase() + (d.id ? '#' + d.id : '') + (d.className && typeof d.className === 'string' ? '.' + d.className.trim().split(/\\s+/)[0] : '') + ' "' + (d.innerText || '').trim().slice(0, 40) + '"';
          }`, [c.x, c.y, opts.hitTest !== false, opts.enabled !== false]);
          if (state === "ok") return { id, ...c };
          reason = state;
        }
      } catch (e: any) {
        reason = e?.message ?? String(e);
        if (/is gone from the page|unknown ref/.test(reason)) throw e;
      }
      if (Date.now() > end) throw new Error(`${target}: ${reason} (waited ${opts.timeoutMs ?? this.actionTimeout} ms)`);
      await sleep(100);
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

  /** After an action: if it started a main-frame navigation, wait for load; then wait for network quiet. */
  async settle(since: number) {
    const tab = this.tab();
    await sleep(30);
    if (tab.navAt >= since) {
      const end = Date.now() + 15_000;
      while (tab.loadAt < tab.navAt && Date.now() < end) await sleep(25);
      tab.refs = newRefTable();
    }
    await this.networkIdle(250, 3000);
  }

  async fill(target: string, text: string) {
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
    await this.networkIdle(200, 1500);
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
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: id }).catch(() => {});
      const { model } = await this.send("DOM.getBoxModel", { backendNodeId: id });
      const xs = model.border.filter((_: number, i: number) => i % 2 === 0), ys = model.border.filter((_: number, i: number) => i % 2 === 1);
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
