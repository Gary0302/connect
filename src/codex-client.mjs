/**
 * Connect's Codex app-server client.
 *
 * Two transports, same JSON-RPC surface:
 *
 *   "daemon" (default) — WebSocket to the managed daemon's control socket.
 *                        This is the one Connect wants: Connect, the Codex TUI
 *                        (`codex --remote unix://...`) and Codex Remote Control
 *                        all drive the SAME app-server, so threads are shared.
 *   "direct"           — private `codex app-server` on stdio, newline-delimited.
 *                        No daemon, no sharing, no Remote Control. Useful as a
 *                        fallback and for tests that must not touch the daemon.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { WsUnixSocket } from "./ws-unix.mjs";

export const DEFAULT_SOCKET = join(homedir(), ".codex/app-server-control/app-server-control.sock");

/**
 * Which `codex` to drive.
 *
 * The daemon needs the standalone install, and a brew/npm `codex` earlier in
 * PATH can be a different version — on this machine, standalone 0.148.0 against
 * brew 0.147.0. Every entry point resolves through here so the CLI and the MCP
 * server cannot disagree about which binary they are talking to.
 */
export function resolveCodexBin() {
  if (process.env.CONNECT_CODEX_BIN) return process.env.CONNECT_CODEX_BIN;
  const standalone = join(homedir(), ".local/bin/codex");
  return existsSync(standalone) ? standalone : "codex";
}

/**
 * How to refuse each server->client request, by method.
 *
 * A server request MUST be answered or the turn stalls forever, and each method
 * has its own response shape — there is no universal refusal. Connect never
 * blocks on a modal, so every one of these declines; the point of the table is
 * that it declines in the shape the app-server will accept.
 *
 * Taken from `ServerRequest.json` / `*Response.json`
 * (`codex app-server generate-json-schema --out <dir>`). Note `decision`: the
 * legal values are accept | acceptForSession | decline | cancel. Connect used
 * to send `"denied"` for every request, which is not in that enum at all — and
 * for six of the ten methods `decision` is not even the right field.
 *
 * `decline` refuses one action and lets the turn carry on; `cancel` would kill
 * the turn outright, which is too blunt for a tool the model may not need.
 */
export const SERVER_REQUEST_DECLINES = Object.freeze({
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "applyPatchApproval": { decision: "decline" },
  "execCommandApproval": { decision: "decline" },
  // An empty profile grants nothing beyond the sandbox the thread already has.
  "item/permissions/requestApproval": { permissions: {} },
  // `answers` is a map keyed by question id; empty means nothing was answered.
  "item/tool/requestUserInput": { answers: {} },
  "mcpServer/elicitation/request": { action: "decline" },
  "item/tool/call": {
    success: false,
    contentItems: [{ type: "inputText", text: "Declined: Connect runs without a human to approve tool calls." }],
  },
  // `account/chatgptAuthTokens/refresh` and `attestation/generate` want
  // credentials, not a decision. There is no honest refusal shape, so they get
  // a JSON-RPC error instead of a fabricated response.
});

export class CodexClient extends EventEmitter {
  #transport = null; // { send(text), close() }
  #proc = null;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #opts = null;
  #clientInfo = null;
  #reconnecting = false;
  #everConnected = false;

  /**
   * Start the managed daemon if needed. Returns its machine-readable status,
   * which carries the socket path plus cliVersion/appServerVersion — the exact
   * pair `/connect:doctor` compares to catch a stale daemon after an update.
   */
  static async ensureDaemon({ codexBin = resolveCodexBin() } = {}) {
    const start = await run(codexBin, ["app-server", "daemon", "start"]);
    const status = tryJson(start.stdout);
    if (!status) throw new Error(`could not parse daemon status: ${start.stdout || start.stderr}`);
    return status;
  }

  async connect(opts = {}) {
    this.#opts = { mode: "daemon", socketPath: DEFAULT_SOCKET, codexBin: "codex", config: [], reconnect: true, ...opts };
    const { mode, socketPath, codexBin, config } = this.#opts;

    if (mode === "daemon") {
      const ws = new WsUnixSocket();
      ws.on("message", (line) => this.#onLine(line));
      ws.on("error", (e) => this.#emitError(e));
      ws.on("close", () => this.#onTransportClosed());
      await ws.connect(socketPath);
      this.#transport = ws;
      return this;
    }

    const args = ["app-server"];
    for (const kv of config) args.push("-c", kv);
    this.#proc = spawn(codexBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#proc.stderr.on("data", (b) => this.emit("stderr", b.toString()));
    this.#proc.on("exit", () => this.#onTransportClosed());
    createInterface({ input: this.#proc.stdout }).on("line", (l) => l.trim() && this.#onLine(l));
    this.#transport = {
      send: (text) => this.#proc.stdin.write(text + "\n"),
      close: () => this.#proc.kill(),
    };
    return this;
  }

  /** initialize + the mandatory `initialized` notification. */
  async handshake({ name = "connect", version = "0.1.0", title = "Connect" } = {}) {
    this.#clientInfo = { name, version, title };
    const info = await this.request("initialize", {
      clientInfo: this.#clientInfo,
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    // Only now is reconnect appropriate: before this, a failed handshake would
    // start a backoff loop on a client the caller is about to throw away.
    this.#everConnected = true;
    return info;
  }

  /**
   * EventEmitter throws when "error" is emitted with no listener, which would
   * take the whole MCP server down over a transport blip. Degrade to `stderr`
   * when nobody is listening rather than exiting the process.
   */
  #emitError(e) {
    if (this.listenerCount("error") > 0) this.emit("error", e);
    else this.emit("stderr", `[connect] ${e?.message ?? e}\n`);
  }

  /**
   * Answer a server->client request with the correct refusal for its method.
   * Returns false when the method has no honest refusal, having replied with a
   * JSON-RPC error so the app-server is not left waiting either way.
   */
  declineServerRequest(msg) {
    const reply = SERVER_REQUEST_DECLINES[msg.method];
    if (!reply) {
      this.respondError(msg.id, -32601, `connect cannot service ${msg.method}`);
      return false;
    }
    this.respond(msg.id, reply);
    return true;
  }

  /**
   * The daemon drops every attached client on `daemon restart`,
   * `enable-remote-control` and `disable-remote-control` — measured, and it is
   * also what a Codex auto-update does. Without this, one of those silently
   * kills Connect. Threads are persisted server-side, so reconnecting and
   * re-running `initialize` is enough to carry on.
   */
  async #onTransportClosed() {
    // A socket that never finished its handshake has no dependants to notify
    // and nothing to reconnect for; the caller already got a rejection.
    if (!this.#everConnected) return;
    this.emit("close");
    if (this.#closed || !this.#opts?.reconnect || this.#reconnecting) return;
    this.#reconnecting = true;

    // In-flight requests can never be answered by the dead connection.
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error("connection to the Codex daemon was reset"));
      this.#pending.delete(id);
    }

    const delays = [250, 500, 1000, 2000, 4000, 8000];
    for (const [i, wait] of delays.entries()) {
      await new Promise((r) => setTimeout(r, wait));
      if (this.#closed) return;
      try {
        await this.connect(this.#opts);
        if (this.#clientInfo) await this.handshake(this.#clientInfo);
        this.#reconnecting = false;
        this.emit("reconnect", { attempt: i + 1 });
        return;
      } catch {
        // daemon still coming back up; keep trying
      }
    }
    this.#reconnecting = false;
    this.#emitError(new Error("could not reconnect to the Codex daemon"));
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("stderr", `[unparsed] ${line}\n`);
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result);
      return;
    }
    // Server->client requests (approvals, item/tool/call) MUST be answered or
    // the turn stalls forever.
    if (msg.id !== undefined && msg.method) return this.emit("serverRequest", msg);
    this.emit("notification", msg);
  }

  request(method, params = {}, { timeoutMs = 300_000 } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method, params = {}) {
    this.#transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  respond(id, result) {
    this.#transport.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id, code, message) {
    this.#transport.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, p] of this.#pending) clearTimeout(p.timer);
    this.#pending.clear();
    this.#transport?.close();
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = "", stderr = "";
    p.stdout.on("data", (b) => (stdout += b));
    p.stderr.on("data", (b) => (stderr += b));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim()}`))
    );
  });
}

function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
