#!/usr/bin/env node
/**
 * Connect MCP server — exposes Codex (and the Antigravity CLI, agy) to Claude Code as tools.
 *
 * Speaks MCP over stdio (JSON-RPC 2.0, newline-delimited). No dependencies, to
 * match the rest of the project: a plugin that needs `npm install` before it
 * works is not "easy to install".
 *
 * One long-lived CodexClient is shared by every tool call, so Codex threads
 * persist for the life of the Claude Code session and survive daemon restarts
 * via the client's reconnect.
 */
import { CodexClient, resolveCodexBin } from "../src/codex-client.mjs";
import { LeaseRegistry } from "../src/lease.mjs";
import { ConnectSession } from "../src/session.mjs";
import { ROUTES, classify } from "../src/router.mjs";
import { loadConfig, saveConfig, applyPatch, effectivePolicy, configPath, MODEL_CHANGE } from "../src/config.mjs";
import { agyAsk, agyPolicy, agyRun, resolveAgyBin, recordTurn, listConversations, conversationCwd, AGY_CEILINGS } from "../src/agy-client.mjs";
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";

const SERVER = { name: "connect", version: "0.6.0" };

/**
 * Returned from `initialize` and injected into the client's context for the
 * whole session. Deliberately short and limited to what is not discoverable
 * from the tool schemas: the cost cliff, how threads continue, and what the
 * sandbox actually allows. `skills/connect/SKILL.md` covers the rest and only
 * loads when the model reaches for it; this is what must always be true.
 */
const INSTRUCTIONS = `Connect bridges this session to a local OpenAI Codex daemon. Use it when a
second, independent model genuinely changes the reliability of an answer — a contested design call,
subtle concurrency, a security-sensitive diff, or when the user asks for Codex by name. Do not
route work through it that you can simply do: it costs real tokens and adds latency.

ALWAYS pass \`intent\` to codex_ask. It sets reasoning effort, the token ceiling and the sandbox.
Omitting it falls back to guessing from the prompt. The default Codex effort on this machine is
xhigh, where one measured one-sentence factual question cost 273,840 tokens in 48 seconds; the same
question as quick_answer costs about 16,000 in 3.5 seconds. Match the intent to the weight of the
question — quick_answer for a fact, second_opinion for a judgement call, code_review for a diff,
deep_reasoning only for genuinely hard design questions.

Codex reads the working directory, so give it real file paths rather than pasting whole files. It
is read-only under every intent except \`implement\`, which lets it write to the workspace — pick
that one deliberately, never as a default.

Threads persist on the daemon across restarts. Every codex_ask result ends with its thread id; pass
it back as \`threadId\` to continue with the exchange's memory intact, and include that id when you
report back so the user can pick the conversation up later. codex_threads lists recent threads and
codex_history replays one.

Codex is a peer model, not an oracle. Report what it said as its view, not as fact, and say plainly
where you disagree — the disagreement is the reason to ask it. If a result says INTERRUPTED or
TURN FAILED, the answer is partial: say so rather than presenting it as complete.

If something looks broken, run codex_doctor. If it reports a version mismatch, tell the user; the
fix restarts the daemon and drops every attached Codex session, including any TUI they have open.
Never run that for them.

agy_ask reaches a second, different peer: Google's Antigravity CLI (Gemini by default), run as
one headless \`agy\` process per turn. It takes the same intents. Like Codex it is read-only under
every intent except \`implement\`, which lets it edit files inside the working directory but still
not run commands, so it cannot build or test what it wrote — check its edits yourself. Its result
ends with a conversation id; pass it back as \`conversationId\` to continue. Use it when the user asks for
Antigravity, agy or Gemini, or when a third independent view is worth the cost; the same rules
apply: report its view as its view, and say so when a result is INTERRUPTED or FAILED.`;
const leases = new LeaseRegistry();

let codex = null;
let connecting = null;

/** Lazy: don't touch the daemon until a tool is actually called. */
async function client() {
  if (codex) return codex;
  connecting ??= (async () => {
    const st = await CodexClient.ensureDaemon({ codexBin: codexBin() });
    const c = new CodexClient();
    await c.connect({ socketPath: st.socketPath });
    await c.handshake({ name: "connect-mcp" });
    // One responder, on the client, in the shape each method actually requires.
    c.on("serverRequest", (m) => c.declineServerRequest(m));
    // Without a listener, a transport error would be a fatal EventEmitter throw.
    c.on("error", (e) => process.stderr.write(`[connect] ${e.message}\n`));
    codex = c;
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Shared with the CLI, so the two cannot drive different codex installs. */
const codexBin = resolveCodexBin;

/** Shared turn time cap for both peers; the 5 min session default killed max-effort research. */
const turnTimeoutMs = () => Number(process.env.CONNECT_TURN_TIMEOUT_MS) || 3_600_000;

const TOOLS = [
  {
    name: "codex_ask",
    description:
      "Ask OpenAI Codex a question in a persistent thread. Use for a second opinion from a different " +
      "model, independent review of a design or diff, or a task worth cross-checking. Codex can read " +
      "the working directory, so it answers from the real code. Returns its full answer plus the model " +
      "that produced it. Pass threadId to continue an earlier conversation with its memory intact. " +
      "Every intent but `implement` runs Codex read-only; `implement` lets it write to the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to ask Codex." },
        intent: {
          type: "string",
          enum: Object.keys(ROUTES),
          description:
            "Routing profile; picks reasoning effort, cost ceiling and sandbox. quick_answer is cheap " +
            "and fast; deep_reasoning is expensive. ALWAYS set this — omitting it falls back to " +
            "guessing from the prompt, and guessing wrong is what makes a one-line question cost " +
            "270k tokens. Use `implement` only when Codex is meant to edit files.",
        },
        threadId: { type: "string", description: "Continue this existing Codex thread." },
        cwd: { type: "string", description: "Working directory for a new thread. Defaults to the current one." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "codex_threads",
    description: "List recent Codex threads on the shared daemon, newest first. Use to find a threadId to resume.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many (default 15)." } },
    },
  },
  {
    name: "codex_history",
    description: "Read back the turns of an existing Codex thread, so you can see what was discussed before.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        limit: { type: "number", description: "How many turns (default 20)." },
      },
      required: ["threadId"],
    },
  },
  {
    name: "codex_config",
    description:
      "Read or change the user's Connect preferences: which Codex model to use, and per-intent reasoning " +
      "effort and token ceiling. `show` (the default) returns the current settings plus every model the " +
      "daemon offers and the efforts each supports. `set` merges changes; `reset` clears everything back " +
      "to the built-in defaults. `interactive` opens forms in the user's terminal (MCP elicitation) and " +
      "saves what they pick; it errors if the client cannot show forms. Only change settings when the user " +
      "asked to. Sandboxes are not configurable. Changing the model resets Codex's prompt cache on any " +
      "existing thread that is continued afterwards; `onModelChange` decides how that is handled.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["show", "set", "reset", "interactive"], description: "Default show." },
        onModelChange: {
          type: "string",
          enum: [...MODEL_CHANGE],
          description:
            "When an existing thread runs on a different model than configured: switch it on the next turn " +
            "(default; its prompt cache is lost), compact it first then switch, or keep it on its old model.",
        },
        model: {
          type: ["string", "null"],
          description: "Model id from `show`. null or \"\" goes back to Codex's own default.",
        },
        intents: {
          type: "object",
          description:
            "Per-intent overrides, e.g. {\"second_opinion\": {\"effort\": \"high\", \"maxTokens\": 160000}}. " +
            "Set a field to null to revert it to the built-in default.",
          properties: Object.fromEntries(
            Object.keys(ROUTES).map((k) => [
              k,
              {
                type: "object",
                properties: { effort: { type: ["string", "null"] }, maxTokens: { type: ["integer", "null"] } },
              },
            ])
          ),
        },
      },
    },
  },
  {
    name: "codex_doctor",
    description:
      "Health of the Codex integration: daemon status, CLI/app-server version match, socket, remote control state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agy_ask",
    description:
      "Ask Google's Antigravity CLI (agy; Gemini by default) a question, as a second peer model beside " +
      "Codex. Each call is one headless agy turn that can read the working directory. Every intent but " +
      "`implement` is read-only; `implement` lets agy create and edit files inside the working directory " +
      "(never outside it, never shell commands). Pass conversationId to continue an earlier agy " +
      "conversation with its memory intact.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to ask agy." },
        intent: {
          type: "string",
          enum: Object.keys(AGY_CEILINGS),
          description:
            "Routing profile; picks reasoning effort, the token ceiling and whether agy may write. ALWAYS " +
            "set this; omitting it guesses from the prompt, and a guess is never `implement`. Use " +
            "`implement` only when agy is meant to edit files.",
        },
        conversationId: { type: "string", description: "Continue this existing agy conversation." },
        model: { type: "string", description: "agy model id (see agy_doctor). Omit for agy's own default." },
        cwd: { type: "string", description: "Working directory for a new conversation. Defaults to the current one." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "agy_threads",
    description:
      "List the agy conversations Connect has started, newest first, with where each ran. Use to find a " +
      "conversationId to continue.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many (default 15)." } },
    },
  },
  {
    name: "agy_doctor",
    description: "Health of the Antigravity CLI integration: which agy binary, its version, and the models it offers.",
    inputSchema: { type: "object", properties: {} },
  },
];

const handlers = {
  async codex_ask({ prompt, intent, threadId, cwd }) {
    const c = await client();
    const session = new ConnectSession(c, leases);
    try {
      // The intent is settled before the thread exists, because it decides the
      // sandbox, and the sandbox is a property of the thread rather than a turn.
      const chosen = intent ?? classify(prompt);
      const sandbox = ROUTES[chosen]?.sandbox ?? "read-only";
      // Read per call, so a change made with codex_config applies to the next ask.
      const cfg = loadConfig();
      let turnModel;
      let switchNote = "";
      if (threadId) {
        // Resuming without stating the sandbox would inherit whatever the thread
        // was originally configured with, which may be far broader than this route.
        //
        // No `model` here: measured, thread/resume ignores it for a thread the
        // daemon already has loaded. The switch has to ride on turn/start, which
        // then sticks for the thread's later turns.
        const r = await c.request("thread/resume", { threadId, sandbox });
        session.threadId = r.thread.id;
        session.hud.model = r.model;
        if (cfg.model && r.model && r.model !== cfg.model) {
          if (cfg.onModelChange === "keep") {
            switchNote = ` · kept on ${r.model} (config says ${cfg.model}; onModelChange=keep)`;
          } else {
            if (cfg.onModelChange === "compact") await session.compact();
            turnModel = cfg.model;
            switchNote =
              ` · switched ${r.model} -> ${cfg.model}` +
              (cfg.onModelChange === "compact" ? " after compacting" : "; prompt cache reset for this thread");
            session.hud.model = cfg.model;
          }
        }
      } else {
        const r = await session.startThread({ cwd: cwd || process.cwd(), sandbox, model: cfg.model ?? undefined });
        session.hud.model = r.model;
      }
      const res = await session.ask(prompt, { intent: chosen, model: turnModel, policy: (i) => effectivePolicy(i, cfg), timeoutMs: turnTimeoutMs() });
      const steps = [...session.reasoning.values()].flatMap((m) => [...m.values()]);
      const note = res.interrupted
        ? " · INTERRUPTED: exceeded the budget for this intent, so the answer is partial"
        : res.budgetExceeded
          ? ` · OVER BUDGET and the interrupt did not take${res.interruptError ? ` (${res.interruptError.message})` : ""}`
          : res.failed
            ? ` · TURN FAILED: ${res.error?.message ?? "no reason given"}`
            : "";
      return [
        res.answer || (res.failed ? "(the turn failed before producing an answer)" : "(no answer)"),
        "",
        `---`,
        `thread: ${session.threadId}  (pass this as threadId to continue)`,
        // Report the model the daemon actually used rather than asserting one.
        `routed: ${res.intent} · ${session.hud.model ?? "model unknown"} · effort ${res.policy.effort}${res.policy.customized ? " (your config)" : ""}` +
          ` · sandbox ${sandbox} · ${res.tokens.toLocaleString()} tokens this turn${switchNote}${note}`,
        steps.length ? `steps: ${steps.map((s) => s.replace(/\*\*/g, "")).join(" -> ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    } finally {
      // The client outlives every call; a session left attached to it would keep
      // ingesting notifications for the rest of the process.
      session.dispose();
    }
  },

  async codex_threads({ limit = 15 }) {
    const c = await client();
    const list = await c.request("thread/list", { limit });
    const rows = (list.data ?? []).map(
      (t) => `${t.id}  ${(t.name ?? "(unnamed)").slice(0, 40).padEnd(42)}${t.cwd ?? ""}`
    );
    return rows.length ? rows.join("\n") : "no threads yet";
  },

  async codex_history({ threadId, limit = 20 }) {
    const c = await client();
    await c.request("thread/resume", { threadId });
    // thread/items/list exists in the schema but answers "not supported yet".
    const tl = await c.request("thread/turns/list", { threadId, limit });
    const out = [];
    for (const turn of tl.data ?? []) {
      for (const it of turn.items ?? []) {
        const txt = it.text ?? it.content?.[0]?.text ?? "";
        if (!txt) continue;
        out.push(`${it.type === "userMessage" ? "user " : "codex"}: ${String(txt).replace(/\s+/g, " ").slice(0, 400)}`);
      }
    }
    return out.length ? out.join("\n\n") : "(no turns recorded on this thread)";
  },

  async codex_config({ action = "show", model, onModelChange, intents }) {
    const models = await listModels();
    let summary = "";
    if (action === "reset") {
      saveConfig({ model: null, onModelChange: "switch", intents: {} });
    } else if (action === "set") {
      if (model === undefined && !intents && onModelChange == null)
        throw new Error("set needs `model`, `onModelChange` and/or `intents`");
      saveConfig(validate(applyPatch(loadConfig(), { model, onModelChange, intents }), models));
    } else if (action === "interactive") {
      const r = await interactiveConfig(models);
      if (!r) return "No changes: the form was cancelled.\n\n" + renderConfig(loadConfig(), models);
      summary = r;
    } else if (action !== "show") {
      throw new Error(`unknown action: ${action}`);
    }
    return (summary ? summary + "\n\n" : "") + renderConfig(loadConfig(), models);
  },

  async codex_doctor() {
    const st = await CodexClient.ensureDaemon({ codexBin: codexBin() });
    const c = await client();
    const rc = await c.request("remoteControl/status/read");
    const stale = st.cliVersion !== st.appServerVersion;
    const lines = [
      `daemon          ${st.status} (${st.backend})`,
      `socket          ${st.socketPath}`,
      `cli / server    ${st.cliVersion} / ${st.appServerVersion}${stale ? "   MISMATCH" : "   ok"}`,
      `managed codex   ${st.managedCodexPath}`,
      `remote control  ${rc.status}`,
    ];
    if (stale)
      lines.push(
        "",
        "The daemon runs an older app-server than the CLI. Fixing it needs",
        "`codex app-server daemon restart`, which DROPS every attached Codex session.",
        "Tell the user; do not run it for them."
      );
    if (rc.status === "errored")
      lines.push("", "Remote control could not enroll. Enrollment requires MFA on the ChatGPT account.");
    return lines.join("\n");
  },
};

Object.assign(handlers, {
  async agy_ask({ prompt, intent, conversationId, model, cwd }) {
    let chosen = intent ?? classify(prompt);
    // Writing must be asked for: a guess never lands on implement.
    if (!intent && chosen === "implement") chosen = "second_opinion";
    const policy = agyPolicy(chosen, effectivePolicy(chosen, loadConfig()));
    // agy denies every write from a path with a symlink in it (agy-client note 2a).
    const dir = realpathSync(cwd || (conversationId && conversationCwd(conversationId)) || process.cwd());
    const res = await agyAsk({ prompt, intent: chosen, policy, model, conversationId, cwd: dir, timeoutMs: turnTimeoutMs() });
    recordTurn({ conversationId: res.conversationId, cwd: dir, prompt, intent: chosen, model });
    const note = res.interrupted
      ? ` · INTERRUPTED: ${res.interrupted}, so the answer is partial`
      : res.failed
        ? ` · TURN FAILED: ${res.error}`
        : "";
    return [
      res.answer || (res.failed ? "(the turn failed before producing an answer)" : "(no answer)"),
      "",
      `---`,
      `conversation: ${res.conversationId ?? "unknown"}  (pass this as conversationId to continue)`,
      `routed: ${chosen} · agy ${model ?? "default model"} · effort ${res.effortNote ?? policy.effort} · ${policy.sandbox}` +
        ` · ${res.tokens.toLocaleString()} tokens this turn${res.retried ? " (incl. one retry after a denied command)" : ""}${note}`,
      res.edited.length ? `edited: ${res.edited.join(", ")}` : "",
      res.gitReverted.length ? `REVERTED agy's changes to ${res.gitReverted.join(", ")} (git would have run or obeyed them)` : "",
      res.denied.length ? `denied (${policy.write ? "outside the workspace, or a command" : "read-only"}): ${[...new Set(res.denied)].join(", ")}` : "",
      res.steps.length ? `steps: ${res.steps.join(" -> ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },

  async agy_threads({ limit = 15 }) {
    const rows = listConversations(limit).map(
      (c) => `${c.id}  ${c.at.slice(0, 16).replace("T", " ")}  ${String(c.turns).padStart(2)} turns  ${c.prompt.slice(0, 40).padEnd(42)}${c.cwd ?? ""}`
    );
    return rows.length ? rows.join("\n") : "no agy conversations started through Connect yet";
  },

  async agy_doctor() {
    const bin = resolveAgyBin();
    let ver;
    try {
      ver = await agyRun(["--version"], { bin });
    } catch (e) {
      return `agy binary      ${bin}   NOT FOUND (${e.message})\n\nInstall the Antigravity CLI, or set CONNECT_AGY_BIN.`;
    }
    const models = await agyRun(["models"], { bin });
    const list = models.stdout.split("\n").filter((l) => l.includes("\t")).map((l) => `  ${l.replace("\t", " — ")}`);
    return [
      `agy binary      ${bin}`,
      `version         ${ver.stdout.trim() || ver.stderr.trim() || `exit ${ver.code}`}`,
      `conversations   ${listConversations(Infinity).length} started through Connect`,
      "",
      list.length ? "available models:" : `could not list models: ${(models.stderr || models.stdout).trim() || `exit ${models.code}`}`,
      ...list,
    ].join("\n");
  },
});

/**
 * Check a config against what the daemon actually offers, not a hardcoded
 * list: the catalogue changes under us, and so do each model's allowed efforts.
 */
function validate(next, models) {
  const byId = new Map(models.map((m) => [m.id, m]));
  if (next.model && !byId.has(next.model))
    throw new Error(`unknown model: ${next.model}. available: ${models.map((m) => m.id).join(", ")}`);
  const target = byId.get(next.model) ?? models.find((m) => m.isDefault);
  const allowed = effortsOf(target);
  for (const [i, o] of Object.entries(next.intents)) {
    if (o.effort && allowed.length && !allowed.includes(o.effort))
      throw new Error(`${target.id} does not support effort "${o.effort}" (for ${i}). supported: ${allowed.join(", ")}`);
  }
  return next;
}

const effortsOf = (m) => m?.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [];

/** The model's own wording for each level, as Codex's /model picker shows it. */
const effortField = (m, title, current) => {
  const levels = m.supportedReasoningEfforts;
  const ids = levels.map((e) => e.reasoningEffort);
  return {
    type: "string",
    title,
    enum: ids,
    enumNames: levels.map((e) => `${e.reasoningEffort} — ${e.description}`),
    // Clamp to the highest supported level at or below the current one.
    default: ids.includes(current) ? current : ids[ids.length - 1],
  };
};

/**
 * Settings as native forms in the user's terminal. Up to three short forms,
 * each depending on the last: the efforts on offer depend on the model.
 * Returns a one-line summary, or null if the user cancelled.
 */
async function interactiveConfig(models) {
  if (!clientCapabilities?.elicitation)
    throw new Error("this client cannot show forms (no MCP elicitation support); ask with AskUserQuestion instead");
  const cfg = loadConfig();
  const def = models.find((m) => m.isDefault);
  const custom = Object.keys(cfg.intents).length > 0;
  const DEFAULT = "__codex_default__";

  const f1 = await elicit("Connect — which Codex model and effort?", {
    model: {
      type: "string",
      title: "Model",
      enum: [DEFAULT, ...models.map((m) => m.id)],
      enumNames: [
        `Codex default (currently ${def?.id ?? "unknown"}) — follows ~/.codex/config.toml`,
        ...models.map((m) => `${m.id} — ${m.description}`),
      ],
      default: cfg.model ?? DEFAULT,
    },
    effort: {
      type: "string",
      title: "Reasoning effort",
      enum: [...(custom ? ["keep"] : []), "auto", "all", "per_intent"],
      enumNames: [
        ...(custom ? ["Keep my current per-intent settings"] : []),
        "Auto — by intent: quick low, 2nd opinion medium, review high, deep xhigh, implement high",
        "One Codex level for every intent",
        "Pick a Codex level per intent",
      ],
      default: custom ? "keep" : "auto",
    },
    ceilings: {
      type: "string",
      title: "Token ceiling (a turn past it is cut off)",
      enum: ["keep", "builtin", "2x", "4x"],
      enumNames: ["Keep as is", "Built-in (20k … 400k by intent)", "2× built-in", "4× built-in"],
      default: "keep",
    },
  });
  if (f1.action !== "accept") return null;
  const picked = f1.content.model === DEFAULT ? null : f1.content.model;
  const target = models.find((m) => m.id === picked) ?? def;
  const intents = {};
  const names = Object.keys(ROUTES);

  if (f1.content.effort === "auto") for (const i of names) intents[i] = { effort: null };
  if (f1.content.effort === "all" || f1.content.effort === "per_intent") {
    const one = f1.content.effort === "all";
    const fields = one
      ? { all: effortField(target, `Effort for every intent (${target.id})`, effectivePolicy("second_opinion", cfg).effort) }
      : Object.fromEntries(names.map((i) => [i, effortField(target, i, effectivePolicy(i, cfg).effort)]));
    const f2 = await elicit(`Codex reasoning effort on ${target.id}`, fields);
    if (f2.action !== "accept") return null;
    for (const i of names) intents[i] = { effort: one ? f2.content.all : f2.content[i] };
  }
  const scale = { builtin: null, "2x": 2, "4x": 4 }[f1.content.ceilings];
  if (f1.content.ceilings !== "keep")
    for (const i of names) intents[i] = { ...intents[i], maxTokens: scale ? ROUTES[i].maxTokens * scale : null };

  let onModelChange;
  const modelChanged = (picked ?? null) !== (cfg.model ?? null);
  if (modelChanged) {
    const f3 = await elicit(
      `Switching to ${picked ?? "the Codex default"} resets Codex's prompt cache on every existing thread you ` +
        "continue afterwards: its next turn re-reads the whole history at full price. New threads are unaffected.",
      {
        onModelChange: {
          type: "string",
          title: "Existing threads",
          enum: [...MODEL_CHANGE],
          enumNames: [
            "Change directly on their next turn (default)",
            "Compact first, then change — smaller uncached history, ~a few seconds extra",
            "No — keep old threads on their model; only new threads use the new one",
          ],
          default: cfg.onModelChange ?? "switch",
        },
      }
    );
    if (f3.action !== "accept") return null;
    onModelChange = f3.content.onModelChange;
  }

  // Unsupported leftovers (a kept override the new model lacks) fail here,
  // before anything is written, with the valid levels in the message.
  saveConfig(validate(applyPatch(cfg, { model: modelChanged ? picked : undefined, onModelChange, intents }), models));
  const bits = [];
  if (modelChanged) bits.push(`model -> ${picked ?? "Codex default"} (existing threads: ${onModelChange})`);
  if (f1.content.effort !== "keep") bits.push(`effort -> ${f1.content.effort === "per_intent" ? "per intent" : f1.content.effort}`);
  if (f1.content.ceilings !== "keep") bits.push(`ceilings -> ${f1.content.ceilings}`);
  return bits.length ? `Saved: ${bits.join("; ")}.` : "Saved (nothing changed).";
}

async function listModels() {
  const c = await client();
  const out = [];
  let cursor = null;
  do {
    const r = await c.request("model/list", cursor ? { cursor } : {});
    out.push(...(r.data ?? []));
    cursor = r.nextCursor ?? null;
  } while (cursor);
  return out.filter((m) => !m.hidden);
}

function renderConfig(cfg, models) {
  const def = models.find((m) => m.isDefault);
  const lines = [
    `config file  ${configPath()}`,
    `model        ${cfg.model ?? `(Codex default: ${def?.id ?? "unknown"})`}`,
    `old threads  ${{ switch: "switch to the configured model (cache resets)", compact: "compact, then switch", keep: "stay on their own model" }[cfg.onModelChange ?? "switch"]}`,
    "",
    "intent           effort    token ceiling   sandbox",
  ];
  for (const intent of Object.keys(ROUTES)) {
    const p = effectivePolicy(intent, cfg);
    const o = cfg.intents[intent] ?? {};
    const mark = (v, set) => `${v}${set ? "*" : ""}`;
    lines.push(
      `${intent.padEnd(17)}${mark(p.effort, o.effort != null).padEnd(10)}` +
        `${mark(p.maxTokens.toLocaleString(), o.maxTokens != null).padEnd(16)}${p.sandbox}`
    );
  }
  lines.push("(* = your override; everything else is the built-in default)", "", "available models:");
  for (const m of models) {
    const efforts = m.supportedReasoningEfforts.map((e) => e.reasoningEffort).join(", ");
    lines.push(`  ${m.id}${m.isDefault ? " (default)" : ""} — ${m.description} efforts: ${efforts}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------ MCP wire
/** Newest first; the first entry is what we fall back to. */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

/** What the client said it supports in `initialize`; gates elicitation. */
let clientCapabilities = null;

/** Server -> client requests (elicitation), matched to their replies by id. */
const outbound = new Map();
let outboundSeq = 0;
function requestClient(method, params) {
  const id = `connect-${++outboundSeq}`;
  return new Promise((resolve, reject) => {
    outbound.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

/** One form. No timeout: it waits on a person, and they may take a while. */
const elicit = (message, properties) =>
  requestClient("elicitation/create", { message, requestedSchema: { type: "object", properties } });
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message, code = -32603) => send({ jsonrpc: "2.0", id, error: { code, message } });

const rl = createInterface({ input: process.stdin });

/** In-flight tool calls, so closing stdin does not cut one off mid-answer. */
let inFlight = 0;
let stdinClosed = false;
const maybeExit = () => {
  if (!stdinClosed || inFlight > 0) return;
  codex?.close();
  // Exiting straight after a write can truncate it. Let stdout drain first.
  process.stdout.write("", () => process.exit(0));
};
rl.on("close", () => { stdinClosed = true; maybeExit(); });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // A silently dropped frame leaves the client waiting forever for a reply.
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  const { id, method, params } = msg;

  // A reply to one of our own requests, not a request to us.
  if (!method && id != null && outbound.has(id)) {
    const p = outbound.get(id);
    outbound.delete(id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "client refused the request"));
    else p.resolve(msg.result ?? {});
    return;
  }

  try {
    switch (method) {
      case "initialize": {
        // Agree to the client's version only if we actually speak it; echoing an
        // arbitrary version back claims support this server does not have.
        const asked = params?.protocolVersion;
        clientCapabilities = params?.capabilities ?? null;
        return reply(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER,
          instructions: INSTRUCTIONS,
        });
      }
      case "notifications/initialized":
      case "initialized":
        return; // notification, no response
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: TOOLS });
      case "tools/call": {
        const fn = handlers[params?.name];
        if (!fn) return fail(id, `unknown tool: ${params?.name}`, -32602);
        inFlight++;
        try {
          const text = await fn(params.arguments ?? {});
          reply(id, { content: [{ type: "text", text }] });
        } catch (e) {
          // A failing tool is a tool RESULT carrying isError, not a protocol
          // error: the model should see what went wrong and be able to react.
          reply(id, { content: [{ type: "text", text: `connect error: ${e.message}` }], isError: true });
        } finally {
          // Decremented only after the reply is written, so a shutdown racing
          // the last call cannot exit between the two.
          inFlight--;
          maybeExit();
        }
        return;
      }
      default:
        if (id !== undefined) return fail(id, `unknown method: ${method}`, -32601);
    }
  } catch (e) {
    // Anything outside tools/call failing is a protocol-level error; answering
    // it with a tool-result shape would be a lie about what went wrong.
    if (id !== undefined) fail(id, e.message);
  }
});

process.on("SIGTERM", () => { codex?.close(); process.exit(0); });
process.on("SIGINT", () => { codex?.close(); process.exit(0); });
