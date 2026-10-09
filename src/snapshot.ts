// Compact page snapshot: Accessibility tree merged with DOMSnapshot layout/cursor data.
// Interactive nodes get stable `@N` refs (stable per backend DOM node for the life of the tab).
import type { CDP } from "./cdp.js";

export const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider",
  "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "treeitem",
  "listbox", "textarea", "ListBoxOption", "MenuListOption", "colorwell", "date", "time",
]);
const SKIP_ROLES = new Set(["none", "presentation", "InlineTextBox", "LineBreak", "ignored"]);
const TRANSPARENT_ROLES = new Set(["generic", "GenericContainer", "group", "Section", "paragraph", "div", "Pre", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Iframe", "IframePresentational", "RootWebArea", "WebArea", "main", "article", "region"]);
const STRUCTURAL_KEEP = new Set(["heading", "navigation", "main", "form", "dialog", "alertdialog", "alert", "list", "table", "row", "banner", "contentinfo", "search", "complementary", "menu", "menubar", "tablist", "tree", "grid", "img", "image", "status"]);
const STATE_PROPS = ["checked", "selected", "expanded", "pressed", "disabled", "required", "invalid", "readonly", "focused", "level", "valuetext"];

/** A DOM node: the CDP session that owns it, its backend id, and the <iframe> hosting its document (none = top document). */
export type El = { sid: string; bid: number; owner?: El };
export const elKey = (e: El) => `${e.sid}:${e.bid}`;

export type RefTable = {
  byBackend: Map<string, number>;
  byRef: Map<number, { el: El; role: string; name: string }>;
  next: number;
};
export const newRefTable = (): RefTable => ({ byBackend: new Map(), byRef: new Map(), next: 1 });

type AXNode = {
  nodeId: string; parentId?: string; childIds?: string[]; ignored?: boolean;
  role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[]; backendDOMNodeId?: number;
};

type DomInfo = { visible: boolean; pointer: boolean; tag?: string; href?: string };

/** High enough that real pages (Wikipedia ~660 lines, MDN ~1060) are never cut; only runaway pages are. */
export const DEFAULT_MAX_LINES = 2000;
export type SnapshotOptions = { interactive?: boolean; maxText?: number; maxLines?: number; compact?: boolean; maxInline?: number; maxProse?: number };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

async function domInfo(cdp: CDP, sessionId: string): Promise<Map<number, DomInfo>> {
  const out = new Map<number, DomInfo>();
  const snap: any = await cdp.send("DOMSnapshot.captureSnapshot", {
    computedStyles: ["cursor", "visibility", "opacity"],
    includeDOMRects: false,
  }, sessionId);
  const strings: string[] = snap.strings;
  for (const doc of snap.documents ?? []) {
    const nodes = doc.nodes;
    const backend: number[] = nodes.backendNodeId ?? [];
    const names: number[] = nodes.nodeName ?? [];
    for (let i = 0; i < backend.length; i++) out.set(backend[i], { visible: false, pointer: false, tag: strings[names[i]]?.toLowerCase() });
    const layoutIdx: number[] = doc.layout?.nodeIndex ?? [];
    const styles: number[][] = doc.layout?.styles ?? [];
    const bounds: number[][] = doc.layout?.bounds ?? [];
    for (let j = 0; j < layoutIdx.length; j++) {
      const info = out.get(backend[layoutIdx[j]]);
      if (!info) continue;
      const [cursor, visibility, opacity] = (styles[j] ?? []).map((k) => strings[k]);
      const b = bounds[j] ?? [0, 0, 0, 0];
      info.visible = visibility !== "hidden" && opacity !== "0" && b[2] > 0 && b[3] > 0;
      info.pointer = cursor === "pointer";
    }
  }
  return out;
}

type Doc = { sid: string; owner?: El; nodes: AXNode[]; byId: Map<string, AXNode>; dom: Map<number, DomInfo> };

/**
 * Load the top document plus every iframe document, same-process (by frameId) or out-of-process
 * (its own session from `oopifs`), keyed by the hosting <iframe> element.
 */
async function loadDocs(cdp: CDP, mainSid: string, oopifs: Map<string, string>) {
  const domCache = new Map<string, Promise<Map<number, DomInfo>>>();
  const domFor = (sid: string) => { let d = domCache.get(sid); if (!d) { d = domInfo(cdp, sid).catch(() => new Map()); domCache.set(sid, d); } return d; };
  const load = async (sid: string, frameId: string | undefined, owner?: El): Promise<Doc> => {
    const [{ nodes }, dom] = await Promise.all([
      cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", frameId ? { frameId } : {}, sid),
      domFor(sid),
    ]);
    return { sid, owner, nodes, byId: new Map(nodes.map((n) => [n.nodeId, n])), dom };
  };
  const frames = new Map<string, Doc>();
  const children = async (sid: string, node: any, parentOwner: El | undefined, depth: number): Promise<void> => {
    if (depth > 4) return;
    await Promise.all((node.childFrames ?? []).map(async (child: any) => {
      try {
        const { backendNodeId } = await cdp.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: child.frame.id }, sid);
        const owner: El = { sid, bid: backendNodeId, owner: parentOwner };
        const oop = oopifs.get(child.frame.id);
        if (oop) {
          frames.set(elKey(owner), await load(oop, undefined, owner));
          const { frameTree } = await cdp.send<any>("Page.getFrameTree", {}, oop);
          await children(oop, frameTree, owner, depth + 1);
        } else {
          frames.set(elKey(owner), await load(sid, child.frame.id, owner));
          await children(sid, child, owner, depth + 1);
        }
      } catch { /* frame detached mid-snapshot */ }
    }));
  };
  const [main, { frameTree }] = await Promise.all([load(mainSid, undefined), cdp.send<any>("Page.getFrameTree", {}, mainSid)]);
  await children(mainSid, frameTree, undefined, 0);
  // Out-of-process frames are missing from their parent's frame tree: find each one's <iframe> host in an already-loaded session.
  const docs = () => [main, ...frames.values()];
  const loaded = new Set([...frames.values()].map((d) => d.sid));
  for (let pass = 0; pass < 4; pass++) {
    let progress = false;
    for (const [frameId, oop] of oopifs) {
      if (loaded.has(oop)) continue;
      for (const sid of new Set(docs().map((d) => d.sid))) {
        const r = await cdp.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId }, sid).catch(() => null);
        if (!r?.backendNodeId) continue;
        const host = docs().find((d) => d.sid === sid && d.nodes.some((n) => n.backendDOMNodeId === r.backendNodeId));
        const owner: El = { sid, bid: r.backendNodeId, owner: host?.owner };
        try {
          frames.set(elKey(owner), await load(oop, undefined, owner));
          const { frameTree: ft } = await cdp.send<any>("Page.getFrameTree", {}, oop);
          await children(oop, ft, owner, 1);
        } catch { /* gone */ }
        loaded.add(oop); progress = true;
        break;
      }
    }
    if (!progress) break;
  }
  return { main, frames };
}

export async function takeSnapshot(cdp: CDP, sessionId: string, refs: RefTable, opts: SnapshotOptions = {}, oopifs = new Map<string, string>()): Promise<{ text: string; refCount: number; lines: number }> {
  const maxText = opts.maxText ?? 80;
  const { main, frames } = await loadDocs(cdp, sessionId, oopifs);
  // Current document while walking; swapped when descending into an iframe.
  let { byId, dom, sid: curSid, owner: curOwner } = main;
  const root = main.nodes.find((n) => !n.parentId) ?? main.nodes[0];
  const lines: string[] = [];
  let refCount = 0;

  const refFor = (backendNodeId: number, role: string, name: string) => {
    const el: El = { sid: curSid, bid: backendNodeId, owner: curOwner };
    const key = elKey(el);
    let r = refs.byBackend.get(key);
    if (!r) { r = refs.next++; refs.byBackend.set(key, r); }
    refs.byRef.set(r, { el, role, name });
    refCount++;
    return r;
  };

  const props = (n: AXNode) => {
    const parts: string[] = [];
    for (const p of n.properties ?? []) {
      if (!STATE_PROPS.includes(p.name)) continue;
      const v = p.value?.value;
      if (v === false || v === undefined || v === "false") continue;
      if (p.name === "focused") parts.push("focused");
      else parts.push(v === true || v === "true" ? p.name : `${p.name}=${v}`);
    }
    return parts;
  };

  const textOf = (n: AXNode, budget = 120): string => {
    let acc = "";
    const rec = (m: AXNode | undefined) => {
      if (!m || acc.length >= budget) return;
      if (m.role?.value === "StaticText") { const t = norm(m.name?.value); if (t) acc += (acc ? " " : "") + t; return; }
      for (const c of m.childIds ?? []) rec(byId.get(c));
    };
    rec(n);
    return acc;
  };

  const BLOCK_ROLES = new Set(["heading", "list", "table", "form", "dialog", "alertdialog", "navigation", "banner", "contentinfo", "main", "article", "region", "complementary", "search", "menu", "menubar", "tablist", "tree", "grid", "listbox", "combobox", "radiogroup", "toolbar", "Iframe", "RootWebArea", "WebArea", "figure", "rowgroup"]);
  const INLINE_MAX = opts.maxInline ?? 220;
  const PROSE_ROLES = new Set(["paragraph", "listitem", "cell", "gridcell", "blockquote", "LabelText", "caption", "definition", "term", "DescriptionListDetail", "DescriptionListTerm", "figcaption"]);

  /** Render a subtree as one line with inline refs: `text [label]@N text`. Returns null if it holds block structure. */
  const inline = (n: AXNode, inPointer: boolean, top = true, max = INLINE_MAX): { s: string; parts: number } | null => {
    const role = n.role?.value ?? "";
    const name = norm(n.name?.value);
    const info = n.backendDOMNodeId ? dom.get(n.backendDOMNodeId) : undefined;
    if (!top && BLOCK_ROLES.has(role)) return null;
    if (n.ignored || SKIP_ROLES.has(role) || (info && !info.visible && dom.size)) {
      return joinKids(n, inPointer, " ", max);
    }
    if (role === "StaticText") return name ? { s: name, parts: 1 } : { s: "", parts: 0 };
    const pointerOnly = !INTERACTIVE_ROLES.has(role) && !!info?.pointer;
    if (!top && n.backendDOMNodeId && (INTERACTIVE_ROLES.has(role) || (pointerOnly && !inPointer))) {
      const label = name || textOf(n);
      if (pointerOnly && !label) return joinKids(n, true, " ", max);
      const shownRole = pointerOnly ? "clickable" : role;
      const r = refFor(n.backendDOMNodeId, shownRole, label);
      const val = n.value?.value;
      const st = props(n).filter((x) => x !== "focused");
      const kind = role === "link" || pointerOnly ? "" : `${role}${label ? " " : ""}`;
      let body = `${kind}${label ? clip(label, maxText) : role}`;
      if (val !== undefined && val !== "" && role !== "link") body += `="${clip(norm(val), 40)}"`;
      if (st.length) body += ` (${st.join(", ")})`;
      return { s: `[${body}]@${r}`, parts: 1 };
    }
    if ((role === "img" || role === "image")) return name ? { s: `(img: ${clip(name, 40)})`, parts: 1 } : { s: "", parts: 0 };
    const sep = role === "row" ? " | " : " ";
    return joinKids(n, inPointer || !!info?.pointer, sep, max);
  };
  const joinKids = (n: AXNode, inPointer: boolean, sep = " ", max = INLINE_MAX): { s: string; parts: number } | null => {
    const out: string[] = [];
    let parts = 0;
    for (const c of n.childIds ?? []) {
      const r = inline(byId.get(c)!, inPointer, false, max);
      if (r === null) return null;
      if (r.s) { out.push(r.s); parts += r.parts; }
      if (out.join(sep).length > max * 2) return null;
    }
    let joined = out.join(sep);
    // "Name [textbox Name]@3" → "[textbox Name]@3": drop a label text that the next control repeats.
    joined = joined.replace(/(^|\s|\|)([^\[\]@|]{1,60}?) \[((?:\w+ )?)\2(\]|=| \()/g, "$1[$3$2$4");
    return { s: joined.replace(/\s+([,.;:!?)])/g, "$1").replace(/\(\s+/g, "("), parts };
  };

  const walk = (n: AXNode | undefined, depth: number, parentName: string, inPointer = false) => {
    if (!n) return;
    const role = n.role?.value ?? "";
    const name = norm(n.name?.value);
    const passName = role === "RootWebArea" || role === "WebArea" ? parentName : name || parentName;
    const info = n.backendDOMNodeId ? dom.get(n.backendDOMNodeId) : undefined;
    const kids = (ip = inPointer) => { for (const c of n.childIds ?? []) walk(byId.get(c), depth, passName, ip); };
    const kidsDeeper = (ip = inPointer) => { for (const c of n.childIds ?? []) walk(byId.get(c), depth + 1, passName, ip); };

    const sub = (role === "Iframe" || role === "IframePresentational") && n.backendDOMNodeId ? frames.get(`${curSid}:${n.backendDOMNodeId}`) : undefined;
    if (sub) {
      if (info && !info.visible && dom.size) return;
      const subRoot = sub.nodes.find((x) => !x.parentId) ?? sub.nodes[0];
      const title = name || norm(subRoot?.name?.value);
      lines.push(`${"  ".repeat(Math.min(depth, 12))}- iframe${title ? ` "${clip(title, maxText)}"` : ""}`);
      const saved = { byId, dom, curSid, curOwner };
      ({ byId, dom } = sub); curSid = sub.sid; curOwner = sub.owner;
      walk(subRoot, depth + 1, "", false);
      ({ byId, dom, curSid, curOwner } = saved);
      return;
    }
    if (n.ignored || SKIP_ROLES.has(role)) return kids();
    if (info && !info.visible && dom.size && role !== "RootWebArea") {
      // Hidden subtree: AX may still list it (e.g. visibility toggles). Skip unless a child is visible.
      return kids();
    }
    const isInteractive = INTERACTIVE_ROLES.has(role) || (!!info?.pointer && !inPointer && n.backendDOMNodeId !== undefined);
    const pointerOnly = !INTERACTIVE_ROLES.has(role) && !!info?.pointer;
    const childInPointer = inPointer || !!info?.pointer;
    const pad = opts.compact === false ? "  ".repeat(depth) : "  ".repeat(Math.min(depth, 12));

    if (role === "StaticText") {
      if (opts.interactive) return;
      if (!name || (parentName && parentName.includes(name))) return;
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      const grand = parent?.parentId ? byId.get(parent.parentId) : undefined;
      const sib = (x?: AXNode) => (x?.childIds ?? []).some((c) => { const k = byId.get(c); return k && k !== n && INTERACTIVE_ROLES.has(k.role?.value ?? "") && norm(k.name?.value) === name; });
      if (sib(parent) || sib(grand)) return; // label text repeated by its control
      lines.push(`${pad}- text "${clip(name, maxText * 2)}"`);
      return;
    }

    if (isInteractive && n.backendDOMNodeId) {
      // Pointer-cursor elements inherit the cursor down the tree; only ref the outermost one.
      const shownRole = pointerOnly ? "clickable" : role;
      const label = name || (pointerOnly ? textOf(n) : "");
      if (pointerOnly && !label) return kids(childInPointer);
      const r = refFor(n.backendDOMNodeId, shownRole, label);
      const val = n.value?.value;
      let line = `${pad}- ${shownRole}${label ? ` "${clip(label, maxText)}"` : ""} @${r}`;
      if (val !== undefined && val !== "" && role !== "link") line += ` value="${clip(norm(val), maxText)}"`;
      if (info?.href) line += ` ${info.href}`;
      const st = props(n).filter((x) => x !== "focused");
      if (st.length) line += ` [${st.join(", ")}]`;
      lines.push(line);
      // Children of a named control are usually its label text; skip them unless they are interactive.
      if (label && !["listbox", "combobox", "menu", "tablist", "tree", "radiogroup"].includes(role)) {
        for (const c of n.childIds ?? []) walk(byId.get(c), depth + 1, label, childInPointer);
        return;
      }
      return kidsDeeper(childInPointer);
    }

    if (opts.interactive) return kids(childInPointer);
    if ((role === "img" || role === "image") && (!name || inPointer || parentName.includes(name))) return; // decorative or inside a control

    // Containers whose content is just text + controls collapse to one line with inline refs.
    if (!BLOCK_ROLES.has(role) || role === "navigation") {
      const max = PROSE_ROLES.has(role) ? opts.maxProse ?? 1500 : INLINE_MAX;
      const flat = inline(n, inPointer, true, max);
      if (flat && flat.parts >= 1 && flat.s && flat.s.length <= max && !(flat.parts === 1 && TRANSPARENT_ROLES.has(role) && !/@\d+$/.test(flat.s) && false)) {
        const tag = role === "row" ? "row: " : role === "listitem" ? "li: " : role === "navigation" ? "nav: " : role === "cell" || role === "gridcell" ? "cell: " : "";
        if (flat.parts === 1 && !tag) {
          // A lone text or control: keep the normal rendering below for controls (role shown), emit text directly.
          if (!flat.s.includes("]@")) { if (!parentName.includes(flat.s)) lines.push(`${pad}- ${tag}${flat.s}`); return; }
        } else { lines.push(`${pad}- ${tag}${flat.s}`); return; }
      }
    }

    if (STRUCTURAL_KEEP.has(role) || (!TRANSPARENT_ROLES.has(role) && name)) {
      if (!name && ["list", "row", "group"].includes(role) && (n.childIds?.length ?? 0) <= 1) return kids();
      const st = props(n).filter((x) => x !== "focused");
      lines.push(`${pad}- ${role}${name ? ` "${clip(name, maxText)}"` : ""}${st.length ? ` [${st.join(", ")}]` : ""}`);
      return kidsDeeper(childInPointer);
    }
    return kids(childInPointer);
  };

  walk(root, 0, "");
  mergeLinkRuns(lines, INLINE_MAX);
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  let text = lines.join("\n");
  if (lines.length > maxLines) text = lines.slice(0, maxLines).join("\n") + `\n… ${lines.length - maxLines} more lines (use --max-lines or -i)`;
  return { text, refCount, lines: lines.length };
}

/** Merge consecutive plain `- link "X" @N` lines at the same indent into one inline line. */
function mergeLinkRuns(lines: string[], max: number) {
  const re = /^(\s*)- (?:link|button) "([^"]*)" @(\d+)$/;
  for (let i = 0; i < lines.length; i++) {
    const a = re.exec(lines[i]);
    if (!a) continue;
    let j = i + 1;
    let acc = `[${a[2]}]@${a[3]}`;
    while (j < lines.length) {
      const b = re.exec(lines[j]);
      if (!b || b[1] !== a[1] || acc.length + b[2].length + 8 > max) break;
      acc += ` [${b[2]}]@${b[3]}`;
      j++;
    }
    if (j > i + 1) lines.splice(i, j - i, `${a[1]}- ${acc}`);
  }
}
