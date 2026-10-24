// Swap bin/mb for the native thin client on Linux/macOS (no Node start-up per command).
// Windows keeps the Node launcher: npm's .cmd/.ps1 shims invoke it with node, and replacing it
// with a PE file would break `node bin/mb`. chmod is meaningless there, so skip win32 entirely.
// Skipped in a git checkout (keeps the tracked launcher). Silent no-op when there is no binary
// for the platform/arch: bin/mb falls back to Node.
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBinaryPath } from "./native-name.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32" && !existsSync(join(root, ".git"))) {
  const src = nativeBinaryPath(root, process.platform, process.arch);
  if (src && existsSync(src)) {
    try {
      copyFileSync(src, join(root, "bin", "mb"));
      chmodSync(join(root, "bin", "mb"), 0o755);
    } catch { /* keep the Node launcher */ }
  }
}
