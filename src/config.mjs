/**
 * User preferences layered over the routing policy: which Codex model to use,
 * and per-intent effort and token ceiling.
 *
 * Lives outside the plugin directory on purpose. Installing copies the plugin
 * into ~/.claude/plugins/cache/, and a reinstall would wipe anything stored
 * there. Read fresh on every call, so `/connect:config` takes effect on the
 * next `codex_ask` without restarting Claude Code.
 *
 * What is NOT configurable: the sandbox. That is a safety property of each
 * intent (read-only unless `implement`), not a preference.
 *
 *   {
 *     "model": "gpt-5.6-terra",              // omit or null = Codex's own default
 *     "onModelChange": "switch",             // switch | compact | keep — see below
 *     "intents": {
 *       "second_opinion": { "effort": "high", "maxTokens": 160000 }
 *     }
 *   }
 *
 * `onModelChange` decides what happens when an EXISTING thread is continued
 * while it runs on a different model than the configured one. Switching a
 * thread's model throws away Codex's prompt cache for it, so the next turn
 * pays full price for the whole history:
 *   switch  — change it on the next turn (default)
 *   compact — compact the thread first, so the uncached history is small
 *   keep    — leave old threads on their model; only new threads use the new one
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ROUTES } from "./router.mjs";

export const MODEL_CHANGE = Object.freeze(["switch", "compact", "keep"]);

export function configPath() {
  return process.env.CONNECT_CONFIG || join(homedir(), ".config", "connect", "config.json");
}

/** Missing file is the normal case and means "no preferences". A corrupt one is not. */
export function loadConfig(path = configPath()) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { model: null, onModelChange: "switch", intents: {} };
    throw e;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${e.message}); fix or delete it`);
  }
  return { model: cfg.model ?? null, onModelChange: cfg.onModelChange ?? "switch", intents: cfg.intents ?? {} };
}

/** Atomic, so a crash mid-write cannot leave a half file that breaks every later ask. */
export function saveConfig(cfg, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Merge a patch into the stored config. `model: null` clears the preference;
 * an intent field set to null reverts it to the built-in default.
 */
export function applyPatch(cfg, { model, onModelChange, intents = {} } = {}) {
  const next = { model: cfg.model, onModelChange: cfg.onModelChange ?? "switch", intents: structuredClone(cfg.intents) };
  if (model !== undefined) next.model = model || null;
  if (onModelChange != null) {
    if (!MODEL_CHANGE.includes(onModelChange))
      throw new Error(`onModelChange must be one of: ${MODEL_CHANGE.join(", ")}`);
    next.onModelChange = onModelChange;
  }
  for (const [intent, fields] of Object.entries(intents)) {
    if (!ROUTES[intent]) throw new Error(`unknown intent: ${intent}. one of: ${Object.keys(ROUTES).join(", ")}`);
    const cur = { ...next.intents[intent] };
    for (const key of ["effort", "maxTokens"]) {
      if (!(key in fields)) continue;
      if (fields[key] == null) delete cur[key];
      else cur[key] = fields[key];
    }
    if (cur.maxTokens != null && !(Number.isInteger(cur.maxTokens) && cur.maxTokens > 0))
      throw new Error(`maxTokens for ${intent} must be a positive integer`);
    if (Object.keys(cur).length) next.intents[intent] = cur;
    else delete next.intents[intent];
  }
  return next;
}

/** The policy an intent actually runs with once preferences are applied. */
export function effectivePolicy(intent, cfg) {
  const base = ROUTES[intent];
  if (!base) throw new Error(`unknown intent: ${intent}`);
  const o = cfg?.intents?.[intent] ?? {};
  return {
    ...base,
    effort: o.effort ?? base.effort,
    maxTokens: o.maxTokens ?? base.maxTokens,
    customized: o.effort != null || o.maxTokens != null,
  };
}
