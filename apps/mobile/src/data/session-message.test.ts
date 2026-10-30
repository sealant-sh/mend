import { describe, expect, it, vi } from "vitest";

import { pairingKeyOf } from "@/data/pairing-key";

vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));

const PAIRING = pairingKeyOf({ url: "https://a.example", token: "token-a" });
const WORDS = "rotate the payroll keys";
const KEY = "0b8f4c2e-7d1a-4e5b-9c3f-2a6d8e1f4b7c";
const IMAGE = { name: "shot.jpg", path: "/workspace/.mend/images/1.jpg", uri: "file:///shot.jpg" };

describe("a message draft", () => {
  it("comes back with its images and key after the app restarts", async () => {
    const before = await import("./session-message");
    await before.settleDraftScope(PAIRING);
    expect(
      await before.setSessionMessage(PAIRING, "session-1", {
        draft: { text: WORDS, images: [IMAGE], clientMessageId: KEY },
      }),
    ).toBe(true);

    vi.resetModules();
    const after = await import("./session-message");
    await after.settleDraftScope(PAIRING);
    expect(after.sessionMessage(PAIRING, "session-1")).toEqual({
      draft: { text: WORDS, images: [IMAGE], clientMessageId: KEY },
      outcome: { _tag: "Idle" },
    });
  });
});
