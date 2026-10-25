// Help text shared by the command table and the local watch command handler.
export const WATCH_USAGE = "watch add <url|owner/repo> … | watch list | watch check [name|all] | watch remove <name> | watch logs [name] | watch run";

export const WATCH_HELP = `usage: mb watch <command> [options]

commands:
  add <url|owner/repo>   create a watcher and store its baseline
      --kind page|rss|release        default: inferred from the source
      --extract text|css:<selector>|json:<path>   page only (default: text)
      --condition <expr>             default: changed
      --every <duration>             required; 30s, 5m, 1h, 1d
      --name <name>                  default: derived from source + extraction
      --render                       render with Chrome (JS-heavy pages)
      --exec <command>               run only when the condition fires (no shell)
      --notify                       POST to MONAD_WATCH_NOTIFY_URL / watchNotifyUrl
      --json                         machine-readable result
  list [--json]          show watchers, next check and last error
  check [name|all]       check now; prints only fired watchers
  remove <name>          delete a watcher and its logs
  logs [name]            recent fired/error/baseline events
  run [--json]           foreground loop for CI/systemd (Ctrl-C to stop)

conditions:
  changed | contains "x" | not-contains "x" | matches /re/ | > 10 | >= 10 | < 5 | <= 5 | == 0 | != 0

state: ~/.monad-browser/watches.json (MONAD_HOME overrides). The daemon timer keeps running
between CLI calls; mb watch run is the foreground alternative. Plain text, no ANSI; --json is stable.`;
