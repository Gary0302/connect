---
name: ask-codex
description: Ask OpenAI Codex for a second opinion, an independent code review, or a cross-check from a different model, with cost-aware routing and resumable threads. Use when the user says "ask Codex", "what does Codex think", "get a second opinion", "have another model check this", or refers to an earlier Codex thread. Also use when a contested design decision, a subtle concurrency bug, or a security-sensitive diff would benefit from a genuinely independent model.
---

# Ask Codex

Runs one headless OpenAI Codex turn through `scripts/ask-codex.mjs` and returns its answer plus a
thread id you can continue later. Codex reads the working directory itself, so point it at real
file paths instead of pasting whole files.

Requirements: the `codex` CLI on PATH and logged in (`codex login`), and Node.js 18+.

## Running it

```sh
node <this skill's directory>/scripts/ask-codex.mjs --intent <intent> "<prompt>"
```

- `--thread <id>` continues an earlier conversation with its memory intact.
- `--model <id>` picks a Codex model. Leave it out unless the user asks for one.
- `--cd <dir>` sets the directory Codex works in (new threads only).
- Piped stdin is appended to the prompt, which is useful for a diff:
  `git diff | node .../ask-codex.mjs --intent code_review "review this diff for bugs"`.

## Always pick an intent

The intent sets reasoning effort, the sandbox and a time cap. It is required, because Codex's own
default effort can be `xhigh`. One measured one-sentence factual question at that default cost
**273,840 tokens and 48 seconds**. The same question as `quick_answer` cost about 16,000 tokens in
under 4 seconds.

| intent | effort | sandbox | use for |
|---|---|---|---|
| `quick_answer` | low | read-only | facts, versions, one-liners |
| `second_opinion` | medium | read-only | "is this approach sound?" |
| `code_review` | high | read-only | reading a diff or file for defects |
| `deep_reasoning` | xhigh | read-only | architecture, protocols, race conditions. Expensive |
| `implement` | high | **workspace-write** | Codex writes code in the working directory |

Use `implement` only when the user explicitly wants Codex to change files, and read its edits
before you call the work done. Every other intent cannot modify anything.

## Reading the result

The output is Codex's answer, then a `---` footer:

```
thread: 01a1…  (pass as --thread to continue)
routed: code_review · effort high · sandbox read-only · 41,203 tokens · 22.4s
```

- Always pass the thread id on to the user so they can resume the conversation later.
- `TURN FAILED` means there is no answer, or only a partial one. Say so; do not present it as
  complete. A time-cap failure usually means the question needs narrowing or a higher intent.
- `OVER CEILING` means the turn cost more than its intent normally should. Mention it if
  cost matters to the user.

## Reporting back

Codex is a peer model, not an oracle. Present its answer as Codex's view, quote it where the
wording matters, and say plainly where you disagree. The disagreement is why you asked.

## When not to use it

Don't send Codex work you can simply do yourself. Each call costs real tokens and adds latency.
Use it when a second, independent model makes the answer more reliable, or when the user asks.
