# Connect

**Talk to OpenAI Codex from inside Claude Code.** Persistent threads, cost-aware routing, one
shared Codex daemon.

**Website:** [gary0302.github.io/connect](https://gary0302.github.io/connect/) ·
**Source:** [github.com/Gary0302/connect](https://github.com/Gary0302/connect) ·
**License:** MIT

Connect is a **Claude Code plugin**: an MCP server, a skill, and five slash commands. It lets
Claude ask Codex for a second opinion, a code review, or a hard design call — and keep that
conversation going across sessions. There is nothing to `npm install`: zero dependencies, plain
Node.js.

```
/connect:ask is this lock-free queue actually safe under ABA? see src/queue.ts
```

```
Codex's view: the CAS on `head` is ABA-prone because … (thread: 019a…)
routed: code_review · gpt-5.x · effort high
```

## Why

- **A second, independent model.** When a design is contested, a concurrency bug is subtle, or a
  diff is security-sensitive, a different model's disagreement is the useful signal.
- **Memory that survives.** Codex threads live on the local daemon, not in Claude's context. They
  survive Claude Code restarts, daemon restarts and reboots, and you can resume any of them.
- **It does not burn tokens by accident.** Codex's thread default effort can be `xhigh`. One
  measured one-sentence factual question at that default cost **273,840 tokens in 48 seconds**;
  the same question routed as `quick_answer` cost about **16,000 tokens in 3.5 seconds**. Connect
  pins effort, sandbox and a token ceiling on every turn.

## Requirements

- **Claude Code** with plugin support.
- **macOS or Linux** — Connect talks to the daemon over a Unix-domain socket.
- **Node.js 18+**. No packages are installed.
- **The standalone Codex install.** The app-server daemon needs it; a brew or npm `codex` is not
  enough.
- A signed-in Codex / ChatGPT account.

## Install

```bash
# 1. standalone Codex
curl -fsSL https://chatgpt.com/codex/install.sh | sh

# 2. the plugin
claude plugin marketplace add Gary0302/connect
claude plugin install connect@connect-local
```

Restart Claude Code, then run `/connect:doctor` to confirm the daemon is reachable.

### Troubleshooting

| symptom | what to check |
|---|---|
| daemon will not start | the standalone Codex install is missing, or an older brew/npm `codex` wins in `PATH` — set `CONNECT_CODEX_BIN=~/.local/bin/codex` |
| doctor reports a version mismatch | the CLI was upgraded but the daemon is still the old one. The fix is `codex app-server daemon restart` — read [the warning below](#️-do-not-restart-the-daemon-casually) first |
| errors about the config file | `~/.config/connect/config.json` is malformed — fix or delete it |
| `implement` cannot do something | Connect declines every approval and input request from Codex automatically; only what the `workspace-write` sandbox already allows can happen |

### Uninstall

```bash
claude plugin uninstall connect@connect-local
claude plugin marketplace remove connect-local   # optional
rm -rf ~/.config/connect                         # optional: your preferences
```

### Developing on the plugin

Installing **copies** the plugin into `~/.claude/plugins/cache/`, so edits in this checkout do not
take effect until you resync. `claude plugin update` is a no-op while the version in
`.claude-plugin/plugin.json` is unchanged, so either bump the version or reinstall:

```bash
claude plugin uninstall connect@connect-local && claude plugin install connect@connect-local
```

## Usage

### Slash commands

| command | what it does |
|---|---|
| `/connect:ask <question>` | ask Codex in a new persistent thread |
| `/connect:threads` | list recent Codex threads |
| `/connect:resume <threadId> <question>` | read an earlier thread back, then continue it |
| `/connect:config [args]` | choose model, effort and token ceilings (interactive with no args) |
| `/connect:doctor` | health check: daemon, versions, remote control |

### Letting Claude decide

The bundled `connect` **skill** tells Claude *when* Codex is worth asking. It loads when you say
"ask Codex", "what does Codex think", "get a second opinion", or when Claude judges that a risky
diff or a contested design call deserves an independent model. It is `user-invocable: false`, so
it stays out of the `/` menu.

Claude also gets the MCP tools directly:

| tool | purpose |
|---|---|
| `codex_ask` | one routed turn: `prompt`, `intent`, optional `threadId` and `cwd` |
| `codex_threads` | list recent threads on the daemon |
| `codex_history` | a recent, truncated transcript of a thread (default 20 turns, 400 chars per item) |
| `codex_config` | read or change preferences |
| `codex_doctor` | diagnose the daemon and versions |

Claude is told to report Codex's answer **as Codex's view, not as fact**, and to say plainly where
it disagrees.

## Intents and routing

Every `codex_ask` carries an `intent`. It pins three things: reasoning effort, the sandbox, and a
per-turn token ceiling.

| intent | effort | sandbox | token ceiling | for |
|---|---|---|---|---|
| `quick_answer` | low | read-only | 20k | facts, versions, one-liners |
| `second_opinion` | medium | read-only | 80k | "is this approach sound?" (the default) |
| `code_review` | high | read-only | 200k | reading a diff or file for defects |
| `deep_reasoning` | xhigh | read-only | 400k | architecture, protocols, races |
| `implement` | high | **workspace-write** | 300k | asking Codex to write code |

- **If no intent is given**, a cheap keyword heuristic guesses one (`src/router.mjs`). Claude is
  instructed to always pass it explicitly.
- **The sandbox is pinned on purpose.** `approvalPolicy: "never"` decides *who is asked*, not *what
  is possible* — with nobody to ask, whatever the sandbox allows just happens. Asking for an opinion
  must not be able to edit your tree, so only `implement` can write. Codex can still *read* the
  working directory, so point it at real paths instead of pasting files.
- **The ceiling is measured per turn**, not against the thread's running total. It is enforced by
  Connect, not the daemon: once reported usage passes it, Connect sends `turn/interrupt` and the
  result says `INTERRUPTED: exceeded the budget for this intent` — the answer is partial. If the
  interrupt itself fails, the result says that instead.
- **Codex never waits on a human.** Every approval or input request Codex raises is declined
  automatically, so a turn cannot hang on a prompt nobody will see.

## Threads and resuming

Every `codex_ask` result ends with its thread id. Pass it back as `threadId` to continue with the
thread's memory intact. `codex_threads` returns conversations from days ago, and `codex_history`
shows what one contains — so `/connect:resume` can pick up a conversation from a previous session.

Verified: resume a thread, ask "what did I ask you earlier in this thread?", and Codex answers from
the thread's own history.

## Configuration

`/connect:config` with no arguments opens **forms in the terminal**, drawn by the MCP server itself
through MCP elicitation:

1. **Model** (from the daemon's live `model/list`), **effort mode** (auto by intent / one level
   everywhere / per intent) and **token ceilings** (keep / built-in / 2× / 4×).
2. If you chose a level: Codex's own effort levels for that model, worded as Codex's `/model`
   picker words them.
3. Only if the model changed: what to do with **existing threads** — switch directly (default),
   compact first then switch, or keep old threads on their model. Switching a thread's model
   discards its prompt cache, so the next turn re-reads the whole history at full price.

Clients without elicitation get a clear refusal, and the slash command falls back to asking the
same questions with `AskUserQuestion`. Quick changes take arguments:

```
/connect:config show
/connect:config model gpt-5.6-terra
/connect:config model default
/connect:config code_review xhigh
/connect:config old-threads compact
/connect:config reset
```

Preferences are validated against the models and efforts the daemon actually offers, stored
outside the plugin (so a reinstall does not wipe them), and re-read on every call (so changes apply
to the next ask). Sandboxes are deliberately **not** configurable.

| environment variable | default | purpose |
|---|---|---|
| `CONNECT_CONFIG` | `~/.config/connect/config.json` | preferences file |
| `CONNECT_CODEX_BIN` | resolved automatically | which `codex` binary to use |
| `CONNECT_TEST_DISRUPTIVE` | unset | `1` enables the daemon-restart test |

## Standalone CLI

Codex without Claude in the loop. It reads the same config file; `--model` overrides it.

```bash
node bin/connect.mjs doctor
node bin/connect.mjs threads 10
node bin/connect.mjs ask --intent quick_answer "what version of node is this"
node bin/connect.mjs ask --thread <id> "and what about the previous point?"
node bin/connect.mjs history <threadId>
```

## How it works

```
Claude Code ──stdio / MCP──▶ mcp/connect-mcp.mjs
                                   │
                          src/session.mjs   ← router (intent → effort, sandbox, ceiling)
                                   │           config (user overrides) · lease (fencing)
                          src/codex-client.mjs  JSON-RPC, reconnect with backoff
                                   │
                          src/ws-unix.mjs       RFC 6455 WebSocket over a Unix socket
                                   │
              ~/.codex/app-server-control/app-server-control.sock
                                   │
                        codex app-server daemon  (also reachable from `codex --remote`)
```

Connect starts the daemon if needed (`codex app-server daemon start`) and talks to it over its
control socket. A Codex TUI started with `codex --remote unix://<socket>` drives the **same**
app-server, so threads are shared between it and Connect.

Within one Connect MCP process, thread leases with fencing tokens stop two concurrent `codex_ask`
calls from starting turns on the same thread. The registry is in-memory: it does **not** fence
writers outside Connect, such as a Codex TUI or Remote Control session on the same thread.

Protocol details that drove the design are written up in [`spike/FINDINGS.md`](spike/FINDINGS.md) —
read it before changing `src/`. Two examples:

- `thread/resume` **ignores** `model` for a thread the daemon already has loaded; a model switch
  has to ride on `turn/start`, and then sticks for later turns.
- Reasoning notifications only arrive when `summary` is set on `turn/start`.

## Testing

```bash
export PATH="$HOME/.local/bin:$PATH"   # make sure the standalone codex comes first
node test/verify.mjs
```

About 130 checks: daemon lifecycle, WebSocket handshake and frame validation, concurrent clients,
routing policy, user config, lease fencing, notification correlation on a shared daemon, per-turn
budget accounting, session lifecycle and refusal shapes, the MCP protocol surface over stdio, and
the config forms.

- Sections 11–13 run **four live Codex turns** and spend a small number of tokens — two of them
  full `codex_ask` calls through the MCP server, the second continuing the first's thread after a
  model change (compact, then switch).
- Sections 1, 2 and 4 need the **running daemon** but spend no model tokens.
- Everything else runs offline.

`CONNECT_TEST_DISRUPTIVE=1` adds a reconnect test. It restarts the daemon, which disconnects every
attached Codex session, so it is off by default.

## ⚠️ Do not restart the daemon casually

`codex app-server daemon restart`, `enable-remote-control` and `disable-remote-control` each tear
down the app-server and drop **every attached client** — including a Codex TUI you have open, mid
turn. That is why `/connect:doctor` *reports* a version mismatch but never fixes it for you: you
pick the moment.

Connect itself survives a restart: the client reconnects with backoff, re-runs `initialize`, and
continues on the same thread.

## Known limitations

- **A daemon restart mid-turn loses that turn's answer.** The thread survives, but the in-flight
  turn fails fast with a reset error rather than being replayed.
- **Codex Remote Control requires MFA** on the ChatGPT account (`403 Multi-factor authentication
  required` otherwise). Connect only reads Remote Control status for `/connect:doctor`.
- **Leases are local to Connect.** Remote Control and TUI clients are not fed into the lease
  registry; the contention test uses a simulated second writer.
- **Two Codex installs can coexist** (standalone in `~/.local/bin` and brew earlier in `PATH`).
  Connect resolves the binary in one place so the CLI and MCP server always agree; override with
  `CONNECT_CODEX_BIN`.
- **No status-line HUD yet.** `session.hudLine()` produces one, but it is not wired into Claude
  Code's `statusLine`, since that slot usually already holds the user's own script.

## Project layout

```
.claude-plugin/     plugin + marketplace manifests
.mcp.json           MCP server registration
mcp/                the MCP server
skills/connect/     when Claude should reach for Codex
commands/           slash commands
bin/connect.mjs     standalone CLI
src/
  ws-unix.mjs       minimal RFC 6455 client over a Unix socket
  codex-client.mjs  JSON-RPC over that socket, with reconnect
  router.mjs        per-intent effort / sandbox / ceiling policy
  config.mjs        user preferences layered over it
  lease.mjs         fencing-token thread leases
  session.mjs       ties them together, plus HUD state
test/verify.mjs     end-to-end suite
spike/              protocol experiments and FINDINGS.md
docs/               the product website (GitHub Pages)
```

## License

[MIT](LICENSE)
