// `read`: fetch a page as the text an agent actually wants. Prefer markdown (including
// `llms.txt` docs indexes), then fall back to a small, dependency-free readability pass.
// URL reads never start Chrome; the no-URL form reads the active tab's rendered DOM.

export type ReadOptions = {
  raw?: boolean;
  requireMd?: boolean;
  outline?: boolean;
  filter?: string;
  llms?: "index" | "full";
  timeoutMs?: number;
};

const READ_ACCEPT = "text/markdown, text/plain;q=0.9, text/html;q=0.7, */*;q=0.1";
const USER_AGENT = "monad-browser read";
const MAX_BYTES = 2 * 1024 * 1024;

export function normalizeUrl(input: string): string {
  if (/^([a-z][a-z0-9+.-]*:\/\/|about:|data:|file:|javascript:|blob:)/i.test(input)) return input;
  return (/^(localhost|127\.|\[::1\])/.test(input) ? "http://" : "https://") + input;
}

async function fetchText(url: string, opts: ReadOptions, accept = READ_ACCEPT): Promise<{ body: string; contentType: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: accept, "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`response is larger than ${MAX_BYTES} bytes (${url})`);
    return {
      body: buf.toString("utf8"),
      contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
      finalUrl: res.url || url,
    };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`read timed out after ${opts.timeoutMs ?? 10_000} ms (${url})`);
    throw e;
  } finally { clearTimeout(timer); }
}

const looksMarkdown = (body: string) => /(^|\n)\s{0,3}#{1,6}\s+\S/.test(body) || /(^|\n)\s*[-*]\s+\S/.test(body) || /```/.test(body);

/** Walk ancestors of the page path looking for the nearest llms.txt / llms-full.txt. */
async function nearestLlms(url: string, mode: "index" | "full", opts: ReadOptions): Promise<string | null> {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const name = mode === "full" ? "llms-full.txt" : "llms.txt";
  for (let i = parts.length; i >= 0; i--) {
    const dir = parts.slice(0, i).join("/");
    const href = new URL(`${dir ? `/${dir}` : ""}/${name}`, u.origin).href;
    try {
      const { body, contentType } = await fetchText(href, opts, "text/plain, text/markdown;q=0.9, */*;q=0.1");
      // A catch-all HTML 404 page is not an llms index; keep walking toward the origin.
      if (contentType.includes("text/html")) continue;
      return body;
    } catch { /* try the parent */ }
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", middot: "·",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Turn a page's main content into compact markdown-ish text. No DOM, no dependencies. */
export function htmlToText(html: string, opts: { outline?: boolean } = {}): string {
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|canvas)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|header|footer|aside|form|button|select|textarea)\b[\s\S]*?<\/\1>/gi, "");

  // Prefer the page's main content when the site marks it up.
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1]
    ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body)?.[1];
  if (main) body = main;
  else body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(body)?.[1] ?? body;

  if (opts.outline) {
    const heads: { level: number; text: string }[] = [];
    for (const m of body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
      const text = stripTags(m[2]);
      if (text) heads.push({ level: Number(m[1]), text });
    }
    return heads.map((h) => `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text}`).join("\n");
  }

  let text = body
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\`\`\`\n${stripTags(code)}\n\`\`\`\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code: string) => `\`${stripTags(code)}\``)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n${"#".repeat(Number(level))} ${stripTags(inner)}\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `\n- ${stripTags(inner)}`)
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const label = stripTags(inner);
      return label ? `[${label}](${href})` : "";
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner: string) => `**${stripTags(inner)}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner: string) => `*${stripTags(inner)}*`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|blockquote|figure|figcaption|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Keep only sections whose heading/body contains `needle` (markdown headings delimit sections). */
export function filterSections(text: string, needle: string): string {
  if (!needle) return text;
  const want = needle.toLowerCase();
  const lines = text.split("\n");
  const out: string[] = [];
  let keep = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) keep = line.toLowerCase().includes(want);
    if (keep || line.toLowerCase().includes(want)) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() || text;
}

/** Read a URL. Prefers markdown / llms.txt; HTML is converted to compact text. */
export async function readUrl(input: string, opts: ReadOptions = {}): Promise<string> {
  const url = normalizeUrl(input);
  if (opts.llms) {
    const doc = await nearestLlms(url, opts.llms, opts);
    if (!doc) throw new Error(`no ${opts.llms === "full" ? "llms-full.txt" : "llms.txt"} found near ${url}`);
    const filtered = opts.filter ? filterSections(doc, opts.filter) : doc;
    return opts.outline ? outlineMarkdown(filtered) : filtered;
  }

  let { body, contentType, finalUrl } = await fetchText(url, opts);
  // --raw means exactly what the server returned; do not replace it with a .md twin.
  if (opts.raw) return body;
  const markdown = contentType.includes("text/markdown") || looksMarkdown(body) && !contentType.includes("text/html");
  if (opts.requireMd && !markdown)
    throw new Error(`expected text/markdown from ${url}, got ${contentType || "an unknown content type"}`);

  // A docs server that answers HTML may still have a .md twin.
  if (!markdown && contentType.includes("text/html")) {
    try {
      const mdUrl = finalUrl.endsWith("/") ? `${finalUrl}index.md` : `${finalUrl}.md`;
      const alt = await fetchText(mdUrl, opts);
      if (alt.contentType.includes("text/markdown")) { body = alt.body; contentType = alt.contentType; }
    } catch { /* no twin */ }
  }

  const text = contentType.includes("text/html") ? htmlToText(body, opts) : body;
  const filtered = opts.filter ? filterSections(text, opts.filter) : text;
  return opts.outline ? (contentType.includes("text/html") ? htmlToText(body, { outline: true }) : outlineMarkdown(filtered)) : filtered;
}

/** Headings only, from markdown text. */
export function outlineMarkdown(text: string): string {
  return text.split("\n").filter((l) => /^#{1,6}\s/.test(l)).join("\n");
}
