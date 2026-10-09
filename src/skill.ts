// `mb install-skill`: drop a SKILL.md so coding agents (Claude Code, Codex, OpenCode, Memoh…) know how to drive the CLI.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SKILL_MD = `---
name: monad-browser
description: Drive a real headless Chrome from the shell with \`mb\` (monad-browser) — open pages, read compact accessibility snapshots with @refs, click/fill/press, and run whole multi-step plans in one call. Use for any web browsing, form filling, scraping, testing a web app, or logging into a site.
---

# monad-browser (\`mb\`)

A warm daemon keeps Chrome open between calls, so each command is ~40 ms.

## Core loop
1. \`mb open <url> -s\` — navigate and print the snapshot.
2. Read refs like \`[Sign in]@12\` or \`button "Submit" @6\`.
3. Act: \`mb click @12 -s\`, \`mb fill @3 "text" -s\`, \`mb press Enter -s\`.
   With \`-s\` an action prints only what changed on the page (a diff), not the whole page again.

## Prefer one call for multi-step work
\`\`\`bash
mb run '
  await goto("github.com/login");
  await fill("role=textbox:Username or email address", "me");
  await fill("role=textbox:Password", "secret");
  await click("role=button:Sign in");
  await waitForText("Dashboard");
  return await snapshot({ diff: true });
'
\`\`\`
API inside \`run\`: goto click fill type press select hover scroll text js snapshot exists wait(ms|target)
waitForText waitForIdle screenshot back reload cdp tabs url title log sleep. Only log()/return output comes back.

## Targets
\`@N\` (from the latest snapshot; refs stay stable and self-heal after re-renders), \`text=Label\`,
\`role=button:Name\`, or a CSS selector. Actions auto-wait until the element is visible, stable, enabled and
not covered; if something covers it (cookie banner, modal), the error names the cover — close it first.

## Other commands
- \`mb snapshot -i\` interactive elements only; \`mb snapshot -d\` only changes since the last snapshot.
- \`mb text [target]\` readable text; \`mb eval '<js>'\` page JS; \`mb screenshot out.png [--full]\`.
- \`mb tabs\`, \`mb tab new <url>\`, \`mb tab 1\`, \`mb back\`, \`mb wait text=Done\`, \`mb console\`.
- Logins: \`mb state save auth.json\` once, then \`mb state load auth.json\` in a fresh session.
- Parallel browsers: \`mb --session work open …\`; \`mb sessions\`; \`mb stop --all\`.
- Attach to an existing Chrome: \`mb --cdp 9222 open …\`. Visible window: \`mb --headful open …\`.
`;

export function installSkill(argv: string[]) {
  if (argv.includes("--print")) return SKILL_MD;
  const di = argv.indexOf("--dir");
  const targets: string[] = [];
  if (di >= 0 && argv[di + 1]) targets.push(resolve(argv[di + 1]));
  else if (argv.includes("--project")) targets.push(resolve(".claude/skills/monad-browser"), resolve(".agents/skills/monad-browser"));
  else targets.push(join(homedir(), ".claude/skills/monad-browser"), join(homedir(), ".agents/skills/monad-browser"));
  for (const t of targets) { mkdirSync(t, { recursive: true }); writeFileSync(join(t, "SKILL.md"), SKILL_MD); }
  return targets.map((t) => `ok wrote ${join(t, "SKILL.md")}`).join("\n");
}
