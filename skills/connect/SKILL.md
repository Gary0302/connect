---
name: connect
user-invocable: false
description: Ask OpenAI Codex for a second opinion, an independent review, or a cross-check from a different model, and resume earlier Codex conversations. Use when the user says "ask Codex", "what does Codex think", "get a second opinion", "have another model check this", or refers to a previous Codex thread. Also use when a design decision, a subtle bug, or a risky diff would benefit from a genuinely independent model rather than more of your own reasoning.
---

# Connect — Codex from inside Claude Code

Connect gives you four MCP tools backed by a local Codex daemon. Threads persist, so a
conversation with Codex can span the whole session and be resumed later.

## Choosing an intent

`codex_ask` takes an `intent`, which sets reasoning effort and a cost ceiling. **Always pass one
explicitly.** If you omit it, it is inferred from the prompt, which is a guess.

| intent | effort | sandbox | use for |
|---|---|---|---|
| `quick_answer` | low | read-only | facts, versions, one-liners. ~16k tokens, a few seconds |
| `second_opinion` | medium | read-only | "is this approach sound?" |
| `code_review` | high | read-only | reading a diff or a file for defects |
| `deep_reasoning` | xhigh | read-only | architecture, protocols, race conditions. Expensive |
| `implement` | high | **workspace-write** | asking Codex to write code |

The sandbox column is not decoration. `implement` is the only intent that can modify the tree, so
reach for it deliberately — never as a default for "do something". Under every other intent Codex
can still read the working directory, which is where most of its usefulness comes from: point it at
real paths instead of pasting files into the prompt.

This matters more than it looks. The Codex thread default is `xhigh`, and one measured
one-sentence factual question at that default cost **273,840 tokens and 48 seconds**. The same
question as `quick_answer` costs about 16,000 tokens in 3.5 seconds. Never send a trivial question
without `intent: "quick_answer"`.

## Continuing a conversation

Every `codex_ask` result ends with the `thread:` id it used. Pass that back as `threadId` to
continue with full memory of the exchange. `codex_threads` lists recent threads and
`codex_history` replays one, so a conversation from a previous session can be picked back up.

## Reporting back

Codex is a peer model, not an oracle. Relay what it actually said, name it as Codex's view rather
than fact, and say so plainly when you disagree — the point of asking a different model is the
disagreement. Quote it when the wording matters; summarize when it does not.

If a result says `INTERRUPTED: exceeded the budget for this intent`, the answer is partial: either
re-ask with a higher intent or narrow the question.

## When not to use it

Do not route work to Codex that you can simply do. It costs real tokens and adds latency. Reach
for it when a second, independent model genuinely changes the answer's reliability: contested
design calls, subtle concurrency, security-sensitive review, or when the user asks.

## If something is broken

Run `codex_doctor`. It reports daemon status, a CLI/app-server version mismatch, and remote
control state. If it reports a version mismatch, **tell the user** — the fix is
`codex app-server daemon restart`, which drops every attached Codex session, including any TUI
they have open. Never run it for them.
