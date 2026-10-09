#!/usr/bin/env node
// Entry point. Turn on V8's on-disk compile cache before anything else loads, then hand off.
import module from "node:module";
(module as any).enableCompileCache?.();
await import("./main.js");
