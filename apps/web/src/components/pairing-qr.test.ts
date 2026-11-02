import { PublicOrigin } from "@mend/network";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { countdown, groupCode, pairingPayload, pairingUrls } from "./pairing-qr.ts";

const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const decodeOrigin = Schema.decodeUnknownSync(PublicOrigin);
const pairing = (urls: ReadonlyArray<string>) => ({
  code: "ABCDEFGH",
  expiresAt: "2026-08-22T10:10:00.000Z",
  urls: urls.map((url) => decodeOrigin(url)),
});

describe("pairingUrls", () => {
  it("keeps only the server-configured origins in their preferred order", () => {
    expect(
      pairingUrls(
        pairing([
          "http://mac-mini.local:3105",
          "http://192.168.1.9:3105",
          "http://mac-mini.local:3105",
        ]),
      ),
    ).toEqual(["http://mac-mini.local:3105", "http://192.168.1.9:3105"]);
  });

  it("does not infer a URL from the browser or machine interfaces", () => {
    expect(pairingUrls(pairing([]))).toEqual([]);
  });
});

describe("the QR payload", () => {
  it("encodes the URL and the code the phone reads back", () => {
    expect(pairingPayload("http://100.84.1.2:3105", "ABCDEFGH")).toBe(
      "mend://pair?u=http%3A%2F%2F100.84.1.2%3A3105&c=ABCDEFGH",
    );
    expect(groupCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });

  it("counts down to the expiry and then says nothing", () => {
    expect(countdown("2026-08-22T10:10:00.000Z", at("2026-08-22T10:04:19.000Z"))).toBe("5:41");
    expect(countdown("2026-08-22T10:10:00.000Z", at("2026-08-22T10:10:00.000Z"))).toBeNull();
  });
});
