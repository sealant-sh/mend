import { describe, expect, it } from "vitest";

import {
  CLIENT_HANDSHAKE,
  PASSWORD,
  RELAYED_SERVER,
  RELAYED_VIEWER,
  chunkings,
  queueOf,
} from "../../test/rfb-fixtures.ts";
import { ByteQueue } from "./rfb-queue.ts";
import { type SignIn, VncSignIn, vncAuthResponse } from "./rfb-sign-in.ts";

const VERSION = Buffer.from("RFB 003.008\n", "latin1");
const CHALLENGE = RELAYED_SERVER.subarray(14, 30);

const signIn = (...chunks: ReadonlyArray<Uint8Array>): SignIn =>
  new VncSignIn(PASSWORD).read(queueOf(...chunks));

describe("vncAuthResponse", () => {
  it("is DES under the password with each byte's bits reversed (FIPS 81 vector)", () => {
    const key = "\xc8\x2c\xea\x9e\xd9\x3d\xfb\x8f";
    const response = vncAuthResponse(key, Buffer.from("0123456789abcdef0123456789abcdef", "hex"));
    expect(Buffer.from(response).toString("hex")).toBe("85e813540f0ab40585e813540f0ab405");
  });

  it("answers TigerVNC's challenge as noVNC did", () => {
    const answered = RELAYED_VIEWER.subarray(13, 29);
    expect(Buffer.from(vncAuthResponse(PASSWORD, CHALLENGE)).equals(answered)).toBe(true);
  });
});

describe("VncSignIn", () => {
  it("sends noVNC's handshake bytes, which Xvnc accepted, at every chunk boundary", () => {
    const handshake = RELAYED_SERVER.subarray(0, 34);
    for (const chunks of chunkings(handshake)) {
      const reader = new VncSignIn(PASSWORD);
      const queue = new ByteQueue();
      const sent: Uint8Array[] = [];
      let last: SignIn | undefined;
      for (const chunk of chunks) {
        queue.push(chunk);
        last = reader.read(queue);
        if (last._tag !== "Refused") sent.push(...last.send);
      }
      expect(last?._tag).toBe("SignedIn");
      expect(Buffer.concat(sent).equals(RELAYED_VIEWER.subarray(0, CLIENT_HANDSHAKE))).toBe(true);
    }
  });

  it("leaves ServerInit and what follows in the queue", () => {
    const queue = queueOf(RELAYED_SERVER);
    expect(new VncSignIn(PASSWORD).read(queue)._tag).toBe("SignedIn");
    expect(queue.length).toBe(RELAYED_SERVER.length - 34);
  });

  it("refuses an old protocol, a server without VncAuth and a failed password", () => {
    expect(signIn(Buffer.from("RFB 003.003\n", "latin1"))).toEqual({
      _tag: "Refused",
      reason: "protocol-version",
    });
    expect(signIn(VERSION, Uint8Array.of(0, 0, 0, 0, 0))).toEqual({
      _tag: "Refused",
      reason: "server-refused",
    });
    expect(signIn(VERSION, Uint8Array.of(1, 1))).toEqual({
      _tag: "Refused",
      reason: "no-vnc-auth",
    });
    expect(signIn(VERSION, Uint8Array.of(1, 2), CHALLENGE, Uint8Array.of(0, 0, 0, 1))).toEqual({
      _tag: "Refused",
      reason: "auth-failed",
    });
  });
});
