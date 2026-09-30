---
description: Choose the Codex model, reasoning effort and token ceilings Connect uses
argument-hint: "[show | reset | model <id> | <intent> <effort> | old-threads switch|compact|keep]"
---

Configure Connect: $ARGUMENTS

Everything goes through the `codex_config` MCP tool. Settings are stored in
`~/.config/connect/config.json` and apply to the next `codex_ask` — no restart needed.

## With arguments — do it directly, no questions

- `show` → `codex_config` with `action: "show"`.
- `reset` → `action: "reset"`.
- `model <id>` → `action: "set"`, `model: "<id>"`. `model default` sets `model: null`.
- `<intent> <effort>` (e.g. `code_review xhigh`) → `action: "set"`,
  `intents: { "<intent>": { "effort": "<effort>" } }`.
- `old-threads <switch|compact|keep>` → `action: "set"`, `onModelChange: "<value>"`.

Print the table the tool returns. If it errors (unknown model, unsupported effort), show the error
and the valid choices it lists.

If a model change goes through this way, tell the user in one line: an existing Codex thread they
continue afterwards loses its prompt cache (its next turn re-reads the whole history at full
price), and `old-threads compact` or `old-threads keep` changes that.

## Without arguments — interactive

Call `codex_config` with `action: "interactive"`. The MCP server opens its own forms in the
terminal — model, then Codex's effort levels for that model, then (only if the model changed) what
to do with existing threads — and saves the result. Print the summary and table it returns, and
nothing else. Do not ask the questions yourself.

### Fallback: only if that call errors saying the client cannot show forms

1. `codex_config` with `action: "show"`; print the table.
2. One `AskUserQuestion` call:
   - **Model** — up to 3 models from `available models` (current one first, marked "(current)")
     plus `Codex default`. Option descriptions: each model's description. Others via "Other".
   - **Effort** — `Auto by intent (Recommended)` (clears overrides), `One Codex level for all`,
     `Per intent`.
   - **Token ceilings** — `Keep`, `Built-in`, `2×`, `4×`. Say that a turn past its ceiling is cut
     off, so raising effort without raising the ceiling truncates answers.
3. If they chose a single level or per intent: ask with the model's own Codex levels and their
   descriptions from the table (at most 4 options per question, "Other" covers the rest).
4. If the model changed, ask **Existing threads** and state in the question that switching resets
   Codex's prompt cache on every existing thread continued afterwards:
   `Change directly (default)` / `Compact first, then change` / `No — keep old threads on their model`
   → `onModelChange` `switch` / `compact` / `keep`.
5. Apply everything in one `codex_config` `set` call. Ceilings: `maxTokens: null` for built-in, or
   the built-in ceiling × 2 or × 4 (20,000 / 80,000 / 200,000 / 400,000 / 300,000 in intent
   order). Print the table it returns.

Sandboxes are not configurable: every intent but `implement` stays read-only. If the user asks to
change that, say so rather than working around it.
