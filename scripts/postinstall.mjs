// Swap bin/mb for the native thin client of this platform (no Node start-up per command).
// Skipped in a git checkout (keeps the tracked launcher). Silent no-op when there is no binary for the platform (Windows, other arches): bin/mb falls back to Node.
import { copyFileSync, chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
const src = join(root, "bin", "native", `mb-${process.platform}-${arch}`);
if (!existsSync(join(root, ".git")) && arch && (process.platform === "linux" || process.platform === "darwin") && existsSync(src)) {
  try { copyFileSync(src, join(root, "bin", "mb")); chmodSync(join(root, "bin", "mb"), 0o755); } catch { /* keep the shell launcher */ }
}
