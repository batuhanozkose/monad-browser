// Dependency-free HTML + CSS extraction for watchers. `read`'s markdown pass is used for
// whole-page text; this file only exists because `css:<selector>` needs a DOM-ish query without
// pulling in a runtime dependency.
import { decodeEntities, htmlToText } from "./read.js";

export type HtmlNode = {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlNode | string)[];
  parent?: HtmlNode;
};

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "noscript", "template"]);
const SKIP_TEXT = new Set(["script", "style", "noscript", "template", "head"]);
const AUTO_CLOSE: Record<string, string[]> = {
  li: ["li"], p: ["p"], tr: ["tr"], td: ["td", "th"], th: ["th", "td"], option: ["option"], dt: ["dt", "dd"], dd: ["dd", "dt"],
};
const BLOCK_STOP = new Set(["ul", "ol", "table", "select", "dl", "div", "body", "html"]);

const isNode = (x: HtmlNode | string): x is HtmlNode => typeof x !== "string";
const norm = (s: string) => s.replace(/[ \t\f\v]+/g, " ").replace(/\s+/g, " ").trim();

/** Index of the `>` that ends a tag, skipping quoted attribute values. */
function tagEnd(s: string, start: number): number {
  let quote = "";
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const name = m[1].toLowerCase();
    if (name) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function addText(stack: HtmlNode[], raw: string) {
  if (!raw) return;
  const text = decodeEntities(raw);
  if (!text) return;
  const parent = stack[stack.length - 1];
  const last = parent.children[parent.children.length - 1];
  if (typeof last === "string") parent.children[parent.children.length - 1] = last + text;
  else parent.children.push(text);
}

function popTo(stack: HtmlNode[], tag: string) {
  for (let i = stack.length - 1; i > 0; i--) {
    if (stack[i].tag === tag) { stack.length = i; return; }
  }
}

/** Parse enough HTML to query it: tags, attributes, text, comments and raw-text elements. */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlNode[] = [root];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { addText(stack, html.slice(i)); break; }
    if (lt > i) addText(stack, html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt + 9);
      addText(stack, end < 0 ? html.slice(lt + 9) : html.slice(lt + 9, end));
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (!/[a-zA-Z!/]/.test(html[lt + 1] ?? "")) {
      // A bare `<` in text (`2 < 3`) is not a tag.
      addText(stack, "<");
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt + 1);
    if (end < 0) { addText(stack, html.slice(lt)); break; }
    const raw = html.slice(lt + 1, end).trim();
    i = end + 1;
    if (!raw) continue;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().split(/\s+/)[0].toLowerCase();
      if (name) popTo(stack, name);
      continue;
    }
    const self = raw.endsWith("/");
    const body = self ? raw.slice(0, -1).trim() : raw;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const node: HtmlNode = { tag, attrs: parseAttrs(m[2]), children: [], parent: stack[stack.length - 1] };
    const auto = AUTO_CLOSE[tag];
    if (auto) {
      for (let j = stack.length - 1; j > 0; j--) {
        const t = stack[j].tag;
        if (auto.includes(t)) { stack.length = j; break; }
        if (BLOCK_STOP.has(t)) break;
      }
    }
    stack[stack.length - 1].children.push(node);
    if (self || VOID.has(tag)) continue;
    stack.push(node);
    if (RAW.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "i").exec(html.slice(i));
      if (!close) {
        addText(stack, html.slice(i));
        i = html.length;
      } else {
        addText(stack, html.slice(i, i + close.index));
        i += close.index + close[0].length;
      }
      stack.pop();
    }
  }
  return root;
}

/** Visible text of a node. Raw-text elements never contribute. */
export function htmlText(node: HtmlNode): string {
  if (SKIP_TEXT.has(node.tag)) return "";
  if (node.tag === "br") return " ";
  let out = "";
  for (const child of node.children) out += typeof child === "string" ? child : htmlText(child) + " ";
  return out;
}

function walk(node: HtmlNode, fn: (n: HtmlNode) => void) {
  for (const child of node.children) {
    if (!isNode(child)) continue;
    fn(child);
    walk(child, fn);
  }
}

// ---- selectors -----------------------------------------------------------------------------

type AttrSel = { name: string; op?: string; value?: string };
type Pseudo = { name: string; arg?: string };
type Simple = { tag?: string; id?: string; classes: string[]; attrs: AttrSel[]; pseudos: Pseudo[] };
type Combinator = " " | ">" | "+" | "~";
type Step = { combinator: Combinator | null; simple: Simple };

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0, depth = 0, quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

function closing(s: string, start: number): number {
  let depth = 1, quote = "";
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`invalid CSS selector: missing closing bracket in "${s}"`);
}

function ident(s: string, i: number): [string, number] {
  let out = "";
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      if (i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
      break;
    }
    if (/[\s>+~,.#:[\]()]/.test(ch)) break;
    out += ch;
    i++;
  }
  return [out, i];
}

function parseAttr(raw: string): AttrSel {
  const m = /^([^\s~|^$*=]+)\s*(?:(~=|\|=|\^=|\$=|\*=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?$/.exec(raw.trim());
  if (!m) throw new Error(`invalid CSS attribute selector: [${raw}]`);
  return { name: m[1].toLowerCase(), op: m[2], value: m[3] ?? m[4] ?? m[5] };
}

function parseCompound(s: string, i: number): [Simple, number] {
  const simple: Simple = { classes: [], attrs: [], pseudos: [] };
  let any = false;
  if (s[i] === "*") { simple.tag = "*"; i++; any = true; }
  else if (s[i] && !/[#.\[:\s>+~,]/.test(s[i])) {
    const [tag, ni] = ident(s, i);
    if (!tag) throw new Error(`invalid CSS selector near "${s.slice(i)}"`);
    simple.tag = tag.toLowerCase();
    i = ni;
    any = true;
  }
  while (i < s.length) {
    const ch = s[i];
    if (ch === "#") {
      const [id, ni] = ident(s, i + 1);
      if (!id) throw new Error("invalid CSS selector: empty id");
      simple.id = id; i = ni; any = true;
    } else if (ch === ".") {
      const [cls, ni] = ident(s, i + 1);
      if (!cls) throw new Error("invalid CSS selector: empty class");
      simple.classes.push(cls); i = ni; any = true;
    } else if (ch === "[") {
      const end = closing(s, i + 1);
      simple.attrs.push(parseAttr(s.slice(i + 1, end)));
      i = end + 1; any = true;
    } else if (ch === ":") {
      const [name, ni] = ident(s, i + 1);
      if (!name) throw new Error("invalid CSS selector: empty pseudo-class");
      i = ni;
      let arg: string | undefined;
      if (s[i] === "(") {
        const end = closing(s, i + 1);
        arg = s.slice(i + 1, end).trim();
        i = end + 1;
      }
      simple.pseudos.push({ name: name.toLowerCase(), arg });
      any = true;
    } else break;
  }
  if (!any) throw new Error(`invalid CSS selector near "${s.slice(i)}"`);
  return [simple, i];
}

function parseGroup(raw: string): Step[] {
  const steps: Step[] = [];
  let i = 0, pending: Combinator | null = null, first = true;
  while (i < raw.length) {
    let space = false;
    while (i < raw.length && /\s/.test(raw[i])) { i++; space = true; }
    if (i >= raw.length) break;
    if (raw[i] === ">" || raw[i] === "+" || raw[i] === "~") {
      if (first) throw new Error(`invalid CSS selector: leading combinator in "${raw}"`);
      pending = raw[i] as Combinator;
      i++;
      while (i < raw.length && /\s/.test(raw[i])) i++;
    } else if (!first && space) {
      pending ??= " ";
    }
    if (i >= raw.length) throw new Error(`invalid CSS selector: trailing combinator in "${raw}"`);
    const [simple, ni] = parseCompound(raw, i);
    steps.push({ combinator: first ? null : (pending ?? " "), simple });
    pending = null;
    first = false;
    i = ni;
  }
  if (!steps.length) throw new Error("CSS selector is empty");
  return steps;
}

/** Parse a selector group (comma-separated). Exported for create-time validation and tests. */
export function parseSelector(raw: string): Step[][] {
  const text = raw.trim();
  if (!text) throw new Error("CSS selector is empty");
  if (Buffer.byteLength(text) > 512) throw new Error("CSS selector is longer than 512 bytes");
  return splitTop(text, ",").map((g) => {
    const group = g.trim();
    if (!group) throw new Error(`invalid CSS selector: empty group in "${raw}"`);
    return parseGroup(group);
  });
}

function attrMatches(node: HtmlNode, a: AttrSel): boolean {
  const value = node.attrs[a.name];
  if (value === undefined) return false;
  if (!a.op) return true;
  const want = a.value ?? "";
  switch (a.op) {
    case "=": return value === want;
    case "~=": return value.split(/\s+/).includes(want);
    case "|=": return value === want || value.startsWith(want + "-");
    case "^=": return value.startsWith(want);
    case "$=": return value.endsWith(want);
    case "*=": return value.includes(want);
    default: return false;
  }
}

function nth(n: number, arg: string): boolean {
  const a = arg.trim().toLowerCase();
  if (a === "odd") return n % 2 === 1;
  if (a === "even") return n % 2 === 0;
  if (/^[+-]?\d+$/.test(a)) return n === Number(a);
  const m = /^([+-]?\d*)n\s*([+-]\s*\d+)?$/.exec(a.replace(/\s+/g, ""));
  if (!m) throw new Error(`unsupported :nth-child argument: ${arg}`);
  const step = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
  const offset = m[2] ? Number(m[2].replace(/\s+/g, "")) : 0;
  if (step === 0) return n === offset;
  const k = (n - offset) / step;
  return Number.isInteger(k) && k >= 0;
}

function siblings(node: HtmlNode): HtmlNode[] {
  if (!node.parent) return [node];
  return node.parent.children.filter(isNode);
}

function pseudoMatches(node: HtmlNode, p: Pseudo): boolean {
  const sibs = siblings(node);
  const idx = sibs.indexOf(node);
  switch (p.name) {
    case "first-child": return idx === 0;
    case "last-child": return idx === sibs.length - 1;
    case "only-child": return sibs.length === 1;
    case "empty": return node.children.every((c) => typeof c === "string" ? c.trim() === "" : false);
    case "nth-child": return nth(idx + 1, p.arg ?? "");
    case "not": {
      const [inner, end] = parseCompound(p.arg ?? "", 0);
      if (end !== (p.arg ?? "").length) throw new Error(`unsupported :not() argument: ${p.arg}`);
      return !matchesSimple(node, inner);
    }
    default: throw new Error(`unsupported CSS pseudo-class :${p.name}`);
  }
}

function matchesSimple(node: HtmlNode, s: Simple): boolean {
  if (s.tag && s.tag !== "*" && node.tag !== s.tag) return false;
  if (s.id && node.attrs.id !== s.id) return false;
  if (s.classes.length) {
    const have = (node.attrs.class ?? "").split(/\s+/).filter(Boolean);
    for (const c of s.classes) if (!have.includes(c)) return false;
  }
  for (const a of s.attrs) if (!attrMatches(node, a)) return false;
  for (const p of s.pseudos) if (!pseudoMatches(node, p)) return false;
  return true;
}

function prevElement(node: HtmlNode): HtmlNode | undefined {
  if (!node.parent) return undefined;
  const kids = node.parent.children;
  let at = kids.indexOf(node);
  for (let i = at - 1; i >= 0; i--) if (isNode(kids[i])) return kids[i] as HtmlNode;
  return undefined;
}

function matchesAt(node: HtmlNode, group: Step[], idx: number): boolean {
  if (!matchesSimple(node, group[idx].simple)) return false;
  if (idx === 0) return true;
  const comb = group[idx].combinator;
  if (comb === ">") return node.parent ? matchesAt(node.parent, group, idx - 1) : false;
  if (comb === " ") {
    for (let p = node.parent; p; p = p.parent) if (matchesAt(p, group, idx - 1)) return true;
    return false;
  }
  if (comb === "+") {
    const prev = prevElement(node);
    return prev ? matchesAt(prev, group, idx - 1) : false;
  }
  if (comb === "~") {
    for (let prev = prevElement(node); prev; prev = prevElement(prev)) if (matchesAt(prev, group, idx - 1)) return true;
    return false;
  }
  return false;
}

/** All descendants matching a CSS selector, in document order, de-duplicated. */
export function querySelectorAll(root: HtmlNode, selector: string): HtmlNode[] {
  const groups = parseSelector(selector);
  const out: HtmlNode[] = [];
  const seen = new Set<HtmlNode>();
  walk(root, (node) => {
    if (seen.has(node)) return;
    if (groups.some((g) => matchesAt(node, g, g.length - 1))) {
      seen.add(node);
      out.push(node);
    }
  });
  return out;
}

// ---- extraction ----------------------------------------------------------------------------

function looksHtml(body: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("html")) return true;
  if (ct.startsWith("text/plain") || ct.includes("json") || ct.includes("xml")) return false;
  const head = body.slice(0, 512).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html") || head.includes("<body") || head.includes("<main");
}

function normalizeLines(s: string): string {
  return s.replace(/\r\n?/g, "\n").split("\n").map(norm).filter(Boolean).join("\n");
}

/** `read` returns markdown; watchers compare content, so strip formatting that is not content. */
function plainMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^```.*$/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1$2")
    .replace(/^[-*]\s+/gm, "")
    .replace(/^>\s?/gm, "");
}

/** Main text of a page (or the body itself for plain text). */
export function extractText(body: string, contentType: string): string {
  if (!looksHtml(body, contentType)) return normalizeLines(body);
  return normalizeLines(plainMarkdown(htmlToText(body)));
}

/** Text of every element matching `selector`, one per line. */
export function extractCss(body: string, selector: string): string {
  const nodes = querySelectorAll(parseHtml(body), selector);
  if (!nodes.length) throw new Error("the CSS selector matched nothing on the page");
  return nodes.slice(0, 200).map((n) => norm(htmlText(n))).join("\n");
}
