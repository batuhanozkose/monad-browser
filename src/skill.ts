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

## Output
- Captured/pipe output is plain text; a TTY adds semantic color (refs, URLs, numbers, ok/error/warn).
- \`NO_COLOR\`, \`FORCE_COLOR\`, \`TERM=dumb\` and CI are honored; \`--json\` is always the stable machine contract.
- \`mb --help\` is a compact command map; \`mb help --all\` lists every command; \`mb <command> --help\` shows flags and examples.
- An action with \`-s\` prints a one-line receipt and only the changed lines.
- Windows legacy consoles default to ASCII UI glyphs; \`MB_ASCII=1\` forces ASCII, \`MB_UNICODE=1\` forces Unicode.

## Core loop
1. \`mb open <url> -s\` — navigate and print the snapshot.
2. Read refs like \`[Sign in]@12\` or \`button "Submit" @6\`.
3. Act: \`mb click @12 -s\`, \`mb fill @3 "text" -s\`, \`mb press Enter -s\`.
   With \`-s\` an action prints only what changed on the page (a diff), not the whole page again.

## Read and query before snapshotting
- \`mb read <url>\` fetches markdown / \`llms.txt\` without launching Chrome; \`mb read\` reads the active tab.
  For URLs, add \`--outline\`, \`--filter <text>\`, or \`--require-md\`.
- \`mb get text|value|count|box|styles <target>\` reads one value instead of a whole snapshot;
  \`mb get attr <target> <name>\` reads one attribute.
- \`mb is visible|enabled|checked <target>\` answers a state question.
- \`mb find label "Email" fill "a@b.com"\`, \`mb find role button click --name Submit\`,
  \`mb find placeholder "Search" fill "x"\`, \`mb find first ".item" click\`.
- \`mb check @5\` / \`mb uncheck @5\`.

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
API inside \`run\`: goto click fill type press select hover scroll text js snapshot exists get is find
check uncheck focus scrollIntoView upload pdf read drag download cookies storage networkRequests
wait(ms|target) waitForText waitForUrl waitForFn waitForIdle screenshot back reload cdp tabs url title log sleep.
Only log()/return output comes back.

## Targets
\`@N\` (from the latest snapshot; refs stay stable and self-heal after re-renders), \`text=Label\`,
\`text~=Substring\`, \`role=button:Name\`, \`label=Email\`, \`placeholder=Search\`, \`alt=Logo\`,
\`title=Tooltip\`, \`testid=submit\`, \`nth=0:.item\`, or a CSS selector. Actions auto-wait until the
element is visible, stable, enabled and not covered; if something covers it (cookie banner, modal),
the error names the cover — close it first.

## Other commands
- \`mb snapshot -i\` interactive only; \`-d\` only changes; \`--full\` resets the diff baseline; \`--json\` returns a compact patch.
- \`mb diff snapshot\` compares with the last snapshot; \`mb diff url <a> <b>\` compares two pages.
- \`mb screenshot out.png [--full] [--annotate] [--if-changed]\`; \`mb pdf out.pdf\`.
- \`mb text [target]\` readable text; \`mb eval '<js>'\` page JS; \`mb wait --url|--fn|--text|--state hidden\`.
- \`mb upload @3 file.pdf\`, \`mb download @4 ./dl\`, \`mb drag @1 @2\`, \`mb focus @3\`, \`mb scrollintoview @3\`.
- \`mb cookies\`, \`mb storage local\`, \`mb network requests\`, \`mb network route '**/api' --abort\`.
- \`mb set viewport 390 844\`, \`mb set device "iPhone 15"\`, \`mb set media dark\`, \`mb set offline on\`.
- \`mb dialog status|accept|dismiss\` after launching with \`--no-auto-dialog\`.
- Logins: \`mb state save auth.json\` once, then \`mb state load auth.json\` in a fresh session.
- Parallel browsers: \`mb --session work open …\`; \`mb sessions\`; \`mb stop --all\`.
- Attach to an existing Chrome: \`mb --cdp 9222 open …\`. Visible window: \`mb --headful open …\`.

## Watch pages, feeds and releases
- \`mb watch add <url|owner/repo> --kind page|rss|release --extract text|css:<selector>|json:<path> --condition <expr> --every 5m [--name N]\`
- Conditions: \`changed\`, \`contains "x"\`, \`not-contains "x"\`, \`matches /re/\`, \`> 10\`, \`< 5\`, \`== 0\`.
  The first check stores a baseline; a condition fires on the transition into it, not every interval.
- \`mb watch list\`, \`mb watch check [name|all]\`, \`mb watch logs [name]\`, \`mb watch remove <name>\`.
- The timer lives in the daemon between CLI calls; \`mb watch run\` is the foreground/CI alternative.
  \`--render\` uses Chrome for JS-heavy pages; the default fetch path is Chrome-less.
- Text output appears only when something fires. Add \`--json\` for the stable machine contract.
- \`--exec '<cmd>'\` runs only on a fire and never through a shell; \`--notify\` POSTs to
  \`MONAD_WATCH_NOTIFY_URL\` (or \`watchNotifyUrl\` in config).

## Windows and PowerShell
\`mb\` runs on Node there (the Go thin client is Linux/macOS only). PowerShell parses arguments
before \`mb\` sees them: a bare \`@12\` is splatting and is dropped, so write
\`mb click '@12' -s\` or, easier, \`mb click 12 -s\` — a plain number is the same ref. Quote CSS
selectors and values PowerShell would rewrite: \`mb click '#email'\`, \`mb get count '*'\`,
\`mb click 'text=Sign in'\`, \`mb eval 'return location.href'\`. \`cmd.exe\` passes \`@12\`
through unchanged. Prefer \`mb run --file plan.js\` over inline scripts. In \`cmd.exe\` quote
values containing \`&\` or \`|\`, write JSON with escaped quotes (see the README), and use single
quotes inside \`run\` scripts or \`run --file\`. Unknown \`--flags\` are rejected.
`;

/** Skills shipped with the CLI, so an agent's instructions always match the installed version. */
export const SKILLS: Record<string, { description: string; body: string }> = {
  core: {
    description: "Drive monad-browser: snapshots, refs, actions, diff, run, read, state.",
    body: SKILL_MD,
  },
};

export function listSkills(): string {
  return Object.entries(SKILLS).map(([name, s]) => `${name}\t${s.description}`).join("\n");
}

export function getSkill(name = "core"): string {
  const skill = SKILLS[name];
  if (!skill) throw new Error(`unknown skill: ${name} (known: ${Object.keys(SKILLS).join(", ")})`);
  return skill.body;
}

export function skillPath(name = "core"): string {
  if (!SKILLS[name]) throw new Error(`unknown skill: ${name}`);
  return join(homedir(), ".agents", "skills", "monad-browser");
}

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
