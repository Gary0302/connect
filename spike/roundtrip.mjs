/**
 * Connect spike — full round trip against the shared Codex app-server daemon.
 *
 *   daemon start -> proxy -> initialize -> initialized -> thread/start
 *   -> turn/start -> stream reasoning + agent message deltas -> turn/completed
 *
 * Also probes the endpoints the Connect HUD and the thread-lease design need:
 *   remoteControl/status/read, thread/backgroundTerminals/list, model/list.
 */
import { CodexClient } from "./codex-client.mjs";

const PROMPT = process.argv.slice(2).join(" ") ||
  "Reply with exactly one sentence: what file does `codex app-server proxy` connect to?";

const MODE = process.env.CONNECT_MODE || "proxy"; // "proxy" | "direct"

const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6) + "ms";
const log = (...a) => console.log(`[${ms()}]`, ...a);

if (MODE === "proxy") {
  const daemon = await CodexClient.ensureDaemon({ remoteControl: false });
  log("daemon:", JSON.stringify(daemon.version));
} else {
  log("mode=direct: private app-server on stdio (no daemon, no Remote Control)");
}

const codex = new CodexClient();
codex.on("stderr", (s) => process.stderr.write(`  ! ${s}`));
await codex.connect({ mode: MODE });

const init = await codex.request("initialize", {
  clientInfo: { name: "connect-spike", title: "Connect", version: "0.0.1" },
  capabilities: { experimentalApi: true },
});
log("initialize ok:", JSON.stringify(init).slice(0, 200));
codex.notify("initialized");

// --- HUD / lease data sources -------------------------------------------
for (const [method, params] of [
  ["remoteControl/status/read", {}],
  ["model/list", {}],
]) {
  try {
    const r = await codex.request(method, params);
    log(`${method}:`, JSON.stringify(r).slice(0, 300));
  } catch (e) {
    log(`${method} FAILED:`, e.message.slice(0, 200));
  }
}

// --- Thread + turn -------------------------------------------------------
const thread = await codex.request("thread/start", {
  cwd: process.cwd(),
  approvalPolicy: "never",
});
const threadId = thread.thread.id;
log("thread/start:", threadId, "model:", thread.model, "effort:", thread.reasoningEffort);

let answer = "";
let reasoningChars = 0;
const done = new Promise((resolve) => {
  codex.on("notification", (msg) => {
    switch (msg.method) {
      case "item/agentMessage/delta":
        answer += msg.params.delta;
        process.stdout.write(msg.params.delta);
        break;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        reasoningChars += (msg.params.delta || "").length;
        break;
      case "thread/tokenUsage/updated":
        log("tokenUsage:", JSON.stringify(msg.params).slice(0, 240));
        break;
      case "turn/completed":
        resolve(msg.params);
        break;
      case "error":
        log("SERVER ERROR:", JSON.stringify(msg.params).slice(0, 300));
        break;
    }
  });
});

// Anything needing a human is declined so the spike never blocks.
codex.on("serverRequest", (msg) => {
  log("serverRequest (declining):", msg.method);
  codex.respond(msg.id, { decision: "denied" });
});

log("turn/start ...");
await codex.request("turn/start", {
  threadId,
  input: [{ type: "text", text: PROMPT }],
});

const completed = await done;
console.log();
log("turn/completed. reasoning chars:", reasoningChars);
log("usage:", JSON.stringify(completed.turn?.usage ?? completed.turn ?? {}).slice(0, 300));

try {
  const terms = await codex.request("thread/backgroundTerminals/list", { threadId });
  log("backgroundTerminals:", JSON.stringify(terms).slice(0, 200));
} catch (e) {
  log("backgroundTerminals FAILED:", e.message.slice(0, 160));
}

log("answer:", JSON.stringify(answer.trim().slice(0, 200)));
codex.close();
process.exit(0);
