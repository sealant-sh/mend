import { SealantPrincipal } from "@mend/sealant";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { generateWorktreeCommitMessage } from "../src/worktree-commit.ts";

describe("explicit commit message generation", () => {
  it("uses the caller's subscription and chosen writer, with a bounded change preview", async () => {
    const seen: unknown[] = [];
    const message = await Effect.runPromise(
      generateWorktreeCommitMessage(
        {
          respond: (request) =>
            Effect.gen(function* () {
              seen.push({ principal: yield* SealantPrincipal, request });
              return { subject: "Fix parser", body: "Keep literal paths." };
            }),
        },
        "alice",
        {
          provider: "codex",
          model: "writer-model",
          instructions: "Use Conventional Commits syntax.",
        },
        {
          summary: "M\tsrc/parser.ts",
          patch: "+fixed",
          recentMessages: "fix: parse files",
        },
      ),
    );
    expect(message).toBe("Fix parser\n\nKeep literal paths.");
    expect(seen).toMatchObject([
      {
        principal: { kind: "user", userId: "alice" },
        request: {
          context: "git-commit",
          provider: "codex",
          model: "writer-model",
        },
      },
    ]);
  });
});
