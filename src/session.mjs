/**
 * A Connect session: one Codex thread, driven through the router and fenced by
 * the lease registry, with the HUD state the status line needs.
 */
import { CodexClient } from "./codex-client.mjs";
import { LeaseRegistry } from "./lease.mjs";
import { route, overBudget } from "./router.mjs";

/** Distinguishes concurrent sessions in the lease registry. See `owner` below. */
let sessionSeq = 0;

export class ConnectSession {
  /**
   * @param {CodexClient} codex
   * @param {LeaseRegistry} leases
   * @param {{owner?: string}} [opts] `owner` defaults to a per-session id, and
   *   should stay unique: the registry lets one owner re-acquire its own lease,
   *   so sessions sharing a name do not exclude each other on a shared thread.
   */
  constructor(codex, leases, { owner = `connect#${++sessionSeq}` } = {}) {
    this.codex = codex;
    this.leases = leases;
    this.owner = owner;
    this.threadId = null;

    /** The turn `ask()` is currently driving, learned from `turn/started`.
     *  Null between turns, which is also what makes `#owns` refuse to attribute
     *  a stray turn to this session while it is idle. */
    this.activeTurnId = null;
    /** True only between `turn/start` being sent and the turn finishing: the
     *  window in which an unclaimed `turn/started` on our thread is ours. */
    this.claimingTurn = false;
    /** Thread-cumulative token total as it stood before this turn, so the cost
     *  of THIS turn can be isolated. Null until the turn's first usage update. */
    this.turnTokenBaseline = null;

    /** Everything the HUD renders. Updated from notifications, never polled. */
    this.hud = {
      state: "idle", // idle | working | reasoning | done | interrupted
      model: null,
      effort: null,
      intent: null,
      step: null, // latest reasoning summary headline
      totalTokens: 0, // thread-cumulative, what the daemon reports
      turnTokens: 0, // this turn alone — the number the budget must police
      cachedInputTokens: 0,
      lastActivity: Date.now(),
    };

    /** Reasoning summaries keyed by itemId, because summaryIndex restarts at 0
     *  for each new reasoning item within a single turn (measured, spike 02). */
    this.reasoning = new Map();

    // Held so `dispose()` can take it back off. A session that stays attached to
    // a long-lived client after its call is over keeps ingesting every later
    // notification, and the client is shared by every tool call.
    this.onNotification = (m) => this.#onNotification(m);
    codex.on("notification", this.onNotification);
    // Server->client requests are answered once, by the client itself. A
    // per-session responder means N responses to one request id.
  }

  /** Detach from the shared client. Idempotent; a disposed session is inert. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.codex.off("notification", this.onNotification);
  }

  async startThread({ cwd = process.cwd(), approvalPolicy = "never", sandbox = "read-only", model } = {}) {
    // `approvalPolicy: "never"` only decides who is asked; `sandbox` decides
    // what is possible. Without it the thread inherits whatever the config says.
    const res = await this.codex.request("thread/start", { cwd, approvalPolicy, sandbox, ...(model ? { model } : {}) });
    this.threadId = res.thread.id; // NOT res.threadId (spike 01 correction)
    this.hud.model = res.model;
    return res;
  }

  /**
   * Does this notification belong to our thread and our in-flight turn?
   *
   * The daemon is shared by construction: a Codex TUI (`codex --remote`) and
   * Remote Control drive the same app-server and emit the same notification
   * methods down the same socket. Unfiltered, one of their `turn/completed`
   * resolves our turn early, their `item/agentMessage/delta` lands in our
   * answer, and their `thread/tokenUsage/updated` drives our budget.
   *
   * Every notification consumed here carries the correlation we need, but not
   * in one shape: the deltas carry a flat `turnId`, while `turn/started` and
   * `turn/completed` nest it as `turn.id` (generated app-server schemas,
   * `codex app-server generate-json-schema`).
   */
  #owns(msg) {
    const p = msg.params ?? {};
    if (!this.threadId || p.threadId !== this.threadId) return false;
    const turnId = p.turnId ?? p.turn?.id;
    // Before `turn/started` arrives there is no id to match on, and a turn can
    // emit before the `turn/start` response returns. Thread identity is then
    // the strongest claim available, and the lease makes it a sound one.
    if (!this.activeTurnId || !turnId) return true;
    return turnId === this.activeTurnId;
  }

  #onNotification(msg) {
    const p = msg.params ?? {};
    // Claim the turn before filtering: this is the notification that teaches
    // #owns which turn is ours, so it cannot be gated on already knowing.
    if (msg.method === "turn/started" && this.claimingTurn && !this.activeTurnId && p.threadId === this.threadId) {
      this.activeTurnId = p.turn?.id ?? null;
    }
    if (!this.#owns(msg)) return;
    this.hud.lastActivity = Date.now();
    switch (msg.method) {
      case "item/reasoning/summaryTextDelta": {
        const parts = this.reasoning.get(p.itemId) ?? new Map();
        parts.set(p.summaryIndex, (parts.get(p.summaryIndex) ?? "") + p.delta);
        this.reasoning.set(p.itemId, parts);
        this.hud.state = "reasoning";
        this.hud.step = String(parts.get(p.summaryIndex)).replace(/\*\*/g, "").trim();
        break;
      }
      case "thread/tokenUsage/updated": {
        // The reliable liveness heartbeat: reasoning summaries are optional and
        // a turn can produce none, but this fires throughout (spike 01/02).
        //
        // `total` is thread-cumulative and `last` is the most recent model
        // REQUEST, not the turn. Measured on a 4-step tool turn: last went
        // 16,228 -> 16,363 -> 16,496 -> 16,586 while total went 16,228 ->
        // 32,591 -> 49,087 -> 65,673. The turn cost 65,673; `last` understates
        // it fourfold, and `total` overstates it by everything the thread spent
        // before now. Neither can police a per-turn budget on its own.
        //
        // The first update of a turn pins the baseline: at that point `total`
        // already includes `last`, so `total - last` is exactly what the thread
        // had spent beforehand. That holds for a resumed thread too.
        const t = p.tokenUsage?.total ?? {};
        const lastTokens = p.tokenUsage?.last?.totalTokens;
        this.hud.totalTokens = t.totalTokens ?? this.hud.totalTokens;
        this.hud.cachedInputTokens = t.cachedInputTokens ?? this.hud.cachedInputTokens;
        if (this.claimingTurn && this.turnTokenBaseline === null && t.totalTokens != null && lastTokens != null) {
          this.turnTokenBaseline = t.totalTokens - lastTokens;
        }
        if (this.turnTokenBaseline !== null) {
          this.hud.turnTokens = Math.max(0, this.hud.totalTokens - this.turnTokenBaseline);
        }
        if (this.hud.state === "idle") this.hud.state = "working";
        break;
      }
      case "turn/started":
        this.hud.state = "working";
        break;
      case "turn/completed":
        this.hud.state = "done";
        this.hud.step = null;
        break;
    }
  }

  /**
   * One routed, leased, budget-capped turn. Resolves with the final text.
   * `policy` is an optional `intent => policy` resolver carrying user preferences.
   */
  async ask(text, { intent, model, policy: resolvePolicy, timeoutMs = 300_000 } = {}) {
    if (!this.threadId) throw new Error("startThread() first");
    if (this.disposed) throw new Error("session disposed");
    // One turn at a time per session: the turn-claim state below is singular,
    // and a second concurrent turn would silently steal the first one's id.
    if (this.claimingTurn) throw new Error("this session already has a turn in flight");

    const lease = this.leases.acquire(this.threadId, this.owner);
    const { intent: chosen, policy, params } = route({ threadId: this.threadId, text, intent, model, policy: resolvePolicy });
    this.hud.intent = chosen;
    this.hud.effort = policy.effort;
    this.hud.state = "working";

    // The fence. A stale token is refused here even if the clock says otherwise.
    this.leases.guard("turn/start", this.threadId, lease.token);

    this.activeTurnId = null;
    this.claimingTurn = true;
    this.turnTokenBaseline = null;
    this.hud.turnTokens = 0;

    let answer = "";
    let budgetExceeded = false;
    let interruptError = null;
    const onDelta = (m) => {
      if (!this.#owns(m)) return;
      if (m.method === "item/agentMessage/delta") answer += m.params.delta;
      if (m.method !== "thread/tokenUsage/updated" || budgetExceeded) return;
      if (!overBudget(chosen, this.hud.turnTokens, policy.maxTokens)) return;
      budgetExceeded = true;
      this.hud.state = "interrupted";
      // `turn/interrupt` requires BOTH ids (TurnInterruptParams.required is
      // ["threadId","turnId"]); sending only the thread id is rejected, which
      // is how the budget silently did nothing. Without a claimed turn there is
      // nothing valid to send, so record that rather than fire a bad request.
      if (!this.activeTurnId) {
        interruptError = new Error("over budget before the turn id was known; cannot interrupt");
        return;
      }
      this.codex
        .request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId })
        .catch((e) => (interruptError = e));
    };
    this.codex.on("notification", onDelta);

    // Every listener and timer this turn installs, torn down in one place. The
    // old code only unhooked on the success path, so a timeout or a failed
    // `turn/start` left a listener on the shared client forever.
    let timer = null;
    let onDone = null;
    let onDisconnect = null;
    const teardown = () => {
      clearTimeout(timer);
      this.codex.off("notification", onDelta);
      if (onDone) this.codex.off("notification", onDone);
      if (onDisconnect) this.codex.off("close", onDisconnect);
    };

    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`turn timed out after ${timeoutMs}ms`)), timeoutMs);
      onDone = (m) => {
        if (m.method !== "turn/completed" || !this.#owns(m)) return;
        resolve(m.params);
      };
      // A dropped transport can never deliver `turn/completed`. Without this the
      // turn sits until its timeout even though the answer is already lost:
      // `turn/start` has returned, so there is no pending request to reject.
      onDisconnect = () => reject(new Error("connection to the Codex daemon was reset mid-turn"));
      this.codex.on("notification", onDone);
      this.codex.on("close", onDisconnect);
    });
    // Nothing awaits this until `turn/start` resolves; without a catch here a
    // rejection in that window is an unhandled rejection.
    completed.catch(() => {});

    try {
      // Fallback claim: normally `turn/started` has already set this, but the
      // response carries the same id and wins if the notification was missed.
      const started = await this.codex.request("turn/start", params);
      this.activeTurnId ??= started.turn?.id ?? null;
      const done = await completed;
      // The daemon is the authority on what happened. A rejected or failed
      // interrupt used to be swallowed while the caller was still told the turn
      // had been interrupted, and a failed turn read as a successful empty one.
      const status = done.turn?.status ?? "completed";
      return {
        answer: answer.trim(),
        intent: chosen,
        policy,
        status,
        interrupted: status === "interrupted",
        failed: status === "failed",
        error: done.turn?.error ?? null,
        budgetExceeded,
        interruptError,
        tokens: this.hud.turnTokens,
        turn: done.turn,
      };
    } finally {
      teardown();
      this.claimingTurn = false;
      this.activeTurnId = null;
      this.turnTokenBaseline = null;
      // Releasing must not mask the turn's own outcome. The lease can legitimately
      // be gone by now — expired, or reaped by a newer holder — and throwing from
      // a finally would replace a good answer with a lease error.
      try {
        this.leases.release(this.threadId, lease.token);
      } catch {
        /* lease already moved on; the turn's result stands */
      }
    }
  }

  /**
   * Compact the thread's history. Measured: `thread/compact/start` answers `{}`
   * at once, then the daemon runs compaction as its own turn — `turn/started`,
   * a `contextCompaction` item, `turn/completed` (~6s on a short thread). No
   * `thread/compacted` notification arrived, so completion is the turn's.
   */
  async compact({ timeoutMs = 180_000 } = {}) {
    if (!this.threadId) throw new Error("startThread() first");
    if (this.claimingTurn) throw new Error("this session already has a turn in flight");
    const lease = this.leases.acquire(this.threadId, this.owner);
    this.leases.guard("thread/compact/start", this.threadId, lease.token);
    let turnId = null;
    let timer = null;
    let onNote = null;
    let onDisconnect = null;
    try {
      const done = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`compaction timed out after ${timeoutMs}ms`)), timeoutMs);
        onNote = (m) => {
          const p = m.params ?? {};
          if (p.threadId !== this.threadId) return;
          if (m.method === "turn/started" && !turnId) turnId = p.turn?.id ?? null;
          if (m.method === "turn/completed" && (!turnId || p.turn?.id === turnId)) resolve(p.turn);
        };
        onDisconnect = () => reject(new Error("connection to the Codex daemon was reset mid-compaction"));
        this.codex.on("notification", onNote);
        this.codex.on("close", onDisconnect);
      });
      done.catch(() => {});
      await this.codex.request("thread/compact/start", { threadId: this.threadId });
      const turn = await done;
      if (turn?.status === "failed") throw new Error(`compaction failed: ${turn.error?.message ?? "no reason given"}`);
      return turn;
    } finally {
      clearTimeout(timer);
      if (onNote) this.codex.off("notification", onNote);
      if (onDisconnect) this.codex.off("close", onDisconnect);
      try {
        this.leases.release(this.threadId, lease.token);
      } catch {
        /* lease already moved on */
      }
    }
  }

  /** One line for the status bar. */
  hudLine() {
    const h = this.hud;
    const dot = { idle: "○", working: "●", reasoning: "◐", done: "✓", interrupted: "⊘" }[h.state] ?? "?";
    const cache = h.totalTokens ? ` · cached ${Math.round((h.cachedInputTokens / h.totalTokens) * 100)}%` : "";
    const step = h.step ? ` · ${h.step}` : "";
    // This turn's cost, not the thread's: the thread total only ever climbs and
    // says nothing about what the user is waiting on right now.
    return `Codex ${dot} ${h.model ?? "?"} · ${h.intent ?? "-"}/${h.effort ?? "-"} · ${h.turnTokens.toLocaleString()} tok${cache}${step}`;
  }
}
