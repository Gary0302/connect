/**
 * Antigravity CLI (`agy`) as a second peer model, beside Codex.
 *
 * There is no daemon to talk to: every turn is one `agy -p` process in
 * stream-json mode. Conversations persist on agy's side (one SQLite file per
 * conversation under ~/.gemini/antigravity-cli/conversations/), and
 * `--conversation <id>` continues one with its memory intact.
 *
 * Measured against agy 1.2.16 on this machine, and what follows from it:
 *
 *   1. Headless runs cannot prompt, so any tool needing permission is
 *      auto-denied and listed in the result's `denied_actions`. File writes and
 *      mutating shell commands are denied; reads and `ls` go through. That is
 *      the read-only sandbox every non-`implement` intent wants, for free —
 *      within whatever the user's own agy `permissions.allow` already permits.
 *   2. The only headless way to let agy write is --dangerously-skip-permissions,
 *      and `--sandbox` does NOT confine that to the workspace: a probe wrote to
 *      ~/.cache from a workspace in /tmp. Codex's `workspace-write` has no agy
 *      equivalent, so `implement` is refused here rather than silently widened
 *      to full disk access.
 *   3. A bare "pong" costs ~11.7k tokens; finding one function in this repo cost
 *      36k-130k across five runs (agy reads several files per question). Codex's
 *      20k quick_answer ceiling would cut off nearly every agy turn, so agy has
 *      its own ceilings (AGY_CEILINGS).
 *   4. Per-step `usage` in step_update events sums to the result's usage, so a
 *      running total can enforce the ceiling mid-turn by killing the process.
 *
 *   5. Even told not to, agy sometimes calls run_command, is denied, and ends
 *      the turn empty-handed (1 run in 5). One follow-up turn in the same
 *      conversation, pointing at the denial, recovers it.
 *
 * agy has no command that lists conversations, and its storage format is
 * internal, so Connect keeps its own ledger of the conversations it started.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ROUTES } from "./router.mjs";
import { configPath } from "./config.mjs";

export const AGY_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/** Token ceilings per intent; see note 3 above for why they differ from Codex's. */
export const AGY_CEILINGS = Object.freeze({
  quick_answer: 150_000,
  second_opinion: 250_000,
  code_review: 400_000,
  deep_reasoning: 800_000,
});

export function resolveAgyBin() {
  if (process.env.CONNECT_AGY_BIN) return process.env.CONNECT_AGY_BIN;
  // Claude Code's MCP environment often lacks ~/.local/bin on PATH.
  const standalone = join(homedir(), ".local/bin/agy");
  return existsSync(standalone) ? standalone : "agy";
}

/**
 * The policy an agy turn runs with. Effort follows the user's Codex config when
 * agy accepts that level, else the built-in route: one effort setting for both
 * models is what the user expects, but a Codex-only level must not break agy.
 */
export function agyPolicy(intent, codexPolicy) {
  if (intent === "implement")
    throw new Error(
      "agy cannot run `implement`: headless agy can only write with --dangerously-skip-permissions, " +
        "which is not confined to the workspace. Use codex_ask for implement, or ask agy read-only."
    );
  const base = ROUTES[intent];
  if (!base) throw new Error(`unknown intent: ${intent}`);
  const effort = AGY_EFFORTS.includes(codexPolicy?.effort) ? codexPolicy.effort : base.effort;
  return { effort, maxTokens: AGY_CEILINGS[intent], sandbox: "read-only (headless denies writes)" };
}

/**
 * Measured: told nothing, agy reaches for run_command first, gets it denied,
 * and ends the turn with no answer; or delegates to a subagent and ends the
 * turn before it reports back. Its own read tools need no permission.
 */
export const READ_ONLY_PREAMBLE =
  "[Headless, read-only, single-turn run: nobody can approve anything and nothing runs after you stop. " +
  "Do not call run_command and do not delegate to subagents; both end the run with no answer. Read files " +
  "yourself with view_file, grep_search, find_by_name and list_dir, then give your complete answer in this reply.]\n\n";

const RETRY_NUDGE =
  "Your last step was denied and you stopped without answering. Do not run commands. Use view_file, " +
  "grep_search, find_by_name and list_dir, then answer the original question in full.";

/** The only mode in which headless agy cannot act without asking; anything else may write. */
const SAFE_PERMISSION_MODE = "request-review";

/** argv for one turn. Pure, so it is testable without spawning anything. */
export function agyArgs({ prompt, effort, model, conversationId }) {
  return [
    "-p", READ_ONLY_PREAMBLE + prompt,
    "--output-format", "stream-json",
    "--effort", effort,
    // Our own timer enforces the cap; agy's must not fire first with less detail.
    "--print-timeout", "0s",
    ...(model ? ["--model", model] : []),
    ...(conversationId ? ["--conversation", conversationId] : []),
  ];
}

/**
 * Ask agy, recovering once from an empty answer caused by a denied command
 * (note 5). Resolves with the answer and accounting; rejects only when agy
 * could not be started at all.
 */
export async function agyAsk(opts) {
  const first = await runTurn(opts);
  if (first.answer || first.interrupted || first.failed || !first.denied.includes("command") || !first.conversationId)
    return first;
  const left = opts.policy.maxTokens - first.tokens;
  if (left <= 0) return first;
  const second = await runTurn({ ...opts, prompt: RETRY_NUDGE, conversationId: first.conversationId, policy: { ...opts.policy, maxTokens: left } });
  return {
    ...second,
    tokens: first.tokens + second.tokens,
    steps: [...first.steps, ...second.steps],
    denied: [...first.denied, ...second.denied],
    retried: true,
  };
}

/**
 * One agy process. A turn over budget or over time is killed and reported as
 * interrupted, with whatever text had streamed so far.
 */
function runTurn({ prompt, intent, policy, model, conversationId, cwd, timeoutMs, bin = resolveAgyBin() }) {
  return new Promise((resolve, reject) => {
    // stdin ignored: agy -p has hung in the past waiting on a non-TTY stdin.
    const child = spawn(bin, agyArgs({ prompt, effort: policy.effort, model, conversationId }), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "", stderr = "", streamed = "", tokens = 0, cid = conversationId ?? null;
    let result = null, interrupted = null;
    const steps = [];

    const stop = (why) => {
      if (interrupted) return;
      interrupted = why;
      child.kill("SIGTERM");
    };
    const timer = timeoutMs ? setTimeout(() => stop(`exceeded the ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)} s`} time cap`), timeoutMs) : null;

    const onEvent = (ev) => {
      if (ev.event === "init") {
        cid = ev.conversation_id ?? cid;
        // A user setting that auto-approves tools would let this "read-only" turn write.
        const mode = ev.init?.permission_mode;
        if (mode && mode !== SAFE_PERMISSION_MODE) stop(`refused: agy runs in permission mode "${mode}", which can write without asking`);
      }
      else if (ev.event === "step_update") {
        const s = ev.step_update ?? {};
        if (s.text_delta) streamed += s.text_delta;
        if (s.step_type === "tool" && s.state === "DONE" && s.tool_name) steps.push(s.tool_name);
        if (s.state === "DONE" && s.usage?.total_tokens) {
          tokens += s.usage.total_tokens;
          if (tokens > policy.maxTokens) stop(`exceeded the ${policy.maxTokens.toLocaleString()}-token budget for this intent`);
        }
      } else if (ev.event === "result") result = ev.result;
    };

    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line)); } catch { /* a non-JSON line is agy chatter, not an event */ }
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new Error(`agy not found at "${bin}"; install the Antigravity CLI or set CONNECT_AGY_BIN`) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const failed = !interrupted && (!result || result.status !== "SUCCESS");
      resolve({
        answer: (result?.response ?? streamed).trim(),
        conversationId: result?.conversation_id ?? cid,
        tokens: result?.usage?.total_tokens ?? tokens,
        steps,
        denied: (result?.denied_actions ?? []).map((a) => a.action),
        interrupted,
        failed,
        error: failed ? (stderr.trim().split("\n").pop() || `agy exited ${code} with status ${result?.status ?? "none"}`) : null,
        intent,
        policy,
      });
    });
  });
}

/** Run agy with arguments and collect output; for doctor and model listing. */
export function agyRun(args, { bin = resolveAgyBin(), timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

// ------------------------------------------------------------------ ledger
/** Beside the user's config, outside the plugin dir that a reinstall wipes. */
export function ledgerPath() {
  return process.env.CONNECT_AGY_LEDGER || join(dirname(configPath()), "agy-conversations.jsonl");
}

/** One line per turn; the newest line for an id wins. */
export function recordTurn({ conversationId, cwd, prompt, intent, model }, path = ledgerPath()) {
  if (!conversationId) return;
  mkdirSync(dirname(path), { recursive: true });
  const line = { id: conversationId, cwd, intent, model: model ?? null, prompt: prompt.slice(0, 120), at: new Date().toISOString() };
  appendFileSync(path, JSON.stringify(line) + "\n");
}

/** Conversations newest first, each with its first prompt and turn count. */
export function listConversations(limit = 15, path = ledgerPath()) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const byId = new Map();
  for (const l of raw.split("\n")) {
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    const cur = byId.get(r.id);
    byId.set(r.id, cur ? { ...cur, at: r.at, turns: cur.turns + 1 } : { ...r, turns: 1 });
  }
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Where a known conversation was started, so a continuation runs there too. */
export const conversationCwd = (id, path = ledgerPath()) =>
  listConversations(Infinity, path).find((c) => c.id === id)?.cwd ?? null;
