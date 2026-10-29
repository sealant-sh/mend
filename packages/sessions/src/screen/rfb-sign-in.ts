import { createCipheriv } from "node:crypto";

import { type ByteQueue, view } from "./rfb-queue.ts";

const VNC_AUTH = 2;

export type SignInRefusal = "protocol-version" | "server-refused" | "no-vnc-auth" | "auth-failed";

export type SignIn =
  | { readonly _tag: "Pending" | "SignedIn"; readonly send: ReadonlyArray<Uint8Array> }
  | { readonly _tag: "Refused"; readonly reason: SignInRefusal };

const reverseBits = (byte: number): number => {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit++) reversed |= ((byte >> bit) & 1) << (7 - bit);
  return reversed;
};

/** RFC 6143 §7.2.2. Node has no single DES, so DES-EDE3 with one key three times stands in. */
export const vncAuthResponse = (password: string, challenge: Uint8Array): Uint8Array => {
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1")
    .subarray(0, 8)
    .forEach((byte, index) => key.writeUInt8(reverseBits(byte), index));
  const cipher = createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
};

/** The client side of the RFB 3.8 handshake with VncAuth, up to and including ClientInit (shared). */
export class VncSignIn {
  private step: "version" | "security" | "challenge" | "result" = "version";

  private readonly password: string;

  constructor(password: string) {
    this.password = password;
  }

  private outcome: SignIn | undefined;

  /** Pending until signed in or refused; either outcome then stays, with nothing more to send. */
  read(queue: ByteQueue): SignIn {
    if (this.outcome !== undefined) return this.outcome;
    const result = this.advance(queue);
    if (result._tag === "Refused") this.outcome = result;
    if (result._tag === "SignedIn") this.outcome = { _tag: "SignedIn", send: [] };
    return result;
  }

  private advance(queue: ByteQueue): SignIn {
    const send: Uint8Array[] = [];
    for (;;) {
      switch (this.step) {
        case "version": {
          if (queue.length < 12) return { _tag: "Pending", send };
          const version = Buffer.from(queue.take(12)).toString("latin1");
          const minor = /^RFB 003\.(\d{3})\n$/.exec(version)?.[1];
          if (minor === undefined || Number(minor) < 8) {
            return { _tag: "Refused", reason: "protocol-version" };
          }
          send.push(Buffer.from("RFB 003.008\n", "latin1"));
          this.step = "security";
          break;
        }
        case "security": {
          const count = queue.length < 1 ? undefined : (queue.peek(1)[0] ?? 0);
          if (count === undefined || queue.length < 1 + count) return { _tag: "Pending", send };
          if (count === 0) return { _tag: "Refused", reason: "server-refused" };
          const offered = queue.take(1 + count).subarray(1);
          if (!offered.includes(VNC_AUTH)) {
            return { _tag: "Refused", reason: "no-vnc-auth" };
          }
          send.push(Uint8Array.of(VNC_AUTH));
          this.step = "challenge";
          break;
        }
        case "challenge":
          if (queue.length < 16) return { _tag: "Pending", send };
          send.push(vncAuthResponse(this.password, queue.take(16)));
          this.step = "result";
          break;
        case "result":
          if (queue.length < 4) return { _tag: "Pending", send };
          if (view(queue.take(4)).getUint32(0) !== 0) {
            return { _tag: "Refused", reason: "auth-failed" };
          }
          return { _tag: "SignedIn", send: [...send, Uint8Array.of(1)] };
      }
    }
  }
}
