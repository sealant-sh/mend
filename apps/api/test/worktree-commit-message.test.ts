import { InferenceCallsRepo } from "@mend/db";
import { InferenceError, InferenceProvider, sealantProviderLayer } from "@mend/inference";
import { SealantClient, SealantPlatformError, SealantPrincipal } from "@mend/sealant";
import type { InferenceResponse } from "@sealant/sdk";
import { ConfigProvider, Effect, Layer } from "effect";
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

const preview = { summary: "M\tREADME.md", patch: "+Hello", recentMessages: "docs: explain setup" };

for (const [provider, selectedModel] of [
  ["codex", "gpt-6-luna"],
  ["codex", "gpt-6-astra"],
  ["claude", "claude-future"],
] as const) {
  it(`falls back on the same ${provider} login when ${selectedModel} Core rejects the selected writer model`, async () => {
    const exchanges: Array<{ principal: unknown; options: unknown }> = [];
    const layer = sealantProviderLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(SealantClient, {
            inferenceRespond: (options) =>
              Effect.gen(function* () {
                exchanges.push({ principal: yield* SealantPrincipal, options });
                if (exchanges.length === 1)
                  return yield* new SealantPlatformError({
                    code: "InferenceInternalServerError",
                    status: 500,
                    message: "The selected model requires a newer Codex runtime.",
                    cause: null,
                  });
                return {
                  sessionId: "inference-2",
                  turn: {
                    type: "text",
                    text: JSON.stringify({ subject: "Add README greeting", body: "" }),
                  },
                } satisfies InferenceResponse;
              }),
          }),
          Layer.succeed(InferenceCallsRepo, { record: () => Effect.void }),
        ),
      ),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );
    const message = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* generateWorktreeCommitMessage(
          yield* InferenceProvider,
          "alice",
          { provider, model: selectedModel },
          preview,
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(message).toBe("Add README greeting");
    expect(exchanges).toMatchObject([
      {
        principal: { kind: "user", userId: "alice" },
        options: { model: selectedModel, credentials: { [provider]: true } },
      },
      {
        principal: { kind: "user", userId: "alice" },
        options: {
          model: provider === "codex" ? "gpt-5.6-luna" : "claude-haiku-4-5",
          credentials: { [provider]: true },
        },
      },
    ]);
  });
}

it("reports a login failure without trying a different model or person", async () => {
  let attempts = 0;
  const refusal = await Effect.runPromise(
    Effect.flip(
      generateWorktreeCommitMessage(
        {
          respond: () => {
            attempts++;
            return Effect.fail(
              new InferenceError({
                message: "Reconnect the connected account",
                cause: new SealantPlatformError({
                  code: "connected-account-invalid",
                  status: 409,
                  message: "Reconnect the connected account",
                  cause: null,
                }),
              }),
            );
          },
        },
        "alice",
        { provider: "codex", model: "gpt-6-astra" },
        preview,
      ),
    ),
  );
  expect(attempts).toBe(1);
  expect(refusal.message).toMatch(/Codex.*login.*reconnect/i);
  expect(refusal.message).toContain("Nothing was committed");
});
