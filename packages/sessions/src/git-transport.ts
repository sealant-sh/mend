import type { GitTransportKind } from "@mend/domain/workbench";

import { SCRIPT_TRANSPORT_PRELUDE } from "./script-transport.ts";

/**
 * The workspace git transport (docs/GIT-ACCESS.md): plain `git push`/`fetch`
 * inside a session workspace with zero credentials in the container. Git's
 * `core.sshCommand` points at a shim that carries the target (host, port,
 * remote command) and the raw transport bytes over the session socket; the
 * host resolves the project's auth mode, opens the real authenticated ssh
 * connection, and shuttles the pack protocol both ways.
 *
 * Wire shape over one CONNECT tunnel on /run/mend/mend.sock:
 * - shim → host: frames `i` (stdin bytes) and `q` (stdin closed);
 * - host → shim: frames `o` (stdout), `e` (stderr — ssh's own words reach the
 *   workspace terminal), `x` (exit code, one byte, always last).
 * Every frame is 1 type byte + 4 length bytes (BE) + payload. Both sides
 * frame because unix-socket half-close is not dependable through node's HTTP
 * CONNECT plumbing — the tunnel closes only after `x`.
 */

/** What the shim asks the host to open. */
export interface GitTransportRequest {
  readonly host: string;
  readonly port: number | null;
  readonly command: string;
}

/** The host-resolved answer: what to spawn, and the op to close out after. */
export interface GitTransportPlan {
  readonly opId: string;
  readonly kind: GitTransportKind;
  readonly argv: ReadonlyArray<string>;
  /** Extra env for the spawned ssh (bridge mode's SSH_AUTH_SOCK rides here). */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The only remote commands git's ssh transport issues. Anything else is not
 * git talking and is refused host-side — the socket is a git tunnel, not a
 * general ssh capability.
 */
export const parseGitRemoteCommand = (
  command: string,
): { readonly kind: GitTransportKind } | null => {
  const match = /^(?:git[- ])(upload-pack|receive-pack|upload-archive)\s+\S/.exec(command);
  if (match === null) return null;
  const verb = match[1];
  if (verb === "receive-pack") return { kind: "push" };
  if (verb === "upload-archive") return { kind: "archive" };
  return { kind: "fetch" };
};

export const frame = (type: "o" | "e" | "x" | "i" | "q", payload: Buffer): Buffer => {
  const header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};

/** Incremental frame parser; feed raw chunks, get (type, payload) callbacks. */
export const makeFrameFeed = (
  onFrame: (type: string, payload: Buffer) => void,
): ((chunk: Buffer) => void) => {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const size = pending.readUInt32BE(1);
      if (pending.length < 5 + size) return;
      const type = String.fromCharCode(pending[0] ?? 0);
      const payload = pending.subarray(5, 5 + size);
      pending = pending.subarray(5 + size);
      onFrame(type, payload);
    }
  };
};

/** Refspec detail is only worth what it costs — stop looking after this much. */
const SNIFF_LIMIT = 64 * 1024;

/**
 * Cheap refspec detail for pushes: git-receive-pack's client stream opens
 * with pkt-lines of `<old-sha> <new-sha> <ref>` before any pack data, so the
 * first bytes name every ref the push touches. Feed the client stream; once
 * the flush-pkt (`0000`) arrives the commands are complete. Beyond the cap
 * the answer is honestly null, never a guess.
 */
export const makePushSniffer = (): {
  readonly feed: (chunk: Buffer) => void;
  readonly updates: () => ReadonlyArray<string> | null;
} => {
  let pending: Buffer = Buffer.alloc(0);
  let done = false;
  const lines: string[] = [];
  return {
    feed: (chunk) => {
      if (done || pending.length > SNIFF_LIMIT) return;
      pending = Buffer.concat([pending, chunk]);
      let offset = 0;
      while (offset + 4 <= pending.length) {
        const sizeHex = pending.subarray(offset, offset + 4).toString("latin1");
        if (sizeHex === "0000") {
          done = true;
          return;
        }
        const size = Number.parseInt(sizeHex, 16);
        if (!Number.isInteger(size) || size < 5) {
          done = true; // not pkt-lines after all — stop reading, keep what parsed
          return;
        }
        if (offset + size > pending.length) break;
        const raw = pending.subarray(offset + 4, offset + size).toString("utf8");
        const line = (raw.split("\0")[0] ?? "").replace(/\n$/, "");
        if (/^[0-9a-f]{40} [0-9a-f]{40} \S/.test(line)) lines.push(line);
        offset += size;
      }
      pending = pending.subarray(offset);
    },
    updates: () => (lines.length === 0 ? null : lines),
  };
};

/**
 * The in-workspace shim `git` invokes as its ssh. Dependency-free node,
 * staged beside the `mend` helper at /run/mend/bin — versioned with the
 * server routes because they ship together. It parses the ssh-shaped argv
 * git builds (`ssh.variant=ssh`: options, then host, then one command
 * argument), opens the CONNECT tunnel, and pumps until the exit frame.
 */
export const GIT_SSH_SHIM_SCRIPT = `#!/usr/bin/env node
// mend-git-ssh — git's ssh transport, carried over /run/mend/mend.sock (or the
// authenticated session endpoint when this workspace has no socket).
// No credential lives in this workspace: the Mend host authenticates.
${SCRIPT_TRANSPORT_PRELUDE}

// ssh-shaped argv from git: [-4|-6] [-o SendEnv=GIT_PROTOCOL] [-p <port>] host "command"
const args = process.argv.slice(2);
let host = null;
let port = null;
const command = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (host !== null) { command.push(arg); continue; }
  if (arg === "-p" || arg === "-P") { port = args[++i] ?? null; continue; }
  if (arg === "-o" || arg === "-i" || arg === "-F" || arg === "-l" || arg === "-E" || arg === "-e") { i++; continue; }
  if (arg === "--") { host = args[++i] ?? null; continue; }
  if (arg.startsWith("-")) continue;
  host = arg;
}

const fail = (message, code) => {
  process.stderr.write("mend: " + message + "\\n");
  process.exit(code);
};

if (host === null || command.length === 0) {
  fail("mend-git-ssh is git's transport, not a shell — it expects: host git-<verb> '<path>'", 129);
}

const options = transportOptions("CONNECT", "/git/transport", {
  "x-mend-git-host": host,
  "x-mend-git-port": port ?? "",
  "x-mend-git-command": command.join(" "),
  "x-mend-git-protocol": process.env.GIT_PROTOCOL ?? "",
});
if (options === null) {
  fail(transportUnavailable() + " — remote git is unavailable in this workspace right now", 255);
}
const request = transportClient().request(options);

// Node surfaces EVERY response to a CONNECT as this event — refusals included.
request.on("connect", (res, socket) => {
  if (res.statusCode !== 200) {
    socket.destroy();
    const raw = res.headers["x-mend-refusal"];
    let reason = typeof raw === "string" ? raw : "";
    // Percent-encoded server-side: headers are latin-1, the words are not.
    try { reason = decodeURIComponent(reason); } catch {}
    fail(
      reason !== "" ? reason : "the git transport was refused (" + res.statusCode + ")",
      128,
    );
  }
  let exitCode = null;
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const size = pending.readUInt32BE(1);
      if (pending.length < 5 + size) return;
      const type = pending[0];
      const payload = pending.subarray(5, 5 + size);
      pending = pending.subarray(5 + size);
      if (type === 0x6f) process.stdout.write(payload);      // o
      else if (type === 0x65) process.stderr.write(payload); // e
      else if (type === 0x78) exitCode = payload[0] ?? 255;  // x
    }
  });
  process.stdin.on("data", (chunk) => {
    const header = Buffer.alloc(5);
    header[0] = 0x69; // i
    header.writeUInt32BE(chunk.length, 1);
    socket.write(Buffer.concat([header, chunk]));
  });
  process.stdin.on("end", () => {
    socket.write(Buffer.from([0x71, 0, 0, 0, 0])); // q
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    const code = exitCode === null ? 255 : exitCode;
    if (exitCode === null) process.stderr.write("mend: the git transport closed unexpectedly\\n");
    // Never truncate a pack: let stdout drain before exiting.
    if (process.stdout.writableLength === 0) process.exit(code);
    else process.stdout.once("drain", () => process.exit(code));
  });
});

request.on("error", () => {
  fail(transportDownMessage() + " — remote git is unavailable in this workspace right now", 255);
});

request.end();
`;
