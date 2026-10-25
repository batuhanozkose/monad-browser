// RSS 2.0 / RSS 1.0 (RDF) / Atom parsing without a runtime dependency. Feeds are watched as
// "title — link" lines, so a new line is a new entry.
import { decodeEntities } from "./read.js";

export type FeedEntry = { id: string; title: string; link: string };

type XmlNode = { name: string; attrs: Record<string, string>; children: (XmlNode | string)[] };

const isNode = (x: XmlNode | string): x is XmlNode => typeof x !== "string";
const local = (name: string) => name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function tagEnd(s: string, start: number): number {
  let quote = "";
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = ""; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

/** A forgiving XML parser: enough for feeds, never resolves external entities. */
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  const text = (raw: string) => {
    if (!raw) return;
    const value = decodeEntities(raw);
    if (!value) return;
    const parent = stack[stack.length - 1];
    const last = parent.children[parent.children.length - 1];
    if (typeof last === "string") parent.children[parent.children.length - 1] = last + value;
    else parent.children.push(value);
  };
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) { text(xml.slice(i)); break; }
    if (lt > i) text(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) { stack[stack.length - 1].children.push(xml.slice(lt + 9)); break; }
      stack[stack.length - 1].children.push(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      i = end < 0 ? xml.length : end + 1;
      continue;
    }
    const end = tagEnd(xml, lt + 1);
    if (end < 0) { text(xml.slice(lt)); break; }
    const raw = xml.slice(lt + 1, end).trim();
    i = end + 1;
    if (!raw) continue;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().split(/\s+/)[0];
      for (let j = stack.length - 1; j > 0; j--) {
        if (stack[j].name === name) { stack.length = j; break; }
      }
      continue;
    }
    const self = raw.endsWith("/");
    const body = self ? raw.slice(0, -1).trim() : raw;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
    if (!m) continue;
    const node: XmlNode = { name: m[1], attrs: attrs(m[2]), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  return root;
}

const nodes = (n: XmlNode, name: string): XmlNode[] =>
  n.children.filter((c): c is XmlNode => isNode(c) && local(c.name) === name);
const first = (n: XmlNode, name: string): XmlNode | undefined => nodes(n, name)[0];

function textOf(n?: XmlNode): string {
  if (!n) return "";
  let out = "";
  for (const c of n.children) out += typeof c === "string" ? c : textOf(c) + " ";
  return norm(out);
}

/** Parse RSS 2.0, RSS 1.0 (RDF) or Atom; entries stay in document order. */
export function parseFeed(body: string, limit = 20): FeedEntry[] {
  const doc = parseXml(body);
  const root = doc.children.find(isNode);
  if (!root) throw new Error("response is not an RSS or Atom feed");
  const kind = local(root.name).toLowerCase();
  let out: FeedEntry[] = [];
  if (kind === "rss") {
    const channel = first(root, "channel") ?? root;
    out = nodes(channel, "item").map((item) => ({
      id: textOf(first(item, "guid")),
      title: textOf(first(item, "title")),
      link: textOf(first(item, "link")),
    }));
  } else if (kind === "feed") {
    out = nodes(root, "entry").map((entry) => {
      const links = nodes(entry, "link");
      let link = "";
      for (const l of links) {
        const rel = l.attrs.rel ?? "";
        if (!rel || rel === "alternate") { link = l.attrs.href ?? ""; break; }
      }
      if (!link && links[0]) link = links[0].attrs.href ?? "";
      return { id: textOf(first(entry, "id")), title: textOf(first(entry, "title")), link: norm(link) };
    });
  } else if (kind === "rdf") {
    out = nodes(root, "item").map((item) => ({
      id: norm(item.attrs.about ?? ""),
      title: textOf(first(item, "title")),
      link: textOf(first(item, "link")),
    }));
  } else {
    throw new Error(`not an RSS or Atom feed (root element "${local(root.name)}")`);
  }
  for (const e of out) if (!e.id) e.id = e.link || e.title;
  return limit > 0 ? out.slice(0, limit) : out;
}

/** Render feed entries as the value that is hashed and diffed. */
export function feedValue(entries: FeedEntry[]): string {
  return entries.map((e) => {
    const title = e.title || e.id;
    return norm(e.link && e.link !== title ? `${title} — ${e.link}` : title);
  }).filter(Boolean).join("\n");
}
