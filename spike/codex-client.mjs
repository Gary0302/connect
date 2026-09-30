/**
 * Connect spike — minimal Codex app-server client.
 *
 * Talks JSON-RPC (newline-delimited) to the *shared* managed app-server daemon
 * via `codex app-server proxy`, so Connect and Codex Remote Control drive the
 * same backend instead of each owning a private Codex process.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export class CodexClient extends EventEmitter {
  #proc = null;
  #nextId = 1;
  #pending = new Map();

  /** Ensure the managed daemon is up; returns its machine-readable status. */
  static async ensureDaemon({ remoteControl = false } = {}) {
    const args = remoteControl
      ? ["remote-control", "start", "--json"]
      : ["app-server", "daemon", "start"];
    const out = await run("codex", args);
    const version = await run("codex", ["app-server", "daemon", "version"]);
    return {
      start: tryJson(out.stdout) ?? out.stdout.trim(),
      version: tryJson(version.stdout) ?? version.stdout.trim(),
    };
  }

  /**
   * mode "proxy"  -> shared managed daemon (what Connect wants: Connect and
   *                  Codex Remote Control drive the same app-server).
   * mode "direct" -> private app-server on stdio. No daemon, no sharing, no
   *                  Remote Control, but the wire protocol is identical.
   */
  async connect({ mode = "proxy", socketPath, config = [] } = {}) {
    const args = mode === "direct" ? ["app-server"] : ["app-server", "proxy"];
    if (mode !== "direct" && socketPath) args.push("--sock", socketPath);
    for (const kv of config) args.push("-c", kv); // e.g. show_raw_agent_reasoning=true
    this.#proc = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#proc.stderr.on("data", (b) => this.emit("stderr", b.toString()));
    this.#proc.on("exit", (code) => this.emit("exit", code));

    createInterface({ input: this.#proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("stderr", `[unparsed] ${line}\n`);
        return;
      }
      this.#dispatch(msg);
    });
  }

  #dispatch(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      // Response to one of our requests.
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // Server -> client request (approvals, tool calls). Must be answered or
      // the turn stalls. The spike declines anything needing a human.
      this.emit("serverRequest", msg);
      return;
    }
    this.emit("notification", msg);
  }

  request(method, params = {}) {
    const id = this.#nextId++;
    this.#send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 120_000);
    });
  }

  notify(method, params = {}) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  respond(id, result) {
    this.#send({ jsonrpc: "2.0", id, result });
  }

  #send(obj) {
    this.#proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  close() {
    this.#proc?.kill();
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = "", stderr = "";
    p.stdout.on("data", (b) => (stdout += b));
    p.stderr.on("data", (b) => (stderr += b));
    p.on("exit", (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr}`))
    );
  });
}

function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
