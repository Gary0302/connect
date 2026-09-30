/**
 * Connect spike 02 — where does Codex reasoning actually surface?
 *
 * Logs EVERY notification method (with counts) for one turn, so we stop
 * guessing which one carries reasoning. Config the turn via env:
 *
 *   SUMMARY=detailed|auto|concise|none   (turn/start `summary`, unset = omit)
 *   EFFORT=low|medium|high|xhigh         (turn/start `effort`, unset = omit)
 */
import { CodexClient } from "./codex-client.mjs";

const SUMMARY = process.env.SUMMARY;
const EFFORT = process.env.EFFORT || "medium";
const PROMPT = process.argv.slice(2).join(" ") ||
  "Without using any tools, think it through, then answer in one line: " +
  "if a cache has a 5 minute TTL and I ping it every 4 minutes, how many pings until 30 minutes have passed?";

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

const codex = new CodexClient();
codex.on("stderr", (s) => process.stderr.write(`  ! ${s}`));
await codex.connect({ mode: "direct", config: process.env.CODEX_CONFIG ? process.env.CODEX_CONFIG.split(",") : [] });

await codex.request("initialize", {
  clientInfo: { name: "connect-spike", version: "0.0.1" },
  capabilities: { experimentalApi: true },
});
codex.notify("initialized");

const thread = await codex.request("thread/start", { cwd: process.cwd(), approvalPolicy: "never" });
const threadId = thread.thread.id;
log(`thread ${threadId} · model=${thread.model} · threadEffort=${thread.reasoningEffort}`);
log(`turn: effort=${EFFORT} summary=${SUMMARY ?? "(omitted)"}`);

const counts = new Map();
const samples = new Map();
const reasoning = [];
let answer = "";

const done = new Promise((resolve) => {
  codex.on("notification", (msg) => {
    const m = msg.method;
    counts.set(m, (counts.get(m) || 0) + 1);
    if (!samples.has(m)) samples.set(m, JSON.stringify(msg.params).slice(0, 220));
    if (m === "item/agentMessage/delta") answer += msg.params.delta;
    if (m === "item/reasoning/summaryTextDelta" || m === "item/reasoning/textDelta") {
      reasoning.push({ m, i: msg.params.summaryIndex ?? msg.params.contentIndex, delta: msg.params.delta });
    }
    if (m === "turn/completed") resolve(msg.params);
    if (m === "error") log("SERVER ERROR:", JSON.stringify(msg.params).slice(0, 300));
  });
});
codex.on("serverRequest", (msg) => codex.respond(msg.id, { decision: "denied" }));

const params = { threadId, input: [{ type: "text", text: PROMPT }], effort: EFFORT };
if (SUMMARY) params.summary = SUMMARY;
await codex.request("turn/start", params);
await done;

console.log("\n=== notification methods seen ===");
for (const [m, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  const tag = /reason/i.test(m) ? "  <-- REASONING" : "";
  console.log(`  ${String(n).padStart(4)}x  ${m}${tag}`);
  if (/reason|item\/(started|completed)/i.test(m)) console.log(`         ${samples.get(m)}`);
}
console.log("\n=== reasoning deltas verbatim ===");
for (const r of reasoning) console.log(`  [${r.m.split("/").pop()} #${r.i}] ${JSON.stringify(r.delta)}`);
console.log("\nanswer:", JSON.stringify(answer.trim().slice(0, 160)));
codex.close();
process.exit(0);
