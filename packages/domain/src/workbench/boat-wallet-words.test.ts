import { describe, expect, it } from "vitest";

import {
  boatKeyReportFixture,
  boatUnreachableFixture,
  oneWalletReportFixture,
  organizationKeyReportFixture,
  threeWalletsReportFixture,
  walletChangedReportFixture,
} from "./boat-key-fixtures.ts";
import { boatKeyFacts, boatKeyWarnings } from "./boat-key-words.ts";
import {
  boatWalletChoices,
  hasUnreachable,
  unreachableWords,
  walletWarnings,
} from "./boat-wallet-words.ts";

const NOW = new Date("2026-11-13T14:02:00.000Z");

const fact = (report: ReturnType<typeof boatKeyReportFixture>, label: string, own = false) =>
  boatKeyFacts(report, NOW, own ? "own" : "other").find((row) => row.label === label);

describe("which wallet a Boat key bills (SLNT-821)", () => {
  it("says a Boat organization's key bills its organization, fixed, with nothing to choose", () => {
    const report = organizationKeyReportFixture(NOW);
    expect(fact(report, "Bills")?.value).toBe(
      "the Boat organization acme-boat · the key's role there: admin · fixed: a Boat organization's key bills only its own organization",
    );
    expect(fact(report, "Can bill")).toBeUndefined();
    expect(boatWalletChoices(report, "other")).toBeNull();
  });

  it("names a person's own account as theirs, and offers no choice with one wallet", () => {
    const report = oneWalletReportFixture(NOW);
    expect(fact(report, "Bills", true)?.value).toBe(
      "your personal Boat account · fixed: sealant names it on every request",
    );
    expect(fact(report, "Bills")?.value).toBe(
      "the personal Boat account of @acme-ci · fixed: sealant names it on every request",
    );
    expect(fact(report, "Can bill", true)?.value).toBe(
      "your personal Boat account · active in Boat now",
    );
    expect(boatWalletChoices(report, "own")).toBeNull();
  });

  it("lists every wallet a personal key can bill, with the one it bills now chosen", () => {
    const report = threeWalletsReportFixture(NOW);
    expect(fact(report, "Can bill", true)?.value).toBe(
      "your personal Boat account; the Boat organization acme-boat (admin); the Boat organization beta-labs (member) · active in Boat now",
    );
    expect(boatWalletChoices(report, "own")).toEqual({
      current: "org_9",
      pinned: true,
      options: [
        { id: "personal", label: "your personal Boat account", detail: null },
        { id: "org_9", label: "the Boat organization acme-boat", detail: "your role: admin" },
        {
          id: "org_12",
          label: "the Boat organization beta-labs",
          detail: "your role: member · active in Boat now",
        },
      ],
    });
    // Pinned: nothing to warn about, whatever Boat has active.
    expect(walletWarnings(report, "own")).toEqual([]);
  });

  it("says the bill moved when a key sealant has not pinned followed its active wallet", () => {
    const report = walletChangedReportFixture(NOW);
    const bills = fact(report, "Bills");
    expect(bills?.value).toBe(
      "the Boat organization acme-boat · the key's role there: admin · not fixed: it follows the active wallet of the key's Boat account",
    );
    expect(bills?.tone).toBe("bad");
    // Choosing pins a key sealant has not pinned, even to the wallet it bills now.
    expect(boatWalletChoices(report, "other")).toMatchObject({ current: "org_9", pinned: false });
    const [moved] = boatKeyWarnings(report, NOW, "Replace it.", "own");
    expect(moved).toEqual({
      tone: "bad",
      text: expect.stringMatching(
        /^The bill moved: this key billed your personal Boat account until the active wallet of its Boat account changed, observed 2026-11-13 09:30 UTC, and bills the Boat organization acme-boat now\. sealant pins/,
      ),
    });
  });

  it("says a key not pinned yet follows its active wallet, and that nothing new starts until it is", () => {
    const report = boatKeyReportFixture(
      { billing: { mode: "active-wallet", walletChanged: null } },
      NOW,
    );
    expect(walletWarnings(report, "other")).toEqual([
      {
        tone: "wait",
        text: expect.stringContaining(
          "This key is not pinned to a wallet yet: it bills whichever wallet its Boat account has active in Boat.",
        ),
      },
    ]);
  });

  it("reads a report from before sealant said which wallet as it did before", () => {
    const report = boatKeyReportFixture({ wallets: null, billing: null }, NOW);
    expect(fact(report, "Bills")?.value).toBe(
      "the Boat organization acme-boat · the key's role there: admin",
    );
    expect(fact(report, "Can bill")).toBeUndefined();
    expect(walletWarnings(report, "other")).toEqual([]);
  });

  it("says why the wallets are not listed when Boat did not show them", () => {
    const report = boatKeyReportFixture(
      { wallets: { observed: false, reason: "no-answer", boat: null } },
      NOW,
    );
    expect(fact(report, "Can bill")).toEqual({
      label: "Can bill",
      value: "not observed · Boat did not answer",
      tone: "off",
    });
    expect(boatWalletChoices(report, "own")).toBeNull();
  });
});

describe("what Boat holds that sealant cannot reach", () => {
  it("names saved images as Boat lists them, counts the rest, and says what to do for each holder", () => {
    expect(hasUnreachable(boatUnreachableFixture)).toBe(true);
    expect(hasUnreachable({ savedImages: [], runs: [], builds: [] })).toBe(false);
    expect(hasUnreachable(null)).toBe(false);
    const words = unreachableWords(boatUnreachableFixture, "organization");
    expect(words).toBe(
      "sealant could not find the saved images sealant-img-a1b2 and sealant-img-c3d4 (Saved snapshots in Boat), the VM of an ended session and what an image build left in any wallet this key can bill: they were made before sealant recorded wallets, and were since deleted in Boat or are in a Boat organization the key's account has left. sealant keeps them on record and never uses or removes them; while Boat still holds them they cost money or keep a saved snapshot slot. Remove them in Boat, or replace the organization's key with one whose Boat account can see them.",
    );
    expect(unreachableWords(boatUnreachableFixture, "server")).toContain(
      "give this server a key whose Boat account can see them",
    );
    expect(unreachableWords(boatUnreachableFixture, "person")).toContain("replace your key");
  });
});
