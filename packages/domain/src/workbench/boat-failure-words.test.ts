import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BOAT_LAUNCH_REFUSAL_CODES,
  type BoatKeyHolder,
  type BoatWordsContext,
  type BoatWordsPlace,
  boatFailureLogLine,
  boatProblemText,
  boatProblemWords,
} from "./boat-failure-words.ts";
import { BOAT_FAILURE_KINDS, type BoatFailure, type BoatFailureKind } from "./boat-failure.ts";

const HOLDERS: ReadonlyArray<BoatKeyHolder> = ["organization", "server", "person"];
const PLACES: ReadonlyArray<BoatWordsPlace> = ["launch", "key-check"];

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
            place === "launch" ? /this session's (VM|image)/ : /nothing changed/,
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

describe("the words for Core's refusals before anything ran", () => {
  for (const kind of BOAT_LAUNCH_REFUSAL_CODES) {
    it(kind, () => {
      const words = boatProblemWords(
        { kind, coreMessage: "Boat supports Ubuntu and Nix; Arch is unsupported." },
        { holder: "organization", place: "launch" },
      );
      expect(words.happened).toMatch(/^[A-Z].*\.$/);
      expect(words.todo).toMatch(/^[A-Z].*\.$/);
    });
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
    return [START, ...rows, END].join("\n");
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
