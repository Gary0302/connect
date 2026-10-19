#!/usr/bin/env node
/** Intercept only this command; displaying a block reason skips inference. */
import { collectUsage, formatUsage } from "../src/usage.mjs";

export async function handleUsagePrompt(input, collect = collectUsage) {
  const expansion = input.hook_event_name === "UserPromptExpansion" && input.command_name === "connect:usage";
  const match = typeof input.prompt === "string" ? /^\/connect:usage(?:\s+([\s\S]*))?$/.exec(input.prompt.trim()) : null;
  if (!expansion && !match) return null;
  const args = (expansion ? input.command_args ?? "" : match[1] ?? "").trim();
  let reason;
  if (args && args !== "--json") reason = "Usage: /connect:usage [--json]";
  else {
    try {
      const report = await collect();
      reason = args === "--json" ? JSON.stringify(report, null, 2) : formatUsage(report, {
        // Hooks use a pipe even in the interactive terminal.
        color: !Object.hasOwn(process.env, "NO_COLOR") && process.env.FORCE_COLOR !== "0",
      });
    } catch { reason = "Connect usage failed. Run node bin/connect.mjs usage from the plugin directory to retry."; }
  }
  return {
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: expansion ? "UserPromptExpansion" : "UserPromptSubmit",
      ...(!expansion ? { suppressOriginalPrompt: true } : {}),
    },
  };
}

// Export the handler for offline tests without executing stdin on import.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const output = await handleUsagePrompt(input);
  if (output) process.stdout.write(JSON.stringify(output) + "\n");
}
