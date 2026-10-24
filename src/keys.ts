export type KeyDef = { key: string; code: string; keyCode: number; text?: string };

export const KEYS: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Esc: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  CapsLock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
for (let d = 0; d <= 9; d++) KEYS[String(d)] = { key: String(d), code: `Digit${d}`, keyCode: 48 + d, text: String(d) };

export function modifierBit(name: string): number {
  switch (name.toLowerCase()) {
    case "alt": case "option": return 1;
    case "ctrl": case "control": return 2;
    case "meta": case "cmd": case "command": return 4;
    case "shift": return 8;
    case "mod": return process.platform === "darwin" ? 4 : 2;
    default: throw new Error(`unknown modifier: ${name}`);
  }
}
