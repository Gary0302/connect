# Connect spike 01 — Codex app-server round trip

Verified on 2026-08-21. `codex-cli 0.147.0`, Claude Code `2.1.238`, node `v26.3.0`, macOS 15.1 arm64.

## Result

Full round trip works end to end:

```
initialize -> initialized -> model/list -> thread/start -> turn/start
  -> item/agentMessage/delta (streamed) -> thread/tokenUsage/updated -> turn/completed
  -> thread/backgroundTerminals/list
```

Run it:

```bash
CONNECT_MODE=direct node spike/roundtrip.mjs "your prompt"   # works today
node spike/roundtrip.mjs "your prompt"                       # shared daemon; blocked, see below
```

## BLOCKER: the shared-daemon design needs the standalone Codex install

Both `codex app-server daemon start` and `codex remote-control start` fail with:

```
Error: managed standalone Codex install not found at
  /Users/gary/.codex/packages/standalone/current/codex
This command requires the standalone install managed by the Codex installer,
because the daemon starts and updates app-server from that fixed path.
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

This machine's codex is the npm install (`/opt/homebrew/lib/node_modules/@openai/codex`),
which ships the CLI but not the managed package tree.

Consequences for the v2 architecture:

- **`codex app-server proxy` is unusable** — there is no control socket to proxy to.
  `~/.codex/app-server-control/` does not exist.
- **Codex Remote Control is unavailable.** `remoteControl/status/read` returns
  `{"status":"disabled","serverName":"Mac",...}` and cannot be enabled without the daemon.
- **`codex --remote unix://PATH` is unusable** for the same reason, so the
  `/connect watch` "attach a real Codex TUI to the same app-server" trick is also blocked.

`CONNECT_MODE=direct` spawns a private `codex app-server` on stdio instead. The wire
protocol is byte-identical, so all Connect protocol work can proceed now; switching to the
shared daemon is one argv change in `codex-client.mjs` once the installer has been run.

Until then Connect gets **one Codex per connectd**, not a shared backend — which means the
thread-lease design has nothing to contend with yet.

## Protocol facts (from `codex app-server generate-json-schema --experimental`)

Regenerate any time into `spike/protocol/`. 133 client requests, 70 server notifications,
11 server->client requests. Do not hand-write these from the README.

Confirmed present, and directly load-bearing for Connect:

| Need | Methods |
|---|---|
| Remote Control control plane | `remoteControl/enable`, `remoteControl/disable`, `remoteControl/status/read`, `remoteControl/pairing/start`, `remoteControl/client/list`, `remoteControl/client/revoke`, notification `remoteControl/status/changed` |
| Thread lease / co-presence | `remoteControl/client/list` enumerates the other clients — this is the real input to the lease, not a guess |
| Shared terminals | `process/spawn`, `process/writeStdin`, `process/resizePty`, `process/kill`; notifications `process/outputDelta`, `process/exited` |
| Codex background terminals | `thread/backgroundTerminals/list` / `terminate` / `clean` |
| HUD: Codex context + cache | `thread/tokenUsage/updated` (`totalTokens`, `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`) |
| HUD: Codex rate limits | `account/rateLimits/read`, notification `account/rateLimits/updated` |
| Steering a live turn | `turn/steer`, `turn/interrupt` |

Exact shapes worth pinning:

- `initialize` -> `{ clientInfo: { name, version, title? }, capabilities?: { experimentalApi } }`.
  Must be followed by the `initialized` **notification** or later calls hang.
- `thread/start` -> `{ cwd?, approvalPolicy?, model?, ... }`, returns `{ threadId, model, modelProvider, reasoningEffort, ... }`.
- `turn/start` -> required `{ threadId, input: [{ type: "text", text }] }`; optional `model`, `effort`,
  `cwd`, `collaborationMode`, `personality`, `sandboxPolicy`, `outputSchema`, `serviceTier`.
- `AskForApproval` = `"untrusted" | "on-request" | "never"` or a `{ granular: {...} }` object.
- Framing is newline-delimited JSON, **not** `Content-Length`.
- Server->client requests (approvals, `item/tool/call`) **must** be answered or the turn stalls.

## Two things the spike changed my mind about

1. **Default effort is `xhigh`.** `thread/start` with no `effort` returned `reasoningEffort: "xhigh"`.
   A one-sentence factual question cost **273,840 tokens / 48.6s**. Connect's router must set
   `effort` explicitly per turn; inheriting the thread default makes the "cheap second opinion"
   path anything but cheap.
2. **No reasoning deltas arrived.** `item/reasoning/textDelta` and `item/reasoning/summaryTextDelta`
   never fired (0 chars) even across 48s of thinking. The HUD's `Codex ▸ reasoning...` line cannot
   rely on them until we find the opt-in — likely the `summary` param on `turn/start`. Open item.
   `thread/tokenUsage/updated` *did* fire ~8 times during the turn, so that is the reliable
   "Codex is alive and working" heartbeat for the HUD.

## Files

- `codex-client.mjs` — dependency-free JSON-RPC client; `mode: "proxy" | "direct"`.
- `roundtrip.mjs` — the driver above.
- `protocol/` — generated schema bundle (gitignore-able; regenerate with the command above).

---

# Connect spike 02 — the reasoning delta opt-in (SOLVED)

## Answer

`item/reasoning/*` notifications are gated behind the **`summary` parameter on `turn/start`**.
Omit it and Codex sends zero reasoning notifications, at any effort.

```js
await codex.request("turn/start", {
  threadId,
  input: [{ type: "text", text: prompt }],
  effort: "high",
  summary: "auto",        // <-- the opt-in. "auto" | "concise" | "detailed" | "none"
});
```

Controlled A/B, same prompt, same `effort: "medium"`:

| `summary` | `item/reasoning/summaryPartAdded` | `item/reasoning/summaryTextDelta` |
|---|---|---|
| omitted | 0 | 0 |
| `"detailed"` | 1 | 1 |
| `"auto"` (high effort, longer prompt) | 6 | 6 |

The config-file equivalent is `model_reasoning_summary`, confirmed a real field via
`--strict-config` (a bogus key errors with `unknown configuration field ... in -c/--config override`;
this one does not). **Prefer the per-turn param** — Connect should not mutate the user's global
`~/.codex/config.toml` to get HUD data.

## What the HUD actually receives — better than expected

The deltas are **not** token-by-token. `summaryPartAdded` and `summaryTextDelta` arrive 1:1, and
each delta is one complete, human-readable step headline:

```
[summaryTextDelta #0] "**Designing lease protocol with fencing tokens**"
[summaryTextDelta #1] "**Formulating lease protocol states and operations**"
[summaryTextDelta #2] "**Drafting lease protocol invariants and TTL**"
[summaryTextDelta #0] "**Planning atomic lease renewal and operation tracking**"
[summaryTextDelta #1] "**Defining lease and turn state transitions**"
[summaryTextDelta #2] "**Enforcing fail-closed and consensus safety measures**"
```

So the HUD line is a direct assignment, no buffering or truncation logic needed:

```
 Codex  ● reasoning · Enforcing fail-closed and consensus safety measures
```

Strip the surrounding `**`.

### Gotcha: `summaryIndex` resets per reasoning item

Note the indices above run `0,1,2` then `0,1,2` — one turn produced **two** reasoning items with
different `itemId`s (`rs_...`). Key HUD state on `(itemId, summaryIndex)`, never `summaryIndex`
alone, or later steps will overwrite earlier ones.

## Raw reasoning is NOT available

`show_raw_agent_reasoning` is a valid config field, but setting it changes nothing over app-server:
`item/reasoning/textDelta` never fires. Identical prompt, `summary: "auto"`, `effort: "high"`:

| config | textDelta | summaryTextDelta |
|---|---|---|
| (none) | 0 | 6 |
| `show_raw_agent_reasoning=true` | 0 | 3 |

gpt-5.6-sol reasoning appears to be encrypted upstream (cf. the `encrypted_content` variant in
`AgentMessageInputContent`). Connect must design for summaries only.

## Delta count is not guaranteed — keep the tokenUsage heartbeat

The same prompt produced 6 and then 3 summary parts on consecutive runs; a short turn produced 1.
A turn can plausibly produce none. So spike 01's conclusion stands unchanged:
**`thread/tokenUsage/updated` remains the HUD's liveness signal**, and reasoning summaries are the
optional "what is it doing right now" label layered on top.

## Cost note

`summary` does not measurably change token cost — it surfaces summaries the model already produces.
The expensive knob is `effort`, which spike 01 already flagged.

## Unrelated bug found in `~/.codex/config.toml`

Line 3 is `network_access = "enabled"`, which is **not a recognized field**:

```
$ codex app-server --strict-config
Error: /Users/gary/.codex/config.toml:3:1: unknown configuration field `network_access`
```

It is silently ignored in non-strict mode, so if this was meant to grant network access to Codex's
sandbox it is doing nothing. Worth checking against the current sandbox config schema.

## Spike 01 correction

`thread/start` returns the id at **`response.thread.id`**, not `response.threadId`
(required fields: `thread`, `model`, `modelProvider`, `cwd`, `sandbox`, `approvalPolicy`,
`approvalsReviewer`). Spike 01's fallback chain masked this; both scripts now use `thread.thread.id`.

## Files

- `reasoning-probe.mjs` — logs every notification method with counts; env `SUMMARY`, `EFFORT`,
  `CODEX_CONFIG` (comma-separated `-c` overrides).

---

# Connect spike 03 — the daemon transport is WebSocket, not JSONL

## The v2 doc's transport assumption was wrong

The plan was `connectd -> codex app-server proxy -> control socket`, treating proxy as a
JSON-RPC pipe. It is not. `proxy` is a **dumb byte pipe** — it forwards stdin to the socket
verbatim and does no handshake. Sending JSONL through it produces total silence: proxy blocks
while stdin is open, exits 0, and the daemon replies with nothing.

Connecting to the socket directly with `net.connect` and writing JSONL reproduces it exactly:
the daemon accepts the connection, then **closes it immediately**.

The socket speaks **WebSocket over the Unix domain socket**:

```
$ (HTTP/1.1 GET with Upgrade: websocket over the unix socket)
HTTP/1.1 101 Switching Protocols
connection: Upgrade
upgrade: websocket
sec-websocket-accept: JpTEGe+8mQ7UTpEVMBO9LeAAGfA=
```

A plain JSON line is not a valid upgrade request, so the server drops the connection — which is
the entire explanation for the silence.

**Connect therefore skips `proxy` altogether** and connects to the socket directly with a minimal
RFC 6455 client (`src/ws-unix.mjs`, no dependencies). One less subprocess per session, and the
handshake was our job either way.

Framing summary:

| Transport | Framing |
|---|---|
| `codex app-server` (stdio, private) | newline-delimited JSON |
| daemon control socket (shared) | WebSocket text frames, client frames masked |

## Standalone install: done, with a caveat

`curl -fsSL https://chatgpt.com/codex/install.sh | sh` installed **0.148.0** to
`~/.local/bin/codex` -> `~/.codex/packages/standalone/current/bin/codex`, and appended a PATH
block to `~/.zprofile` (`.zshrc` and `.profile` untouched).

**Two Codex installs now coexist.** The brew/npm one at `/opt/homebrew/bin/codex` is 0.147.0 and
still earlier in PATH for existing shells. The installer warned about this. The daemon always
uses the standalone path, so `cliVersion` vs `appServerVersion` can drift apart — which is exactly
the stale-daemon mismatch `/connect:doctor` must report. Connect should invoke the standalone
binary by absolute path rather than trusting PATH.

## Codex Remote Control: blocked on account MFA, not on Connect

With the standalone install present, `remoteControl/enable` now reaches the network and fails
with a precise reason:

```
remote control server enrollment failed at
  https://chatgpt.com/backend-api/wham/remote/control/server/enroll:
HTTP 403 Forbidden
{"detail":"Multi-factor authentication required"}
```

So Remote Control needs MFA enabled on the ChatGPT account. Until then
`remoteControl/status/read` reports `status: "errored"`, `environmentId: null`, and
`remoteControl/client/list` fails with `missing field 'environmentId'` — meaning the
**co-presence client list the lease design wanted as its input is unavailable** until enrollment
succeeds. The lease registry is written and tested against a simulated second writer; swap in
`remoteControl/client/list` once MFA is on.

Remote control was left **disabled** (its pre-existing state) so it does not retry-and-error in
the background. Re-enable with `codex app-server daemon enable-remote-control` after setting up MFA.

---

# Connect spike 04 — daemon lifecycle commands kill every attached client

## Symptom

A Codex TUI attached to the daemon died with:

```
ERROR: remote app server at `unix:///Users/gary/.codex/app-server-control/app-server-control.sock`
transport failed: WebSocket protocol error: Connection reset without closing handshake
Token usage: total=46,840 input=42,818 (+ 408,320 cached) output=4,022 (reasoning 682)
```

## Cause

Not a Connect defect and not contention. These daemon lifecycle commands tear down the
app-server, and every attached client is dropped without a WebSocket closing handshake:

| Command | Attached client |
|---|---|
| `codex app-server daemon restart` | **KICKED** |
| `codex app-server daemon enable-remote-control` | **KICKED** |
| `codex app-server daemon disable-remote-control` | **KICKED** |

Measured directly: attach a client, run the command, observe the drop. The Remote Control
debugging in spike 03 ran these repeatedly, which is what killed the session.

Ruled out by experiment:

- **Not a connection cap** — 12 simultaneous clients all connect and issue requests fine.
- **Not caused by abrupt client exits** — killing a client mid-connection leaves the daemon PID
  unchanged and healthy.
- **Not Connect-vs-TUI contention** — a Codex TUI attaches cleanly via
  `codex --remote unix://...` while a Connect client is holding a connection and issuing requests.

## Consequences for the design

1. **connectd must never issue these commands casually.** The v2 doc's `/connect:doctor` repair
   suggestion ("restart Codex app-server after current turn") would silently kill the user's own
   Codex TUI and any Remote Control session. Doctor should report the mismatch and let the user
   decide, or at minimum warn and enumerate what is attached.
2. **Getting kicked is normal, not exceptional.** A Codex auto-update restarts the daemon too.
   Any long-lived Connect session must expect the transport to vanish at any moment.

## Fix: automatic reconnect

`CodexClient` now reconnects with backoff (250ms -> 8s, six attempts), re-runs `initialize`, and
emits `reconnect`. In-flight requests are rejected immediately with
`connection to the Codex daemon was reset` rather than hanging until their timeout.

Threads are persisted server-side, so a reconnected client resumes against the same `threadId`:

```
attached; now restarting the daemon under it...
  transport dropped
  RECONNECTED on attempt 1
RESULT: still usable after daemon restart — threads = 25
```

The regression test for this is `[9]` in `test/verify.mjs` and is **opt-in**
(`CONNECT_TEST_DISRUPTIVE=1`) precisely because running it kicks the user's live Codex sessions.

---

# Connect spike 05 — resuming existing threads

`thread/resume` takes just `{ threadId }` and works. Verified: resume a thread created in an
earlier process, ask "what did I ask you earlier in this thread?", and Codex answers correctly
from the thread's own history. Threads persist across client restarts, daemon restarts and reboots.

Two corrections to the obvious approach:

- **`thread/items/list` is not implemented.** It is in the schema but answers
  `-32601: thread/items/list is not supported yet`. Use **`thread/turns/list`**, which returns
  `{ data: [{ items: [...] }] }`.
- **`initialTurnsPage` on the resume response is `null`**, even with `excludeTurns: false`. It is
  not a shortcut to the history; fetch turns separately.

`thread/list` accepts `{ limit, cursor, searchTerm, cwd, archived, sortKey, sortDirection }`, so
the thread picker can filter by working directory rather than listing everything.

---

# Connect spike 06 — what `thread/tokenUsage/updated` actually measures

Verified on 2026-08-22 against the standalone daemon. **Read this before touching the budget.**

`ThreadTokenUsage` carries two breakdowns, `last` and `total`, and neither one is the cost of the
current turn. Two turns on one thread, then one four-step tool turn:

```
two turns, one thread          one turn, four model requests
  last     total                 last      total
 16131    16131                 16228     16228
 16148    32279                 16363     32591
                                16496     49087
                                16586     65673
```

- **`total` is thread-cumulative.** It includes everything the thread spent before this turn, so a
  resumed thread trips any ceiling the moment it speaks. This is what the code used to compare
  against, which made `quick_answer` unusable on any thread with history.
- **`last` is the most recent model REQUEST, not the turn.** The four-step turn cost 65,673 tokens;
  `last` ended at 16,586 — understating it fourfold — because each step re-sends the context and
  `last` only ever reports the newest of those sends. Switching the budget to `last` looks correct
  on a one-step turn and silently stops policing multi-step ones.

The turn's own cost is `total - baseline`, where the baseline is pinned from the turn's **first**
usage update as `total - last`: at that moment `total` already includes `last`, so the difference
is exactly what the thread had spent beforehand. It needs no state carried between turns, which is
what makes it correct for a resumed thread as well. Confirmed against the table above: the first
row gives `16228 - 16228 = 0`, and the second row's `32591 - 16363 = 16228` reproduces the first
row's total.

Related: **`turn/interrupt` requires both ids.** `TurnInterruptParams.required` is
`["threadId", "turnId"]` (`codex app-server generate-json-schema --out <dir>`). Sending only the
thread id is rejected, so a budget interrupt built that way never stopped anything. The turn id
comes from `turn/started` or the `turn/start` response, both as `turn.id`. `Turn` itself carries
no usage, so the notification stream is the only source for cost.

Whether a turn really stopped is `turn/completed`'s `turn.status` (`completed` | `interrupted` |
`failed` | `inProgress`) — not whether an interrupt was sent.

---

# Connect spike 07 — `approvalPolicy` is not a sandbox

Verified on 2026-08-22. Same prompt, same thread setup, only `sandbox` differs:

```
sandbox=read-only        "It did not succeed. The shell returned `operation not permitted`
                          because the current workspace is read-only."
                         PROOF.txt exists: false   dir now: []

sandbox=workspace-write  "Succeeded. PROOF.txt was created and verified to contain WROTE."
                         PROOF.txt exists: true    dir now: [ 'PROOF.txt' ]
```

`thread/start` previously sent only `approvalPolicy: "never"`. That decides **who is asked**, not
**what is possible** — with nobody to ask, whatever the ambient sandbox permits simply happens. A
tool whose description says "ask for a second opinion" could edit the tree.

`ThreadStartParams.sandbox` and `ThreadResumeParams.sandbox` take `SandboxMode`, a string:
`read-only` | `workspace-write` | `danger-full-access`. Every route now pins it (`router.mjs`), and
only `implement` gets `workspace-write`. Read-only still lets Codex read the repo, which is where
most of its value comes from — the answers above were produced by a Codex that had run shell
commands to look around.

**Resuming needs it too.** `thread/resume` without `sandbox` inherits whatever the thread was
originally created with, which may be far broader than the route being run now.

Watch the naming: the **turn**-level field is `sandboxPolicy` and takes an OBJECT
(`{type: "readOnly", networkAccess: false}`); the **thread**-level field is `sandbox` and takes the
string enum above. They are not interchangeable.
