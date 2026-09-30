#!/usr/bin/env node
/**
 * connect — drive Codex through the shared daemon from the terminal.
 *
 *   connect doctor                     health of the daemon, versions, remote control
 *   connect threads [n]                recent threads on the shared daemon
 *   connect history <threadId>         replay a thread's turns
 *   connect ask [opts] "prompt"        one routed turn
 *       --thread <id>   continue an existing thread instead of starting one
 *       --intent <name> quick_answer|second_opinion|code_review|deep_reasoning|implement
 *       --model <id>    overrides the model from ~/.config/connect/config.json
 */
import { CodexClient } from "../src/codex-client.mjs";
import { LeaseRegistry } from "../src/lease.mjs";
import { ConnectSession } from "../src/session.mjs";
import { ROUTES } from "../src/router.mjs";
import { loadConfig, effectivePolicy } from "../src/config.mjs";

const [cmd, ...rest] = process.argv.slice(2);

const flag = (name, fallback = null) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? fallback : rest[i + 1];
};
const positional = () => {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) { i++; continue; }
    out.push(rest[i]);
  }
  return out;
};

async function open(name = "connect-cli") {
  const st = await CodexClient.ensureDaemon();
  const c = new CodexClient();
  await c.connect({ socketPath: st.socketPath });
  await c.handshake({ name });
  return { c, st };
}

const commands = {
  async doctor() {
    const { c, st } = await open("connect-doctor");
    const rc = await c.request("remoteControl/status/read");
    const threads = await c.request("thread/list", { limit: 1 });
    const stale = st.cliVersion !== st.appServerVersion;
    console.log(`daemon          ${st.status}  (${st.backend})`);
    console.log(`socket          ${st.socketPath}`);
    console.log(`cli / server    ${st.cliVersion} / ${st.appServerVersion}${stale ? "   MISMATCH" : ""}`);
    console.log(`managed codex   ${st.managedCodexPath}`);
    console.log(`remote control  ${rc.status}${rc.environmentId ? ` (env ${rc.environmentId})` : ""}`);
    console.log(`threads         reachable`);
    if (stale) {
      console.log("\nThe daemon is running an older app-server than the CLI.");
      console.log("Fixing it needs `codex app-server daemon restart`, which DROPS every attached");
      console.log("Codex session, so this is left for you to run when nothing is mid-turn.");
    }
    if (rc.status === "errored") {
      console.log("\nRemote control failed to enroll. Enrollment requires MFA on the ChatGPT account.");
    }
    c.close();
  },

  async threads() {
    const limit = Number(positional()[0] ?? 15);
    const { c } = await open();
    const list = await c.request("thread/list", { limit });
    for (const t of list.data ?? []) {
      console.log(`${t.id}  ${(t.name ?? "(unnamed)").slice(0, 40).padEnd(42)}${t.cwd ?? ""}`);
    }
    c.close();
  },

  async history() {
    const id = positional()[0];
    if (!id) throw new Error("usage: connect history <threadId>");
    const { c } = await open();
    await c.request("thread/resume", { threadId: id });
    // thread/items/list is declared in the schema but returns
    // "not supported yet"; turns/list is the one that works.
    const tl = await c.request("thread/turns/list", { threadId: id, limit: Number(flag("limit", 20)) });
    for (const turn of tl.data ?? []) {
      for (const it of turn.items ?? []) {
        const txt = it.text ?? it.content?.[0]?.text ?? "";
        if (!txt) continue;
        const who = it.type === "userMessage" ? "you " : "codex";
        console.log(`${who}  ${String(txt).replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
    c.close();
  },

  async ask() {
    const text = positional().join(" ");
    if (!text) throw new Error('usage: connect ask [--thread <id>] [--intent <name>] "prompt"');
    const intent = flag("intent");
    if (intent && !ROUTES[intent]) throw new Error(`unknown intent: ${intent}. one of: ${Object.keys(ROUTES).join(", ")}`);

    const cfg = loadConfig();
    const explicit = flag("model");
    const model = explicit ?? cfg.model ?? undefined;
    let turnModel;
    const { c } = await open();
    const session = new ConnectSession(c, new LeaseRegistry());
    const threadId = flag("thread");
    if (threadId) {
      // thread/resume ignores `model` for a loaded thread; the switch rides on the turn.
      const r = await c.request("thread/resume", { threadId });
      session.threadId = r.thread.id;
      session.hud.model = r.model;
      console.error(`(continuing ${threadId})`);
      // An explicit --model always wins; the config's model obeys onModelChange.
      if (model && r.model !== model && (explicit || cfg.onModelChange !== "keep")) {
        if (!explicit && cfg.onModelChange === "compact") {
          console.error("(compacting before the model switch)");
          await session.compact();
        }
        console.error(`(switching ${r.model} -> ${model}; this thread's prompt cache resets)`);
        turnModel = model;
        session.hud.model = model;
      }
    } else {
      await session.startThread({ model });
      console.error(`(new thread ${session.threadId})`);
    }

    // Live progress on stderr so stdout stays pipeable.
    const tick = setInterval(() => process.stderr.write(`\r\x1b[K${session.hudLine()}`), 250);
    const res = await session.ask(text, { intent, model: turnModel, policy: (i) => effectivePolicy(i, cfg) });
    clearInterval(tick);
    process.stderr.write(`\r\x1b[K${session.hudLine()}\n`);
    console.log(res.answer);
    c.close();
  },
};

const run = commands[cmd];
if (!run) {
  console.log(`connect — drive Codex through the shared daemon

  connect doctor
  connect threads [n]
  connect history <threadId> [--limit n]
  connect ask [--thread <id>] [--intent <name>] [--model <id>] "prompt"

intents: ${Object.keys(ROUTES).join(", ")}`);
  process.exit(cmd ? 1 : 0);
}
try {
  await run();
  process.exit(0);
} catch (e) {
  console.error(`connect: ${e.message}`);
  process.exit(1);
}
