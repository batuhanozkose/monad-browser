// Small vendored display-width / wrapping helper. The project has no runtime
// dependencies, and the only part we really need from `string-width` is a
// grapheme-aware width plus word wrapping. This covers CJK, emoji, combining
// marks and ANSI-free text.
export type WrapOptions = {
  width: number;
  /** Prefix for the first line; usually the existing leading whitespace. */
  indent?: string;
  /** Prefix for continuation lines. Defaults to indent + two spaces. */
  hanging?: string;
  /** Break a single word longer than the width instead of overflowing. */
  breakLong?: boolean;
};

const ANSI = /\x1b\[[0-9;]*m/g;
const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks, ZWJ, variation selectors and other zero-width controls.
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) ||
      (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) ||
      (cp >= 0xfe20 && cp <= 0xfe2f)) return 0;
  // East Asian wide / fullwidth and emoji.
  if (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd))) return 2;
  return 1;
}

function graphemeWidth(s: string): number {
  if (!s) return 0;
  if (/\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(s)) return 2;
  if (/^[\p{M}\u200d\ufe0e\ufe0f]+$/u.test(s)) return 0;
  let w = 0;
  for (const ch of s) w = Math.max(w, codePointWidth(ch.codePointAt(0) ?? 0));
  return w;
}

export function stringWidth(s: string): number {
  const plain = stripAnsi(s);
  if (!segmenter) return [...plain].reduce((n, ch) => n + graphemeWidth(ch), 0);
  let w = 0;
  for (const { segment } of segmenter.segment(plain)) w += graphemeWidth(segment);
  return w;
}

export function padEnd(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - stringWidth(s)));
}

export function padStart(s: string, width: number): string {
  return " ".repeat(Math.max(0, width - stringWidth(s))) + s;
}

export function truncate(s: string, width: number, ellipsis = "…"): string {
  if (stringWidth(s) <= width) return s;
  const target = Math.max(0, width - stringWidth(ellipsis));
  let out = "";
  if (segmenter) {
    for (const { segment } of segmenter.segment(s)) {
      if (stringWidth(out + segment) > target) break;
      out += segment;
    }
  } else {
    for (const ch of s) {
      if (stringWidth(out + ch) > target) break;
      out += ch;
    }
  }
  return out + ellipsis;
}

/** Wrap plain text, preserving a leading indent and protecting `[label]@N` tokens. */
export function wrap(text: string, opts: WrapOptions): string[] {
  const width = Math.max(1, opts.width);
  const leading = text.match(/^\s*/)?.[0] ?? "";
  const indent = opts.indent ?? leading;
  const hanging = opts.hanging ?? indent + "  ";
  const body = opts.indent !== undefined && !text.startsWith(indent) ? text : text.slice(indent.length);
  if (!body) return [indent];
  if (stringWidth(indent + body) <= width) return [indent + body];

  // Refs and quoted names are one unit: never split `[Search the docs]@9`
  // or `"us-east-1 (Virginia)"` across lines. Use a private-use glyph, not
  // NBSP, because JS treats NBSP as whitespace when splitting words.
  const protectedBody = body.replace(/(\[[^\]]*\]@\d+)|("[^"]*")/g, (m) => m.replace(/ /g, "\uE000"));
  const words = protectedBody.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = indent;
  let hasWord = false;

  const push = () => { out.push(line.replace(/\uE000/g, " ")); line = hanging; hasWord = false; };

  for (const word of words) {
    const visible = word.replace(/\uE000/g, " ");
    const sep = hasWord ? " " : "";
    if (stringWidth(line) + sep.length + stringWidth(visible) <= width) {
      line += sep + word;
      hasWord = true;
      continue;
    }
    if (hasWord) push();
    if (stringWidth(line) + stringWidth(visible) <= width) {
      line += visible;
      hasWord = true;
      continue;
    }
    if (!opts.breakLong) {
      line += visible;
      hasWord = true;
      push();
      continue;
    }
    // Break a long URL / token by grapheme.
    let rest = visible;
    while (stringWidth(line) + stringWidth(rest) > width) {
      const room = Math.max(1, width - stringWidth(line));
      let take = "";
      if (segmenter) {
        for (const { segment } of segmenter.segment(rest)) {
          if (stringWidth(take + segment) > room) break;
          take += segment;
        }
      } else {
        for (const ch of rest) {
          if (stringWidth(take + ch) > room) break;
          take += ch;
        }
      }
      if (!take) break;
      line += take;
      rest = rest.slice(take.length);
      push();
    }
    if (rest) { line += rest; hasWord = true; }
  }
  if (hasWord) out.push(line.replace(/\uE000/g, " "));
  return out.length ? out : [indent];
}

/** Wrap a snapshot/tree line with a two-space hanging indent. */
export function wrapTreeLine(line: string, width: number): string[] {
  const indent = line.match(/^\s*/)?.[0] ?? "";
  return wrap(line, { width, indent, hanging: indent + "  ", breakLong: true });
}
