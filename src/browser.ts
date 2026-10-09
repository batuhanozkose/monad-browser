// Browser session: one CDP connection, a current tab, refs, and the action primitives.
import { CDP } from "./cdp.js";
import { launchChrome, resolveCdpEndpoint, cleanupProfile, type LaunchedChrome } from "./chrome.js";
import { takeSnapshot, newRefTable, type RefTable, type SnapshotOptions } from "./snapshot.js";
import { KEYS, modifierBit } from "./keys.js";

export type BrowserOptions = {
  cdpEndpoint?: string; executable?: string; userDataDir?: string; headful?: boolean;
  block?: string[]; // resource types to block: image, font, media, stylesheet
  proxy?: string;
};

type Tab = { targetId: string; sessionId: string; refs: RefTable; inflight: Set<string>; lastNet: number; url: string; title: string };

const RESOURCE_TYPES: Record<string, string> = { image: "Image", font: "Font", media: "Media", stylesheet: "Stylesheet", css: "Stylesheet" };

export class Browser {
  cdp!: CDP;
  private chrome?: LaunchedChrome;
  private tabs = new Map<string, Tab>();
  current?: Tab;
  private blockTypes: string[] = [];
  private dialogs: string[] = [];
  console: string[] = [];

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
    const tab: Tab = { targetId, sessionId, refs: newRefTable(), inflight: new Set(), lastNet: Date.now(), url: "", title: "" };
    this.tabs.set(targetId, tab);
    const s = sessionId;
    const on = (ev: string, fn: (p: any) => void) => this.cdp.on(ev, (p, sid) => { if (sid === s) fn(p); });
    on("Network.requestWillBeSent", (p) => { if (p.type !== "WebSocket" && p.type !== "EventSource") tab.inflight.add(p.requestId); tab.lastNet = Date.now(); });
    const done = (p: any) => { tab.inflight.delete(p.requestId); tab.lastNet = Date.now(); };
    on("Network.loadingFinished", done);
    on("Network.loadingFailed", done);
    on("Page.frameNavigated", (p) => { if (!p.frame.parentId) { tab.url = p.frame.url; tab.inflight.clear(); } });
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
    const loaded = this.cdp.waitFor("Page.lifecycleEvent", { sessionId: tab.sessionId, timeoutMs, predicate: (p) => p.name === "load" });
    loaded.catch(() => {});
    const res = await this.send("Page.navigate", { url });
    if (res.errorText) throw new Error(`navigation failed: ${res.errorText} (${url})`);
    if (res.loaderId) await loaded.catch(() => { /* slow load: fall through to idle wait */ });
    await this.networkIdle(400, 4000);
    tab.refs = newRefTable();
    return this.info();
  }

  async info() {
    const r = await this.evaluate("({url: location.href, title: document.title})");
    return r as { url: string; title: string };
  }

  async evaluate(expression: string, awaitPromise = true) {
    const src = /^\s*(return\b|await\b|const\b|let\b|for\b|if\b)/.test(expression) || /;\s*\S/.test(expression)
      ? `(async () => { ${/\breturn\b/.test(expression) ? expression : `return (${expression})`} })()`
      : expression;
    const r: any = await this.send("Runtime.evaluate", { expression: src, awaitPromise, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }

  async snapshot(opts: SnapshotOptions = {}) {
    const tab = this.tab();
    const res = await takeSnapshot(this.cdp, tab.sessionId, tab.refs, opts);
    const { url, title } = await this.info();
    const extra: string[] = [];
    if (this.dialogs.length) extra.push(`dialogs: ${this.dialogs.splice(0).join(" | ")}`);
    return `# ${title} — ${url}\n${extra.length ? extra.join("\n") + "\n" : ""}${res.text}`;
  }

  /** Resolve `@N`, `N`, or a CSS selector to a backendNodeId. */
  async resolve(target: string): Promise<number> {
    const tab = this.tab();
    const m = /^@?e?(\d+)$/.exec(target.trim());
    if (m) {
      const ref = tab.refs.byRef.get(Number(m[1]));
      if (!ref) throw new Error(`unknown ref @${m[1]} — take a fresh snapshot`);
      return ref.backendNodeId;
    }
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector: target });
    if (!nodeId) throw new Error(`no element matches selector: ${target}`);
    const { node } = await this.send("DOM.describeNode", { nodeId });
    return node.backendNodeId;
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

  private async center(backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    for (let i = 0; i < 10; i++) {
      try {
        const { quads } = await this.send("DOM.getContentQuads", { backendNodeId });
        if (quads?.length) {
          const q = quads[0];
          const x = (q[0] + q[2] + q[4] + q[6]) / 4, y = (q[1] + q[3] + q[5] + q[7]) / 4;
          return { x, y };
        }
      } catch { /* not laid out yet */ }
      await sleep(100);
    }
    throw new Error("element is not visible (no layout box)");
  }

  async click(target: string, opts: { button?: "left" | "right" | "middle"; count?: number } = {}) {
    const id = await this.resolve(target);
    const { x, y } = await this.center(id);
    // Hit-test: if something covers the point, report it rather than clicking the wrong thing silently.
    const covered = await this.callOn(id, `function(x, y){ const e = document.elementFromPoint(x, y); if (!e || this === e || this.contains(e) || e.contains(this)) return null; const d = e.closest('[role],button,a,input') || e; return (d.tagName.toLowerCase() + (d.id ? '#' + d.id : '') + ' "' + (d.innerText||'').trim().slice(0,40) + '"'); }`, [x, y]).catch(() => null);
    if (covered) throw new Error(`click target is covered by ${covered} — close it or use 'eval'`);
    const button = opts.button ?? "left";
    const clickCount = opts.count ?? 1;
    const tab = this.tab();
    const before = tab.url;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
    await this.settle(before);
  }

  /** After an action: give the page a moment to start navigating/fetching, then wait for quiet. */
  async settle(beforeUrl?: string) {
    await sleep(60);
    const tab = this.tab();
    if (beforeUrl !== undefined && tab.url !== beforeUrl) {
      await this.cdp.waitFor("Page.lifecycleEvent", { sessionId: tab.sessionId, timeoutMs: 10_000, predicate: (p) => p.name === "load" }).catch(() => {});
    }
    await this.networkIdle(300, 3000);
  }

  async fill(target: string, text: string) {
    const id = await this.resolve(target);
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: id }).catch(() => {});
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
    const tab = this.tab();
    const before = tab.url;
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers };
    const text = modifiers & ~8 ? undefined : def.text; // no text when Ctrl/Alt/Meta held
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text, unmodifiedText: text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await this.settle(before);
  }

  async hover(target: string) {
    const { x, y } = await this.center(await this.resolve(target));
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

  async back() { const b = this.tab().url; await this.evaluate("history.back()"); await this.settle(b + "#"); }
  async forward() { const b = this.tab().url; await this.evaluate("history.forward()"); await this.settle(b + "#"); }
  async reload() { const b = this.tab().url; await this.send("Page.reload", {}); await this.settle(b + "#"); }

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
