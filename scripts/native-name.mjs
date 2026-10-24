// Where the packaged Go thin client lives, shared by bin/mb, postinstall and the unit tests.
// Windows uses a "windows" name (not Node's "win32") so a future build is mb-windows-amd64.exe.
import { join } from "node:path";

const OS = { win32: "windows", linux: "linux", darwin: "darwin" };
const ARCH = { x64: "amd64", arm64: "arm64", ia32: "386", arm: "arm" };

/** e.g. ("win32", "x64") -> "mb-windows-amd64.exe"; undefined when there is no packaged build. */
export function nativeBinaryName(platform, arch) {
  const os = OS[platform];
  const cpu = ARCH[arch];
  if (!os || !cpu) return undefined;
  return `mb-${os}-${cpu}${platform === "win32" ? ".exe" : ""}`;
}

/** Absolute path of the native binary inside a package root, or undefined for an unsupported target. */
export function nativeBinaryPath(root, platform, arch) {
  const name = nativeBinaryName(platform, arch);
  return name ? join(root, "bin", "native", name) : undefined;
}
