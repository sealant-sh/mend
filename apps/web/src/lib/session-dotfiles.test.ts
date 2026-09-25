import { describe, expect, it } from "vitest";

import { sessionDotfilesLines } from "./session-dotfiles.ts";

describe("sessionDotfilesLines", () => {
  it("says nothing before launch or when no dotfiles were configured", () => {
    expect(sessionDotfilesLines(null)).toEqual([]);
    expect(sessionDotfilesLines({ repository: null, snapshotSha: null, notApplied: [] })).toEqual(
      [],
    );
  });

  it("states what was sent with the launch", () => {
    expect(
      sessionDotfilesLines({
        repository: { url: "https://github.com/me/dots.git", ref: "main" },
        snapshotSha: "5eed0f5eed0f5eed0f5eed0f",
        notApplied: [],
      }),
    ).toEqual([
      {
        text: "dotfiles · repo https://github.com/me/dots.git @ main · snapshot 5eed0f5 · sent at launch",
        notApplied: false,
      },
    ]);
  });

  it("names a source the launch left out, with the reason, beside what was still sent", () => {
    expect(
      sessionDotfilesLines({
        repository: { url: "https://github.com/me/dots.git", ref: null },
        snapshotSha: "5eed0f5eed0f5eed0f5eed0f",
        notApplied: [
          {
            source: "repository",
            reason:
              "the dotfiles repo https://github.com/me/dots.git was stopped after 60s — Mend gives a dotfiles repository 60s to clone and pack.",
          },
        ],
      }),
    ).toEqual([
      { text: "dotfiles · snapshot 5eed0f5 · sent at launch", notApplied: false },
      {
        text: "dotfiles · repo not applied · the dotfiles repo https://github.com/me/dots.git was stopped after 60s — Mend gives a dotfiles repository 60s to clone and pack.",
        notApplied: true,
      },
    ]);
  });
});
