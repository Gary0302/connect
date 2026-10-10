/**
 * Antigravity CLI (`agy`) as a second peer model, beside Codex.
 *
 * There is no daemon to talk to: every turn is one `agy -p` process in
 * stream-json mode. Conversations persist on agy's side (one SQLite file per
 * conversation under ~/.gemini/antigravity-cli/conversations/), and
 * `--conversation <id>` continues one with its memory intact.
 *
 * Measured against agy 1.2.16 and 1.3.2 on this machine, and what follows from it:
 *
 *   1. Headless runs cannot prompt, so any tool needing permission is
 *      auto-denied and listed in the result's `denied_actions`. File writes and
 *      mutating shell commands are denied; reads inside the working directory
 *      and `ls` go through, reads outside it are denied. That is the read-only
 *      sandbox every non-`implement` intent wants, for free — within whatever
 *      the user's own agy `permissions.allow` already permits.
 *   2. `--mode accept-edits` (1.3.2) is the workspace-write equivalent:
 *      write_to_file and replace_file_content succeed inside the working
 *      directory, and are denied outside it by absolute path, `../`, `/x/../`,
 *      or a symlink (to a file or a directory) inside the workspace. Shell
 *      commands stay denied, inside the workspace too. The mode is per turn: a
 *      continued conversation without the flag is read-only again. `init`
 *      still reports permission_mode "request-review".
 *      Not confined: a hard link inside the workspace writes through to its
 *      target (as with Codex), and `.git/` is writable, so a hook or a config
 *      `core.hooksPath` would run later as the user. Hence the .git guard below.
 *      --dangerously-skip-permissions is never used: `--sandbox` does not keep
 *      it in the workspace (a probe wrote to ~/.cache from a workspace in /tmp).
 *   2a. The workspace check compares unresolved paths: started from a path
 *      with a symlink in it (/tmp is one on macOS), every write is denied, even
 *      inside. Callers pass a realpath.
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
import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync, lstatSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ROUTES } from "./router.mjs";
import { configPath } from "./config.mjs";

export const AGY_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/** Token ceilings per intent; see note 3 above for why they differ from Codex's. */
export const AGY_CEILINGS = Object.freeze({
  quick_answer: 150_000,
  second_opinion: 250_000,
  code_review: 400_000,
  deep_reasoning: 800_000,
  implement: 600_000,
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
  const base = ROUTES[intent];
  if (!base) throw new Error(`unknown intent: ${intent}`);
  const effort = AGY_EFFORTS.includes(codexPolicy?.effort) ? codexPolicy.effort : base.effort;
  const write = intent === "implement";
  return {
    effort,
    maxTokens: AGY_CEILINGS[intent],
    write,
    sandbox: write ? "workspace-write (accept-edits, no shell, .git guarded)" : "read-only",
  };
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

export const IMPLEMENT_PREAMBLE =
  "[Headless, single-turn run that may edit files: nobody can approve anything and nothing runs after you stop. " +
  "Create and edit files inside the working directory with write_to_file and replace_file_content; writes outside " +
  "it are denied. run_command is denied too, so you cannot build, test or run anything. Do not touch .git/. Do not " +
  "delegate to subagents. Make the change, then say in this reply which files you changed and what is unverified.]\n\n";

const RETRY_NUDGE =
  "Your last step was denied and you stopped without answering. Do not run commands. Use view_file, " +
  "grep_search, find_by_name and list_dir, then answer the original question in full.";

const IMPLEMENT_RETRY_NUDGE =
  "Your last step was denied and you stopped without finishing. Do not run commands. Read with view_file, " +
  "grep_search, find_by_name and list_dir, edit with write_to_file and replace_file_content, then finish the " +
  "original task and say which files you changed.";

/**
 * Modes in which headless agy cannot act without asking. accept-edits is let
 * through only on a write turn, in case agy starts reporting it (note 2).
 */
const SAFE_PERMISSION_MODES = ["request-review"];
const WRITE_PERMISSION_MODES = ["request-review", "accept-edits"];

/** argv for one turn. Pure, so it is testable without spawning anything. */
export function agyArgs({ prompt, effort, model, conversationId, write = false }) {
  return [
    "-p", (write ? IMPLEMENT_PREAMBLE : READ_ONLY_PREAMBLE) + prompt,
    "--output-format", "stream-json",
    "--effort", effort,
    // Our own timer enforces the cap; agy's must not fire first with less detail.
    "--print-timeout", "0s",
    // Per turn (note 2), so a read-only continuation of a write conversation stays read-only.
    ...(write ? ["--mode", "accept-edits"] : []),
    ...(model ? ["--model", model] : []),
    ...(conversationId ? ["--conversation", conversationId] : []),
  ];
}

// ---------------------------------------------------------------- .git guard
/** Not walked: large, and nothing in them is executed or obeyed by git. */
const GIT_SKIP_DIRS = new Set(["objects", "logs", "refs", "lfs"]);
/** What git runs or obeys: hooks, config (core.hooksPath, fsmonitor, filters) and info/, at any depth (modules/*). */
const isGitControl = (rel) => /(^|\/)(config|hooks\/.+|info\/.+)$/.test(rel);

/**
 * Contents and modes of the files under `<cwd>/.git` that could make agy's
 * edits run as the user later (note 2). A `.git` file (worktree, submodule)
 * points outside the workspace, where agy cannot write anyway.
 */
export function snapshotGit(cwd) {
  const root = join(cwd, ".git");
  const files = new Map();
  let st;
  try { st = lstatSync(root); } catch { return null; }
  if (!st.isDirectory()) return null;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!GIT_SKIP_DIRS.has(e.name)) walk(p); continue; }
      const rel = relative(root, p);
      if (!e.isFile() || !isGitControl(rel)) continue;
      files.set(rel, { data: readFileSync(p), mode: lstatSync(p).mode & 0o777 });
    }
  };
  walk(root);
  return { root, files };
}

/** Put the snapshot back; returns the .git paths agy changed, added or removed. */
export function restoreGit(snap) {
  if (!snap) return [];
  const now = snapshotGit(dirname(snap.root))?.files ?? new Map();
  const touched = [];
  for (const [rel, cur] of now) {
    const was = snap.files.get(rel);
    if (was && was.mode === cur.mode && was.data.equals(cur.data)) continue;
    touched.push(rel);
    if (!was) rmSync(join(snap.root, rel), { force: true });
  }
  for (const [rel, was] of snap.files) {
    const cur = now.get(rel);
    if (cur && cur.mode === was.mode && cur.data.equals(was.data)) continue;
    if (!cur) touched.push(rel);
    const p = join(snap.root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, was.data);
    chmodSync(p, was.mode);
  }
  return touched.map((rel) => join(".git", rel)).sort();
}

/**
 * Ask agy, recovering once from an empty answer caused by a denied command
 * (note 5). Resolves with the answer and accounting; rejects only when agy
 * could not be started at all.
 */
export async function agyAsk(opts) {
  const snap = opts.policy.write ? snapshotGit(opts.cwd) : null;
  try {
    const res = await askWithRetry(opts);
    return { ...res, gitReverted: restoreGit(snap) };
  } catch (e) {
    restoreGit(snap);
    throw e;
  }
}

/**
 * agy validates effort per model ("gemini-3.8-flash has no "max" effort
 * (available: low, medium, high)"), and Connect's effort comes from the user's
 * Codex-oriented config. Returns the highest offered level below the one asked
 * for, or null when the failure was something else.
 */
export function effortFallback(error, asked) {
  const m = /has no "([a-z]+)" effort \(available: ([^)]+)\)/.exec(error ?? "");
  if (!m) return null;
  const offered = m[2].split(/,\s*/);
  const below = AGY_EFFORTS.slice(0, Math.max(AGY_EFFORTS.indexOf(asked), 0)).reverse();
  return below.find((e) => offered.includes(e)) ?? offered[offered.length - 1] ?? null;
}

async function askWithRetry(opts) {
  let first = await runTurn(opts);
  const lower = first.failed && !first.tokens ? effortFallback(first.error, opts.policy.effort) : null;
  if (lower) {
    const asked = opts.policy.effort;
    opts = { ...opts, policy: { ...opts.policy, effort: lower } };
    first = { ...(await runTurn(opts)), effortNote: `${asked} is not offered by this model, ran at ${lower}` };
  }
  if (first.answer || first.interrupted || first.failed || !first.denied.includes("command") || !first.conversationId)
    return first;
  const left = opts.policy.maxTokens - first.tokens;
  if (left <= 0) return first;
  const nudge = opts.policy.write ? IMPLEMENT_RETRY_NUDGE : RETRY_NUDGE;
  const second = await runTurn({ ...opts, prompt: nudge, conversationId: first.conversationId, policy: { ...opts.policy, maxTokens: left } });
  return {
    ...second,
    tokens: first.tokens + second.tokens,
    steps: [...first.steps, ...second.steps],
    denied: [...first.denied, ...second.denied],
    edited: [...new Set([...first.edited, ...second.edited])],
    effortNote: first.effortNote,
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
    const child = spawn(bin, agyArgs({ prompt, effort: policy.effort, model, conversationId, write: policy.write }), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "", stderr = "", streamed = "", tokens = 0, cid = conversationId ?? null;
    let result = null, interrupted = null;
    const steps = [], edited = new Set();
    const allowedModes = policy.write ? WRITE_PERMISSION_MODES : SAFE_PERMISSION_MODES;

    const stop = (why) => {
      if (interrupted) return;
      interrupted = why;
      child.kill("SIGTERM");
    };
    const timer = timeoutMs ? setTimeout(() => stop(`exceeded the ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)} s`} time cap`), timeoutMs) : null;

    const onEvent = (ev) => {
      if (ev.event === "init") {
        cid = ev.conversation_id ?? cid;
        // A user setting that auto-approves tools would let this turn write, or run commands, unasked.
        const mode = ev.init?.permission_mode;
        if (mode && !allowedModes.includes(mode)) stop(`refused: agy runs in permission mode "${mode}", which can act without asking`);
      }
      else if (ev.event === "step_update") {
        const s = ev.step_update ?? {};
        if (s.text_delta) streamed += s.text_delta;
        if (s.step_type === "tool" && s.state === "DONE" && s.tool_name) {
          steps.push(s.tool_name);
          const target = s.tool_info?.parameters?.TargetFile;
          if (target && s.tool_name !== "view_file") edited.add(cwd ? relative(cwd, target) || target : target);
        }
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
        edited: [...edited],
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
