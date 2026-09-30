# Connect

Talk to OpenAI Codex from inside Claude Code. Persistent threads, cost-aware routing, one shared
Codex daemon.

**Website:** [gary0302.github.io/connect](https://gary0302.github.io/connect/) ·
**Source:** [github.com/Gary0302/connect](https://github.com/Gary0302/connect)

It is a **Claude Code plugin**: an MCP server plus a skill and five slash commands. Nothing to
`npm install` — no dependencies at all.

## Install

From scratch:

```bash
# 1. the standalone Codex install (the daemon requires it; brew/npm codex is not enough)
curl -fsSL https://chatgpt.com/codex/install.sh | sh

# 2. the plugin
claude plugin marketplace add Gary0302/connect
claude plugin install connect@connect-local
```

Restart Claude Code, then `/connect:doctor` to confirm.

**Installing copies the directory into `~/.claude/plugins/cache/`.** Edits here do not take effect
until you resync. `claude plugin update connect@connect-local` is a no-op while the version in
`plugin.json` is unchanged, so during development either bump the version or:

```bash
claude plugin uninstall connect@connect-local && claude plugin install connect@connect-local
```

## Use it

Five slash commands:

```
/connect:ask      <question>            ask Codex
/connect:threads                        list recent Codex threads
/connect:resume   <threadId> <question> continue an earlier conversation
/connect:config                         pick model, effort and token ceilings (interactive)
/connect:doctor                         health check
```

### The `connect` skill

The plugin also ships a **skill** — the instructions that tell Claude *when and how* to use Codex on
its own. It loads automatically when you say "ask Codex", "what does Codex think", "get a second
opinion", or when Claude decides a risky diff or a contested design call deserves an independent
model. It is marked `user-invocable: false`, so it stays out of the `/` menu: there is nothing to
type, and `/connect:ask` covers asking directly.

Claude gets five MCP tools directly: `codex_ask`, `codex_threads`, `codex_history`,
`codex_config`, `codex_doctor`.

## Preferences

`/connect:config` with no arguments opens **forms in the terminal**, drawn by the MCP server itself
through MCP elicitation rather than by Claude asking questions:

1. model (from the daemon's live `model/list`, with Codex's descriptions), effort mode
   (auto by intent / one level everywhere / per intent), token ceilings (keep / built-in / 2× / 4×);
2. if you chose a level: **Codex's own effort levels for that model**, worded as Codex's `/model`
   picker words them (`low — Fast responses with lighter reasoning` … `ultra`);
3. only if the model changed: what to do with **existing threads**, because switching a thread's
   model throws away its prompt cache and the next turn re-reads the whole history at full price —
   change directly (default), compact first then change, or keep old threads on their model.

A client without elicitation gets a clear refusal, and the command falls back to `AskUserQuestion`.
It also takes arguments for quick changes:

```
/connect:config show
/connect:config model gpt-5.6-terra
/connect:config model default
/connect:config code_review xhigh
/connect:config old-threads compact
/connect:config reset
```

Stored in `~/.config/connect/config.json` (override with `CONNECT_CONFIG`), outside the plugin so
a reinstall does not wipe it, and read on every call so changes apply to the next ask. Models and
efforts are validated against what the daemon's `model/list` actually offers. Sandboxes are
deliberately not configurable. The CLI reads the same file; `--model` overrides it.

Measured while building this: `thread/resume` **ignores** `model` for a thread the daemon already
has loaded. The switch has to ride on `turn/start`, which then sticks for the thread's later turns.
Compaction (`thread/compact/start`) runs as its own turn — `contextCompaction` item, then
`turn/completed`, ~6s on a short thread — and no `thread/compacted` notification arrived.

There is also a standalone CLI if you want Codex without Claude in the loop:

```bash
node bin/connect.mjs doctor
node bin/connect.mjs threads 10
node bin/connect.mjs ask --intent quick_answer "what version of node is this"
node bin/connect.mjs ask --thread <id> "and what about the previous point?"
node bin/connect.mjs history <threadId>
```

## Resuming an existing session

Yes, and with memory intact. Every `codex_ask` result ends with its thread id; pass it back as
`threadId`. Threads live on the daemon and survive Claude Code restarts, daemon restarts, and
reboots — `thread/list` here returns conversations from days ago.

Verified: resume a thread, ask "what did I ask you earlier in this thread?", and Codex answers
correctly from the thread's own history.

## Why routing exists

The Codex thread default effort comes from `~/.codex/config.toml` — `xhigh` on this machine. One
measured one-sentence factual question at that default cost **273,840 tokens in 48 seconds**. The
same question as `quick_answer` costs about **16,000 tokens in 3.5 seconds**.

So every turn Connect issues pins `effort` explicitly:

| intent | effort | sandbox | for |
|---|---|---|---|
| `quick_answer` | low | read-only | facts, one-liners |
| `second_opinion` | medium | read-only | "is this sound?" |
| `code_review` | high | read-only | reading a diff |
| `deep_reasoning` | xhigh | read-only | architecture, protocols, races |
| `implement` | high | workspace-write | writing code |

Each route pins the sandbox too, because `approvalPolicy: "never"` decides *who is asked*, not
*what is possible* — with nobody to ask, whatever the ambient sandbox allows just happens. Asking
for an opinion should not be able to edit your tree. Measured both ways in spike 07.

Each also carries a token ceiling, measured against **this turn's** cost rather than the thread's
running total — see spike 06, where neither field the daemon reports is that number on its own. A
turn that blows through the ceiling is interrupted and says so; if the interrupt does not take, it
says that instead of claiming otherwise.

## Verify

```bash
export PATH="$HOME/.local/bin:$PATH"   # the standalone codex, not the brew one
node test/verify.mjs
```

126 checks: daemon lifecycle, WebSocket handshake and frame validation, two concurrent clients,
routing policy, user config, lease fencing, notification correlation against a shared daemon, per-turn budget
accounting, session lifecycle and refusal shapes, the MCP protocol surface driven over stdio, and
four live Codex turns — two of them full `codex_ask` calls through the MCP server, the second
continuing the first's thread after a `codex_config` model change (compact, then switch) — plus
the config forms driven over stdio. Everything except
those three runs offline and costs nothing.

`CONNECT_TEST_DISRUPTIVE=1` adds a reconnect test. It restarts the daemon, which kicks every
attached Codex session, so it is off by default.

## Layout

```
.claude-plugin/    plugin + marketplace manifests
.mcp.json          MCP server registration
mcp/               the MCP server (zero deps)
skills/connect/    when Claude should reach for Codex
commands/          slash commands
bin/connect.mjs    standalone CLI
src/
  ws-unix.mjs      minimal RFC 6455 client over a Unix socket
  codex-client.mjs JSON-RPC over that socket, with reconnect
  router.mjs       per-intent effort/summary policy
  config.mjs       user preferences layered over it
  lease.mjs        fencing-token thread leases
  session.mjs      binds the three, plus HUD state
test/verify.mjs    end-to-end suite
spike/FINDINGS.md  measured protocol behaviour — read before changing src/
```

## Do not restart the daemon casually

`codex app-server daemon restart`, `enable-remote-control` and `disable-remote-control` each tear
down the app-server and drop **every attached client** — including a Codex TUI the user has open,
mid turn, with `WebSocket protocol error: Connection reset without closing handshake`. Report
version mismatches; let the user pick the moment.

Connect survives it: the client reconnects with backoff, re-runs `initialize`, and resumes against
the same thread.

## Known gaps

- **Codex Remote Control needs MFA on the ChatGPT account.** Enrollment returns
  `403 {"detail":"Multi-factor authentication required"}`. Until then `remoteControl/client/list`
  is unavailable, so the lease registry runs against a simulated second writer rather than real
  co-presence data.
- **Two Codex installs coexist**: the standalone one (`~/.local/bin/codex`, what the daemon uses)
  and a brew one earlier in PATH for existing shells. Everything now resolves through
  `resolveCodexBin()`, so the CLI and the MCP server cannot disagree; override with
  `CONNECT_CODEX_BIN`.
- **A daemon restart mid-turn loses that turn's answer.** The client reconnects and the thread
  survives, but the in-flight turn is not resumed or replayed — it fails fast with a reset error
  rather than hanging until its timeout. Recovering the answer would mean reading the turn's items
  back after reconnecting.
- **`~/.codex/config.toml:3`** sets `network_access`, which is not a recognized field and is
  silently ignored.
- **No HUD yet.** `session.hudLine()` produces the status line, but nothing wires it into Claude
  Code's `statusLine`. That slot already holds your own script, so wiring it means composing with
  that rather than replacing it.
