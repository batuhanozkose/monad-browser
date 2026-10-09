// Minimal CDP client over the browser-level WebSocket, using flattened sessions.
// Uses Node >=22's built-in WebSocket; no dependencies.

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };
type Listener = (params: any, sessionId?: string) => void;

export class CDPError extends Error {
  constructor(public method: string, public code: number, message: string) {
    super(`${method}: ${message}`);
  }
}

export class CDP {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<Listener>>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => this.onMessage(String((ev as MessageEvent).data)));
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`CDP socket closed (${p.method})`));
      this.pending.clear();
      this.emit("__close", {});
    });
  }

  static connect(wsUrl: string, timeoutMs = 10_000): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const t = setTimeout(() => { ws.close(); reject(new Error(`CDP connect timeout: ${wsUrl}`)); }, timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(new CDP(ws)); });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new Error(`CDP connect failed: ${wsUrl}`)); });
    });
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection is closed"));
    const id = this.nextId++;
    const msg: any = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Resolve on the next matching event (optionally filtered by session/predicate). */
  waitFor(event: string, opts: { sessionId?: string; timeoutMs?: number; predicate?: (p: any) => boolean } = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const off = this.on(event, (params, sid) => {
        if (opts.sessionId && sid !== opts.sessionId) return;
        if (opts.predicate && !opts.predicate(params)) return;
        off(); clearTimeout(timer); resolve(params);
      });
      const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${event}`)); }, opts.timeoutMs ?? 30_000);
    });
  }

  private emit(event: string, params: any, sessionId?: string) {
    const set = this.listeners.get(event);
    if (set) for (const fn of [...set]) { try { fn(params, sessionId); } catch { /* listener errors are isolated */ } }
  }

  private onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CDPError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) this.emit(msg.method, msg.params ?? {}, msg.sessionId);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
