import { execFile } from "node:child_process";
import { startProxyRelay } from "../dist/proxy-relay.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getEncoding } from "js-tiktoken";
export const CHROME = "/workspace/tools/chromium/chromium";
export const PROXY_PORT = 18080;
export const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
export const BIN = new URL("./node_modules/.bin/", import.meta.url).pathname;
const enc = getEncoding("o200k_base");
export const tok = (s) => enc.encode(s ?? "").length;
let relayServer;
export async function relay() {
  if (relayServer) return;
  const u = new URL(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
  ({ server: relayServer } = await startProxyRelay({ host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }, PROXY_PORT));
}
export const cleanEnv = () => { const e = { ...process.env }; for (const k of ["HTTPS_PROXY","HTTP_PROXY","https_proxy","http_proxy","ALL_PROXY","all_proxy"]) delete e[k]; return e; };
export function sh(cmd, args, { env = {}, input, timeout = 90000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const p = execFile(cmd, args, { env: { ...cleanEnv(), ...env }, timeout, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      resolve({ ms: performance.now() - t0, out: String(stdout), err: String(stderr), code: err ? (err.code ?? 1) : 0 });
    });
    if (input !== undefined) { p.stdin.end(input); }
  });
}
export async function mcp(command, args, env = {}) {
  const transport = new StdioClientTransport({ command, args, env: { ...cleanEnv(), ...env }, stderr: "ignore" });
  const client = new Client({ name: "bench", version: "1" });
  const t0 = performance.now();
  await client.connect(transport);
  const { tools } = await client.listTools();
  return {
    client, tools, connectMs: performance.now() - t0,
    async call(name, args = {}) {
      const t = performance.now();
      let r;
      try { r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 }); }
      catch (e) { return { ms: performance.now() - t, out: String(e?.message ?? e), error: true }; }
      const out = (r.content ?? []).map((c) => c.type === "text" ? c.text : `[${c.type}]`).join("\n");
      return { ms: performance.now() - t, out, error: !!r.isError };
    },
    close: () => client.close(),
  };
}
export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
export const FIX = "http://127.0.0.1:18081";
let fixServer;
export async function fixtures() {
  if (fixServer) return;
  const root = new URL("../test/fixtures/", import.meta.url).pathname;
  fixServer = createServer((req, res) => {
    const p = root + (req.url.split("?")[0].replace(/^\//, "") || "form.html");
    if (!existsSync(p)) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, { "content-type": p.endsWith(".html") ? "text/html" : "text/plain" });
    res.end(readFileSync(p));
  });
  await new Promise((r) => fixServer.listen(18081, "127.0.0.1", r));
}
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
export async function chromeOnPort(port = 9333) {
  const dir = mkdtempSync(tmpdir() + "/bchrome-");
  const p = spawn(CHROME, ["--headless=new", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, `--proxy-server=${PROXY}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  return p;
}
