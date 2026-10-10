#!/usr/bin/env node
/**
 * ask-codex — the portable half of Connect.
 *
 * One headless `codex exec` turn with effort, sandbox and a time cap pinned by
 * intent, so a one-line question never runs at the config default (which can
 * be xhigh: 273,840 tokens for a one-sentence fact). No daemon, no MCP server,
 * no dependencies: any agent that can run a shell command can use it.
 *
 *   ask-codex.mjs --intent quick_answer "what does src/x.ts export?"
 *   ask-codex.mjs --intent second_opinion --thread <id> "and if we drop the lock?"
 *   git diff | ask-codex.mjs --intent code_review "review this diff"
 *
 * Prints Codex's final answer, then a footer with the thread id to pass back
 * as --thread. Exit code is 0 only when the turn completed.
 */
import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";

const ROUTES = {
  quick_answer:   { effort: "low",    sandbox: "read-only",       ceiling: 20_000,  seconds: 120 },
  second_opinion: { effort: "medium", sandbox: "read-only",       ceiling: 80_000,  seconds: 300 },
  code_review:    { effort: "high",   sandbox: "read-only",       ceiling: 200_000, seconds: 600 },
  deep_reasoning: { effort: "xhigh",  sandbox: "read-only",       ceiling: 400_000, seconds: 1200 },
  implement:      { effort: "high",   sandbox: "workspace-write", ceiling: 300_000, seconds: 1200 },
};

const USAGE = `usage: ask-codex.mjs --intent <${Object.keys(ROUTES).join("|")}>
                     [--thread <id>] [--model <id>] [--cd <dir>] [--] <prompt>
       The prompt may also be piped on stdin; both are sent if given.`;

function parseArgs(argv) {
  const opts = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--") { opts.rest.push(...argv.slice(i + 1)); break; }
    else if (a === "--intent") opts.intent = take();
    else if (a === "--thread") opts.thread = take();
    else if (a === "--model") opts.model = take();
    else if (a === "--cd") opts.cd = take();
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else if (a.startsWith("--")) fail(`unknown option ${a}`);
    else opts.rest.push(a);
  }
  return opts;
}

function fail(msg) {
  console.error(`ask-codex: ${msg}\n${USAGE}`);
  process.exit(2);
}

/**
 * Read piped input, if there is any. Agent harnesses often hand a command an
 * open stdin pipe that nobody ever writes to or closes, so waiting for EOF
 * would hang forever: only pipes and files are read, and if nothing arrives
 * within a second the pipe is treated as empty.
 */
async function readStdin() {
  const stat = fstatSync(0);
  if (!stat.isFIFO() && !stat.isFile()) return "";
  return new Promise((resolve) => {
    let data = "";
    const done = () => { clearTimeout(idle); process.stdin.pause(); resolve(data.trim()); };
    const idle = setTimeout(() => { if (!data) done(); }, 1000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.intent) fail("--intent is required; it sets effort, sandbox and the time cap");
const route = ROUTES[opts.intent];
if (!route) fail(`unknown intent "${opts.intent}"`);

const piped = await readStdin();
const prompt = [opts.rest.join(" ").trim(), piped && `<stdin>\n${piped}\n</stdin>`].filter(Boolean).join("\n\n");
if (!prompt) fail("no prompt given");

// `-c` rather than `-s`, because `codex exec resume` has no --sandbox flag and
// a resumed turn must not inherit a looser sandbox than its intent allows.
const pins = [
  "-c", `sandbox_mode="${route.sandbox}"`,
  "-c", `model_reasoning_effort="${route.effort}"`,
  ...(opts.model ? ["-m", opts.model] : []),
];
const args = opts.thread
  ? ["exec", "resume", "--json", ...pins, opts.thread, "-"]
  : ["exec", "--json", "--skip-git-repo-check", ...pins, ...(opts.cd ? ["-C", opts.cd] : []), "-"];

const started = Date.now();
const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cd || process.cwd() });
child.stdin.end(prompt);

let threadId = opts.thread ?? null;
let answer = "";
let usage = null;
let failure = null;
const warnings = [];
let stderr = "";

const timer = setTimeout(() => {
  failure ??= `exceeded the ${route.seconds}s time cap for ${opts.intent}`;
  child.kill("SIGTERM");
}, route.seconds * 1000);

child.on("error", (err) => {
  failure = err.code === "ENOENT" ? "the codex CLI is not on PATH (install it and run `codex login`)" : err.message;
});
child.stderr.on("data", (d) => { stderr += d; });

let buffer = "";
child.stdout.on("data", (d) => {
  buffer += d;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
  }
});

function handle(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === "thread.started") threadId = ev.thread_id;
  else if (ev.type === "item.completed" && ev.item?.type === "agent_message") answer = ev.item.text;
  // Item-level errors are advisory (e.g. unknown keys in config.toml); the
  // turn carries on. Turn-level ones end it.
  else if (ev.type === "item.completed" && ev.item?.type === "error") warnings.push(ev.item.message);
  else if (ev.type === "turn.completed") usage = ev.usage;
  else if (ev.type === "turn.failed") failure ??= ev.error?.message ?? "turn failed";
  else if (ev.type === "error") failure ??= ev.message ?? "codex reported an error";
}

const code = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timer);
if (buffer.trim()) handle(buffer.trim());
if (!failure && !usage) failure = `codex exited (${code}) without completing the turn${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`;

// A continued thread re-reads its history every turn, mostly from cache, so
// the ceiling is checked against fresh work only: uncached input plus output.
const tokens = usage ? usage.input_tokens + usage.output_tokens + (usage.reasoning_output_tokens ?? 0) : 0;
const cached = usage?.cached_input_tokens ?? 0;
const fresh = tokens - cached;
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(answer || "(no answer)");
console.log("---");
console.log(`thread: ${threadId ?? "none"}  (pass as --thread to continue)`);
const status = [`routed: ${opts.intent}`, `effort ${route.effort}`, `sandbox ${route.sandbox}`,
  `${tokens.toLocaleString("en-US")} tokens${cached ? ` (${cached.toLocaleString("en-US")} cached)` : ""}`, `${seconds}s`];
if (failure) status.push(`TURN FAILED: ${failure}${answer ? " (the answer above is partial)" : ""}`);
else if (fresh > route.ceiling) status.push(`OVER CEILING: ${route.ceiling.toLocaleString("en-US")} uncached expected for ${opts.intent}`);
console.log(status.join(" · "));
if (process.env.ASK_CODEX_VERBOSE) for (const w of warnings) console.error(`codex warning: ${w}`);

process.exit(failure ? 1 : 0);
