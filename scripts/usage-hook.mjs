#!/usr/bin/env node
/** Intercept only this command; displaying a block reason skips inference. */
import { homedir } from "node:os";
import {
  collectUsage, formatUsage, setStatusLine, statusLineConfigured, statusLineEnabled, statusLinePath,
} from "../src/usage.mjs";

const USAGE = "Usage: /connect:usage [on|off|show|--json]";
// Hooks use a pipe even in the interactive terminal.
const color = () => !Object.hasOwn(process.env, "NO_COLOR") && process.env.FORCE_COLOR !== "0";

/** No arguments toggles the status line; `show` and `--json` only read. */
async function answer(args, collect, { path, settingsPath }) {
  if (args === "show" || args === "--json") {
    const report = await collect();
    return args === "--json" ? JSON.stringify(report, null, 2) : formatUsage(report, { color: color() });
  }
  const on = args === "on" || (args === "" && !(await statusLineEnabled(path)));
  if (!on) {
    await setStatusLine(false, { path });
    return "Connect usage in the status line: off";
  }
  let rows;
  try { rows = formatUsage(await setStatusLine(true, { path, collect }), { color: color() }); }
  catch { rows = "The first quota check failed; the line fills in at the next refresh."; }
  const lines = ["Connect usage in the status line: on", rows];
  if (!(await statusLineConfigured({ path, settingsPath }))) {
    const file = path.replace(homedir(), "~");
    lines.push("", "Your status line does not print it yet. Add this to the end of your status line script:",
      `  f=${file}; if [ -s "$f" ]; then printf '  %s' "$(cat "$f")"; fi`);
  }
  return lines.join("\n");
}

export async function handleUsagePrompt(input, collect = collectUsage, { path = statusLinePath(), settingsPath } = {}) {
  const expansion = input.hook_event_name === "UserPromptExpansion" && input.command_name === "connect:usage";
  const match = typeof input.prompt === "string" ? /^\/connect:usage(?:\s+([\s\S]*))?$/.exec(input.prompt.trim()) : null;
  if (!expansion && !match) return null;
  const args = (expansion ? input.command_args ?? "" : match[1] ?? "").trim();
  let reason;
  if (!["", "on", "off", "show", "--json"].includes(args)) reason = USAGE;
  else {
    try { reason = await answer(args, collect, { path, settingsPath }); }
    catch { reason = "Connect usage failed. Run node bin/connect.mjs usage from the plugin directory to retry."; }
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
