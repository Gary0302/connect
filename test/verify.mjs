/**
 * Connect end-to-end verification against the real Codex daemon.
 *   node test/verify.mjs
 */
import { CodexClient, SERVER_REQUEST_DECLINES, resolveCodexBin } from "../src/codex-client.mjs";
import { LeaseRegistry, LeaseError } from "../src/lease.mjs";
import { ConnectSession } from "../src/session.mjs";
import { WsUnixSocket } from "../src/ws-unix.mjs";
import { route, classify, ROUTES, overBudget } from "../src/router.mjs";
import { loadConfig, saveConfig, applyPatch, effectivePolicy } from "../src/config.mjs";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as tjoin } from "node:path";

// Never read or write the user's real preferences. Inherited by the spawned MCP servers too.
process.env.CONNECT_CONFIG = tjoin(mkdtempSync(tjoin(tmpdir(), "connect-test-")), "config.json");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------- 1. daemon
console.log("\n[1] managed daemon");
const st = await CodexClient.ensureDaemon();
ok("daemon running", st.status === "started" || st.status === "alreadyRunning", st.status);
ok("socket path reported", !!st.socketPath, st.socketPath);
ok("cli/app-server versions match", st.cliVersion === st.appServerVersion,
   `cli=${st.cliVersion} appServer=${st.appServerVersion}`);

// ------------------------------------------------------------- 2. transport
console.log("\n[2] websocket transport to the shared daemon");
const a = new CodexClient();
await a.connect({ socketPath: st.socketPath });
const info = await a.handshake({ name: "connect-verify" });
ok("handshake", !!info.codexHome, info.codexHome);
const threads = await a.request("thread/list", {});
const existing = (threads.data ?? threads.threads ?? []).length;
ok("sees pre-existing threads (proves shared, not private)", existing > 0, `${existing} threads`);

// -------------------------------------------- 3. websocket frame validation
// Drives the real client against a hand-rolled server so malformed frames can
// be staged. The daemon never sends these; the point is that a desynchronised
// parse fails loudly instead of emitting plausible-looking garbage.
console.log("\n[3] websocket frame validation");
{
  const net = await import("node:net");
  const crypto = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join: pjoin } = await import("node:path");
  const { unlinkSync, existsSync } = await import("node:fs");

  // One server per case: accept the upgrade, then send exactly one frame.
  const stage = (frameBytes) =>
    new Promise((resolve) => {
      const path = pjoin(tmpdir(), `connect-ws-${crypto.randomBytes(6).toString("hex")}.sock`);
      const server = net.createServer((sock) => {
        sock.once("data", (req) => {
          const key = /sec-websocket-key:\s*(\S+)/i.exec(req.toString())?.[1] ?? "";
          const accept = crypto
            .createHash("sha1")
            .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            .digest("base64");
          sock.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
              `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
          );
          setTimeout(() => sock.write(frameBytes), 10);
        });
      });
      server.listen(path, async () => {
        const ws = new WsUnixSocket();
        const errors = [];
        ws.on("error", (e) => errors.push(e.message));
        const messages = [];
        ws.on("message", (m) => messages.push(m));
        try { await ws.connect(path); } catch (e) { errors.push(e.message); }
        setTimeout(() => {
          ws.close();
          server.close(() => { if (existsSync(path)) { try { unlinkSync(path); } catch {} } });
          resolve({ errors, messages });
        }, 120);
      });
    });

  // A well-formed unmasked text frame is the control: this must still work.
  const good = Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("hello")]);
  const okCase = await stage(good);
  ok("a valid text frame still arrives", okCase.messages[0] === "hello",
     JSON.stringify(okCase.messages[0] ?? okCase.errors[0]));

  const masked = await stage(Buffer.concat([Buffer.from([0x81, 0x85, 1, 2, 3, 4]), Buffer.from([0x69, 0x67, 0x6f, 0x68, 0x6e])]));
  ok("a masked server frame is refused", masked.errors.some((e) => /masked/.test(e)), masked.errors.join(";"));

  const rsv = await stage(Buffer.concat([Buffer.from([0xc1, 5]), Buffer.from("hello")]));
  ok("reserved bits are refused", rsv.errors.some((e) => /reserved/.test(e)), rsv.errors.join(";"));

  // A control frame that is fragmented (FIN clear) is illegal.
  const badCtl = await stage(Buffer.from([0x09, 0]));
  ok("a fragmented control frame is refused", badCtl.errors.some((e) => /control frame/.test(e)),
     badCtl.errors.join(";"));

  const orphanCont = await stage(Buffer.concat([Buffer.from([0x80, 3]), Buffer.from("abc")]));
  ok("a continuation with nothing to continue is refused",
     orphanCont.errors.some((e) => /nothing to continue/.test(e)), orphanCont.errors.join(";"));

  const unknownOp = await stage(Buffer.from([0x83, 0]));
  ok("an unknown opcode is refused", unknownOp.errors.some((e) => /unknown websocket opcode/.test(e)),
     unknownOp.errors.join(";"));
}

// --------------------------------------------------- 4. second live client
console.log("\n[4] two concurrent clients on one daemon");
const b = new CodexClient();
await b.connect({ socketPath: st.socketPath });
await b.handshake({ name: "connect-verify-2" });
const threadsB = await b.request("thread/list", {});
ok("second client connected", (threadsB.data ?? []).length === existing, "same thread list");

// ------------------------------------------------------------- 5. routing
console.log("\n[5] routing policy");
ok("every route pins effort", Object.values(ROUTES).every((p) => !!p.effort));
ok("quick_answer avoids xhigh", ROUTES.quick_answer.effort === "low");
ok("turn params always carry effort", !!route({ threadId: "T", text: "hi" }).params.effort);
ok("classifier: design -> deep", classify("design a lease protocol") === "deep_reasoning");
ok("budget trips on the 273k regression", overBudget("quick_answer", 273_840));

console.log("\n[5b] user config");
{
  const empty = loadConfig();
  ok("missing config file means no preferences", empty.model === null && Object.keys(empty.intents).length === 0);
  const cfg = applyPatch(empty, { model: "m1", intents: { code_review: { effort: "xhigh", maxTokens: 400_000 } } });
  ok("patch sets model and per-intent fields", cfg.model === "m1" && cfg.intents.code_review.effort === "xhigh");
  const p = effectivePolicy("code_review", cfg);
  ok("effective policy applies overrides", p.effort === "xhigh" && p.maxTokens === 400_000 && p.customized);
  ok("but never the sandbox", p.sandbox === "read-only");
  ok("untouched intents keep built-ins", !effectivePolicy("quick_answer", cfg).customized &&
     effectivePolicy("quick_answer", cfg).effort === "low");
  const r = route({ threadId: "T", text: "x", intent: "code_review", policy: (i) => effectivePolicy(i, cfg) });
  ok("route carries the configured effort", r.params.effort === "xhigh");
  ok("budget honours a configured ceiling", !overBudget("code_review", 300_000, p.maxTokens) &&
     overBudget("code_review", 300_000));
  const reverted = applyPatch(cfg, { model: null, intents: { code_review: { effort: null, maxTokens: null } } });
  ok("null reverts to defaults", reverted.model === null && !("code_review" in reverted.intents));
  let threw = false;
  try { applyPatch(empty, { intents: { nope: { effort: "low" } } }); } catch { threw = true; }
  ok("unknown intent refused", threw);
  threw = false;
  try { applyPatch(empty, { intents: { quick_answer: { maxTokens: -5 } } }); } catch { threw = true; }
  ok("nonsense ceiling refused", threw);
  ok("old threads switch by default", empty.onModelChange === "switch");
  ok("onModelChange is settable", applyPatch(empty, { onModelChange: "keep" }).onModelChange === "keep");
  threw = false;
  try { applyPatch(empty, { onModelChange: "whatever" }); } catch { threw = true; }
  ok("an unknown onModelChange refused", threw);
  saveConfig(cfg);
  ok("round-trips through the file", loadConfig().intents.code_review.maxTokens === 400_000);
  saveConfig({ model: null, onModelChange: "switch", intents: {} });
}

// -------------------------------------------------------------- 6. leases
console.log("\n[6] lease fencing");
{
  let t = 0; const now = () => t;
  const r = new LeaseRegistry({ ttlMs: 1000, now });
  const l1 = r.acquire("T", "connect");
  let refused = false;
  try { r.acquire("T", "remote-control"); } catch (e) { refused = e.code === "held"; }
  ok("concurrent acquire refused", refused);
  ok("reads never need a lease", (() => { r.guard("thread/read", "T", null); return true; })());
  t += 2000;
  const l2 = r.acquire("T", "remote-control");
  ok("token is monotonic across owners", BigInt(l2.token) > BigInt(l1.token));
  let fenced = false;
  try { r.guard("turn/start", "T", l1.token); } catch (e) { fenced = e.code === "stale_token"; }
  ok("expired holder fenced out by token, not clock", fenced);
}

// ------------------------------------------- 7. notification correlation
// The daemon is shared by construction, so another client's turn emits the same
// notification methods down our socket. Unfiltered, their `turn/completed`
// resolved our turn early and their deltas landed in our answer. Driven against
// a fake client so it costs nothing and can stage races a live turn cannot.
console.log("\n[7] notification correlation on a shared daemon");
{
  const { EventEmitter } = await import("node:events");
  class FakeCodex extends EventEmitter {
    constructor(startResponse = {}) { super(); this.startResponse = startResponse; }
    request(method) { return Promise.resolve(method === "turn/start" ? this.startResponse : {}); }
    respond() {}
  }
  const tick = () => new Promise((r) => setImmediate(r));

  // No `turn` in the response, so the claim can only come from `turn/started`.
  const fake = new FakeCodex({});
  const sess = new ConnectSession(fake, new LeaseRegistry(), { owner: "connect" });
  sess.threadId = "THREAD-OURS";
  const n = (method, params) => fake.emit("notification", { method, params });

  const asking = sess.ask("2+2", { intent: "quick_answer", timeoutMs: 5000 });
  await tick();
  n("turn/started", { threadId: "THREAD-OURS", turn: { id: "TURN-OURS" } });
  ok("claims its turn id from turn/started", sess.activeTurnId === "TURN-OURS", String(sess.activeTurnId));

  // A Codex TUI working on a different thread floods the socket.
  n("item/agentMessage/delta", { threadId: "THREAD-OTHER", turnId: "TURN-OTHER", itemId: "x", delta: "POISON" });
  n("thread/tokenUsage/updated", {
    threadId: "THREAD-OTHER", turnId: "TURN-OTHER",
    tokenUsage: { total: { totalTokens: 999_999, cachedInputTokens: 0 } },
  });
  n("turn/completed", { threadId: "THREAD-OTHER", turn: { id: "TURN-OTHER", status: "completed" } });
  ok("another thread's tokens do not drive our budget", sess.hud.totalTokens === 0, String(sess.hud.totalTokens));

  // And a second turn on OUR thread, driven by someone else.
  n("item/agentMessage/delta", { threadId: "THREAD-OURS", turnId: "TURN-THEIRS", itemId: "x", delta: "POISON" });
  n("turn/completed", { threadId: "THREAD-OURS", turn: { id: "TURN-THEIRS", status: "completed" } });

  let settled = false;
  asking.then(() => (settled = true), () => (settled = true));
  await tick();
  ok("a foreign turn/completed does not resolve ours", settled === false);

  n("item/agentMessage/delta", { threadId: "THREAD-OURS", turnId: "TURN-OURS", itemId: "x", delta: "4" });
  n("turn/completed", { threadId: "THREAD-OURS", turn: { id: "TURN-OURS", status: "completed" } });
  const res0 = await asking;
  ok("answer holds only our own deltas", res0.answer === "4", JSON.stringify(res0.answer));
  ok("turn id cleared once the turn ends", sess.activeTurnId === null);

  // Fallback: `turn/started` missed, the turn/start response claims it instead.
  const fake2 = new FakeCodex({ turn: { id: "TURN-FALLBACK" } });
  const sess2 = new ConnectSession(fake2, new LeaseRegistry(), { owner: "connect" });
  sess2.threadId = "T2";
  const asking2 = sess2.ask("hi", { intent: "quick_answer", timeoutMs: 5000 });
  await tick();
  ok("turn/start response claims the turn when the notification is missed",
     sess2.activeTurnId === "TURN-FALLBACK", String(sess2.activeTurnId));
  fake2.emit("notification", { method: "turn/completed", params: { threadId: "T2", turn: { id: "TURN-FALLBACK" } } });
  await asking2;
}

// ------------------------------------ 8. per-turn budget and interruption
// Two bugs lived here: `turn/interrupt` was sent without the `turnId` its
// schema marks required (so it was rejected, swallowed, and the caller still
// told the turn was interrupted), and the ceiling was compared against the
// thread-cumulative total.
//
// Measured on a 4-step tool turn (spike): `last` went 16,228 -> 16,363 ->
// 16,496 -> 16,586 while `total` went 16,228 -> 32,591 -> 49,087 -> 65,673.
// `last` is the last model REQUEST, not the turn — using it understates a
// multi-step turn fourfold. Only `total - baseline` measures the turn.
console.log("\n[8] per-turn budget accounting and interruption");
{
  const { EventEmitter } = await import("node:events");
  class FakeCodex extends EventEmitter {
    constructor({ interruptFails = false } = {}) { super(); this.interruptFails = interruptFails; this.sent = []; }
    request(method, params) {
      this.sent.push({ method, params });
      if (method === "turn/start") return Promise.resolve({ turn: { id: "T" } });
      if (method === "turn/interrupt" && this.interruptFails) return Promise.reject(new Error("-32602: invalid params"));
      return Promise.resolve({});
    }
    respond() {}
  }
  const tick = () => new Promise((r) => setImmediate(r));
  const usage = (last, total) => ({
    threadId: "TH", turnId: "T",
    tokenUsage: { last: { totalTokens: last }, total: { totalTokens: total } },
  });

  // A resumed thread already 500k deep. The old code tripped instantly.
  const fake = new FakeCodex();
  const sess = new ConnectSession(fake, new LeaseRegistry(), { owner: "connect" });
  sess.threadId = "TH";
  const asking = sess.ask("hi", { intent: "quick_answer", timeoutMs: 5000 });
  await tick();
  fake.emit("notification", { method: "turn/started", params: { threadId: "TH", turn: { id: "T" } } });
  fake.emit("notification", { method: "thread/tokenUsage/updated", params: usage(16_000, 516_000) });
  ok("baseline isolates the turn on a 500k-deep thread", sess.hud.turnTokens === 16_000, String(sess.hud.turnTokens));
  ok("a resumed thread does not trip the ceiling on arrival",
     !fake.sent.some((c) => c.method === "turn/interrupt"));

  // Multi-step growth: `last` stays flat, `total` climbs. The budget must see it.
  fake.emit("notification", { method: "thread/tokenUsage/updated", params: usage(16_100, 532_000) });
  ok("a flat `last` does not hide multi-step growth", sess.hud.turnTokens === 32_000, String(sess.hud.turnTokens));
  ok("ceiling trips on the turn's real cost", fake.sent.some((c) => c.method === "turn/interrupt"));

  const call = fake.sent.find((c) => c.method === "turn/interrupt");
  ok("turn/interrupt carries the required turnId", call.params.turnId === "T", JSON.stringify(call.params));
  ok("turn/interrupt carries the threadId", call.params.threadId === "TH");

  fake.emit("notification", {
    method: "turn/completed",
    params: { threadId: "TH", turn: { id: "T", status: "interrupted" } },
  });
  const res1 = await asking;
  ok("interrupted reported from the daemon's own turn status", res1.interrupted === true);
  ok("budgetExceeded recorded alongside it", res1.budgetExceeded === true);
  ok("reports this turn's cost, not the thread's", res1.tokens === 32_000, String(res1.tokens));

  // A rejected interrupt must not be reported as a successful one.
  const fake2 = new FakeCodex({ interruptFails: true });
  const sess2 = new ConnectSession(fake2, new LeaseRegistry(), { owner: "connect" });
  sess2.threadId = "TH";
  const asking2 = sess2.ask("hi", { intent: "quick_answer", timeoutMs: 5000 });
  await tick();
  fake2.emit("notification", { method: "turn/started", params: { threadId: "TH", turn: { id: "T" } } });
  fake2.emit("notification", { method: "thread/tokenUsage/updated", params: usage(50_000, 50_000) });
  await tick();
  fake2.emit("notification", {
    method: "turn/completed",
    params: { threadId: "TH", turn: { id: "T", status: "completed" } },
  });
  const res2 = await asking2;
  ok("a failed interrupt is not reported as interrupted", res2.interrupted === false);
  ok("but the budget overrun is still surfaced", res2.budgetExceeded === true && !!res2.interruptError,
     res2.interruptError?.message);
}

// ------------------------------------------- 9. lifecycle and refusals
// Everything here is offline: the shared client outliving its sessions, the
// shapes a server request will actually accept, and the failure paths that used
// to leak listeners or take the process down.
console.log("\n[9] session lifecycle, refusal shapes, failure paths");
{
  const { EventEmitter } = await import("node:events");
  class FakeCodex extends EventEmitter {
    constructor(startResponse = { turn: { id: "T" } }) { super(); this.startResponse = startResponse; this.sent = []; }
    request(method, params) {
      this.sent.push({ method, params });
      return Promise.resolve(method === "turn/start" ? this.startResponse : {});
    }
    respond() {} respondError() {}
  }
  const tick = () => new Promise((r) => setImmediate(r));

  // --- a session must let go of the shared client -------------------------
  const shared = new FakeCodex();
  shared.setMaxListeners(50); // this test deliberately stacks what #4 used to leak
  const base = shared.listenerCount("notification");
  const sessions = [];
  for (let i = 0; i < 12; i++) sessions.push(new ConnectSession(shared, new LeaseRegistry()));
  ok("each session attaches exactly one notification listener",
     shared.listenerCount("notification") === base + 12, String(shared.listenerCount("notification")));
  ok("sessions never install their own serverRequest responder",
     shared.listenerCount("serverRequest") === 0);
  for (const x of sessions) x.dispose();
  ok("dispose() detaches every one of them", shared.listenerCount("notification") === base,
     String(shared.listenerCount("notification")));
  sessions[0].dispose();
  ok("dispose() is idempotent", shared.listenerCount("notification") === base);

  // --- refusal shapes -----------------------------------------------------
  // `denied` was never a legal decision; the enum is accept | acceptForSession
  // | decline | cancel, and six of the ten methods do not take `decision`.
  const decisionMethods = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval",
                           "applyPatchApproval", "execCommandApproval"];
  ok("approval refusals use a legal decision value",
     decisionMethods.every((m) => SERVER_REQUEST_DECLINES[m]?.decision === "decline"));
  ok("no refusal anywhere still says 'denied'",
     !Object.values(SERVER_REQUEST_DECLINES).some((r) => r.decision === "denied"));
  ok("user-input refusal answers with a map, not a decision",
     typeof SERVER_REQUEST_DECLINES["item/tool/requestUserInput"].answers === "object" &&
     !("decision" in SERVER_REQUEST_DECLINES["item/tool/requestUserInput"]));
  ok("elicitation refusal uses action, not decision",
     SERVER_REQUEST_DECLINES["mcpServer/elicitation/request"].action === "decline");
  ok("dynamic tool call refusal returns success+contentItems",
     SERVER_REQUEST_DECLINES["item/tool/call"].success === false &&
     Array.isArray(SERVER_REQUEST_DECLINES["item/tool/call"].contentItems));
  ok("permission refusal grants an empty profile",
     typeof SERVER_REQUEST_DECLINES["item/permissions/requestApproval"].permissions === "object");
  ok("credential requests get no fabricated answer",
     !("attestation/generate" in SERVER_REQUEST_DECLINES) &&
     !("account/chatgptAuthTokens/refresh" in SERVER_REQUEST_DECLINES));

  // --- a failed turn is not a successful empty one ------------------------
  const f1 = new FakeCodex();
  const s1 = new ConnectSession(f1, new LeaseRegistry());
  s1.threadId = "TH";
  const a1 = s1.ask("x", { intent: "quick_answer", timeoutMs: 5000 });
  await tick();
  f1.emit("notification", {
    method: "turn/completed",
    params: { threadId: "TH", turn: { id: "T", status: "failed", error: { message: "model unavailable" } } },
  });
  const r1 = await a1;
  ok("a failed turn is reported as failed", r1.failed === true && r1.status === "failed");
  ok("its error is carried back", r1.error?.message === "model unavailable", r1.error?.message);
  s1.dispose();

  // --- timeout must not leak the listeners it installed -------------------
  const f2 = new FakeCodex();
  const s2 = new ConnectSession(f2, new LeaseRegistry());
  s2.threadId = "TH";
  const before = f2.listenerCount("notification");
  await s2.ask("x", { intent: "quick_answer", timeoutMs: 60 }).then(
    () => ok("timeout rejects", false, "resolved instead"),
    (e) => ok("timeout rejects", /timed out/.test(e.message), e.message)
  );
  ok("a timed-out turn leaves no listeners behind", f2.listenerCount("notification") === before,
     `${f2.listenerCount("notification")} vs ${before}`);
  ok("and releases its lease", s2.leases.inspect("TH") === null);

  // --- one turn at a time per session -------------------------------------
  const f3 = new FakeCodex();
  const s3 = new ConnectSession(f3, new LeaseRegistry());
  s3.threadId = "TH";
  const first = s3.ask("x", { intent: "quick_answer", timeoutMs: 200 });
  let reentered = false;
  await s3.ask("y", { intent: "quick_answer", timeoutMs: 200 }).catch((e) => (reentered = /already has a turn/.test(e.message)));
  ok("a second concurrent turn on one session is refused", reentered);
  await first.catch(() => {});
  s3.dispose();

  // --- releasing a lease someone else now holds must not eat the answer ---
  const f4 = new FakeCodex();
  const leases4 = new LeaseRegistry({ ttlMs: 1 });
  const s4 = new ConnectSession(f4, leases4);
  s4.threadId = "TH";
  const a4 = s4.ask("x", { intent: "quick_answer", timeoutMs: 5000 });
  await tick();
  await new Promise((r) => setTimeout(r, 5));
  leases4.acquire("TH", "someone-else"); // our token is now stale
  f4.emit("notification", { method: "turn/completed", params: { threadId: "TH", turn: { id: "T", status: "completed" } } });
  const r4 = await a4.then((v) => v, (e) => e);
  ok("a stale lease release does not replace the turn's result", r4 instanceof Error === false,
     r4 instanceof Error ? r4.message : "result returned");
  s4.dispose();

  // --- a transport error with no listener must not be fatal ---------------
  const bare = new CodexClient();
  let threw = null;
  try { bare.emit("stderr", "warmup"); bare.listenerCount("error"); }
  catch (e) { threw = e; }
  ok("a client with no error listener is constructible", threw === null);

  // --- a failed initial connect must not start a background reconnect -----
  const orphan = new CodexClient();
  let closed = false;
  orphan.on("close", () => (closed = true));
  let rejected = false;
  await orphan.connect({ socketPath: "/tmp/connect-does-not-exist.sock", reconnect: true })
    .catch(() => (rejected = true));
  await new Promise((r) => setTimeout(r, 400));
  ok("connecting to a dead socket rejects", rejected);
  ok("and does not start an orphan reconnect loop", closed === false);

  ok("codex binary resolves to one place for CLI and MCP alike", !!resolveCodexBin(), resolveCodexBin());
}

// ------------------------------------------------ 10. MCP protocol surface
// Drives the real server over stdio, the way Claude Code does. No tool calls, so
// it never touches the daemon.
console.log("\n[10] MCP protocol surface");
{
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const proc = spawn(process.execPath, [join(here, "..", "mcp", "connect-mcp.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = new Map();
  let buf = "";
  proc.stdout.on("data", (b) => {
    buf += b;
    for (const line of buf.split("\n").slice(0, -1)) {
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); replies.set(m.id, m); } catch { /* ignore */ }
    }
    buf = buf.slice(buf.lastIndexOf("\n") + 1);
  });
  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  const waitFor = async (id, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (replies.has(id)) return replies.get(id);
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const init = await waitFor(1);
  ok("initialize answers", !!init?.result, JSON.stringify(init?.error ?? "").slice(0, 80));
  ok("agrees on a version it speaks", init?.result?.protocolVersion === "2025-06-18");
  ok("ships instructions for the client", typeof init?.result?.instructions === "string" &&
     init.result.instructions.length > 200, `${init?.result?.instructions?.length ?? 0} chars`);
  ok("the guide names the cost cliff", /273,840/.test(init?.result?.instructions ?? ""));
  ok("the guide insists on an explicit intent", /ALWAYS pass/.test(init?.result?.instructions ?? ""));
  ok("the guide states the read-only default", /read-only/.test(init?.result?.instructions ?? ""));

  // An unknown version must not be echoed back as if supported.
  send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  const odd = await waitFor(2);
  ok("does not claim to speak an unknown protocol version",
     odd?.result?.protocolVersion !== "1999-01-01", odd?.result?.protocolVersion);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const list = await waitFor(3);
  const names = (list?.result?.tools ?? []).map((t) => t.name).sort();
  ok("advertises the eight tools",
     JSON.stringify(names) === JSON.stringify(["agy_ask", "agy_doctor", "agy_threads", "codex_ask", "codex_config", "codex_doctor", "codex_history", "codex_threads"]),
     names.join(","));
  const ask = (list?.result?.tools ?? []).find((t) => t.name === "codex_ask");
  ok("codex_ask no longer hardcodes a model name", !/gpt-5/.test(JSON.stringify(ask)));
  ok("its intent enum still covers every route",
     JSON.stringify(ask?.inputSchema?.properties?.intent?.enum?.slice().sort()) ===
       JSON.stringify(Object.keys(ROUTES).slice().sort()));

  proc.stdin.write("{ this is not json }\n");
  const parse = await waitFor(null, 2000);
  ok("a malformed frame gets a parse error, not silence", parse?.error?.code === -32700,
     JSON.stringify(parse?.error ?? "no reply"));

  send({ jsonrpc: "2.0", id: 4, method: "no/such/method" });
  const unknown = await waitFor(4);
  ok("an unknown method gets -32601", unknown?.error?.code === -32601, JSON.stringify(unknown?.error ?? ""));

  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } });
  const badTool = await waitFor(5);
  ok("an unknown tool gets -32602", badTool?.error?.code === -32602, JSON.stringify(badTool?.error ?? ""));

  proc.kill();
}

// --------------------------------------------- 11. live turn, cheap route
console.log("\n[11] live routed turn (quick_answer, effort=low)");
const leases = new LeaseRegistry();
const s = new ConnectSession(a, leases, { owner: "connect" });
const started = await s.startThread();
ok("thread started via res.thread.id", !!s.threadId, s.threadId);
ok("thread default effort is still xhigh (why routing exists)",
   started.reasoningEffort === "xhigh", `threadDefault=${started.reasoningEffort}`);

const t0 = Date.now();
const res = await s.ask("What is 2 + 2? Answer with just the number.", { intent: "quick_answer" });
const elapsed = Date.now() - t0;
ok("got an answer", /4/.test(res.answer), JSON.stringify(res.answer.slice(0, 60)));
ok("routed as quick_answer/low", res.intent === "quick_answer" && res.policy.effort === "low");
ok("cost stayed far below the 273k xhigh baseline", s.hud.totalTokens < 50_000,
   `${s.hud.totalTokens.toLocaleString()} tokens in ${(elapsed / 1000).toFixed(1)}s`);
ok("lease released after turn", leases.inspect(s.threadId) === null);

// ------------------------------------ 12. live turn with reasoning for HUD
console.log("\n[12] live reasoning turn (HUD feed)");
const s2 = new ConnectSession(b, new LeaseRegistry(), { owner: "connect" });
await s2.startThread();
// The prompt must actually make the model think: a turn short enough to answer
// outright produces zero reasoning summaries (measured). That is expected
// behaviour, not a transport failure, which is why tokenUsage is the heartbeat.
const res2 = await s2.ask(
  "Without using any tools: design a lease protocol so two clients can safely share one Codex thread. Explain the states and the failure modes.",
  { intent: "deep_reasoning" }
);
const steps = [...s2.reasoning.values()].reduce((n, m) => n + m.size, 0);
ok("reasoning summaries arrived (summary opt-in works)", steps > 0, `${steps} steps`);
ok("HUD captured step labels", [...s2.reasoning.values()].some((m) => [...m.values()].some((v) => v.trim().length > 0)),
   JSON.stringify([...s2.reasoning.values()].flatMap((m) => [...m.values()]).slice(0, 2)));
ok("summaries grouped by itemId", s2.reasoning.size >= 1, `${s2.reasoning.size} reasoning item(s)`);
ok("answer returned", res2.answer.length > 20, JSON.stringify(res2.answer.slice(0, 70)));
console.log(`  HUD: ${s2.hudLine()}`);

// ------------------------------------------------ 13. end-to-end over MCP
// The only test that exercises the codex_ask handler itself: intent -> sandbox
// choice -> thread -> turn -> the text Claude Code actually receives.
console.log("\n[13] live codex_ask through the MCP server");
{
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join: pjoin } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const proc = spawn(process.execPath, [pjoin(here, "..", "mcp", "connect-mcp.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = new Map();
  let buf = "";
  proc.stdout.on("data", (b) => {
    buf += b;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) if (l.trim()) {
      let m;
      try { m = JSON.parse(l); } catch { continue; }
      // The server asking US: answer forms from the script, as a person would.
      if (m.method === "elicitation/create") {
        forms.push(m.params);
        const answer = formAnswers.shift() ?? { action: "cancel" };
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer }) + "\n");
      } else replies.set(m.id, m);
    }
  });
  const forms = [];
  const formAnswers = [];
  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  const wait = async (id, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (replies.has(id)) return replies.get(id);
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize",
         params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} } } });
  await wait(1, 10_000);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "codex_ask", arguments: { prompt: "What is 17 times 3? Reply with just the number.", intent: "quick_answer" } },
  });
  const r = await wait(2, 180_000);
  const text = r?.result?.content?.[0]?.text ?? "";
  ok("codex_ask answers over MCP", /51/.test(text), JSON.stringify(text.split("\n")[0]).slice(0, 60));
  ok("not flagged as an error", r?.result?.isError !== true);
  ok("hands back a thread id to continue with", /thread: [0-9a-f-]{36}/.test(text));
  ok("names the model the daemon actually used", /routed: .* · gpt-/.test(text), text.match(/routed: .*/)?.[0]);
  ok("states the sandbox it ran under", /sandbox read-only/.test(text));
  ok("reports this turn's cost", /tokens this turn/.test(text));
  ok("a cheap intent stayed cheap", (() => {
    const n = Number((text.match(/· ([\d,]+) tokens this turn/)?.[1] ?? "0").replace(/,/g, ""));
    return n > 0 && n < 50_000;
  })(), text.match(/· ([\d,]+) tokens this turn/)?.[1]);
  ok("no config means no config marker", !/your config/.test(text));

  const call = async (id, name, args, ms = 30_000) => {
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return wait(id, ms);
  };
  const shown = await call(10, "codex_config", {});
  const shownText = shown?.result?.content?.[0]?.text ?? "";
  ok("codex_config lists the daemon's models", /available models:\n  \S+/.test(shownText));
  const models = [...shownText.matchAll(/^  (\S+)/gm)].map((m) => m[1]);
  const other = models.find((m) => !shownText.includes(`${m} (default)`)) ?? models[0];
  const badModel = await call(11, "codex_config", { action: "set", model: "no-such-model" });
  ok("an unknown model is refused", badModel?.result?.isError === true);
  const badEffort = await call(12, "codex_config", { action: "set", intents: { quick_answer: { effort: "ludicrous" } } });
  ok("an unsupported effort is refused", badEffort?.result?.isError === true);
  ok("refusals leave the file untouched", !existsSync(process.env.CONNECT_CONFIG) || loadConfig().model === null);
  const set = await call(13, "codex_config", {
    action: "set", model: other, onModelChange: "compact", intents: { quick_answer: { maxTokens: 30_000 } },
  });
  ok("a valid change is saved", set?.result?.isError !== true && loadConfig().model === other,
     set?.result?.content?.[0]?.text?.split("\n")[1]);
  // Continue the FIRST thread, which still runs on the old model. Measured:
  // thread/resume ignores `model`, so this proves the turn-level switch.
  const firstThread = text.match(/thread: ([0-9a-f-]{36})/)?.[1];
  const r2 = await call(14, "codex_ask",
    { prompt: "What is 6 times 7? Reply with just the number.", intent: "quick_answer", threadId: firstThread }, 240_000);
  const t2 = r2?.result?.content?.[0]?.text ?? "";
  ok("a continued thread answers after the switch", /42/.test(t2), JSON.stringify(t2.split("\n")[0]).slice(0, 60));
  ok("it is compacted, then switched", /switched \S+ -> \S+ after compacting/.test(t2), t2.match(/routed: .*/)?.[0]);
  ok("and the daemon agrees on the new model", await (async () => {
    const r = await a.request("thread/resume", { threadId: firstThread });
    return r.model === other;
  })());
  ok("and says the config applied", /your config/.test(t2));

  // Forms: model unchanged, one Codex level everywhere, 2× ceilings.
  formAnswers.push(
    { action: "accept", content: { model: other, effort: "all", ceilings: "2x" } },
    { action: "accept", content: { all: "medium" } },
  );
  const inter = await call(16, "codex_config", { action: "interactive" }, 60_000);
  const it = inter?.result?.content?.[0]?.text ?? "";
  ok("interactive shows forms and saves", inter?.result?.isError !== true && /^Saved:/.test(it), it.split("\n")[0]);
  ok("the effort form offers Codex's own levels and wording",
     forms[1]?.requestedSchema?.properties?.all?.enumNames?.some((n) => /^\w+ — \S/.test(n)),
     forms[1]?.requestedSchema?.properties?.all?.enumNames?.[0]);
  ok("no cache question when the model did not change", forms.length === 2);
  const saved = loadConfig();
  ok("one level applied to every intent", Object.keys(ROUTES).every((i) => saved.intents[i]?.effort === "medium"));
  ok("ceilings doubled", saved.intents.deep_reasoning?.maxTokens === 800_000);

  // Changing the model asks about old threads, and cancelling writes nothing.
  forms.length = 0;
  formAnswers.push({ action: "accept", content: { model: "__codex_default__", effort: "keep", ceilings: "keep" } });
  const cancelled = await call(17, "codex_config", { action: "interactive" }, 60_000);
  ok("a model change asks what to do with old threads",
     forms.length === 2 && /prompt cache/.test(forms[1]?.message ?? ""), forms[1]?.message?.slice(0, 60));
  ok("cancelling writes nothing", /cancelled/.test(cancelled?.result?.content?.[0]?.text ?? "") &&
     loadConfig().model === other);
  const reset = await call(15, "codex_config", { action: "reset" });
  ok("reset clears it", reset?.result?.isError !== true && loadConfig().model === null);
  proc.kill();
}

// A client without elicitation must get a clear refusal, so the slash command
// can fall back to asking the questions itself.
console.log("\n[13b] interactive config without form support");
{
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join: pjoin } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const proc = spawn(process.execPath, [pjoin(here, "..", "mcp", "connect-mcp.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  let buf = "";
  proc.stdout.on("data", (b) => {
    buf += b;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) if (l.trim()) { try { const m = JSON.parse(l); replies.set(m.id, m); } catch {} }
  });
  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  const wait = async (id, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (replies.has(id)) return replies.get(id); await new Promise((r) => setTimeout(r, 50)); }
    return null;
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  await wait(1, 10_000);
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codex_config", arguments: { action: "interactive" } } });
  const r = await wait(2, 30_000);
  ok("refuses with a reason the command can act on",
     r?.result?.isError === true && /cannot show forms/.test(r?.result?.content?.[0]?.text ?? ""),
     r?.result?.content?.[0]?.text);
  proc.kill();
}

// ------------------------------------------------------ 14. real contention
console.log("\n[14] real contention on one shared thread");
{
  const shared = new LeaseRegistry({ ttlMs: 60_000 });
  const lease = shared.acquire(s.threadId, "connect");
  let blocked = false;
  try { shared.acquire(s.threadId, "remote-control"); } catch (e) { blocked = e.code === "held"; }
  ok("remote-control blocked while Connect holds", blocked);
  let write = false;
  try { shared.guard("turn/start", s.threadId, "stale-token"); } catch (e) { write = e.code === "stale_token"; }
  ok("its write is fenced at the gate", write);
  shared.release(s.threadId, lease.token);
  ok("after release, remote-control can acquire", !!shared.acquire(s.threadId, "remote-control"));
}

// --------------------------------------------- 15. reconnect (opt-in only)
// This restarts the daemon, which drops EVERY attached client — including any
// Codex TUI or Remote Control session the user has open. Never run it by default.
if (process.env.CONNECT_TEST_DISRUPTIVE === "1") {
  console.log("\n[15] survives a daemon restart (disruptive)");
  const { spawn } = await import("node:child_process");
  const c = new CodexClient();
  let reconnected = false;
  c.on("reconnect", () => (reconnected = true));
  await c.connect({ socketPath: st.socketPath });
  await c.handshake({ name: "connect-reconnect" });
  await new Promise((r) =>
    spawn("codex", ["app-server", "daemon", "restart"], { stdio: "ignore" }).on("exit", r)
  );
  await new Promise((r) => setTimeout(r, 6000));
  ok("client reconnected automatically", reconnected);
  const after = await c.request("thread/list", {});
  ok("threads survive the restart", (after.data ?? []).length === existing);
  c.close();
} else {
  console.log("\n[15] reconnect test skipped (CONNECT_TEST_DISRUPTIVE=1 to run — it restarts the daemon)");
}

// ------------------------------------------- 16. agy, against a fake binary
// A stand-in `agy` that replays stream-json, so routing, the retry, the guards
// and the ledger are checked without spending a token or needing agy installed.
console.log("\n[16] agy bridge (fake agy binary)");
{
  const { writeFileSync, chmodSync, readFileSync, mkdirSync, realpathSync } = await import("node:fs");
  const agy = await import("../src/agy-client.mjs");
  const dir = mkdtempSync(tjoin(tmpdir(), "connect-agy-"));
  const bin = tjoin(dir, "agy");
  const log = tjoin(dir, "calls.jsonl");
  // Behaviour picked by a word in the prompt: DENY (empty + denied command on the
  // first turn only), TURBO (unsafe permission mode), ACCEPT (reports accept-edits),
  // SLOW (never finishes), EDIT (writes ./out.txt and plants a .git hook), else answers.
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const p = a[a.indexOf("-p") + 1];
const conv = a.includes("--conversation") ? a[a.indexOf("--conversation") + 1] : null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
const id = conv ?? "conv-1";
out({ event: "init", conversation_id: id, init: { permission_mode: p.includes("TURBO") ? "always-proceed" : p.includes("ACCEPT") ? "accept-edits" : "request-review" } });
if (p.includes("SLOW")) setTimeout(() => {}, 60000);
else {
  if (p.includes("EDIT")) {
    fs.writeFileSync("out.txt", "x");
    fs.writeFileSync(".git/hooks/pre-commit", "evil");
    fs.writeFileSync(".git/config", "[core]\\n\\thooksPath = /tmp\\n");
    out({ event: "step_update", step_update: { state: "DONE", step_type: "tool", tool_name: "write_to_file",
      tool_info: { parameters: { TargetFile: process.cwd() + "/out.txt" } } } });
  }
  const deny = p.includes("DENY") && !conv;
  out({ event: "step_update", step_update: { state: "DONE", step_type: "agent_response", usage: { total_tokens: 1000 } } });
  out({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: deny ? "" : "answer from " + (conv ? "retry" : "first"),
    usage: { total_tokens: 1000 }, ...(deny ? { denied_actions: [{ action: "command" }] } : {}) } });
}
`);
  chmodSync(bin, 0o755);
  const pol = agy.agyPolicy("quick_answer", { effort: "low" });
  const ask = (prompt, extra = {}) => agy.agyAsk({ prompt, intent: "quick_answer", policy: pol, cwd: dir, bin, timeoutMs: 2000, ...extra });

  const impl = agy.agyPolicy("implement");
  ok("implement writes, every other intent is read-only",
    impl.write && impl.maxTokens === agy.AGY_CEILINGS.implement && !agy.agyPolicy("second_opinion").write);
  ok("a Codex-only effort falls back to the route's", agy.agyPolicy("code_review", { effort: "minimal" }).effort === "high");
  const args = agy.agyArgs({ prompt: "q", effort: "low", conversationId: "c9" });
  ok("argv: stream-json, effort, conversation, preamble, no write mode",
    args.includes("stream-json") && args[args.indexOf("--effort") + 1] === "low" && args.includes("c9") &&
    args[1].startsWith(agy.READ_ONLY_PREAMBLE) && !args.includes("--mode"));
  const effErr = 'error: invalid model selection (--model "" --effort "max"): gemini-3.8-flash has no "max" effort (available: low, medium, high)';
  ok("an effort the model lacks steps down to the highest it offers",
    agy.effortFallback(effErr, "max") === "high" && agy.effortFallback("some other failure", "max") === null);
  const wargs = agy.agyArgs({ prompt: "q", effort: "high", write: true });
  ok("argv: implement adds accept-edits and its own preamble",
    wargs[wargs.indexOf("--mode") + 1] === "accept-edits" && wargs[1].startsWith(agy.IMPLEMENT_PREAMBLE));

  const plain = await ask("hello");
  ok("plain turn answers", plain.answer === "answer from first" && !plain.retried, plain.answer);
  const retried = await ask("DENY please");
  ok("denied empty turn is retried in the same conversation", retried.answer === "answer from retry" && retried.retried && retried.tokens === 2000);
  const turbo = await ask("TURBO please");
  ok("unsafe permission mode is refused", /permission mode "always-proceed"/.test(turbo.interrupted ?? ""), turbo.interrupted);
  const slow = await ask("SLOW please");
  ok("time cap kills a stuck turn", /time cap/.test(slow.interrupted ?? ""), slow.interrupted);
  const tight = await ask("hello", { policy: { ...pol, maxTokens: 500 } });
  ok("token ceiling interrupts", /token budget/.test(tight.interrupted ?? ""), tight.interrupted);
  ok("every turn spawned the binary", readFileSync(log, "utf8").trim().split("\n").length >= 6);
  const accept = await ask("ACCEPT please");
  ok("accept-edits is refused on a read-only turn", /permission mode "accept-edits"/.test(accept.interrupted ?? ""), accept.interrupted);

  // implement: edits are reported, and .git hooks/config are put back.
  const repo = realpathSync(mkdtempSync(tjoin(tmpdir(), "connect-agy-repo-")));  // as agy_ask does
  mkdirSync(tjoin(repo, ".git/hooks"), { recursive: true });
  writeFileSync(tjoin(repo, ".git/config"), "[core]\n");
  writeFileSync(tjoin(repo, ".git/hooks/pre-push"), "orig");
  chmodSync(tjoin(repo, ".git/hooks/pre-push"), 0o755);
  const wrote = await ask("EDIT ACCEPT please", { intent: "implement", policy: impl, cwd: repo });
  ok("implement: accept-edits passes, edit is reported", !wrote.interrupted && wrote.edited.join() === "out.txt", JSON.stringify(wrote.edited));
  ok("implement: planted hook removed, config restored, existing hook untouched",
    !existsSync(tjoin(repo, ".git/hooks/pre-commit")) && readFileSync(tjoin(repo, ".git/config"), "utf8") === "[core]\n" &&
      readFileSync(tjoin(repo, ".git/hooks/pre-push"), "utf8") === "orig" && existsSync(tjoin(repo, "out.txt")));
  ok("implement: reverted .git paths are reported",
    wrote.gitReverted.join() === ".git/config,.git/hooks/pre-commit", JSON.stringify(wrote.gitReverted));
  ok("read-only turns are not snapshotted", plain.gitReverted.length === 0);

  const ledger = tjoin(dir, "ledger.jsonl");
  agy.recordTurn({ conversationId: "a", cwd: "/x", prompt: "first", intent: "quick_answer" }, ledger);
  agy.recordTurn({ conversationId: "b", cwd: "/y", prompt: "other", intent: "quick_answer" }, ledger);
  agy.recordTurn({ conversationId: "a", cwd: "/x", prompt: "again", intent: "quick_answer" }, ledger);
  const convs = agy.listConversations(15, ledger);
  ok("ledger: newest first, turns counted, first prompt kept",
    convs[0].id === "a" && convs[0].turns === 2 && convs[0].prompt === "first" && convs.length === 2);
  ok("ledger: continuation finds its cwd", agy.conversationCwd("b", ledger) === "/y");
}

a.close(); b.close();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
