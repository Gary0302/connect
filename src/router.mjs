/**
 * Connect routing policy.
 *
 * Exists because of two measured facts (spike/FINDINGS.md):
 *
 *   1. A Codex thread's default effort came from ~/.codex/config.toml as
 *      "xhigh". A one-sentence factual question cost 273,840 tokens / 48.6s.
 *      Every turn Connect starts MUST carry an explicit `effort`, or the
 *      "cheap second opinion" path is the most expensive thing in the system.
 *   2. Reasoning notifications only arrive when `summary` is set on turn/start.
 *      The HUD needs them, so routes that surface progress must ask for them.
 *
 * Pure policy: no I/O, no model calls, so it is testable without spending a
 * token. The Haiku frontend may pass an intent explicitly; `classify` is the
 * fallback when it does not.
 */

/** @typedef {"quick_answer"|"second_opinion"|"code_review"|"deep_reasoning"|"implement"} Intent */

/**
 * `summary: "auto"` is the default because it is what feeds the HUD's
 * "what is Codex doing right now" line at no measurable token cost.
 *
 * `sandbox` is the third thing every route must pin. `approvalPolicy: "never"`
 * does NOT mean "do not touch anything" — it means nobody is asked first, so
 * whatever the sandbox permits happens silently. Asking for an opinion should
 * not be able to edit the tree, so everything but `implement` is read-only.
 * Codex can still read the repo, which is where most of its value comes from.
 * (`SandboxMode` = read-only | workspace-write | danger-full-access. Note the
 * turn-level field is `sandboxPolicy` and takes an OBJECT, `{type:"readOnly"}`;
 * this thread-level `sandbox` takes the string. Do not mix them up.)
 */
export const ROUTES = Object.freeze({
  // Factual lookups and one-liners. The whole point is to not pay for thinking.
  quick_answer:   { effort: "low",    summary: "none", maxTokens: 20_000,  sandbox: "read-only", label: "quick" },
  // A sanity check from the other model. Wants judgment, not a research project.
  second_opinion: { effort: "medium", summary: "auto", maxTokens: 80_000,  sandbox: "read-only", label: "2nd opinion" },
  // Reading a diff: needs care, bounded by the size of the diff.
  code_review:    { effort: "high",   summary: "auto", maxTokens: 200_000, sandbox: "read-only", label: "review" },
  // Architecture, race conditions, protocol design. Pay for this one.
  deep_reasoning: { effort: "xhigh",  summary: "detailed", maxTokens: 400_000, sandbox: "read-only", label: "deep" },
  // The one route that writes. Still confined to the workspace.
  implement:      { effort: "high",   summary: "auto", maxTokens: 300_000, sandbox: "workspace-write", label: "implement" },
});

export const DEFAULT_INTENT = "second_opinion";

const PATTERNS = [
  [/\b(design|architect|protocol|race condition|trade-?off|why does|deadlock|consistency)\b/i, "deep_reasoning"],
  [/\b(review|audit|diff|pull request|\bPR\b|regression|smell)\b/i, "code_review"],
  [/\b(implement|write|refactor|add|fix|migrate|port|rename)\b/i, "implement"],
  [/\b(what is|what's|which|where is|version|list|does .* exist|how many)\b/i, "quick_answer"],
];

/** Cheap heuristic used only when no intent was supplied. */
export function classify(text = "") {
  for (const [re, intent] of PATTERNS) if (re.test(text)) return intent;
  return DEFAULT_INTENT;
}

/**
 * Build the `turn/start` params for a request. Always explicit about effort
 * and summary; never inherits the thread or config default.
 *
 * `policy` replaces the built-in route for the chosen intent — how the user's
 * preferences (src/config.mjs) reach the turn without this module doing I/O.
 */
export function route({ threadId, text, intent, model, cwd, policy: override, overrides = {} }) {
  const chosen = intent ?? classify(text);
  const policy = typeof override === "function" ? override(chosen) : ROUTES[chosen];
  if (!policy) throw new Error(`unknown intent: ${chosen}`);

  const params = {
    threadId,
    input: [{ type: "text", text }],
    effort: policy.effort,
    ...(policy.summary === "none" ? {} : { summary: policy.summary }),
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...overrides,
  };
  return { intent: chosen, policy, params };
}

/**
 * Guard against a route running away. Callers poll this with the running total
 * from `thread/tokenUsage/updated` and `turn/interrupt` when it trips.
 */
export function overBudget(intent, totalTokens, maxTokens = ROUTES[intent]?.maxTokens) {
  return maxTokens != null && totalTokens > maxTokens;
}
