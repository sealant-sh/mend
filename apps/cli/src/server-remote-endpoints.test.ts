import * as FastCheck from "fast-check";
import { describe, expect, it } from "vitest";

import { parseRemoteEndpoints } from "./server-remote-endpoints.ts";
import { flagsFor, sameSettings } from "./server-setup-guide.ts";
import { resolveSetupSettings } from "./server-setup.ts";

const valid = {
  sessionUrl: "https://mend.example.com:8443",
  blobUrl: "https://mend.example.com:10000",
  sessionPort: 13106,
  blobPort: 13900,
};

describe("remote endpoint settings", () => {
  it.each([
    null,
    {},
    { ...valid, sessionPort: 0 },
    { ...valid, blobPort: 65536 },
    { ...valid, blobPort: 1.5 },
    { ...valid, blobPort: "13900" },
    { ...valid, blobPort: 13106 },
    { ...valid, blobUrl: valid.sessionUrl },
  ])("refuses incomplete or ambiguous settings: %j", (input) => {
    expect(parseRemoteEndpoints(input)).toMatchObject({ _tag: "error" });
  });

  it.each([
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/channel",
    "https://example.com?q=1",
    "https://example.com#fragment",
    "https://example.com/\\channel",
    "https://example.com.:",
    "https://example.com\n",
    "https://$HOST",
    "not a URL",
  ])("refuses a channel origin that cannot be advertised: %s", (sessionUrl) => {
    expect(parseRemoteEndpoints({ ...valid, sessionUrl })).toMatchObject({ _tag: "error" });
  });

  it("round-trips generated ports and canonical HTTPS origins through the setup flags", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 42000, max: 49998 }),
        FastCheck.nat({ max: 100000 }),
        (port, label) => {
          const input = {
            sessionUrl: `https://CHANNEL-${label}.example.com/`,
            blobUrl: `https://bucket-${label}.example.com/`,
            sessionPort: port,
            blobPort: port + 1,
          };
          const parsed = parseRemoteEndpoints(input);
          expect(parsed._tag).toBe("ok");
          if (parsed._tag === "error") return;
          expect(parseRemoteEndpoints(parsed.value)).toEqual(parsed);
          const before = resolveSetupSettings(null, []);
          const after = { ...before, remoteEndpoints: parsed.value };
          expect(sameSettings(resolveSetupSettings(null, flagsFor(before, after)), after)).toBe(
            true,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
