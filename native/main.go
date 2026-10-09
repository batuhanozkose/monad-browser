// mb: native thin client for monad-browser.
//
// The hot path (a command for a running session daemon) is one unix-socket round trip with no
// Node start-up. Anything else — starting the daemon, mcp, install-skill, sessions, help, Windows —
// is handed to the Node CLI, which this binary finds next to itself (../../dist/cli.js) or via
// MONAD_NODE_CLI.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

var launchFlags = map[string]bool{"cdp": true, "headful": true, "profile": true, "block": true, "chrome": true, "idle": true, "proxy": true}

// Commands the daemon serves directly. Everything else goes to Node.
var nodeOnly = map[string]bool{"": true, "help": true, "--help": true, "-h": true, "version": true, "--version": true, "mcp": true,
	"install-skill": true, "sessions": true, "start": true}

type response struct {
	Ok    bool   `json:"ok"`
	Out   string `json:"out"`
	Error string `json:"error"`
}

func stateDir() string {
	if d := os.Getenv("MONAD_HOME"); d != "" {
		return d
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".monad-browser")
}

func nodeCLI() string {
	if p := os.Getenv("MONAD_NODE_CLI"); p != "" {
		return p
	}
	exe, err := os.Executable()
	if err == nil {
		if r, err := filepath.EvalSymlinks(exe); err == nil {
			exe = r
		}
		for _, rel := range []string{"../../dist/cli.js", "../dist/cli.js"} {
			p := filepath.Join(filepath.Dir(exe), rel)
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return "monad-browser" // on PATH
}

// handOff replaces this process with the Node CLI (same args, same stdio).
func handOff() {
	cli := nodeCLI()
	args := os.Args[1:]
	var bin string
	var argv []string
	if strings.HasSuffix(cli, ".js") {
		bin, _ = exec.LookPath("node")
		argv = append([]string{"node", cli}, args...)
	} else {
		bin, _ = exec.LookPath(cli)
		argv = append([]string{cli}, args...)
	}
	if bin == "" {
		os.Stderr.WriteString("error: node not found on PATH\n")
		os.Exit(1)
	}
	if runtime.GOOS != "windows" {
		err := syscall.Exec(bin, argv, os.Environ())
		os.Stderr.WriteString("error: " + err.Error() + "\n")
		os.Exit(1)
	}
	c := exec.Command(bin, argv[1:]...)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			os.Exit(ee.ExitCode())
		}
		os.Exit(1)
	}
	os.Exit(0)
}

func main() {
	if runtime.GOOS == "windows" {
		handOff()
	}
	args := os.Args[1:]
	session := os.Getenv("MONAD_SESSION")
	if session == "" {
		session = "default"
	}
	// Global options come before the command; launch flags only matter when starting a daemon (Node's job).
	for len(args) > 0 && strings.HasPrefix(args[0], "--") {
		kv := strings.SplitN(args[0][2:], "=", 2)
		k := kv[0]
		if k == "session" {
			if len(kv) == 2 {
				session, args = kv[1], args[1:]
			} else if len(args) > 1 {
				session, args = args[1], args[2:]
			} else {
				handOff()
			}
			continue
		}
		if launchFlags[k] {
			if k == "headful" || len(kv) == 2 {
				args = args[1:]
			} else if len(args) > 1 {
				args = args[2:]
			} else {
				handOff()
			}
			continue
		}
		break
	}
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	if nodeOnly[cmd] || (cmd == "stop" && len(args) > 1 && args[1] == "--all") {
		handOff()
	}
	if cmd == "run" {
		stat, _ := os.Stdin.Stat()
		piped := stat != nil && stat.Mode()&os.ModeCharDevice == 0
		if (len(args) > 1 && args[1] == "-") || (len(args) == 1 && piped) {
			b, _ := io.ReadAll(os.Stdin)
			args = []string{"run", "--", string(b)}
		}
	}

	conn, err := net.Dial("unix", filepath.Join(stateDir(), session+".sock"))
	if err != nil {
		if cmd == "stop" || cmd == "status" {
			if cmd == "stop" {
				os.Stdout.WriteString("not running\n")
			} else {
				os.Stdout.WriteString("stopped\n")
			}
			return
		}
		handOff() // no daemon yet: Node starts it and runs the command
	}
	defer conn.Close()
	timeout := 120 * time.Second
	if cmd == "run" {
		timeout = 600 * time.Second
	}
	conn.SetDeadline(time.Now().Add(timeout))
	cwd, _ := os.Getwd()
	req, _ := json.Marshal(map[string]any{"argv": args, "cwd": cwd})
	if _, err := conn.Write(append(req, '\n')); err != nil {
		handOff()
	}
	body, err := io.ReadAll(bufio.NewReader(conn))
	if err != nil {
		os.Stderr.WriteString("error: " + err.Error() + "\n")
		os.Exit(1)
	}
	var res response
	if err := json.Unmarshal(body, &res); err != nil {
		os.Stderr.WriteString("error: bad daemon response\n")
		os.Exit(1)
	}
	if !res.Ok {
		os.Stderr.WriteString("error: " + res.Error + "\n")
		os.Exit(1)
	}
	if res.Out != "" {
		if !strings.HasSuffix(res.Out, "\n") {
			res.Out += "\n"
		}
		os.Stdout.WriteString(res.Out)
	}
}
