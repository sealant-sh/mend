import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BOAT_KEY_ACCOUNT_REFUSALS,
  BOAT_LAUNCH_REFUSAL_CODES,
  type BoatKeyHolder,
  type BoatWordsContext,
  type BoatWordsPlace,
  boatFailureLogLine,
  boatKeyAccountWords,
  boatProblemText,
  boatProblemWords,
} from "./boat-failure-words.ts";
import { BOAT_FAILURE_KINDS, type BoatFailure, type BoatFailureKind } from "./boat-failure.ts";

const HOLDERS: ReadonlyArray<BoatKeyHolder> = ["organization", "server", "person"];
const PLACES: ReadonlyArray<BoatWordsPlace> = ["launch", "key-check", "status"];

/** What Boat may send, with everything that must never reach a sentence planted in it. */
const failureOf = (kind: BoatFailureKind, overrides: Partial<BoatFailure> = {}): BoatFailure => ({
  kind,
  retryable: kind === "rate-limited" || kind === "no-machine" || kind === "no-answer",
  operation: "create",
  status: 403,
  code: "api_secret_code_xyz",
  message: "Key boat_live_PLANTED0123456789 refused by http://10.0.0.7:8080/internal",
  requestId: "req_PLANTED42",
  permission: kind === "permission-missing" ? "sandbox.create" : null,
  retryAfterSeconds: null,
  retryAt: null,
  billingUrl: null,
  ...overrides,
});

const FORBIDDEN = [
  "api_secret_code_xyz",
  "req_PLANTED42",
  "boat_live",
  "10.0.0.7",
  "http://",
  "/internal",
];

describe("the words for every Boat failure", () => {
  for (const kind of BOAT_FAILURE_KINDS) {
    for (const holder of HOLDERS) {
      for (const place of PLACES) {
        it(`${kind} · ${holder}'s key · ${place}`, () => {
          const context: BoatWordsContext = { holder, place };
          const words = boatProblemWords({ kind, failure: failureOf(kind) }, context);
          for (const line of [words.happened, words.todo]) {
            expect(line).not.toContain("\n");
            expect(line).toMatch(/^[A-Z].*\.$/);
            for (const secret of FORBIDDEN) expect(line).not.toContain(secret);
          }
          // The first line stands alone: it says what happened and what it stopped.
          expect(words.happened).toMatch(
            place === "launch"
              ? /this session's (VM|image)/
              : place === "status"
                ? /new Boat sessions cannot start with it/
                : /nothing changed/,
          );
          expect(words.todo.length).toBeGreaterThan(20);
        });
      }
    }
  }

  it("says who fixes a key problem by whose key it was", () => {
    const expired = { kind: "key-expired" as const, failure: failureOf("key-expired") };
    expect(boatProblemText(expired, { holder: "organization", place: "launch" })).toBe(
      [
        "The organization's Boat key has expired, so Boat refused it and this session's VM did not start.",
        "An owner of this organization creates a new key using the command in Settings, Organization, Boat and replaces the key there. Then start the session again. Boat keys last 90 days unless made to last longer; the command on the Boat page makes one that lasts a year.",
      ].join("\n"),
    );
    expect(boatProblemText(expired, { holder: "server", place: "launch" })).toBe(
      [
        "This server's Boat key has expired, so Boat refused it and this session's VM did not start.",
        "The person who runs this Mend server gives it a new key with mend server setup --boat-api-key-stdin. An owner of this organization can instead connect the organization's own key in Settings, Organization, Boat. Then start the session again. Boat keys last 90 days unless made to last longer; the command on the Boat page makes one that lasts a year.",
      ].join("\n"),
    );
    expect(boatProblemText(expired, { holder: "organization", place: "key-check" })).toBe(
      [
        "This Boat key has expired, so Boat refused it and nothing changed.",
        "Create a new key using the command on Mend's Boat page (Settings, Organization, Boat) and connect that one. Boat keys last 90 days unless made to last longer; the command on the Boat page makes one that lasts a year.",
      ].join("\n"),
    );
    expect(boatProblemText(expired, { holder: "server", place: "status" })).toBe(
      [
        "This server's Boat key has expired, so Boat refused it and new Boat sessions cannot start with it.",
        "The person who runs this Mend server gives it a new key with mend server setup --boat-api-key-stdin, or drops its key with --no-boat-api-key so each organization connects its own. Boat keys last 90 days unless made to last longer; the command on the Boat page makes one that lasts a year.",
      ].join("\n"),
    );
  });

  it("names a person's own key as its owner's, and tells only its owner what to do", () => {
    const expired = { kind: "key-expired" as const, failure: failureOf("key-expired") };
    expect(boatProblemText(expired, { holder: "person", place: "launch" })).toBe(
      [
        "The session owner's own Boat key has expired, so Boat refused it and this session's VM did not start.",
        "The session's owner creates a new key using the command in Settings, Account and replaces their key there, or with mend boat connect --mine. Then they start the session again. Boat keys last 90 days unless made to last longer; the command on the Boat page makes one that lasts a year.",
      ].join("\n"),
    );
    expect(boatProblemText(expired, { holder: "person", place: "key-check" })).toContain(
      "Create a new key using the command in Settings, Account and connect that one there, or with mend boat connect --mine.",
    );
    for (const kind of BOAT_FAILURE_KINDS) {
      const words = boatProblemWords(
        { kind, failure: failureOf(kind) },
        { holder: "person", place: "launch" },
      );
      const text = `${words.happened} ${words.todo}`;
      // Nobody but the session's owner is sent to change a key or an organization's settings.
      expect(text).not.toMatch(/An owner of this organization|Settings, Organization/);
      if (/key|account|wallet|organization that/i.test(words.happened) && kind !== "refused")
        expect(text).toMatch(/session owner's own Boat key/);
    }
  });

  it("names the permission, Boat's billing link, and when to retry when Boat gave them", () => {
    const launch: BoatWordsContext = { holder: "organization", place: "launch" };
    expect(
      boatProblemWords(
        { kind: "permission-missing", failure: failureOf("permission-missing") },
        launch,
      ).happened,
    ).toContain("lacks the Boat permission sandbox.create");
    expect(
      boatProblemWords(
        {
          kind: "billing-required",
          failure: failureOf("billing-required", { billingUrl: "https://boat.dev/billing" }),
        },
        launch,
      ).todo,
    ).toContain("pays or tops it up at https://boat.dev/billing");
    expect(
      boatProblemWords(
        {
          kind: "rate-limited",
          failure: failureOf("rate-limited", { retryAt: new Date("2026-11-13T14:05:00Z") }),
        },
        launch,
      ).todo,
    ).toBe(
      "Start the session again after 14:05 UTC, when Boat said it allows the next start. Nothing needs changing.",
    );
    expect(
      boatProblemWords(
        { kind: "no-machine", failure: failureOf("no-machine", { retryAfterSeconds: 120 }) },
        launch,
      ).todo,
    ).toBe("Start the session again in about 2 minutes, as Boat asked. Nothing needs changing.");
  });

  it("says an image that could not be saved, not a VM that did not start, for a snapshot call", () => {
    expect(
      boatProblemWords(
        {
          kind: "snapshot-allowance-full",
          failure: failureOf("snapshot-allowance-full", { operation: "saveSnapshot" }),
        },
        { holder: "organization", place: "launch" },
      ).happened,
    ).toContain("so this session's image could not be saved");
  });

  it("keeps Boat's code and request id for the log line only", () => {
    expect(boatFailureLogLine(failureOf("key-expired"))).toBe(
      "boat refused · key-expired · api_secret_code_xyz · request req_PLANTED42 · create · 403",
    );
  });
});

describe("the words for sealant's refusals before anything ran", () => {
  for (const kind of BOAT_LAUNCH_REFUSAL_CODES) {
    for (const holder of HOLDERS) {
      it(`${kind} · ${holder}'s key`, () => {
        const words = boatProblemWords(
          { kind, coreMessage: "Boat supports Ubuntu and Nix; Arch is unsupported." },
          { holder, place: "launch" },
        );
        expect(words.happened).toMatch(/^[A-Z].*\.$/);
        expect(words.todo).toMatch(/^[A-Z].*\.$/);
      });
    }
  }

  it("names the session owner's own key, not the organization's, when nothing starts Boat VMs", () => {
    const words = boatProblemWords(
      { kind: "unsupported-runtime", coreMessage: "no worker" },
      { holder: "person", place: "launch" },
    );
    expect(words.happened).toBe(
      "The session owner's own Boat key is connected, and Sealant says nothing on this server starts Boat VMs right now, so nothing was started.",
    );
  });
});

describe("a key sealant has not pinned to a wallet yet (sealant#641)", () => {
  const SEALANT_SENTENCE =
    "The Boat account this workspace names was connected before sealant pinned accounts to a Boat wallet, and sealant has not seen yet which wallet its key bills.";

  it("refuses a launch, says running sessions go on, and names the one remedy for a key without account.read", () => {
    const words = boatProblemWords(
      { kind: "boat-account-wallet-unresolved", coreMessage: SEALANT_SENTENCE },
      { holder: "organization", place: "launch" },
    );
    expect(words.happened).toBe(
      "The Boat wallet the organization's Boat key bills is not known to sealant yet, so nothing was started. sealant looks at a key connected before this server's upgrade within about a minute of it; sessions already running on the key are not affected.",
    );
    expect(words.todo).toBe(
      "Start the session again in a minute. If it is refused again, the key lacks Boat's account.read permission, which Boat never adds to an existing key: an owner of this organization creates a key with every permission Mend needs using the command in Settings, Organization, Boat and replaces the key there. Then start the session again.",
    );
    const own = boatProblemText(
      { kind: "boat-account-wallet-unresolved", coreMessage: SEALANT_SENTENCE },
      { holder: "person", place: "launch" },
    );
    expect(own).toContain("the session owner's own Boat key");
    expect(own).toContain("mend boat connect --mine");
  });

  it("reads a launch refusal, not a failure", () => {
    expect(BOAT_LAUNCH_REFUSAL_CODES).toContain("boat-account-wallet-unresolved");
  });

  it("refuses a full check with sealant's own sentence after Mend's, since nothing else tells its causes apart", () => {
    const message =
      "sealant has not pinned Boat account 7c0b… to a Boat wallet yet, so nothing new is started with its key; nothing was changed.";
    const words = boatKeyAccountWords("unpinned", message, {
      holder: "organization",
      place: "full-check",
    });
    expect(words.happened).toBe(
      `No full check of this key was started, so nothing was made in Boat. sealant says: ${message.replace(/\.$/, "")}.`,
    );
    expect(words.todo).toContain(
      "within about a minute of the upgrade; run the full check again then",
    );
    expect(words.todo).toContain("Boat never adds a permission to an existing key");
    expect(words.todo).toContain("Settings, Organization, Boat");
  });

  it("says an organization's key has no wallet to choose, and that the server's own key is set at setup", () => {
    const organization = boatKeyAccountWords("key-organization", "", {
      holder: "person",
      place: "key-check",
    });
    expect(organization.happened).toBe(
      "This Boat key is a Boat organization's key: it bills that Boat organization and nothing else, and has no wallet to choose. Nothing changed.",
    );
    expect(organization.todo).toContain("mend boat connect --mine");
    const environment = boatKeyAccountWords("environment", "", {
      holder: "server",
      place: "key-check",
    });
    expect(environment.todo).toBe(
      "The person who runs this Mend server changes them with mend server setup --boat-api-key-stdin and --boat-organization.",
    );
  });

  for (const refusal of BOAT_KEY_ACCOUNT_REFUSALS) {
    for (const holder of HOLDERS) {
      it(`${refusal} · ${holder}'s key reads as sentences`, () => {
        const words = boatKeyAccountWords(refusal, "A sentence.", { holder, place: "key-check" });
        expect(words.happened).toMatch(/^[A-Z].*\.$/);
        expect(words.todo).toMatch(/^[A-Z].*\.$/);
      });
    }
  }
});

/**
 * The troubleshooting section of the Boat docs page is this table, as an organization's session
 * reads it. `UPDATE_BOAT_DOCS=1` rewrites it; otherwise the test fails when they differ.
 */
/** The docs formatter wraps lines, so only the words are compared. */
const wordsOnly = (markdown: string) => markdown.replace(/\s+/g, " ").trim();

describe("the Boat docs page", () => {
  const page = new URL("../../../../apps/docs/src/content/docs/operate/boat.md", import.meta.url);
  const START = "<!-- boat-failure-words:start -->";
  const END = "<!-- boat-failure-words:end -->";
  const generated = (): string => {
    const launch: BoatWordsContext = { holder: "organization", place: "launch" };
    const rows = BOAT_FAILURE_KINDS.map((kind) => {
      const words = boatProblemWords({ kind, failure: failureOf(kind, { message: null }) }, launch);
      return `- **${kind}**: ${words.happened} ${words.todo}`;
    });
    const unpinned = boatProblemWords(
      { kind: "boat-account-wallet-unresolved", coreMessage: "" },
      launch,
    );
    const wallet = `- **wallet not known yet**: ${unpinned.happened} ${unpinned.todo}`;
    return [START, ...rows, wallet, END].join("\n");
  };

  it("lists every failure in the words a session shows", () => {
    const text = readFileSync(page, "utf8");
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    expect(start).toBeGreaterThanOrEqual(0);
    const current = text.slice(start, end + END.length);
    if (process.env.UPDATE_BOAT_DOCS === "1" && wordsOnly(current) !== wordsOnly(generated())) {
      writeFileSync(page, text.replace(current, generated()));
      return;
    }
    expect(wordsOnly(current)).toBe(wordsOnly(generated()));
  });
});
