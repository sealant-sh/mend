import { createHmac, timingSafeEqual } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";

interface Peer {
  readonly socket: Socket;
  readonly password: string;
  readonly port: number;
  remote: { readonly address: string; readonly port: number } | null;
}

const addressKey = (address: string, port: number) => `${address}:${port}`;
const bind = (socket: Socket, port: number, address: string): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, address, () => {
      socket.off("error", reject);
      resolve();
    });
  });

/**
 * Werift 0.25 has per-peer sockets, no UDP mux. One public socket routes authenticated STUN
 * usernames and then DTLS/SRTP/SCTP to private loopback peers. ICE-lite keeps their replies on
 * this path. No SO_REUSEPORT hashing, port range, public per-peer ports, or TURN is involved.
 */
export class ScreenRtcUdp {
  readonly #socket = createSocket("udp4");
  readonly #peers = new Map<string, Peer>();
  readonly #remotes = new Map<string, Peer>();
  #ready: Promise<void> | null = null;

  constructor(
    readonly port: number,
    readonly host: string,
  ) {
    this.#socket.on("error", () => {});
    this.#socket.on("message", (data, from) => this.#receive(data, from));
  }

  #receive(data: Buffer, from: RemoteInfo): void {
    const key = addressKey(from.address, from.port);
    let peer = this.#remotes.get(key);
    if (data.length >= 20 && data.readUInt32BE(4) === 0x2112a442 && data.readUInt16BE(0) === 1) {
      // A USERNAME alone is public. Authenticate MESSAGE-INTEGRITY before remembering a tuple.
      let username = "";
      peer = undefined;
      const end = Math.min(data.length, 20 + data.readUInt16BE(2));
      for (let offset = 20; offset + 4 <= end; ) {
        const type = data.readUInt16BE(offset);
        const size = data.readUInt16BE(offset + 2);
        if (offset + 4 + size > end) return;
        if (type === 6) username = data.subarray(offset + 4, offset + 4 + size).toString();
        if (type === 8 && size === 20) {
          const candidate = this.#peers.get(username.split(":")[0] ?? "");
          if (candidate === undefined) return;
          const signed = Buffer.from(data.subarray(0, offset));
          signed.writeUInt16BE(offset + 24 - 20, 2);
          const digest = createHmac("sha1", candidate.password).update(signed).digest();
          if (!timingSafeEqual(digest, data.subarray(offset + 4, offset + 24))) return;
          peer = candidate;
          break;
        }
        offset += 4 + ((size + 3) & ~3);
      }
      if (peer === undefined) return;
      if (peer.remote !== null)
        this.#remotes.delete(addressKey(peer.remote.address, peer.remote.port));
      peer.remote = { address: from.address, port: from.port };
      this.#remotes.set(key, peer);
    }
    if (peer !== undefined) peer.socket.send(data, peer.port, "127.0.0.1", () => {});
  }

  /** Gathers one public candidate; removing it releases every per-peer socket and tuple. */
  async register(sdp: string): Promise<{ readonly sdp: string; readonly close: () => void }> {
    this.#ready ??= bind(this.#socket, this.port, "0.0.0.0").catch((error: unknown) => {
      this.#ready = null;
      throw error;
    });
    await this.#ready;
    const address = (await lookup(this.host, { family: 4 })).address;
    const ufrag = /^a=ice-ufrag:(.+)\r?$/m.exec(sdp)?.[1]?.trim();
    const password = /^a=ice-pwd:(.+)\r?$/m.exec(sdp)?.[1]?.trim();
    const candidate = /^a=candidate:.*? 1 udp \d+ \S+ (\d+) typ host.*$/im.exec(sdp);
    if (ufrag === undefined || password === undefined || candidate === null) {
      throw new Error("screen RTC gathered no UDP host candidate");
    }
    const socket = createSocket("udp4");
    socket.on("error", () => {});
    await bind(socket, 0, "127.0.0.1");
    const peer: Peer = { socket, password, port: Number(candidate[1]), remote: null };
    socket.on("message", (data, from) => {
      if (from.address !== "127.0.0.1" || from.port !== peer.port || peer.remote === null) return;
      this.#socket.send(data, peer.remote.port, peer.remote.address, () => {});
    });
    this.#peers.set(ufrag, peer);
    return {
      sdp: sdp
        .replace(/^a=candidate:.*\r?\n/gm, "")
        .replace(/^a=end-of-candidates\r?\n/gm, "")
        .replace(
          /^(a=ice-ufrag:.*\r?\n)/gm,
          `a=candidate:1 1 udp 2130706431 ${address} ${this.port} typ host\r\na=end-of-candidates\r\n$1`,
        ),
      close: () => {
        this.#peers.delete(ufrag);
        if (peer.remote !== null)
          this.#remotes.delete(addressKey(peer.remote.address, peer.remote.port));
        socket.close();
      },
    };
  }

  /** Ends the API's public listener at shutdown, after its peers have closed. */
  close(): void {
    for (const peer of this.#peers.values()) peer.socket.close();
    this.#peers.clear();
    this.#remotes.clear();
    if (this.#ready !== null) this.#socket.close();
  }
}
