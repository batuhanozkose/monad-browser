// Build the Go thin client for every platform the package ships. This replaces the POSIX shell
// loop that only ran on Linux/macOS; Windows itself is not a build target (bin/mb uses Node).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "bin", "native");
const targets = [["linux", "amd64"], ["linux", "arm64"], ["darwin", "amd64"], ["darwin", "arm64"]];
mkdirSync(outDir, { recursive: true });

for (const [goos, goarch] of targets) {
  const out = join(outDir, `mb-${goos}-${goarch}`);
  const r = spawnSync(process.platform === "win32" ? "go.exe" : "go", ["build", "-trimpath", "-ldflags=-s -w", "-o", out, "."], {
    cwd: join(root, "native"),
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
  });
  if (r.error) {
    console.error(`build:native: could not run go (${r.error.message}). Install Go 1.22+ or use \`npm pack --ignore-scripts\`.`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
  // A Windows host may append .exe to an explicit -o path; keep the packaged name exact.
  if (!existsSync(out) && existsSync(`${out}.exe`)) renameSync(`${out}.exe`, out);
}
