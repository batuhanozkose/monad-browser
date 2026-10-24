// Single source of truth for the CLI version: package.json, so --version, MCP and PDF metadata agree.
import { readFileSync } from "node:fs";

export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
