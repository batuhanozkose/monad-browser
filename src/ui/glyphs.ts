// UI glyphs. Everything here is decorative: the adjacent word always carries the
// same meaning, so ASCII mode loses nothing.
export type Glyphs = {
  ok: string;
  fail: string;
  warn: string;
  info: string;
  arrow: string;
  dot: string;
  ellipsis: string;
  rule: string;
};

export const unicodeGlyphs: Glyphs = {
  ok: "✓",
  fail: "✗",
  warn: "!",
  info: "·",
  arrow: "→",
  dot: "·",
  ellipsis: "…",
  rule: "─",
};

export const asciiGlyphs: Glyphs = {
  ok: "ok",
  fail: "ERR",
  warn: "!",
  info: "-",
  arrow: "->",
  dot: "-",
  ellipsis: "...",
  rule: "-",
};

export function glyphsFor(unicode: boolean): Glyphs {
  return unicode ? unicodeGlyphs : asciiGlyphs;
}
