/**
 * Minimal RFC 6455 client over a Unix domain socket. No dependencies.
 *
 * The Codex managed daemon exposes its app-server at
 * ~/.codex/app-server-control/app-server-control.sock and speaks WebSocket
 * there, not raw JSONL. `codex app-server proxy` is only a dumb byte pipe, so
 * the handshake is the client's job either way — we skip the subprocess and
 * connect to the socket directly.
 *
 * Only what an app-server client needs: text frames, continuation frames,
 * ping/pong, close. No permessage-deflate, no binary payloads.
 */
import net from "node:net";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** Ceiling on a whole message, however many frames it arrives in. */
const MAX_MESSAGE = 64 * 1024 * 1024;

export class WsUnixSocket extends EventEmitter {
  #sock = null;
  #buf = Buffer.alloc(0);
  #open = false;
  #fragOp = null;
  #frag = [];
  #fragLen = 0;

  connect(socketPath, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const expect = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      const timer = setTimeout(() => {
        this.#sock?.destroy();
        reject(new Error(`websocket handshake timed out on ${socketPath}`));
      }, timeoutMs);

      this.#sock = net.connect(socketPath);
      this.#sock.on("error", (e) => {
        clearTimeout(timer);
        this.#open ? this.emit("error", e) : reject(e);
      });
      this.#sock.on("close", () => {
        this.#open = false;
        this.emit("close");
      });

      const onHandshake = (chunk) => {
        this.#buf = Buffer.concat([this.#buf, chunk]);
        const end = this.#buf.indexOf("\r\n\r\n");
        if (end === -1) return; // headers still arriving
        const head = this.#buf.subarray(0, end).toString("latin1");
        this.#buf = this.#buf.subarray(end + 4);
        clearTimeout(timer);
        this.#sock.off("data", onHandshake);

        if (!/^HTTP\/1\.1 101/i.test(head)) {
          this.#sock.destroy();
          return reject(new Error(`websocket upgrade refused: ${head.split("\r\n")[0]}`));
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
        if (accept !== expect) {
          this.#sock.destroy();
          return reject(new Error("websocket Sec-WebSocket-Accept mismatch"));
        }

        this.#open = true;
        this.#sock.on("data", (d) => {
          this.#buf = Buffer.concat([this.#buf, d]);
          this.#drain();
        });
        this.#drain(); // headers and first frame can share a packet
        resolve(this);
      };

      this.#sock.on("connect", () => {
        this.#sock.write(
          "GET / HTTP/1.1\r\n" +
            "Host: localhost\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n"
        );
      });
      this.#sock.on("data", onHandshake);
    });
  }

  /** Parse as many whole frames as the buffer holds. */
  #drain() {
    for (;;) {
      const b = this.#buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;

      // RFC 6455 §5.2: no extension was negotiated, so any reserved bit set
      // means we are out of sync with the stream and cannot trust what follows.
      if (rsv !== 0) return this.#fail("websocket reserved bits set");
      // §5.1: a server MUST NOT mask. Accepting one silently would hide a
      // desynchronised parse behind plausible-looking output.
      if (masked) return this.#fail("websocket server frame is masked");
      // §5.5: control frames carry <=125 bytes and are never fragmented.
      if (opcode >= 0x8 && (!fin || len > 125)) return this.#fail(`invalid control frame (opcode ${opcode})`);

      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        const big = b.readBigUInt64BE(off);
        if (big > 0x7fffffffn) {
          this.emit("error", new Error("websocket frame too large"));
          return this.close();
        }
        len = Number(big);
        off += 8;
      }

      if (b.length < off + len) return; // frame incomplete

      const payload = b.subarray(off, off + len);
      this.#buf = b.subarray(off + len);

      switch (opcode) {
        case OP.PING:
          this.#frame(OP.PONG, payload);
          break;
        case OP.PONG:
          break;
        case OP.CLOSE:
          this.#frame(OP.CLOSE, payload);
          this.#sock.end();
          return;
        case OP.CONT:
          if (this.#fragOp === null) return this.#fail("continuation frame with nothing to continue");
          this.#frag.push(payload);
          this.#fragLen += payload.length;
          // The per-frame cap says nothing about a message split across many
          // frames; without this a fragmented stream can grow without bound.
          if (this.#fragLen > MAX_MESSAGE) return this.#fail("websocket message too large");
          if (fin) this.#emitMessage();
          break;
        case OP.TEXT:
        case OP.BIN:
          if (this.#fragOp !== null) return this.#fail("new data frame while a message was still fragmented");
          if (fin) {
            if (opcode === OP.TEXT) this.emit("message", payload.toString("utf8"));
          } else {
            this.#fragOp = opcode;
            this.#frag = [payload];
            this.#fragLen = payload.length;
          }
          break;
        default:
          // Silently ignoring an unknown opcode means carrying on against a
          // peer we demonstrably do not understand.
          return this.#fail(`unknown websocket opcode ${opcode}`);
      }
    }
  }

  #emitMessage() {
    const full = Buffer.concat(this.#frag);
    if (this.#fragOp === OP.TEXT) this.emit("message", full.toString("utf8"));
    this.#frag = [];
    this.#fragLen = 0;
    this.#fragOp = null;
  }

  /** A protocol violation we cannot parse past: report it and close. */
  #fail(message) {
    this.emit("error", new Error(message));
    this.close();
  }

  send(text) {
    if (!this.#open) throw new Error("websocket is not open");
    this.#frame(OP.TEXT, Buffer.from(text, "utf8"));
  }

  /** Client frames are always masked, per spec. */
  #frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.#sock.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    if (this.#open) this.#frame(OP.CLOSE, Buffer.alloc(0));
    this.#open = false;
    this.#sock?.end();
  }
}
