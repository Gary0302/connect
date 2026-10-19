/**
 * Connect's HUD, a function-hooks module Claude Code loads with the plugin.
 *
 * Two jobs. While a Connect call runs, a line pinned under the prompt names
 * the peer at work and how long it has run. And it keeps the quota line that
 * `/connect:usage` switches on fresh: `bin/connect.mjs usage refresh` rewrites
 * ~/.config/connect/usage-line.txt, which the user's status line prints. That
 * reads quotas only and never starts a model turn; while the line is off it
 * exits at once. This module has no Node, so the work runs on the host.
 * CONNECT_HUD=0 turns the module off.
 */

const PEERS = {
  mcp__plugin_connect_connect__codex_ask: "codex",
  mcp__plugin_connect_connect__agy_ask: "agy",
  mcp__plugin_connect_connect__peers_compare: "codex+agy",
};
const REFRESH_MS = 5 * 60_000;
// Turns end often; the script also skips a line another session wrote this minute.
const MIN_GAP_MS = 60_000;

let enabled = true;
let lastRefresh = -Infinity;
let refreshing = null;
const running = new Map();

const clock = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

async function draw($) {
  const now = await $.clock.now();
  const busy = [...running.values()].map((r) => `${r.who} ▸ ${r.intent} ${clock(now - r.startedAt)}`);
  $.ui.status(busy.length ? busy.join(" · ") : undefined);
}

async function refresh($, { force = false } = {}) {
  const now = await $.clock.now();
  if (refreshing || (!force && now - lastRefresh < MIN_GAP_MS)) return refreshing;
  lastRefresh = now;
  refreshing = $.process.run(["node", `${$.plugin.root}/bin/connect.mjs`, "usage", "refresh"], { timeoutMs: 30_000 })
    .catch(() => {})
    .finally(() => { refreshing = null; });
  return refreshing;
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    enabled = (await $.env.get("CONNECT_HUD")) !== "0" && e.isInteractive;
    if (enabled) {
      $.clock.after(0, () => { refresh($, { force: true }); });
      $.clock.every(REFRESH_MS, () => { refresh($, { force: true }); });
    }
    return result;
  });

  on("tool.call", { tool: [
    "mcp__plugin_connect_connect__codex_ask",
    "mcp__plugin_connect_connect__agy_ask",
    "mcp__plugin_connect_connect__peers_compare",
  ] }, async ($, e, next) => {
    if (!enabled) return next(e);
    running.set(e.tool_use_id, {
      who: PEERS[e.tool],
      intent: typeof e.intent === "string" ? e.intent : "ask",
      startedAt: await $.clock.now(),
    });
    await draw($);
    const tick = $.clock.every(1000, () => { draw($); });
    try {
      return await next(e);
    } finally {
      tick.cancel();
      running.delete(e.tool_use_id);
      await draw($);
      // Work that outlives this dispatch rides a timer, as the hooks API asks.
      $.clock.after(0, () => { refresh($); });
    }
  }).catch(($, e, next) => next(e));

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    // A subagent's turns end here too; the main loop's are the ones worth a check.
    if (enabled && !e.agentId) $.clock.after(0, () => { refresh($); });
    return result;
  });
};
