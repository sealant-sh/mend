import { describe, expect, it } from "vitest";

import { MendApiError } from "./mend-http.js";
import { RECONNECTS, TtyAttachment, type PtyLiveness, type TtySocket } from "./tty-attachment.js";

/** A socket the test drives: it opens, delivers frames and closes when told. */
class FakeSocket implements TtySocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  closes = 0;
  readonly sent: Array<string | Uint8Array> = [];
  private readonly listeners = new Map<
    string,
    Array<(event: { readonly data: unknown }) => void>
  >();

  addEventListener(type: string, listener: (event: { readonly data: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  private emit(type: string, data: unknown = undefined): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closes += 1;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  output(text: string): void {
    this.emit("message", new TextEncoder().encode(text).buffer);
  }
  drop(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

const deferred = <T>() => {
  const settled: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>((ok) => {
    settled.resolve = ok;
  });
  return { promise, resolve: (value: T) => settled.resolve(value) };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const harness = (
  options: {
    readonly mint?: () => Promise<string>;
    readonly liveness?: () => Promise<PtyLiveness>;
  } = {},
) => {
  const sockets: Array<FakeSocket> = [];
  const written: Array<string> = [];
  const ended: Array<number> = [];
  let mints = 0;
  const attachment = new TtyAttachment({
    connection: async () => ({ url: "http://mend-mini.local:3105", token: "mdt_x" }),
    address: { process: "shell-1" },
    liveness: options.liveness ?? (async () => "live"),
    write: (text) => written.push(text),
    ended: (code) => ended.push(code),
    mint: async () => {
      mints += 1;
      return options.mint === undefined ? `tkt-${mints}` : options.mint();
    },
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    sleep: async () => undefined,
  });
  return { attachment, sockets, written, ended, mints: () => mints };
};

describe("a session terminal's attachment", () => {
  it("attaches with a ticket, writes output, sends keys and the size", async () => {
    const h = harness();
    h.attachment.start({ columns: 120, rows: 30 });
    await settle();
    const socket = h.sockets[0];
    if (socket === undefined) throw new Error("no socket");
    socket.open();
    socket.output("hello");
    h.attachment.input("ls\r");
    expect(h.written.join("")).toContain("hello");
    expect(socket.sent[0]).toBe(JSON.stringify({ t: "resize", cols: 120, rows: 30 }));
    const keys = socket.sent[1];
    expect(keys instanceof Uint8Array ? new TextDecoder().decode(keys) : keys).toBe("ls\r");
  });

  it("closed while its ticket is minted, it opens no socket at all", async () => {
    const ticket = deferred<string>();
    const h = harness({ mint: () => ticket.promise });
    h.attachment.start(null);
    await settle();
    h.attachment.close();
    ticket.resolve("tkt");
    await settle();
    expect(h.sockets).toHaveLength(0);
  });

  it("a socket that opens after the tab closed is closed at once", async () => {
    const h = harness();
    h.attachment.start(null);
    await settle();
    h.attachment.close();
    const socket = h.sockets[0];
    socket?.open();
    expect(socket?.closes).toBeGreaterThan(0);
  });

  it("retries a ticket that failed in transit, under the same budget as a dropped socket", async () => {
    let calls = 0;
    const h = harness({
      mint: async () => {
        calls += 1;
        // The first attachment works; the next mint fails once (the mini waking), then works.
        if (calls === 2)
          throw new MendApiError(
            "Mend at http://mend-mini.local:3105 did not answer within 30 s.",
            null,
          );
        return `tkt-${calls}`;
      },
      liveness: async () => "unknown",
    });
    h.attachment.start(null);
    await settle();
    h.sockets[0]?.open();
    h.sockets[0]?.drop();
    await settle();
    await settle();
    await settle();
    expect(calls).toBe(3);
    expect(h.sockets).toHaveLength(2);
    expect(h.ended).toEqual([]);
  });

  it("stops on a refusal instead of retrying it", async () => {
    const h = harness({
      mint: async () => {
        throw new MendApiError("forbidden", 403);
      },
    });
    h.attachment.start(null);
    await settle();
    expect(h.mints()).toBe(1);
    expect(h.ended).toEqual([1]);
    expect(h.written.join("")).toContain("Mend refused this terminal");
  });

  it("gives up after the budget, and says the process keeps running", async () => {
    const h = harness({ liveness: async () => "unknown" });
    h.attachment.start(null);
    for (let attempt = 0; attempt <= RECONNECTS; attempt += 1) {
      await settle();
      await settle();
      h.sockets.at(-1)?.drop();
    }
    await settle();
    await settle();
    expect(h.ended).toEqual([1]);
    expect(h.written.join("")).toContain("the process keeps running");
  });

  it("ends quietly when the process ended, and when the editor may no longer see it", async () => {
    const ended = harness({ liveness: async () => "ended" });
    ended.attachment.start(null);
    await settle();
    ended.sockets[0]?.drop();
    await settle();
    expect(ended.ended).toEqual([0]);

    // Shared control turned off while the socket was down: no retry, and the reason.
    const unshared = harness({ liveness: async () => "not-steerable" });
    unshared.attachment.start(null);
    await settle();
    unshared.sockets[0]?.drop();
    await settle();
    expect(unshared.ended).toEqual([1]);
    expect(unshared.sockets).toHaveLength(1);
    expect(unshared.mints()).toBe(1);
    expect(unshared.written.join("")).toContain("turned shared control off");
    // It did not look at the process, so it says nothing about whether it runs.
    expect(unshared.written.join("")).not.toContain("keeps running");

    const refused = harness({ liveness: async () => "refused" });
    refused.attachment.start(null);
    await settle();
    refused.sockets[0]?.drop();
    await settle();
    expect(refused.ended).toEqual([1]);
    expect(refused.sockets).toHaveLength(1);
  });
});
